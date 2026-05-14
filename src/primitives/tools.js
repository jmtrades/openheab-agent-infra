// ============================================================================
// OpenHeab Tools — Tool/MCP registry with curated + community tiers
// Tables: tools, tool_versions, tool_installs, tool_health_log
// Cron: /v1/_jobs/tool-health-sweep — pings curated tools, updates health_status
// ============================================================================
const cryptoLib = require('crypto');
const express = require('express');
const { z } = require('zod');

const TOOL_KINDS = ['http', 'mcp', 'inline', 'wasm'];
const TIERS = ['curated', 'community'];
const HEALTH_STATES = ['ok', 'degraded', 'down', 'unknown'];
const HEALTH_TIMEOUT_MS = parseInt(process.env.TOOL_HEALTH_TIMEOUT_MS || '5000');

// ----------------------------------------------------------------------------
// Migration
// ----------------------------------------------------------------------------
async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tools (
      slug             TEXT PRIMARY KEY,
      name             TEXT NOT NULL,
      description      TEXT,
      category         TEXT,
      kind             TEXT NOT NULL DEFAULT 'http',
      tier             TEXT NOT NULL DEFAULT 'community',
      publisher_did    TEXT,
      homepage_url     TEXT,
      source_url       TEXT,
      latest_version   TEXT,
      install_count    BIGINT NOT NULL DEFAULT 0,
      health_status    TEXT NOT NULL DEFAULT 'unknown',
      last_health_at   TIMESTAMPTZ,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_tools_category ON tools (category);
    CREATE INDEX IF NOT EXISTS idx_tools_tier ON tools (tier);
    CREATE INDEX IF NOT EXISTS idx_tools_publisher ON tools (publisher_did);

    CREATE TABLE IF NOT EXISTS tool_versions (
      slug           TEXT NOT NULL,
      version        TEXT NOT NULL,
      manifest       JSONB,
      mcp_endpoint   TEXT,
      http_endpoint  TEXT,
      checksum       TEXT,
      changelog      TEXT,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (slug, version)
    );

    CREATE TABLE IF NOT EXISTS tool_installs (
      agent_did    TEXT NOT NULL,
      slug         TEXT NOT NULL,
      version      TEXT,
      pinned       BOOLEAN NOT NULL DEFAULT FALSE,
      installed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (agent_did, slug)
    );
    CREATE INDEX IF NOT EXISTS idx_tool_installs_slug ON tool_installs (slug);

    CREATE TABLE IF NOT EXISTS tool_health_log (
      log_id       BIGSERIAL PRIMARY KEY,
      slug         TEXT NOT NULL,
      status       TEXT NOT NULL,
      latency_ms   INTEGER,
      http_status  INTEGER,
      error        TEXT,
      checked_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_tool_health_log_slug ON tool_health_log (slug, checked_at DESC);
  `);
}

// ----------------------------------------------------------------------------
// Health pinging
// ----------------------------------------------------------------------------
async function pingTool(pool, slug) {
  const toolR = await pool.query(
    `SELECT t.slug, t.latest_version, t.kind, v.http_endpoint, v.mcp_endpoint, t.homepage_url
     FROM tools t
     LEFT JOIN tool_versions v ON v.slug = t.slug AND v.version = t.latest_version
     WHERE t.slug = $1`, [slug]
  ).catch(() => ({ rows: [] }));
  if (!toolR.rows[0]) return { slug, status: 'unknown', error: 'tool_not_found' };
  const row = toolR.rows[0];
  const target = row.http_endpoint || row.mcp_endpoint || row.homepage_url;
  if (!target) {
    await pool.query(
      `UPDATE tools SET health_status='unknown', last_health_at=NOW() WHERE slug=$1`, [slug]
    ).catch(() => {});
    return { slug, status: 'unknown', error: 'no_endpoint' };
  }

  if (typeof fetch !== 'function') {
    return { slug, status: 'unknown', error: 'fetch_unavailable' };
  }

  const start = Date.now();
  let status = 'unknown', httpStatus = null, err = null;

  async function tryFetch(method) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), HEALTH_TIMEOUT_MS);
    try {
      const r = await fetch(target, { method, signal: ctl.signal });
      return r;
    } finally { clearTimeout(t); }
  }

  try {
    let r;
    try { r = await tryFetch('HEAD'); }
    catch { r = await tryFetch('GET'); }
    httpStatus = r.status;
    if (r.status >= 200 && r.status < 400) status = 'ok';
    else if (r.status >= 400 && r.status < 500) status = 'degraded';
    else status = 'down';
  } catch (e) {
    status = 'down';
    err = e.message || String(e);
  }
  const latency = Date.now() - start;

  await pool.query(
    `INSERT INTO tool_health_log (slug, status, latency_ms, http_status, error)
     VALUES ($1,$2,$3,$4,$5)`,
    [slug, status, latency, httpStatus, err]
  ).catch(() => {});
  await pool.query(
    `UPDATE tools SET health_status=$1, last_health_at=NOW(), updated_at=NOW() WHERE slug=$2`,
    [status, slug]
  ).catch(() => {});

  return { slug, status, latency_ms: latency, http_status: httpStatus, error: err };
}

async function tickHealth(pool) {
  const r = await pool.query(
    `SELECT slug FROM tools WHERE tier='curated' ORDER BY last_health_at NULLS FIRST LIMIT 50`
  ).catch(() => ({ rows: [] }));
  const results = [];
  for (const row of r.rows) {
    try { results.push(await pingTool(pool, row.slug)); }
    catch (e) { results.push({ slug: row.slug, status: 'down', error: e.message }); }
  }
  return { checked: results.length, results };
}

// ----------------------------------------------------------------------------
// Routes
// ----------------------------------------------------------------------------
function registerToolsRoutes(app, pool, verifyAgentAuth, auditChain) {
  // POST /v1/tools
  const CreateSchema = z.object({
    slug: z.string().min(2).max(128).regex(/^[a-z0-9._-]+$/),
    name: z.string().min(1).max(256),
    description: z.string().max(4096).optional(),
    category: z.string().max(64).optional(),
    kind: z.enum(TOOL_KINDS).optional().default('http'),
    publisher_did: z.string().optional(),
    homepage_url: z.string().url().optional(),
    source_url: z.string().url().optional()
  });

  app.post('/v1/tools', express.json(), async (req, res) => {
    try {
      const parse = CreateSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;

      const adminToken = req.headers['x-admin-token'];
      const isAdmin = adminToken && process.env.OPERATOR_ADMIN_TOKEN && adminToken === process.env.OPERATOR_ADMIN_TOKEN;
      const tier = isAdmin ? 'curated' : 'community';

      let publisherDid = d.publisher_did || null;
      if (!isAdmin) {
        const auth = await verifyAgentAuth(req, publisherDid || null);
        if (!auth.valid) return res.status(401).json({ error: auth.error });
        publisherDid = auth.subject;
      }

      try {
        await pool.query(
          `INSERT INTO tools (slug, name, description, category, kind, tier,
                              publisher_did, homepage_url, source_url)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [d.slug, d.name, d.description || null, d.category || null,
           d.kind, tier, publisherDid, d.homepage_url || null, d.source_url || null]
        );
      } catch (e) {
        if (e.code === '23505') return res.status(409).json({ error: 'slug_exists' });
        throw e;
      }

      await auditChain.append({
        event_type: 'tools.published',
        slug: d.slug, tier, publisher_did: publisherDid,
        timestamp: new Date().toISOString()
      });

      return res.status(201).json({
        slug: d.slug, name: d.name, tier, kind: d.kind,
        publisher_did: publisherDid, category: d.category || null
      });
    } catch (e) {
      console.error('[tools.create]', e);
      return res.status(500).json({ error: 'create_failed', message: e.message });
    }
  });

  // GET /v1/tools — filter q/category/tier
  app.get('/v1/tools', async (req, res) => {
    const q = req.query.q;
    const category = req.query.category;
    const tier = req.query.tier;
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const offset = Math.max(parseInt(req.query.offset) || 0, 0);

    const params = [];
    const where = [];
    if (q) { params.push(`%${q}%`); where.push(`(name ILIKE $${params.length} OR description ILIKE $${params.length} OR slug ILIKE $${params.length})`); }
    if (category) { params.push(category); where.push(`category = $${params.length}`); }
    if (tier) { params.push(tier); where.push(`tier = $${params.length}`); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    params.push(limit); const limIdx = params.length;
    params.push(offset); const offIdx = params.length;

    const r = await pool.query(
      `SELECT slug, name, description, category, kind, tier, publisher_did,
              homepage_url, latest_version, install_count, health_status, last_health_at
       FROM tools ${whereSql}
       ORDER BY tier='curated' DESC, install_count DESC, slug ASC
       LIMIT $${limIdx} OFFSET $${offIdx}`,
      params
    ).catch(() => ({ rows: [] }));
    return res.json({ tools: r.rows, count: r.rows.length });
  });

  // GET /v1/tools/:slug
  app.get('/v1/tools/:slug', async (req, res) => {
    const r = await pool.query(
      `SELECT * FROM tools WHERE slug = $1`, [req.params.slug]
    ).catch(() => ({ rows: [] }));
    if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });

    const vR = await pool.query(
      `SELECT version, mcp_endpoint, http_endpoint, checksum, changelog, created_at
       FROM tool_versions WHERE slug = $1 ORDER BY created_at DESC LIMIT 50`,
      [req.params.slug]
    ).catch(() => ({ rows: [] }));

    return res.json({ ...r.rows[0], versions: vR.rows });
  });

  // POST /v1/tools/:slug/versions — publisher only
  const VersionSchema = z.object({
    version: z.string().min(1).max(64),
    manifest: z.any().optional(),
    mcp_endpoint: z.string().url().optional(),
    http_endpoint: z.string().url().optional(),
    checksum: z.string().optional(),
    changelog: z.string().optional()
  });
  app.post('/v1/tools/:slug/versions', express.json(), async (req, res) => {
    try {
      const parse = VersionSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;

      const t = await pool.query(
        `SELECT publisher_did FROM tools WHERE slug = $1`, [req.params.slug]
      ).catch(() => ({ rows: [] }));
      if (!t.rows[0]) return res.status(404).json({ error: 'tool_not_found' });

      const adminToken = req.headers['x-admin-token'];
      const isAdmin = adminToken && process.env.OPERATOR_ADMIN_TOKEN && adminToken === process.env.OPERATOR_ADMIN_TOKEN;
      if (!isAdmin) {
        const auth = await verifyAgentAuth(req, t.rows[0].publisher_did || null);
        if (!auth.valid) return res.status(401).json({ error: auth.error });
        if (auth.subject !== t.rows[0].publisher_did) return res.status(403).json({ error: 'not_publisher' });
      }

      try {
        await pool.query(
          `INSERT INTO tool_versions (slug, version, manifest, mcp_endpoint,
                                       http_endpoint, checksum, changelog)
           VALUES ($1,$2,$3::jsonb,$4,$5,$6,$7)`,
          [req.params.slug, d.version,
           d.manifest ? JSON.stringify(d.manifest) : null,
           d.mcp_endpoint || null, d.http_endpoint || null,
           d.checksum || null, d.changelog || null]
        );
      } catch (e) {
        if (e.code === '23505') return res.status(409).json({ error: 'version_exists' });
        throw e;
      }

      await pool.query(
        `UPDATE tools SET latest_version = $1, updated_at = NOW() WHERE slug = $2`,
        [d.version, req.params.slug]
      ).catch(() => {});

      await auditChain.append({
        event_type: 'tools.version_published',
        slug: req.params.slug, version: d.version,
        timestamp: new Date().toISOString()
      });

      return res.status(201).json({ slug: req.params.slug, version: d.version });
    } catch (e) {
      console.error('[tools.version.create]', e);
      return res.status(500).json({ error: 'version_create_failed', message: e.message });
    }
  });

  // GET /v1/tools/:slug/versions
  app.get('/v1/tools/:slug/versions', async (req, res) => {
    const r = await pool.query(
      `SELECT version, manifest, mcp_endpoint, http_endpoint, checksum, changelog, created_at
       FROM tool_versions WHERE slug = $1 ORDER BY created_at DESC`,
      [req.params.slug]
    ).catch(() => ({ rows: [] }));
    return res.json({ slug: req.params.slug, versions: r.rows, count: r.rows.length });
  });

  // POST /v1/tools/:slug/install
  const InstallSchema = z.object({
    agent_did: z.string().min(3),
    version: z.string().optional(),
    pinned: z.boolean().optional().default(false)
  });
  app.post('/v1/tools/:slug/install', express.json(), async (req, res) => {
    try {
      const parse = InstallSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;

      const auth = await verifyAgentAuth(req, d.agent_did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const t = await pool.query(
        `SELECT latest_version FROM tools WHERE slug = $1`, [req.params.slug]
      ).catch(() => ({ rows: [] }));
      if (!t.rows[0]) return res.status(404).json({ error: 'tool_not_found' });
      const version = d.version || t.rows[0].latest_version || null;

      await pool.query(
        `INSERT INTO tool_installs (agent_did, slug, version, pinned)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (agent_did, slug) DO UPDATE
         SET version = EXCLUDED.version, pinned = EXCLUDED.pinned`,
        [d.agent_did, req.params.slug, version, d.pinned]
      );
      await pool.query(
        `UPDATE tools SET install_count = install_count + 1, updated_at = NOW() WHERE slug = $1`,
        [req.params.slug]
      ).catch(() => {});

      await auditChain.append({
        event_type: 'tools.installed',
        slug: req.params.slug, agent_did: d.agent_did, version,
        timestamp: new Date().toISOString()
      });

      return res.json({ slug: req.params.slug, agent_did: d.agent_did, version, pinned: d.pinned });
    } catch (e) {
      console.error('[tools.install]', e);
      return res.status(500).json({ error: 'install_failed', message: e.message });
    }
  });

  // GET /v1/agents/:did/tools — list installed
  app.get('/v1/agents/:did/tools', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });

    const r = await pool.query(
      `SELECT i.slug, i.version, i.pinned, i.installed_at,
              t.name, t.description, t.kind, t.tier, t.health_status, t.latest_version
       FROM tool_installs i
       LEFT JOIN tools t ON t.slug = i.slug
       WHERE i.agent_did = $1
       ORDER BY i.installed_at DESC`,
      [did]
    ).catch(() => ({ rows: [] }));
    return res.json({ tools: r.rows, count: r.rows.length });
  });

  // POST /v1/tools/:slug/health — ad-hoc ping
  app.post('/v1/tools/:slug/health', express.json(), async (req, res) => {
    try {
      const out = await pingTool(pool, req.params.slug);
      return res.json(out);
    } catch (e) {
      return res.status(500).json({ error: 'health_check_failed', message: e.message });
    }
  });

  // Cron job
  const { registerCron } = require('../cron_auth');
  registerCron(app, '/v1/_jobs/tool-health-sweep', async (req, res) => {
    try {
      const out = await tickHealth(pool);
      return res.json(out);
    } catch (e) {
      return res.status(500).json({ error: 'sweep_failed', message: e.message });
    }
  });
}

module.exports = {
  migrate,
  registerToolsRoutes,
  pingTool,
  tickHealth,
  TOOL_KINDS,
  TIERS,
  HEALTH_STATES
};
