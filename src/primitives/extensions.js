// ============================================================================
// OpenHeab Extensions — Third-party agent capability marketplace with 70/30
// revenue split (default). Publishers register extensions; agents invoke them
// through a metered, audited broker.
// ============================================================================
const express = require('express');
const cryptoLib = require('crypto');
const { z } = require('zod');

const PUBLISHER_BPS = parseInt(process.env.EXTENSIONS_PUBLISHER_BPS || '7000');
const PLATFORM_BPS = 10000 - PUBLISHER_BPS;

const CATEGORIES = [
  'legal', 'real-estate', 'trading', 'healthcare', 'research', 'data',
  'commerce', 'logistics', 'travel', 'education', 'creative', 'devtools',
  'compliance', 'identity', 'compute', 'storage', 'inference', 'other'
];

// ----------------------------------------------------------------------------
// Migration
// ----------------------------------------------------------------------------
async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS extensions (
      slug                 TEXT PRIMARY KEY,
      publisher_did        TEXT NOT NULL,
      name                 TEXT NOT NULL,
      description          TEXT,
      category             TEXT,
      tags                 TEXT[],
      homepage_url         TEXT,
      docs_url             TEXT,
      icon_url             TEXT,
      status               TEXT NOT NULL DEFAULT 'active',
      capabilities         JSONB,
      pricing_model        TEXT NOT NULL DEFAULT 'per_call',
      price_usdc_raw       NUMERIC(78,0) NOT NULL DEFAULT 0,
      free_trial_calls     INTEGER NOT NULL DEFAULT 0,
      current_version      TEXT,
      total_invocations    BIGINT NOT NULL DEFAULT 0,
      total_revenue_raw    NUMERIC(78,0) NOT NULL DEFAULT 0,
      avg_rating           REAL,
      review_count         INTEGER NOT NULL DEFAULT 0,
      audit_hash           TEXT,
      created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_ext_publisher ON extensions (publisher_did);
    CREATE INDEX IF NOT EXISTS idx_ext_category ON extensions (category) WHERE status='active';
    CREATE INDEX IF NOT EXISTS idx_ext_status ON extensions (status);

    CREATE TABLE IF NOT EXISTS extension_versions (
      version_id      TEXT PRIMARY KEY,
      slug            TEXT NOT NULL,
      version         TEXT NOT NULL,
      invocation_url  TEXT NOT NULL,
      auth_required   BOOLEAN NOT NULL DEFAULT FALSE,
      timeout_ms      INTEGER NOT NULL DEFAULT 30000,
      input_schema    JSONB,
      output_schema   JSONB,
      changelog       TEXT,
      published_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (slug, version)
    );
    CREATE INDEX IF NOT EXISTS idx_ext_versions_slug ON extension_versions (slug, published_at DESC);

    CREATE TABLE IF NOT EXISTS extension_invocations (
      invocation_id        TEXT PRIMARY KEY,
      slug                 TEXT NOT NULL,
      version              TEXT,
      caller_did           TEXT NOT NULL,
      publisher_did        TEXT NOT NULL,
      status               TEXT NOT NULL,
      cost_usdc_raw        NUMERIC(78,0) NOT NULL DEFAULT 0,
      publisher_share_raw  NUMERIC(78,0) NOT NULL DEFAULT 0,
      platform_share_raw   NUMERIC(78,0) NOT NULL DEFAULT 0,
      latency_ms           INTEGER,
      response_status      INTEGER,
      error                TEXT,
      audit_hash           TEXT,
      created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_ext_inv_slug ON extension_invocations (slug, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_ext_inv_caller ON extension_invocations (caller_did, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_ext_inv_publisher ON extension_invocations (publisher_did, created_at DESC);

    CREATE TABLE IF NOT EXISTS extension_reviews (
      review_id       TEXT PRIMARY KEY,
      slug            TEXT NOT NULL,
      reviewer_did    TEXT NOT NULL,
      rating          SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
      title           TEXT,
      body            TEXT,
      verified_caller BOOLEAN NOT NULL DEFAULT FALSE,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (slug, reviewer_did)
    );
    CREATE INDEX IF NOT EXISTS idx_ext_reviews_slug ON extension_reviews (slug, created_at DESC);
  `).catch(() => {});
}

// ----------------------------------------------------------------------------
// Idempotency
// ----------------------------------------------------------------------------
async function checkIdempotency(pool, agentDid, key, scope) {
  if (!key) return null;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS extensions_idempotency (
      agent_did TEXT NOT NULL,
      scope TEXT NOT NULL,
      idem_key TEXT NOT NULL,
      response JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (agent_did, scope, idem_key)
    )`).catch(() => {});
  const r = await pool.query(
    `SELECT response FROM extensions_idempotency WHERE agent_did=$1 AND scope=$2 AND idem_key=$3`,
    [agentDid, scope, key]
  ).catch(() => ({ rows: [] }));
  return r.rows[0]?.response || null;
}

async function recordIdempotency(pool, agentDid, key, scope, response) {
  if (!key) return;
  await pool.query(
    `INSERT INTO extensions_idempotency (agent_did, scope, idem_key, response)
     VALUES ($1,$2,$3,$4::jsonb) ON CONFLICT DO NOTHING`,
    [agentDid, scope, key, JSON.stringify(response)]
  ).catch(() => {});
}

// ----------------------------------------------------------------------------
// HTTP broker — relay to invocation_url
// ----------------------------------------------------------------------------
async function brokerFetch(url, body, timeoutMs, headers) {
  const controller = new AbortController();
  const to = setTimeout(() => controller.abort(), timeoutMs || 30000);
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(headers || {}) },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    let parsed = null;
    try { parsed = await r.json(); } catch { parsed = null; }
    return { status: r.status, body: parsed };
  } finally { clearTimeout(to); }
}

// ----------------------------------------------------------------------------
// Helpers — count free trial usage
// ----------------------------------------------------------------------------
async function countCallerInvocations(pool, slug, callerDid) {
  const r = await pool.query(
    `SELECT COUNT(*)::int AS n FROM extension_invocations
     WHERE slug=$1 AND caller_did=$2 AND status='success'`,
    [slug, callerDid]
  ).catch(() => ({ rows: [{ n: 0 }] }));
  return parseInt(r.rows[0]?.n || 0);
}

// ----------------------------------------------------------------------------
// Signature canonical for publishing
// ----------------------------------------------------------------------------
function publishCanonical(slug, publisherDid, name) {
  return `PUBLISH|${slug}|${publisherDid}|${name}`;
}

// ----------------------------------------------------------------------------
// Routes
// ----------------------------------------------------------------------------
function registerExtensionRoutes(app, pool, verifyAgentAuth, auditChain) {
  let commerce = null;
  try { commerce = require('./commerce'); } catch { commerce = null; }

  // --------------------------------------------------------------------------
  // POST /v1/extensions — publish
  // --------------------------------------------------------------------------
  const PublishSchema = z.object({
    slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,63}$/),
    publisher_did: z.string(),
    name: z.string().min(1).max(200),
    description: z.string().max(20000).optional(),
    category: z.enum(CATEGORIES).optional(),
    tags: z.array(z.string().max(64)).max(50).optional(),
    homepage_url: z.string().url().max(2000).optional(),
    docs_url: z.string().url().max(2000).optional(),
    icon_url: z.string().url().max(2000).optional(),
    capabilities: z.any().optional(),
    pricing_model: z.enum(['per_call', 'subscription', 'free']).optional(),
    price_usdc_raw: z.string().regex(/^\d+$/).optional(),
    free_trial_calls: z.number().int().nonnegative().optional(),
    version: z.string().min(1).max(64),
    invocation_url: z.string().url().max(2000),
    auth_required: z.boolean().optional(),
    timeout_ms: z.number().int().positive().max(300000).optional(),
    input_schema: z.any().optional(),
    output_schema: z.any().optional(),
    changelog: z.string().max(20000).optional()
  });

  app.post('/v1/extensions', express.json(), async (req, res) => {
    try {
      const parse = PublishSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;

      const auth = await verifyAgentAuth(req, d.publisher_did, { strictSignatureRequired: true });
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const idemKey = req.headers['x-idempotency-key'];
      const cached = await checkIdempotency(pool, d.publisher_did, idemKey, `publish:${d.slug}`);
      if (cached) return res.json(cached);

      // Ensure existing extension is owned by same publisher
      const existing = await pool.query(
        `SELECT publisher_did FROM extensions WHERE slug = $1`, [d.slug]
      );
      if (existing.rows[0] && existing.rows[0].publisher_did !== d.publisher_did) {
        return res.status(403).json({ error: 'slug_owned_by_other_publisher' });
      }

      const auditHash = cryptoLib.createHash('sha256')
        .update(publishCanonical(d.slug, d.publisher_did, d.name))
        .digest('hex');

      const chainEntry = await auditChain.append({
        event_type: 'extensions.published',
        slug: d.slug,
        publisher_did: d.publisher_did,
        version: d.version,
        category: d.category || null,
        timestamp: new Date().toISOString()
      });

      await pool.query(`
        INSERT INTO extensions
          (slug, publisher_did, name, description, category, tags, homepage_url, docs_url,
           icon_url, status, capabilities, pricing_model, price_usdc_raw, free_trial_calls,
           current_version, audit_hash, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'active', $10::jsonb, $11, $12, $13, $14, $15, NOW())
        ON CONFLICT (slug) DO UPDATE SET
          name = EXCLUDED.name,
          description = COALESCE(EXCLUDED.description, extensions.description),
          category = COALESCE(EXCLUDED.category, extensions.category),
          tags = COALESCE(EXCLUDED.tags, extensions.tags),
          homepage_url = COALESCE(EXCLUDED.homepage_url, extensions.homepage_url),
          docs_url = COALESCE(EXCLUDED.docs_url, extensions.docs_url),
          icon_url = COALESCE(EXCLUDED.icon_url, extensions.icon_url),
          capabilities = COALESCE(EXCLUDED.capabilities, extensions.capabilities),
          pricing_model = EXCLUDED.pricing_model,
          price_usdc_raw = EXCLUDED.price_usdc_raw,
          free_trial_calls = EXCLUDED.free_trial_calls,
          current_version = EXCLUDED.current_version,
          audit_hash = EXCLUDED.audit_hash,
          updated_at = NOW()
      `, [
        d.slug, d.publisher_did, d.name, d.description || null,
        d.category || null, d.tags || null,
        d.homepage_url || null, d.docs_url || null, d.icon_url || null,
        d.capabilities ? JSON.stringify(d.capabilities) : null,
        d.pricing_model || 'per_call',
        d.price_usdc_raw || '0',
        d.free_trial_calls || 0,
        d.version, auditHash
      ]);

      const versionId = 'extv_' + cryptoLib.randomBytes(12).toString('hex');
      await pool.query(`
        INSERT INTO extension_versions
          (version_id, slug, version, invocation_url, auth_required, timeout_ms,
           input_schema, output_schema, changelog)
        VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9)
        ON CONFLICT (slug, version) DO UPDATE SET
          invocation_url = EXCLUDED.invocation_url,
          auth_required = EXCLUDED.auth_required,
          timeout_ms = EXCLUDED.timeout_ms,
          input_schema = COALESCE(EXCLUDED.input_schema, extension_versions.input_schema),
          output_schema = COALESCE(EXCLUDED.output_schema, extension_versions.output_schema),
          changelog = COALESCE(EXCLUDED.changelog, extension_versions.changelog)
      `, [
        versionId, d.slug, d.version, d.invocation_url,
        d.auth_required || false, d.timeout_ms || 30000,
        d.input_schema ? JSON.stringify(d.input_schema) : null,
        d.output_schema ? JSON.stringify(d.output_schema) : null,
        d.changelog || null
      ]);

      const response = {
        slug: d.slug,
        publisher_did: d.publisher_did,
        version: d.version,
        status: 'active',
        audit_hash: auditHash,
        audit_chain_entry: chainEntry.hash
      };
      await recordIdempotency(pool, d.publisher_did, idemKey, `publish:${d.slug}`, response);
      return res.status(201).json(response);
    } catch (e) {
      console.error('[extensions.publish]', e);
      return res.status(500).json({ error: 'publish_failed', message: e.message });
    }
  });

  // --------------------------------------------------------------------------
  // GET /v1/extensions/categories
  // --------------------------------------------------------------------------
  app.get('/v1/extensions/categories', async (req, res) => {
    return res.json({ categories: CATEGORIES });
  });

  // --------------------------------------------------------------------------
  // GET /v1/extensions (list with filters)
  // --------------------------------------------------------------------------
  app.get('/v1/extensions', async (req, res) => {
    const params = [];
    const conditions = [`status = 'active'`];

    if (req.query.category) {
      params.push(req.query.category);
      conditions.push(`category = $${params.length}`);
    }
    if (req.query.tag) {
      params.push(req.query.tag);
      conditions.push(`$${params.length} = ANY(tags)`);
    }
    if (req.query.q) {
      params.push(`%${req.query.q}%`);
      conditions.push(`(name ILIKE $${params.length} OR description ILIKE $${params.length})`);
    }
    if (req.query.publisher_did) {
      params.push(req.query.publisher_did);
      conditions.push(`publisher_did = $${params.length}`);
    }

    let orderBy = 'updated_at DESC';
    if (req.query.sort === 'popular') orderBy = 'total_invocations DESC';
    else if (req.query.sort === 'rating') orderBy = 'avg_rating DESC NULLS LAST';
    else if (req.query.sort === 'revenue') orderBy = 'total_revenue_raw DESC';
    else if (req.query.sort === 'new') orderBy = 'created_at DESC';

    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const offset = Math.max(parseInt(req.query.offset) || 0, 0);
    params.push(limit, offset);

    const r = await pool.query(
      `SELECT slug, publisher_did, name, description, category, tags, homepage_url,
              icon_url, pricing_model, price_usdc_raw::text, free_trial_calls,
              current_version, total_invocations::text, total_revenue_raw::text,
              avg_rating, review_count, status, created_at, updated_at
       FROM extensions
       WHERE ${conditions.join(' AND ')}
       ORDER BY ${orderBy}
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    ).catch(() => ({ rows: [] }));

    return res.json({ extensions: r.rows, count: r.rows.length });
  });

  // --------------------------------------------------------------------------
  // GET /v1/extensions/:slug
  // --------------------------------------------------------------------------
  app.get('/v1/extensions/:slug', async (req, res) => {
    const slug = req.params.slug;
    const r = await pool.query(
      `SELECT slug, publisher_did, name, description, category, tags, homepage_url,
              docs_url, icon_url, status, capabilities, pricing_model,
              price_usdc_raw::text, free_trial_calls, current_version,
              total_invocations::text, total_revenue_raw::text, avg_rating,
              review_count, audit_hash, created_at, updated_at
       FROM extensions WHERE slug = $1`, [slug]
    ).catch(() => ({ rows: [] }));
    if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });

    const versions = await pool.query(
      `SELECT version, invocation_url, auth_required, timeout_ms, changelog, published_at
       FROM extension_versions WHERE slug = $1 ORDER BY published_at DESC LIMIT 20`,
      [slug]
    ).catch(() => ({ rows: [] }));

    return res.json({ ...r.rows[0], versions: versions.rows });
  });

  // --------------------------------------------------------------------------
  // POST /v1/extensions/:slug/invoke — broker
  // --------------------------------------------------------------------------
  const InvokeSchema = z.object({
    caller_did: z.string(),
    version: z.string().optional(),
    input: z.any().optional()
  });

  app.post('/v1/extensions/:slug/invoke', express.json(), async (req, res) => {
    const slug = req.params.slug;
    try {
      const parse = InvokeSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const { caller_did, version, input } = parse.data;

      const auth = await verifyAgentAuth(req, caller_did, { strictSignatureRequired: true });
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const idemKey = req.headers['x-idempotency-key'];
      const cached = await checkIdempotency(pool, caller_did, idemKey, `invoke:${slug}`);
      if (cached) return res.json(cached);

      // Load extension
      const extR = await pool.query(
        `SELECT * FROM extensions WHERE slug = $1`, [slug]
      );
      if (!extR.rows[0]) return res.status(404).json({ error: 'extension_not_found' });
      const ext = extR.rows[0];
      if (ext.status !== 'active') return res.status(400).json({ error: 'extension_disabled', status: ext.status });

      // Load version
      const versionToUse = version || ext.current_version;
      const verR = await pool.query(
        `SELECT * FROM extension_versions WHERE slug = $1 AND version = $2`,
        [slug, versionToUse]
      );
      if (!verR.rows[0]) return res.status(404).json({ error: 'version_not_found', version: versionToUse });
      const ver = verR.rows[0];

      // Determine cost: free trial → 0, subscription → 0 (if active), else price_usdc_raw
      const priceRaw = String(ext.price_usdc_raw || '0');
      let cost = priceRaw;

      // Free-trial: first N invocations
      if (ext.free_trial_calls && parseInt(ext.free_trial_calls) > 0) {
        const used = await countCallerInvocations(pool, slug, caller_did);
        if (used < parseInt(ext.free_trial_calls)) cost = '0';
      }

      // Subscription pricing
      if (ext.pricing_model === 'subscription') {
        if (commerce && typeof commerce.hasActiveSubscription === 'function') {
          const active = await commerce.hasActiveSubscription(pool, caller_did, slug).catch(() => false);
          if (active) cost = '0';
          else if (cost === priceRaw && priceRaw !== '0') {
            // No active subscription and a non-zero price → reject (caller must subscribe)
            return res.status(402).json({ error: 'subscription_required', slug });
          }
        }
      } else if (ext.pricing_model === 'free') {
        cost = '0';
      }

      // Budget check
      if (commerce && typeof commerce.checkBudget === 'function' && cost !== '0') {
        const ok = await commerce.checkBudget(pool, caller_did, {
          category: 'extensions',
          slug,
          amount_raw: cost,
          currency: 'USDC'
        }).catch(() => ({ allowed: true }));
        if (ok && ok.allowed === false) {
          return res.status(402).json({ error: 'budget_exceeded', reason: ok.reason || null });
        }
      }

      const invocationId = 'inv_' + cryptoLib.randomBytes(12).toString('hex');
      const startedAt = Date.now();

      const brokerHeaders = {
        'x-openheab-invocation-id': invocationId,
        'x-openheab-caller-did': caller_did,
        'x-openheab-slug': slug,
        'x-openheab-version': versionToUse
      };

      let status = 'success';
      let respStatus = 0;
      let respBody = null;
      let errMsg = null;

      try {
        const out = await brokerFetch(
          ver.invocation_url,
          { invocation_id: invocationId, caller_did, input: input || null },
          ver.timeout_ms || 30000,
          brokerHeaders
        );
        respStatus = out.status;
        respBody = out.body;
        if (respStatus < 200 || respStatus >= 300) {
          status = 'failed';
          errMsg = `upstream_status_${respStatus}`;
        }
      } catch (e) {
        status = 'failed';
        errMsg = e.name === 'AbortError' ? 'timeout' : (e.message || 'broker_error');
      }

      const latency = Date.now() - startedAt;

      // Split revenue (only if success and non-zero cost)
      const costN = BigInt(cost);
      const isFree = costN === 0n;
      const finalCost = (status === 'success' && !isFree) ? costN : 0n;
      const publisherShare = (finalCost * BigInt(PUBLISHER_BPS)) / 10000n;
      const platformShare = finalCost - publisherShare;

      const auditHash = cryptoLib.createHash('sha256')
        .update(`INV|${invocationId}|${slug}|${caller_did}|${status}|${finalCost.toString()}`)
        .digest('hex');

      const chainEntry = await auditChain.append({
        event_type: 'extensions.invoked',
        invocation_id: invocationId,
        slug,
        version: versionToUse,
        caller_did,
        publisher_did: ext.publisher_did,
        status,
        cost_usdc_raw: finalCost.toString(),
        publisher_share_raw: publisherShare.toString(),
        platform_share_raw: platformShare.toString(),
        latency_ms: latency,
        timestamp: new Date().toISOString()
      });

      await pool.query(`
        INSERT INTO extension_invocations
          (invocation_id, slug, version, caller_did, publisher_did, status,
           cost_usdc_raw, publisher_share_raw, platform_share_raw, latency_ms,
           response_status, error, audit_hash)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      `, [
        invocationId, slug, versionToUse, caller_did, ext.publisher_did, status,
        finalCost.toString(), publisherShare.toString(), platformShare.toString(),
        latency, respStatus, errMsg, auditHash
      ]);

      if (status === 'success') {
        await pool.query(`
          UPDATE extensions SET
            total_invocations = total_invocations + 1,
            total_revenue_raw = total_revenue_raw + $2::numeric,
            updated_at = NOW()
          WHERE slug = $1
        `, [slug, finalCost.toString()]).catch(() => {});
      }

      const response = {
        invocation_id: invocationId,
        slug,
        version: versionToUse,
        caller_did,
        status,
        cost_usdc_raw: finalCost.toString(),
        publisher_share_raw: publisherShare.toString(),
        platform_share_raw: platformShare.toString(),
        latency_ms: latency,
        response_status: respStatus,
        output: respBody,
        error: errMsg,
        audit_hash: auditHash,
        audit_chain_entry: chainEntry.hash
      };
      await recordIdempotency(pool, caller_did, idemKey, `invoke:${slug}`, response);
      return res.status(status === 'success' ? 200 : 502).json(response);
    } catch (e) {
      console.error('[extensions.invoke]', e);
      return res.status(500).json({ error: 'invoke_failed', message: e.message });
    }
  });

  // --------------------------------------------------------------------------
  // POST /v1/extensions/:slug/reviews
  // --------------------------------------------------------------------------
  const ReviewSchema = z.object({
    reviewer_did: z.string(),
    rating: z.number().int().min(1).max(5),
    title: z.string().max(500).optional(),
    body: z.string().max(20000).optional()
  });

  app.post('/v1/extensions/:slug/reviews', express.json(), async (req, res) => {
    try {
      const parse = ReviewSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;
      const slug = req.params.slug;

      const auth = await verifyAgentAuth(req, d.reviewer_did, { strictSignatureRequired: true });
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const extR = await pool.query(
        `SELECT publisher_did FROM extensions WHERE slug=$1`, [slug]
      );
      if (!extR.rows[0]) return res.status(404).json({ error: 'extension_not_found' });
      if (extR.rows[0].publisher_did === d.reviewer_did) {
        return res.status(400).json({ error: 'cannot_review_own_extension' });
      }

      // Verified caller = has at least one successful invocation
      const invR = await pool.query(
        `SELECT 1 FROM extension_invocations
         WHERE slug=$1 AND caller_did=$2 AND status='success' LIMIT 1`,
        [slug, d.reviewer_did]
      );
      const verified = !!invR.rows[0];

      const reviewId = 'rev_' + cryptoLib.randomBytes(12).toString('hex');

      const ins = await pool.query(`
        INSERT INTO extension_reviews
          (review_id, slug, reviewer_did, rating, title, body, verified_caller)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (slug, reviewer_did) DO UPDATE SET
          rating = EXCLUDED.rating,
          title = EXCLUDED.title,
          body = EXCLUDED.body,
          verified_caller = EXCLUDED.verified_caller,
          created_at = NOW()
        RETURNING *
      `, [reviewId, slug, d.reviewer_did, d.rating, d.title || null, d.body || null, verified]);

      await pool.query(`
        UPDATE extensions SET
          avg_rating = (SELECT AVG(rating)::real FROM extension_reviews WHERE slug = $1),
          review_count = (SELECT COUNT(*) FROM extension_reviews WHERE slug = $1),
          updated_at = NOW()
        WHERE slug = $1
      `, [slug]);

      await auditChain.append({
        event_type: 'extensions.reviewed',
        slug,
        reviewer_did: d.reviewer_did,
        rating: d.rating,
        verified_caller: verified,
        timestamp: new Date().toISOString()
      });

      return res.status(201).json(ins.rows[0]);
    } catch (e) {
      console.error('[extensions.review]', e);
      return res.status(500).json({ error: 'review_failed', message: e.message });
    }
  });

  // --------------------------------------------------------------------------
  // GET /v1/extensions/:slug/stats (publisher only)
  // --------------------------------------------------------------------------
  app.get('/v1/extensions/:slug/stats', async (req, res) => {
    try {
      const slug = req.params.slug;
      const extR = await pool.query(
        `SELECT publisher_did, total_invocations::text AS total_invocations,
                total_revenue_raw::text AS total_revenue_raw,
                avg_rating, review_count
         FROM extensions WHERE slug=$1`, [slug]
      );
      if (!extR.rows[0]) return res.status(404).json({ error: 'not_found' });
      const ext = extR.rows[0];

      const auth = await verifyAgentAuth(req, ext.publisher_did);
      if (!auth.valid) return res.status(401).json({ error: 'publisher_only' });

      const daily = await pool.query(`
        SELECT DATE_TRUNC('day', created_at) AS day,
               COUNT(*)::int AS invocations,
               COUNT(*) FILTER (WHERE status='success')::int AS successful,
               COUNT(*) FILTER (WHERE status='failed')::int AS failed,
               COALESCE(SUM(cost_usdc_raw), 0)::text AS revenue_raw,
               COALESCE(AVG(latency_ms), 0)::int AS avg_latency_ms
        FROM extension_invocations
        WHERE slug = $1 AND created_at > NOW() - INTERVAL '30 days'
        GROUP BY day ORDER BY day DESC
      `, [slug]).catch(() => ({ rows: [] }));

      return res.json({
        slug,
        publisher_did: ext.publisher_did,
        total_invocations: ext.total_invocations,
        total_revenue_raw: ext.total_revenue_raw,
        avg_rating: ext.avg_rating,
        review_count: ext.review_count,
        publisher_bps: PUBLISHER_BPS,
        platform_bps: PLATFORM_BPS,
        daily: daily.rows
      });
    } catch (e) {
      console.error('[extensions.stats]', e);
      return res.status(500).json({ error: 'stats_failed', message: e.message });
    }
  });

  // --------------------------------------------------------------------------
  // POST /v1/extensions/:slug/disable
  // --------------------------------------------------------------------------
  app.post('/v1/extensions/:slug/disable', express.json(), async (req, res) => {
    try {
      const slug = req.params.slug;
      const extR = await pool.query(
        `SELECT publisher_did FROM extensions WHERE slug=$1`, [slug]
      );
      if (!extR.rows[0]) return res.status(404).json({ error: 'not_found' });

      const auth = await verifyAgentAuth(req, extR.rows[0].publisher_did, { strictSignatureRequired: true });
      if (!auth.valid) return res.status(401).json({ error: 'publisher_only' });

      await pool.query(
        `UPDATE extensions SET status='disabled', updated_at=NOW() WHERE slug=$1`, [slug]
      );

      await auditChain.append({
        event_type: 'extensions.disabled',
        slug,
        publisher_did: extR.rows[0].publisher_did,
        timestamp: new Date().toISOString()
      });

      return res.json({ slug, status: 'disabled' });
    } catch (e) {
      console.error('[extensions.disable]', e);
      return res.status(500).json({ error: 'disable_failed', message: e.message });
    }
  });
}

module.exports = {
  migrate,
  registerExtensionRoutes,
  PUBLISHER_BPS,
  PLATFORM_BPS,
  CATEGORIES
};
