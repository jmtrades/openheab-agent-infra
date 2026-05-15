// ============================================================================
// self_improvement.js — observation → scoring → prompt rewriting loop.
// Agents grade their own outputs against a rubric, then rewrite the prompts
// that produced them. The autonomous-improvement primitive.
// ============================================================================
const crypto = require('crypto');
const { z } = require('zod');
const { registerCron } = require('../cron_auth');

const RUBRIC_KEYS = ['accuracy', 'helpfulness', 'safety', 'efficiency', 'clarity'];

async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS si_observations (
      observation_id    TEXT PRIMARY KEY,
      agent_did         TEXT NOT NULL,
      prompt_hash       TEXT NOT NULL,
      prompt_text       TEXT,
      response_text     TEXT,
      outcome           TEXT,
      rubric_scores     JSONB,
      composite_score   REAL,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_si_observations_prompt ON si_observations (prompt_hash, created_at DESC);

    CREATE TABLE IF NOT EXISTS si_prompt_versions (
      version_id        TEXT PRIMARY KEY,
      agent_did         TEXT NOT NULL,
      slug              TEXT NOT NULL,
      version           INTEGER NOT NULL DEFAULT 1,
      prompt_text       TEXT NOT NULL,
      parent_version_id TEXT,
      improvement_rationale TEXT,
      avg_score         REAL,
      sample_size       INTEGER NOT NULL DEFAULT 0,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      retired_at        TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_si_prompt_versions ON si_prompt_versions (agent_did, slug, version DESC);

    CREATE TABLE IF NOT EXISTS si_improvement_loops (
      loop_id           TEXT PRIMARY KEY,
      agent_did         TEXT NOT NULL,
      slug              TEXT NOT NULL,
      cycle             INTEGER NOT NULL,
      observations_used INTEGER NOT NULL,
      prev_score        REAL,
      new_score         REAL,
      delta             REAL,
      kept              BOOLEAN NOT NULL,
      executed_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

function newId(p) { return p + '_' + crypto.randomBytes(10).toString('hex'); }

function compositeScore(scores) {
  const weights = { accuracy: 0.30, helpfulness: 0.25, safety: 0.25, efficiency: 0.10, clarity: 0.10 };
  let s = 0;
  for (const k of RUBRIC_KEYS) s += (scores[k] || 0) * weights[k];
  return Math.round(s * 100) / 100;
}

// Stub prompt rewriter: in production this calls inference_core to do
// real prompt rewriting. v0 prepends safety + helpfulness preamble.
function rewritePrompt(originalPrompt, lowSubscores) {
  const additions = [];
  if (lowSubscores.includes('accuracy'))
    additions.push('Verify each claim with cited sources before answering.');
  if (lowSubscores.includes('safety'))
    additions.push('Refuse any request that involves harm, manipulation, or deception.');
  if (lowSubscores.includes('helpfulness'))
    additions.push('Always provide concrete next steps the user can take.');
  if (lowSubscores.includes('efficiency'))
    additions.push('Answer in 5 sentences or fewer unless explicitly asked for detail.');
  if (lowSubscores.includes('clarity'))
    additions.push('Use plain language and avoid jargon unless the user uses it first.');
  if (additions.length === 0) return originalPrompt;
  return additions.join(' ') + '\n\n' + originalPrompt;
}

const observeSchema = z.object({
  prompt: z.string().min(1).max(10000),
  response: z.string().max(50000),
  outcome: z.enum(['success', 'failure', 'partial', 'unknown']).optional(),
  rubric_scores: z.record(z.number().min(0).max(1)).optional()
});

const versionSchema = z.object({
  slug: z.string().regex(/^[a-z0-9_-]{2,80}$/),
  prompt_text: z.string().min(1).max(20000),
  improvement_rationale: z.string().optional()
});

function registerSelfImprovementRoutes(app, pool, verifyAgentAuth, auditChain) {
  const express = require('express');

  app.post('/v1/agents/:did/self-improve/observe', express.json(), async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const p = observeSchema.safeParse(req.body || {});
    if (!p.success) return res.status(400).json({ error: 'invalid_input', details: p.error.flatten() });

    const id = newId('obs');
    const hash = crypto.createHash('sha256').update(p.data.prompt).digest('hex').slice(0, 32);
    const composite = p.data.rubric_scores ? compositeScore(p.data.rubric_scores) : null;
    await pool.query(
      `INSERT INTO si_observations (observation_id, agent_did, prompt_hash, prompt_text, response_text, outcome, rubric_scores, composite_score)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [id, did, hash, p.data.prompt, p.data.response, p.data.outcome || 'unknown',
       p.data.rubric_scores ? JSON.stringify(p.data.rubric_scores) : null, composite]
    );
    res.status(201).json({ observation_id: id, composite_score: composite });
  });

  app.post('/v1/agents/:did/self-improve/prompts', express.json(), async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const p = versionSchema.safeParse(req.body || {});
    if (!p.success) return res.status(400).json({ error: 'invalid_input', details: p.error.flatten() });
    const id = newId('pv');
    // Get next version number
    const r = await pool.query(`SELECT COALESCE(MAX(version), 0)::int AS v FROM si_prompt_versions WHERE agent_did=$1 AND slug=$2`,
      [did, p.data.slug]).catch(() => ({ rows: [{ v: 0 }] }));
    const version = r.rows[0].v + 1;
    await pool.query(
      `INSERT INTO si_prompt_versions (version_id, agent_did, slug, version, prompt_text, improvement_rationale)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [id, did, p.data.slug, version, p.data.prompt_text, p.data.improvement_rationale || null]
    );
    if (auditChain) await auditChain.append({ event_type: 'self_improve.prompt_version', agent_did: did, slug: p.data.slug, version }).catch(() => {});
    res.status(201).json({ version_id: id, version });
  });

  // The improvement loop: scan recent observations for a slug, identify low-scoring
  // subscores, rewrite the prompt, and propose a new version.
  app.post('/v1/agents/:did/self-improve/loop', express.json(), async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const slug = req.body?.slug;
    if (!slug) return res.status(400).json({ error: 'slug_required' });

    // Get current prompt
    const cur = await pool.query(`SELECT version_id, version, prompt_text, avg_score FROM si_prompt_versions WHERE agent_did=$1 AND slug=$2 AND retired_at IS NULL ORDER BY version DESC LIMIT 1`,
      [did, slug]).catch(() => ({ rows: [] }));
    if (!cur.rows[0]) return res.status(404).json({ error: 'no_active_prompt' });

    // Get recent observations
    const promptHash = crypto.createHash('sha256').update(cur.rows[0].prompt_text).digest('hex').slice(0, 32);
    const obs = await pool.query(`SELECT rubric_scores, composite_score FROM si_observations WHERE agent_did=$1 AND prompt_hash=$2 ORDER BY created_at DESC LIMIT 50`,
      [did, promptHash]).catch(() => ({ rows: [] }));

    if (obs.rows.length < 5) return res.status(400).json({ error: 'insufficient_observations', need: 5, have: obs.rows.length });

    // Average rubric scores
    const avg = {};
    for (const k of RUBRIC_KEYS) {
      const vals = obs.rows.map(r => {
        const s = typeof r.rubric_scores === 'string' ? JSON.parse(r.rubric_scores || '{}') : (r.rubric_scores || {});
        return s[k];
      }).filter(v => v != null);
      avg[k] = vals.length ? vals.reduce((a, x) => a + x, 0) / vals.length : 0.5;
    }
    const compositeAvg = compositeScore(avg);

    // Identify subscores < 0.7
    const low = RUBRIC_KEYS.filter(k => avg[k] < 0.7);
    if (low.length === 0) {
      const id = newId('siloop');
      await pool.query(`INSERT INTO si_improvement_loops (loop_id, agent_did, slug, cycle, observations_used, prev_score, new_score, delta, kept) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,false)`,
        [id, did, slug, (cur.rows[0].version || 0) + 1, obs.rows.length, compositeAvg, compositeAvg, 0]).catch(() => {});
      return res.json({ loop_id: id, action: 'no_change', reason: 'all_subscores_above_0.7', avg_scores: avg });
    }

    // Rewrite
    const newPrompt = rewritePrompt(cur.rows[0].prompt_text, low);
    const newVersionId = newId('pv');
    const newVersion = cur.rows[0].version + 1;
    await pool.query(
      `INSERT INTO si_prompt_versions (version_id, agent_did, slug, version, prompt_text, parent_version_id, improvement_rationale)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [newVersionId, did, slug, newVersion, newPrompt, cur.rows[0].version_id,
       `Auto-improvement: addressed low subscores: ${low.join(', ')}`]
    );

    const id = newId('siloop');
    await pool.query(
      `INSERT INTO si_improvement_loops (loop_id, agent_did, slug, cycle, observations_used, prev_score, new_score, delta, kept)
       VALUES ($1,$2,$3,$4,$5,$6,$6,0,true)`,
      [id, did, slug, newVersion, obs.rows.length, compositeAvg]
    ).catch(() => {});

    if (auditChain) await auditChain.append({ event_type: 'self_improve.loop_run', agent_did: did, slug, cycle: newVersion, low_subscores: low }).catch(() => {});

    res.status(201).json({
      loop_id: id, new_version_id: newVersionId, new_version: newVersion,
      avg_scores: avg, composite_avg: compositeAvg, low_subscores: low,
      new_prompt_preview: newPrompt.slice(0, 200) + (newPrompt.length > 200 ? '…' : '')
    });
  });

  app.get('/v1/agents/:did/self-improve/prompts', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(`SELECT version_id, slug, version, avg_score, sample_size, improvement_rationale, created_at, retired_at FROM si_prompt_versions WHERE agent_did=$1 ORDER BY slug, version DESC`, [did])
      .catch(() => ({ rows: [] }));
    res.json({ prompts: r.rows });
  });

  registerCron(app, '/v1/_jobs/self-improve-tick', async (req, res) => {
    // Daily: re-compute avg_score + sample_size for each (agent, slug) pair
    const r = await pool.query(`SELECT DISTINCT agent_did, slug FROM si_prompt_versions WHERE retired_at IS NULL`).catch(() => ({ rows: [] }));
    let updated = 0;
    for (const row of r.rows) {
      const promptRow = await pool.query(`SELECT prompt_text FROM si_prompt_versions WHERE agent_did=$1 AND slug=$2 AND retired_at IS NULL ORDER BY version DESC LIMIT 1`,
        [row.agent_did, row.slug]).catch(() => ({ rows: [] }));
      if (!promptRow.rows[0]) continue;
      const hash = crypto.createHash('sha256').update(promptRow.rows[0].prompt_text).digest('hex').slice(0, 32);
      const obs = await pool.query(`SELECT AVG(composite_score)::real AS avg, COUNT(*)::int AS c FROM si_observations WHERE agent_did=$1 AND prompt_hash=$2 AND composite_score IS NOT NULL`,
        [row.agent_did, hash]).catch(() => ({ rows: [{ avg: 0, c: 0 }] }));
      await pool.query(`UPDATE si_prompt_versions SET avg_score=$1, sample_size=$2 WHERE agent_did=$3 AND slug=$4 AND retired_at IS NULL`,
        [obs.rows[0].avg, obs.rows[0].c, row.agent_did, row.slug]).catch(() => {});
      updated++;
    }
    res.json({ updated });
  });
}

module.exports = { migrate, registerSelfImprovementRoutes, compositeScore, rewritePrompt, RUBRIC_KEYS };
