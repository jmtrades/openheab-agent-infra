// ============================================================================
// OpenHeab Eval — Test suites, hallucination logs, drift detection, replay
// ============================================================================
const express = require('express');
const cryptoLib = require('crypto');
const { z } = require('zod');

const SEVERITIES = ['low', 'medium', 'high', 'critical'];

// ----------------------------------------------------------------------------
// Migration
// ----------------------------------------------------------------------------
async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS eval_runs (
      run_id            TEXT PRIMARY KEY,
      agent_did         TEXT NOT NULL,
      suite_name        TEXT NOT NULL,
      suite_version     TEXT,
      total_cases       INTEGER NOT NULL DEFAULT 0,
      passed            INTEGER NOT NULL DEFAULT 0,
      failed            INTEGER NOT NULL DEFAULT 0,
      skipped           INTEGER NOT NULL DEFAULT 0,
      score             REAL,
      results           JSONB,
      audit_chain_entry TEXT,
      started_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      finished_at       TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_eval_runs_agent ON eval_runs (agent_did, started_at DESC);

    CREATE TABLE IF NOT EXISTS eval_hallucinations (
      halluc_id         TEXT PRIMARY KEY,
      agent_did         TEXT NOT NULL,
      category          TEXT NOT NULL,
      severity          TEXT NOT NULL,
      claimed_output    TEXT,
      ground_truth      TEXT,
      input_context     JSONB,
      detection_method  TEXT,
      remediation       TEXT,
      audit_chain_entry TEXT,
      detected_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_eval_halluc_agent ON eval_hallucinations (agent_did, detected_at DESC);
    CREATE INDEX IF NOT EXISTS idx_eval_halluc_sev   ON eval_hallucinations (severity, detected_at DESC);

    CREATE TABLE IF NOT EXISTS eval_baselines (
      baseline_id       TEXT PRIMARY KEY,
      agent_did         TEXT NOT NULL,
      name              TEXT NOT NULL,
      fingerprint       JSONB NOT NULL,
      sample_size       INTEGER NOT NULL DEFAULT 0,
      established_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      retired_at        TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_eval_baselines_agent ON eval_baselines (agent_did, established_at DESC);
    CREATE INDEX IF NOT EXISTS idx_eval_baselines_active
      ON eval_baselines (agent_did) WHERE retired_at IS NULL;

    CREATE TABLE IF NOT EXISTS eval_replays (
      replay_id         TEXT PRIMARY KEY,
      agent_did         TEXT NOT NULL,
      source_audit_entry TEXT,
      policy_override   JSONB,
      input_payload     JSONB,
      original_output   JSONB,
      replay_output     JSONB,
      diff              JSONB,
      audit_chain_entry TEXT,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_eval_replays_agent ON eval_replays (agent_did, created_at DESC);
  `);
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------
function genId(prefix) {
  return prefix + '_' + cryptoLib.randomBytes(12).toString('hex');
}

function computeDiff(orig, replay) {
  const diff = { changes: [], identical: true };
  const a = orig && typeof orig === 'object' ? orig : { value: orig };
  const b = replay && typeof replay === 'object' ? replay : { value: replay };
  const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  for (const k of keys) {
    if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) {
      diff.changes.push({ key: k, original: a[k], replay: b[k] });
      diff.identical = false;
    }
  }
  return diff;
}

function computeFingerprintDelta(active, current) {
  const deltas = {};
  const keys = new Set([...Object.keys(active || {}), ...Object.keys(current || {})]);
  let sum = 0;
  let n = 0;
  for (const k of keys) {
    const a = Number(active?.[k] ?? 0);
    const c = Number(current?.[k] ?? 0);
    const denom = Math.max(Math.abs(a), 1e-9);
    const delta = Math.abs(c - a) / denom;
    deltas[k] = { active: a, current: c, delta };
    sum += delta;
    n++;
  }
  return { per_key: deltas, avg_delta: n > 0 ? sum / n : 0 };
}

// ----------------------------------------------------------------------------
// Routes
// ----------------------------------------------------------------------------
function registerEvalRoutes(app, pool, verifyAgentAuth, auditChain) {
  // POST /v1/agents/:did/eval/run
  const RunSchema = z.object({
    suite_name:    z.string().min(1).max(128),
    suite_version: z.string().max(64).optional(),
    total_cases:   z.number().int().min(0).optional(),
    passed:        z.number().int().min(0).optional(),
    failed:        z.number().int().min(0).optional(),
    skipped:       z.number().int().min(0).optional(),
    score:         z.number().optional(),
    results:       z.any().optional()
  });

  app.post('/v1/agents/:did/eval/run', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const parse = RunSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });

      const d = parse.data;
      const runId = genId('run');
      const startedAt = new Date();
      const finishedAt = new Date();
      const total = d.total_cases ?? ((d.passed || 0) + (d.failed || 0) + (d.skipped || 0));
      const score = d.score ?? (total > 0 ? (d.passed || 0) / total : null);

      const entry = await auditChain.append({
        event_type: 'eval.run',
        agent_did: did,
        run_id: runId,
        suite_name: d.suite_name,
        suite_version: d.suite_version || null,
        total_cases: total,
        passed: d.passed || 0,
        failed: d.failed || 0,
        skipped: d.skipped || 0,
        score,
        timestamp: finishedAt.toISOString()
      });

      await pool.query(`
        INSERT INTO eval_runs
        (run_id, agent_did, suite_name, suite_version, total_cases, passed, failed,
         skipped, score, results, audit_chain_entry, started_at, finished_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13)
      `, [runId, did, d.suite_name, d.suite_version || null, total,
          d.passed || 0, d.failed || 0, d.skipped || 0, score,
          d.results ? JSON.stringify(d.results) : null,
          entry.hash, startedAt.toISOString(), finishedAt.toISOString()]);

      return res.status(201).json({
        run_id: runId, agent_did: did, suite_name: d.suite_name,
        score, total_cases: total, passed: d.passed || 0,
        failed: d.failed || 0, skipped: d.skipped || 0,
        audit_chain_entry: entry.hash, finished_at: finishedAt.toISOString()
      });
    } catch (e) {
      console.error('[eval.run]', e);
      return res.status(500).json({ error: 'run_failed', message: e.message });
    }
  });

  // GET /v1/agents/:did/eval/runs
  app.get('/v1/agents/:did/eval/runs', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const r = await pool.query(`
      SELECT run_id, suite_name, suite_version, total_cases, passed, failed, skipped,
             score, audit_chain_entry, started_at, finished_at
      FROM eval_runs WHERE agent_did = $1
      ORDER BY started_at DESC LIMIT $2
    `, [did, limit]).catch(() => ({ rows: [] }));
    return res.json({ agent_did: did, runs: r.rows, count: r.rows.length });
  });

  // POST /v1/agents/:did/eval/halluc
  const HallucSchema = z.object({
    category:         z.string().min(1).max(128),
    severity:         z.enum(SEVERITIES),
    claimed_output:   z.string().optional(),
    ground_truth:     z.string().optional(),
    input_context:    z.any().optional(),
    detection_method: z.string().max(128).optional(),
    remediation:      z.string().max(2000).optional()
  });

  app.post('/v1/agents/:did/eval/halluc', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const parse = HallucSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;

      const hallucId = genId('halluc');
      const now = new Date();
      const entry = await auditChain.append({
        event_type: 'eval.hallucination',
        agent_did: did,
        halluc_id: hallucId,
        category: d.category,
        severity: d.severity,
        detection_method: d.detection_method || null,
        timestamp: now.toISOString()
      });

      await pool.query(`
        INSERT INTO eval_hallucinations
        (halluc_id, agent_did, category, severity, claimed_output, ground_truth,
         input_context, detection_method, remediation, audit_chain_entry, detected_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11)
      `, [hallucId, did, d.category, d.severity,
          d.claimed_output || null, d.ground_truth || null,
          d.input_context ? JSON.stringify(d.input_context) : null,
          d.detection_method || null, d.remediation || null,
          entry.hash, now.toISOString()]);

      return res.status(201).json({
        halluc_id: hallucId, agent_did: did, severity: d.severity,
        audit_chain_entry: entry.hash, detected_at: now.toISOString()
      });
    } catch (e) {
      console.error('[eval.halluc]', e);
      return res.status(500).json({ error: 'halluc_record_failed', message: e.message });
    }
  });

  // GET /v1/agents/:did/eval/halluc
  app.get('/v1/agents/:did/eval/halluc', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    const sev = req.query.severity;
    const params = [did, limit];
    let where = `agent_did = $1`;
    if (sev && SEVERITIES.includes(sev)) {
      params.splice(1, 0, sev);
      where = `agent_did = $1 AND severity = $2`;
    }
    const r = await pool.query(`
      SELECT halluc_id, category, severity, claimed_output, ground_truth,
             input_context, detection_method, remediation, audit_chain_entry, detected_at
      FROM eval_hallucinations WHERE ${where}
      ORDER BY detected_at DESC LIMIT $${params.length}
    `, params).catch(() => ({ rows: [] }));
    return res.json({ agent_did: did, hallucinations: r.rows, count: r.rows.length });
  });

  // POST /v1/agents/:did/eval/baseline
  const BaselineSchema = z.object({
    name:        z.string().min(1).max(128),
    fingerprint: z.record(z.any()),
    sample_size: z.number().int().min(0).optional()
  });

  app.post('/v1/agents/:did/eval/baseline', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const parse = BaselineSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;

      // Retire previous active baselines
      await pool.query(
        `UPDATE eval_baselines SET retired_at = NOW()
         WHERE agent_did = $1 AND retired_at IS NULL`,
        [did]
      );

      const baselineId = genId('base');
      await pool.query(`
        INSERT INTO eval_baselines
        (baseline_id, agent_did, name, fingerprint, sample_size, established_at)
        VALUES ($1,$2,$3,$4::jsonb,$5, NOW())
      `, [baselineId, did, d.name, JSON.stringify(d.fingerprint), d.sample_size || 0]);

      await auditChain.append({
        event_type: 'eval.baseline_established',
        agent_did: did,
        baseline_id: baselineId,
        name: d.name,
        sample_size: d.sample_size || 0,
        timestamp: new Date().toISOString()
      });

      return res.status(201).json({
        baseline_id: baselineId, agent_did: did, name: d.name,
        sample_size: d.sample_size || 0, established_at: new Date().toISOString()
      });
    } catch (e) {
      console.error('[eval.baseline]', e);
      return res.status(500).json({ error: 'baseline_failed', message: e.message });
    }
  });

  // POST /v1/agents/:did/eval/drift-check
  const DriftSchema = z.object({
    current_fingerprint: z.record(z.any())
  });

  app.post('/v1/agents/:did/eval/drift-check', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const parse = DriftSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const { current_fingerprint } = parse.data;

      const baseR = await pool.query(
        `SELECT baseline_id, name, fingerprint, sample_size, established_at
         FROM eval_baselines WHERE agent_did = $1 AND retired_at IS NULL
         ORDER BY established_at DESC LIMIT 1`,
        [did]
      ).catch(() => ({ rows: [] }));

      if (!baseR.rows[0]) {
        return res.status(404).json({ error: 'no_active_baseline' });
      }
      const baseline = baseR.rows[0];
      const baselineFp = typeof baseline.fingerprint === 'string'
        ? JSON.parse(baseline.fingerprint) : baseline.fingerprint;

      const delta = computeFingerprintDelta(baselineFp, current_fingerprint);
      const driftDetected = delta.avg_delta > 0.1;

      await auditChain.append({
        event_type: 'eval.drift_check',
        agent_did: did,
        baseline_id: baseline.baseline_id,
        avg_delta: delta.avg_delta,
        drift_detected: driftDetected,
        timestamp: new Date().toISOString()
      });

      return res.json({
        agent_did: did,
        baseline_id: baseline.baseline_id,
        baseline_name: baseline.name,
        drift_detected: driftDetected,
        avg_delta: delta.avg_delta,
        threshold: 0.1,
        per_key: delta.per_key
      });
    } catch (e) {
      console.error('[eval.drift]', e);
      return res.status(500).json({ error: 'drift_check_failed', message: e.message });
    }
  });

  // POST /v1/agents/:did/eval/replay
  const ReplaySchema = z.object({
    source_audit_entry: z.string().optional(),
    policy_override:    z.record(z.any()).optional(),
    input_payload:      z.any(),
    original_output:    z.any(),
    replay_output:      z.any()
  });

  app.post('/v1/agents/:did/eval/replay', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const parse = ReplaySchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;

      const diff = computeDiff(d.original_output, d.replay_output);
      const replayId = genId('replay');

      const entry = await auditChain.append({
        event_type: 'eval.replay',
        agent_did: did,
        replay_id: replayId,
        source_audit_entry: d.source_audit_entry || null,
        identical: diff.identical,
        change_count: diff.changes.length,
        timestamp: new Date().toISOString()
      });

      await pool.query(`
        INSERT INTO eval_replays
        (replay_id, agent_did, source_audit_entry, policy_override, input_payload,
         original_output, replay_output, diff, audit_chain_entry, created_at)
        VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7::jsonb,$8::jsonb,$9, NOW())
      `, [replayId, did, d.source_audit_entry || null,
          d.policy_override ? JSON.stringify(d.policy_override) : null,
          JSON.stringify(d.input_payload ?? null),
          JSON.stringify(d.original_output ?? null),
          JSON.stringify(d.replay_output ?? null),
          JSON.stringify(diff),
          entry.hash]);

      return res.status(201).json({
        replay_id: replayId, agent_did: did,
        identical: diff.identical, diff,
        audit_chain_entry: entry.hash
      });
    } catch (e) {
      console.error('[eval.replay]', e);
      return res.status(500).json({ error: 'replay_failed', message: e.message });
    }
  });
}

module.exports = {
  migrate,
  registerEvalRoutes,
  computeDiff,
  computeFingerprintDelta,
  SEVERITIES
};
