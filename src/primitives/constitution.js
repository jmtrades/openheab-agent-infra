// ============================================================================
// constitution.js — declarative agent constitutional rules with
// cryptographic enforcement. Every action an agent takes can be checked
// against the org's constitution; violations get blocked and audit-logged.
//
// This is the "AGI safety" primitive that lets an org bind every agent in
// it to a published, version-controlled set of rules — and that becomes
// the substrate's safety story to regulators.
// ============================================================================
const crypto = require('crypto');
const { z } = require('zod');

const RULE_KINDS = ['hard_limit', 'rate_limit', 'forbidden_action', 'required_approval',
                     'allowlist', 'denylist', 'kyc_required', 'risk_max', 'spending_cap'];

async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS constitutions (
      constitution_id   TEXT PRIMARY KEY,
      org_id            TEXT,
      owner_did         TEXT,
      slug              TEXT NOT NULL,
      version           INTEGER NOT NULL DEFAULT 1,
      title             TEXT NOT NULL,
      preamble          TEXT,
      hash              TEXT,
      published         BOOLEAN NOT NULL DEFAULT FALSE,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      published_at      TIMESTAMPTZ,
      UNIQUE (org_id, slug, version)
    );
    CREATE TABLE IF NOT EXISTS constitution_rules (
      rule_id           TEXT PRIMARY KEY,
      constitution_id   TEXT NOT NULL,
      kind              TEXT NOT NULL,
      target            TEXT,
      params            JSONB,
      severity          TEXT NOT NULL DEFAULT 'block',
      narrative         TEXT,
      sort_order        INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS constitution_bindings (
      binding_id        TEXT PRIMARY KEY,
      constitution_id   TEXT NOT NULL,
      agent_did         TEXT NOT NULL,
      bound_by_did      TEXT,
      bound_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      revoked_at        TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_constitution_bindings_agent ON constitution_bindings (agent_did) WHERE revoked_at IS NULL;
    CREATE TABLE IF NOT EXISTS constitution_violations (
      violation_id      TEXT PRIMARY KEY,
      agent_did         TEXT NOT NULL,
      constitution_id   TEXT NOT NULL,
      rule_id           TEXT NOT NULL,
      action_attempted  TEXT,
      context           JSONB,
      severity          TEXT NOT NULL,
      blocked           BOOLEAN NOT NULL DEFAULT TRUE,
      occurred_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_constitution_violations_agent ON constitution_violations (agent_did, occurred_at DESC);
  `);
}

function newId(p) { return p + '_' + crypto.randomBytes(10).toString('hex'); }

const ruleSchema = z.object({
  kind: z.enum(RULE_KINDS),
  target: z.string().optional(),
  params: z.record(z.any()).optional(),
  severity: z.enum(['block', 'warn', 'log']).optional(),
  narrative: z.string().max(2000).optional()
});

const constitutionSchema = z.object({
  slug: z.string().regex(/^[a-z0-9_-]{2,80}$/),
  title: z.string().min(1).max(200),
  preamble: z.string().max(5000).optional(),
  org_id: z.string().optional(),
  rules: z.array(ruleSchema).min(1).max(200)
});

// Evaluate an action against bound constitutions for an agent.
// action: { kind, target, amount_cents?, risk_score?, context? }
// Returns { allowed, violations: [{ rule_id, severity, narrative, kind }] }
async function evaluateAction(pool, agentDid, action) {
  const r = await pool.query(`
    SELECT r.rule_id, r.kind, r.target, r.params, r.severity, r.narrative
    FROM constitution_bindings b
    JOIN constitution_rules r ON r.constitution_id = b.constitution_id
    WHERE b.agent_did = $1 AND b.revoked_at IS NULL
  `, [agentDid]).catch(() => ({ rows: [] }));

  const violations = [];
  for (const rule of r.rows) {
    let v = false;
    const params = typeof rule.params === 'string' ? JSON.parse(rule.params || '{}') : (rule.params || {});

    if (rule.kind === 'forbidden_action' && rule.target === action.kind) v = true;
    if (rule.kind === 'allowlist' && rule.target === action.kind) {
      if (params.values && !params.values.includes(action.target)) v = true;
    }
    if (rule.kind === 'denylist' && rule.target === action.kind) {
      if (params.values && params.values.includes(action.target)) v = true;
    }
    if (rule.kind === 'spending_cap' && action.amount_cents != null) {
      if (params.cents != null && action.amount_cents > Number(params.cents)) v = true;
    }
    if (rule.kind === 'risk_max' && action.risk_score != null) {
      if (params.max != null && action.risk_score > Number(params.max)) v = true;
    }
    if (rule.kind === 'kyc_required' && (action.kyc_tier ?? 0) < (params.tier ?? 1)) v = true;
    if (rule.kind === 'required_approval') {
      // Only allowed if context includes an approval
      if (!action.context?.approval_id) v = true;
    }

    if (v) violations.push({ rule_id: rule.rule_id, kind: rule.kind, severity: rule.severity, narrative: rule.narrative });
  }
  const blocking = violations.filter(v => v.severity === 'block');
  return { allowed: blocking.length === 0, violations, blocking_count: blocking.length };
}

async function recordViolation(pool, agentDid, constitutionId, ruleId, action, severity, blocked, auditChain) {
  const id = newId('vio');
  await pool.query(
    `INSERT INTO constitution_violations (violation_id, agent_did, constitution_id, rule_id,
       action_attempted, context, severity, blocked)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [id, agentDid, constitutionId, ruleId, action.kind, JSON.stringify(action), severity, blocked]
  ).catch(() => {});
  if (auditChain) await auditChain.append({ event_type: 'constitution.violation', agent_did: agentDid, rule_id: ruleId, action_kind: action.kind, blocked }).catch(() => {});
}

function isAdmin(req) {
  const t = req.headers['x-admin-token'];
  return require('../safe_compare').safeTokenCompare(t, process.env.OPERATOR_ADMIN_TOKEN);
}

function registerConstitutionRoutes(app, pool, verifyAgentAuth, auditChain) {
  const express = require('express');

  app.post('/v1/constitutions', express.json(), async (req, res) => {
    const did = req.headers['x-agent-did'];
    if (!did) return res.status(401).json({ error: 'agent_did_required' });
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const p = constitutionSchema.safeParse(req.body || {});
    if (!p.success) return res.status(400).json({ error: 'invalid_input', details: p.error.flatten() });

    const constId = newId('cnst');
    const hashSrc = JSON.stringify({ title: p.data.title, preamble: p.data.preamble, rules: p.data.rules });
    const hash = crypto.createHash('sha256').update(hashSrc).digest('hex');
    await pool.query(
      `INSERT INTO constitutions (constitution_id, org_id, owner_did, slug, title,
         preamble, hash, published, version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,FALSE,1)`,
      [constId, p.data.org_id || null, did, p.data.slug, p.data.title, p.data.preamble || null, hash]
    );
    for (let i = 0; i < p.data.rules.length; i++) {
      const r = p.data.rules[i];
      await pool.query(
        `INSERT INTO constitution_rules (rule_id, constitution_id, kind, target, params, severity, narrative, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [newId('rule'), constId, r.kind, r.target || null, r.params ? JSON.stringify(r.params) : null,
         r.severity || 'block', r.narrative || null, i]
      );
    }
    if (auditChain) await auditChain.append({ event_type: 'constitution.created', constitution_id: constId, owner_did: did, hash }).catch(() => {});
    res.status(201).json({ constitution_id: constId, hash, status: 'draft' });
  });

  app.post('/v1/constitutions/:cid/publish', async (req, res) => {
    const did = req.headers['x-agent-did'];
    if (!did) return res.status(401).json({ error: 'agent_did_required' });
    const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(`UPDATE constitutions SET published=TRUE, published_at=NOW() WHERE constitution_id=$1 AND owner_did=$2 RETURNING constitution_id`,
      [req.params.cid, did]).catch(() => ({ rows: [] }));
    if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
    if (auditChain) await auditChain.append({ event_type: 'constitution.published', constitution_id: r.rows[0].constitution_id }).catch(() => {});
    res.json({ constitution_id: r.rows[0].constitution_id, status: 'published' });
  });

  app.post('/v1/agents/:did/constitutions/bind', express.json(), async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const cid = req.body?.constitution_id;
    if (!cid) return res.status(400).json({ error: 'constitution_id_required' });
    const id = newId('bnd');
    await pool.query(
      `INSERT INTO constitution_bindings (binding_id, constitution_id, agent_did, bound_by_did)
       VALUES ($1,$2,$3,$4)`,
      [id, cid, did, did]
    );
    if (auditChain) await auditChain.append({ event_type: 'constitution.bound', constitution_id: cid, agent_did: did }).catch(() => {});
    res.status(201).json({ binding_id: id });
  });

  app.post('/v1/agents/:did/constitutions/check', express.json(), async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const action = req.body?.action || {};
    const out = await evaluateAction(pool, did, action);
    if (!out.allowed) {
      for (const v of out.violations.filter(x => x.severity === 'block')) {
        await recordViolation(pool, did, '', v.rule_id, action, v.severity, true, auditChain);
      }
    }
    res.json(out);
  });

  app.get('/v1/agents/:did/constitutions', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(`
      SELECT c.constitution_id, c.slug, c.title, c.version, c.hash, c.published,
             b.bound_at, b.binding_id
      FROM constitution_bindings b JOIN constitutions c ON c.constitution_id = b.constitution_id
      WHERE b.agent_did = $1 AND b.revoked_at IS NULL
    `, [did]).catch(() => ({ rows: [] }));
    res.json({ bound: r.rows });
  });

  app.get('/v1/constitutions/:cid', async (req, res) => {
    const c = await pool.query(`SELECT * FROM constitutions WHERE constitution_id=$1`, [req.params.cid])
      .catch(() => ({ rows: [] }));
    if (!c.rows[0]) return res.status(404).json({ error: 'not_found' });
    const rules = await pool.query(`SELECT rule_id, kind, target, params, severity, narrative, sort_order
                                     FROM constitution_rules WHERE constitution_id=$1 ORDER BY sort_order`, [req.params.cid])
      .catch(() => ({ rows: [] }));
    res.json({ ...c.rows[0], rules: rules.rows });
  });

  app.get('/v1/agents/:did/constitutions/violations', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(`
      SELECT violation_id, rule_id, action_attempted, severity, blocked, occurred_at
      FROM constitution_violations WHERE agent_did=$1 ORDER BY occurred_at DESC LIMIT 200
    `, [did]).catch(() => ({ rows: [] }));
    res.json({ violations: r.rows });
  });
}

module.exports = { migrate, registerConstitutionRoutes, evaluateAction, recordViolation, RULE_KINDS };
