// ============================================================================
// OpenHeab Beliefs — Belief state + Bayesian revision
// Propositions held by an agent, their confidence, and how evidence updates them.
// ============================================================================
const express = require('express');
const cryptoLib = require('crypto');
const { z } = require('zod');

const REV_METHODS = ['bayes', 'heuristic', 'explicit'];
const CONTRADICTION_RESOLUTIONS = ['kept_a', 'kept_b', 'merged', 'abandoned_both'];

// ----------------------------------------------------------------------------
// Migration
// ----------------------------------------------------------------------------
async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS beliefs (
      belief_id        TEXT PRIMARY KEY,
      agent_did        TEXT NOT NULL,
      proposition      TEXT NOT NULL,
      confidence       REAL NOT NULL DEFAULT 0.5,
      evidence_count   INTEGER NOT NULL DEFAULT 0,
      sources          JSONB NOT NULL DEFAULT '[]'::jsonb,
      last_revised_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_beliefs_agent ON beliefs (agent_did, confidence DESC);
    CREATE INDEX IF NOT EXISTS idx_beliefs_prop ON beliefs (agent_did, proposition);

    CREATE TABLE IF NOT EXISTS belief_revisions (
      revision_id          TEXT PRIMARY KEY,
      belief_id            TEXT NOT NULL,
      agent_did            TEXT NOT NULL,
      prior_confidence     REAL NOT NULL,
      posterior_confidence REAL NOT NULL,
      evidence             JSONB,
      method               TEXT NOT NULL DEFAULT 'bayes',
      reasoning            TEXT,
      created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_belief_revisions_belief ON belief_revisions (belief_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS belief_contradictions (
      contradiction_id  TEXT PRIMARY KEY,
      agent_did         TEXT NOT NULL,
      belief_a_id       TEXT NOT NULL,
      belief_b_id       TEXT NOT NULL,
      resolution        TEXT,
      detected_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      resolved_at       TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_belief_contradictions_agent ON belief_contradictions (agent_did, detected_at DESC);
  `);
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------
function genId(prefix) {
  return prefix + '_' + cryptoLib.randomBytes(12).toString('hex');
}

function clamp01(x) { return Math.max(0.0001, Math.min(0.9999, x)); }

// Jaccard token similarity — fast, no embeddings needed
function tokenSimilarity(a, b) {
  const toks = s => new Set(String(s).toLowerCase().match(/[a-z0-9]+/g) || []);
  const A = toks(a); const B = toks(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  const union = A.size + B.size - inter;
  return inter / union;
}

// Bayes update: P(H|E) = P(E|H)*P(H) / (P(E|H)*P(H) + P(E|~H)*P(~H))
function bayesPosterior(prior, likelihoodH, likelihoodNotH) {
  const p = clamp01(prior);
  const lh = clamp01(likelihoodH);
  const lnh = clamp01(likelihoodNotH);
  const num = lh * p;
  const den = num + lnh * (1 - p);
  return clamp01(num / den);
}

// Heuristic contradiction detector: two beliefs contradict if one
// reads as a clear negation of the other, or shares high token-similarity
// but one starts with "not"/"no".
function detectContradiction(a, b) {
  const sa = String(a).toLowerCase();
  const sb = String(b).toLowerCase();
  const sim = tokenSimilarity(sa, sb);
  if (sim < 0.4) return false;
  const negPrefixA = /^(not |no |never |it is not |isn'?t |aren'?t )/.test(sa);
  const negPrefixB = /^(not |no |never |it is not |isn'?t |aren'?t )/.test(sb);
  if (negPrefixA !== negPrefixB) return true;
  // Look for "X is Y" vs "X is not Y" within same proposition
  const stripped = (s) => s.replace(/\b(not|never)\b/g, '').replace(/\s+/g, ' ').trim();
  const ca = stripped(sa);
  const cb = stripped(sb);
  if (tokenSimilarity(ca, cb) > 0.85 && /\bnot|\bnever/.test(sa) !== /\bnot|\bnever/.test(sb)) {
    return true;
  }
  return false;
}

// ----------------------------------------------------------------------------
// Schemas
// ----------------------------------------------------------------------------
const AssertSchema = z.object({
  proposition: z.string().min(1).max(2000),
  confidence:  z.number().min(0).max(1).optional(),
  sources:     z.array(z.object({
    source_url:    z.string().optional(),
    contribution:  z.number().min(0).max(1).optional(),
    signed_by_did: z.string().optional(),
    note:          z.string().optional()
  })).optional(),
  similarity_threshold: z.number().min(0).max(1).optional()
});

const ReviseSchema = z.object({
  evidence: z.record(z.any()),
  likelihood_given_h:     z.number().min(0).max(1).optional(),
  likelihood_given_not_h: z.number().min(0).max(1).optional(),
  method:    z.enum(REV_METHODS).optional(),
  posterior: z.number().min(0).max(1).optional(), // explicit override
  reasoning: z.string().max(2000).optional()
});

const CiteSchema = z.object({
  source_url:    z.string().optional(),
  contribution:  z.number().min(0).max(1).optional(),
  signed_by_did: z.string().optional(),
  note:          z.string().max(2000).optional()
});

const ResolveContradictionSchema = z.object({
  resolution: z.enum(CONTRADICTION_RESOLUTIONS)
});

// ----------------------------------------------------------------------------
// Routes
// ----------------------------------------------------------------------------
function registerBeliefsRoutes(app, pool, verifyAgentAuth, auditChain) {
  // POST /v1/agents/:did/beliefs — assert / merge
  app.post('/v1/agents/:did/beliefs', express.json(), async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const parse = AssertSchema.safeParse(req.body || {});
    if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
    const d = parse.data;
    const threshold = d.similarity_threshold ?? 0.7;
    const initialConf = d.confidence ?? 0.6;

    // Look for nearby existing belief (token similarity)
    const existing = await pool.query(
      `SELECT belief_id, proposition, confidence, evidence_count, sources
       FROM beliefs WHERE agent_did = $1 ORDER BY last_revised_at DESC LIMIT 200`,
      [did]
    ).catch(() => ({ rows: [] }));

    let merge = null;
    for (const b of existing.rows) {
      if (tokenSimilarity(b.proposition, d.proposition) >= threshold) { merge = b; break; }
    }

    if (merge) {
      const oldSources = Array.isArray(merge.sources)
        ? merge.sources
        : (typeof merge.sources === 'string' ? JSON.parse(merge.sources) : []);
      const newSources = [...oldSources, ...(d.sources || [])];
      const newCount = merge.evidence_count + (d.sources?.length || 1);
      // Weighted average of confidence
      const newConf = clamp01(
        (merge.confidence * merge.evidence_count + initialConf) / Math.max(newCount, 1)
      );
      await pool.query(`
        UPDATE beliefs SET sources = $2::jsonb,
                            evidence_count = $3,
                            confidence = $4,
                            last_revised_at = NOW()
        WHERE belief_id = $1
      `, [merge.belief_id, JSON.stringify(newSources), newCount, newConf]);
      await auditChain.append({
        event_type: 'belief.merged',
        belief_id: merge.belief_id, agent_did: did,
        prior_confidence: merge.confidence, posterior_confidence: newConf,
        timestamp: new Date().toISOString()
      });
      return res.json({
        belief_id: merge.belief_id, merged: true,
        proposition: merge.proposition, confidence: newConf,
        evidence_count: newCount
      });
    }

    const id = genId('blf');
    await pool.query(`
      INSERT INTO beliefs (belief_id, agent_did, proposition, confidence, evidence_count, sources)
      VALUES ($1, $2, $3, $4, $5, $6::jsonb)
    `, [id, did, d.proposition, initialConf,
        d.sources?.length || 0, JSON.stringify(d.sources || [])]);

    await auditChain.append({
      event_type: 'belief.asserted',
      belief_id: id, agent_did: did, confidence: initialConf,
      timestamp: new Date().toISOString()
    });
    return res.status(201).json({
      belief_id: id, merged: false, proposition: d.proposition,
      confidence: initialConf
    });
  });

  // GET /v1/agents/:did/beliefs
  app.get('/v1/agents/:did/beliefs', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const minConf = parseFloat(req.query.min_confidence || '0');
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    const r = await pool.query(`
      SELECT belief_id, proposition, confidence, evidence_count,
             sources, last_revised_at, created_at
      FROM beliefs WHERE agent_did = $1 AND confidence >= $2
      ORDER BY confidence DESC LIMIT $3
    `, [did, minConf, limit]).catch(() => ({ rows: [] }));
    return res.json({ agent_did: did, beliefs: r.rows, count: r.rows.length });
  });

  // PUT /v1/agents/:did/beliefs/:id/revise
  app.put('/v1/agents/:did/beliefs/:id/revise', express.json(), async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const parse = ReviseSchema.safeParse(req.body || {});
    if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
    const d = parse.data;

    const b = await pool.query(
      `SELECT confidence FROM beliefs WHERE belief_id=$1 AND agent_did=$2`,
      [req.params.id, did]
    ).catch(() => ({ rows: [] }));
    if (!b.rows[0]) return res.status(404).json({ error: 'belief_not_found' });

    const prior = parseFloat(b.rows[0].confidence);
    const method = d.method || (d.posterior !== undefined ? 'explicit' : 'bayes');
    let posterior = prior;
    if (method === 'explicit' && d.posterior !== undefined) {
      posterior = clamp01(d.posterior);
    } else if (method === 'heuristic') {
      // average evidence contribution toward 1 or 0
      const support = d.likelihood_given_h ?? 0.7;
      posterior = clamp01(prior * 0.6 + support * 0.4);
    } else {
      // bayes
      const lh = d.likelihood_given_h ?? 0.8;
      const lnh = d.likelihood_given_not_h ?? 0.3;
      posterior = bayesPosterior(prior, lh, lnh);
    }

    await pool.query(`
      UPDATE beliefs SET confidence = $2,
                          evidence_count = evidence_count + 1,
                          last_revised_at = NOW()
      WHERE belief_id = $1
    `, [req.params.id, posterior]);

    const revId = genId('brv');
    await pool.query(`
      INSERT INTO belief_revisions
      (revision_id, belief_id, agent_did, prior_confidence,
       posterior_confidence, evidence, method, reasoning)
      VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
    `, [revId, req.params.id, did, prior, posterior,
        JSON.stringify(d.evidence || {}), method, d.reasoning || null]);

    await auditChain.append({
      event_type: 'belief.revised',
      belief_id: req.params.id, revision_id: revId, agent_did: did,
      method, prior_confidence: prior, posterior_confidence: posterior,
      timestamp: new Date().toISOString()
    });

    return res.json({
      belief_id: req.params.id, revision_id: revId,
      prior_confidence: prior, posterior_confidence: posterior, method
    });
  });

  // POST /v1/agents/:did/beliefs/check-contradictions
  app.post('/v1/agents/:did/beliefs/check-contradictions', express.json(), async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(
      `SELECT belief_id, proposition FROM beliefs WHERE agent_did = $1 LIMIT 500`,
      [did]
    ).catch(() => ({ rows: [] }));

    const detected = [];
    for (let i = 0; i < r.rows.length; i++) {
      for (let j = i + 1; j < r.rows.length; j++) {
        if (detectContradiction(r.rows[i].proposition, r.rows[j].proposition)) {
          // Avoid duplicate registrations
          const dup = await pool.query(`
            SELECT contradiction_id FROM belief_contradictions
            WHERE agent_did=$1
              AND ((belief_a_id=$2 AND belief_b_id=$3) OR (belief_a_id=$3 AND belief_b_id=$2))
              AND resolved_at IS NULL
            LIMIT 1
          `, [did, r.rows[i].belief_id, r.rows[j].belief_id]).catch(() => ({ rows: [] }));
          if (dup.rows[0]) continue;
          const cid = genId('ctr');
          await pool.query(`
            INSERT INTO belief_contradictions
            (contradiction_id, agent_did, belief_a_id, belief_b_id)
            VALUES ($1, $2, $3, $4)
          `, [cid, did, r.rows[i].belief_id, r.rows[j].belief_id]).catch(() => {});
          detected.push({ contradiction_id: cid, belief_a_id: r.rows[i].belief_id, belief_b_id: r.rows[j].belief_id });
        }
      }
    }

    if (detected.length) {
      await auditChain.append({
        event_type: 'belief.contradictions_detected',
        agent_did: did, count: detected.length,
        timestamp: new Date().toISOString()
      });
    }
    return res.json({ agent_did: did, contradictions: detected, count: detected.length });
  });

  // POST /v1/agents/:did/beliefs/contradictions/:cid/resolve
  app.post('/v1/agents/:did/beliefs/contradictions/:cid/resolve', express.json(), async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const parse = ResolveContradictionSchema.safeParse(req.body || {});
    if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });

    const c = await pool.query(
      `SELECT belief_a_id, belief_b_id FROM belief_contradictions WHERE contradiction_id=$1 AND agent_did=$2`,
      [req.params.cid, did]
    ).catch(() => ({ rows: [] }));
    if (!c.rows[0]) return res.status(404).json({ error: 'contradiction_not_found' });

    await pool.query(`
      UPDATE belief_contradictions SET resolution=$2, resolved_at=NOW()
      WHERE contradiction_id=$1
    `, [req.params.cid, parse.data.resolution]);

    // Apply effect to beliefs
    if (parse.data.resolution === 'kept_a') {
      await pool.query(`UPDATE beliefs SET confidence=0.05, last_revised_at=NOW() WHERE belief_id=$1`,
        [c.rows[0].belief_b_id]).catch(() => {});
    } else if (parse.data.resolution === 'kept_b') {
      await pool.query(`UPDATE beliefs SET confidence=0.05, last_revised_at=NOW() WHERE belief_id=$1`,
        [c.rows[0].belief_a_id]).catch(() => {});
    } else if (parse.data.resolution === 'abandoned_both') {
      await pool.query(`UPDATE beliefs SET confidence=0.05, last_revised_at=NOW() WHERE belief_id IN ($1,$2)`,
        [c.rows[0].belief_a_id, c.rows[0].belief_b_id]).catch(() => {});
    }

    await auditChain.append({
      event_type: 'belief.contradiction_resolved',
      contradiction_id: req.params.cid, resolution: parse.data.resolution,
      agent_did: did, timestamp: new Date().toISOString()
    });
    return res.json({ contradiction_id: req.params.cid, resolution: parse.data.resolution });
  });

  // POST /v1/agents/:did/beliefs/:id/cite
  app.post('/v1/agents/:did/beliefs/:id/cite', express.json(), async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const parse = CiteSchema.safeParse(req.body || {});
    if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });

    const b = await pool.query(
      `SELECT sources, evidence_count, confidence FROM beliefs WHERE belief_id=$1 AND agent_did=$2`,
      [req.params.id, did]
    ).catch(() => ({ rows: [] }));
    if (!b.rows[0]) return res.status(404).json({ error: 'belief_not_found' });

    const existing = Array.isArray(b.rows[0].sources)
      ? b.rows[0].sources
      : (typeof b.rows[0].sources === 'string' ? JSON.parse(b.rows[0].sources) : []);
    existing.push({
      source_url:    parse.data.source_url || null,
      contribution:  parse.data.contribution ?? 0.05,
      signed_by_did: parse.data.signed_by_did || null,
      note:          parse.data.note || null,
      added_at:      new Date().toISOString()
    });

    // Slight bayes-style nudge
    const newConf = clamp01(b.rows[0].confidence + (parse.data.contribution ?? 0.05) * (1 - b.rows[0].confidence));
    await pool.query(`
      UPDATE beliefs SET sources=$2::jsonb,
                          evidence_count=evidence_count+1,
                          confidence=$3,
                          last_revised_at=NOW()
      WHERE belief_id=$1
    `, [req.params.id, JSON.stringify(existing), newConf]);

    await auditChain.append({
      event_type: 'belief.cited',
      belief_id: req.params.id, agent_did: did,
      new_confidence: newConf, timestamp: new Date().toISOString()
    });
    return res.json({
      belief_id: req.params.id, evidence_count: (b.rows[0].evidence_count || 0) + 1,
      confidence: newConf
    });
  });
}

module.exports = {
  migrate,
  registerBeliefsRoutes,
  bayesPosterior,
  detectContradiction,
  tokenSimilarity,
  REV_METHODS,
  CONTRADICTION_RESOLUTIONS
};
