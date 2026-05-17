// ============================================================================
// Agent passport — digital travel/ID documents (eKYC tier 4+, EU ID2.0, etc)
// ============================================================================
const crypto = require('crypto');
const { z } = require('zod');

async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS passport_documents (
      doc_id            TEXT PRIMARY KEY,
      holder_did        TEXT NOT NULL,
      kind              TEXT NOT NULL,
      issuer_country    TEXT NOT NULL,
      issuer_authority  TEXT,
      document_number   TEXT,
      issued_at         DATE,
      expires_at        DATE,
      mrz_encrypted     BYTEA,
      photo_blob_id     TEXT,
      verification_status TEXT NOT NULL DEFAULT 'unverified',
      verified_at       TIMESTAMPTZ,
      verification_provider TEXT,
      revoked_at        TIMESTAMPTZ,
      audit_chain_entry TEXT,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_passport_holder
      ON passport_documents (holder_did) WHERE revoked_at IS NULL;

    CREATE TABLE IF NOT EXISTS passport_credentials (
      credential_id     TEXT PRIMARY KEY,
      holder_did        TEXT NOT NULL,
      kind              TEXT NOT NULL,
      issuer_did        TEXT,
      schema_uri        TEXT,
      claims            JSONB NOT NULL,
      proof             JSONB,
      issued_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at        TIMESTAMPTZ,
      revoked_at        TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS passport_presentations (
      presentation_id   TEXT PRIMARY KEY,
      holder_did        TEXT NOT NULL,
      verifier_did      TEXT,
      verifier_url      TEXT,
      credentials       JSONB,
      disclosed_claims  JSONB,
      challenge         TEXT,
      proof             JSONB,
      result            TEXT,
      presented_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

const docSchema = z.object({
  kind: z.enum(['passport', 'drivers_license', 'national_id', 'birth_certificate',
                'tax_id', 'visa', 'work_permit', 'residence_permit', 'other']),
  issuer_country: z.string().length(2),
  issuer_authority: z.string().max(200).optional(),
  document_number: z.string().max(100),
  issued_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  expires_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  photo_blob_id: z.string().optional(),
  mrz: z.string().optional()
});

async function handleAdd(req, res, pool, verifyAgentAuth, auditChain) {
  const did = req.params.did;
  const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
  if (!auth.valid) return res.status(401).json({ error: auth.error });

  let body;
  try { body = docSchema.parse(req.body); }
  catch (e) { return res.status(400).json({ error: 'invalid_request', details: e.errors }); }

  const docId = 'pdoc_' + crypto.randomBytes(10).toString('hex');
  let mrzEnc = null;
  if (body.mrz) {
    const kek = process.env.IDENTITY_MASTER_KEK;
    if (!kek || kek.length < 64) {
      return res.status(503).json({ error: 'mrz_encryption_unavailable', message: 'IDENTITY_MASTER_KEK must be set (≥64 hex chars) to store MRZ data' });
    }
    const key = Buffer.from(kek.slice(0, 64), 'hex');
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([cipher.update(body.mrz, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    mrzEnc = Buffer.concat([iv, tag, ct]);
  }
  await pool.query(`
    INSERT INTO passport_documents (doc_id, holder_did, kind, issuer_country,
      issuer_authority, document_number, issued_at, expires_at, mrz_encrypted, photo_blob_id)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
  `, [docId, did, body.kind, body.issuer_country, body.issuer_authority || null,
      body.document_number, body.issued_at || null, body.expires_at || null,
      mrzEnc, body.photo_blob_id || null]);

  if (auditChain) {
    await auditChain.append({
      event_type: 'passport.added',
      holder_did: did, doc_id: docId, kind: body.kind
    });
  }
  return res.status(201).json({ doc_id: docId, kind: body.kind, status: 'unverified' });
}

async function handleList(req, res, pool, verifyAgentAuth) {
  const did = req.params.did;
  const auth = await verifyAgentAuth(req, did);
  if (!auth.valid) return res.status(401).json({ error: auth.error });
  const r = await pool.query(`
    SELECT doc_id, kind, issuer_country, issuer_authority, document_number,
           issued_at, expires_at, verification_status, verified_at,
           verification_provider, photo_blob_id
    FROM passport_documents
    WHERE holder_did = $1 AND revoked_at IS NULL
    ORDER BY issued_at DESC NULLS LAST
  `, [did]);
  return res.json({ holder_did: did, documents: r.rows });
}

async function handleVerify(req, res, pool, verifyAgentAuth, auditChain) {
  const did = req.params.did;
  const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
  if (!auth.valid) return res.status(401).json({ error: auth.error });

  const provider = req.body?.provider || 'jumio';
  const r = await pool.query(`
    UPDATE passport_documents
    SET verification_status = 'verified',
        verified_at = NOW(),
        verification_provider = $1
    WHERE doc_id = $2 AND holder_did = $3 AND verification_status = 'unverified'
    RETURNING doc_id
  `, [provider, req.params.id, did]);
  if (!r.rows[0]) return res.status(404).json({ error: 'not_found_or_already_verified' });
  if (auditChain) {
    await auditChain.append({
      event_type: 'passport.verified',
      holder_did: did, doc_id: r.rows[0].doc_id, provider
    });
  }
  return res.json({ doc_id: r.rows[0].doc_id, status: 'verified' });
}

const credentialSchema = z.object({
  kind: z.enum(['age_over', 'citizenship', 'residency', 'employment',
                'education', 'professional_license', 'membership', 'other']),
  issuer_did: z.string().optional(),
  schema_uri: z.string().url().optional(),
  claims: z.record(z.any()),
  expires_in_days: z.number().int().positive().optional()
});

async function handleIssueCredential(req, res, pool, verifyAgentAuth, auditChain) {
  const issuerDid = req.headers['x-agent-did'] || req.params.did;
  const holderDid = req.body.holder_did || req.params.did;
  const auth = await verifyAgentAuth(req, issuerDid, { strictSignatureRequired: true });
  if (!auth.valid) return res.status(401).json({ error: auth.error });

  let body;
  try { body = credentialSchema.parse(req.body); }
  catch (e) { return res.status(400).json({ error: 'invalid_request', details: e.errors }); }

  const credId = 'cred_' + crypto.randomBytes(10).toString('hex');
  const expiresAt = body.expires_in_days
    ? new Date(Date.now() + body.expires_in_days * 86400_000) : null;

  // Sign claims with issuer key (simplified — real implementation uses Ed25519 detached signature on canonical JSON-LD)
  const canonical = JSON.stringify({ holder: holderDid, claims: body.claims });
  const proofSig = crypto.createHash('sha256').update(issuerDid + ':' + canonical).digest('hex');

  await pool.query(`
    INSERT INTO passport_credentials (credential_id, holder_did, kind,
      issuer_did, schema_uri, claims, proof, expires_at)
    VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8)
  `, [credId, holderDid, body.kind, issuerDid, body.schema_uri || null,
      JSON.stringify(body.claims), JSON.stringify({ kind: 'simple-hash', value: proofSig }),
      expiresAt]);

  if (auditChain) {
    await auditChain.append({
      event_type: 'credential.issued',
      issuer_did: issuerDid, holder_did: holderDid, credential_id: credId, kind: body.kind
    });
  }
  return res.status(201).json({ credential_id: credId, kind: body.kind, expires_at: expiresAt });
}

async function handlePresent(req, res, pool, verifyAgentAuth, auditChain) {
  const did = req.params.did;
  const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
  if (!auth.valid) return res.status(401).json({ error: auth.error });

  const credIds = req.body?.credential_ids;
  const disclose = req.body?.disclose;
  const verifierDid = req.body?.verifier_did;
  if (!Array.isArray(credIds)) return res.status(400).json({ error: 'credential_ids_required' });

  const r = await pool.query(`
    SELECT credential_id, kind, issuer_did, claims FROM passport_credentials
    WHERE credential_id = ANY($1::text[]) AND holder_did = $2
      AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > NOW())
  `, [credIds, did]);

  const disclosed = {};
  for (const row of r.rows) {
    if (Array.isArray(disclose) && disclose.length) {
      const c = {};
      for (const k of disclose) if (row.claims[k] !== undefined) c[k] = row.claims[k];
      disclosed[row.credential_id] = { kind: row.kind, issuer: row.issuer_did, claims: c };
    } else {
      disclosed[row.credential_id] = { kind: row.kind, issuer: row.issuer_did, claims: row.claims };
    }
  }

  const presId = 'pres_' + crypto.randomBytes(8).toString('hex');
  await pool.query(`
    INSERT INTO passport_presentations (presentation_id, holder_did, verifier_did,
      credentials, disclosed_claims, result)
    VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, 'pending')
  `, [presId, did, verifierDid || null, JSON.stringify(credIds), JSON.stringify(disclosed)]);

  if (auditChain) {
    await auditChain.append({
      event_type: 'passport.presented',
      holder_did: did, verifier_did: verifierDid, presentation_id: presId
    });
  }
  return res.json({ presentation_id: presId, disclosed });
}

function registerPassportRoutes(app, pool, verifyAgentAuth, auditChain) {
  app.post('/v1/agents/:did/passport/documents',
    (req, res) => handleAdd(req, res, pool, verifyAgentAuth, auditChain));
  app.get('/v1/agents/:did/passport/documents',
    (req, res) => handleList(req, res, pool, verifyAgentAuth));
  app.post('/v1/agents/:did/passport/documents/:id/verify',
    (req, res) => handleVerify(req, res, pool, verifyAgentAuth, auditChain));
  app.post('/v1/agents/:did/passport/credentials',
    (req, res) => handleIssueCredential(req, res, pool, verifyAgentAuth, auditChain));
  app.post('/v1/agents/:did/passport/present',
    (req, res) => handlePresent(req, res, pool, verifyAgentAuth, auditChain));
}

module.exports = { migrate, registerPassportRoutes };
