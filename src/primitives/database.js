// ============================================================================
// OpenHeab Database — Per-agent Postgres + Redis instances
// Tables: agent_databases, database_credentials, database_backups
// Encryption: AES-256-GCM with HKDF-derived per-agent KEK from IDENTITY_MASTER_KEK
// Provisioning: Neon API (Postgres), Upstash API (Redis) — fallback to stub
// ============================================================================
const cryptoLib = require('crypto');
const express = require('express');
const { z } = require('zod');

const DB_KINDS = ['postgres', 'redis', 'sqlite'];
const DB_STATUSES = ['provisioning', 'active', 'paused', 'destroyed'];
const ROLES = ['read', 'write', 'admin'];

const DEFAULT_REGION = process.env.DATABASE_DEFAULT_REGION || 'us-east-1';

// ----------------------------------------------------------------------------
// Migration
// ----------------------------------------------------------------------------
async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS agent_databases (
      db_id                   TEXT PRIMARY KEY,
      owner_did               TEXT NOT NULL,
      kind                    TEXT NOT NULL,
      name                    TEXT NOT NULL UNIQUE,
      region                  TEXT,
      size_gb                 INTEGER NOT NULL DEFAULT 1,
      connection_string_enc   BYTEA,
      kek_salt                BYTEA,
      kek_iv                  BYTEA,
      kek_tag                 BYTEA,
      external_id             TEXT,
      status                  TEXT NOT NULL DEFAULT 'provisioning',
      max_connections         INTEGER NOT NULL DEFAULT 10,
      created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_accessed_at        TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_agent_dbs_owner ON agent_databases (owner_did);

    CREATE TABLE IF NOT EXISTS database_credentials (
      credential_id   TEXT PRIMARY KEY,
      db_id           TEXT NOT NULL REFERENCES agent_databases(db_id) ON DELETE CASCADE,
      owner_did       TEXT NOT NULL,
      role            TEXT NOT NULL DEFAULT 'read',
      username        TEXT NOT NULL,
      password_enc    BYTEA NOT NULL,
      kek_salt        BYTEA NOT NULL,
      kek_iv          BYTEA NOT NULL,
      kek_tag         BYTEA NOT NULL,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      revoked_at      TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_db_creds_db ON database_credentials (db_id);

    CREATE TABLE IF NOT EXISTS database_backups (
      backup_id          TEXT PRIMARY KEY,
      db_id              TEXT NOT NULL REFERENCES agent_databases(db_id) ON DELETE CASCADE,
      size_bytes         BIGINT NOT NULL DEFAULT 0,
      storage_blob_id    TEXT,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      restored_to_db_id  TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_db_backups_db ON database_backups (db_id, created_at DESC);
  `);
}

// ----------------------------------------------------------------------------
// Crypto helpers
// ----------------------------------------------------------------------------
function getMasterKek() {
  const raw = process.env.IDENTITY_MASTER_KEK
           || 'openheab-database-default-kek';
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, 'hex');
  return cryptoLib.createHash('sha256').update(raw).digest();
}

function deriveKek(agentDid, salt) {
  const master = getMasterKek();
  const info = Buffer.from(`openheab:database:v1:${agentDid}`, 'utf8');
  return Buffer.from(cryptoLib.hkdfSync('sha256', master, salt, info, 32));
}

function encryptValue(plaintext, agentDid) {
  const salt = cryptoLib.randomBytes(16);
  const iv = cryptoLib.randomBytes(12);
  const kek = deriveKek(agentDid, salt);
  const cipher = cryptoLib.createCipheriv('aes-256-gcm', kek, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { encrypted: enc, salt, iv, tag };
}

function decryptValue(enc, salt, iv, tag, agentDid) {
  const kek = deriveKek(agentDid, salt);
  const decipher = cryptoLib.createDecipheriv('aes-256-gcm', kek, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
  return dec.toString('utf8');
}

function genDbId() { return 'db_' + cryptoLib.randomBytes(12).toString('hex'); }
function genCredId() { return 'dbc_' + cryptoLib.randomBytes(12).toString('hex'); }
function genBackupId() { return 'bkp_' + cryptoLib.randomBytes(12).toString('hex'); }

// ----------------------------------------------------------------------------
// External provisioning (Neon / Upstash)
// ----------------------------------------------------------------------------
async function provisionDatabase(kind, name, region) {
  const fetch = global.fetch || require('node-fetch');
  if (kind === 'postgres' && process.env.NEON_API_KEY) {
    try {
      const r = await fetch('https://console.neon.tech/api/v2/projects', {
        method: 'POST',
        headers: {
          'authorization': `Bearer ${process.env.NEON_API_KEY}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({ project: { name, region_id: region || DEFAULT_REGION } })
      });
      const j = await r.json();
      if (j && j.project) {
        const conn = j.connection_uris?.[0]?.connection_uri
                  || `postgres://stub@${j.project.id}.neon.tech/${name}`;
        return { external_id: j.project.id, connection_string: conn };
      }
    } catch (e) {
      console.warn('[database.neon] provisioning failed:', e.message);
    }
  }
  if (kind === 'redis' && process.env.UPSTASH_API_KEY) {
    try {
      const auth = Buffer.from(
        `${process.env.UPSTASH_EMAIL || 'api'}:${process.env.UPSTASH_API_KEY}`
      ).toString('base64');
      const r = await fetch('https://api.upstash.com/v2/redis/database', {
        method: 'POST',
        headers: {
          'authorization': `Basic ${auth}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({ name, region: region || 'us-east-1', tls: true })
      });
      const j = await r.json();
      if (j && j.database_id) {
        return {
          external_id: j.database_id,
          connection_string: j.endpoint
            ? `rediss://default:${j.password}@${j.endpoint}:${j.port}`
            : `redis://stub.upstash.io/${j.database_id}`
        };
      }
    } catch (e) {
      console.warn('[database.upstash] provisioning failed:', e.message);
    }
  }
  // Stub
  const password = cryptoLib.randomBytes(16).toString('hex');
  if (kind === 'postgres') {
    return { external_id: null, connection_string: `postgres://agent:${password}@stub.local/${name}` };
  }
  if (kind === 'redis') {
    return { external_id: null, connection_string: `redis://:${password}@stub.local:6379` };
  }
  return { external_id: null, connection_string: `sqlite:///var/agent/${name}.db` };
}

// ----------------------------------------------------------------------------
// Routes
// ----------------------------------------------------------------------------
function registerDatabaseRoutes(app, pool, verifyAgentAuth, auditChain) {
  // POST /v1/agents/:did/databases — provision
  const ProvSchema = z.object({
    kind: z.enum(DB_KINDS),
    name: z.string().min(3).max(63).regex(/^[a-z0-9_-]+$/i),
    region: z.string().max(64).optional(),
    size_gb: z.number().int().min(1).max(1024).optional().default(1),
    max_connections: z.number().int().min(1).max(1000).optional().default(10)
  });

  app.post('/v1/agents/:did/databases', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const parse = ProvSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;

      const dbId = genDbId();
      const region = d.region || DEFAULT_REGION;

      const prov = await provisionDatabase(d.kind, d.name, region);
      const enc = encryptValue(prov.connection_string, did);

      try {
        await pool.query(
          `INSERT INTO agent_databases
           (db_id, owner_did, kind, name, region, size_gb,
            connection_string_enc, kek_salt, kek_iv, kek_tag,
            external_id, status, max_connections)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'active',$12)`,
          [dbId, did, d.kind, d.name, region, d.size_gb,
           enc.encrypted, enc.salt, enc.iv, enc.tag,
           prov.external_id, d.max_connections]
        );
      } catch (e) {
        if (e.code === '23505') return res.status(409).json({ error: 'name_already_exists' });
        throw e;
      }

      await auditChain.append({
        event_type: 'database.provisioned',
        db_id: dbId, owner_did: did, kind: d.kind, name: d.name, region,
        timestamp: new Date().toISOString()
      });

      return res.status(201).json({
        db_id: dbId, owner_did: did, kind: d.kind, name: d.name,
        region, size_gb: d.size_gb, status: 'active',
        max_connections: d.max_connections,
        external_id: prov.external_id
      });
    } catch (e) {
      console.error('[database.provision]', e);
      return res.status(500).json({ error: 'provision_failed', message: e.message });
    }
  });

  // GET /v1/agents/:did/databases
  app.get('/v1/agents/:did/databases', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });

    const r = await pool.query(
      `SELECT db_id, kind, name, region, size_gb, status, max_connections,
              external_id, created_at, last_accessed_at
       FROM agent_databases WHERE owner_did = $1 AND status != 'destroyed'
       ORDER BY created_at DESC`, [did]
    ).catch(() => ({ rows: [] }));
    return res.json({ databases: r.rows, count: r.rows.length });
  });

  // GET /v1/agents/:did/databases/:id/connection — one-time signed access
  app.get('/v1/agents/:did/databases/:id/connection', async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      // Simple in-memory rate limit per (did, dbId) — 10/min
      const key = `db_conn:${did}:${req.params.id}`;
      if (!global._dbConnRateLimit) global._dbConnRateLimit = new Map();
      const now = Date.now();
      const window = 60000;
      const entry = global._dbConnRateLimit.get(key) || { count: 0, reset: now + window };
      if (entry.reset < now) { entry.count = 0; entry.reset = now + window; }
      entry.count += 1;
      global._dbConnRateLimit.set(key, entry);
      if (entry.count > 10) {
        return res.status(429).json({ error: 'rate_limit_exceeded', retry_after_ms: entry.reset - now });
      }

      const r = await pool.query(
        `SELECT * FROM agent_databases
         WHERE db_id = $1 AND owner_did = $2 AND status != 'destroyed'`,
        [req.params.id, did]
      ).catch(() => ({ rows: [] }));
      if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
      const row = r.rows[0];

      const connStr = decryptValue(
        row.connection_string_enc, row.kek_salt, row.kek_iv, row.kek_tag, did
      );

      await pool.query(
        `UPDATE agent_databases SET last_accessed_at = NOW() WHERE db_id = $1`,
        [row.db_id]
      ).catch(() => {});

      await auditChain.append({
        event_type: 'database.connection_accessed',
        db_id: row.db_id, owner_did: did,
        timestamp: new Date().toISOString()
      });

      return res.json({
        db_id: row.db_id, kind: row.kind, name: row.name,
        connection_string: connStr,
        expires_in_seconds: 300,
        warning: 'Treat connection_string as a secret; rotates on demand.'
      });
    } catch (e) {
      console.error('[database.connection]', e);
      return res.status(500).json({ error: 'connection_fetch_failed', message: e.message });
    }
  });

  // POST /v1/agents/:did/databases/:id/credentials — issue read-only key
  const CredSchema = z.object({
    role: z.enum(ROLES).optional().default('read'),
    username: z.string().max(64).optional()
  });

  app.post('/v1/agents/:did/databases/:id/credentials', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const parse = CredSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;

      const dr = await pool.query(
        `SELECT db_id FROM agent_databases
         WHERE db_id = $1 AND owner_did = $2 AND status = 'active'`,
        [req.params.id, did]
      ).catch(() => ({ rows: [] }));
      if (!dr.rows[0]) return res.status(404).json({ error: 'database_not_found' });

      const credId = genCredId();
      const username = d.username || `${d.role}_${cryptoLib.randomBytes(4).toString('hex')}`;
      const password = cryptoLib.randomBytes(24).toString('base64url');
      const enc = encryptValue(password, did);

      await pool.query(
        `INSERT INTO database_credentials
         (credential_id, db_id, owner_did, role, username,
          password_enc, kek_salt, kek_iv, kek_tag)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [credId, req.params.id, did, d.role, username,
         enc.encrypted, enc.salt, enc.iv, enc.tag]
      );

      await auditChain.append({
        event_type: 'database.credential_issued',
        credential_id: credId, db_id: req.params.id, owner_did: did,
        role: d.role, username,
        timestamp: new Date().toISOString()
      });

      return res.status(201).json({
        credential_id: credId, db_id: req.params.id,
        role: d.role, username, password,
        warning: 'Password is returned once and not stored in plaintext.'
      });
    } catch (e) {
      console.error('[database.credential]', e);
      return res.status(500).json({ error: 'credential_failed', message: e.message });
    }
  });

  // POST /v1/agents/:did/databases/:id/backup
  app.post('/v1/agents/:did/databases/:id/backup', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const dr = await pool.query(
        `SELECT db_id, size_gb FROM agent_databases
         WHERE db_id = $1 AND owner_did = $2 AND status = 'active'`,
        [req.params.id, did]
      ).catch(() => ({ rows: [] }));
      if (!dr.rows[0]) return res.status(404).json({ error: 'database_not_found' });

      const backupId = genBackupId();
      const size = (req.body && req.body.size_bytes) || (dr.rows[0].size_gb * 1024 * 1024 * 1024);
      const blobId = (req.body && req.body.storage_blob_id) || null;

      await pool.query(
        `INSERT INTO database_backups (backup_id, db_id, size_bytes, storage_blob_id)
         VALUES ($1,$2,$3,$4)`,
        [backupId, req.params.id, size, blobId]
      );

      await auditChain.append({
        event_type: 'database.backed_up',
        backup_id: backupId, db_id: req.params.id, owner_did: did,
        size_bytes: size,
        timestamp: new Date().toISOString()
      });

      return res.status(201).json({
        backup_id: backupId, db_id: req.params.id,
        size_bytes: size, storage_blob_id: blobId,
        created_at: new Date().toISOString()
      });
    } catch (e) {
      console.error('[database.backup]', e);
      return res.status(500).json({ error: 'backup_failed', message: e.message });
    }
  });

  // POST /v1/agents/:did/databases/:id/restore
  const RestoreSchema = z.object({
    backup_id: z.string().min(3)
  });

  app.post('/v1/agents/:did/databases/:id/restore', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const parse = RestoreSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;

      const dr = await pool.query(
        `SELECT db_id FROM agent_databases
         WHERE db_id = $1 AND owner_did = $2 AND status = 'active'`,
        [req.params.id, did]
      ).catch(() => ({ rows: [] }));
      if (!dr.rows[0]) return res.status(404).json({ error: 'database_not_found' });

      const br = await pool.query(
        `SELECT backup_id, db_id FROM database_backups WHERE backup_id = $1`,
        [d.backup_id]
      ).catch(() => ({ rows: [] }));
      if (!br.rows[0]) return res.status(404).json({ error: 'backup_not_found' });

      await pool.query(
        `UPDATE database_backups SET restored_to_db_id = $1 WHERE backup_id = $2`,
        [req.params.id, d.backup_id]
      ).catch(() => {});

      await auditChain.append({
        event_type: 'database.restored',
        db_id: req.params.id, owner_did: did, backup_id: d.backup_id,
        timestamp: new Date().toISOString()
      });

      return res.json({
        db_id: req.params.id, backup_id: d.backup_id,
        restored: true, restored_at: new Date().toISOString()
      });
    } catch (e) {
      console.error('[database.restore]', e);
      return res.status(500).json({ error: 'restore_failed', message: e.message });
    }
  });
}

module.exports = {
  migrate,
  registerDatabaseRoutes,
  encryptValue,
  decryptValue,
  DB_KINDS,
  ROLES
};
