// ============================================================================
// agent_market.js — hire-an-agent marketplace. Agents post job listings
// (or buyers post RFPs); other agents bid; reputation-weighted selection;
// escrowed payment on completion. The "Upwork for AGI" — eventually a
// $5-10B/yr GMV layer at saturation.
// ============================================================================
const crypto = require('crypto');
const { z } = require('zod');

async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS agent_market_listings (
      listing_id        TEXT PRIMARY KEY,
      poster_did        TEXT NOT NULL,
      kind              TEXT NOT NULL,
      title             TEXT NOT NULL,
      description       TEXT,
      category          TEXT,
      budget_min_cents  BIGINT,
      budget_max_cents  BIGINT,
      currency          TEXT DEFAULT 'usd',
      delivery_deadline TIMESTAMPTZ,
      required_skills   TEXT[],
      status            TEXT NOT NULL DEFAULT 'open',
      bid_count         INTEGER NOT NULL DEFAULT 0,
      selected_bid_id   TEXT,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_agent_market_listings_status ON agent_market_listings (status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_agent_market_listings_category ON agent_market_listings (category);

    CREATE TABLE IF NOT EXISTS agent_market_bids (
      bid_id            TEXT PRIMARY KEY,
      listing_id        TEXT NOT NULL,
      bidder_did        TEXT NOT NULL,
      amount_cents      BIGINT NOT NULL,
      delivery_window   TEXT,
      proposal          TEXT,
      reputation_score  REAL,
      status            TEXT NOT NULL DEFAULT 'pending',
      submitted_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_agent_market_bids_listing ON agent_market_bids (listing_id, status);

    CREATE TABLE IF NOT EXISTS agent_market_engagements (
      engagement_id     TEXT PRIMARY KEY,
      listing_id        TEXT NOT NULL,
      bid_id            TEXT NOT NULL,
      poster_did        TEXT NOT NULL,
      worker_did        TEXT NOT NULL,
      amount_cents      BIGINT NOT NULL,
      escrow_held       BOOLEAN NOT NULL DEFAULT TRUE,
      status            TEXT NOT NULL DEFAULT 'in_progress',
      delivered_at      TIMESTAMPTZ,
      released_at       TIMESTAMPTZ,
      review_stars      INTEGER,
      review_text       TEXT,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

function newId(p) { return p + '_' + crypto.randomBytes(10).toString('hex'); }

const listingSchema = z.object({
  kind: z.enum(['rfp', 'service_offer']),
  title: z.string().min(1).max(200),
  description: z.string().max(5000).optional(),
  category: z.string().optional(),
  budget_min_cents: z.number().int().min(0).optional(),
  budget_max_cents: z.number().int().min(0).optional(),
  delivery_deadline: z.string().optional(),
  required_skills: z.array(z.string()).optional()
});
const bidSchema = z.object({
  amount_cents: z.number().int().min(1),
  delivery_window: z.string().optional(),
  proposal: z.string().min(1).max(5000).optional()
});

async function recordRevenueIfPossible(pool, layer, amount_cents, agent_did, related_id) {
  try {
    const rev = require('./revenue');
    await rev.recordRevenue({ pool, source_layer: layer, amount_cents, agent_did, related_id });
  } catch {}
}

function registerAgentMarketRoutes(app, pool, verifyAgentAuth, auditChain) {
  const express = require('express');

  app.post('/v1/agents/:did/agent-market/listings', express.json(), async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const p = listingSchema.safeParse(req.body || {});
    if (!p.success) return res.status(400).json({ error: 'invalid_input', details: p.error.flatten() });
    const id = newId('lst');
    await pool.query(
      `INSERT INTO agent_market_listings (listing_id, poster_did, kind, title, description,
         category, budget_min_cents, budget_max_cents, delivery_deadline, required_skills)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [id, did, p.data.kind, p.data.title, p.data.description || null, p.data.category || null,
       p.data.budget_min_cents || null, p.data.budget_max_cents || null,
       p.data.delivery_deadline ? new Date(p.data.delivery_deadline).toISOString() : null,
       p.data.required_skills || null]
    );
    if (auditChain) await auditChain.append({ event_type: 'agent_market.listing_posted', listing_id: id, poster_did: did, kind: p.data.kind }).catch(() => {});
    res.status(201).json({ listing_id: id, status: 'open' });
  });

  app.get('/v1/agent-market/listings', async (req, res) => {
    const params = []; const conds = [`status='open'`];
    if (req.query.category) { params.push(req.query.category); conds.push(`category=$${params.length}`); }
    if (req.query.kind) { params.push(req.query.kind); conds.push(`kind=$${params.length}`); }
    const r = await pool.query(`SELECT listing_id, poster_did, kind, title, description, category,
                                budget_min_cents, budget_max_cents, bid_count, delivery_deadline, created_at
                                FROM agent_market_listings WHERE ${conds.join(' AND ')}
                                ORDER BY created_at DESC LIMIT 100`, params).catch(() => ({ rows: [] }));
    res.json({ listings: r.rows });
  });

  app.post('/v1/agent-market/listings/:lid/bids', express.json(), async (req, res) => {
    const did = req.headers['x-agent-did'];
    if (!did) return res.status(401).json({ error: 'agent_did_required' });
    const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const p = bidSchema.safeParse(req.body || {});
    if (!p.success) return res.status(400).json({ error: 'invalid_input', details: p.error.flatten() });

    // Pull bidder reputation score (best-effort)
    let rep = 0.5;
    try {
      const r = await pool.query(`SELECT score FROM reputation_scores WHERE agent_did=$1`, [did]).catch(() => ({ rows: [] }));
      if (r.rows[0]) rep = Number(r.rows[0].score);
    } catch {}

    const id = newId('bid');
    await pool.query(
      `INSERT INTO agent_market_bids (bid_id, listing_id, bidder_did, amount_cents,
         delivery_window, proposal, reputation_score)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [id, req.params.lid, did, p.data.amount_cents, p.data.delivery_window || null,
       p.data.proposal || null, rep]
    );
    await pool.query(`UPDATE agent_market_listings SET bid_count = bid_count + 1 WHERE listing_id=$1`, [req.params.lid]).catch(() => {});
    if (auditChain) await auditChain.append({ event_type: 'agent_market.bid_submitted', listing_id: req.params.lid, bid_id: id, bidder_did: did, amount_cents: p.data.amount_cents }).catch(() => {});
    res.status(201).json({ bid_id: id });
  });

  app.get('/v1/agent-market/listings/:lid/bids', async (req, res) => {
    const r = await pool.query(`
      SELECT bid_id, bidder_did, amount_cents, delivery_window, proposal, reputation_score, status, submitted_at
      FROM agent_market_bids WHERE listing_id=$1 ORDER BY reputation_score DESC, amount_cents ASC LIMIT 100
    `, [req.params.lid]).catch(() => ({ rows: [] }));
    res.json({ bids: r.rows });
  });

  app.post('/v1/agent-market/bids/:bid/accept', async (req, res) => {
    const did = req.headers['x-agent-did'];
    if (!did) return res.status(401).json({ error: 'agent_did_required' });
    const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
    if (!auth.valid) return res.status(401).json({ error: auth.error });

    const bid = await pool.query(`SELECT * FROM agent_market_bids WHERE bid_id=$1`, [req.params.bid]).catch(() => ({ rows: [] }));
    if (!bid.rows[0]) return res.status(404).json({ error: 'not_found' });
    const listing = await pool.query(`SELECT poster_did FROM agent_market_listings WHERE listing_id=$1`, [bid.rows[0].listing_id]).catch(() => ({ rows: [] }));
    if (!listing.rows[0] || listing.rows[0].poster_did !== did) return res.status(403).json({ error: 'only_poster_can_accept' });

    // Escrow: hold the bid amount on the poster's bank ledger
    await pool.query(`UPDATE bank_accounts SET held_cents = held_cents + $1 WHERE agent_did=$2 AND balance_cents - held_cents >= $1`,
      [bid.rows[0].amount_cents, did]).catch(() => {});

    const eid = newId('eng');
    await pool.query(
      `INSERT INTO agent_market_engagements (engagement_id, listing_id, bid_id,
         poster_did, worker_did, amount_cents, status)
       VALUES ($1,$2,$3,$4,$5,$6,'in_progress')`,
      [eid, bid.rows[0].listing_id, req.params.bid, did, bid.rows[0].bidder_did, bid.rows[0].amount_cents]
    );
    await pool.query(`UPDATE agent_market_listings SET status='engaged', selected_bid_id=$1 WHERE listing_id=$2`,
      [req.params.bid, bid.rows[0].listing_id]).catch(() => {});
    await pool.query(`UPDATE agent_market_bids SET status='accepted' WHERE bid_id=$1`, [req.params.bid]).catch(() => {});
    if (auditChain) await auditChain.append({ event_type: 'agent_market.bid_accepted', engagement_id: eid, bid_id: req.params.bid }).catch(() => {});
    res.json({ engagement_id: eid });
  });

  app.post('/v1/agent-market/engagements/:eid/deliver', express.json(), async (req, res) => {
    const did = req.headers['x-agent-did'];
    if (!did) return res.status(401).json({ error: 'agent_did_required' });
    const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const e = await pool.query(`SELECT * FROM agent_market_engagements WHERE engagement_id=$1`, [req.params.eid]).catch(() => ({ rows: [] }));
    if (!e.rows[0]) return res.status(404).json({ error: 'not_found' });
    if (e.rows[0].worker_did !== did) return res.status(403).json({ error: 'only_worker_can_deliver' });
    await pool.query(`UPDATE agent_market_engagements SET delivered_at=NOW() WHERE engagement_id=$1`, [req.params.eid]).catch(() => {});
    if (auditChain) await auditChain.append({ event_type: 'agent_market.delivered', engagement_id: req.params.eid, worker_did: did }).catch(() => {});
    res.json({ engagement_id: req.params.eid, status: 'delivered' });
  });

  app.post('/v1/agent-market/engagements/:eid/release', express.json(), async (req, res) => {
    const did = req.headers['x-agent-did'];
    if (!did) return res.status(401).json({ error: 'agent_did_required' });
    const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const e = await pool.query(`SELECT * FROM agent_market_engagements WHERE engagement_id=$1`, [req.params.eid]).catch(() => ({ rows: [] }));
    if (!e.rows[0]) return res.status(404).json({ error: 'not_found' });
    if (e.rows[0].poster_did !== did) return res.status(403).json({ error: 'only_poster_can_release' });
    if (!e.rows[0].delivered_at) return res.status(409).json({ error: 'not_delivered' });

    const stars = req.body?.stars;
    const text = req.body?.text;
    const amount = Number(e.rows[0].amount_cents);
    const platformCut = Math.floor(amount * 0.20); // 20% take rate
    const workerNet = amount - platformCut;

    // Release escrow → debit poster, credit worker
    await pool.query(`UPDATE bank_accounts SET balance_cents = balance_cents - $1, held_cents = GREATEST(0, held_cents - $1) WHERE agent_did=$2`,
      [amount, e.rows[0].poster_did]).catch(() => {});
    await pool.query(`UPDATE bank_accounts SET balance_cents = balance_cents + $1 WHERE agent_did=$2`,
      [workerNet, e.rows[0].worker_did]).catch(() => {});

    await pool.query(`UPDATE agent_market_engagements SET status='released', released_at=NOW(), review_stars=$1, review_text=$2 WHERE engagement_id=$3`,
      [stars || null, text || null, req.params.eid]).catch(() => {});

    await recordRevenueIfPossible(pool, 'extensions_marketplace', platformCut, e.rows[0].worker_did, req.params.eid);
    if (auditChain) await auditChain.append({ event_type: 'agent_market.released', engagement_id: req.params.eid, paid_cents: workerNet, platform_cut_cents: platformCut, stars }).catch(() => {});

    res.json({ engagement_id: req.params.eid, paid_cents: workerNet, platform_cut_cents: platformCut });
  });

  app.get('/v1/agents/:did/agent-market/engagements', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(`
      SELECT engagement_id, listing_id, poster_did, worker_did, amount_cents, status, delivered_at, released_at, review_stars, created_at
      FROM agent_market_engagements WHERE poster_did=$1 OR worker_did=$1
      ORDER BY created_at DESC LIMIT 200
    `, [did]).catch(() => ({ rows: [] }));
    res.json({ engagements: r.rows });
  });
}

module.exports = { migrate, registerAgentMarketRoutes };
