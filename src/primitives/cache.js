// ============================================================================
// OpenHeab Cache — Distributed Redis-like cache for agents
// Tables: cache_namespaces, cache_entries
// Eviction: LRU / LFU / TTL; cron expires keys + prunes when over cap
// ============================================================================
const cryptoLib = require('crypto');
const express = require('express');
const { z } = require('zod');

const EVICTION_POLICIES = ['lru', 'lfu', 'ttl'];

const MAX_VALUE_BYTES = parseInt(process.env.CACHE_MAX_VALUE_BYTES || String(1024 * 1024)); // 1MB
const DEFAULT_MAX_ENTRIES = parseInt(process.env.CACHE_DEFAULT_MAX_ENTRIES || '10000');
const DEFAULT_TTL_SECONDS = parseInt(process.env.CACHE_DEFAULT_TTL_SECONDS || '3600');

// ----------------------------------------------------------------------------
// Migration
// ----------------------------------------------------------------------------
async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cache_namespaces (
      namespace_id        TEXT PRIMARY KEY,
      owner_did           TEXT NOT NULL,
      name                TEXT NOT NULL,
      max_entries         INTEGER NOT NULL DEFAULT 10000,
      default_ttl_seconds INTEGER,
      eviction_policy     TEXT NOT NULL DEFAULT 'lru',
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (owner_did, name)
    );
    CREATE INDEX IF NOT EXISTS idx_cache_ns_owner ON cache_namespaces (owner_did);

    CREATE TABLE IF NOT EXISTS cache_entries (
      namespace_id      TEXT NOT NULL REFERENCES cache_namespaces(namespace_id) ON DELETE CASCADE,
      key               TEXT NOT NULL,
      value             BYTEA,
      expires_at        TIMESTAMPTZ,
      hits              BIGINT NOT NULL DEFAULT 0,
      last_accessed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      size_bytes        INTEGER NOT NULL DEFAULT 0,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (namespace_id, key)
    );
    CREATE INDEX IF NOT EXISTS idx_cache_entries_expires ON cache_entries (expires_at)
      WHERE expires_at IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_cache_entries_lru ON cache_entries (namespace_id, last_accessed_at);
  `);
}

function genNsId() { return 'cns_' + cryptoLib.randomBytes(12).toString('hex'); }

async function getNamespaceByName(pool, name) {
  const r = await pool.query(
    `SELECT * FROM cache_namespaces WHERE namespace_id = $1 OR name = $1 LIMIT 1`,
    [name]
  ).catch(() => ({ rows: [] }));
  return r.rows[0] || null;
}

async function evictIfNeeded(pool, ns) {
  const c = await pool.query(
    `SELECT COUNT(*)::INTEGER AS n FROM cache_entries WHERE namespace_id = $1`,
    [ns.namespace_id]
  ).catch(() => ({ rows: [{ n: 0 }] }));
  const count = c.rows[0].n;
  if (count <= ns.max_entries) return 0;

  const overflow = count - ns.max_entries;
  let orderClause = 'last_accessed_at ASC';
  if (ns.eviction_policy === 'lfu') orderClause = 'hits ASC, last_accessed_at ASC';
  if (ns.eviction_policy === 'ttl') orderClause = 'expires_at ASC NULLS LAST, last_accessed_at ASC';

  const r = await pool.query(
    `DELETE FROM cache_entries
     WHERE (namespace_id, key) IN (
       SELECT namespace_id, key FROM cache_entries
       WHERE namespace_id = $1 ORDER BY ${orderClause} LIMIT $2
     ) RETURNING key`,
    [ns.namespace_id, overflow]
  ).catch(() => ({ rows: [] }));
  return r.rows.length;
}

async function cacheEvict(pool) {
  const expired = await pool.query(
    `DELETE FROM cache_entries
     WHERE expires_at IS NOT NULL AND expires_at < NOW() RETURNING namespace_id`
  ).catch(() => ({ rows: [] }));

  const nsR = await pool.query(`SELECT * FROM cache_namespaces`).catch(() => ({ rows: [] }));
  let pruned = 0;
  for (const ns of nsR.rows) pruned += await evictIfNeeded(pool, ns);

  return {
    expired: expired.rows.length,
    lru_pruned: pruned,
    timestamp: new Date().toISOString()
  };
}

// ----------------------------------------------------------------------------
// Routes
// ----------------------------------------------------------------------------
function registerCacheRoutes(app, pool, verifyAgentAuth, auditChain) {
  // POST /v1/agents/:did/cache/namespaces — create
  const NsSchema = z.object({
    name: z.string().min(1).max(128).regex(/^[a-z0-9_-]+$/i),
    max_entries: z.number().int().min(10).max(10_000_000).optional().default(DEFAULT_MAX_ENTRIES),
    default_ttl_seconds: z.number().int().min(1).max(86400 * 365).optional(),
    eviction_policy: z.enum(EVICTION_POLICIES).optional().default('lru')
  });

  app.post('/v1/agents/:did/cache/namespaces', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const parse = NsSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;

      const nsId = genNsId();
      try {
        await pool.query(
          `INSERT INTO cache_namespaces
           (namespace_id, owner_did, name, max_entries, default_ttl_seconds, eviction_policy)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [nsId, did, d.name, d.max_entries, d.default_ttl_seconds || null, d.eviction_policy]
        );
      } catch (e) {
        if (e.code === '23505') return res.status(409).json({ error: 'namespace_exists' });
        throw e;
      }

      await auditChain.append({
        event_type: 'cache.namespace_created',
        namespace_id: nsId, owner_did: did, name: d.name,
        timestamp: new Date().toISOString()
      });

      return res.status(201).json({
        namespace_id: nsId, owner_did: did, name: d.name,
        max_entries: d.max_entries,
        default_ttl_seconds: d.default_ttl_seconds || null,
        eviction_policy: d.eviction_policy
      });
    } catch (e) {
      console.error('[cache.ns_create]', e);
      return res.status(500).json({ error: 'create_failed', message: e.message });
    }
  });

  // GET /v1/agents/:did/cache/namespaces
  app.get('/v1/agents/:did/cache/namespaces', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });

    const r = await pool.query(
      `SELECT namespace_id, name, max_entries, default_ttl_seconds, eviction_policy, created_at
       FROM cache_namespaces WHERE owner_did = $1 ORDER BY created_at DESC`,
      [did]
    ).catch(() => ({ rows: [] }));
    return res.json({ namespaces: r.rows, count: r.rows.length });
  });

  // PUT /v1/cache/:namespace/:key — set
  app.put('/v1/cache/:namespace/:key', express.json({ limit: '2mb' }), async (req, res) => {
    try {
      const ns = await getNamespaceByName(pool, req.params.namespace);
      if (!ns) return res.status(404).json({ error: 'namespace_not_found' });

      const auth = await verifyAgentAuth(req, ns.owner_did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const value = req.body?.value;
      const ttl = req.body?.ttl_seconds || ns.default_ttl_seconds || DEFAULT_TTL_SECONDS;
      if (value === undefined) return res.status(400).json({ error: 'value_required' });

      const buf = typeof value === 'string'
        ? Buffer.from(value)
        : Buffer.from(JSON.stringify(value));
      if (buf.length > MAX_VALUE_BYTES) {
        return res.status(413).json({ error: 'value_too_large', max_bytes: MAX_VALUE_BYTES });
      }

      const expiresAt = ttl ? new Date(Date.now() + ttl * 1000).toISOString() : null;

      await pool.query(
        `INSERT INTO cache_entries
         (namespace_id, key, value, expires_at, size_bytes, last_accessed_at)
         VALUES ($1,$2,$3,$4,$5,NOW())
         ON CONFLICT (namespace_id, key) DO UPDATE SET
           value = EXCLUDED.value,
           expires_at = EXCLUDED.expires_at,
           size_bytes = EXCLUDED.size_bytes,
           last_accessed_at = NOW()`,
        [ns.namespace_id, req.params.key, buf, expiresAt, buf.length]
      );

      await evictIfNeeded(pool, ns);

      return res.json({
        namespace: ns.name, key: req.params.key,
        size_bytes: buf.length, expires_at: expiresAt
      });
    } catch (e) {
      console.error('[cache.set]', e);
      return res.status(500).json({ error: 'set_failed', message: e.message });
    }
  });

  // GET /v1/cache/:namespace/:key — get
  app.get('/v1/cache/:namespace/:key', async (req, res) => {
    try {
      const ns = await getNamespaceByName(pool, req.params.namespace);
      if (!ns) return res.status(404).json({ error: 'namespace_not_found' });

      const auth = await verifyAgentAuth(req, ns.owner_did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const r = await pool.query(
        `SELECT value, expires_at, hits, size_bytes FROM cache_entries
         WHERE namespace_id = $1 AND key = $2`,
        [ns.namespace_id, req.params.key]
      ).catch(() => ({ rows: [] }));
      if (!r.rows[0]) return res.status(404).json({ error: 'key_not_found' });
      const e = r.rows[0];
      if (e.expires_at && new Date(e.expires_at) < new Date()) {
        await pool.query(
          `DELETE FROM cache_entries WHERE namespace_id = $1 AND key = $2`,
          [ns.namespace_id, req.params.key]
        ).catch(() => {});
        return res.status(404).json({ error: 'expired' });
      }

      await pool.query(
        `UPDATE cache_entries SET hits = hits + 1, last_accessed_at = NOW()
         WHERE namespace_id = $1 AND key = $2`,
        [ns.namespace_id, req.params.key]
      ).catch(() => {});

      const valueStr = e.value ? Buffer.from(e.value).toString('utf8') : null;
      let parsed = valueStr;
      try { parsed = JSON.parse(valueStr); } catch {}

      return res.json({
        namespace: ns.name, key: req.params.key,
        value: parsed, size_bytes: e.size_bytes,
        hits: parseInt(e.hits) + 1, expires_at: e.expires_at
      });
    } catch (e) {
      console.error('[cache.get]', e);
      return res.status(500).json({ error: 'get_failed', message: e.message });
    }
  });

  // DELETE /v1/cache/:namespace/:key
  app.delete('/v1/cache/:namespace/:key', async (req, res) => {
    try {
      const ns = await getNamespaceByName(pool, req.params.namespace);
      if (!ns) return res.status(404).json({ error: 'namespace_not_found' });

      const auth = await verifyAgentAuth(req, ns.owner_did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const r = await pool.query(
        `DELETE FROM cache_entries WHERE namespace_id = $1 AND key = $2 RETURNING key`,
        [ns.namespace_id, req.params.key]
      ).catch(() => ({ rows: [] }));
      return res.json({ namespace: ns.name, key: req.params.key, deleted: !!r.rows[0] });
    } catch (e) {
      console.error('[cache.del]', e);
      return res.status(500).json({ error: 'delete_failed', message: e.message });
    }
  });

  // POST /v1/cache/:namespace/mget
  const MgetSchema = z.object({ keys: z.array(z.string()).min(1).max(1000) });
  app.post('/v1/cache/:namespace/mget', express.json(), async (req, res) => {
    try {
      const ns = await getNamespaceByName(pool, req.params.namespace);
      if (!ns) return res.status(404).json({ error: 'namespace_not_found' });
      const auth = await verifyAgentAuth(req, ns.owner_did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const parse = MgetSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });

      const r = await pool.query(
        `SELECT key, value, expires_at FROM cache_entries
         WHERE namespace_id = $1 AND key = ANY($2::text[])
           AND (expires_at IS NULL OR expires_at > NOW())`,
        [ns.namespace_id, parse.data.keys]
      ).catch(() => ({ rows: [] }));

      const out = {};
      for (const row of r.rows) {
        const s = Buffer.from(row.value).toString('utf8');
        try { out[row.key] = JSON.parse(s); } catch { out[row.key] = s; }
      }
      if (r.rows.length) {
        await pool.query(
          `UPDATE cache_entries SET hits = hits + 1, last_accessed_at = NOW()
           WHERE namespace_id = $1 AND key = ANY($2::text[])`,
          [ns.namespace_id, r.rows.map(x => x.key)]
        ).catch(() => {});
      }
      return res.json({ namespace: ns.name, values: out, found: r.rows.length });
    } catch (e) {
      console.error('[cache.mget]', e);
      return res.status(500).json({ error: 'mget_failed', message: e.message });
    }
  });

  // POST /v1/cache/:namespace/mset
  const MsetSchema = z.object({
    entries: z.array(z.object({
      key: z.string().min(1),
      value: z.any(),
      ttl_seconds: z.number().int().min(1).max(86400 * 365).optional()
    })).min(1).max(1000)
  });
  app.post('/v1/cache/:namespace/mset', express.json({ limit: '4mb' }), async (req, res) => {
    try {
      const ns = await getNamespaceByName(pool, req.params.namespace);
      if (!ns) return res.status(404).json({ error: 'namespace_not_found' });
      const auth = await verifyAgentAuth(req, ns.owner_did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const parse = MsetSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });

      let written = 0;
      for (const ent of parse.data.entries) {
        const buf = typeof ent.value === 'string'
          ? Buffer.from(ent.value)
          : Buffer.from(JSON.stringify(ent.value));
        if (buf.length > MAX_VALUE_BYTES) continue;
        const ttl = ent.ttl_seconds || ns.default_ttl_seconds || DEFAULT_TTL_SECONDS;
        const expAt = ttl ? new Date(Date.now() + ttl * 1000).toISOString() : null;
        await pool.query(
          `INSERT INTO cache_entries (namespace_id, key, value, expires_at, size_bytes)
           VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (namespace_id, key) DO UPDATE SET
             value = EXCLUDED.value, expires_at = EXCLUDED.expires_at,
             size_bytes = EXCLUDED.size_bytes, last_accessed_at = NOW()`,
          [ns.namespace_id, ent.key, buf, expAt, buf.length]
        ).catch(() => {});
        written += 1;
      }

      await evictIfNeeded(pool, ns);
      return res.json({ namespace: ns.name, written });
    } catch (e) {
      console.error('[cache.mset]', e);
      return res.status(500).json({ error: 'mset_failed', message: e.message });
    }
  });

  // POST /v1/cache/:namespace/flush
  app.post('/v1/cache/:namespace/flush', express.json(), async (req, res) => {
    try {
      const ns = await getNamespaceByName(pool, req.params.namespace);
      if (!ns) return res.status(404).json({ error: 'namespace_not_found' });
      const auth = await verifyAgentAuth(req, ns.owner_did, { strictSignatureRequired: true });
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const r = await pool.query(
        `DELETE FROM cache_entries WHERE namespace_id = $1 RETURNING key`,
        [ns.namespace_id]
      ).catch(() => ({ rows: [] }));

      await auditChain.append({
        event_type: 'cache.flushed',
        namespace_id: ns.namespace_id, owner_did: ns.owner_did,
        flushed_count: r.rows.length, timestamp: new Date().toISOString()
      });
      return res.json({ namespace: ns.name, flushed: r.rows.length });
    } catch (e) {
      console.error('[cache.flush]', e);
      return res.status(500).json({ error: 'flush_failed', message: e.message });
    }
  });

  // GET /v1/agents/:did/cache/namespaces/:id/stats
  app.get('/v1/agents/:did/cache/namespaces/:id/stats', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });

    const nsR = await pool.query(
      `SELECT * FROM cache_namespaces WHERE namespace_id = $1 AND owner_did = $2`,
      [req.params.id, did]
    ).catch(() => ({ rows: [] }));
    if (!nsR.rows[0]) return res.status(404).json({ error: 'namespace_not_found' });

    const s = await pool.query(
      `SELECT COUNT(*)::INTEGER AS entries,
              COALESCE(SUM(size_bytes),0)::BIGINT AS bytes,
              COALESCE(SUM(hits),0)::BIGINT AS total_hits,
              MAX(last_accessed_at) AS last_accessed
       FROM cache_entries WHERE namespace_id = $1`,
      [req.params.id]
    ).catch(() => ({ rows: [{ entries: 0, bytes: 0, total_hits: 0 }] }));

    const stat = s.rows[0];
    const hitRate = stat.entries > 0
      ? Number(stat.total_hits) / (Number(stat.total_hits) + Number(stat.entries))
      : 0;

    return res.json({
      namespace_id: req.params.id,
      name: nsR.rows[0].name,
      entries: parseInt(stat.entries),
      bytes: parseInt(stat.bytes),
      total_hits: parseInt(stat.total_hits),
      hit_rate: hitRate,
      max_entries: nsR.rows[0].max_entries,
      eviction_policy: nsR.rows[0].eviction_policy,
      last_accessed: stat.last_accessed
    });
  });

  // Cron job: evict
  const { registerCron } = require('../cron_auth');
  registerCron(app, '/v1/_jobs/cache-evict', async (req, res) => {
    try {
      const out = await cacheEvict(pool);
      return res.json(out);
    } catch (e) {
      return res.status(500).json({ error: 'evict_failed', message: e.message });
    }
  });
}

module.exports = {
  migrate,
  registerCacheRoutes,
  cacheEvict,
  EVICTION_POLICIES
};
