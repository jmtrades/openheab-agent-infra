// ============================================================================
// agi_proof_of_personhood.js — Sybil resistance for AGIs. Distinguishes
// "this is a real legitimate AGI with a known operator and verified
// behaviour" from "this is a spam bot pretending to be an AGI".
//
// Issues + verifies portable AGI-personhood attestations signed by trusted
// attesters (labs, regulators, audit firms, OpenHeab itself).
// ============================================================================
const crypto = require('crypto');
const { z } = require('zod');

const ATTESTATION_KINDS = ['lab_operator', 'regulator', 'audit_firm', 'reputation_oracle', 'self_attest'];
const TRUSTED_ATTESTERS_DEFAULT = ['anthropic', 'openai', 'google', 'meta', 'openheab', 'nist'];

async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS agi_personhood_attestations (
      attestation_id    TEXT PRIMARY KEY,
      agent_did         TEXT NOT NULL,
      attester_did      TEXT NOT NULL,
      attester_kind     TEXT NOT NULL,
      attester_name     TEXT,
      attestation_text  TEXT NOT NULL,
      signature_ed25519 TEXT NOT NULL,
      attester_pubkey_pem TEXT,
      issued_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at        TIMESTAMPTZ,
      revoked_at        TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_agi_personhood_attestations_agent
      ON agi_personhood_attestations (agent_did, revoked_at);
    CREATE TABLE IF NOT EXISTS agi_personhood_trusted_attesters (
      attester_did      TEXT PRIMARY KEY,
      name              TEXT NOT NULL,
      kind              TEXT NOT NULL,
      pubkey_pem        TEXT,
      added_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

function newId(p) { return p + '_' + crypto.randomBytes(10).toString('hex'); }
function isAdmin(req) {
  const t = req.headers['x-admin-token'];
  return require('../safe_compare').safeTokenCompare(t, process.env.OPERATOR_ADMIN_TOKEN);
}

const attestSchema = z.object({
  agent_did: z.string(),
  attestation_text: z.string().min(20).max(5000),
  signature_ed25519: z.string(),
  attester_pubkey_pem: z.string(),
  ttl_days: z.number().int().min(1).max(3650).optional()
});

function registerAgiPersonhoodRoutes(app, pool, verifyAgentAuth, auditChain) {
  const express = require('express');

  // Admin: register a trusted attester (typically the labs + regulators)
  app.post('/v1/admin/agi-personhood/attesters', express.json(), async (req, res) => {
    if (!isAdmin(req)) return res.status(401).json({ error: 'admin_auth_required' });
    const { attester_did, name, kind, pubkey_pem } = req.body || {};
    if (!attester_did || !name || !kind) return res.status(400).json({ error: 'invalid' });
    await pool.query(
      `INSERT INTO agi_personhood_trusted_attesters (attester_did, name, kind, pubkey_pem)
       VALUES ($1,$2,$3,$4) ON CONFLICT (attester_did) DO UPDATE
       SET name=$2, kind=$3, pubkey_pem=$4`,
      [attester_did, name, kind, pubkey_pem || null]
    );
    res.status(201).json({ attester_did });
  });

  // Attest: an authorised attester signs an attestation about an AGI
  app.post('/v1/agi-personhood/attestations', express.json(), async (req, res) => {
    const attesterDid = req.headers['x-agent-did'];
    if (!attesterDid) return res.status(401).json({ error: 'attester_did_required' });
    const auth = await verifyAgentAuth(req, attesterDid, { strictSignatureRequired: true });
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const p = attestSchema.safeParse(req.body || {});
    if (!p.success) return res.status(400).json({ error: 'invalid_input', details: p.error.flatten() });

    // Look up attester
    const t = await pool.query(`SELECT name, kind FROM agi_personhood_trusted_attesters WHERE attester_did=$1`, [attesterDid])
      .catch(() => ({ rows: [] }));
    if (!t.rows[0]) return res.status(403).json({ error: 'attester_not_trusted' });

    // Verify the Ed25519 signature
    try {
      const pubKey = crypto.createPublicKey(p.data.attester_pubkey_pem);
      const ok = crypto.verify(null, Buffer.from(p.data.attestation_text), pubKey, Buffer.from(p.data.signature_ed25519, 'hex'));
      if (!ok) return res.status(400).json({ error: 'signature_invalid' });
    } catch (e) { return res.status(400).json({ error: 'signature_verification_failed', message: e.message }); }

    const id = newId('agatt');
    const ttl = p.data.ttl_days || 365;
    const expires = new Date(Date.now() + ttl * 86400000).toISOString();
    await pool.query(
      `INSERT INTO agi_personhood_attestations (attestation_id, agent_did, attester_did, attester_kind,
         attester_name, attestation_text, signature_ed25519, attester_pubkey_pem, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [id, p.data.agent_did, attesterDid, t.rows[0].kind, t.rows[0].name,
       p.data.attestation_text, p.data.signature_ed25519, p.data.attester_pubkey_pem, expires]
    );
    if (auditChain) await auditChain.append({
      event_type: 'agi_personhood.attested', attestation_id: id, agent_did: p.data.agent_did,
      attester_did: attesterDid, attester_kind: t.rows[0].kind, expires_at: expires
    }).catch(() => {});
    res.status(201).json({ attestation_id: id, expires_at: expires });
  });

  // Public verification: is this agent_did a real AGI?
  app.get('/v1/agi-personhood/:did/verify', async (req, res) => {
    const r = await pool.query(`
      SELECT a.attestation_id, a.attester_did, a.attester_kind, a.attester_name, a.issued_at, a.expires_at, t.kind AS attester_kind_canon
      FROM agi_personhood_attestations a
      LEFT JOIN agi_personhood_trusted_attesters t ON t.attester_did = a.attester_did
      WHERE a.agent_did=$1 AND a.revoked_at IS NULL AND (a.expires_at IS NULL OR a.expires_at > NOW())
      ORDER BY a.issued_at DESC LIMIT 20
    `, [req.params.did]).catch(() => ({ rows: [] }));

    // Score: more attesters from more kinds = higher confidence
    const distinctKinds = new Set(r.rows.map(x => x.attester_kind_canon).filter(Boolean));
    const score = Math.min(100, distinctKinds.size * 25 + r.rows.length * 5);
    const verified = score >= 50;

    res.json({
      agent_did: req.params.did,
      verified, score,
      attestations: r.rows,
      attester_kinds_present: Array.from(distinctKinds),
      verification_method: 'Ed25519 signatures over attestation text, signed by trusted attesters'
    });
  });

  app.get('/v1/agi-personhood/trusted-attesters', async (req, res) => {
    const r = await pool.query(`SELECT attester_did, name, kind, added_at FROM agi_personhood_trusted_attesters ORDER BY kind, name`)
      .catch(() => ({ rows: [] }));
    res.json({ attesters: r.rows, default_kinds: ATTESTATION_KINDS, suggested: TRUSTED_ATTESTERS_DEFAULT });
  });

  app.post('/v1/agi-personhood/attestations/:id/revoke', async (req, res) => {
    const attesterDid = req.headers['x-agent-did'];
    if (!attesterDid) return res.status(401).json({ error: 'attester_did_required' });
    const auth = await verifyAgentAuth(req, attesterDid, { strictSignatureRequired: true });
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(`UPDATE agi_personhood_attestations SET revoked_at=NOW() WHERE attestation_id=$1 AND attester_did=$2 RETURNING attestation_id`,
      [req.params.id, attesterDid]).catch(() => ({ rows: [] }));
    if (!r.rows[0]) return res.status(404).json({ error: 'not_found_or_not_attester' });
    if (auditChain) await auditChain.append({ event_type: 'agi_personhood.revoked', attestation_id: r.rows[0].attestation_id, attester_did: attesterDid }).catch(() => {});
    res.json({ revoked: true });
  });
}

module.exports = { migrate, registerAgiPersonhoodRoutes, ATTESTATION_KINDS, TRUSTED_ATTESTERS_DEFAULT };
