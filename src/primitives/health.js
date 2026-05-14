// ============================================================================
// Health records — HIPAA-compliant medical records for agents that act on
// behalf of humans (e.g. health concierge agents, telemedicine, fitness)
// ============================================================================
// Encrypted at rest with HKDF-derived KEK from HEALTH_MASTER_KEK.
// Audit-chained access. Patient consent required on every read.

const crypto = require('crypto');
const { z } = require('zod');

const MASTER_KEK = process.env.HEALTH_MASTER_KEK || process.env.SECRETS_MASTER_KEK || process.env.IDENTITY_MASTER_KEK;

async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS health_records (
      record_id           TEXT PRIMARY KEY,
      agent_did           TEXT NOT NULL,
      patient_did         TEXT NOT NULL,
      kind                TEXT NOT NULL,
      provider_name       TEXT,
      provider_npi        TEXT,
      issued_at           TIMESTAMPTZ,
      data_encrypted      BYTEA NOT NULL,
      kek_salt            BYTEA NOT NULL,
      kek_iv              BYTEA NOT NULL,
      kek_tag             BYTEA NOT NULL,
      tags                TEXT[],
      sensitive_flags     TEXT[],
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      revoked_at          TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_health_patient
      ON health_records (patient_did, created_at DESC) WHERE revoked_at IS NULL;

    CREATE TABLE IF NOT EXISTS health_consents (
      consent_id        TEXT PRIMARY KEY,
      patient_did       TEXT NOT NULL,
      grantee_did       TEXT NOT NULL,
      scope             JSONB NOT NULL,
      purpose           TEXT,
      granted_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at        TIMESTAMPTZ,
      revoked_at        TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_health_consents_patient
      ON health_consents (patient_did, grantee_did) WHERE revoked_at IS NULL;

    CREATE TABLE IF NOT EXISTS health_access_log (
      log_id            TEXT PRIMARY KEY,
      record_id         TEXT NOT NULL,
      accessor_did      TEXT NOT NULL,
      consent_id        TEXT,
      purpose           TEXT,
      accessed_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

function deriveKek(patientDid, salt) {
  if (!MASTER_KEK) throw new Error('HEALTH_MASTER_KEK or fallback required');
  return Buffer.from(crypto.hkdfSync('sha256',
    Buffer.from(MASTER_KEK, 'hex'), salt, Buffer.from('health:' + patientDid), 32));
}

function encryptRecord(value, patientDid) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const kek = deriveKek(patientDid, salt);
  const cipher = crypto.createCipheriv('aes-256-gcm', kek, iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return { encrypted: ct, salt, iv, tag: cipher.getAuthTag() };
}

function decryptRecord(row, patientDid) {
  const kek = deriveKek(patientDid, row.kek_salt);
  const dec = crypto.createDecipheriv('aes-256-gcm', kek, row.kek_iv);
  dec.setAuthTag(row.kek_tag);
  const plain = Buffer.concat([dec.update(row.data_encrypted), dec.final()]).toString('utf8');
  return JSON.parse(plain);
}

const createSchema = z.object({
  patient_did: z.string().regex(/^did:op:/),
  kind: z.enum(['lab_result', 'prescription', 'vaccination', 'diagnosis', 'imaging',
                'procedure', 'allergy', 'condition', 'medication', 'vitals',
                'consultation_note', 'fitness', 'other']),
  data: z.record(z.any()),
  provider_name: z.string().max(200).optional(),
  provider_npi: z.string().regex(/^\d{10}$/).optional(),
  issued_at: z.string().datetime().optional(),
  tags: z.array(z.string()).max(20).optional(),
  sensitive_flags: z.array(z.enum(['hiv', 'mental_health', 'substance_abuse',
                                    'genetic', 'reproductive'])).optional()
});

async function handleCreate(req, res, pool, verifyAgentAuth, auditChain) {
  const did = req.params.did;
  const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
  if (!auth.valid) return res.status(401).json({ error: auth.error || 'signature_required' });

  let body;
  try { body = createSchema.parse(req.body); }
  catch (e) { return res.status(400).json({ error: 'invalid_request', details: e.errors }); }

  // Require consent if creator != patient
  if (did !== body.patient_did) {
    const consent = await pool.query(`
      SELECT 1 FROM health_consents
      WHERE patient_did = $1 AND grantee_did = $2
        AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > NOW())
        AND scope->>'write' = 'true'
    `, [body.patient_did, did]);
    if (!consent.rows[0]) return res.status(403).json({ error: 'no_write_consent' });
  }

  const { encrypted, salt, iv, tag } = encryptRecord(body.data, body.patient_did);
  const recordId = 'hrec_' + crypto.randomBytes(12).toString('hex');
  await pool.query(`
    INSERT INTO health_records (record_id, agent_did, patient_did, kind, provider_name,
      provider_npi, issued_at, data_encrypted, kek_salt, kek_iv, kek_tag, tags, sensitive_flags)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
  `, [recordId, did, body.patient_did, body.kind, body.provider_name || null,
      body.provider_npi || null, body.issued_at || null,
      encrypted, salt, iv, tag, body.tags || null, body.sensitive_flags || null]);

  if (auditChain) {
    await auditChain.append({
      event_type: 'health.record_created',
      agent_did: did, patient_did: body.patient_did, record_id: recordId, kind: body.kind
    });
  }
  return res.status(201).json({ record_id: recordId, kind: body.kind });
}

async function handleRead(req, res, pool, verifyAgentAuth, auditChain) {
  const did = req.params.did;
  const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
  if (!auth.valid) return res.status(401).json({ error: auth.error });

  const r = await pool.query(
    `SELECT * FROM health_records WHERE record_id = $1 AND revoked_at IS NULL`,
    [req.params.id]
  );
  if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });

  const row = r.rows[0];
  let consentId = null;
  if (did !== row.patient_did) {
    const consent = await pool.query(`
      SELECT consent_id, scope FROM health_consents
      WHERE patient_did = $1 AND grantee_did = $2
        AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > NOW())
        AND scope->>'read' = 'true'
    `, [row.patient_did, did]);
    if (!consent.rows[0]) return res.status(403).json({ error: 'no_read_consent' });
    consentId = consent.rows[0].consent_id;
  }

  let data;
  try { data = decryptRecord(row, row.patient_did); }
  catch (e) { return res.status(500).json({ error: 'decrypt_failed' }); }

  await pool.query(`
    INSERT INTO health_access_log (log_id, record_id, accessor_did, consent_id, purpose)
    VALUES ($1, $2, $3, $4, $5)
  `, ['halog_' + crypto.randomBytes(8).toString('hex'),
      row.record_id, did, consentId, req.query.purpose || null]).catch(() => {});

  if (auditChain) {
    await auditChain.append({
      event_type: 'health.record_accessed',
      record_id: row.record_id, accessor_did: did, patient_did: row.patient_did
    });
  }

  return res.json({
    record_id: row.record_id,
    patient_did: row.patient_did,
    kind: row.kind,
    provider_name: row.provider_name,
    issued_at: row.issued_at,
    tags: row.tags,
    sensitive_flags: row.sensitive_flags,
    data, created_at: row.created_at
  });
}

async function handleList(req, res, pool, verifyAgentAuth) {
  const did = req.params.did;
  const auth = await verifyAgentAuth(req, did);
  if (!auth.valid) return res.status(401).json({ error: auth.error });
  const r = await pool.query(`
    SELECT record_id, patient_did, kind, provider_name, provider_npi,
           issued_at, tags, sensitive_flags, created_at
    FROM health_records
    WHERE (patient_did = $1 OR agent_did = $1) AND revoked_at IS NULL
    ORDER BY created_at DESC LIMIT 200
  `, [did]);
  return res.json({ agent_did: did, records: r.rows });
}

const consentSchema = z.object({
  grantee_did: z.string().regex(/^did:op:/),
  scope: z.object({
    read: z.boolean().optional(),
    write: z.boolean().optional(),
    kinds: z.array(z.string()).optional(),
    sensitive_excluded: z.array(z.string()).optional()
  }),
  purpose: z.string().max(200).optional(),
  expires_in_days: z.number().int().min(1).max(365).optional()
});

async function handleGrantConsent(req, res, pool, verifyAgentAuth, auditChain) {
  const patientDid = req.params.did;
  const auth = await verifyAgentAuth(req, patientDid, { strictSignatureRequired: true });
  if (!auth.valid) return res.status(401).json({ error: auth.error });

  let body;
  try { body = consentSchema.parse(req.body); }
  catch (e) { return res.status(400).json({ error: 'invalid_request', details: e.errors }); }

  const consentId = 'hcon_' + crypto.randomBytes(10).toString('hex');
  const expiresAt = body.expires_in_days
    ? new Date(Date.now() + body.expires_in_days * 86400_000) : null;

  await pool.query(`
    INSERT INTO health_consents (consent_id, patient_did, grantee_did, scope, purpose, expires_at)
    VALUES ($1, $2, $3, $4::jsonb, $5, $6)
  `, [consentId, patientDid, body.grantee_did, JSON.stringify(body.scope),
      body.purpose || null, expiresAt]);

  if (auditChain) {
    await auditChain.append({
      event_type: 'health.consent_granted',
      patient_did: patientDid, grantee_did: body.grantee_did,
      consent_id: consentId, scope: body.scope
    });
  }
  return res.status(201).json({ consent_id: consentId, expires_at: expiresAt });
}

async function handleRevokeConsent(req, res, pool, verifyAgentAuth, auditChain) {
  const did = req.params.did;
  const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
  if (!auth.valid) return res.status(401).json({ error: auth.error });

  const r = await pool.query(`
    UPDATE health_consents SET revoked_at = NOW()
    WHERE consent_id = $1 AND patient_did = $2 AND revoked_at IS NULL
    RETURNING consent_id
  `, [req.params.consent_id, did]);
  if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
  if (auditChain) {
    await auditChain.append({
      event_type: 'health.consent_revoked',
      patient_did: did, consent_id: r.rows[0].consent_id
    });
  }
  return res.json({ consent_id: r.rows[0].consent_id, revoked: true });
}

async function handleListConsents(req, res, pool, verifyAgentAuth) {
  const did = req.params.did;
  const auth = await verifyAgentAuth(req, did);
  if (!auth.valid) return res.status(401).json({ error: auth.error });
  const r = await pool.query(`
    SELECT * FROM health_consents
    WHERE patient_did = $1 OR grantee_did = $1
    ORDER BY granted_at DESC
  `, [did]);
  return res.json({ agent_did: did, consents: r.rows });
}

async function handleAccessLog(req, res, pool, verifyAgentAuth) {
  const did = req.params.did;
  const auth = await verifyAgentAuth(req, did);
  if (!auth.valid) return res.status(401).json({ error: auth.error });
  const r = await pool.query(`
    SELECT log_id, record_id, accessor_did, consent_id, purpose, accessed_at
    FROM health_access_log al
    JOIN health_records hr ON hr.record_id = al.record_id
    WHERE hr.patient_did = $1
    ORDER BY accessed_at DESC LIMIT 500
  `, [did]);
  return res.json({ agent_did: did, accesses: r.rows });
}

function registerHealthRoutes(app, pool, verifyAgentAuth, auditChain) {
  app.post('/v1/agents/:did/health/records',
    (req, res) => handleCreate(req, res, pool, verifyAgentAuth, auditChain));
  app.get('/v1/agents/:did/health/records',
    (req, res) => handleList(req, res, pool, verifyAgentAuth));
  app.get('/v1/agents/:did/health/records/:id',
    (req, res) => handleRead(req, res, pool, verifyAgentAuth, auditChain));
  app.post('/v1/agents/:did/health/consents',
    (req, res) => handleGrantConsent(req, res, pool, verifyAgentAuth, auditChain));
  app.delete('/v1/agents/:did/health/consents/:consent_id',
    (req, res) => handleRevokeConsent(req, res, pool, verifyAgentAuth, auditChain));
  app.get('/v1/agents/:did/health/consents',
    (req, res) => handleListConsents(req, res, pool, verifyAgentAuth));
  app.get('/v1/agents/:did/health/access-log',
    (req, res) => handleAccessLog(req, res, pool, verifyAgentAuth));
}

module.exports = { migrate, registerHealthRoutes };
