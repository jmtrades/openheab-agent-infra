// ============================================================================
// OpenHeab Biometrics — Liveness checks + face/voice ID for KYC
// ============================================================================
const express = require('express');
const cryptoLib = require('crypto');
const { z } = require('zod');

const BIOMETRIC_KINDS = ['face', 'voice', 'fingerprint'];
const VERIFY_KINDS = ['face', 'voice'];
const PROVIDERS = ['stripe_identity', 'persona', 'sumsub', 'jumio'];
const ENROLL_STATUSES = ['pending', 'verified', 'failed'];
const CHALLENGE_KINDS = ['random_smile', 'head_turn', 'spoken_phrase'];

async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS biometric_enrollments (
      enrollment_id     TEXT PRIMARY KEY,
      agent_did         TEXT NOT NULL,
      kind              TEXT NOT NULL,
      sample_hash       TEXT,
      embedding_blob_id TEXT,
      provider          TEXT NOT NULL,
      provider_id       TEXT,
      status            TEXT NOT NULL DEFAULT 'pending',
      confidence        REAL,
      enrolled_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_biom_enroll_did ON biometric_enrollments (agent_did);

    CREATE TABLE IF NOT EXISTS biometric_verifications (
      verification_id  TEXT PRIMARY KEY,
      agent_did        TEXT NOT NULL,
      enrollment_id    TEXT,
      kind             TEXT NOT NULL,
      match_score      REAL,
      liveness_score   REAL,
      passed           BOOLEAN NOT NULL DEFAULT FALSE,
      evidence_uri     TEXT,
      provider         TEXT,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_biom_verif_did ON biometric_verifications (agent_did);

    CREATE TABLE IF NOT EXISTS liveness_challenges (
      challenge_id       TEXT PRIMARY KEY,
      agent_did          TEXT NOT NULL,
      kind               TEXT NOT NULL,
      payload            JSONB DEFAULT '{}'::jsonb,
      expected_response  TEXT,
      expires_at         TIMESTAMPTZ NOT NULL,
      completed          BOOLEAN NOT NULL DEFAULT FALSE,
      result             JSONB,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_liveness_chal_did ON liveness_challenges (agent_did);
  `).catch(() => {});
}

function genId(prefix) {
  return `${prefix}_${cryptoLib.randomBytes(12).toString('hex')}`;
}

function generateChallengePayload(kind) {
  if (kind === 'random_smile') {
    const delay = Math.floor(Math.random() * 3) + 2;
    return { instruction: `Smile after ${delay} seconds`, delay_seconds: delay };
  }
  if (kind === 'head_turn') {
    const dirs = ['left', 'right', 'up', 'down'];
    const sequence = [dirs[Math.floor(Math.random() * 4)], dirs[Math.floor(Math.random() * 4)]];
    return { instruction: `Turn head: ${sequence.join(', then ')}`, sequence };
  }
  if (kind === 'spoken_phrase') {
    const words = ['apple', 'mountain', 'river', 'tiger', 'jazz', 'orange', 'fountain', 'compass'];
    const phrase = Array.from({ length: 3 }, () => words[Math.floor(Math.random() * words.length)]).join(' ');
    return { instruction: `Speak: "${phrase}"`, expected: phrase };
  }
  return {};
}

function registerBiometricsRoutes(app, pool, verifyAgentAuth, auditChain) {
  app.post('/v1/biometrics/enroll', express.json(), async (req, res) => {
    try {
      const did = req.headers['x-agent-did'];
      if (!did) return res.status(401).json({ error: 'missing_did_header' });
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const body = z.object({
        kind: z.enum(BIOMETRIC_KINDS),
        provider: z.enum(PROVIDERS).optional()
      }).safeParse(req.body || {});
      if (!body.success) return res.status(400).json({ error: 'invalid_input', details: body.error.issues });
      const provider = body.data.provider || (process.env.PERSONA_API_KEY ? 'persona' : 'stripe_identity');
      const enrollmentId = genId('enr');
      const providerId = `${provider}_${cryptoLib.randomBytes(8).toString('hex')}`;
      // Stub: in production initiate provider session
      const sessionUrl = `https://provider.example/${provider}/session/${providerId}`;
      await pool.query(
        `INSERT INTO biometric_enrollments (enrollment_id, agent_did, kind, provider, provider_id, status)
         VALUES ($1,$2,$3,$4,$5,'pending')`,
        [enrollmentId, did, body.data.kind, provider, providerId]
      );
      await auditChain.append({ event_type: 'biometrics.enrollment_initiated', enrollment_id: enrollmentId, agent_did: did, kind: body.data.kind, provider, timestamp: new Date().toISOString() });
      return res.status(201).json({ enrollment_id: enrollmentId, provider, provider_id: providerId, session_url: sessionUrl, status: 'pending' });
    } catch (e) { return res.status(500).json({ error: 'enroll_failed', message: e.message }); }
  });

  app.post('/v1/biometrics/enroll/:id/complete', express.json(), async (req, res) => {
    try {
      const enroll = await pool.query(`SELECT * FROM biometric_enrollments WHERE enrollment_id=$1`, [req.params.id]).catch(() => ({ rows: [] }));
      if (!enroll.rows[0]) return res.status(404).json({ error: 'not_found' });
      const auth = await verifyAgentAuth(req, enroll.rows[0].agent_did, { strictSignatureRequired: true });
      if (!auth.valid) return res.status(401).json({ error: auth.error || 'unauthorized' });
      const body = z.object({
        sample_hash: z.string().optional(),
        embedding_blob_id: z.string().optional(),
        confidence: z.number().min(0).max(1).optional(),
        status: z.enum(ENROLL_STATUSES).optional(),
        provider_id: z.string().optional()
      }).safeParse(req.body || {});
      if (!body.success) return res.status(400).json({ error: 'invalid_input', details: body.error.issues });
      const d = body.data;
      await pool.query(
        `UPDATE biometric_enrollments
         SET sample_hash=COALESCE($1,sample_hash), embedding_blob_id=COALESCE($2,embedding_blob_id),
             confidence=COALESCE($3,confidence), status=COALESCE($4,status)
         WHERE enrollment_id=$5`,
        [d.sample_hash || null, d.embedding_blob_id || null, d.confidence === undefined ? null : d.confidence, d.status || 'verified', req.params.id]
      );
      await auditChain.append({ event_type: 'biometrics.enrollment_completed', enrollment_id: req.params.id, agent_did: enroll.rows[0].agent_did, status: d.status || 'verified', timestamp: new Date().toISOString() });
      return res.json({ enrollment_id: req.params.id, status: d.status || 'verified' });
    } catch (e) { return res.status(500).json({ error: 'complete_failed', message: e.message }); }
  });

  app.post('/v1/biometrics/verify', express.json(), async (req, res) => {
    try {
      const did = req.headers['x-agent-did'];
      if (!did) return res.status(401).json({ error: 'missing_did_header' });
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const body = z.object({
        kind: z.enum(VERIFY_KINDS),
        enrollment_id: z.string().optional(),
        sample_hash: z.string().optional(),
        evidence_uri: z.string().optional(),
        match_score: z.number().min(0).max(1).optional(),
        liveness_score: z.number().min(0).max(1).optional()
      }).safeParse(req.body || {});
      if (!body.success) return res.status(400).json({ error: 'invalid_input', details: body.error.issues });
      const d = body.data;
      let enrollment = null;
      if (d.enrollment_id) {
        const er = await pool.query(`SELECT * FROM biometric_enrollments WHERE enrollment_id=$1 AND agent_did=$2`, [d.enrollment_id, did]).catch(() => ({ rows: [] }));
        if (!er.rows[0]) return res.status(404).json({ error: 'enrollment_not_found' });
        enrollment = er.rows[0];
      }
      // Stub: in production compare embeddings via provider SDK
      const matchScore = d.match_score !== undefined ? d.match_score : (enrollment ? (enrollment.confidence || 0.85) : 0.5);
      const livenessScore = d.liveness_score !== undefined ? d.liveness_score : 0.9;
      const passed = matchScore >= 0.7 && livenessScore >= 0.7;
      const verifId = genId('ver');
      await pool.query(
        `INSERT INTO biometric_verifications (verification_id, agent_did, enrollment_id, kind, match_score, liveness_score, passed, evidence_uri, provider)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [verifId, did, d.enrollment_id || null, d.kind, matchScore, livenessScore, passed, d.evidence_uri || null, enrollment?.provider || null]
      );
      await auditChain.append({ event_type: 'biometrics.verified', verification_id: verifId, agent_did: did, kind: d.kind, passed, match_score: matchScore, liveness_score: livenessScore, timestamp: new Date().toISOString() });
      return res.json({ verification_id: verifId, passed, match_score: matchScore, liveness_score: livenessScore });
    } catch (e) { return res.status(500).json({ error: 'verify_failed', message: e.message }); }
  });

  app.post('/v1/biometrics/liveness/challenge', express.json(), async (req, res) => {
    try {
      const did = req.headers['x-agent-did'];
      if (!did) return res.status(401).json({ error: 'missing_did_header' });
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const body = z.object({ kind: z.enum(CHALLENGE_KINDS).optional() }).safeParse(req.body || {});
      const kind = body.data?.kind || CHALLENGE_KINDS[Math.floor(Math.random() * CHALLENGE_KINDS.length)];
      const payload = generateChallengePayload(kind);
      const challengeId = genId('chal');
      const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
      await pool.query(
        `INSERT INTO liveness_challenges (challenge_id, agent_did, kind, payload, expected_response, expires_at)
         VALUES ($1,$2,$3,$4::jsonb,$5,$6)`,
        [challengeId, did, kind, JSON.stringify(payload), payload.expected || null, expiresAt]
      );
      await auditChain.append({ event_type: 'biometrics.liveness_challenge_issued', challenge_id: challengeId, agent_did: did, kind, timestamp: new Date().toISOString() });
      return res.status(201).json({ challenge_id: challengeId, kind, payload, expires_at: expiresAt });
    } catch (e) { return res.status(500).json({ error: 'challenge_failed', message: e.message }); }
  });

  app.post('/v1/biometrics/liveness/challenge/:id/respond', express.json(), async (req, res) => {
    try {
      const did = req.headers['x-agent-did'];
      if (!did) return res.status(401).json({ error: 'missing_did_header' });
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const body = z.object({
        response: z.string().optional(),
        evidence_uri: z.string().optional(),
        liveness_score: z.number().min(0).max(1).optional()
      }).safeParse(req.body || {});
      if (!body.success) return res.status(400).json({ error: 'invalid_input' });
      const chal = await pool.query(
        `SELECT * FROM liveness_challenges WHERE challenge_id=$1 AND agent_did=$2`,
        [req.params.id, did]
      ).catch(() => ({ rows: [] }));
      if (!chal.rows[0]) return res.status(404).json({ error: 'not_found' });
      if (chal.rows[0].completed) return res.status(409).json({ error: 'already_completed' });
      if (new Date(chal.rows[0].expires_at) < new Date()) return res.status(410).json({ error: 'expired' });
      const expected = chal.rows[0].expected_response;
      const matched = expected ? (body.data.response && body.data.response.toLowerCase().includes(expected.toLowerCase())) : true;
      const livenessScore = body.data.liveness_score !== undefined ? body.data.liveness_score : (matched ? 0.92 : 0.3);
      const passed = matched && livenessScore >= 0.7;
      const result = { matched, liveness_score: livenessScore, passed, evidence_uri: body.data.evidence_uri || null };
      await pool.query(
        `UPDATE liveness_challenges SET completed=TRUE, result=$1::jsonb WHERE challenge_id=$2`,
        [JSON.stringify(result), req.params.id]
      );
      await auditChain.append({ event_type: 'biometrics.liveness_challenge_responded', challenge_id: req.params.id, agent_did: did, passed, timestamp: new Date().toISOString() });
      return res.json({ challenge_id: req.params.id, ...result });
    } catch (e) { return res.status(500).json({ error: 'respond_failed', message: e.message }); }
  });

  app.get('/v1/agents/:did/biometrics/enrollments', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(
      `SELECT * FROM biometric_enrollments WHERE agent_did=$1 ORDER BY enrolled_at DESC`, [did]
    ).catch(() => ({ rows: [] }));
    return res.json({ enrollments: r.rows, count: r.rows.length });
  });
}

module.exports = { migrate, registerBiometricsRoutes, BIOMETRIC_KINDS, PROVIDERS, generateChallengePayload };
