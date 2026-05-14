// ============================================================================
// OpenHeab Prompts — Prompt marketplace with 70/30 publisher/platform split
// ============================================================================
const express = require('express');
const cryptoLib = require('crypto');
const { z } = require('zod');

const CATEGORIES = [
  'general', 'coding', 'writing', 'analysis', 'creative', 'reasoning',
  'extraction', 'classification', 'translation', 'summarization', 'roleplay',
  'tool-use', 'agentic', 'safety', 'research', 'education', 'finance',
  'marketing', 'sales', 'support', 'legal', 'medical'
];

const PUBLISHER_BPS = 7000;
const PLATFORM_BPS = 3000;

// ----------------------------------------------------------------------------
// Migration
// ----------------------------------------------------------------------------
async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS prompts (
      slug            TEXT PRIMARY KEY,
      title           TEXT NOT NULL,
      description     TEXT,
      category        TEXT NOT NULL,
      publisher_did   TEXT NOT NULL,
      price_cents     INTEGER NOT NULL DEFAULT 0,
      uses_count      BIGINT NOT NULL DEFAULT 0,
      avg_rating      REAL NOT NULL DEFAULT 0,
      latest_version  INTEGER NOT NULL DEFAULT 1,
      tags            TEXT[] NOT NULL DEFAULT '{}',
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_prompts_category ON prompts (category);
    CREATE INDEX IF NOT EXISTS idx_prompts_publisher ON prompts (publisher_did);
    CREATE INDEX IF NOT EXISTS idx_prompts_uses ON prompts (uses_count DESC);

    CREATE TABLE IF NOT EXISTS prompt_versions (
      slug            TEXT NOT NULL,
      version         INTEGER NOT NULL,
      template        TEXT NOT NULL,
      variables       JSONB NOT NULL DEFAULT '[]'::jsonb,
      system_prompt   TEXT,
      example_input   JSONB,
      example_output  TEXT,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (slug, version)
    );

    CREATE TABLE IF NOT EXISTS prompt_uses (
      use_id          TEXT PRIMARY KEY,
      slug            TEXT NOT NULL,
      version         INTEGER NOT NULL,
      caller_did      TEXT NOT NULL,
      publisher_did   TEXT NOT NULL,
      price_cents     INTEGER NOT NULL DEFAULT 0,
      publisher_cents INTEGER NOT NULL DEFAULT 0,
      platform_cents  INTEGER NOT NULL DEFAULT 0,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_prompt_uses_slug ON prompt_uses (slug, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_prompt_uses_caller ON prompt_uses (caller_did, created_at DESC);

    CREATE TABLE IF NOT EXISTS prompt_reviews (
      review_id      TEXT PRIMARY KEY,
      slug           TEXT NOT NULL,
      reviewer_did   TEXT NOT NULL,
      rating         INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
      review_text    TEXT,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (slug, reviewer_did)
    );
    CREATE INDEX IF NOT EXISTS idx_prompt_reviews_slug ON prompt_reviews (slug);
  `).catch(() => {});
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------
function genId(prefix) {
  return `${prefix}_${cryptoLib.randomBytes(12).toString('hex')}`;
}

async function recalcAvgRating(pool, slug) {
  const r = await pool.query(
    `SELECT COALESCE(AVG(rating)::real, 0) AS avg FROM prompt_reviews WHERE slug=$1`,
    [slug]
  ).catch(() => ({ rows: [{ avg: 0 }] }));
  await pool.query(
    `UPDATE prompts SET avg_rating=$1, updated_at=NOW() WHERE slug=$2`,
    [r.rows[0].avg, slug]
  ).catch(() => {});
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
function registerPromptsRoutes(app, pool, verifyAgentAuth, auditChain) {
  // POST /v1/prompts — create prompt
  const CreateSchema = z.object({
    slug: z.string().min(1).max(120).regex(/^[a-z0-9][a-z0-9-]{0,118}[a-z0-9]$/),
    title: z.string().min(1).max(200),
    description: z.string().max(4000).optional(),
    category: z.enum(CATEGORIES),
    publisher_did: z.string(),
    price_cents: z.number().int().nonnegative().max(1_000_000).default(0),
    tags: z.array(z.string()).max(20).optional(),
    template: z.string().min(1),
    variables: z.array(z.any()).optional(),
    system_prompt: z.string().optional(),
    example_input: z.any().optional(),
    example_output: z.string().optional()
  });

  app.post('/v1/prompts', express.json({ limit: '1mb' }), async (req, res) => {
    try {
      const parse = CreateSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;

      const auth = await verifyAgentAuth(req, d.publisher_did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const exists = await pool.query(`SELECT slug FROM prompts WHERE slug=$1`, [d.slug])
        .catch(() => ({ rows: [] }));
      if (exists.rows[0]) return res.status(409).json({ error: 'slug_taken' });

      await pool.query(
        `INSERT INTO prompts (slug, title, description, category, publisher_did,
          price_cents, latest_version, tags)
         VALUES ($1,$2,$3,$4,$5,$6,1,$7)`,
        [d.slug, d.title, d.description || null, d.category, d.publisher_did,
         d.price_cents || 0, d.tags || []]
      );
      await pool.query(
        `INSERT INTO prompt_versions (slug, version, template, variables, system_prompt,
          example_input, example_output)
         VALUES ($1,1,$2,$3::jsonb,$4,$5::jsonb,$6)`,
        [d.slug, d.template, JSON.stringify(d.variables || []), d.system_prompt || null,
         d.example_input ? JSON.stringify(d.example_input) : null, d.example_output || null]
      );

      await auditChain.append({
        event_type: 'prompts.created',
        slug: d.slug, publisher_did: d.publisher_did, category: d.category,
        timestamp: new Date().toISOString()
      });

      return res.status(201).json({
        slug: d.slug, version: 1, title: d.title,
        publisher_did: d.publisher_did, price_cents: d.price_cents || 0
      });
    } catch (e) {
      console.error('[prompts.create]', e);
      return res.status(500).json({ error: 'create_failed', message: e.message });
    }
  });

  // POST /v1/prompts/:slug/versions — publish new version
  const VersionSchema = z.object({
    template: z.string().min(1),
    variables: z.array(z.any()).optional(),
    system_prompt: z.string().optional(),
    example_input: z.any().optional(),
    example_output: z.string().optional()
  });

  app.post('/v1/prompts/:slug/versions', express.json({ limit: '1mb' }), async (req, res) => {
    try {
      const slug = req.params.slug;
      const promptR = await pool.query(`SELECT publisher_did, latest_version FROM prompts WHERE slug=$1`, [slug])
        .catch(() => ({ rows: [] }));
      if (!promptR.rows[0]) return res.status(404).json({ error: 'not_found' });

      const auth = await verifyAgentAuth(req, promptR.rows[0].publisher_did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const parse = VersionSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;
      const nextV = (promptR.rows[0].latest_version || 0) + 1;

      await pool.query(
        `INSERT INTO prompt_versions (slug, version, template, variables, system_prompt,
          example_input, example_output)
         VALUES ($1,$2,$3,$4::jsonb,$5,$6::jsonb,$7)`,
        [slug, nextV, d.template, JSON.stringify(d.variables || []),
         d.system_prompt || null,
         d.example_input ? JSON.stringify(d.example_input) : null, d.example_output || null]
      );
      await pool.query(`UPDATE prompts SET latest_version=$1, updated_at=NOW() WHERE slug=$2`, [nextV, slug]);

      await auditChain.append({
        event_type: 'prompts.version_published',
        slug, version: nextV, timestamp: new Date().toISOString()
      });

      return res.status(201).json({ slug, version: nextV });
    } catch (e) {
      console.error('[prompts.version]', e);
      return res.status(500).json({ error: 'version_failed', message: e.message });
    }
  });

  // GET /v1/prompts — list
  app.get('/v1/prompts', async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const offset = Math.max(parseInt(req.query.offset) || 0, 0);
    const category = req.query.category;
    const publisher = req.query.publisher_did;
    const q = req.query.q;

    const params = [limit, offset];
    const where = [];
    if (category) { params.push(category); where.push(`category=$${params.length}`); }
    if (publisher) { params.push(publisher); where.push(`publisher_did=$${params.length}`); }
    if (q) { params.push(`%${q}%`); where.push(`(title ILIKE $${params.length} OR description ILIKE $${params.length})`); }
    const sql = `SELECT slug, title, description, category, publisher_did, price_cents,
                        uses_count, avg_rating, latest_version, tags, created_at, updated_at
                 FROM prompts ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                 ORDER BY uses_count DESC LIMIT $1 OFFSET $2`;
    const r = await pool.query(sql, params).catch(() => ({ rows: [] }));
    return res.json({ prompts: r.rows, count: r.rows.length });
  });

  // GET /v1/prompts/:slug
  app.get('/v1/prompts/:slug', async (req, res) => {
    const slug = req.params.slug;
    const r = await pool.query(`SELECT * FROM prompts WHERE slug=$1`, [slug])
      .catch(() => ({ rows: [] }));
    if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
    const versions = await pool.query(
      `SELECT version, created_at FROM prompt_versions WHERE slug=$1 ORDER BY version DESC`,
      [slug]
    ).catch(() => ({ rows: [] }));
    return res.json({ ...r.rows[0], versions: versions.rows });
  });

  // POST /v1/prompts/:slug/use
  const UseSchema = z.object({
    caller_did: z.string(),
    version: z.number().int().positive().optional(),
    variables: z.record(z.any()).optional()
  });

  app.post('/v1/prompts/:slug/use', express.json(), async (req, res) => {
    try {
      const slug = req.params.slug;
      const parse = UseSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;

      const auth = await verifyAgentAuth(req, d.caller_did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const pr = await pool.query(
        `SELECT slug, publisher_did, price_cents, latest_version FROM prompts WHERE slug=$1`,
        [slug]
      ).catch(() => ({ rows: [] }));
      if (!pr.rows[0]) return res.status(404).json({ error: 'not_found' });
      const prompt = pr.rows[0];
      const version = d.version || prompt.latest_version;

      const vr = await pool.query(
        `SELECT version, template, variables, system_prompt, example_input, example_output
         FROM prompt_versions WHERE slug=$1 AND version=$2`,
        [slug, version]
      ).catch(() => ({ rows: [] }));
      if (!vr.rows[0]) return res.status(404).json({ error: 'version_not_found' });

      const priceCents = prompt.price_cents || 0;
      const publisherCents = Math.floor(priceCents * PUBLISHER_BPS / 10000);
      const platformCents = priceCents - publisherCents;
      const useId = genId('puse');

      if (priceCents > 0) {
        await tryRecordCost(pool, d.caller_did, priceCents, `prompt:${slug}@${version}`);
      }

      await pool.query(
        `INSERT INTO prompt_uses (use_id, slug, version, caller_did, publisher_did,
          price_cents, publisher_cents, platform_cents)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [useId, slug, version, d.caller_did, prompt.publisher_did,
         priceCents, publisherCents, platformCents]
      );
      await pool.query(
        `UPDATE prompts SET uses_count = uses_count + 1, updated_at=NOW() WHERE slug=$1`,
        [slug]
      );

      await auditChain.append({
        event_type: 'prompts.used',
        use_id: useId, slug, version, caller_did: d.caller_did,
        publisher_did: prompt.publisher_did, price_cents: priceCents,
        timestamp: new Date().toISOString()
      });

      return res.status(201).json({
        use_id: useId, slug, version,
        template: vr.rows[0].template,
        variables: vr.rows[0].variables,
        system_prompt: vr.rows[0].system_prompt,
        example_input: vr.rows[0].example_input,
        example_output: vr.rows[0].example_output,
        price_cents: priceCents,
        publisher_cents: publisherCents,
        platform_cents: platformCents
      });
    } catch (e) {
      console.error('[prompts.use]', e);
      return res.status(500).json({ error: 'use_failed', message: e.message });
    }
  });

  // POST /v1/prompts/:slug/reviews
  const ReviewSchema = z.object({
    reviewer_did: z.string(),
    rating: z.number().int().min(1).max(5),
    review_text: z.string().max(4000).optional()
  });

  app.post('/v1/prompts/:slug/reviews', express.json(), async (req, res) => {
    try {
      const slug = req.params.slug;
      const parse = ReviewSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;

      const auth = await verifyAgentAuth(req, d.reviewer_did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const exists = await pool.query(`SELECT slug FROM prompts WHERE slug=$1`, [slug])
        .catch(() => ({ rows: [] }));
      if (!exists.rows[0]) return res.status(404).json({ error: 'not_found' });

      const reviewId = genId('prev');
      const ins = await pool.query(
        `INSERT INTO prompt_reviews (review_id, slug, reviewer_did, rating, review_text)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (slug, reviewer_did) DO UPDATE SET
           rating=$4, review_text=$5, created_at=NOW()
         RETURNING review_id`,
        [reviewId, slug, d.reviewer_did, d.rating, d.review_text || null]
      ).catch(() => ({ rows: [] }));

      await recalcAvgRating(pool, slug);

      await auditChain.append({
        event_type: 'prompts.reviewed',
        slug, reviewer_did: d.reviewer_did, rating: d.rating,
        timestamp: new Date().toISOString()
      });

      return res.status(201).json({
        review_id: ins.rows[0]?.review_id || reviewId,
        slug, reviewer_did: d.reviewer_did, rating: d.rating
      });
    } catch (e) {
      console.error('[prompts.review]', e);
      return res.status(500).json({ error: 'review_failed', message: e.message });
    }
  });

  // GET /v1/prompts/:slug/reviews
  app.get('/v1/prompts/:slug/reviews', async (req, res) => {
    const slug = req.params.slug;
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const r = await pool.query(
      `SELECT review_id, reviewer_did, rating, review_text, created_at
       FROM prompt_reviews WHERE slug=$1 ORDER BY created_at DESC LIMIT $2`,
      [slug, limit]
    ).catch(() => ({ rows: [] }));
    return res.json({ reviews: r.rows, count: r.rows.length });
  });
}

module.exports = {
  migrate,
  registerPromptsRoutes,
  CATEGORIES,
  PUBLISHER_BPS,
  PLATFORM_BPS
};
