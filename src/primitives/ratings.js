// ============================================================================
// OpenHeab Ratings — User-facing reviews and reputation aggregator.
// Supports reviews of agents, extensions, skills, products, recipes, services.
// Aggregates re-computed on every new rating; helpful votes + responses + flags.
// ============================================================================
const express = require('express');
const cryptoLib = require('crypto');
const { z } = require('zod');

const TARGET_KINDS = ['agent', 'extension', 'skill', 'product', 'recipe', 'service', 'channel'];
const RATING_STATUSES = ['active', 'hidden', 'flagged'];

// ----------------------------------------------------------------------------
// Migration
// ----------------------------------------------------------------------------
async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ratings (
      rating_id      TEXT PRIMARY KEY,
      target_kind    TEXT NOT NULL,
      target_id      TEXT NOT NULL,
      reviewer_did   TEXT NOT NULL,
      stars          INTEGER NOT NULL,
      title          TEXT,
      body           TEXT,
      verified       BOOLEAN NOT NULL DEFAULT FALSE,
      helpful_count  INTEGER NOT NULL DEFAULT 0,
      status         TEXT NOT NULL DEFAULT 'active',
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (target_kind, target_id, reviewer_did),
      CHECK (stars >= 1 AND stars <= 5)
    );
    CREATE INDEX IF NOT EXISTS idx_ratings_target ON ratings (target_kind, target_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_ratings_reviewer ON ratings (reviewer_did, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_ratings_status ON ratings (status);

    CREATE TABLE IF NOT EXISTS rating_responses (
      response_id   TEXT PRIMARY KEY,
      rating_id     TEXT NOT NULL,
      responder_did TEXT NOT NULL,
      body          TEXT NOT NULL,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_rating_responses_rating ON rating_responses (rating_id);

    CREATE TABLE IF NOT EXISTS rating_aggregates (
      target_kind     TEXT NOT NULL,
      target_id       TEXT NOT NULL,
      avg_stars       REAL NOT NULL DEFAULT 0,
      total_reviews   INTEGER NOT NULL DEFAULT 0,
      distribution    JSONB NOT NULL DEFAULT '{"5":0,"4":0,"3":0,"2":0,"1":0}'::jsonb,
      last_updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (target_kind, target_id)
    );

    CREATE TABLE IF NOT EXISTS rating_helpful_votes (
      rating_id   TEXT NOT NULL,
      voter_did   TEXT NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (rating_id, voter_did)
    );

    CREATE TABLE IF NOT EXISTS rating_flags (
      flag_id     TEXT PRIMARY KEY,
      rating_id   TEXT NOT NULL,
      flagger_did TEXT NOT NULL,
      reason      TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (rating_id, flagger_did)
    );
  `).catch(() => {});
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------
function genId(prefix) { return `${prefix}_${cryptoLib.randomBytes(12).toString('hex')}`; }

async function recomputeAggregate(pool, targetKind, targetId) {
  const r = await pool.query(
    `SELECT stars, COUNT(*)::int AS n
     FROM ratings
     WHERE target_kind=$1 AND target_id=$2 AND status='active'
     GROUP BY stars`,
    [targetKind, targetId]
  ).catch(() => ({ rows: [] }));
  const distribution = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 };
  let total = 0;
  let sum = 0;
  for (const row of r.rows) {
    distribution[String(row.stars)] = row.n;
    total += row.n;
    sum += row.stars * row.n;
  }
  const avg = total > 0 ? +(sum / total).toFixed(2) : 0;
  await pool.query(
    `INSERT INTO rating_aggregates
       (target_kind, target_id, avg_stars, total_reviews, distribution, last_updated_at)
     VALUES ($1,$2,$3,$4,$5::jsonb, NOW())
     ON CONFLICT (target_kind, target_id) DO UPDATE
       SET avg_stars=$3, total_reviews=$4, distribution=$5::jsonb, last_updated_at=NOW()`,
    [targetKind, targetId, avg, total, JSON.stringify(distribution)]
  ).catch(() => {});
  return { avg_stars: avg, total_reviews: total, distribution };
}

// ----------------------------------------------------------------------------
// Routes
// ----------------------------------------------------------------------------
function registerRatingsRoutes(app, pool, verifyAgentAuth, auditChain) {
  // POST /v1/ratings — create review
  const RatingSchema = z.object({
    reviewer_did: z.string(),
    target_kind: z.enum(TARGET_KINDS),
    target_id: z.string().min(1).max(200),
    stars: z.number().int().min(1).max(5),
    title: z.string().max(300).optional(),
    body: z.string().max(20000).optional(),
    verified: z.boolean().optional()
  });
  app.post('/v1/ratings', express.json(), async (req, res) => {
    try {
      const parse = RatingSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;
      const auth = await verifyAgentAuth(req, d.reviewer_did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const ratingId = genId('rate');
      const r = await pool.query(
        `INSERT INTO ratings
           (rating_id, target_kind, target_id, reviewer_did, stars, title, body, verified)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (target_kind, target_id, reviewer_did) DO UPDATE
           SET stars=$5, title=$6, body=$7, updated_at=NOW(), status='active'
         RETURNING rating_id`,
        [ratingId, d.target_kind, d.target_id, d.reviewer_did,
         d.stars, d.title || null, d.body || null, !!d.verified]
      ).catch(() => ({ rows: [] }));
      const actualId = r.rows[0]?.rating_id || ratingId;
      const agg = await recomputeAggregate(pool, d.target_kind, d.target_id);
      await auditChain.append({
        event_type: 'ratings.created', rating_id: actualId,
        reviewer_did: d.reviewer_did, target_kind: d.target_kind,
        target_id: d.target_id, stars: d.stars,
        timestamp: new Date().toISOString()
      });
      return res.status(201).json({ rating_id: actualId, aggregate: agg });
    } catch (e) { return res.status(500).json({ error: 'rating_failed', message: e.message }); }
  });

  // GET /v1/ratings/:kind/:target_id — list
  app.get('/v1/ratings/:kind/:target_id', async (req, res) => {
    const kind = req.params.kind;
    if (!TARGET_KINDS.includes(kind)) return res.status(400).json({ error: 'invalid_kind' });
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const offset = Math.max(parseInt(req.query.offset) || 0, 0);
    const r = await pool.query(
      `SELECT * FROM ratings WHERE target_kind=$1 AND target_id=$2 AND status='active'
       ORDER BY helpful_count DESC, created_at DESC LIMIT $3 OFFSET $4`,
      [kind, req.params.target_id, limit, offset]
    ).catch(() => ({ rows: [] }));
    return res.json({ ratings: r.rows, count: r.rows.length });
  });

  // GET /v1/ratings/:kind/:target_id/aggregate
  app.get('/v1/ratings/:kind/:target_id/aggregate', async (req, res) => {
    const kind = req.params.kind;
    if (!TARGET_KINDS.includes(kind)) return res.status(400).json({ error: 'invalid_kind' });
    const r = await pool.query(
      `SELECT * FROM rating_aggregates WHERE target_kind=$1 AND target_id=$2`,
      [kind, req.params.target_id]
    ).catch(() => ({ rows: [] }));
    if (!r.rows[0]) {
      return res.json({
        target_kind: kind, target_id: req.params.target_id,
        avg_stars: 0, total_reviews: 0,
        distribution: { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 }
      });
    }
    return res.json(r.rows[0]);
  });

  // POST /v1/ratings/:id/respond  (owner of target responds)
  const RespondSchema = z.object({
    responder_did: z.string(),
    body: z.string().min(1).max(20000)
  });
  app.post('/v1/ratings/:id/respond', express.json(), async (req, res) => {
    try {
      const parse = RespondSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;
      const auth = await verifyAgentAuth(req, d.responder_did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const r = await pool.query(`SELECT rating_id FROM ratings WHERE rating_id=$1`, [req.params.id])
        .catch(() => ({ rows: [] }));
      if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
      const responseId = genId('resp');
      await pool.query(
        `INSERT INTO rating_responses (response_id, rating_id, responder_did, body)
         VALUES ($1, $2, $3, $4)`,
        [responseId, req.params.id, d.responder_did, d.body]
      );
      await auditChain.append({
        event_type: 'ratings.responded', rating_id: req.params.id,
        response_id: responseId, responder_did: d.responder_did,
        timestamp: new Date().toISOString()
      });
      return res.status(201).json({ response_id: responseId });
    } catch (e) { return res.status(500).json({ error: 'respond_failed', message: e.message }); }
  });

  // POST /v1/ratings/:id/helpful
  const HelpfulSchema = z.object({ voter_did: z.string() });
  app.post('/v1/ratings/:id/helpful', express.json(), async (req, res) => {
    try {
      const parse = HelpfulSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;
      const auth = await verifyAgentAuth(req, d.voter_did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const ins = await pool.query(
        `INSERT INTO rating_helpful_votes (rating_id, voter_did)
         VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING rating_id`,
        [req.params.id, d.voter_did]
      ).catch(() => ({ rows: [] }));
      if (!ins.rows[0]) return res.json({ rating_id: req.params.id, already_voted: true });
      const r = await pool.query(
        `UPDATE ratings SET helpful_count = helpful_count + 1
         WHERE rating_id=$1
         RETURNING helpful_count`,
        [req.params.id]
      ).catch(() => ({ rows: [] }));
      if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
      return res.json({ rating_id: req.params.id, helpful_count: r.rows[0].helpful_count });
    } catch (e) { return res.status(500).json({ error: 'helpful_failed', message: e.message }); }
  });

  // POST /v1/ratings/:id/flag
  const FlagSchema = z.object({
    flagger_did: z.string(),
    reason: z.string().max(2000).optional()
  });
  app.post('/v1/ratings/:id/flag', express.json(), async (req, res) => {
    try {
      const parse = FlagSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;
      const auth = await verifyAgentAuth(req, d.flagger_did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const flagId = genId('flag');
      await pool.query(
        `INSERT INTO rating_flags (flag_id, rating_id, flagger_did, reason)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (rating_id, flagger_did) DO NOTHING`,
        [flagId, req.params.id, d.flagger_did, d.reason || null]
      );
      // Hide rating after 3+ flags
      const cnt = await pool.query(
        `SELECT COUNT(*)::int AS n FROM rating_flags WHERE rating_id=$1`,
        [req.params.id]
      ).catch(() => ({ rows: [{ n: 0 }] }));
      if (cnt.rows[0].n >= 3) {
        const target = await pool.query(
          `UPDATE ratings SET status='flagged' WHERE rating_id=$1
           RETURNING target_kind, target_id`,
          [req.params.id]
        ).catch(() => ({ rows: [] }));
        if (target.rows[0]) {
          await recomputeAggregate(pool, target.rows[0].target_kind, target.rows[0].target_id);
        }
      }
      await auditChain.append({
        event_type: 'ratings.flagged', rating_id: req.params.id,
        flagger_did: d.flagger_did, flags: cnt.rows[0].n,
        timestamp: new Date().toISOString()
      });
      return res.json({ rating_id: req.params.id, flagged: true, flag_count: cnt.rows[0].n });
    } catch (e) { return res.status(500).json({ error: 'flag_failed', message: e.message }); }
  });

  // GET /v1/agents/:did/ratings — reviews I've written
  app.get('/v1/agents/:did/ratings', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(
      `SELECT * FROM ratings WHERE reviewer_did=$1
       ORDER BY created_at DESC LIMIT 500`, [did]
    ).catch(() => ({ rows: [] }));
    return res.json({ ratings: r.rows, count: r.rows.length });
  });

  // POST /v1/agents/:did/ratings — alternate path matching the spec
  app.post('/v1/agents/:did/ratings', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(
      `SELECT * FROM ratings WHERE reviewer_did=$1
       ORDER BY created_at DESC LIMIT 500`, [did]
    ).catch(() => ({ rows: [] }));
    return res.json({ ratings: r.rows, count: r.rows.length });
  });
}

module.exports = {
  migrate,
  registerRatingsRoutes,
  recomputeAggregate,
  TARGET_KINDS,
  RATING_STATUSES
};
