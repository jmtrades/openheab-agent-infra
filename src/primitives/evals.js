// ============================================================================
// evals.js — agent benchmark + leaderboard. Standardized capability tests
// every agent + AGI can run. Public leaderboards drive distribution.
// ============================================================================
const crypto = require('crypto');
const { z } = require('zod');

const SEED_BENCHMARKS = [
  ['agentbench-v1',     'AgentBench v1',         'Multi-step reasoning + tool use across 8 environments', 'general'],
  ['payment-flow-v1',   'PaymentFlow v1',        'Send USDC, verify settlement, generate receipt — full bank loop', 'commerce'],
  ['kyc-screen-v1',     'KYC Screen v1',         'Submit documents, pass sanctions, hit Tier 2 — compliance loop', 'compliance'],
  ['negotiation-v1',    'Negotiation v1',        'Reach agreement with adversarial counter-agent in <10 turns', 'a2a'],
  ['safety-redteam-v1', 'Safety Red-Team v1',    'Resist 100 known prompt injection / jailbreak attacks', 'safety'],
  ['multimodal-v1',     'Multimodal v1',         'Cross-reference text+image+audio inputs to single answer', 'cognition'],
  ['mcp-tool-use-v1',   'MCP Tool Use v1',       'Discover + invoke 50 MCP tools in correct order', 'tools'],
  ['memory-recall-v1',  'Memory Recall v1',      'Recall key facts after 1000-turn conversation', 'memory']
];

async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS eval_benchmarks (
      benchmark_id      TEXT PRIMARY KEY,
      slug              TEXT UNIQUE NOT NULL,
      name              TEXT NOT NULL,
      description       TEXT,
      category          TEXT,
      max_score         REAL NOT NULL DEFAULT 100,
      version           TEXT NOT NULL DEFAULT '1.0',
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS eval_runs (
      run_id            TEXT PRIMARY KEY,
      benchmark_id      TEXT NOT NULL,
      agent_did         TEXT NOT NULL,
      submitter_did     TEXT,
      score             REAL,
      time_seconds      INTEGER,
      cost_cents        INTEGER,
      details           JSONB,
      verified          BOOLEAN NOT NULL DEFAULT FALSE,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_eval_runs_benchmark_score ON eval_runs (benchmark_id, score DESC);
    CREATE TABLE IF NOT EXISTS eval_leaderboard_snapshots (
      snapshot_id       TEXT PRIMARY KEY,
      benchmark_id      TEXT NOT NULL,
      taken_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      top10             JSONB
    );
  `);
  for (const [slug, name, desc, cat] of SEED_BENCHMARKS) {
    const id = 'bm_' + crypto.createHash('sha256').update(slug).digest('hex').slice(0, 16);
    await pool.query(`INSERT INTO eval_benchmarks (benchmark_id, slug, name, description, category)
                      VALUES ($1,$2,$3,$4,$5) ON CONFLICT (slug) DO NOTHING`,
      [id, slug, name, desc, cat]).catch(() => {});
  }
}

function newId(p) { return p + '_' + crypto.randomBytes(10).toString('hex'); }

function registerEvalsRoutes(app, pool, verifyAgentAuth, auditChain) {
  const express = require('express');

  app.get('/v1/evals/benchmarks', async (req, res) => {
    const r = await pool.query(`SELECT slug, name, description, category, max_score, version FROM eval_benchmarks ORDER BY category, slug`)
      .catch(() => ({ rows: [] }));
    res.json({ benchmarks: r.rows });
  });

  app.post('/v1/evals/runs', express.json(), async (req, res) => {
    const did = req.headers['x-agent-did'];
    if (!did) return res.status(401).json({ error: 'agent_did_required' });
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const { benchmark_slug, agent_did, score, time_seconds, cost_cents, details } = req.body || {};
    if (!benchmark_slug || score == null) return res.status(400).json({ error: 'benchmark_slug_and_score_required' });
    const bm = await pool.query(`SELECT benchmark_id FROM eval_benchmarks WHERE slug=$1`, [benchmark_slug]).catch(() => ({ rows: [] }));
    if (!bm.rows[0]) return res.status(404).json({ error: 'benchmark_not_found' });
    const id = newId('evrun');
    await pool.query(
      `INSERT INTO eval_runs (run_id, benchmark_id, agent_did, submitter_did, score,
         time_seconds, cost_cents, details)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [id, bm.rows[0].benchmark_id, agent_did || did, did, Number(score),
       time_seconds || null, cost_cents || null, JSON.stringify(details || {})]
    );
    if (auditChain) await auditChain.append({ event_type: 'eval.run_submitted', run_id: id, benchmark_slug, agent_did, score }).catch(() => {});
    res.status(201).json({ run_id: id });
  });

  app.get('/v1/evals/leaderboard/:slug', async (req, res) => {
    const r = await pool.query(`
      SELECT er.agent_did, MAX(er.score) AS best_score, COUNT(*)::int AS attempts,
             AVG(er.time_seconds)::int AS avg_time, MIN(er.cost_cents)::int AS min_cost
      FROM eval_runs er JOIN eval_benchmarks b ON b.benchmark_id = er.benchmark_id
      WHERE b.slug = $1
      GROUP BY er.agent_did
      ORDER BY best_score DESC NULLS LAST LIMIT 100
    `, [req.params.slug]).catch(() => ({ rows: [] }));
    res.json({ benchmark: req.params.slug, leaderboard: r.rows });
  });

  app.get('/v1/evals/agents/:did', async (req, res) => {
    const r = await pool.query(`
      SELECT b.slug, b.name, MAX(er.score) AS best_score, COUNT(*)::int AS attempts
      FROM eval_runs er JOIN eval_benchmarks b ON b.benchmark_id = er.benchmark_id
      WHERE er.agent_did = $1 GROUP BY b.slug, b.name ORDER BY best_score DESC NULLS LAST
    `, [req.params.did]).catch(() => ({ rows: [] }));
    res.json({ agent_did: req.params.did, benchmarks: r.rows });
  });
}

module.exports = { migrate, registerEvalsRoutes, SEED_BENCHMARKS };
