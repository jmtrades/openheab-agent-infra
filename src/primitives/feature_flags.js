// ============================================================================
// OpenHeab Feature Flags — Boolean/value flags + percentage rollouts + segments
// Tables: feature_flags_def, feature_flag_rules, feature_flag_evaluations, feature_segments
// Bucket: SHA-256(flag_key + did) → 0-99
// ============================================================================
const cryptoLib = require('crypto');
const express = require('express');
const { z } = require('zod');

const FLAG_KINDS = ['boolean', 'string', 'number', 'json'];
const RULE_KIND_OPS = ['eq', 'ne', 'in', 'contains', 'gt', 'lt', 'pct'];

// ----------------------------------------------------------------------------
// Migration
// ----------------------------------------------------------------------------
async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS feature_flags_def (
      flag_id        TEXT PRIMARY KEY,
      owner_did      TEXT NOT NULL,
      key            TEXT NOT NULL,
      name           TEXT NOT NULL,
      description    TEXT,
      kind           TEXT NOT NULL DEFAULT 'boolean',
      default_value  JSONB,
      active         BOOLEAN NOT NULL DEFAULT TRUE,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (owner_did, key)
    );

    CREATE TABLE IF NOT EXISTS feature_flag_rules (
      rule_id    TEXT PRIMARY KEY,
      flag_id    TEXT NOT NULL REFERENCES feature_flags_def(flag_id) ON DELETE CASCADE,
      sequence   INTEGER NOT NULL DEFAULT 0,
      condition  JSONB,
      value      JSONB,
      active     BOOLEAN NOT NULL DEFAULT TRUE
    );
    CREATE INDEX IF NOT EXISTS idx_rules_flag ON feature_flag_rules (flag_id, sequence);

    CREATE TABLE IF NOT EXISTS feature_flag_evaluations (
      eval_id         TEXT PRIMARY KEY,
      flag_id         TEXT NOT NULL,
      agent_did       TEXT,
      context         JSONB,
      returned_value  JSONB,
      rule_id_matched TEXT,
      evaluated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_evals_flag ON feature_flag_evaluations (flag_id, evaluated_at DESC);

    CREATE TABLE IF NOT EXISTS feature_segments (
      segment_id  TEXT PRIMARY KEY,
      owner_did   TEXT NOT NULL,
      name        TEXT NOT NULL,
      conditions  JSONB NOT NULL DEFAULT '{}',
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_segments_owner ON feature_segments (owner_did);
  `);
}

function genFlagId()    { return 'flag_' + cryptoLib.randomBytes(12).toString('hex'); }
function genRuleId()    { return 'frul_' + cryptoLib.randomBytes(12).toString('hex'); }
function genEvalId()    { return 'feval_' + cryptoLib.randomBytes(12).toString('hex'); }
function genSegmentId() { return 'seg_' + cryptoLib.randomBytes(12).toString('hex'); }

// Stable bucket: SHA-256(flag_key + did) → 0-99
function bucketOf(flagKey, did) {
  const hex = cryptoLib.createHash('sha256').update(`${flagKey}::${did}`).digest('hex');
  // Use first 8 hex chars
  return parseInt(hex.slice(0, 8), 16) % 100;
}

function matchCondition(cond, ctx, did, flagKey) {
  if (!cond || typeof cond !== 'object') return true;
  // Percentage rollout
  if (cond.percentage != null) {
    const pct = Number(cond.percentage);
    const bucket = bucketOf(flagKey, ctx?.bucket_key || did || '');
    if (bucket >= pct) return false;
  }
  // Segments
  if (Array.isArray(cond.segments) && cond.segments.length > 0) {
    if (!ctx?.segments || !cond.segments.some(s => ctx.segments.includes(s))) return false;
  }
  // Matchers: array of {field, op, value}
  if (Array.isArray(cond.matchers)) {
    for (const m of cond.matchers) {
      const v = ctx?.[m.field];
      switch (m.op) {
        case 'eq': if (v !== m.value) return false; break;
        case 'ne': if (v === m.value) return false; break;
        case 'in':
          if (!Array.isArray(m.value) || !m.value.includes(v)) return false; break;
        case 'contains':
          if (typeof v !== 'string' || !v.includes(String(m.value))) return false; break;
        case 'gt': if (!(Number(v) > Number(m.value))) return false; break;
        case 'lt': if (!(Number(v) < Number(m.value))) return false; break;
        default: break;
      }
    }
  }
  return true;
}

async function evaluateFlag(pool, ownerDid, flagKey, agentDid, context) {
  const flagR = await pool.query(
    `SELECT * FROM feature_flags_def WHERE owner_did = $1 AND key = $2 AND active = TRUE`,
    [ownerDid, flagKey]
  ).catch(() => ({ rows: [] }));
  if (!flagR.rows[0]) return { found: false };
  const flag = flagR.rows[0];

  const rulesR = await pool.query(
    `SELECT * FROM feature_flag_rules WHERE flag_id = $1 AND active = TRUE
     ORDER BY sequence ASC`,
    [flag.flag_id]
  ).catch(() => ({ rows: [] }));

  let matchedRule = null;
  let value = flag.default_value;
  for (const r of rulesR.rows) {
    if (matchCondition(r.condition || {}, context || {}, agentDid, flagKey)) {
      matchedRule = r;
      value = r.value;
      break;
    }
  }

  // Log evaluation (fire-and-forget)
  await pool.query(
    `INSERT INTO feature_flag_evaluations
     (eval_id, flag_id, agent_did, context, returned_value, rule_id_matched)
     VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6)`,
    [genEvalId(), flag.flag_id, agentDid || null,
     context ? JSON.stringify(context) : null,
     value != null ? JSON.stringify(value) : null,
     matchedRule ? matchedRule.rule_id : null]
  ).catch(() => {});

  return {
    found: true, flag_id: flag.flag_id, key: flag.key,
    value, kind: flag.kind, rule_id_matched: matchedRule?.rule_id || null
  };
}

// ----------------------------------------------------------------------------
// Routes
// ----------------------------------------------------------------------------
function registerFeatureFlagsRoutes(app, pool, verifyAgentAuth, auditChain) {
  // POST /v1/agents/:did/flags
  const FlagSchema = z.object({
    key: z.string().min(1).max(128).regex(/^[a-zA-Z0-9_.-]+$/),
    name: z.string().min(1).max(256),
    description: z.string().max(2048).optional(),
    kind: z.enum(FLAG_KINDS).optional().default('boolean'),
    default_value: z.any().optional(),
    active: z.boolean().optional().default(true)
  });

  app.post('/v1/agents/:did/flags', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const parse = FlagSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;

      const flagId = genFlagId();
      try {
        await pool.query(
          `INSERT INTO feature_flags_def
           (flag_id, owner_did, key, name, description, kind, default_value, active)
           VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`,
          [flagId, did, d.key, d.name, d.description || null, d.kind,
           d.default_value != null ? JSON.stringify(d.default_value) : null, d.active]
        );
      } catch (e) {
        if (e.code === '23505') return res.status(409).json({ error: 'flag_key_taken' });
        throw e;
      }

      await auditChain.append({
        event_type: 'flags.flag_created',
        flag_id: flagId, owner_did: did, key: d.key, kind: d.kind,
        timestamp: new Date().toISOString()
      });

      return res.status(201).json({
        flag_id: flagId, owner_did: did, key: d.key, name: d.name,
        description: d.description || null, kind: d.kind,
        default_value: d.default_value, active: d.active,
        created_at: new Date().toISOString()
      });
    } catch (e) {
      console.error('[flags.create]', e);
      return res.status(500).json({ error: 'flag_create_failed', message: e.message });
    }
  });

  // GET /v1/agents/:did/flags
  app.get('/v1/agents/:did/flags', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(
      `SELECT flag_id, key, name, description, kind, default_value, active, created_at, updated_at
       FROM feature_flags_def WHERE owner_did = $1 ORDER BY created_at DESC`,
      [did]
    ).catch(() => ({ rows: [] }));
    return res.json({ flags: r.rows, count: r.rows.length });
  });

  // POST /v1/agents/:did/flags/:key/rules
  const RuleSchema = z.object({
    sequence: z.number().int().min(0).max(10000).optional().default(0),
    condition: z.record(z.any()),
    value: z.any(),
    active: z.boolean().optional().default(true)
  });

  app.post('/v1/agents/:did/flags/:key/rules', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const parse = RuleSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;

      const flagR = await pool.query(
        `SELECT flag_id FROM feature_flags_def WHERE owner_did = $1 AND key = $2`,
        [did, req.params.key]
      ).catch(() => ({ rows: [] }));
      if (!flagR.rows[0]) return res.status(404).json({ error: 'flag_not_found' });

      const ruleId = genRuleId();
      await pool.query(
        `INSERT INTO feature_flag_rules
         (rule_id, flag_id, sequence, condition, value, active)
         VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6)`,
        [ruleId, flagR.rows[0].flag_id, d.sequence,
         JSON.stringify(d.condition),
         d.value != null ? JSON.stringify(d.value) : null, d.active]
      );

      await pool.query(
        `UPDATE feature_flags_def SET updated_at = NOW() WHERE flag_id = $1`,
        [flagR.rows[0].flag_id]
      );

      await auditChain.append({
        event_type: 'flags.rule_added',
        flag_id: flagR.rows[0].flag_id, rule_id: ruleId,
        owner_did: did, key: req.params.key,
        timestamp: new Date().toISOString()
      });

      return res.status(201).json({
        rule_id: ruleId, flag_id: flagR.rows[0].flag_id,
        sequence: d.sequence, condition: d.condition,
        value: d.value, active: d.active
      });
    } catch (e) {
      console.error('[flags.rule.add]', e);
      return res.status(500).json({ error: 'rule_create_failed', message: e.message });
    }
  });

  // POST /v1/flags/evaluate — public-ish; returns value
  const EvalSchema = z.object({
    owner_did: z.string().max(256).optional(),
    key: z.string().min(1).max(128),
    agent_did: z.string().max(256).optional(),
    context: z.record(z.any()).optional()
  });

  app.post('/v1/flags/evaluate', express.json(), async (req, res) => {
    try {
      const parse = EvalSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;

      // owner_did may be inferred via context.owner_did or fallback
      const ownerDid = d.owner_did || d.context?.owner_did;
      if (!ownerDid) return res.status(400).json({ error: 'owner_did_required' });

      const r = await evaluateFlag(pool, ownerDid, d.key, d.agent_did, d.context);
      if (!r.found) return res.status(404).json({ error: 'flag_not_found_or_inactive' });

      return res.json({
        key: r.key, value: r.value, kind: r.kind,
        rule_id_matched: r.rule_id_matched
      });
    } catch (e) {
      console.error('[flags.evaluate]', e);
      return res.status(500).json({ error: 'evaluate_failed', message: e.message });
    }
  });

  // GET /v1/agents/:did/flags/:key/evaluations
  app.get('/v1/agents/:did/flags/:key/evaluations', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });

    const flagR = await pool.query(
      `SELECT flag_id FROM feature_flags_def WHERE owner_did = $1 AND key = $2`,
      [did, req.params.key]
    ).catch(() => ({ rows: [] }));
    if (!flagR.rows[0]) return res.status(404).json({ error: 'flag_not_found' });

    const limit = Math.min(parseInt(req.query.limit) || 100, 1000);
    const evals = await pool.query(
      `SELECT eval_id, agent_did, context, returned_value, rule_id_matched, evaluated_at
       FROM feature_flag_evaluations WHERE flag_id = $1
       ORDER BY evaluated_at DESC LIMIT $2`,
      [flagR.rows[0].flag_id, limit]
    ).catch(() => ({ rows: [] }));

    const agg = await pool.query(
      `SELECT returned_value, COUNT(*) AS n FROM feature_flag_evaluations
       WHERE flag_id = $1 AND evaluated_at >= NOW() - INTERVAL '24 hours'
       GROUP BY returned_value`,
      [flagR.rows[0].flag_id]
    ).catch(() => ({ rows: [] }));

    return res.json({
      flag_id: flagR.rows[0].flag_id, key: req.params.key,
      evaluations: evals.rows, count: evals.rows.length,
      counts_24h_by_value: agg.rows
    });
  });

  // POST /v1/agents/:did/segments
  const SegmentSchema = z.object({
    name: z.string().min(1).max(256),
    conditions: z.record(z.any())
  });

  app.post('/v1/agents/:did/segments', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const parse = SegmentSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;

      const segmentId = genSegmentId();
      await pool.query(
        `INSERT INTO feature_segments (segment_id, owner_did, name, conditions)
         VALUES ($1,$2,$3,$4::jsonb)`,
        [segmentId, did, d.name, JSON.stringify(d.conditions)]
      );

      await auditChain.append({
        event_type: 'flags.segment_created',
        segment_id: segmentId, owner_did: did, name: d.name,
        timestamp: new Date().toISOString()
      });

      return res.status(201).json({
        segment_id: segmentId, owner_did: did,
        name: d.name, conditions: d.conditions,
        created_at: new Date().toISOString()
      });
    } catch (e) {
      console.error('[flags.segment.create]', e);
      return res.status(500).json({ error: 'segment_create_failed', message: e.message });
    }
  });
}

module.exports = {
  migrate,
  registerFeatureFlagsRoutes,
  evaluateFlag,
  bucketOf,
  FLAG_KINDS
};
