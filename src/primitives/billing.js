// ============================================================================
// OpenHeab Billing — Subscription billing for the agent's OWN customers
// (not OpenHeab's billing). Stripe-style product/price/customer/subscription
// model with usage records. Cron generates invoices when periods elapse.
// ============================================================================
const express = require('express');
const cryptoLib = require('crypto');
const { z } = require('zod');

const PRODUCT_KINDS = ['one_time', 'subscription', 'usage'];
const INTERVALS = ['month', 'year', 'once'];
const USAGE_TYPES = ['licensed', 'metered'];
const SUB_STATUSES = ['active', 'past_due', 'cancelled', 'trialing'];
const PAYMENT_METHODS = ['usdc', 'card'];

async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS billing_products (
      product_id   TEXT PRIMARY KEY,
      agent_did    TEXT NOT NULL,
      name         TEXT NOT NULL,
      description  TEXT,
      kind         TEXT NOT NULL DEFAULT 'subscription',
      currency     TEXT NOT NULL DEFAULT 'USD',
      active       BOOLEAN NOT NULL DEFAULT TRUE,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_billing_products_agent ON billing_products (agent_did);

    CREATE TABLE IF NOT EXISTS billing_prices (
      price_id     TEXT PRIMARY KEY,
      product_id   TEXT NOT NULL,
      agent_did    TEXT NOT NULL,
      amount_cents BIGINT NOT NULL,
      interval     TEXT NOT NULL DEFAULT 'month',
      usage_type   TEXT NOT NULL DEFAULT 'licensed',
      currency     TEXT NOT NULL DEFAULT 'USD',
      active       BOOLEAN NOT NULL DEFAULT TRUE,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_billing_prices_product ON billing_prices (product_id);

    CREATE TABLE IF NOT EXISTS billing_customers (
      customer_id      TEXT PRIMARY KEY,
      agent_did        TEXT NOT NULL,
      did_link         TEXT,
      email            TEXT,
      name             TEXT,
      payment_method   TEXT,
      default_payment  JSONB DEFAULT '{}'::jsonb,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_billing_customers_agent ON billing_customers (agent_did);

    CREATE TABLE IF NOT EXISTS billing_subscriptions (
      subscription_id        TEXT PRIMARY KEY,
      agent_did              TEXT NOT NULL,
      customer_id            TEXT NOT NULL,
      price_id               TEXT NOT NULL,
      status                 TEXT NOT NULL DEFAULT 'active',
      current_period_start   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      current_period_end     TIMESTAMPTZ,
      trial_end              TIMESTAMPTZ,
      cancel_at_period_end   BOOLEAN NOT NULL DEFAULT FALSE,
      created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_billing_subscriptions_agent ON billing_subscriptions (agent_did);
    CREATE INDEX IF NOT EXISTS idx_billing_subscriptions_period ON billing_subscriptions (current_period_end);

    CREATE TABLE IF NOT EXISTS billing_usage (
      usage_id         TEXT PRIMARY KEY,
      subscription_id  TEXT NOT NULL,
      agent_did        TEXT NOT NULL,
      quantity         NUMERIC NOT NULL DEFAULT 0,
      recorded_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      meta             JSONB
    );
    CREATE INDEX IF NOT EXISTS idx_billing_usage_sub ON billing_usage (subscription_id, recorded_at);

    CREATE TABLE IF NOT EXISTS billing_invoices_link (
      invoice_id       TEXT PRIMARY KEY,
      subscription_id  TEXT,
      agent_did        TEXT NOT NULL,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `).catch(() => {});
}

function genId(prefix) { return `${prefix}_${cryptoLib.randomBytes(12).toString('hex')}`; }

function addInterval(dt, interval) {
  const d = new Date(dt);
  if (interval === 'year') d.setUTCFullYear(d.getUTCFullYear() + 1);
  else if (interval === 'month') d.setUTCMonth(d.getUTCMonth() + 1);
  return d;
}

function registerBillingRoutes(app, pool, verifyAgentAuth, auditChain) {
  // POST /v1/agents/:did/billing/products
  const ProductSchema = z.object({
    name: z.string().min(1).max(300),
    description: z.string().max(5000).optional(),
    kind: z.enum(PRODUCT_KINDS).optional(),
    currency: z.string().length(3).optional()
  });
  app.post('/v1/agents/:did/billing/products', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const parse = ProductSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;
      const productId = genId('prod');
      await pool.query(
        `INSERT INTO billing_products (product_id, agent_did, name, description, kind, currency)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [productId, did, d.name, d.description || null, d.kind || 'subscription', d.currency || 'USD']
      );
      await auditChain.append({
        event_type: 'billing.product_created', product_id: productId, agent_did: did,
        timestamp: new Date().toISOString()
      });
      return res.status(201).json({ product_id: productId, name: d.name });
    } catch (e) { return res.status(500).json({ error: 'create_failed', message: e.message }); }
  });

  app.get('/v1/agents/:did/billing/products', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(`SELECT * FROM billing_products WHERE agent_did=$1 ORDER BY created_at DESC`, [did]).catch(() => ({ rows: [] }));
    return res.json({ products: r.rows, count: r.rows.length });
  });

  // POST /v1/agents/:did/billing/prices
  const PriceSchema = z.object({
    product_id: z.string(),
    amount_cents: z.number().int().positive(),
    interval: z.enum(INTERVALS).optional(),
    usage_type: z.enum(USAGE_TYPES).optional(),
    currency: z.string().length(3).optional()
  });
  app.post('/v1/agents/:did/billing/prices', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const parse = PriceSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;
      const prod = await pool.query(
        `SELECT product_id FROM billing_products WHERE product_id=$1 AND agent_did=$2`,
        [d.product_id, did]
      ).catch(() => ({ rows: [] }));
      if (!prod.rows[0]) return res.status(404).json({ error: 'product_not_found' });
      const priceId = genId('price');
      await pool.query(
        `INSERT INTO billing_prices (price_id, product_id, agent_did, amount_cents, interval, usage_type, currency)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [priceId, d.product_id, did, d.amount_cents, d.interval || 'month',
         d.usage_type || 'licensed', d.currency || 'USD']
      );
      await auditChain.append({
        event_type: 'billing.price_created', price_id: priceId, product_id: d.product_id,
        agent_did: did, amount_cents: d.amount_cents, timestamp: new Date().toISOString()
      });
      return res.status(201).json({ price_id: priceId, amount_cents: d.amount_cents, interval: d.interval || 'month' });
    } catch (e) { return res.status(500).json({ error: 'create_failed', message: e.message }); }
  });

  app.get('/v1/agents/:did/billing/prices', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(`SELECT * FROM billing_prices WHERE agent_did=$1 ORDER BY created_at DESC`, [did]).catch(() => ({ rows: [] }));
    return res.json({ prices: r.rows, count: r.rows.length });
  });

  // POST /v1/agents/:did/billing/customers
  const CustomerSchema = z.object({
    did_link: z.string().optional(),
    email: z.string().email().optional(),
    name: z.string().max(300).optional(),
    payment_method: z.enum(PAYMENT_METHODS).optional(),
    default_payment: z.record(z.any()).optional()
  });
  app.post('/v1/agents/:did/billing/customers', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const parse = CustomerSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;
      const customerId = genId('cust');
      await pool.query(
        `INSERT INTO billing_customers (customer_id, agent_did, did_link, email, name,
                                         payment_method, default_payment)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
        [customerId, did, d.did_link || null, d.email || null, d.name || null,
         d.payment_method || null, JSON.stringify(d.default_payment || {})]
      );
      await auditChain.append({
        event_type: 'billing.customer_created', customer_id: customerId, agent_did: did,
        timestamp: new Date().toISOString()
      });
      return res.status(201).json({ customer_id: customerId });
    } catch (e) { return res.status(500).json({ error: 'create_failed', message: e.message }); }
  });

  app.get('/v1/agents/:did/billing/customers', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(`SELECT * FROM billing_customers WHERE agent_did=$1 ORDER BY created_at DESC`, [did]).catch(() => ({ rows: [] }));
    return res.json({ customers: r.rows, count: r.rows.length });
  });

  // POST /v1/agents/:did/billing/subscriptions
  const SubSchema = z.object({
    customer_id: z.string(),
    price_id: z.string(),
    trial_days: z.number().int().min(0).max(365).optional()
  });
  app.post('/v1/agents/:did/billing/subscriptions', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const parse = SubSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;
      const price = await pool.query(
        `SELECT * FROM billing_prices WHERE price_id=$1 AND agent_did=$2`,
        [d.price_id, did]
      ).catch(() => ({ rows: [] }));
      if (!price.rows[0]) return res.status(404).json({ error: 'price_not_found' });
      const subId = genId('sub');
      const now = new Date();
      const trialEnd = d.trial_days ? new Date(Date.now() + d.trial_days * 86400_000) : null;
      const periodEnd = addInterval(trialEnd || now, price.rows[0].interval);
      const status = trialEnd ? 'trialing' : 'active';
      await pool.query(
        `INSERT INTO billing_subscriptions (subscription_id, agent_did, customer_id, price_id,
                                             status, current_period_start, current_period_end, trial_end)
         VALUES ($1,$2,$3,$4,$5, NOW(), $6, $7)`,
        [subId, did, d.customer_id, d.price_id, status, periodEnd, trialEnd]
      );
      await auditChain.append({
        event_type: 'billing.subscription_created', subscription_id: subId, agent_did: did,
        customer_id: d.customer_id, price_id: d.price_id, timestamp: new Date().toISOString()
      });
      return res.status(201).json({ subscription_id: subId, status, current_period_end: periodEnd });
    } catch (e) { return res.status(500).json({ error: 'create_failed', message: e.message }); }
  });

  // POST /v1/agents/:did/billing/subscriptions/:id/cancel
  app.post('/v1/agents/:did/billing/subscriptions/:id/cancel', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const atPeriodEnd = req.body && req.body.at_period_end !== false;
      let r;
      if (atPeriodEnd) {
        r = await pool.query(
          `UPDATE billing_subscriptions SET cancel_at_period_end=TRUE
           WHERE subscription_id=$1 AND agent_did=$2 RETURNING subscription_id, status, current_period_end`,
          [req.params.id, did]
        ).catch(() => ({ rows: [] }));
      } else {
        r = await pool.query(
          `UPDATE billing_subscriptions SET status='cancelled', cancel_at_period_end=TRUE
           WHERE subscription_id=$1 AND agent_did=$2 RETURNING subscription_id, status`,
          [req.params.id, did]
        ).catch(() => ({ rows: [] }));
      }
      if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
      await auditChain.append({
        event_type: 'billing.subscription_cancelled', subscription_id: req.params.id,
        agent_did: did, at_period_end: atPeriodEnd, timestamp: new Date().toISOString()
      });
      return res.json(r.rows[0]);
    } catch (e) { return res.status(500).json({ error: 'cancel_failed', message: e.message }); }
  });

  // POST /v1/agents/:did/billing/usage
  const UsageSchema = z.object({
    subscription_id: z.string(),
    quantity: z.number().positive(),
    meta: z.record(z.any()).optional()
  });
  app.post('/v1/agents/:did/billing/usage', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const parse = UsageSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;
      const usageId = genId('use');
      await pool.query(
        `INSERT INTO billing_usage (usage_id, subscription_id, agent_did, quantity, meta)
         VALUES ($1,$2,$3,$4,$5::jsonb)`,
        [usageId, d.subscription_id, did, d.quantity, JSON.stringify(d.meta || {})]
      );
      await auditChain.append({
        event_type: 'billing.usage_recorded', usage_id: usageId, subscription_id: d.subscription_id,
        agent_did: did, quantity: d.quantity, timestamp: new Date().toISOString()
      });
      return res.status(201).json({ usage_id: usageId, quantity: d.quantity });
    } catch (e) { return res.status(500).json({ error: 'usage_failed', message: e.message }); }
  });

  // GET /v1/agents/:did/billing/mrr
  app.get('/v1/agents/:did/billing/mrr', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(
      `SELECT
         SUM(CASE WHEN p.interval='month' THEN p.amount_cents
                  WHEN p.interval='year' THEN p.amount_cents / 12
                  ELSE 0 END)::bigint AS mrr_cents,
         COUNT(*) FILTER (WHERE s.status='active') AS active_subs,
         COUNT(*) FILTER (WHERE s.status='trialing') AS trialing_subs
       FROM billing_subscriptions s
       JOIN billing_prices p ON p.price_id = s.price_id
       WHERE s.agent_did=$1 AND s.status IN ('active','trialing')`,
      [did]
    ).catch(() => ({ rows: [{ mrr_cents: 0, active_subs: 0, trialing_subs: 0 }] }));
    return res.json({ agent_did: did, ...r.rows[0] });
  });
}

// Cron: bill expired periods. Creates a linked invoice and rolls period forward.
async function billingCycleCron(pool, auditChain) {
  const r = await pool.query(
    `SELECT s.*, p.amount_cents, p.interval, p.currency FROM billing_subscriptions s
     JOIN billing_prices p ON p.price_id = s.price_id
     WHERE s.status IN ('active','trialing','past_due')
       AND s.current_period_end <= NOW()
     LIMIT 200`
  ).catch(() => ({ rows: [] }));
  let generated = 0;
  for (const sub of r.rows) {
    if (sub.cancel_at_period_end) {
      await pool.query(`UPDATE billing_subscriptions SET status='cancelled' WHERE subscription_id=$1`, [sub.subscription_id]).catch(() => {});
      continue;
    }
    const invoiceId = `inv_${cryptoLib.randomBytes(12).toString('hex')}`;
    await pool.query(
      `INSERT INTO billing_invoices_link (invoice_id, subscription_id, agent_did) VALUES ($1,$2,$3)`,
      [invoiceId, sub.subscription_id, sub.agent_did]
    ).catch(() => {});
    const newEnd = addInterval(sub.current_period_end, sub.interval);
    await pool.query(
      `UPDATE billing_subscriptions
         SET current_period_start = current_period_end,
             current_period_end = $1,
             status='active'
       WHERE subscription_id=$2`,
      [newEnd, sub.subscription_id]
    ).catch(() => {});
    generated++;
    if (auditChain) {
      await auditChain.append({
        event_type: 'billing.cycle_invoiced', subscription_id: sub.subscription_id,
        agent_did: sub.agent_did, invoice_id: invoiceId,
        amount_cents: sub.amount_cents, timestamp: new Date().toISOString()
      });
    }
  }
  return { processed: r.rows.length, generated };
}

module.exports = {
  migrate, registerBillingRoutes, billingCycleCron, addInterval,
  PRODUCT_KINDS, INTERVALS, USAGE_TYPES, SUB_STATUSES, PAYMENT_METHODS
};
