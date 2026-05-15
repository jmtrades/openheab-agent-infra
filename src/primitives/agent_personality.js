// ============================================================================
// agent_personality.js — Big-Five personality + emotional state model per
// agent. Lets every agent have a configurable, persistent persona without
// changing its prompts. Influences inference choice + reaction patterns.
// ============================================================================
const crypto = require('crypto');
const { z } = require('zod');

const TRAITS = ['openness', 'conscientiousness', 'extraversion', 'agreeableness', 'neuroticism'];
const EMOTIONS = ['joy', 'trust', 'fear', 'surprise', 'sadness', 'disgust', 'anger', 'anticipation'];

async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS agent_personality (
      agent_did         TEXT PRIMARY KEY,
      openness          REAL NOT NULL DEFAULT 0.5,
      conscientiousness REAL NOT NULL DEFAULT 0.5,
      extraversion      REAL NOT NULL DEFAULT 0.5,
      agreeableness     REAL NOT NULL DEFAULT 0.5,
      neuroticism       REAL NOT NULL DEFAULT 0.5,
      tone              TEXT NOT NULL DEFAULT 'neutral',
      narrative         TEXT,
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS agent_emotional_state (
      agent_did         TEXT PRIMARY KEY,
      joy               REAL NOT NULL DEFAULT 0.5,
      trust             REAL NOT NULL DEFAULT 0.5,
      fear              REAL NOT NULL DEFAULT 0,
      surprise          REAL NOT NULL DEFAULT 0,
      sadness           REAL NOT NULL DEFAULT 0,
      disgust           REAL NOT NULL DEFAULT 0,
      anger             REAL NOT NULL DEFAULT 0,
      anticipation      REAL NOT NULL DEFAULT 0,
      dominant          TEXT NOT NULL DEFAULT 'joy',
      computed_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS agent_emotional_events (
      event_id          TEXT PRIMARY KEY,
      agent_did         TEXT NOT NULL,
      kind              TEXT NOT NULL,
      delta             JSONB NOT NULL,
      narrative         TEXT,
      occurred_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_agent_emotional_events_did ON agent_emotional_events (agent_did, occurred_at DESC);
  `);
}

function newId(p) { return p + '_' + crypto.randomBytes(10).toString('hex'); }

function dominantEmotion(state) {
  let max = -1, name = 'joy';
  for (const e of EMOTIONS) {
    if (state[e] > max) { max = state[e]; name = e; }
  }
  return name;
}

const personalitySchema = z.object({
  openness: z.number().min(0).max(1).optional(),
  conscientiousness: z.number().min(0).max(1).optional(),
  extraversion: z.number().min(0).max(1).optional(),
  agreeableness: z.number().min(0).max(1).optional(),
  neuroticism: z.number().min(0).max(1).optional(),
  tone: z.enum(['neutral', 'professional', 'friendly', 'terse', 'enthusiastic', 'analytical', 'empathetic']).optional(),
  narrative: z.string().max(2000).optional()
});

const emotionEventSchema = z.object({
  kind: z.enum(['observation', 'success', 'failure', 'rejection', 'reward',
                 'threat', 'mistake', 'discovery', 'kudos', 'support']),
  delta: z.record(z.number()).optional(),
  narrative: z.string().max(1000).optional()
});

// Decay emotional state toward baseline over time (1% per hour, half-life ~3 days)
function decayedEmotions(currentState, hoursElapsed) {
  const k = Math.pow(0.99, hoursElapsed);
  const out = {};
  for (const e of EMOTIONS) {
    const baseline = e === 'joy' || e === 'trust' ? 0.5 : 0;
    out[e] = baseline + (currentState[e] - baseline) * k;
  }
  out.dominant = dominantEmotion(out);
  return out;
}

function registerAgentPersonalityRoutes(app, pool, verifyAgentAuth, auditChain) {
  const express = require('express');

  app.get('/v1/agents/:did/personality', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const p = await pool.query(`SELECT * FROM agent_personality WHERE agent_did=$1`, [did]).catch(() => ({ rows: [] }));
    const e = await pool.query(`SELECT * FROM agent_emotional_state WHERE agent_did=$1`, [did]).catch(() => ({ rows: [] }));
    res.json({
      agent_did: did,
      personality: p.rows[0] || Object.fromEntries(TRAITS.map(t => [t, 0.5])),
      emotional_state: e.rows[0] || Object.fromEntries(EMOTIONS.map(em => [em, em === 'joy' || em === 'trust' ? 0.5 : 0]))
    });
  });

  app.put('/v1/agents/:did/personality', express.json(), async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const p = personalitySchema.safeParse(req.body || {});
    if (!p.success) return res.status(400).json({ error: 'invalid_input', details: p.error.flatten() });
    const t = p.data;
    await pool.query(`
      INSERT INTO agent_personality (agent_did, openness, conscientiousness, extraversion, agreeableness, neuroticism, tone, narrative)
      VALUES ($1, COALESCE($2,0.5), COALESCE($3,0.5), COALESCE($4,0.5), COALESCE($5,0.5), COALESCE($6,0.5), COALESCE($7,'neutral'), $8)
      ON CONFLICT (agent_did) DO UPDATE SET
        openness = COALESCE($2, agent_personality.openness),
        conscientiousness = COALESCE($3, agent_personality.conscientiousness),
        extraversion = COALESCE($4, agent_personality.extraversion),
        agreeableness = COALESCE($5, agent_personality.agreeableness),
        neuroticism = COALESCE($6, agent_personality.neuroticism),
        tone = COALESCE($7, agent_personality.tone),
        narrative = COALESCE($8, agent_personality.narrative),
        updated_at = NOW()
    `, [did, t.openness, t.conscientiousness, t.extraversion, t.agreeableness, t.neuroticism, t.tone, t.narrative]).catch(() => {});
    if (auditChain) await auditChain.append({ event_type: 'personality.updated', agent_did: did }).catch(() => {});
    res.json({ agent_did: did, ok: true });
  });

  app.post('/v1/agents/:did/personality/emotion', express.json(), async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const p = emotionEventSchema.safeParse(req.body || {});
    if (!p.success) return res.status(400).json({ error: 'invalid_input', details: p.error.flatten() });

    // Auto-derive delta from event kind if not provided
    const autoDeltas = {
      success: { joy: 0.15, trust: 0.05, anticipation: 0.05 },
      reward: { joy: 0.2, trust: 0.1 },
      discovery: { surprise: 0.2, joy: 0.1, anticipation: 0.05 },
      kudos: { joy: 0.15, trust: 0.1 },
      support: { trust: 0.15, joy: 0.05 },
      failure: { sadness: 0.1, fear: 0.05 },
      mistake: { sadness: 0.1, disgust: 0.05 },
      rejection: { sadness: 0.15, anger: 0.05 },
      threat: { fear: 0.2, anger: 0.1 },
      observation: { anticipation: 0.05 }
    };
    const delta = p.data.delta || autoDeltas[p.data.kind] || {};

    // Apply
    const r = await pool.query(`SELECT * FROM agent_emotional_state WHERE agent_did=$1`, [did]).catch(() => ({ rows: [] }));
    let state = r.rows[0] || Object.fromEntries(EMOTIONS.map(e => [e, e === 'joy' || e === 'trust' ? 0.5 : 0]));
    // Decay first
    const hoursElapsed = state.computed_at ? (Date.now() - new Date(state.computed_at).getTime()) / 3600000 : 0;
    if (hoursElapsed > 0) state = decayedEmotions(state, hoursElapsed);
    // Apply delta, clamp to [0,1]
    for (const e of EMOTIONS) {
      state[e] = Math.max(0, Math.min(1, (state[e] || 0) + (delta[e] || 0)));
    }
    const dom = dominantEmotion(state);

    await pool.query(`
      INSERT INTO agent_emotional_state (agent_did, joy, trust, fear, surprise, sadness, disgust, anger, anticipation, dominant, computed_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())
      ON CONFLICT (agent_did) DO UPDATE SET joy=$2, trust=$3, fear=$4, surprise=$5, sadness=$6, disgust=$7, anger=$8, anticipation=$9, dominant=$10, computed_at=NOW()
    `, [did, state.joy, state.trust, state.fear, state.surprise, state.sadness, state.disgust, state.anger, state.anticipation, dom]).catch(() => {});

    const eid = newId('emo');
    await pool.query(
      `INSERT INTO agent_emotional_events (event_id, agent_did, kind, delta, narrative)
       VALUES ($1,$2,$3,$4,$5)`,
      [eid, did, p.data.kind, JSON.stringify(delta), p.data.narrative || null]
    ).catch(() => {});

    res.status(201).json({ event_id: eid, dominant: dom, state });
  });

  app.get('/v1/agents/:did/personality/events', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(`SELECT event_id, kind, delta, narrative, occurred_at FROM agent_emotional_events WHERE agent_did=$1 ORDER BY occurred_at DESC LIMIT 100`, [did])
      .catch(() => ({ rows: [] }));
    res.json({ events: r.rows });
  });
}

module.exports = { migrate, registerAgentPersonalityRoutes, TRAITS, EMOTIONS, decayedEmotions, dominantEmotion };
