// ============================================================================
// OpenHeab Notary — Digital notarization + attestations
// Tables: notarizations, attestations, notary_services
// Optional: anchor document_hash via bank_chain.broadcastTransaction
// ============================================================================
const express = require('express');
const cryptoLib = require('crypto');
const { z } = require('zod');

const NOTARY_KINDS = ['contract', 'agreement', 'oath', 'incorporation', 'witness'];

// ----------------------------------------------------------------------------
// Migration
// ----------------------------------------------------------------------------
async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS notary_services (
      notary_did    TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      qualifications JSONB,
      jurisdictions TEXT[] NOT NULL DEFAULT '{}',
      fee_usdc      NUMERIC(20,6) NOT NULL DEFAULT 0,
      active        BOOLEAN NOT NULL DEFAULT TRUE,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_notary_services_active
      ON notary_services (active);

    CREATE TABLE IF NOT EXISTS notarizations (
      notarization_id   TEXT PRIMARY KEY,
      notary_did        TEXT NOT NULL,
      subject_did       TEXT NOT NULL,
      document_hash     TEXT NOT NULL,
      document_uri      TEXT,
      kind              TEXT NOT NULL,
      signers           JSONB NOT NULL,
      witness_count     INTEGER NOT NULL DEFAULT 0,
      notary_signature  TEXT,
      blockchain_tx     TEXT,
      public_record_uri TEXT,
      audit_chain_entry TEXT,
      notarized_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at        TIMESTAMPTZ,
      revoked_at        TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_notarizations_subject
      ON notarizations (subject_did, notarized_at DESC);
    CREATE INDEX IF NOT EXISTS idx_notarizations_notary
      ON notarizations (notary_did, notarized_at DESC);
    CREATE INDEX IF NOT EXISTS idx_notarizations_hash
      ON notarizations (document_hash);

    CREATE TABLE IF NOT EXISTS attestations (
      attestation_id   TEXT PRIMARY KEY,
      attestor_did     TEXT NOT NULL,
      subject_did      TEXT NOT NULL,
      claim            TEXT NOT NULL,
      evidence_uri     TEXT,
      valid_from       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      valid_until      TIMESTAMPTZ,
      signature        TEXT,
      audit_chain_entry TEXT,
      revoked_at       TIMESTAMPTZ,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_attestations_subject
      ON attestations (subject_did, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_attestations_attestor
      ON attestations (attestor_did, created_at DESC);
  `);
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------
function genId(prefix) {
  return prefix + '_' + cryptoLib.randomBytes(12).toString('hex');
}

function isHex64(s) {
  return typeof s === 'string' && /^[0-9a-fA-F]{64}$/.test(s);
}

// Verify Ed25519 signature over document_hash by signer's public key
function verifySignerSignature(documentHash, signature, publicKeyPem) {
  if (!documentHash || !signature || !publicKeyPem) return false;
  try {
    const pubKey = cryptoLib.createPublicKey(publicKeyPem);
    return cryptoLib.verify(null, Buffer.from(documentHash, 'hex'),
      pubKey, Buffer.from(signature, 'hex'));
  } catch { return false; }
}

async function getIdentityPubKey(pool, did) {
  const r = await pool.query(`
    SELECT public_key FROM identity_keys WHERE agent_did = $1 AND status = 'active'
    UNION ALL
    SELECT public_key FROM identities WHERE did = $1 LIMIT 1
  `, [did]).catch(() => ({ rows: [] }));
  return r.rows[0]?.public_key || null;
}

// Optionally anchor the document_hash on-chain via bank_chain
async function anchorOnChain(documentHash) {
  if (process.env.NOTARY_DISABLE_CHAIN === 'true') return null;
  try {
    const bankChain = require('./bank_chain');
    if (typeof bankChain.broadcastTransaction === 'function') {
      const r = await bankChain.broadcastTransaction({
        kind: 'op_return',
        data: `OPENHEAB_NOTARY:${documentHash}`
      }).catch(() => null);
      return r?.tx_id || r?.signature || null;
    }
  } catch { /* primitive not available */ }
  return null;
}

// ----------------------------------------------------------------------------
// Routes
// ----------------------------------------------------------------------------
function registerNotaryRoutes(app, pool, verifyAgentAuth, auditChain) {
  // POST /v1/notary/register — agent becomes notary
  const RegisterSchema = z.object({
    name:           z.string().min(1).max(128),
    qualifications: z.any().optional(),
    jurisdictions:  z.array(z.string().max(64)).min(1).max(100),
    fee_usdc:       z.number().min(0).optional()
  });
  app.post('/v1/notary/register', express.json(), async (req, res) => {
    try {
      const did = req.headers['x-agent-did'];
      if (!did) return res.status(401).json({ error: 'missing_agent_did' });
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const parse = RegisterSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;

      await pool.query(`
        INSERT INTO notary_services (notary_did, name, qualifications, jurisdictions, fee_usdc, active)
        VALUES ($1,$2,$3::jsonb,$4,$5,TRUE)
        ON CONFLICT (notary_did) DO UPDATE
        SET name = EXCLUDED.name,
            qualifications = EXCLUDED.qualifications,
            jurisdictions = EXCLUDED.jurisdictions,
            fee_usdc = EXCLUDED.fee_usdc,
            active = TRUE
      `, [did, d.name, d.qualifications ? JSON.stringify(d.qualifications) : null,
          d.jurisdictions, d.fee_usdc || 0]);

      const entry = await auditChain.append({
        event_type: 'notary.registered',
        notary_did: did, name: d.name, jurisdictions: d.jurisdictions,
        timestamp: new Date().toISOString()
      });

      return res.status(201).json({
        notary_did: did, name: d.name,
        jurisdictions: d.jurisdictions, fee_usdc: d.fee_usdc || 0,
        audit_chain_entry: entry.hash
      });
    } catch (e) {
      console.error('[notary.register]', e);
      return res.status(500).json({ error: 'register_failed', message: e.message });
    }
  });

  // GET /v1/notary — list notaries by jurisdiction
  app.get('/v1/notary', async (req, res) => {
    try {
      const jur = req.query.jurisdiction;
      const limit = Math.min(parseInt(req.query.limit) || 50, 200);
      const params = [limit];
      let where = `active = TRUE`;
      if (jur) {
        params.unshift(jur);
        where = `active = TRUE AND $1 = ANY(jurisdictions)`;
      }
      const r = await pool.query(`
        SELECT notary_did, name, qualifications, jurisdictions, fee_usdc, created_at
        FROM notary_services WHERE ${where}
        ORDER BY created_at DESC LIMIT $${params.length}
      `, params).catch(() => ({ rows: [] }));
      return res.json({ notaries: r.rows, count: r.rows.length });
    } catch (e) {
      return res.status(500).json({ error: 'list_failed', message: e.message });
    }
  });

  // POST /v1/notary/:notary_did/notarize — submit document for notarization
  const NotarizeSchema = z.object({
    subject_did:   z.string().min(1).max(256),
    document_hash: z.string().refine(isHex64, { message: 'must_be_sha256_hex' }),
    document_uri:  z.string().max(2048).optional(),
    kind:          z.enum(NOTARY_KINDS),
    signers:       z.array(z.object({
      did:        z.string().min(1).max(256),
      signature:  z.string().min(1),
      public_key: z.string().min(1).optional(),
      signed_at:  z.string().optional()
    })).min(1),
    witness_count: z.number().int().min(0).optional(),
    expires_at:    z.string().optional(),
    anchor_on_chain: z.boolean().optional()
  });

  app.post('/v1/notary/:notary_did/notarize', express.json(), async (req, res) => {
    try {
      const notaryDid = req.params.notary_did;
      const auth = await verifyAgentAuth(req, notaryDid);
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const parse = NotarizeSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;

      const notR = await pool.query(
        `SELECT notary_did, active FROM notary_services WHERE notary_did = $1 AND active = TRUE`,
        [notaryDid]
      ).catch(() => ({ rows: [] }));
      if (!notR.rows[0]) return res.status(404).json({ error: 'notary_not_found_or_inactive' });

      // Verify every signer's Ed25519 signature on document_hash
      const verifiedSigners = [];
      for (const s of d.signers) {
        const pub = s.public_key || (await getIdentityPubKey(pool, s.did));
        const ok = pub ? verifySignerSignature(d.document_hash, s.signature, pub) : false;
        if (!ok) {
          return res.status(400).json({ error: 'invalid_signer_signature', signer_did: s.did });
        }
        verifiedSigners.push({
          did: s.did,
          signed_at: s.signed_at || new Date().toISOString(),
          signature: s.signature,
          public_key: pub
        });
      }

      // Notary signs the document_hash with the operator's signing key
      const notarySignature = cryptoLib.createHmac('sha256',
        process.env.IDENTITY_MASTER_KEK || 'openheab-notary-default')
        .update(`${notaryDid}|${d.document_hash}|${d.subject_did}`)
        .digest('hex');

      // Optionally anchor on-chain
      let blockchainTx = null;
      if (d.anchor_on_chain !== false) {
        blockchainTx = await anchorOnChain(d.document_hash);
      }

      const notarizationId = genId('not');
      const notarizedAt = new Date().toISOString();
      const expiresAt = d.expires_at || null;

      const entry = await auditChain.append({
        event_type: 'notary.notarized',
        notarization_id: notarizationId,
        notary_did: notaryDid,
        subject_did: d.subject_did,
        document_hash: d.document_hash,
        kind: d.kind,
        signer_count: verifiedSigners.length,
        blockchain_tx: blockchainTx,
        timestamp: notarizedAt
      });

      const publicRecordUri = `${process.env.OPERATOR_PUBLIC_URL || ''}/v1/notary/notarizations/${notarizationId}`;

      await pool.query(`
        INSERT INTO notarizations
          (notarization_id, notary_did, subject_did, document_hash, document_uri,
           kind, signers, witness_count, notary_signature, blockchain_tx,
           public_record_uri, audit_chain_entry, notarized_at, expires_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13,$14)
      `, [notarizationId, notaryDid, d.subject_did, d.document_hash,
          d.document_uri || null, d.kind, JSON.stringify(verifiedSigners),
          d.witness_count || 0, notarySignature, blockchainTx,
          publicRecordUri, entry.hash, notarizedAt, expiresAt]);

      return res.status(201).json({
        notarization_id: notarizationId,
        notary_did: notaryDid,
        subject_did: d.subject_did,
        document_hash: d.document_hash,
        kind: d.kind,
        signer_count: verifiedSigners.length,
        notary_signature: notarySignature,
        blockchain_tx: blockchainTx,
        public_record_uri: publicRecordUri,
        audit_chain_entry: entry.hash,
        notarized_at: notarizedAt,
        expires_at: expiresAt
      });
    } catch (e) {
      console.error('[notary.notarize]', e);
      return res.status(500).json({ error: 'notarize_failed', message: e.message });
    }
  });

  // GET /v1/notary/notarizations/:id — public lookup (no auth)
  app.get('/v1/notary/notarizations/:id', async (req, res) => {
    try {
      const r = await pool.query(
        `SELECT notarization_id, notary_did, subject_did, document_hash, document_uri,
                kind, signers, witness_count, notary_signature, blockchain_tx,
                public_record_uri, audit_chain_entry, notarized_at, expires_at, revoked_at
         FROM notarizations WHERE notarization_id = $1`,
        [req.params.id]
      ).catch(() => ({ rows: [] }));
      if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
      return res.json(r.rows[0]);
    } catch (e) {
      return res.status(500).json({ error: 'get_failed', message: e.message });
    }
  });

  // POST /v1/notary/notarizations/:id/revoke
  const RevokeSchema = z.object({ reason: z.string().max(2000).optional() });
  app.post('/v1/notary/notarizations/:id/revoke', express.json(), async (req, res) => {
    try {
      const r0 = await pool.query(
        `SELECT notary_did, subject_did, revoked_at FROM notarizations WHERE notarization_id = $1`,
        [req.params.id]
      ).catch(() => ({ rows: [] }));
      if (!r0.rows[0]) return res.status(404).json({ error: 'not_found' });
      if (r0.rows[0].revoked_at) return res.status(409).json({ error: 'already_revoked' });

      const requester = req.headers['x-agent-did'];
      if (!requester) return res.status(401).json({ error: 'missing_agent_did' });
      const auth = await verifyAgentAuth(req, requester);
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      // Only the notary or the subject can revoke
      if (requester !== r0.rows[0].notary_did && requester !== r0.rows[0].subject_did) {
        return res.status(403).json({ error: 'not_authorized' });
      }

      const parse = RevokeSchema.safeParse(req.body || {});
      const reason = parse.success ? (parse.data.reason || null) : null;

      await pool.query(
        `UPDATE notarizations SET revoked_at = NOW() WHERE notarization_id = $1`,
        [req.params.id]
      );
      const entry = await auditChain.append({
        event_type: 'notary.revoked',
        notarization_id: req.params.id,
        revoked_by_did: requester, reason,
        timestamp: new Date().toISOString()
      });

      return res.json({ notarization_id: req.params.id, revoked: true,
        audit_chain_entry: entry.hash });
    } catch (e) {
      return res.status(500).json({ error: 'revoke_failed', message: e.message });
    }
  });

  // POST /v1/agents/:did/attest — issue attestation about another DID
  const AttestSchema = z.object({
    subject_did:  z.string().min(1).max(256),
    claim:        z.string().min(1).max(4000),
    evidence_uri: z.string().max(2048).optional(),
    valid_until:  z.string().optional()
  });
  app.post('/v1/agents/:did/attest', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const parse = AttestSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;

      const attestationId = genId('att');
      const claimHash = cryptoLib.createHash('sha256')
        .update(`${did}|${d.subject_did}|${d.claim}|${d.evidence_uri || ''}`)
        .digest('hex');
      const signature = cryptoLib.createHmac('sha256',
        process.env.IDENTITY_MASTER_KEK || 'openheab-attest-default')
        .update(claimHash).digest('hex');

      const entry = await auditChain.append({
        event_type: 'notary.attestation_issued',
        attestation_id: attestationId,
        attestor_did: did, subject_did: d.subject_did,
        claim_hash: claimHash,
        timestamp: new Date().toISOString()
      });

      await pool.query(`
        INSERT INTO attestations
          (attestation_id, attestor_did, subject_did, claim, evidence_uri,
           valid_from, valid_until, signature, audit_chain_entry)
        VALUES ($1,$2,$3,$4,$5, NOW(), $6, $7, $8)
      `, [attestationId, did, d.subject_did, d.claim,
          d.evidence_uri || null, d.valid_until || null,
          signature, entry.hash]);

      return res.status(201).json({
        attestation_id: attestationId,
        attestor_did: did, subject_did: d.subject_did,
        claim: d.claim, signature,
        audit_chain_entry: entry.hash
      });
    } catch (e) {
      console.error('[notary.attest]', e);
      return res.status(500).json({ error: 'attest_failed', message: e.message });
    }
  });

  // GET /v1/agents/:did/attestations — issued and received
  app.get('/v1/agents/:did/attestations', async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const limit = Math.min(parseInt(req.query.limit) || 50, 500);

      const issued = await pool.query(`
        SELECT attestation_id, subject_did, claim, evidence_uri,
               valid_from, valid_until, signature, revoked_at, created_at
        FROM attestations WHERE attestor_did = $1
        ORDER BY created_at DESC LIMIT $2
      `, [did, limit]).catch(() => ({ rows: [] }));

      const received = await pool.query(`
        SELECT attestation_id, attestor_did, claim, evidence_uri,
               valid_from, valid_until, signature, revoked_at, created_at
        FROM attestations WHERE subject_did = $1
        ORDER BY created_at DESC LIMIT $2
      `, [did, limit]).catch(() => ({ rows: [] }));

      return res.json({
        agent_did: did,
        issued: issued.rows, issued_count: issued.rows.length,
        received: received.rows, received_count: received.rows.length
      });
    } catch (e) {
      return res.status(500).json({ error: 'list_failed', message: e.message });
    }
  });
}

module.exports = {
  migrate,
  registerNotaryRoutes,
  verifySignerSignature,
  anchorOnChain,
  NOTARY_KINDS
};
