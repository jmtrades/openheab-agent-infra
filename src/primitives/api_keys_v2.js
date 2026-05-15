// ============================================================================
// api_keys_v2.js — proper API key management: create, list, rotate, revoke.
// Each key is hashed (sha256) before storage; raw key only shown at creation.
// Agents can scope keys (read-only, read-write, billing-only) and set expiry.
// Closes the gap between signup creating a single key and ongoing operations.
// ============================================================================
const crypto = require('crypto');
const { z } = require('zod');

async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS api_keys_v2 (
      key_id            TEXT PRIMARY KEY,
      agent_did         TEXT NOT NULL,
      name              TEXT NOT NULL,
      key_hash          TEXT NOT NULL UNIQUE,
      key_prefix        TEXT NOT NULL,
      scope             TEXT NOT NULL DEFAULT 'read-write',
      expires_at        TIMESTAMPTZ,
      last_used_at      TIMESTAMPTZ,
      use_count         BIGINT NOT NULL DEFAULT 0,
      revoked_at        TIMESTAMPTZ,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_api_keys_v2_agent ON api_keys_v2 (agent_did);
    CREATE INDEX IF NOT EXISTS idx_api_keys_v2_hash ON api_keys_v2 (key_hash) WHERE revoked_at IS NULL;
  `);
}

function newId(p) { return p + '_' + crypto.randomBytes(10).toString('hex'); }

function generateKey() {
  const raw = 'oh_live_' + crypto.randomBytes(32).toString('base64url');
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  const prefix = raw.slice(0, 16);
  return { raw, hash, prefix };
}

const createSchema = z.object({
  name: z.string().min(1).max(100),
  scope: z.enum(['read-only', 'read-write', 'billing-only', 'admin']).optional(),
  expires_days: z.number().int().min(1).max(3650).optional()
});

async function verifyApiKey(pool, rawKey) {
  if (!rawKey || !rawKey.startsWith('oh_live_')) return null;
  const hash = crypto.createHash('sha256').update(rawKey).digest('hex');
  const r = await pool.query(
    `SELECT key_id, agent_did, scope, expires_at, revoked_at FROM api_keys_v2 WHERE key_hash = $1`,
    [hash]
  ).catch(() => ({ rows: [] }));
  const row = r.rows[0];
  if (!row) return null;
  if (row.revoked_at) return { valid: false, reason: 'revoked' };
  if (row.expires_at && new Date(row.expires_at) < new Date()) return { valid: false, reason: 'expired' };
  pool.query(`UPDATE api_keys_v2 SET last_used_at=NOW(), use_count=use_count+1 WHERE key_id=$1`, [row.key_id]).catch(() => {});
  return { valid: true, agent_did: row.agent_did, scope: row.scope, key_id: row.key_id };
}

function registerApiKeysV2Routes(app, pool, verifyAgentAuth, auditChain) {
  const express = require('express');

  // Create a new API key
  app.post('/v1/agents/:did/keys', express.json(), async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const p = createSchema.safeParse(req.body || {});
    if (!p.success) return res.status(400).json({ error: 'invalid_input', details: p.error.flatten() });
    const { raw, hash, prefix } = generateKey();
    const id = newId('ak');
    const expires = p.data.expires_days ? new Date(Date.now() + p.data.expires_days * 86400000) : null;
    await pool.query(
      `INSERT INTO api_keys_v2 (key_id, agent_did, name, key_hash, key_prefix, scope, expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [id, did, p.data.name, hash, prefix, p.data.scope || 'read-write', expires]
    );
    if (auditChain) await auditChain.append({ event_type: 'api_key.created', key_id: id, agent_did: did, scope: p.data.scope }).catch(() => {});
    res.status(201).json({
      key_id: id, key: raw, prefix, scope: p.data.scope || 'read-write', expires_at: expires,
      warning: 'Save this key now. It will not be shown again.'
    });
  });

  // List keys (raw key never returned)
  app.get('/v1/agents/:did/keys', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(
      `SELECT key_id, name, key_prefix, scope, expires_at, last_used_at, use_count, revoked_at, created_at
       FROM api_keys_v2 WHERE agent_did=$1 ORDER BY created_at DESC`, [did]
    ).catch(() => ({ rows: [] }));
    res.json({ keys: r.rows });
  });

  // Rotate (revoke old + create new with same name/scope)
  app.post('/v1/agents/:did/keys/:key_id/rotate', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const old = await pool.query(
      `SELECT name, scope FROM api_keys_v2 WHERE key_id=$1 AND agent_did=$2 AND revoked_at IS NULL`,
      [req.params.key_id, did]
    ).catch(() => ({ rows: [] }));
    if (!old.rows[0]) return res.status(404).json({ error: 'not_found' });
    await pool.query(`UPDATE api_keys_v2 SET revoked_at=NOW() WHERE key_id=$1`, [req.params.key_id]).catch(() => {});
    const { raw, hash, prefix } = generateKey();
    const id = newId('ak');
    await pool.query(
      `INSERT INTO api_keys_v2 (key_id, agent_did, name, key_hash, key_prefix, scope) VALUES ($1,$2,$3,$4,$5,$6)`,
      [id, did, old.rows[0].name, hash, prefix, old.rows[0].scope]
    );
    if (auditChain) await auditChain.append({ event_type: 'api_key.rotated', old_key_id: req.params.key_id, new_key_id: id, agent_did: did }).catch(() => {});
    res.json({ key_id: id, key: raw, prefix, scope: old.rows[0].scope, warning: 'Save this key now. It will not be shown again.' });
  });

  // Revoke
  app.delete('/v1/agents/:did/keys/:key_id', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(
      `UPDATE api_keys_v2 SET revoked_at=NOW() WHERE key_id=$1 AND agent_did=$2 AND revoked_at IS NULL`,
      [req.params.key_id, did]
    ).catch(() => ({ rowCount: 0 }));
    if (auditChain) await auditChain.append({ event_type: 'api_key.revoked', key_id: req.params.key_id, agent_did: did }).catch(() => {});
    res.json({ revoked: r.rowCount || 0 });
  });

  // Verify (for middleware-style usage by downstream apps)
  app.post('/v1/_internal/api-keys/verify', express.json(), async (req, res) => {
    if (req.headers['x-internal-api-key'] !== process.env.INTERNAL_API_KEY) return res.status(401).json({ error: 'unauthorized' });
    const result = await verifyApiKey(pool, req.body?.key);
    res.json(result || { valid: false });
  });
}

module.exports = { migrate, registerApiKeysV2Routes, verifyApiKey, generateKey };
