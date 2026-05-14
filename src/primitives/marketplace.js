// ============================================================================
// OpenHeab Marketplace — Agent-hire marketplace with escrow orders
// Listings + orders with bank-held escrow; 1% platform take, 99% to seller.
// ============================================================================
const express = require('express');
const cryptoLib = require('crypto');
const { z } = require('zod');

const PLATFORM_TAKE_BPS = 100;   // 1%
const SELLER_BPS = 10000 - PLATFORM_TAKE_BPS;

// ----------------------------------------------------------------------------
// Migration
// ----------------------------------------------------------------------------
async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS marketplace_listings (
      listing_id           TEXT PRIMARY KEY,
      seller_did           TEXT NOT NULL,
      title                TEXT NOT NULL,
      description          TEXT,
      category             TEXT,
      tags                 JSONB,
      price_cents          BIGINT NOT NULL,
      currency             TEXT NOT NULL DEFAULT 'USD',
      pricing_model        TEXT NOT NULL DEFAULT 'fixed',
      delivery_sla_seconds INTEGER,
      max_concurrent       INTEGER,
      schema_input         JSONB,
      schema_output        JSONB,
      api_endpoint         TEXT,
      status               TEXT NOT NULL DEFAULT 'active',
      orders_completed     INTEGER NOT NULL DEFAULT 0,
      orders_disputed      INTEGER NOT NULL DEFAULT 0,
      avg_rating           REAL,
      created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      audit_chain_entry    TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_mp_listings_seller ON marketplace_listings (seller_did);
    CREATE INDEX IF NOT EXISTS idx_mp_listings_category ON marketplace_listings (category) WHERE status='active';
    CREATE INDEX IF NOT EXISTS idx_mp_listings_status ON marketplace_listings (status);

    CREATE TABLE IF NOT EXISTS marketplace_orders (
      order_id          TEXT PRIMARY KEY,
      listing_id        TEXT NOT NULL,
      buyer_did         TEXT NOT NULL,
      seller_did        TEXT NOT NULL,
      quantity          INTEGER NOT NULL DEFAULT 1,
      unit_price_cents  BIGINT NOT NULL,
      total_cents       BIGINT NOT NULL,
      currency          TEXT NOT NULL DEFAULT 'USD',
      bank_hold_id      TEXT,
      input_payload     JSONB,
      output_payload    JSONB,
      status            TEXT NOT NULL DEFAULT 'pending',
      delivery_deadline TIMESTAMPTZ,
      rating            INTEGER,
      review_text       TEXT,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      delivered_at      TIMESTAMPTZ,
      accepted_at       TIMESTAMPTZ,
      audit_chain_entry TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_mp_orders_buyer ON marketplace_orders (buyer_did, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_mp_orders_seller ON marketplace_orders (seller_did, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_mp_orders_listing ON marketplace_orders (listing_id);
    CREATE INDEX IF NOT EXISTS idx_mp_orders_status ON marketplace_orders (status);
  `).catch(() => {});
}

// ----------------------------------------------------------------------------
// Idempotency
// ----------------------------------------------------------------------------
async function checkIdempotency(pool, agentDid, key, scope) {
  if (!key) return null;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS marketplace_idempotency (
      agent_did TEXT NOT NULL,
      scope TEXT NOT NULL,
      idem_key TEXT NOT NULL,
      response JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (agent_did, scope, idem_key)
    )`).catch(() => {});
  const r = await pool.query(
    `SELECT response FROM marketplace_idempotency WHERE agent_did=$1 AND scope=$2 AND idem_key=$3`,
    [agentDid, scope, key]
  ).catch(() => ({ rows: [] }));
  return r.rows[0]?.response || null;
}

async function recordIdempotency(pool, agentDid, key, scope, response) {
  if (!key) return;
  await pool.query(
    `INSERT INTO marketplace_idempotency (agent_did, scope, idem_key, response)
     VALUES ($1,$2,$3,$4::jsonb) ON CONFLICT DO NOTHING`,
    [agentDid, scope, key, JSON.stringify(response)]
  ).catch(() => {});
}

// ----------------------------------------------------------------------------
// Routes
// ----------------------------------------------------------------------------
function registerMarketplaceRoutes(app, pool, verifyAgentAuth, auditChain, bankModule) {
  // --------------------------------------------------------------------------
  // POST /v1/marketplace/listings
  // --------------------------------------------------------------------------
  const ListingSchema = z.object({
    seller_did: z.string(),
    title: z.string().min(1).max(500),
    description: z.string().max(20000).optional(),
    category: z.string().max(64).optional(),
    tags: z.array(z.string().max(64)).max(50).optional(),
    price_cents: z.number().int().nonnegative(),
    currency: z.string().length(3).optional(),
    pricing_model: z.enum(['fixed', 'per_unit', 'subscription', 'auction']).optional(),
    delivery_sla_seconds: z.number().int().positive().optional(),
    max_concurrent: z.number().int().positive().optional(),
    schema_input: z.any().optional(),
    schema_output: z.any().optional(),
    api_endpoint: z.string().url().optional()
  });

  app.post('/v1/marketplace/listings', express.json(), async (req, res) => {
    try {
      const parse = ListingSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const data = parse.data;

      const auth = await verifyAgentAuth(req, data.seller_did, { strictSignatureRequired: true });
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const idemKey = req.headers['x-idempotency-key'];
      const cached = await checkIdempotency(pool, data.seller_did, idemKey, 'listing-create');
      if (cached) return res.json(cached);

      const listingId = 'lst_' + cryptoLib.randomBytes(12).toString('hex');

      const chainEntry = await auditChain.append({
        event_type: 'marketplace.listing_created',
        listing_id: listingId,
        seller_did: data.seller_did,
        title: data.title,
        price_cents: data.price_cents,
        currency: data.currency || 'USD',
        timestamp: new Date().toISOString()
      });

      const ins = await pool.query(`
        INSERT INTO marketplace_listings
          (listing_id, seller_did, title, description, category, tags, price_cents, currency,
           pricing_model, delivery_sla_seconds, max_concurrent, schema_input, schema_output,
           api_endpoint, status, audit_chain_entry)
        VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11, $12::jsonb, $13::jsonb,
                $14, 'active', $15)
        RETURNING *
      `, [
        listingId, data.seller_did, data.title, data.description || null,
        data.category || null, data.tags ? JSON.stringify(data.tags) : null,
        data.price_cents, data.currency || 'USD',
        data.pricing_model || 'fixed',
        data.delivery_sla_seconds || null, data.max_concurrent || null,
        data.schema_input ? JSON.stringify(data.schema_input) : null,
        data.schema_output ? JSON.stringify(data.schema_output) : null,
        data.api_endpoint || null, chainEntry.hash
      ]);

      const response = { ...ins.rows[0], audit_chain_entry: chainEntry.hash };
      await recordIdempotency(pool, data.seller_did, idemKey, 'listing-create', response);
      return res.status(201).json(response);
    } catch (e) {
      console.error('[marketplace.listing]', e);
      return res.status(500).json({ error: 'listing_failed', message: e.message });
    }
  });

  // --------------------------------------------------------------------------
  // GET /v1/marketplace/listings (filters)
  // --------------------------------------------------------------------------
  app.get('/v1/marketplace/listings', async (req, res) => {
    const params = [];
    const conditions = [`status = 'active'`];

    if (req.query.category) {
      params.push(req.query.category);
      conditions.push(`category = $${params.length}`);
    }
    if (req.query.q) {
      params.push(`%${req.query.q}%`);
      conditions.push(`(title ILIKE $${params.length} OR description ILIKE $${params.length})`);
    }
    if (req.query.tag) {
      params.push(JSON.stringify([req.query.tag]));
      conditions.push(`tags @> $${params.length}::jsonb`);
    }
    if (req.query.max_price_cents) {
      params.push(parseInt(req.query.max_price_cents));
      conditions.push(`price_cents <= $${params.length}`);
    }
    if (req.query.seller_did) {
      params.push(req.query.seller_did);
      conditions.push(`seller_did = $${params.length}`);
    }

    let orderBy = 'created_at DESC';
    if (req.query.sort === 'price_asc') orderBy = 'price_cents ASC';
    else if (req.query.sort === 'price_desc') orderBy = 'price_cents DESC';
    else if (req.query.sort === 'rating') orderBy = 'avg_rating DESC NULLS LAST';
    else if (req.query.sort === 'popular') orderBy = 'orders_completed DESC';

    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const offset = Math.max(parseInt(req.query.offset) || 0, 0);
    params.push(limit, offset);

    const r = await pool.query(
      `SELECT * FROM marketplace_listings
       WHERE ${conditions.join(' AND ')}
       ORDER BY ${orderBy}
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    ).catch(() => ({ rows: [] }));

    return res.json({ listings: r.rows, count: r.rows.length });
  });

  // --------------------------------------------------------------------------
  // GET /v1/marketplace/listings/:id
  // --------------------------------------------------------------------------
  app.get('/v1/marketplace/listings/:id', async (req, res) => {
    const r = await pool.query(
      `SELECT * FROM marketplace_listings WHERE listing_id = $1`,
      [req.params.id]
    ).catch(() => ({ rows: [] }));
    if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
    return res.json(r.rows[0]);
  });

  // --------------------------------------------------------------------------
  // POST /v1/marketplace/listings/:id/order — buyer creates order with escrow
  // --------------------------------------------------------------------------
  const OrderSchema = z.object({
    buyer_did: z.string(),
    quantity: z.number().int().positive().optional(),
    input_payload: z.any().optional()
  });

  app.post('/v1/marketplace/listings/:id/order', express.json(), async (req, res) => {
    try {
      const parse = OrderSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });

      const auth = await verifyAgentAuth(req, parse.data.buyer_did, { strictSignatureRequired: true });
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const listingR = await pool.query(
        `SELECT * FROM marketplace_listings WHERE listing_id=$1`,
        [req.params.id]
      );
      if (!listingR.rows[0]) return res.status(404).json({ error: 'listing_not_found' });
      const listing = listingR.rows[0];
      if (listing.status !== 'active') return res.status(400).json({ error: 'listing_not_active' });
      if (listing.seller_did === parse.data.buyer_did) {
        return res.status(400).json({ error: 'cannot_order_own_listing' });
      }

      const idemKey = req.headers['x-idempotency-key'];
      const cached = await checkIdempotency(pool, parse.data.buyer_did, idemKey, `order:${listing.listing_id}`);
      if (cached) return res.json(cached);

      const qty = parse.data.quantity || 1;
      const total = parseInt(listing.price_cents) * qty;
      const orderId = 'ord_' + cryptoLib.randomBytes(12).toString('hex');

      let bankHoldId = null;
      if (bankModule && typeof bankModule.handleHold === 'function') {
        try {
          const hold = await bankModule.handleHold(pool, {
            agent_did: parse.data.buyer_did,
            amount_cents: total,
            currency: listing.currency || 'USD',
            reason: 'marketplace_order',
            external_ref: orderId,
            description: `Order for listing ${listing.listing_id}`
          }, auditChain);
          bankHoldId = hold?.hold_id || hold?.id || null;
        } catch (e) {
          return res.status(400).json({ error: 'hold_failed', message: e.message });
        }
      }

      const deadline = listing.delivery_sla_seconds
        ? new Date(Date.now() + listing.delivery_sla_seconds * 1000)
        : null;

      const chainEntry = await auditChain.append({
        event_type: 'marketplace.order_created',
        order_id: orderId,
        listing_id: listing.listing_id,
        buyer_did: parse.data.buyer_did,
        seller_did: listing.seller_did,
        total_cents: total,
        currency: listing.currency || 'USD',
        bank_hold_id: bankHoldId,
        timestamp: new Date().toISOString()
      });

      const ins = await pool.query(`
        INSERT INTO marketplace_orders
          (order_id, listing_id, buyer_did, seller_did, quantity, unit_price_cents,
           total_cents, currency, bank_hold_id, input_payload, status, delivery_deadline,
           audit_chain_entry)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, 'pending', $11, $12)
        RETURNING *
      `, [
        orderId, listing.listing_id, parse.data.buyer_did, listing.seller_did,
        qty, listing.price_cents, total, listing.currency || 'USD',
        bankHoldId,
        parse.data.input_payload ? JSON.stringify(parse.data.input_payload) : null,
        deadline, chainEntry.hash
      ]);

      const response = { ...ins.rows[0], audit_chain_entry: chainEntry.hash };
      await recordIdempotency(pool, parse.data.buyer_did, idemKey, `order:${listing.listing_id}`, response);
      return res.status(201).json(response);
    } catch (e) {
      console.error('[marketplace.order]', e);
      return res.status(500).json({ error: 'order_failed', message: e.message });
    }
  });

  // --------------------------------------------------------------------------
  // POST /v1/marketplace/orders/:id/deliver — seller marks delivered
  // --------------------------------------------------------------------------
  const DeliverSchema = z.object({
    seller_did: z.string(),
    output_payload: z.any().optional()
  });

  app.post('/v1/marketplace/orders/:id/deliver', express.json(), async (req, res) => {
    try {
      const parse = DeliverSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });

      const auth = await verifyAgentAuth(req, parse.data.seller_did, { strictSignatureRequired: true });
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const orderR = await pool.query(
        `SELECT * FROM marketplace_orders WHERE order_id=$1`, [req.params.id]
      );
      if (!orderR.rows[0]) return res.status(404).json({ error: 'not_found' });
      const order = orderR.rows[0];
      if (order.seller_did !== parse.data.seller_did) {
        return res.status(403).json({ error: 'not_seller' });
      }
      if (!['pending', 'accepted_by_seller', 'in_progress'].includes(order.status)) {
        return res.status(400).json({ error: 'invalid_state', status: order.status });
      }

      const chainEntry = await auditChain.append({
        event_type: 'marketplace.order_delivered',
        order_id: order.order_id,
        seller_did: order.seller_did,
        timestamp: new Date().toISOString()
      });

      await pool.query(
        `UPDATE marketplace_orders SET status='delivered', delivered_at=NOW(),
                                       output_payload=$2::jsonb, audit_chain_entry=$3
         WHERE order_id=$1`,
        [
          order.order_id,
          parse.data.output_payload ? JSON.stringify(parse.data.output_payload) : null,
          chainEntry.hash
        ]
      );

      return res.json({ order_id: order.order_id, status: 'delivered', audit_chain_entry: chainEntry.hash });
    } catch (e) {
      console.error('[marketplace.deliver]', e);
      return res.status(500).json({ error: 'deliver_failed', message: e.message });
    }
  });

  // --------------------------------------------------------------------------
  // POST /v1/marketplace/orders/:id/accept — buyer captures hold (1%/99% split)
  // --------------------------------------------------------------------------
  const AcceptSchema = z.object({
    buyer_did: z.string(),
    rating: z.number().int().min(1).max(5).optional(),
    review_text: z.string().max(5000).optional()
  });

  app.post('/v1/marketplace/orders/:id/accept', express.json(), async (req, res) => {
    try {
      const parse = AcceptSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });

      const auth = await verifyAgentAuth(req, parse.data.buyer_did, { strictSignatureRequired: true });
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const orderR = await pool.query(
        `SELECT * FROM marketplace_orders WHERE order_id=$1`, [req.params.id]
      );
      if (!orderR.rows[0]) return res.status(404).json({ error: 'not_found' });
      const order = orderR.rows[0];
      if (order.buyer_did !== parse.data.buyer_did) return res.status(403).json({ error: 'not_buyer' });
      if (order.status !== 'delivered') return res.status(400).json({ error: 'not_delivered', status: order.status });

      const total = parseInt(order.total_cents);
      const platformTake = Math.floor((total * PLATFORM_TAKE_BPS) / 10000);
      const sellerShare = total - platformTake;

      // Capture/release hold by transferring to seller. We call handleHoldRelease
      // with a capture intent — the bank module is expected to support this shape.
      if (bankModule && typeof bankModule.handleHoldRelease === 'function' && order.bank_hold_id) {
        try {
          await bankModule.handleHoldRelease(pool, {
            hold_id: order.bank_hold_id,
            agent_did: order.buyer_did,
            capture: true,
            recipient_did: order.seller_did,
            amount_cents: sellerShare,
            platform_take_cents: platformTake,
            currency: order.currency || 'USD',
            reason: 'marketplace_order_capture',
            external_ref: order.order_id
          }, auditChain);
        } catch (e) {
          return res.status(400).json({ error: 'capture_failed', message: e.message });
        }
      }

      const chainEntry = await auditChain.append({
        event_type: 'marketplace.order_accepted',
        order_id: order.order_id,
        buyer_did: order.buyer_did,
        seller_did: order.seller_did,
        total_cents: total,
        seller_share_cents: sellerShare,
        platform_take_cents: platformTake,
        rating: parse.data.rating || null,
        timestamp: new Date().toISOString()
      });

      await pool.query(
        `UPDATE marketplace_orders SET status='accepted', accepted_at=NOW(),
                                       rating=$2, review_text=$3, audit_chain_entry=$4
         WHERE order_id=$1`,
        [order.order_id, parse.data.rating || null, parse.data.review_text || null, chainEntry.hash]
      );

      await pool.query(
        `UPDATE marketplace_listings
         SET orders_completed = orders_completed + 1,
             avg_rating = (
               SELECT AVG(rating)::real FROM marketplace_orders
               WHERE listing_id = $1 AND rating IS NOT NULL
             ),
             updated_at = NOW()
         WHERE listing_id = $1`,
        [order.listing_id]
      ).catch(() => {});

      return res.json({
        order_id: order.order_id,
        status: 'accepted',
        seller_share_cents: sellerShare,
        platform_take_cents: platformTake,
        audit_chain_entry: chainEntry.hash
      });
    } catch (e) {
      console.error('[marketplace.accept]', e);
      return res.status(500).json({ error: 'accept_failed', message: e.message });
    }
  });

  // --------------------------------------------------------------------------
  // POST /v1/marketplace/orders/:id/reject — buyer rejects, refund
  // --------------------------------------------------------------------------
  const RejectSchema = z.object({
    buyer_did: z.string(),
    reason: z.string().max(5000).optional()
  });

  app.post('/v1/marketplace/orders/:id/reject', express.json(), async (req, res) => {
    try {
      const parse = RejectSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });

      const auth = await verifyAgentAuth(req, parse.data.buyer_did, { strictSignatureRequired: true });
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const orderR = await pool.query(
        `SELECT * FROM marketplace_orders WHERE order_id=$1`, [req.params.id]
      );
      if (!orderR.rows[0]) return res.status(404).json({ error: 'not_found' });
      const order = orderR.rows[0];
      if (order.buyer_did !== parse.data.buyer_did) return res.status(403).json({ error: 'not_buyer' });
      if (!['pending', 'accepted_by_seller', 'in_progress', 'delivered'].includes(order.status)) {
        return res.status(400).json({ error: 'invalid_state', status: order.status });
      }

      if (bankModule && typeof bankModule.handleHoldRelease === 'function' && order.bank_hold_id) {
        try {
          await bankModule.handleHoldRelease(pool, {
            hold_id: order.bank_hold_id,
            agent_did: order.buyer_did,
            capture: false,
            reason: 'marketplace_order_refund',
            external_ref: order.order_id
          }, auditChain);
        } catch (e) {
          console.warn('[marketplace.reject] release failed:', e.message);
        }
      }

      const chainEntry = await auditChain.append({
        event_type: 'marketplace.order_rejected',
        order_id: order.order_id,
        buyer_did: order.buyer_did,
        reason: parse.data.reason || null,
        timestamp: new Date().toISOString()
      });

      await pool.query(
        `UPDATE marketplace_orders SET status='rejected', audit_chain_entry=$2
         WHERE order_id=$1`,
        [order.order_id, chainEntry.hash]
      );

      return res.json({ order_id: order.order_id, status: 'rejected', audit_chain_entry: chainEntry.hash });
    } catch (e) {
      console.error('[marketplace.reject]', e);
      return res.status(500).json({ error: 'reject_failed', message: e.message });
    }
  });

  // --------------------------------------------------------------------------
  // GET /v1/marketplace/orders?role=buyer|seller
  // --------------------------------------------------------------------------
  app.get('/v1/marketplace/orders', async (req, res) => {
    const did = req.query.agent_did || req.query.did;
    const role = req.query.role || 'buyer';
    if (!did) return res.status(400).json({ error: 'agent_did_required' });

    const auth = await verifyAgentAuth(req, String(did));
    if (!auth.valid) return res.status(401).json({ error: auth.error });

    const col = role === 'seller' ? 'seller_did' : 'buyer_did';
    const statusFilter = req.query.status ? `AND status = $2` : '';
    const params = req.query.status ? [did, req.query.status] : [did];

    const r = await pool.query(
      `SELECT * FROM marketplace_orders
       WHERE ${col} = $1 ${statusFilter}
       ORDER BY created_at DESC
       LIMIT 200`,
      params
    ).catch(() => ({ rows: [] }));

    return res.json({ orders: r.rows, count: r.rows.length, role });
  });
}

module.exports = {
  migrate,
  registerMarketplaceRoutes,
  PLATFORM_TAKE_BPS,
  SELLER_BPS
};
