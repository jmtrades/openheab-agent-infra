// ============================================================================
// stripe_adapter.js — REAL Stripe Checkout + Connect + webhook handling.
// When STRIPE_SECRET_KEY set, hits api.stripe.com. Webhook signature
// verification per Stripe's spec.
// ============================================================================
const crypto = require('crypto');
const { z } = require('zod');

const BASE = 'https://api.stripe.com/v1';
const STRIPE_API_VERSION = '2024-11-20.acacia';

async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS stripe_customers (
      customer_id   TEXT PRIMARY KEY,
      agent_did     TEXT,
      org_id        TEXT,
      email         TEXT,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS stripe_events (
      event_id      TEXT PRIMARY KEY,
      kind          TEXT NOT NULL,
      payload       JSONB NOT NULL,
      signature_ok  BOOLEAN,
      processed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_stripe_events_kind ON stripe_events (kind, processed_at DESC);
  `);
}

// Verify Stripe signature per https://stripe.com/docs/webhooks/signatures
function verifyStripeSignature(rawBody, header, secret) {
  if (!header || !secret) return false;
  const parts = String(header).split(',').reduce((m, p) => { const [k, v] = p.split('='); m[k] = v; return m; }, {});
  if (!parts.t || !parts.v1) return false;
  const signedPayload = `${parts.t}.${typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8')}`;
  const expected = crypto.createHmac('sha256', secret).update(signedPayload).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(parts.v1));
}

async function stripeAPI(path, method = 'GET', body = null, idempotencyKey = null) {
  if (!process.env.STRIPE_SECRET_KEY) return { stub: true, path, method };
  if (typeof fetch !== 'function') throw new Error('fetch_unavailable');
  const headers = {
    authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`,
    'stripe-version': STRIPE_API_VERSION,
    'content-type': 'application/x-www-form-urlencoded'
  };
  if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
  const formBody = body ? new URLSearchParams(flatten(body)).toString() : undefined;
  const r = await fetch(`${BASE}${path}`, { method, headers, body: formBody });
  const json = await r.json();
  if (!r.ok) throw new Error(`stripe_${r.status}_${json.error?.message || JSON.stringify(json).slice(0, 200)}`);
  return json;
}

function flatten(obj, prefix = '') {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) v.forEach((x, i) => Object.assign(out, flatten(x, `${key}[${i}]`)));
    else if (v && typeof v === 'object') Object.assign(out, flatten(v, key));
    else if (v != null) out[key] = String(v);
  }
  return out;
}

const checkoutSchema = z.object({
  price_id: z.string(),
  customer_email: z.string().email().optional(),
  success_url: z.string().url(),
  cancel_url: z.string().url(),
  metadata: z.record(z.string()).optional()
});

function registerStripeAdapterRoutes(app, pool, verifyAgentAuth, auditChain) {
  const express = require('express');

  app.post('/v1/agents/:did/stripe/checkout', express.json(), async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const p = checkoutSchema.safeParse(req.body || {});
    if (!p.success) return res.status(400).json({ error: 'invalid_input', details: p.error.flatten() });
    try {
      const session = await stripeAPI('/checkout/sessions', 'POST', {
        mode: 'subscription',
        payment_method_types: ['card'],
        line_items: [{ price: p.data.price_id, quantity: 1 }],
        success_url: p.data.success_url,
        cancel_url: p.data.cancel_url,
        customer_email: p.data.customer_email,
        metadata: { agent_did: did, ...(p.data.metadata || {}) }
      }, `chk_${did}_${Date.now()}`);
      if (auditChain) await auditChain.append({ event_type: 'stripe.checkout_session_created', agent_did: did, session_id: session.id, stub: !!session.stub }).catch(() => {});
      res.status(201).json(session);
    } catch (e) { res.status(502).json({ error: 'stripe_failed', message: e.message }); }
  });

  app.post('/v1/_webhooks/stripe-real', express.raw({ type: 'application/json' }), async (req, res) => {
    const sig = req.headers['stripe-signature'];
    const ok = verifyStripeSignature(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    let event;
    try { event = JSON.parse(req.body.toString('utf8')); } catch { return res.status(400).json({ error: 'bad_json' }); }
    if (!ok && process.env.NODE_ENV === 'production') return res.status(400).json({ error: 'signature_invalid' });
    await pool.query(`INSERT INTO stripe_events (event_id, kind, payload, signature_ok) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
      [event.id || `evt_${crypto.randomBytes(10).toString('hex')}`, event.type, JSON.stringify(event), ok]).catch(() => {});

    if (event.type === 'checkout.session.completed' || event.type === 'customer.subscription.created') {
      const orgId = event.data?.object?.client_reference_id || event.data?.object?.metadata?.org_id;
      if (orgId) {
        await pool.query(`UPDATE orgs SET plan='pro' WHERE org_id=$1`, [orgId]).catch(() => {});
        try {
          const rev = require('./revenue');
          await rev.recordRevenue({ pool, source_layer: 'subscriptions', amount_cents: event.data?.object?.amount_total || 0, org_id: orgId });
        } catch {}
      }
    }
    if (auditChain) await auditChain.append({ event_type: 'stripe.webhook', stripe_event_type: event.type, signature_ok: ok }).catch(() => {});
    res.json({ received: true, signature_valid: ok });
  });

  app.get('/v1/admin/stripe/events', async (req, res) => {
    const { safeTokenCompare: _stc } = require('../safe_compare'); if (!_stc(req.headers['x-admin-token'], process.env.OPERATOR_ADMIN_TOKEN)) return res.status(401).json({ error: 'admin_auth_required' });
    const r = await pool.query(`SELECT event_id, kind, signature_ok, processed_at FROM stripe_events ORDER BY processed_at DESC LIMIT 200`).catch(() => ({ rows: [] }));
    res.json({ events: r.rows, configured: !!process.env.STRIPE_SECRET_KEY });
  });
}

module.exports = { migrate, registerStripeAdapterRoutes, stripeAPI, verifyStripeSignature };
