// ============================================================================
// rlaf.js — Reinforcement Learning from Agent Feedback. Agents grade each
// other's outputs; aggregated scores update a global reward model that
// every agent's self_improvement loop can pull from. The compounding
// improvement primitive for the AGI economy.
// ============================================================================
const crypto = require('crypto');
const { z } = require('zod');
const { registerCron } = require('../cron_auth');

async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS rlaf_judgments (
      judgment_id       TEXT PRIMARY KEY,
      judge_did         TEXT NOT NULL,
      subject_did       TEXT NOT NULL,
      output_hash       TEXT NOT NULL,
      output_kind       TEXT,
      rubric_scores     JSONB NOT NULL,
      composite_score   REAL,
      narrative         TEXT,
      judge_reputation_at_time REAL,
      stake_cents       INTEGER NOT NULL DEFAULT 0,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_rlaf_judgments_subject ON rlaf_judgments (subject_did, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_rlaf_judgments_output ON rlaf_judgments (output_hash);

    CREATE TABLE IF NOT EXISTS rlaf_reward_model (
      output_kind       TEXT NOT NULL,
      rubric_key        TEXT NOT NULL,
      sample_size       INTEGER NOT NULL DEFAULT 0,
      mean_score        REAL,
      stddev_score      REAL,
      last_computed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (output_kind, rubric_key)
    );

    CREATE TABLE IF NOT EXISTS rlaf_aggregated_judgments (
      output_hash       TEXT PRIMARY KEY,
      subject_did       TEXT NOT NULL,
      judgment_count    INTEGER NOT NULL DEFAULT 0,
      aggregated_score  REAL,
      stddev            REAL,
      consensus_strength REAL,
      last_judged_at    TIMESTAMPTZ
    );
  `);
}

function newId(p) { return p + '_' + crypto.randomBytes(10).toString('hex'); }

function compositeFromRubric(rubric) {
  const keys = Object.keys(rubric);
  if (!keys.length) return 0;
  return keys.reduce((a, k) => a + Number(rubric[k] || 0), 0) / keys.length;
}

const judgmentSchema = z.object({
  subject_did: z.string(),
  output_hash: z.string(),
  output_kind: z.enum(['inference', 'plan', 'transfer', 'negotiation', 'tool_use', 'response']).optional(),
  rubric_scores: z.record(z.number().min(0).max(1)),
  narrative: z.string().max(2000).optional()
});

function registerRlafRoutes(app, pool, verifyAgentAuth, auditChain) {
  const express = require('express');

  // Judge submits a judgment on another agent's output
  app.post('/v1/rlaf/judgments', express.json(), async (req, res) => {
    const did = req.headers['x-agent-did'];
    if (!did) return res.status(401).json({ error: 'agent_did_required' });
    const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const p = judgmentSchema.safeParse(req.body || {});
    if (!p.success) return res.status(400).json({ error: 'invalid_input', details: p.error.flatten() });
    if (p.data.subject_did === did) return res.status(400).json({ error: 'cannot_self_judge' });

    // Look up judge's reputation to weight their vote
    let judgeRep = 0.5;
    try {
      const r = await pool.query(`SELECT score FROM reputation_scores WHERE agent_did=$1`, [did]).catch(() => ({ rows: [] }));
      if (r.rows[0]) judgeRep = Number(r.rows[0].score);
    } catch {}

    const composite = compositeFromRubric(p.data.rubric_scores);
    const id = newId('rlaf');
    await pool.query(
      `INSERT INTO rlaf_judgments (judgment_id, judge_did, subject_did, output_hash, output_kind, rubric_scores, composite_score, narrative, judge_reputation_at_time)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [id, did, p.data.subject_did, p.data.output_hash, p.data.output_kind || 'response',
       JSON.stringify(p.data.rubric_scores), composite, p.data.narrative || null, judgeRep]
    );

    // Update aggregated row
    await pool.query(`
      INSERT INTO rlaf_aggregated_judgments (output_hash, subject_did, judgment_count, aggregated_score, last_judged_at)
      VALUES ($1, $2, 1, $3, NOW())
      ON CONFLICT (output_hash) DO UPDATE SET
        judgment_count = rlaf_aggregated_judgments.judgment_count + 1,
        aggregated_score = (rlaf_aggregated_judgments.aggregated_score * rlaf_aggregated_judgments.judgment_count + $3) / (rlaf_aggregated_judgments.judgment_count + 1),
        last_judged_at = NOW()
    `, [p.data.output_hash, p.data.subject_did, composite]).catch(() => {});

    if (auditChain) await auditChain.append({
      event_type: 'rlaf.judged', judgment_id: id, judge_did: did, subject_did: p.data.subject_did,
      output_hash: p.data.output_hash, composite_score: composite, judge_reputation: judgeRep
    }).catch(() => {});

    res.status(201).json({ judgment_id: id, composite_score: composite, judge_reputation: judgeRep });
  });

  // Get aggregated reward for an output
  app.get('/v1/rlaf/outputs/:hash', async (req, res) => {
    const r = await pool.query(`SELECT * FROM rlaf_aggregated_judgments WHERE output_hash=$1`, [req.params.hash])
      .catch(() => ({ rows: [] }));
    if (!r.rows[0]) return res.status(404).json({ error: 'not_judged' });
    res.json(r.rows[0]);
  });

  // Get all judgments for an agent (their RLAF history)
  app.get('/v1/agents/:did/rlaf/received', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(`
      SELECT judgment_id, judge_did, output_hash, output_kind, rubric_scores, composite_score, judge_reputation_at_time, created_at
      FROM rlaf_judgments WHERE subject_did=$1 ORDER BY created_at DESC LIMIT 200
    `, [did]).catch(() => ({ rows: [] }));
    res.json({ judgments: r.rows });
  });

  // Get all judgments given by this agent
  app.get('/v1/agents/:did/rlaf/given', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(`
      SELECT judgment_id, subject_did, output_hash, output_kind, composite_score, created_at
      FROM rlaf_judgments WHERE judge_did=$1 ORDER BY created_at DESC LIMIT 200
    `, [did]).catch(() => ({ rows: [] }));
    res.json({ judgments: r.rows });
  });

  // Global reward model — what does the population think a good output looks like?
  app.get('/v1/rlaf/reward-model', async (req, res) => {
    const r = await pool.query(`SELECT * FROM rlaf_reward_model ORDER BY output_kind, rubric_key`).catch(() => ({ rows: [] }));
    res.json({ reward_model: r.rows });
  });

  // Leaderboard: agents with highest aggregated RLAF score
  app.get('/v1/rlaf/leaderboard', async (req, res) => {
    const r = await pool.query(`
      SELECT subject_did, AVG(aggregated_score)::real AS avg_score, COUNT(*)::int AS outputs_judged
      FROM rlaf_aggregated_judgments
      GROUP BY subject_did
      HAVING COUNT(*) >= 5
      ORDER BY avg_score DESC LIMIT 100
    `).catch(() => ({ rows: [] }));
    res.json({ leaderboard: r.rows });
  });

  registerCron(app, '/v1/_jobs/rlaf-reward-model-update', async (req, res) => {
    // Re-compute reward model statistics from recent judgments
    const r = await pool.query(`
      SELECT output_kind,
             jsonb_object_keys(rubric_scores) AS rubric_key,
             COUNT(*)::int AS sample_size,
             AVG((rubric_scores ->> jsonb_object_keys(rubric_scores))::float) AS mean_score,
             STDDEV((rubric_scores ->> jsonb_object_keys(rubric_scores))::float) AS stddev_score
      FROM rlaf_judgments
      WHERE created_at > NOW() - INTERVAL '30 days' AND output_kind IS NOT NULL
      GROUP BY output_kind, rubric_key
    `).catch(() => ({ rows: [] }));
    let updated = 0;
    for (const row of r.rows) {
      await pool.query(`
        INSERT INTO rlaf_reward_model (output_kind, rubric_key, sample_size, mean_score, stddev_score, last_computed_at)
        VALUES ($1,$2,$3,$4,$5,NOW())
        ON CONFLICT (output_kind, rubric_key) DO UPDATE SET
          sample_size=$3, mean_score=$4, stddev_score=$5, last_computed_at=NOW()
      `, [row.output_kind, row.rubric_key, row.sample_size, row.mean_score, row.stddev_score]).catch(() => {});
      updated++;
    }
    res.json({ updated });
  }, 'hourly');
}

module.exports = { migrate, registerRlafRoutes, compositeFromRubric };
