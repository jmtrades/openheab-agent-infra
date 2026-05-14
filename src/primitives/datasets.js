// ============================================================================
// OpenHeab Datasets — Dataset marketplace with 70/30 publisher/platform split
// ============================================================================
const express = require('express');
const cryptoLib = require('crypto');
const { z } = require('zod');

const CATEGORIES = [
  'text', 'code', 'images', 'audio', 'video', 'tabular', 'sensor', 'graph',
  'finance', 'medical', 'scientific', 'legal', 'commerce', 'social',
  'agent-traces', 'synthetic', 'benchmark', 'other'
];

const PUBLISHER_BPS = 7000;
const PLATFORM_BPS = 3000;

// ----------------------------------------------------------------------------
// Migration
// ----------------------------------------------------------------------------
async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS datasets (
      slug             TEXT PRIMARY KEY,
      title            TEXT NOT NULL,
      description      TEXT,
      category         TEXT NOT NULL,
      publisher_did    TEXT NOT NULL,
      pricing_model    TEXT NOT NULL DEFAULT 'one_time',
      price_cents      INTEGER NOT NULL DEFAULT 0,
      per_row_cents    INTEGER NOT NULL DEFAULT 0,
      license_type     TEXT NOT NULL DEFAULT 'commercial',
      row_count        BIGINT NOT NULL DEFAULT 0,
      bytes            BIGINT NOT NULL DEFAULT 0,
      format           TEXT,
      manifest_url     TEXT,
      sample_rows      JSONB,
      tags             TEXT[] NOT NULL DEFAULT '{}',
      latest_version   INTEGER NOT NULL DEFAULT 1,
      total_licenses   BIGINT NOT NULL DEFAULT 0,
      revenue_cents    BIGINT NOT NULL DEFAULT 0,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_datasets_category ON datasets (category);
    CREATE INDEX IF NOT EXISTS idx_datasets_publisher ON datasets (publisher_did);
    CREATE INDEX IF NOT EXISTS idx_datasets_license ON datasets (license_type);

    CREATE TABLE IF NOT EXISTS dataset_versions (
      slug          TEXT NOT NULL,
      version       INTEGER NOT NULL,
      manifest_url  TEXT,
      checksum      TEXT,
      row_count     BIGINT,
      bytes         BIGINT,
      changelog     TEXT,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (slug, version)
    );

    CREATE TABLE IF NOT EXISTS dataset_licenses (
      license_id        TEXT PRIMARY KEY,
      slug              TEXT NOT NULL,
      version           INTEGER NOT NULL,
      licensee_did      TEXT NOT NULL,
      publisher_did     TEXT NOT NULL,
      pricing_model     TEXT NOT NULL,
      price_paid_cents  INTEGER NOT NULL DEFAULT 0,
      publisher_cents   INTEGER NOT NULL DEFAULT 0,
      platform_cents    INTEGER NOT NULL DEFAULT 0,
      rows_consumed     BIGINT NOT NULL DEFAULT 0,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_dataset_licenses_slug ON dataset_licenses (slug);
    CREATE INDEX IF NOT EXISTS idx_dataset_licenses_licensee ON dataset_licenses (licensee_did);
  `).catch(() => {});
}

function genId(prefix) {
  return `${prefix}_${cryptoLib.randomBytes(12).toString('hex')}`;
}

async function tryRecordCost(pool, callerDid, amountCents, label) {
  try {
    const cost = require('./cost');
    if (cost && typeof cost.recordCost === 'function') {
      await cost.recordCost(pool, callerDid, amountCents, label);
    }
  } catch {}
}

// ----------------------------------------------------------------------------
// Routes
// ----------------------------------------------------------------------------
function registerDatasetsRoutes(app, pool, verifyAgentAuth, auditChain) {
  // POST /v1/datasets
  const CreateSchema = z.object({
    slug: z.string().min(1).max(120).regex(/^[a-z0-9][a-z0-9-]*$/),
    title: z.string().min(1).max(200),
    description: z.string().max(8000).optional(),
    category: z.enum(CATEGORIES),
    publisher_did: z.string(),
    pricing_model: z.enum(['one_time', 'per_row']).default('one_time'),
    price_cents: z.number().int().nonnegative().default(0),
    per_row_cents: z.number().int().nonnegative().default(0),
    license_type: z.enum(['commercial', 'research', 'open']).default('commercial'),
    row_count: z.number().int().nonnegative().optional(),
    bytes: z.number().int().nonnegative().optional(),
    format: z.string().max(40).optional(),
    manifest_url: z.string().url().optional(),
    sample_rows: z.any().optional(),
    tags: z.array(z.string()).max(20).optional()
  });

  app.post('/v1/datasets', express.json({ limit: '5mb' }), async (req, res) => {
    try {
      const parse = CreateSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;
      const auth = await verifyAgentAuth(req, d.publisher_did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const exists = await pool.query(`SELECT slug FROM datasets WHERE slug=$1`, [d.slug])
        .catch(() => ({ rows: [] }));
      if (exists.rows[0]) return res.status(409).json({ error: 'slug_taken' });

      await pool.query(
        `INSERT INTO datasets (slug, title, description, category, publisher_did,
           pricing_model, price_cents, per_row_cents, license_type,
           row_count, bytes, format, manifest_url, sample_rows, tags, latest_version)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15,1)`,
        [d.slug, d.title, d.description || null, d.category, d.publisher_did,
         d.pricing_model, d.price_cents, d.per_row_cents, d.license_type,
         d.row_count || 0, d.bytes || 0, d.format || null,
         d.manifest_url || null,
         d.sample_rows ? JSON.stringify(d.sample_rows) : null,
         d.tags || []]
      );
      await pool.query(
        `INSERT INTO dataset_versions (slug, version, manifest_url, row_count, bytes)
         VALUES ($1,1,$2,$3,$4)`,
        [d.slug, d.manifest_url || null, d.row_count || 0, d.bytes || 0]
      );

      await auditChain.append({
        event_type: 'datasets.created',
        slug: d.slug, publisher_did: d.publisher_did, category: d.category,
        timestamp: new Date().toISOString()
      });

      return res.status(201).json({
        slug: d.slug, title: d.title, version: 1, license_type: d.license_type
      });
    } catch (e) {
      console.error('[datasets.create]', e);
      return res.status(500).json({ error: 'create_failed', message: e.message });
    }
  });

  // GET /v1/datasets
  app.get('/v1/datasets', async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const offset = Math.max(parseInt(req.query.offset) || 0, 0);
    const category = req.query.category;
    const licenseType = req.query.license_type;
    const q = req.query.q;

    const params = [limit, offset];
    const where = [];
    if (category) { params.push(category); where.push(`category=$${params.length}`); }
    if (licenseType) { params.push(licenseType); where.push(`license_type=$${params.length}`); }
    if (q) { params.push(`%${q}%`); where.push(`(title ILIKE $${params.length} OR description ILIKE $${params.length})`); }
    const sql = `SELECT slug, title, description, category, publisher_did, pricing_model,
                        price_cents, per_row_cents, license_type, row_count, bytes,
                        format, latest_version, total_licenses, created_at
                 FROM datasets ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                 ORDER BY total_licenses DESC LIMIT $1 OFFSET $2`;
    const r = await pool.query(sql, params).catch(() => ({ rows: [] }));
    return res.json({ datasets: r.rows, count: r.rows.length });
  });

  // GET /v1/datasets/:slug
  app.get('/v1/datasets/:slug', async (req, res) => {
    const r = await pool.query(`SELECT * FROM datasets WHERE slug=$1`, [req.params.slug])
      .catch(() => ({ rows: [] }));
    if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
    const versions = await pool.query(
      `SELECT version, manifest_url, checksum, row_count, bytes, changelog, created_at
       FROM dataset_versions WHERE slug=$1 ORDER BY version DESC`, [req.params.slug]
    ).catch(() => ({ rows: [] }));
    return res.json({ ...r.rows[0], versions: versions.rows });
  });

  // POST /v1/datasets/:slug/versions
  const VersionSchema = z.object({
    manifest_url: z.string().url().optional(),
    checksum: z.string().optional(),
    row_count: z.number().int().nonnegative().optional(),
    bytes: z.number().int().nonnegative().optional(),
    changelog: z.string().max(8000).optional()
  });

  app.post('/v1/datasets/:slug/versions', express.json(), async (req, res) => {
    try {
      const slug = req.params.slug;
      const dr = await pool.query(
        `SELECT publisher_did, latest_version FROM datasets WHERE slug=$1`, [slug]
      ).catch(() => ({ rows: [] }));
      if (!dr.rows[0]) return res.status(404).json({ error: 'not_found' });
      const auth = await verifyAgentAuth(req, dr.rows[0].publisher_did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const parse = VersionSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;
      const nextV = (dr.rows[0].latest_version || 0) + 1;

      await pool.query(
        `INSERT INTO dataset_versions (slug, version, manifest_url, checksum,
           row_count, bytes, changelog)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [slug, nextV, d.manifest_url || null, d.checksum || null,
         d.row_count || 0, d.bytes || 0, d.changelog || null]
      );
      await pool.query(
        `UPDATE datasets SET latest_version=$1, updated_at=NOW(),
           manifest_url = COALESCE($2, manifest_url),
           row_count = COALESCE($3, row_count),
           bytes = COALESCE($4, bytes)
         WHERE slug=$5`,
        [nextV, d.manifest_url || null, d.row_count || null, d.bytes || null, slug]
      );

      await auditChain.append({
        event_type: 'datasets.version_published',
        slug, version: nextV, timestamp: new Date().toISOString()
      });

      return res.status(201).json({ slug, version: nextV });
    } catch (e) {
      console.error('[datasets.version]', e);
      return res.status(500).json({ error: 'version_failed', message: e.message });
    }
  });

  // POST /v1/datasets/:slug/license — buy access
  const LicenseSchema = z.object({
    licensee_did: z.string(),
    version: z.number().int().positive().optional(),
    rows: z.number().int().positive().optional()
  });

  app.post('/v1/datasets/:slug/license', express.json(), async (req, res) => {
    try {
      const slug = req.params.slug;
      const parse = LicenseSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;
      const auth = await verifyAgentAuth(req, d.licensee_did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const dr = await pool.query(
        `SELECT publisher_did, pricing_model, price_cents, per_row_cents, latest_version, manifest_url
         FROM datasets WHERE slug=$1`, [slug]
      ).catch(() => ({ rows: [] }));
      if (!dr.rows[0]) return res.status(404).json({ error: 'not_found' });
      const ds = dr.rows[0];
      const version = d.version || ds.latest_version;

      let priceCents = 0;
      let rowsConsumed = 0;
      if (ds.pricing_model === 'per_row') {
        const rows = d.rows || 0;
        if (!rows) return res.status(400).json({ error: 'rows_required_for_per_row_pricing' });
        priceCents = rows * (ds.per_row_cents || 0);
        rowsConsumed = rows;
      } else {
        priceCents = ds.price_cents || 0;
      }

      const publisherCents = Math.floor(priceCents * PUBLISHER_BPS / 10000);
      const platformCents = priceCents - publisherCents;
      const licenseId = genId('dlic');

      if (priceCents > 0) {
        await tryRecordCost(pool, d.licensee_did, priceCents, `dataset:${slug}@${version}`);
      }

      await pool.query(
        `INSERT INTO dataset_licenses (license_id, slug, version, licensee_did,
           publisher_did, pricing_model, price_paid_cents, publisher_cents,
           platform_cents, rows_consumed)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [licenseId, slug, version, d.licensee_did, ds.publisher_did,
         ds.pricing_model, priceCents, publisherCents, platformCents, rowsConsumed]
      );
      await pool.query(
        `UPDATE datasets SET
           total_licenses = total_licenses + 1,
           revenue_cents = revenue_cents + $1,
           updated_at = NOW()
         WHERE slug=$2`,
        [priceCents, slug]
      );

      await auditChain.append({
        event_type: 'datasets.licensed',
        license_id: licenseId, slug, version, licensee_did: d.licensee_did,
        publisher_did: ds.publisher_did, price_cents: priceCents,
        timestamp: new Date().toISOString()
      });

      return res.status(201).json({
        license_id: licenseId, slug, version,
        licensee_did: d.licensee_did, price_paid_cents: priceCents,
        publisher_cents: publisherCents, platform_cents: platformCents,
        manifest_url: ds.manifest_url
      });
    } catch (e) {
      console.error('[datasets.license]', e);
      return res.status(500).json({ error: 'license_failed', message: e.message });
    }
  });

  // GET /v1/agents/:did/datasets/licenses
  app.get('/v1/agents/:did/datasets/licenses', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(
      `SELECT license_id, slug, version, pricing_model, price_paid_cents,
              rows_consumed, created_at
       FROM dataset_licenses WHERE licensee_did=$1 ORDER BY created_at DESC LIMIT 200`,
      [did]
    ).catch(() => ({ rows: [] }));
    return res.json({ licenses: r.rows, count: r.rows.length });
  });

  // POST /v1/datasets/:slug/preview
  app.post('/v1/datasets/:slug/preview', express.json(), async (req, res) => {
    const r = await pool.query(
      `SELECT slug, title, sample_rows FROM datasets WHERE slug=$1`,
      [req.params.slug]
    ).catch(() => ({ rows: [] }));
    if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
    return res.json({
      slug: r.rows[0].slug, title: r.rows[0].title,
      sample_rows: r.rows[0].sample_rows || []
    });
  });
}

module.exports = {
  migrate,
  registerDatasetsRoutes,
  CATEGORIES,
  PUBLISHER_BPS,
  PLATFORM_BPS
};
