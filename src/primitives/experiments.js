// ============================================================================
// OpenHeab Experiments — A/B testing + multi-armed bandits (Thompson sampling)
// Tables: experiments, experiment_assignments, experiment_events, experiment_results
// ============================================================================
const cryptoLib = require('crypto');
const express = require('express');
const { z } = require('zod');

const STATUSES = ['draft', 'running', 'concluded', 'stopped'];
const ALLOCATION_KINDS = ['random', 'bandit', 'sticky'];
const EVENT_KINDS = ['exposure', 'conversion', 'metric'];

// ----------------------------------------------------------------------------
// Migration
// ----------------------------------------------------------------------------
async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS experiments (
      experiment_id    TEXT PRIMARY KEY,
      owner_did        TEXT NOT NULL,
      name             TEXT NOT NULL,
      key              TEXT NOT NULL,
      hypothesis       TEXT,
      status           TEXT NOT NULL DEFAULT 'draft',
      allocation_kind  TEXT NOT NULL DEFAULT 'random',
      variants         JSONB NOT NULL DEFAULT '[]',
      target_metric    TEXT,
      started_at       TIMESTAMPTZ,
      ended_at         TIMESTAMPTZ,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (owner_did, key)
    );

    CREATE TABLE IF NOT EXISTS experiment_assignments (
      assignment_id TEXT PRIMARY KEY,
      experiment_id TEXT NOT NULL REFERENCES experiments(experiment_id) ON DELETE CASCADE,
      agent_did     TEXT NOT NULL,
      variant_key   TEXT NOT NULL,
      bucketed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      sticky        BOOLEAN NOT NULL DEFAULT FALSE
    );
    CREATE INDEX IF NOT EXISTS idx_assigns_exp_agent
      ON experiment_assignments (experiment_id, agent_did);

    CREATE TABLE IF NOT EXISTS experiment_events (
      event_id      TEXT PRIMARY KEY,
      experiment_id TEXT NOT NULL REFERENCES experiments(experiment_id) ON DELETE CASCADE,
      assignment_id TEXT,
      kind          TEXT NOT NULL,
      value         DOUBLE PRECISION,
      ts            TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_exp_events ON experiment_events (experiment_id, ts DESC);

    CREATE TABLE IF NOT EXISTS experiment_results (
      experiment_id   TEXT PRIMARY KEY REFERENCES experiments(experiment_id) ON DELETE CASCADE,
      variant_metrics JSONB,
      winner_variant  TEXT,
      confidence      REAL,
      computed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

function genExpId()    { return 'exp_' + cryptoLib.randomBytes(12).toString('hex'); }
function genAssignId() { return 'ass_' + cryptoLib.randomBytes(12).toString('hex'); }
function genEvtId()    { return 'eevt_' + cryptoLib.randomBytes(12).toString('hex'); }

// Box-Muller normal sampling
function randNormal() {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

// Gamma sampler (Marsaglia-Tsang) for shape > 0
function randGamma(shape) {
  if (shape < 1) {
    const r = randGamma(shape + 1);
    return r * Math.pow(Math.random(), 1 / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  while (true) {
    let x, v;
    do {
      x = randNormal();
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = Math.random();
    if (u < 1 - 0.0331 * Math.pow(x, 4)) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

// Beta sample via two Gamma draws
function sampleBeta(alpha, beta) {
  const a = randGamma(Math.max(alpha, 0.001));
  const b = randGamma(Math.max(beta, 0.001));
  return a / (a + b);
}

// Pick a variant using Thompson sampling on Beta(successes+1, failures+1)
function thompsonPick(variants, stats) {
  let best = variants[0]?.key, bestSample = -Infinity;
  for (const v of variants) {
    const s = stats[v.key] || { successes: 0, failures: 0 };
    const sample = sampleBeta(s.successes + 1, s.failures + 1);
    if (sample > bestSample) {
      bestSample = sample;
      best = v.key;
    }
  }
  return best;
}

function weightedRandomPick(variants) {
  const total = variants.reduce((s, v) => s + Number(v.weight || 1), 0);
  let r = Math.random() * total;
  for (const v of variants) {
    r -= Number(v.weight || 1);
    if (r <= 0) return v.key;
  }
  return variants[variants.length - 1]?.key;
}

async function getVariantStats(pool, experimentId, variantKeys) {
  const r = await pool.query(`
    SELECT a.variant_key,
           COUNT(DISTINCT a.assignment_id) FILTER (WHERE e.kind = 'exposure') AS exposures,
           COUNT(DISTINCT a.assignment_id) FILTER (WHERE e.kind = 'conversion') AS conversions,
           COALESCE(SUM(e.value), 0) AS metric_sum,
           COUNT(*) FILTER (WHERE e.kind = 'metric') AS metric_n
      FROM experiment_assignments a
      LEFT JOIN experiment_events e ON e.assignment_id = a.assignment_id
     WHERE a.experiment_id = $1
     GROUP BY a.variant_key
  `, [experimentId]).catch(() => ({ rows: [] }));

  const stats = {};
  for (const k of variantKeys) stats[k] = { successes: 0, failures: 0, exposures: 0, metric_sum: 0, metric_n: 0 };
  for (const row of r.rows) {
    const k = row.variant_key;
    if (!stats[k]) continue;
    stats[k].exposures = parseInt(row.exposures || 0);
    stats[k].successes = parseInt(row.conversions || 0);
    stats[k].failures = Math.max(stats[k].exposures - stats[k].successes, 0);
    stats[k].metric_sum = Number(row.metric_sum || 0);
    stats[k].metric_n = parseInt(row.metric_n || 0);
  }
  return stats;
}

// ----------------------------------------------------------------------------
// Routes
// ----------------------------------------------------------------------------
function registerExperimentsRoutes(app, pool, verifyAgentAuth, auditChain) {
  // POST /v1/agents/:did/experiments
  const VariantSchema = z.object({
    key: z.string().min(1).max(128),
    name: z.string().min(1).max(256),
    weight: z.number().nonnegative().optional().default(1),
    params: z.record(z.any()).optional()
  });
  const ExpSchema = z.object({
    name: z.string().min(1).max(256),
    key: z.string().min(1).max(128).regex(/^[a-zA-Z0-9_.-]+$/),
    hypothesis: z.string().max(8192).optional(),
    allocation_kind: z.enum(ALLOCATION_KINDS).optional().default('random'),
    variants: z.array(VariantSchema).min(2).max(20),
    target_metric: z.string().max(128).optional(),
    status: z.enum(STATUSES).optional().default('draft')
  });

  app.post('/v1/agents/:did/experiments', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const parse = ExpSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;

      const experimentId = genExpId();
      const startedAt = d.status === 'running' ? new Date().toISOString() : null;
      try {
        await pool.query(
          `INSERT INTO experiments
           (experiment_id, owner_did, name, key, hypothesis, status, allocation_kind,
            variants, target_metric, started_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10)`,
          [experimentId, did, d.name, d.key, d.hypothesis || null,
           d.status, d.allocation_kind, JSON.stringify(d.variants),
           d.target_metric || null, startedAt]
        );
      } catch (e) {
        if (e.code === '23505') return res.status(409).json({ error: 'experiment_key_taken' });
        throw e;
      }

      await auditChain.append({
        event_type: 'experiments.created',
        experiment_id: experimentId, owner_did: did, key: d.key,
        allocation_kind: d.allocation_kind, variant_count: d.variants.length,
        timestamp: new Date().toISOString()
      });

      return res.status(201).json({
        experiment_id: experimentId, owner_did: did, name: d.name,
        key: d.key, hypothesis: d.hypothesis || null, status: d.status,
        allocation_kind: d.allocation_kind, variants: d.variants,
        target_metric: d.target_metric || null, started_at: startedAt,
        created_at: new Date().toISOString()
      });
    } catch (e) {
      console.error('[experiments.create]', e);
      return res.status(500).json({ error: 'experiment_create_failed', message: e.message });
    }
  });

  // POST /v1/experiments/:key/assign — context → variant
  const AssignSchema = z.object({
    owner_did: z.string().max(256).optional(),
    agent_did: z.string().min(1).max(256),
    context: z.record(z.any()).optional()
  });

  app.post('/v1/experiments/:key/assign', express.json(), async (req, res) => {
    try {
      const parse = AssignSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;
      const ownerDid = d.owner_did || d.context?.owner_did;
      if (!ownerDid) return res.status(400).json({ error: 'owner_did_required' });

      const expR = await pool.query(
        `SELECT * FROM experiments
         WHERE owner_did = $1 AND key = $2 AND status = 'running'`,
        [ownerDid, req.params.key]
      ).catch(() => ({ rows: [] }));
      if (!expR.rows[0]) return res.status(404).json({ error: 'experiment_not_running' });
      const exp = expR.rows[0];
      const variants = exp.variants || [];
      const variantKeys = variants.map(v => v.key);

      // Check sticky / existing assignment
      const ex = await pool.query(
        `SELECT assignment_id, variant_key, sticky FROM experiment_assignments
         WHERE experiment_id = $1 AND agent_did = $2 LIMIT 1`,
        [exp.experiment_id, d.agent_did]
      ).catch(() => ({ rows: [] }));

      let assignmentId, variantKey;
      if (ex.rows[0]) {
        assignmentId = ex.rows[0].assignment_id;
        variantKey = ex.rows[0].variant_key;
      } else {
        if (exp.allocation_kind === 'bandit') {
          const stats = await getVariantStats(pool, exp.experiment_id, variantKeys);
          variantKey = thompsonPick(variants, stats);
        } else if (exp.allocation_kind === 'sticky') {
          const hash = cryptoLib.createHash('sha256')
            .update(`${exp.key}::${d.agent_did}`).digest('hex');
          variantKey = variants[parseInt(hash.slice(0, 8), 16) % variants.length].key;
        } else {
          variantKey = weightedRandomPick(variants);
        }
        assignmentId = genAssignId();
        await pool.query(
          `INSERT INTO experiment_assignments
           (assignment_id, experiment_id, agent_did, variant_key, sticky)
           VALUES ($1,$2,$3,$4,$5)`,
          [assignmentId, exp.experiment_id, d.agent_did, variantKey,
           exp.allocation_kind === 'sticky']
        );
      }

      // Record exposure
      await pool.query(
        `INSERT INTO experiment_events
         (event_id, experiment_id, assignment_id, kind)
         VALUES ($1,$2,$3,'exposure')`,
        [genEvtId(), exp.experiment_id, assignmentId]
      ).catch(() => {});

      const variant = variants.find(v => v.key === variantKey) || { key: variantKey };
      return res.json({
        experiment_id: exp.experiment_id, key: exp.key,
        assignment_id: assignmentId, variant_key: variantKey,
        variant: { key: variant.key, name: variant.name, params: variant.params || null }
      });
    } catch (e) {
      console.error('[experiments.assign]', e);
      return res.status(500).json({ error: 'assign_failed', message: e.message });
    }
  });

  // POST /v1/experiments/:key/track
  const TrackSchema = z.object({
    owner_did: z.string().max(256).optional(),
    agent_did: z.string().min(1).max(256),
    kind: z.enum(EVENT_KINDS),
    value: z.number().optional(),
    metric: z.string().max(128).optional()
  });

  app.post('/v1/experiments/:key/track', express.json(), async (req, res) => {
    try {
      const parse = TrackSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;
      const ownerDid = d.owner_did || req.body?.context?.owner_did;
      if (!ownerDid) return res.status(400).json({ error: 'owner_did_required' });

      const expR = await pool.query(
        `SELECT experiment_id FROM experiments WHERE owner_did = $1 AND key = $2`,
        [ownerDid, req.params.key]
      ).catch(() => ({ rows: [] }));
      if (!expR.rows[0]) return res.status(404).json({ error: 'experiment_not_found' });

      const assignR = await pool.query(
        `SELECT assignment_id FROM experiment_assignments
         WHERE experiment_id = $1 AND agent_did = $2`,
        [expR.rows[0].experiment_id, d.agent_did]
      ).catch(() => ({ rows: [] }));
      if (!assignR.rows[0]) return res.status(400).json({ error: 'not_assigned' });

      const eventId = genEvtId();
      await pool.query(
        `INSERT INTO experiment_events
         (event_id, experiment_id, assignment_id, kind, value)
         VALUES ($1,$2,$3,$4,$5)`,
        [eventId, expR.rows[0].experiment_id, assignR.rows[0].assignment_id,
         d.kind, d.value ?? null]
      );

      return res.status(201).json({
        event_id: eventId,
        experiment_id: expR.rows[0].experiment_id,
        kind: d.kind, value: d.value ?? null
      });
    } catch (e) {
      console.error('[experiments.track]', e);
      return res.status(500).json({ error: 'track_failed', message: e.message });
    }
  });

  // POST /v1/experiments/:key/results — compute winner
  const ResultsSchema = z.object({
    owner_did: z.string().max(256).optional()
  });

  app.post('/v1/experiments/:key/results', express.json(), async (req, res) => {
    try {
      const parse = ResultsSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const ownerDid = parse.data.owner_did || req.body?.context?.owner_did;
      if (!ownerDid) return res.status(400).json({ error: 'owner_did_required' });

      const expR = await pool.query(
        `SELECT * FROM experiments WHERE owner_did = $1 AND key = $2`,
        [ownerDid, req.params.key]
      ).catch(() => ({ rows: [] }));
      if (!expR.rows[0]) return res.status(404).json({ error: 'experiment_not_found' });
      const exp = expR.rows[0];
      const variants = exp.variants || [];
      const variantKeys = variants.map(v => v.key);
      const stats = await getVariantStats(pool, exp.experiment_id, variantKeys);

      // Compute conversion rates + winner via Monte Carlo Thompson
      const samples = 5000;
      const winCounts = {};
      for (const k of variantKeys) winCounts[k] = 0;
      for (let i = 0; i < samples; i++) {
        let bestKey = variantKeys[0], bestVal = -Infinity;
        for (const k of variantKeys) {
          const s = stats[k];
          const r = sampleBeta(s.successes + 1, s.failures + 1);
          if (r > bestVal) { bestVal = r; bestKey = k; }
        }
        winCounts[bestKey]++;
      }
      let winner = variantKeys[0], maxWin = -1;
      for (const k of variantKeys) {
        if (winCounts[k] > maxWin) { maxWin = winCounts[k]; winner = k; }
      }
      const confidence = samples ? winCounts[winner] / samples : 0;

      const variant_metrics = {};
      for (const k of variantKeys) {
        const s = stats[k];
        const conv = s.exposures > 0 ? s.successes / s.exposures : 0;
        variant_metrics[k] = {
          exposures: s.exposures, conversions: s.successes,
          conversion_rate: conv, metric_sum: s.metric_sum,
          metric_n: s.metric_n, p_best: winCounts[k] / samples
        };
      }

      await pool.query(
        `INSERT INTO experiment_results
         (experiment_id, variant_metrics, winner_variant, confidence, computed_at)
         VALUES ($1, $2::jsonb, $3, $4, NOW())
         ON CONFLICT (experiment_id) DO UPDATE SET
           variant_metrics = $2::jsonb, winner_variant = $3,
           confidence = $4, computed_at = NOW()`,
        [exp.experiment_id, JSON.stringify(variant_metrics), winner, confidence]
      );

      return res.json({
        experiment_id: exp.experiment_id, key: exp.key,
        variant_metrics, winner_variant: winner, confidence,
        computed_at: new Date().toISOString()
      });
    } catch (e) {
      console.error('[experiments.results]', e);
      return res.status(500).json({ error: 'results_failed', message: e.message });
    }
  });

  // POST /v1/agents/:did/experiments/:key/conclude
  app.post('/v1/agents/:did/experiments/:key/conclude', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const upd = await pool.query(
        `UPDATE experiments SET status = 'concluded', ended_at = NOW()
         WHERE owner_did = $1 AND key = $2 AND status IN ('running','draft')
         RETURNING experiment_id`,
        [did, req.params.key]
      ).catch(() => ({ rows: [] }));
      if (!upd.rows[0]) return res.status(404).json({ error: 'experiment_not_active' });

      await auditChain.append({
        event_type: 'experiments.concluded',
        experiment_id: upd.rows[0].experiment_id, owner_did: did,
        key: req.params.key, timestamp: new Date().toISOString()
      });

      return res.json({
        experiment_id: upd.rows[0].experiment_id,
        key: req.params.key, status: 'concluded',
        ended_at: new Date().toISOString()
      });
    } catch (e) {
      console.error('[experiments.conclude]', e);
      return res.status(500).json({ error: 'conclude_failed', message: e.message });
    }
  });

  // GET /v1/agents/:did/experiments
  app.get('/v1/agents/:did/experiments', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(
      `SELECT experiment_id, name, key, hypothesis, status, allocation_kind,
              variants, target_metric, started_at, ended_at, created_at
       FROM experiments WHERE owner_did = $1 ORDER BY created_at DESC`,
      [did]
    ).catch(() => ({ rows: [] }));
    return res.json({ experiments: r.rows, count: r.rows.length });
  });
}

module.exports = {
  migrate,
  registerExperimentsRoutes,
  sampleBeta,
  thompsonPick,
  STATUSES,
  ALLOCATION_KINDS,
  EVENT_KINDS
};
