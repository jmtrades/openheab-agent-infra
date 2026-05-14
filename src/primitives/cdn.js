// ============================================================================
// OpenHeab CDN — Content delivery for agent-served assets
// Tables: cdn_origins, cdn_assets, cdn_purges
// Cost: ~$0.01/GB bandwidth (configurable via CDN_COST_CENTS_PER_GB)
// ============================================================================
const cryptoLib = require('crypto');
const express = require('express');
const { z } = require('zod');

const STATUSES = ['active', 'paused'];
const PURGE_STATUSES = ['pending', 'complete'];

const COST_CENTS_PER_GB = parseFloat(process.env.CDN_COST_CENTS_PER_GB || '1');
const DEFAULT_MAX_AGE = parseInt(process.env.CDN_DEFAULT_MAX_AGE || '3600');
const MAX_CACHE_BYTES = parseInt(process.env.CDN_MAX_CACHE_BYTES || String(10 * 1024 * 1024)); // 10MB

// ----------------------------------------------------------------------------
// Migration
// ----------------------------------------------------------------------------
async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cdn_origins (
      origin_id    TEXT PRIMARY KEY,
      owner_did    TEXT NOT NULL,
      name         TEXT NOT NULL,
      source_url   TEXT NOT NULL,
      cache_rules  JSONB,
      regions      TEXT[],
      status       TEXT NOT NULL DEFAULT 'active',
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (owner_did, name)
    );
    CREATE INDEX IF NOT EXISTS idx_cdn_origins_owner ON cdn_origins (owner_did);

    CREATE TABLE IF NOT EXISTS cdn_assets (
      asset_id        TEXT PRIMARY KEY,
      origin_id       TEXT NOT NULL REFERENCES cdn_origins(origin_id) ON DELETE CASCADE,
      path            TEXT NOT NULL,
      content_type    TEXT,
      size_bytes      BIGINT NOT NULL DEFAULT 0,
      etag            TEXT,
      cached_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at      TIMESTAMPTZ,
      hit_count       BIGINT NOT NULL DEFAULT 0,
      origin_blob_id  TEXT,
      data            BYTEA,
      UNIQUE (origin_id, path)
    );
    CREATE INDEX IF NOT EXISTS idx_cdn_assets_origin ON cdn_assets (origin_id);
    CREATE INDEX IF NOT EXISTS idx_cdn_assets_expires ON cdn_assets (expires_at)
      WHERE expires_at IS NOT NULL;

    CREATE TABLE IF NOT EXISTS cdn_purges (
      purge_id      TEXT PRIMARY KEY,
      origin_id     TEXT NOT NULL REFERENCES cdn_origins(origin_id) ON DELETE CASCADE,
      paths         TEXT[] NOT NULL,
      status        TEXT NOT NULL DEFAULT 'pending',
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at  TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_cdn_purges_origin ON cdn_purges (origin_id, created_at DESC);
  `);
}

function genOriginId() { return 'cdo_' + cryptoLib.randomBytes(12).toString('hex'); }
function genAssetId() { return 'cda_' + cryptoLib.randomBytes(12).toString('hex'); }
function genPurgeId() { return 'cdp_' + cryptoLib.randomBytes(12).toString('hex'); }

function matchCacheRule(path, rules) {
  if (!Array.isArray(rules)) return DEFAULT_MAX_AGE;
  for (const r of rules) {
    if (!r || !r.pattern) continue;
    try {
      const re = new RegExp(r.pattern.replace(/\*/g, '.*'));
      if (re.test(path)) return r.max_age_seconds || DEFAULT_MAX_AGE;
    } catch {}
  }
  return DEFAULT_MAX_AGE;
}

async function fetchFromOrigin(sourceUrl, path) {
  try {
    const fetch = global.fetch || require('node-fetch');
    const url = sourceUrl.replace(/\/$/, '') + '/' + path.replace(/^\//, '');
    const r = await fetch(url);
    if (!r.ok) return null;
    const ct = r.headers.get('content-type') || 'application/octet-stream';
    const ab = await r.arrayBuffer();
    return { data: Buffer.from(ab), content_type: ct, size: ab.byteLength };
  } catch (e) {
    return null;
  }
}

// ----------------------------------------------------------------------------
// Routes
// ----------------------------------------------------------------------------
function registerCdnRoutes(app, pool, verifyAgentAuth, auditChain) {
  // POST /v1/agents/:did/cdn/origins — configure
  const OriginSchema = z.object({
    name: z.string().min(1).max(128).regex(/^[a-z0-9_-]+$/i),
    source_url: z.string().url().max(2048),
    cache_rules: z.array(z.object({
      pattern: z.string().max(512),
      max_age_seconds: z.number().int().min(0).max(86400 * 365)
    })).optional(),
    regions: z.array(z.string().max(64)).optional().default([])
  });

  app.post('/v1/agents/:did/cdn/origins', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const parse = OriginSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;

      const originId = genOriginId();
      try {
        await pool.query(
          `INSERT INTO cdn_origins
           (origin_id, owner_did, name, source_url, cache_rules, regions, status)
           VALUES ($1,$2,$3,$4,$5::jsonb,$6,'active')`,
          [originId, did, d.name, d.source_url,
           d.cache_rules ? JSON.stringify(d.cache_rules) : null,
           d.regions || []]
        );
      } catch (e) {
        if (e.code === '23505') return res.status(409).json({ error: 'name_exists' });
        throw e;
      }

      await auditChain.append({
        event_type: 'cdn.origin_configured',
        origin_id: originId, owner_did: did, name: d.name,
        source_url: d.source_url, timestamp: new Date().toISOString()
      });

      return res.status(201).json({
        origin_id: originId, owner_did: did, name: d.name,
        source_url: d.source_url, cache_rules: d.cache_rules || [],
        regions: d.regions || [], status: 'active'
      });
    } catch (e) {
      console.error('[cdn.origin_create]', e);
      return res.status(500).json({ error: 'create_failed', message: e.message });
    }
  });

  // GET /v1/agents/:did/cdn/origins
  app.get('/v1/agents/:did/cdn/origins', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });

    const r = await pool.query(
      `SELECT origin_id, name, source_url, cache_rules, regions, status, created_at
       FROM cdn_origins WHERE owner_did = $1 ORDER BY created_at DESC`,
      [did]
    ).catch(() => ({ rows: [] }));
    return res.json({ origins: r.rows, count: r.rows.length });
  });

  // POST /v1/agents/:did/cdn/origins/:id/purge
  const PurgeSchema = z.object({
    paths: z.array(z.string().max(2048)).min(1).max(1000)
  });

  app.post('/v1/agents/:did/cdn/origins/:id/purge', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const parse = PurgeSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;

      const own = await pool.query(
        `SELECT origin_id FROM cdn_origins WHERE origin_id = $1 AND owner_did = $2`,
        [req.params.id, did]
      ).catch(() => ({ rows: [] }));
      if (!own.rows[0]) return res.status(404).json({ error: 'origin_not_found' });

      const purgeId = genPurgeId();
      await pool.query(
        `INSERT INTO cdn_purges (purge_id, origin_id, paths, status)
         VALUES ($1,$2,$3,'pending')`,
        [purgeId, req.params.id, d.paths]
      );

      const deleted = await pool.query(
        `DELETE FROM cdn_assets WHERE origin_id = $1 AND path = ANY($2::text[])
         RETURNING asset_id`,
        [req.params.id, d.paths]
      ).catch(() => ({ rows: [] }));

      await pool.query(
        `UPDATE cdn_purges SET status = 'complete', completed_at = NOW()
         WHERE purge_id = $1`,
        [purgeId]
      ).catch(() => {});

      await auditChain.append({
        event_type: 'cdn.purged',
        purge_id: purgeId, origin_id: req.params.id, owner_did: did,
        paths: d.paths, purged_count: deleted.rows.length,
        timestamp: new Date().toISOString()
      });

      return res.json({
        purge_id: purgeId, origin_id: req.params.id,
        paths: d.paths, purged_count: deleted.rows.length,
        status: 'complete'
      });
    } catch (e) {
      console.error('[cdn.purge]', e);
      return res.status(500).json({ error: 'purge_failed', message: e.message });
    }
  });

  // GET /v1/cdn/:origin/* — serve cached or fetch
  app.get(/^\/v1\/cdn\/([^/]+)\/(.+)$/, async (req, res) => {
    try {
      const originRef = req.params[0];
      const path = req.params[1];

      const o = await pool.query(
        `SELECT * FROM cdn_origins
         WHERE (origin_id = $1 OR name = $1) AND status = 'active' LIMIT 1`,
        [originRef]
      ).catch(() => ({ rows: [] }));
      if (!o.rows[0]) return res.status(404).json({ error: 'origin_not_found' });
      const origin = o.rows[0];

      const cachedR = await pool.query(
        `SELECT * FROM cdn_assets
         WHERE origin_id = $1 AND path = $2
           AND (expires_at IS NULL OR expires_at > NOW())`,
        [origin.origin_id, path]
      ).catch(() => ({ rows: [] }));

      if (cachedR.rows[0]) {
        const a = cachedR.rows[0];
        await pool.query(
          `UPDATE cdn_assets SET hit_count = hit_count + 1 WHERE asset_id = $1`,
          [a.asset_id]
        ).catch(() => {});
        res.setHeader('content-type', a.content_type || 'application/octet-stream');
        res.setHeader('etag', a.etag || '');
        res.setHeader('x-cache', 'HIT');
        return res.send(a.data);
      }

      const fetched = await fetchFromOrigin(origin.source_url, path);
      if (!fetched) return res.status(502).json({ error: 'origin_fetch_failed' });

      const maxAge = matchCacheRule(path, origin.cache_rules);
      const etag = '"' + cryptoLib.createHash('sha256').update(fetched.data).digest('hex').slice(0, 32) + '"';
      const assetId = genAssetId();
      const expiresAt = new Date(Date.now() + maxAge * 1000).toISOString();

      if (fetched.size <= MAX_CACHE_BYTES) {
        await pool.query(
          `INSERT INTO cdn_assets
           (asset_id, origin_id, path, content_type, size_bytes, etag,
            cached_at, expires_at, data)
           VALUES ($1,$2,$3,$4,$5,$6,NOW(),$7,$8)
           ON CONFLICT (origin_id, path) DO UPDATE SET
             content_type = EXCLUDED.content_type,
             size_bytes = EXCLUDED.size_bytes,
             etag = EXCLUDED.etag,
             cached_at = NOW(),
             expires_at = EXCLUDED.expires_at,
             data = EXCLUDED.data,
             hit_count = cdn_assets.hit_count + 1`,
          [assetId, origin.origin_id, path, fetched.content_type,
           fetched.size, etag, expiresAt, fetched.data]
        ).catch(() => {});

        try {
          const cost = require('./cost');
          const cents = Math.max(1, Math.round((fetched.size / (1024 * 1024 * 1024)) * COST_CENTS_PER_GB * 100) / 100);
          await cost.recordCost(pool, {
            agent_did: origin.owner_did,
            resource_type: 'cdn_bandwidth',
            provider: 'cdn',
            amount_cents: cents,
            units: fetched.size,
            unit_type: 'byte',
            tags: { origin_id: origin.origin_id, path }
          });
        } catch {}
      }

      res.setHeader('content-type', fetched.content_type);
      res.setHeader('etag', etag);
      res.setHeader('cache-control', `public, max-age=${maxAge}`);
      res.setHeader('x-cache', 'MISS');
      return res.send(fetched.data);
    } catch (e) {
      console.error('[cdn.serve]', e);
      return res.status(500).json({ error: 'serve_failed', message: e.message });
    }
  });

  // GET /v1/agents/:did/cdn/origins/:id/stats
  app.get('/v1/agents/:did/cdn/origins/:id/stats', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });

    const own = await pool.query(
      `SELECT origin_id, name FROM cdn_origins WHERE origin_id = $1 AND owner_did = $2`,
      [req.params.id, did]
    ).catch(() => ({ rows: [] }));
    if (!own.rows[0]) return res.status(404).json({ error: 'origin_not_found' });

    const top = await pool.query(
      `SELECT path, content_type, size_bytes, hit_count, cached_at
       FROM cdn_assets WHERE origin_id = $1
       ORDER BY hit_count DESC LIMIT 20`,
      [req.params.id]
    ).catch(() => ({ rows: [] }));

    const totals = await pool.query(
      `SELECT COUNT(*)::INTEGER AS assets,
              COALESCE(SUM(size_bytes),0)::BIGINT AS bytes_cached,
              COALESCE(SUM(hit_count),0)::BIGINT AS total_hits,
              COALESCE(SUM(size_bytes * hit_count),0)::BIGINT AS bandwidth_bytes
       FROM cdn_assets WHERE origin_id = $1`,
      [req.params.id]
    ).catch(() => ({ rows: [{ assets: 0, bytes_cached: 0, total_hits: 0, bandwidth_bytes: 0 }] }));

    const t = totals.rows[0];
    const bandwidthGB = Number(t.bandwidth_bytes) / (1024 * 1024 * 1024);

    return res.json({
      origin_id: req.params.id,
      name: own.rows[0].name,
      assets: parseInt(t.assets),
      bytes_cached: parseInt(t.bytes_cached),
      total_hits: parseInt(t.total_hits),
      bandwidth_bytes: parseInt(t.bandwidth_bytes),
      bandwidth_gb: bandwidthGB,
      estimated_cost_cents: Math.round(bandwidthGB * COST_CENTS_PER_GB * 100) / 100,
      top_assets: top.rows
    });
  });
}

module.exports = {
  migrate,
  registerCdnRoutes,
  matchCacheRule,
  fetchFromOrigin,
  STATUSES,
  PURGE_STATUSES
};
