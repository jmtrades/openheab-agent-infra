// ============================================================================
// OpenHeab Shopping — Amazon / eBay / Walmart / Shopify retailer integration.
// Agents search products, build a cart, checkout, and track orders end-to-end.
// Retailer APIs are stubbed for tests; cost.recordCost runs on every order.
// ============================================================================
const express = require('express');
const cryptoLib = require('crypto');
const { z } = require('zod');

const RETAILERS = ['amazon', 'ebay', 'walmart', 'shopify', 'target', 'stub'];
const CART_STATUSES = ['open', 'checked_out', 'abandoned'];
const ORDER_STATUSES = ['pending', 'confirmed', 'shipped', 'delivered', 'cancelled', 'returned'];

// Per-order operational cost — covers the agent infra overhead per checkout.
const PER_ORDER_COST_CENTS = 10;

// ----------------------------------------------------------------------------
// Migration
// ----------------------------------------------------------------------------
async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS shopping_carts (
      cart_id        TEXT PRIMARY KEY,
      agent_did      TEXT NOT NULL,
      items          JSONB NOT NULL DEFAULT '[]'::jsonb,
      subtotal_cents BIGINT NOT NULL DEFAULT 0,
      currency       TEXT NOT NULL DEFAULT 'USD',
      status         TEXT NOT NULL DEFAULT 'open',
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_shopping_carts_agent ON shopping_carts (agent_did, status);

    CREATE TABLE IF NOT EXISTS shopping_orders (
      order_id           TEXT PRIMARY KEY,
      agent_did          TEXT NOT NULL,
      retailer           TEXT NOT NULL,
      retailer_order_id  TEXT,
      items              JSONB NOT NULL,
      subtotal_cents     BIGINT NOT NULL,
      tax_cents          BIGINT NOT NULL DEFAULT 0,
      shipping_cents     BIGINT NOT NULL DEFAULT 0,
      total_cents        BIGINT NOT NULL,
      currency           TEXT NOT NULL DEFAULT 'USD',
      shipping_address   JSONB,
      status             TEXT NOT NULL DEFAULT 'pending',
      tracking_number    TEXT,
      payment_method     TEXT,
      placed_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      delivered_at       TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_shopping_orders_agent ON shopping_orders (agent_did, placed_at DESC);
    CREATE INDEX IF NOT EXISTS idx_shopping_orders_status ON shopping_orders (status, placed_at DESC);

    CREATE TABLE IF NOT EXISTS shopping_products_cache (
      product_id     TEXT NOT NULL,
      retailer       TEXT NOT NULL,
      title          TEXT,
      description    TEXT,
      price_cents    BIGINT,
      availability   TEXT,
      image_url      TEXT,
      attributes     JSONB,
      last_synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (retailer, product_id)
    );
    CREATE INDEX IF NOT EXISTS idx_shopping_products_title ON shopping_products_cache USING gin (to_tsvector('english', COALESCE(title,'')));
  `).catch(() => {});
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------
function genId(prefix) { return `${prefix}_${cryptoLib.randomBytes(12).toString('hex')}`; }

function computeSubtotal(items) {
  return (items || []).reduce(
    (acc, it) => acc + Number(it.unit_price_cents || 0) * Number(it.quantity || 1),
    0
  );
}

// Stub retailer search: returns deterministic results from query.
function stubRetailerSearch(query, retailer = 'amazon', limit = 10) {
  const seed = cryptoLib.createHash('sha256').update(`${retailer}:${query}`).digest();
  const results = [];
  for (let i = 0; i < limit; i++) {
    const idx = seed.readUInt32BE((i * 4) % (seed.length - 4));
    results.push({
      product_id: `${retailer}_${(idx % 1_000_000).toString().padStart(7, '0')}_${i}`,
      retailer,
      title: `${query.slice(0, 60)} — Product ${i + 1}`,
      price_cents: 999 + (idx % 50_000),
      availability: (idx % 10) > 1 ? 'in_stock' : 'out_of_stock',
      image_url: `https://example.com/${retailer}/${i}.jpg`,
      attributes: { rating: 3.5 + ((idx % 15) / 10), reviews: idx % 5000 }
    });
  }
  return results;
}

async function getOrCreateCart(pool, did) {
  const r = await pool.query(
    `SELECT * FROM shopping_carts WHERE agent_did=$1 AND status='open'
     ORDER BY created_at DESC LIMIT 1`, [did]
  ).catch(() => ({ rows: [] }));
  if (r.rows[0]) return r.rows[0];
  const cartId = genId('cart');
  await pool.query(
    `INSERT INTO shopping_carts (cart_id, agent_did) VALUES ($1, $2)`,
    [cartId, did]
  );
  return { cart_id: cartId, agent_did: did, items: [], subtotal_cents: 0, currency: 'USD', status: 'open' };
}

// ----------------------------------------------------------------------------
// Routes
// ----------------------------------------------------------------------------
function registerShoppingRoutes(app, pool, verifyAgentAuth, auditChain) {
  // POST /v1/shopping/search — product search (public, but rate-limited upstream)
  const SearchSchema = z.object({
    query: z.string().min(1).max(500),
    retailer: z.enum(RETAILERS).optional(),
    limit: z.number().int().min(1).max(50).optional()
  });
  app.post('/v1/shopping/search', express.json(), async (req, res) => {
    try {
      const parse = SearchSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;
      const retailer = d.retailer || 'amazon';
      const limit = d.limit || 10;
      const results = stubRetailerSearch(d.query, retailer, limit);
      // Cache results
      for (const p of results) {
        await pool.query(
          `INSERT INTO shopping_products_cache
             (product_id, retailer, title, price_cents, availability, image_url, attributes)
           VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
           ON CONFLICT (retailer, product_id) DO UPDATE
             SET title=$3, price_cents=$4, availability=$5, image_url=$6,
                 attributes=$7::jsonb, last_synced_at=NOW()`,
          [p.product_id, p.retailer, p.title, p.price_cents,
           p.availability, p.image_url, JSON.stringify(p.attributes)]
        ).catch(() => {});
      }
      return res.json({ query: d.query, retailer, results });
    } catch (e) { return res.status(500).json({ error: 'search_failed', message: e.message }); }
  });

  // POST /v1/agents/:did/shopping/cart — add item
  const AddItemSchema = z.object({
    product_id: z.string().min(1).max(200),
    retailer: z.enum(RETAILERS),
    quantity: z.number().int().positive().max(1000).optional(),
    unit_price_cents: z.number().int().positive().optional()
  });
  app.post('/v1/agents/:did/shopping/cart', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const parse = AddItemSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;
      const cart = await getOrCreateCart(pool, did);

      // Look up product price if not provided
      let unitPrice = d.unit_price_cents;
      if (!unitPrice) {
        const p = await pool.query(
          `SELECT price_cents FROM shopping_products_cache WHERE retailer=$1 AND product_id=$2`,
          [d.retailer, d.product_id]
        ).catch(() => ({ rows: [] }));
        unitPrice = p.rows[0]?.price_cents ? Number(p.rows[0].price_cents) : 999;
      }

      const items = Array.isArray(cart.items) ? [...cart.items] : [];
      const existing = items.findIndex(it => it.product_id === d.product_id && it.retailer === d.retailer);
      const qty = d.quantity || 1;
      if (existing >= 0) {
        items[existing].quantity = Number(items[existing].quantity || 1) + qty;
      } else {
        items.push({
          product_id: d.product_id, retailer: d.retailer,
          quantity: qty, unit_price_cents: unitPrice
        });
      }
      const subtotal = computeSubtotal(items);
      await pool.query(
        `UPDATE shopping_carts SET items=$2::jsonb, subtotal_cents=$3, updated_at=NOW()
         WHERE cart_id=$1`,
        [cart.cart_id, JSON.stringify(items), subtotal]
      );
      await auditChain.append({
        event_type: 'shopping.cart_item_added', cart_id: cart.cart_id,
        agent_did: did, product_id: d.product_id, retailer: d.retailer,
        quantity: qty, timestamp: new Date().toISOString()
      });
      return res.json({ cart_id: cart.cart_id, items, subtotal_cents: subtotal });
    } catch (e) { return res.status(500).json({ error: 'add_failed', message: e.message }); }
  });

  // GET /v1/agents/:did/shopping/cart
  app.get('/v1/agents/:did/shopping/cart', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const cart = await getOrCreateCart(pool, did);
    return res.json(cart);
  });

  // DELETE /v1/agents/:did/shopping/cart/items/:product_id
  app.delete('/v1/agents/:did/shopping/cart/items/:product_id', async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const cart = await getOrCreateCart(pool, did);
      const items = (Array.isArray(cart.items) ? cart.items : [])
        .filter(it => it.product_id !== req.params.product_id);
      const subtotal = computeSubtotal(items);
      await pool.query(
        `UPDATE shopping_carts SET items=$2::jsonb, subtotal_cents=$3, updated_at=NOW()
         WHERE cart_id=$1`,
        [cart.cart_id, JSON.stringify(items), subtotal]
      );
      await auditChain.append({
        event_type: 'shopping.cart_item_removed', cart_id: cart.cart_id,
        agent_did: did, product_id: req.params.product_id,
        timestamp: new Date().toISOString()
      });
      return res.json({ cart_id: cart.cart_id, items, subtotal_cents: subtotal });
    } catch (e) { return res.status(500).json({ error: 'remove_failed', message: e.message }); }
  });

  // POST /v1/agents/:did/shopping/checkout
  const CheckoutSchema = z.object({
    shipping_address: z.object({
      name: z.string().max(200),
      line1: z.string().max(300),
      line2: z.string().max(300).optional(),
      city: z.string().max(120),
      region: z.string().max(120).optional(),
      postal_code: z.string().max(40),
      country: z.string().min(2).max(3)
    }),
    payment_method: z.string().max(60).optional()
  });
  app.post('/v1/agents/:did/shopping/checkout', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const parse = CheckoutSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;

      const cart = await getOrCreateCart(pool, did);
      const items = Array.isArray(cart.items) ? cart.items : [];
      if (!items.length) return res.status(400).json({ error: 'cart_empty' });

      // Group items by retailer -> one shopping_order per retailer
      const byRetailer = {};
      for (const it of items) {
        if (!byRetailer[it.retailer]) byRetailer[it.retailer] = [];
        byRetailer[it.retailer].push(it);
      }

      const orderIds = [];
      for (const [retailer, retailerItems] of Object.entries(byRetailer)) {
        const subtotal = computeSubtotal(retailerItems);
        const tax = Math.round(subtotal * 0.0825);
        const shipping = subtotal >= 5000 ? 0 : 599;
        const total = subtotal + tax + shipping;
        const orderId = genId('shop_ord');
        const retailerOrderId = `${retailer}_${cryptoLib.randomBytes(6).toString('hex')}`;
        await pool.query(
          `INSERT INTO shopping_orders
             (order_id, agent_did, retailer, retailer_order_id, items,
              subtotal_cents, tax_cents, shipping_cents, total_cents,
              currency, shipping_address, status, payment_method)
           VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11::jsonb,'confirmed',$12)`,
          [orderId, did, retailer, retailerOrderId, JSON.stringify(retailerItems),
           subtotal, tax, shipping, total, cart.currency || 'USD',
           JSON.stringify(d.shipping_address), d.payment_method || 'wallet']
        );
        orderIds.push(orderId);

        try {
          const cost = require('./cost');
          if (cost && typeof cost.recordCost === 'function') {
            await cost.recordCost(pool, {
              agent_did: did,
              resource_type: 'shopping_order',
              provider: retailer,
              amount_cents: PER_ORDER_COST_CENTS,
              units: retailerItems.length,
              unit_type: 'items',
              reference_id: orderId,
              tags: { retailer, total_cents: total }
            });
          }
        } catch {}

        await auditChain.append({
          event_type: 'shopping.order_placed', order_id: orderId,
          agent_did: did, retailer, total_cents: total,
          timestamp: new Date().toISOString()
        });
      }

      // Close cart
      await pool.query(
        `UPDATE shopping_carts SET status='checked_out', updated_at=NOW()
         WHERE cart_id=$1`,
        [cart.cart_id]
      );
      return res.status(201).json({ orders: orderIds, count: orderIds.length });
    } catch (e) { return res.status(500).json({ error: 'checkout_failed', message: e.message }); }
  });

  // GET /v1/agents/:did/shopping/orders
  app.get('/v1/agents/:did/shopping/orders', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(
      `SELECT * FROM shopping_orders WHERE agent_did=$1 ORDER BY placed_at DESC LIMIT 200`,
      [did]
    ).catch(() => ({ rows: [] }));
    return res.json({ orders: r.rows, count: r.rows.length });
  });

  // GET /v1/agents/:did/shopping/orders/:id
  app.get('/v1/agents/:did/shopping/orders/:id', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(
      `SELECT * FROM shopping_orders WHERE order_id=$1 AND agent_did=$2`,
      [req.params.id, did]
    ).catch(() => ({ rows: [] }));
    if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
    return res.json(r.rows[0]);
  });

  // POST /v1/agents/:did/shopping/orders/:id/cancel
  app.post('/v1/agents/:did/shopping/orders/:id/cancel', async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const r = await pool.query(
        `UPDATE shopping_orders SET status='cancelled'
         WHERE order_id=$1 AND agent_did=$2 AND status IN ('pending','confirmed')
         RETURNING order_id, status`,
        [req.params.id, did]
      ).catch(() => ({ rows: [] }));
      if (!r.rows[0]) return res.status(409).json({ error: 'not_cancellable' });
      await auditChain.append({
        event_type: 'shopping.order_cancelled', order_id: req.params.id,
        agent_did: did, timestamp: new Date().toISOString()
      });
      return res.json(r.rows[0]);
    } catch (e) { return res.status(500).json({ error: 'cancel_failed', message: e.message }); }
  });

  // POST /v1/agents/:did/shopping/orders/:id/return
  const ReturnSchema = z.object({
    reason: z.string().max(2000).optional(),
    items: z.array(z.string()).optional()
  });
  app.post('/v1/agents/:did/shopping/orders/:id/return', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const parse = ReturnSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const r = await pool.query(
        `UPDATE shopping_orders SET status='returned'
         WHERE order_id=$1 AND agent_did=$2 AND status IN ('delivered','shipped','confirmed')
         RETURNING order_id, status, retailer`,
        [req.params.id, did]
      ).catch(() => ({ rows: [] }));
      if (!r.rows[0]) return res.status(409).json({ error: 'not_returnable' });
      await auditChain.append({
        event_type: 'shopping.order_returned', order_id: req.params.id,
        agent_did: did, reason: parse.data.reason || null,
        timestamp: new Date().toISOString()
      });
      return res.json(r.rows[0]);
    } catch (e) { return res.status(500).json({ error: 'return_failed', message: e.message }); }
  });
}

module.exports = {
  migrate,
  registerShoppingRoutes,
  stubRetailerSearch,
  computeSubtotal,
  RETAILERS,
  CART_STATUSES,
  ORDER_STATUSES
};
