// ============================================================================
// OpenHeab Secrets — Encrypted credential vault
// AES-256-GCM with HKDF-derived per-agent KEK from SECRETS_MASTER_KEK.
// Tables: secrets, secret_shares
// Kinds: api_key, oauth_token, cert, password, other
// ============================================================================
const cryptoLib = require('crypto');
const express = require('express');
const { z } = require('zod');

const SECRET_KINDS = ['api_key', 'oauth_token', 'cert', 'password', 'other'];

// ----------------------------------------------------------------------------
// Migration
// ----------------------------------------------------------------------------
async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS secrets (
      handle           TEXT PRIMARY KEY,
      owner_did        TEXT NOT NULL,
      name             TEXT NOT NULL,
      kind             TEXT NOT NULL DEFAULT 'other',
      encrypted_value  BYTEA NOT NULL,
      kek_salt         BYTEA NOT NULL,
      kek_iv           BYTEA NOT NULL,
      kek_tag          BYTEA NOT NULL,
      metadata         JSONB,
      rotation_due_at  TIMESTAMPTZ,
      audit_hash       TEXT,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_accessed    TIMESTAMPTZ,
      access_count     BIGINT NOT NULL DEFAULT 0,
      revoked_at       TIMESTAMPTZ,
      UNIQUE (owner_did, name)
    );
    CREATE INDEX IF NOT EXISTS idx_secrets_owner ON secrets (owner_did);
    CREATE INDEX IF NOT EXISTS idx_secrets_rotation ON secrets (rotation_due_at)
      WHERE rotation_due_at IS NOT NULL AND revoked_at IS NULL;

    CREATE TABLE IF NOT EXISTS secret_shares (
      handle       TEXT NOT NULL,
      shared_with  TEXT NOT NULL,
      can_write    BOOLEAN NOT NULL DEFAULT FALSE,
      expires_at   TIMESTAMPTZ,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (handle, shared_with)
    );
    CREATE INDEX IF NOT EXISTS idx_secret_shares_with ON secret_shares (shared_with);
  `);
}

// ----------------------------------------------------------------------------
// Crypto helpers
// ----------------------------------------------------------------------------
function getMasterKek() {
  const raw = process.env.SECRETS_MASTER_KEK
           || process.env.IDENTITY_MASTER_KEK
           || 'openheab-secrets-default-kek';
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, 'hex');
  return cryptoLib.createHash('sha256').update(raw).digest();
}

function deriveKek(agentDid, salt) {
  const master = getMasterKek();
  const info = Buffer.from(`openheab:secrets:v1:${agentDid}`, 'utf8');
  return Buffer.from(cryptoLib.hkdfSync('sha256', master, salt, info, 32));
}

function encryptSecret(plaintext, agentDid) {
  const salt = cryptoLib.randomBytes(16);
  const iv = cryptoLib.randomBytes(12);
  const kek = deriveKek(agentDid, salt);
  const cipher = cryptoLib.createCipheriv('aes-256-gcm', kek, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { encrypted_value: enc, kek_salt: salt, kek_iv: iv, kek_tag: tag };
}

function decryptSecret(row, agentDid) {
  const kek = deriveKek(agentDid, row.kek_salt);
  const decipher = cryptoLib.createDecipheriv('aes-256-gcm', kek, row.kek_iv);
  decipher.setAuthTag(row.kek_tag);
  const dec = Buffer.concat([decipher.update(row.encrypted_value), decipher.final()]);
  return dec.toString('utf8');
}

function genHandle() {
  return 'sec_' + cryptoLib.randomBytes(16).toString('hex');
}

async function canAccess(pool, handle, requesterDid, ownerDid) {
  if (requesterDid === ownerDid) return true;
  const r = await pool.query(
    `SELECT 1 FROM secret_shares
     WHERE handle = $1 AND shared_with = $2 AND (expires_at IS NULL OR expires_at > NOW())`,
    [handle, requesterDid]
  ).catch(() => ({ rows: [] }));
  return !!r.rows[0];
}

// ----------------------------------------------------------------------------
// Routes
// ----------------------------------------------------------------------------
function registerSecretsRoutes(app, pool, verifyAgentAuth, auditChain) {
  // POST /v1/agents/:did/secrets
  const CreateSchema = z.object({
    name: z.string().min(1).max(256),
    kind: z.enum(SECRET_KINDS).optional().default('other'),
    value: z.string().min(1),
    metadata: z.any().optional(),
    rotation_due_at: z.string().datetime().optional()
  });

  app.post('/v1/agents/:did/secrets', express.json({ limit: '1mb' }), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const parse = CreateSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;

      const handle = genHandle();
      const enc = encryptSecret(d.value, did);

      const chainEntry = await auditChain.append({
        event_type: 'secrets.created',
        handle, owner_did: did, name: d.name, kind: d.kind,
        timestamp: new Date().toISOString()
      });

      try {
        await pool.query(
          `INSERT INTO secrets
           (handle, owner_did, name, kind, encrypted_value, kek_salt, kek_iv, kek_tag,
            metadata, rotation_due_at, audit_hash)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11)`,
          [handle, did, d.name, d.kind, enc.encrypted_value, enc.kek_salt,
           enc.kek_iv, enc.kek_tag,
           d.metadata ? JSON.stringify(d.metadata) : null,
           d.rotation_due_at || null, chainEntry.hash]
        );
      } catch (e) {
        if (e.code === '23505') return res.status(409).json({ error: 'name_already_exists' });
        throw e;
      }

      return res.status(201).json({
        handle, owner_did: did, name: d.name, kind: d.kind,
        rotation_due_at: d.rotation_due_at || null,
        audit_hash: chainEntry.hash
      });
    } catch (e) {
      console.error('[secrets.create]', e);
      return res.status(500).json({ error: 'create_failed', message: e.message });
    }
  });

  // GET /v1/agents/:did/secrets — list metadata only
  app.get('/v1/agents/:did/secrets', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });

    const r = await pool.query(
      `SELECT handle, owner_did, name, kind, metadata, rotation_due_at,
              created_at, last_accessed, access_count, revoked_at
       FROM secrets WHERE owner_did = $1 AND revoked_at IS NULL
       ORDER BY created_at DESC`,
      [did]
    ).catch(() => ({ rows: [] }));
    return res.json({ secrets: r.rows, count: r.rows.length });
  });

  // GET /v1/agents/:did/secrets/:handle — decrypt + return value (strict sig)
  app.get('/v1/agents/:did/secrets/:handle', async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const r = await pool.query(
        `SELECT handle, owner_did, name, kind, encrypted_value, kek_salt, kek_iv,
                kek_tag, metadata, rotation_due_at, revoked_at
         FROM secrets WHERE handle = $1`,
        [req.params.handle]
      ).catch(() => ({ rows: [] }));
      if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
      const row = r.rows[0];
      if (row.revoked_at) return res.status(410).json({ error: 'secret_revoked' });

      const ok = await canAccess(pool, row.handle, did, row.owner_did);
      if (!ok) return res.status(403).json({ error: 'forbidden' });

      const value = decryptSecret(row, row.owner_did);

      await pool.query(
        `UPDATE secrets SET last_accessed = NOW(), access_count = access_count + 1
         WHERE handle = $1`, [row.handle]
      ).catch(() => {});

      await auditChain.append({
        event_type: 'secrets.accessed',
        handle: row.handle, owner_did: row.owner_did, accessed_by: did,
        timestamp: new Date().toISOString()
      });

      return res.json({
        handle: row.handle,
        name: row.name,
        kind: row.kind,
        value,
        metadata: row.metadata,
        rotation_due_at: row.rotation_due_at
      });
    } catch (e) {
      console.error('[secrets.read]', e);
      return res.status(500).json({ error: 'read_failed', message: e.message });
    }
  });

  // PUT /v1/agents/:did/secrets/:handle — rotate
  const RotateSchema = z.object({
    value: z.string().min(1),
    rotation_due_at: z.string().datetime().optional(),
    metadata: z.any().optional()
  });
  app.put('/v1/agents/:did/secrets/:handle', express.json({ limit: '1mb' }), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const parse = RotateSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;

      const r = await pool.query(
        `SELECT owner_did FROM secrets WHERE handle = $1`,
        [req.params.handle]
      ).catch(() => ({ rows: [] }));
      if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
      if (r.rows[0].owner_did !== did) return res.status(403).json({ error: 'forbidden' });

      const enc = encryptSecret(d.value, did);
      await pool.query(
        `UPDATE secrets SET
           encrypted_value = $1, kek_salt = $2, kek_iv = $3, kek_tag = $4,
           rotation_due_at = COALESCE($5, rotation_due_at),
           metadata = COALESCE($6::jsonb, metadata)
         WHERE handle = $7`,
        [enc.encrypted_value, enc.kek_salt, enc.kek_iv, enc.kek_tag,
         d.rotation_due_at || null,
         d.metadata ? JSON.stringify(d.metadata) : null,
         req.params.handle]
      );

      await auditChain.append({
        event_type: 'secrets.rotated',
        handle: req.params.handle, owner_did: did,
        timestamp: new Date().toISOString()
      });

      return res.json({ handle: req.params.handle, rotated: true });
    } catch (e) {
      console.error('[secrets.rotate]', e);
      return res.status(500).json({ error: 'rotate_failed', message: e.message });
    }
  });

  // DELETE /v1/agents/:did/secrets/:handle
  app.delete('/v1/agents/:did/secrets/:handle', async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const r = await pool.query(
        `UPDATE secrets SET revoked_at = NOW()
         WHERE handle = $1 AND owner_did = $2 AND revoked_at IS NULL
         RETURNING handle`,
        [req.params.handle, did]
      ).catch(() => ({ rows: [] }));
      if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });

      await auditChain.append({
        event_type: 'secrets.revoked',
        handle: req.params.handle, owner_did: did,
        timestamp: new Date().toISOString()
      });
      return res.json({ handle: req.params.handle, revoked: true });
    } catch (e) {
      console.error('[secrets.delete]', e);
      return res.status(500).json({ error: 'delete_failed', message: e.message });
    }
  });

  // POST /v1/agents/:did/secrets/:handle/share
  const ShareSchema = z.object({
    shared_with: z.string().min(3),
    can_write: z.boolean().optional().default(false),
    expires_at: z.string().datetime().optional()
  });
  app.post('/v1/agents/:did/secrets/:handle/share', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const parse = ShareSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;

      const r = await pool.query(
        `SELECT owner_did FROM secrets WHERE handle = $1 AND revoked_at IS NULL`,
        [req.params.handle]
      ).catch(() => ({ rows: [] }));
      if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
      if (r.rows[0].owner_did !== did) return res.status(403).json({ error: 'forbidden' });

      await pool.query(
        `INSERT INTO secret_shares (handle, shared_with, can_write, expires_at)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (handle, shared_with) DO UPDATE
         SET can_write = EXCLUDED.can_write, expires_at = EXCLUDED.expires_at`,
        [req.params.handle, d.shared_with, d.can_write, d.expires_at || null]
      );

      await auditChain.append({
        event_type: 'secrets.shared',
        handle: req.params.handle, owner_did: did,
        shared_with: d.shared_with, can_write: d.can_write,
        timestamp: new Date().toISOString()
      });

      return res.json({
        handle: req.params.handle,
        shared_with: d.shared_with,
        can_write: d.can_write,
        expires_at: d.expires_at || null
      });
    } catch (e) {
      console.error('[secrets.share]', e);
      return res.status(500).json({ error: 'share_failed', message: e.message });
    }
  });
}

module.exports = {
  migrate,
  registerSecretsRoutes,
  encryptSecret,
  decryptSecret,
  SECRET_KINDS
};
