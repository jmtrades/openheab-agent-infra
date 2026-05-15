// ============================================================================
// public_directory.js — SEO-discoverable directory of agents, extensions,
// skills, prompts, datasets, services, APIs, voice agents, booking types.
// Drives organic acquisition.
// ============================================================================
const crypto = require('crypto');
const { z } = require('zod');
const { registerCron } = require('../cron_auth');

const KINDS = ['agent', 'extension', 'skill', 'prompt', 'dataset', 'service', 'api', 'voice_agent', 'booking_type'];

const DEFAULT_CATEGORIES = [
  ['agent.assistant',         'agent', 'Assistants'],
  ['agent.research',          'agent', 'Research agents'],
  ['agent.payments',          'agent', 'Payments agents'],
  ['agent.support',           'agent', 'Support agents'],
  ['agent.creative',          'agent', 'Creative agents'],
  ['extension.integration',   'extension', 'Integrations'],
  ['extension.compliance',    'extension', 'Compliance'],
  ['extension.commerce',      'extension', 'Commerce'],
  ['extension.devtools',      'extension', 'Dev tools'],
  ['skill.code',              'skill',    'Code skills'],
  ['skill.design',            'skill',    'Design skills'],
  ['skill.research',          'skill',    'Research skills'],
  ['prompt.copywriting',      'prompt',   'Copywriting'],
  ['prompt.analysis',         'prompt',   'Analysis'],
  ['prompt.coding',           'prompt',   'Coding'],
  ['dataset.text',            'dataset',  'Text datasets'],
  ['dataset.images',          'dataset',  'Image datasets'],
  ['service.consulting',      'service',  'Consulting'],
  ['service.implementation',  'service',  'Implementation'],
  ['api.payments',            'api',      'Payments APIs'],
  ['api.identity',            'api',      'Identity APIs'],
  ['voice_agent.outbound',    'voice_agent', 'Outbound calling'],
  ['voice_agent.inbound',     'voice_agent', 'Inbound IVR'],
  ['booking_type.consult',    'booking_type', '30-min consult'],
  ['booking_type.demo',       'booking_type', 'Product demo']
];

async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS directory_listings (
      listing_id        TEXT PRIMARY KEY,
      kind              TEXT NOT NULL,
      slug              TEXT UNIQUE NOT NULL,
      owner_did         TEXT NOT NULL,
      title             TEXT NOT NULL,
      description       TEXT,
      tagline           TEXT,
      cover_image_url   TEXT,
      tags              TEXT[],
      category          TEXT,
      price_model       TEXT DEFAULT 'free',
      price_cents       BIGINT,
      currency          TEXT DEFAULT 'usd',
      featured          BOOLEAN NOT NULL DEFAULT FALSE,
      status            TEXT NOT NULL DEFAULT 'published',
      view_count        BIGINT NOT NULL DEFAULT 0,
      install_count     BIGINT NOT NULL DEFAULT 0,
      rating_avg        REAL,
      rating_count      INTEGER,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_directory_listings_kind_status
      ON directory_listings (kind, status);
    CREATE INDEX IF NOT EXISTS idx_directory_listings_category
      ON directory_listings (category);

    CREATE TABLE IF NOT EXISTS directory_categories (
      category_id       TEXT PRIMARY KEY,
      code              TEXT UNIQUE NOT NULL,
      kind              TEXT NOT NULL,
      name              TEXT NOT NULL,
      description       TEXT,
      sort_order        INTEGER NOT NULL DEFAULT 0,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS directory_collections (
      collection_id     TEXT PRIMARY KEY,
      slug              TEXT UNIQUE NOT NULL,
      name              TEXT NOT NULL,
      description       TEXT,
      curator_did       TEXT,
      listing_ids       TEXT[],
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS directory_views (
      view_id           TEXT PRIMARY KEY,
      listing_id        TEXT NOT NULL,
      ip_hash           TEXT,
      occurred_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      referrer          TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_directory_views_listing
      ON directory_views (listing_id, occurred_at DESC);
  `);
  for (let i = 0; i < DEFAULT_CATEGORIES.length; i++) {
    const [code, kind, name] = DEFAULT_CATEGORIES[i];
    const id = 'cat_' + crypto.createHash('sha256').update(code).digest('hex').slice(0, 16);
    await pool.query(
      `INSERT INTO directory_categories (category_id, code, kind, name, sort_order)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT (code) DO NOTHING`,
      [id, code, kind, name, i]
    ).catch(() => {});
  }
}

function newId(p) { return p + '_' + crypto.randomBytes(10).toString('hex'); }
function isAdmin(req) {
  const t = req.headers['x-admin-token'];
  return t && t === process.env.OPERATOR_ADMIN_TOKEN;
}
function escapeXml(s) {
  return String(s == null ? '' : s).replace(/[<>&'"]/g, c => ({ '<':'&lt;', '>':'&gt;', '&':'&amp;', "'":'&apos;', '"':'&quot;' }[c]));
}

const listingSchema = z.object({
  kind: z.enum(KINDS),
  slug: z.string().regex(/^[a-z0-9][a-z0-9_-]{2,80}$/),
  title: z.string().min(1).max(200),
  description: z.string().max(5000).optional(),
  tagline: z.string().max(200).optional(),
  cover_image_url: z.string().url().optional(),
  tags: z.array(z.string()).optional(),
  category: z.string().optional(),
  price_model: z.enum(['free', 'one_time', 'subscription', 'per_use']).optional(),
  price_cents: z.number().int().min(0).optional(),
  currency: z.string().optional()
});

async function publishListing({ pool, owner_did, ...data }) {
  const id = newId('lst');
  await pool.query(
    `INSERT INTO directory_listings
       (listing_id, kind, slug, owner_did, title, description, tagline,
        cover_image_url, tags, category, price_model, price_cents, currency, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'published')
     ON CONFLICT (slug) DO UPDATE SET
       title = EXCLUDED.title, description = EXCLUDED.description,
       tagline = EXCLUDED.tagline, cover_image_url = EXCLUDED.cover_image_url,
       tags = EXCLUDED.tags, category = EXCLUDED.category,
       price_model = EXCLUDED.price_model, price_cents = EXCLUDED.price_cents,
       currency = EXCLUDED.currency, updated_at = NOW()
     RETURNING listing_id`,
    [id, data.kind, data.slug, owner_did, data.title, data.description || null,
     data.tagline || null, data.cover_image_url || null, data.tags || null,
     data.category || null, data.price_model || 'free', data.price_cents || null,
     data.currency || 'usd']
  );
  return { listing_id: id, slug: data.slug };
}

function registerPublicDirectoryRoutes(app, pool, verifyAgentAuth, auditChain) {
  const express = require('express');

  app.post('/v1/agents/:did/directory/listings', express.json(), async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const p = listingSchema.safeParse(req.body || {});
    if (!p.success) return res.status(400).json({ error: 'invalid_input', details: p.error.flatten() });
    try {
      const out = await publishListing({ pool, owner_did: did, ...p.data });
      if (auditChain) await auditChain.append({ event_type: 'directory.published', owner_did: did, ...out, kind: p.data.kind }).catch(() => {});
      return res.status(201).json(out);
    } catch (e) {
      return res.status(409).json({ error: 'slug_conflict_or_invalid', message: e.message });
    }
  });

  // Public search — no auth.
  app.get('/v1/directory/search', async (req, res) => {
    const q = req.query.q;
    const kind = req.query.kind;
    const category = req.query.category;
    const sort = req.query.sort || 'popular';
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(50, parseInt(req.query.limit) || 20);
    const offset = (page - 1) * limit;

    const conds = [`status='published'`];
    const params = [];
    if (kind)     { params.push(kind);     conds.push(`kind = $${params.length}`); }
    if (category) { params.push(category); conds.push(`category = $${params.length}`); }
    if (q)        { params.push(`%${q}%`); conds.push(`(title ILIKE $${params.length} OR description ILIKE $${params.length} OR tagline ILIKE $${params.length})`); }

    const orderBy = ({
      newest:     'created_at DESC',
      popular:    'view_count DESC',
      price_asc:  'price_cents ASC NULLS FIRST',
      price_desc: 'price_cents DESC NULLS LAST',
      relevance:  'view_count DESC'
    })[sort] || 'view_count DESC';

    params.push(limit); params.push(offset);
    const r = await pool.query(`
      SELECT listing_id, kind, slug, owner_did, title, description, tagline,
             cover_image_url, tags, category, price_model, price_cents, currency,
             featured, view_count, install_count, rating_avg, rating_count, created_at
      FROM directory_listings WHERE ${conds.join(' AND ')}
      ORDER BY featured DESC, ${orderBy}
      LIMIT $${params.length - 1} OFFSET $${params.length}
    `, params).catch(() => ({ rows: [] }));
    res.json({ q: q || null, kind, category, sort, page, count: r.rows.length, listings: r.rows });
  });

  app.get('/v1/directory/listings/:slug', async (req, res) => {
    const r = await pool.query(`
      SELECT * FROM directory_listings WHERE slug = $1 AND status = 'published'
    `, [req.params.slug]).catch(() => ({ rows: [] }));
    if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
    // increment view (fire-and-forget)
    const ipHash = crypto.createHash('sha256').update(req.ip || '').digest('hex').slice(0, 16);
    await pool.query(
      `INSERT INTO directory_views (view_id, listing_id, ip_hash, referrer) VALUES ($1,$2,$3,$4)`,
      [newId('dv'), r.rows[0].listing_id, ipHash, req.headers.referer || null]
    ).catch(() => {});
    await pool.query(`UPDATE directory_listings SET view_count = view_count + 1 WHERE listing_id = $1`,
      [r.rows[0].listing_id]).catch(() => {});
    res.json(r.rows[0]);
  });

  app.get('/v1/directory/categories', async (req, res) => {
    const kind = req.query.kind;
    const r = await pool.query(`
      SELECT code, kind, name, description, sort_order FROM directory_categories
      ${kind ? 'WHERE kind = $1' : ''}
      ORDER BY kind, sort_order, name
    `, kind ? [kind] : []).catch(() => ({ rows: [] }));
    res.json({ categories: r.rows });
  });

  app.get('/v1/directory/collections', async (req, res) => {
    const r = await pool.query(`SELECT collection_id, slug, name, description, listing_ids, created_at
                                FROM directory_collections ORDER BY created_at DESC LIMIT 100`)
      .catch(() => ({ rows: [] }));
    res.json({ collections: r.rows });
  });

  app.get('/v1/directory/collections/:slug', async (req, res) => {
    const c = await pool.query(`SELECT * FROM directory_collections WHERE slug = $1`, [req.params.slug])
      .catch(() => ({ rows: [] }));
    if (!c.rows[0]) return res.status(404).json({ error: 'not_found' });
    const ids = c.rows[0].listing_ids || [];
    const listings = ids.length ? (await pool.query(
      `SELECT listing_id, slug, kind, title, tagline, cover_image_url FROM directory_listings WHERE listing_id = ANY($1::text[]) AND status='published'`,
      [ids]
    ).catch(() => ({ rows: [] }))).rows : [];
    res.json({ ...c.rows[0], listings });
  });

  app.post('/v1/directory/collections', express.json(), async (req, res) => {
    if (!isAdmin(req)) return res.status(401).json({ error: 'admin_auth_required' });
    const { slug, name, description, listing_ids, curator_did } = req.body || {};
    if (!slug || !name) return res.status(400).json({ error: 'slug_and_name_required' });
    const id = newId('col');
    await pool.query(
      `INSERT INTO directory_collections (collection_id, slug, name, description, curator_did, listing_ids)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [id, slug, name, description || null, curator_did || null, listing_ids || []]
    );
    res.status(201).json({ collection_id: id, slug });
  });

  app.get('/v1/directory/featured', async (req, res) => {
    const r = await pool.query(`
      SELECT listing_id, slug, kind, title, tagline, cover_image_url, view_count
      FROM directory_listings WHERE featured = TRUE AND status='published'
      ORDER BY view_count DESC LIMIT 10
    `).catch(() => ({ rows: [] }));
    res.json({ featured: r.rows });
  });

  app.post('/v1/agents/:did/directory/listings/:lid/feature', async (req, res) => {
    if (!isAdmin(req)) return res.status(401).json({ error: 'admin_auth_required' });
    const r = await pool.query(`UPDATE directory_listings SET featured = TRUE WHERE listing_id = $1 RETURNING listing_id`,
      [req.params.lid]).catch(() => ({ rows: [] }));
    if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
    res.json({ listing_id: r.rows[0].listing_id, featured: true });
  });

  app.get('/v1/directory/sitemap.xml', async (req, res) => {
    const r = await pool.query(`SELECT slug, updated_at FROM directory_listings WHERE status='published' ORDER BY updated_at DESC LIMIT 50000`)
      .catch(() => ({ rows: [] }));
    const base = process.env.OPERATOR_PUBLIC_URL || ('http://' + req.headers.host);
    res.setHeader('content-type', 'application/xml');
    res.send(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${r.rows.map(x => `  <url><loc>${escapeXml(base)}/v1/directory/listings/${escapeXml(x.slug)}</loc><lastmod>${new Date(x.updated_at).toISOString().slice(0,10)}</lastmod></url>`).join('\n')}
</urlset>`);
  });

  registerCron(app, '/v1/_jobs/directory-reindex', async (req, res) => {
    // No-op stub for full-text reindex; real implementation would refresh tsvector.
    res.json({ reindexed: 0 });
  });
}

module.exports = { migrate, registerPublicDirectoryRoutes, publishListing, KINDS, DEFAULT_CATEGORIES };
