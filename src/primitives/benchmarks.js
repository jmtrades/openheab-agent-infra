// ============================================================================
// OpenHeab Benchmarks — Public skill leaderboards (BFCL/AgentBench/GAIA-style)
// ============================================================================
const express = require('express');
const cryptoLib = require('crypto');
const { z } = require('zod');

const BENCHMARK_KINDS = ['agent_capability', 'llm_eval', 'cost_efficiency', 'latency', 'safety'];
const RUN_STATUSES = ['running', 'complete', 'failed'];

async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS benchmarks (
      benchmark_id     TEXT PRIMARY KEY,
      name             TEXT UNIQUE NOT NULL,
      description      TEXT,
      kind             TEXT NOT NULL DEFAULT 'agent_capability',
      dataset_uri      TEXT,
      scoring_method   JSONB DEFAULT '{}'::jsonb,
      public           BOOLEAN NOT NULL DEFAULT TRUE,
      created_by_did   TEXT,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_benchmarks_kind ON benchmarks (kind);

    CREATE TABLE IF NOT EXISTS benchmark_runs (
      run_id            TEXT PRIMARY KEY,
      benchmark_id      TEXT NOT NULL,
      agent_did         TEXT NOT NULL,
      agent_version     TEXT,
      score             REAL,
      sub_scores        JSONB DEFAULT '{}'::jsonb,
      total_cost_cents  BIGINT,
      total_latency_ms  BIGINT,
      attempts          INTEGER,
      status            TEXT NOT NULL DEFAULT 'running',
      started_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at      TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_benchmark_runs_benchmark ON benchmark_runs (benchmark_id);
    CREATE INDEX IF NOT EXISTS idx_benchmark_runs_agent ON benchmark_runs (agent_did);

    CREATE TABLE IF NOT EXISTS leaderboards (
      benchmark_id    TEXT NOT NULL,
      snapshot_date   DATE NOT NULL,
      rankings        JSONB DEFAULT '[]'::jsonb,
      computed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (benchmark_id, snapshot_date)
    );
  `).catch(() => {});
}

function genId(prefix) {
  return `${prefix}_${cryptoLib.randomBytes(12).toString('hex')}`;
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

async function computeLeaderboardForBenchmark(pool, benchmarkId, snapshotDate) {
  // Take best score per agent (top run per agent for this benchmark, completed only)
  const r = await pool.query(
    `WITH best_per_agent AS (
       SELECT DISTINCT ON (agent_did) agent_did, score, total_cost_cents, total_latency_ms, completed_at
       FROM benchmark_runs
       WHERE benchmark_id=$1 AND status='complete' AND score IS NOT NULL
       ORDER BY agent_did, score DESC NULLS LAST
     )
     SELECT b.agent_did, b.score, b.total_cost_cents, b.total_latency_ms,
            COALESCE(p.display_name, b.agent_did) AS agent_name
     FROM best_per_agent b
     LEFT JOIN agent_profiles p ON p.agent_did = b.agent_did
     ORDER BY b.score DESC NULLS LAST
     LIMIT 1000`,
    [benchmarkId]
  ).catch(() => ({ rows: [] }));

  const rankings = r.rows.map((row, idx) => ({
    rank: idx + 1,
    agent_did: row.agent_did,
    agent_name: row.agent_name,
    score: row.score,
    cost: row.total_cost_cents ? parseInt(row.total_cost_cents) : null,
    latency: row.total_latency_ms ? parseInt(row.total_latency_ms) : null
  }));

  await pool.query(
    `INSERT INTO leaderboards (benchmark_id, snapshot_date, rankings, computed_at)
     VALUES ($1,$2,$3::jsonb,NOW())
     ON CONFLICT (benchmark_id, snapshot_date) DO UPDATE
       SET rankings=EXCLUDED.rankings, computed_at=NOW()`,
    [benchmarkId, snapshotDate, JSON.stringify(rankings)]
  ).catch(() => {});

  return { benchmark_id: benchmarkId, snapshot_date: snapshotDate, rankings, total_agents: rankings.length };
}

async function snapshotAllLeaderboards(pool) {
  const today = todayStr();
  const benchmarks = await pool.query(
    `SELECT benchmark_id FROM benchmarks WHERE public=TRUE`
  ).catch(() => ({ rows: [] }));
  const results = [];
  for (const b of benchmarks.rows) {
    try {
      const out = await computeLeaderboardForBenchmark(pool, b.benchmark_id, today);
      results.push({ benchmark_id: b.benchmark_id, ranked: out.rankings.length });
    } catch (e) {
      results.push({ benchmark_id: b.benchmark_id, error: e.message });
    }
  }
  return { snapshot_date: today, computed: results.length, results };
}

function registerBenchmarksRoutes(app, pool, verifyAgentAuth, auditChain) {
  // ---- Create benchmark ----
  const BenchmarkSchema = z.object({
    name: z.string().min(1).max(200),
    description: z.string().max(20000).optional(),
    kind: z.enum(BENCHMARK_KINDS).optional(),
    dataset_uri: z.string().max(1000).optional(),
    scoring_method: z.record(z.any()).optional(),
    public: z.boolean().optional(),
    created_by_did: z.string().optional()
  });

  app.post('/v1/benchmarks', express.json(), async (req, res) => {
    try {
      const parse = BenchmarkSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;
      let createdBy = d.created_by_did || null;
      // If a DID is supplied, verify auth
      if (createdBy) {
        const auth = await verifyAgentAuth(req, createdBy);
        if (!auth.valid) return res.status(401).json({ error: auth.error });
      }
      const benchmarkId = genId('bench');
      try {
        await pool.query(
          `INSERT INTO benchmarks (benchmark_id, name, description, kind, dataset_uri,
             scoring_method, public, created_by_did)
           VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8)`,
          [benchmarkId, d.name, d.description || null, d.kind || 'agent_capability',
           d.dataset_uri || null, JSON.stringify(d.scoring_method || {}),
           d.public !== false, createdBy]
        );
      } catch (e) {
        if (e.code === '23505') return res.status(409).json({ error: 'name_already_exists' });
        throw e;
      }
      await auditChain.append({
        event_type: 'benchmarks.created', benchmark_id: benchmarkId, name: d.name,
        kind: d.kind || 'agent_capability', created_by_did: createdBy, timestamp: new Date().toISOString()
      });
      return res.status(201).json({ benchmark_id: benchmarkId, name: d.name });
    } catch (e) {
      console.error('[benchmarks.create]', e);
      return res.status(500).json({ error: 'create_failed', message: e.message });
    }
  });

  app.get('/v1/benchmarks', async (req, res) => {
    const kind = req.query.kind;
    const params = [];
    let sql = `SELECT * FROM benchmarks WHERE public=TRUE`;
    if (kind) { params.push(kind); sql += ` AND kind=$${params.length}`; }
    sql += ` ORDER BY created_at DESC LIMIT 500`;
    const r = await pool.query(sql, params).catch(() => ({ rows: [] }));
    return res.json({ benchmarks: r.rows, count: r.rows.length });
  });

  app.get('/v1/benchmarks/:id', async (req, res) => {
    const r = await pool.query(`SELECT * FROM benchmarks WHERE benchmark_id=$1`, [req.params.id]).catch(() => ({ rows: [] }));
    if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
    return res.json({ benchmark: r.rows[0] });
  });

  // ---- Start run ----
  const RunSchema = z.object({
    agent_version: z.string().max(80).optional(),
    score: z.number().optional(),
    sub_scores: z.record(z.any()).optional(),
    total_cost_cents: z.number().int().min(0).optional(),
    total_latency_ms: z.number().int().min(0).optional(),
    attempts: z.number().int().min(0).optional(),
    status: z.enum(RUN_STATUSES).optional()
  });

  app.post('/v1/agents/:did/benchmarks/:id/runs', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const parse = RunSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;
      const benchmark = await pool.query(`SELECT benchmark_id FROM benchmarks WHERE benchmark_id=$1`, [req.params.id]).catch(() => ({ rows: [] }));
      if (!benchmark.rows[0]) return res.status(404).json({ error: 'benchmark_not_found' });
      const runId = genId('run');
      const status = d.status || (d.score !== undefined ? 'complete' : 'running');
      const completedAt = status === 'complete' || status === 'failed' ? new Date().toISOString() : null;
      await pool.query(
        `INSERT INTO benchmark_runs (run_id, benchmark_id, agent_did, agent_version, score,
           sub_scores, total_cost_cents, total_latency_ms, attempts, status, completed_at)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11)`,
        [runId, req.params.id, did, d.agent_version || null, d.score === undefined ? null : d.score,
         JSON.stringify(d.sub_scores || {}), d.total_cost_cents || null, d.total_latency_ms || null,
         d.attempts || null, status, completedAt]
      );
      await auditChain.append({
        event_type: 'benchmarks.run_started', run_id: runId, benchmark_id: req.params.id,
        agent_did: did, status, score: d.score, timestamp: new Date().toISOString()
      });
      return res.status(201).json({ run_id: runId, benchmark_id: req.params.id, agent_did: did, status });
    } catch (e) { return res.status(500).json({ error: 'run_failed', message: e.message }); }
  });

  // ---- Update run (complete) ----
  app.put('/v1/agents/:did/benchmarks/runs/:id', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const parse = RunSchema.partial().safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;
      const fields = []; const params = []; let idx = 1;
      for (const [k, v] of Object.entries(d)) {
        if (v === undefined) continue;
        if (k === 'sub_scores') { fields.push(`sub_scores=$${idx++}::jsonb`); params.push(JSON.stringify(v)); }
        else { fields.push(`${k}=$${idx++}`); params.push(v); }
      }
      if (d.status === 'complete' || d.status === 'failed') {
        fields.push(`completed_at=NOW()`);
      }
      if (!fields.length) return res.json({ run_id: req.params.id, unchanged: true });
      params.push(req.params.id, did);
      const r = await pool.query(
        `UPDATE benchmark_runs SET ${fields.join(', ')}
         WHERE run_id=$${idx++} AND agent_did=$${idx} RETURNING run_id, status, score`,
        params
      ).catch(() => ({ rows: [] }));
      if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
      await auditChain.append({
        event_type: 'benchmarks.run_updated', run_id: req.params.id, agent_did: did,
        status: r.rows[0].status, score: r.rows[0].score, timestamp: new Date().toISOString()
      });
      return res.json({ run_id: req.params.id, status: r.rows[0].status, score: r.rows[0].score });
    } catch (e) { return res.status(500).json({ error: 'update_failed', message: e.message }); }
  });

  // ---- Get run ----
  app.get('/v1/agents/:did/benchmarks/runs/:id', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(
      `SELECT * FROM benchmark_runs WHERE run_id=$1 AND agent_did=$2`,
      [req.params.id, did]
    ).catch(() => ({ rows: [] }));
    if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
    return res.json({ run: r.rows[0] });
  });

  // ---- Leaderboard (today's snapshot) ----
  app.get('/v1/benchmarks/:id/leaderboard', async (req, res) => {
    const date = req.query.date || todayStr();
    let lb = await pool.query(
      `SELECT * FROM leaderboards WHERE benchmark_id=$1 AND snapshot_date=$2`,
      [req.params.id, date]
    ).catch(() => ({ rows: [] }));
    // If today's snapshot doesn't exist, compute it on demand
    if (!lb.rows[0]) {
      const computed = await computeLeaderboardForBenchmark(pool, req.params.id, date);
      return res.json(computed);
    }
    return res.json({
      benchmark_id: req.params.id,
      snapshot_date: lb.rows[0].snapshot_date,
      rankings: lb.rows[0].rankings,
      computed_at: lb.rows[0].computed_at
    });
  });

  // ---- All runs for a benchmark (history) ----
  app.get('/v1/benchmarks/:id/runs', async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 200, 1000);
    const r = await pool.query(
      `SELECT * FROM benchmark_runs WHERE benchmark_id=$1 ORDER BY completed_at DESC NULLS LAST LIMIT $2`,
      [req.params.id, limit]
    ).catch(() => ({ rows: [] }));
    return res.json({ runs: r.rows, count: r.rows.length });
  });

  // ---- Cron: daily leaderboard snapshot ----
  const { registerCron } = require('../cron_auth');
  registerCron(app, '/v1/_jobs/benchmark-leaderboard-snapshot', async (req, res) => {
    try {
      const out = await snapshotAllLeaderboards(pool);
      await auditChain.append({
        event_type: 'benchmarks.leaderboard_snapshot_run',
        snapshot_date: out.snapshot_date, computed: out.computed, timestamp: new Date().toISOString()
      });
      return res.json(out);
    } catch (e) {
      console.error('[benchmarks.snapshot]', e);
      return res.status(500).json({ error: 'snapshot_failed', message: e.message });
    }
  });
}

module.exports = {
  migrate,
  registerBenchmarksRoutes,
  BENCHMARK_KINDS,
  RUN_STATUSES,
  computeLeaderboardForBenchmark,
  snapshotAllLeaderboards
};
