// ============================================================================
// OpenHeab Storage — File blobs with signed URLs
// Tables: storage_blobs, storage_shares
// Drivers: postgres (default, BYTEA in DB), s3/r2/gcs (external_url)
// ============================================================================
const cryptoLib = require('crypto');
const express = require('express');
const { z } = require('zod');

const DRIVER = process.env.STORAGE_DRIVER || 'postgres';
const QUOTA_BYTES = parseInt(process.env.STORAGE_QUOTA_BYTES || String(1024 * 1024 * 1024)); // 1GB
const MAX_BLOB_BYTES = parseInt(process.env.STORAGE_MAX_BLOB_BYTES || String(10 * 1024 * 1024)); // 10MB
const DEFAULT_URL_TTL_SEC = parseInt(process.env.STORAGE_URL_TTL_SEC || '3600');

// ----------------------------------------------------------------------------
// Migration
// ----------------------------------------------------------------------------
async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS storage_blobs (
      blob_id        TEXT PRIMARY KEY,
      owner_did      TEXT NOT NULL,
      filename       TEXT,
      content_type   TEXT,
      size_bytes     BIGINT NOT NULL DEFAULT 0,
      sha256         TEXT,
      data           BYTEA,
      external_url   TEXT,
      driver         TEXT NOT NULL DEFAULT 'postgres',
      metadata       JSONB,
      audit_hash     TEXT,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      deleted_at     TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_storage_blobs_owner ON storage_blobs (owner_did);
    CREATE INDEX IF NOT EXISTS idx_storage_blobs_created ON storage_blobs (created_at DESC);

    CREATE TABLE IF NOT EXISTS storage_shares (
      blob_id      TEXT NOT NULL,
      shared_with  TEXT NOT NULL,
      can_write    BOOLEAN NOT NULL DEFAULT FALSE,
      expires_at   TIMESTAMPTZ,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (blob_id, shared_with)
    );
    CREATE INDEX IF NOT EXISTS idx_storage_shares_with ON storage_shares (shared_with);
  `);
}

// ----------------------------------------------------------------------------
// Signing helpers
// ----------------------------------------------------------------------------
function getSigningKey() {
  const raw = process.env.STORAGE_SIGNING_KEY
           || process.env.IDENTITY_MASTER_KEK
           || 'openheab-storage-default-key';
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, 'hex');
  return cryptoLib.createHash('sha256').update(raw).digest();
}

function signDownloadUrl(blobId, expiresIn = DEFAULT_URL_TTL_SEC) {
  const exp = Math.floor(Date.now() / 1000) + expiresIn;
  const payload = `${blobId}|${exp}`;
  const sig = cryptoLib.createHmac('sha256', getSigningKey()).update(payload).digest('hex');
  const base = process.env.OPERATOR_PUBLIC_URL || '';
  const path = `/v1/storage/${encodeURIComponent(blobId)}/download?exp=${exp}&sig=${sig}`;
  return { url: base ? `${base}${path}` : path, path, exp, sig };
}

function verifyDownloadSig(blobId, exp, sig) {
  if (!blobId || !exp || !sig) return false;
  const expNum = parseInt(exp);
  if (!Number.isFinite(expNum)) return false;
  if (expNum < Math.floor(Date.now() / 1000)) return false;
  const expected = cryptoLib.createHmac('sha256', getSigningKey())
    .update(`${blobId}|${expNum}`).digest('hex');
  if (sig.length !== expected.length) return false;
  try {
    return cryptoLib.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return false;
  }
}

function genId() {
  return 'blob_' + cryptoLib.randomBytes(16).toString('hex');
}

async function getOwnerUsage(pool, did) {
  const r = await pool.query(
    `SELECT COALESCE(SUM(size_bytes), 0)::BIGINT AS used
     FROM storage_blobs WHERE owner_did = $1 AND deleted_at IS NULL`,
    [did]
  ).catch(() => ({ rows: [{ used: 0 }] }));
  return parseInt(r.rows[0].used || 0);
}

// ----------------------------------------------------------------------------
// Routes
// ----------------------------------------------------------------------------
function registerStorageRoutes(app, pool, verifyAgentAuth, auditChain) {
  // POST /v1/agents/:did/storage — upload via base64 in JSON body
  const UploadSchema = z.object({
    filename: z.string().max(512).optional(),
    content_type: z.string().max(256).optional(),
    data_base64: z.string().min(1),
    metadata: z.any().optional(),
    external_url: z.string().url().optional()
  });

  app.post('/v1/agents/:did/storage', express.json({ limit: '15mb' }), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const parse = UploadSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;

      let dataBuf = null;
      let sizeBytes = 0;
      if (d.data_base64) {
        try { dataBuf = Buffer.from(d.data_base64, 'base64'); }
        catch { return res.status(400).json({ error: 'invalid_base64' }); }
        sizeBytes = dataBuf.length;
      }
      if (sizeBytes > MAX_BLOB_BYTES) {
        return res.status(413).json({ error: 'blob_too_large', max: MAX_BLOB_BYTES, size: sizeBytes });
      }

      const used = await getOwnerUsage(pool, did);
      if (used + sizeBytes > QUOTA_BYTES) {
        return res.status(413).json({ error: 'quota_exceeded', used, quota: QUOTA_BYTES, size: sizeBytes });
      }

      const blobId = genId();
      const sha256 = dataBuf ? cryptoLib.createHash('sha256').update(dataBuf).digest('hex') : null;
      const chainEntry = await auditChain.append({
        event_type: 'storage.blob_uploaded',
        blob_id: blobId,
        owner_did: did,
        size_bytes: sizeBytes,
        sha256,
        timestamp: new Date().toISOString()
      });

      await pool.query(
        `INSERT INTO storage_blobs
         (blob_id, owner_did, filename, content_type, size_bytes, sha256, data,
          external_url, driver, metadata, audit_hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11)`,
        [blobId, did, d.filename || null, d.content_type || 'application/octet-stream',
         sizeBytes, sha256, DRIVER === 'postgres' ? dataBuf : null,
         d.external_url || null, DRIVER,
         d.metadata ? JSON.stringify(d.metadata) : null, chainEntry.hash]
      );

      const signed = signDownloadUrl(blobId);
      return res.status(201).json({
        blob_id: blobId,
        owner_did: did,
        filename: d.filename || null,
        content_type: d.content_type || 'application/octet-stream',
        size_bytes: sizeBytes,
        sha256,
        driver: DRIVER,
        download_url: signed.url,
        download_url_expires: signed.exp,
        audit_hash: chainEntry.hash
      });
    } catch (e) {
      console.error('[storage.upload]', e);
      return res.status(500).json({ error: 'upload_failed', message: e.message });
    }
  });

  // GET /v1/agents/:did/storage — list owned
  app.get('/v1/agents/:did/storage', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });

    const limit = Math.min(parseInt(req.query.limit) || 50, 500);
    const offset = Math.max(parseInt(req.query.offset) || 0, 0);
    const r = await pool.query(
      `SELECT blob_id, filename, content_type, size_bytes, sha256, driver, metadata, created_at
       FROM storage_blobs WHERE owner_did = $1 AND deleted_at IS NULL
       ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
      [did, limit, offset]
    ).catch(() => ({ rows: [] }));
    const used = await getOwnerUsage(pool, did);
    return res.json({
      blobs: r.rows, count: r.rows.length,
      used_bytes: used, quota_bytes: QUOTA_BYTES,
      max_blob_bytes: MAX_BLOB_BYTES
    });
  });

  // GET /v1/agents/:did/storage/:blobId — metadata
  app.get('/v1/agents/:did/storage/:blobId', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });

    const r = await pool.query(
      `SELECT blob_id, owner_did, filename, content_type, size_bytes, sha256,
              external_url, driver, metadata, audit_hash, created_at, deleted_at
       FROM storage_blobs WHERE blob_id = $1`,
      [req.params.blobId]
    ).catch(() => ({ rows: [] }));
    if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
    const row = r.rows[0];
    if (row.owner_did !== did) {
      const shareR = await pool.query(
        `SELECT can_write FROM storage_shares
         WHERE blob_id=$1 AND shared_with=$2 AND (expires_at IS NULL OR expires_at > NOW())`,
        [req.params.blobId, did]
      ).catch(() => ({ rows: [] }));
      if (!shareR.rows[0]) return res.status(403).json({ error: 'forbidden' });
    }
    return res.json(row);
  });

  // GET /v1/storage/:blobId/download — public signed URL endpoint
  app.get('/v1/storage/:blobId/download', async (req, res) => {
    const blobId = req.params.blobId;
    const exp = req.query.exp;
    const sig = req.query.sig;
    if (!verifyDownloadSig(blobId, exp, sig)) {
      return res.status(401).json({ error: 'invalid_or_expired_signature' });
    }
    const r = await pool.query(
      `SELECT filename, content_type, data, external_url, driver, size_bytes
       FROM storage_blobs WHERE blob_id = $1 AND deleted_at IS NULL`,
      [blobId]
    ).catch(() => ({ rows: [] }));
    if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
    const row = r.rows[0];
    if (row.external_url && row.driver !== 'postgres') {
      return res.redirect(302, row.external_url);
    }
    res.setHeader('content-type', row.content_type || 'application/octet-stream');
    if (row.filename) {
      res.setHeader('content-disposition',
        `attachment; filename="${row.filename.replace(/"/g, '')}"`);
    }
    if (row.data) return res.send(row.data);
    return res.status(404).json({ error: 'data_missing' });
  });

  // POST /v1/agents/:did/storage/:blobId/url — generate fresh signed URL
  app.post('/v1/agents/:did/storage/:blobId/url', express.json(), async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });

    const r = await pool.query(
      `SELECT owner_did FROM storage_blobs WHERE blob_id=$1 AND deleted_at IS NULL`,
      [req.params.blobId]
    ).catch(() => ({ rows: [] }));
    if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
    if (r.rows[0].owner_did !== did) {
      const shareR = await pool.query(
        `SELECT 1 FROM storage_shares
         WHERE blob_id=$1 AND shared_with=$2 AND (expires_at IS NULL OR expires_at > NOW())`,
        [req.params.blobId, did]
      ).catch(() => ({ rows: [] }));
      if (!shareR.rows[0]) return res.status(403).json({ error: 'forbidden' });
    }

    const ttl = Math.min(parseInt((req.body || {}).expires_in || DEFAULT_URL_TTL_SEC), 86400);
    const signed = signDownloadUrl(req.params.blobId, ttl);
    return res.json({ download_url: signed.url, expires_at: signed.exp });
  });

  // POST /v1/agents/:did/storage/:blobId/share
  const ShareSchema = z.object({
    shared_with: z.string().min(3),
    can_write: z.boolean().optional().default(false),
    expires_at: z.string().datetime().optional()
  });
  app.post('/v1/agents/:did/storage/:blobId/share', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const parse = ShareSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;

      const r = await pool.query(
        `SELECT owner_did FROM storage_blobs WHERE blob_id=$1 AND deleted_at IS NULL`,
        [req.params.blobId]
      ).catch(() => ({ rows: [] }));
      if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
      if (r.rows[0].owner_did !== did) return res.status(403).json({ error: 'forbidden' });

      await pool.query(
        `INSERT INTO storage_shares (blob_id, shared_with, can_write, expires_at)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (blob_id, shared_with) DO UPDATE
         SET can_write = EXCLUDED.can_write, expires_at = EXCLUDED.expires_at`,
        [req.params.blobId, d.shared_with, d.can_write, d.expires_at || null]
      );

      await auditChain.append({
        event_type: 'storage.blob_shared',
        blob_id: req.params.blobId,
        owner_did: did,
        shared_with: d.shared_with,
        can_write: d.can_write,
        timestamp: new Date().toISOString()
      });

      return res.json({
        blob_id: req.params.blobId,
        shared_with: d.shared_with,
        can_write: d.can_write,
        expires_at: d.expires_at || null
      });
    } catch (e) {
      console.error('[storage.share]', e);
      return res.status(500).json({ error: 'share_failed', message: e.message });
    }
  });

  // DELETE /v1/agents/:did/storage/:blobId
  app.delete('/v1/agents/:did/storage/:blobId', async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const r = await pool.query(
        `UPDATE storage_blobs SET deleted_at = NOW(), data = NULL
         WHERE blob_id = $1 AND owner_did = $2 AND deleted_at IS NULL
         RETURNING blob_id`,
        [req.params.blobId, did]
      ).catch(() => ({ rows: [] }));
      if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });

      await auditChain.append({
        event_type: 'storage.blob_deleted',
        blob_id: req.params.blobId,
        owner_did: did,
        timestamp: new Date().toISOString()
      });
      return res.json({ blob_id: req.params.blobId, deleted: true });
    } catch (e) {
      console.error('[storage.delete]', e);
      return res.status(500).json({ error: 'delete_failed', message: e.message });
    }
  });
}

module.exports = {
  migrate,
  registerStorageRoutes,
  signDownloadUrl,
  verifyDownloadSig,
  QUOTA_BYTES,
  MAX_BLOB_BYTES,
  DRIVER
};
