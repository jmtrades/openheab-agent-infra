// ============================================================================
// OpenHeab Subscriptions — OpenHeab's OWN paid plans (Free/Pro/Scale/Enterprise)
// ----------------------------------------------------------------------------
// THIS IS THE #1 REVENUE BLOCKER. Without it we cannot charge customers
// (orgs) for using OpenHeab. Every paid org has exactly one active subscription.
// Stripe is wired in when STRIPE_SECRET_KEY is set; otherwise we fall back to
// a stub mode that records the subscription locally without billing.
// ============================================================================

const express = require('express');
const cryptoLib = require('crypto');
const { z } = require('zod');
const { registerCron } = require('../cron_auth');

const PLAN_CODES = ['free', 'pro', 'scale', 'enterprise'];
const SUB_STATUSES = ['active', 'past_due', 'cancelled', 'trialing'];
const PLAN_STATUSES = ['active', 'sunset'];
const BILLING_INTERVALS = ['monthly', 'annual'];
const CHANGE_KINDS = ['upgrade', 'downgrade', 'cancel', 'reactivate'];
const INVOICE_STATUSES = ['draft', 'open', 'paid', 'uncollectible', 'void'];

function genId(prefix) {
  return `${prefix}_${cryptoLib.randomBytes(12).toString('hex')}`;
}

function getStripe() {
  if (!process.env.STRIPE_SECRET_KEY) return null;
  try {
    const Stripe = require('stripe');
    return new Stripe(process.env.STRIPE_SECRET_KEY);
  } catch {
    return null;
  }
}

const DEFAULT_PLANS = [
  {
    code: 'free',
    name: 'Free',
    price_cents: 0,
    billing_interval: 'monthly',
    included_quotas: {
      inference_calls: 1000,
      agents: 1,
      storage_gb: 1
    },
    overage_rates: {}
  },
  {
    code: 'pro',
    name: 'Pro',
    price_cents: 9900,
    billing_interval: 'monthly',
    included_quotas: {
      inference_calls: 100000,
      agents: 10,
      storage_gb: 50
    },
    overage_rates: {
      inference_calls: 0.001,
      storage_gb: 5
    }
  },
  {
    code: 'scale',
    name: 'Scale',
    price_cents: 34900,
    billing_interval: 'monthly',
    included_quotas: {
      inference_calls: 1000000,
      agents: 100,
      storage_gb: 500,
      priority_support: true
    },
    overage_rates: {
      inference_calls: 0.0008,
      storage_gb: 4
    }
  },
  {
    code: 'enterprise',
    name: 'Enterprise',
    price_cents: 249900,
    billing_interval: 'monthly',
    included_quotas: {
      inference_calls: null,
      agents: null,
      storage_gb: null,
      sso: true,
      custom_contracts: true,
      dedicated_support: true
    },
    overage_rates: {}
  }
];

// ----------------------------------------------------------------------------
// Migration
// ----------------------------------------------------------------------------
async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS subscription_plans (
      plan_id           TEXT PRIMARY KEY,
      code              TEXT NOT NULL UNIQUE,
      name              TEXT NOT NULL,
      price_cents       BIGINT NOT NULL DEFAULT 0,
      billing_interval  TEXT NOT NULL DEFAULT 'monthly',
      included_quotas   JSONB NOT NULL DEFAULT '{}'::jsonb,
      overage_rates     JSONB NOT NULL DEFAULT '{}'::jsonb,
      stripe_price_id   TEXT,
      status            TEXT NOT NULL DEFAULT 'active',
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS subscriptions (
      sub_id                  TEXT PRIMARY KEY,
      org_id                  TEXT NOT NULL,
      plan_code               TEXT NOT NULL,
      status                  TEXT NOT NULL DEFAULT 'active',
      current_period_start    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      current_period_end      TIMESTAMPTZ,
      trial_end               TIMESTAMPTZ,
      cancel_at_period_end    BOOLEAN NOT NULL DEFAULT FALSE,
      stripe_subscription_id  TEXT,
      created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_subscriptions_org ON subscriptions (org_id);
    CREATE INDEX IF NOT EXISTS idx_subscriptions_status ON subscriptions (status);
    CREATE INDEX IF NOT EXISTS idx_subscriptions_period_end ON subscriptions (current_period_end);

    CREATE TABLE IF NOT EXISTS subscription_changes (
      change_id        TEXT PRIMARY KEY,
      sub_id           TEXT NOT NULL,
      kind             TEXT NOT NULL,
      from_plan        TEXT,
      to_plan          TEXT,
      effective_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_by_did   TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_sub_changes_sub ON subscription_changes (sub_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS subscription_invoices (
      invoice_id       TEXT PRIMARY KEY,
      sub_id           TEXT NOT NULL,
      org_id           TEXT NOT NULL,
      period_start     TIMESTAMPTZ NOT NULL,
      period_end       TIMESTAMPTZ NOT NULL,
      base_cents       BIGINT NOT NULL DEFAULT 0,
      overage_cents    BIGINT NOT NULL DEFAULT 0,
      total_cents      BIGINT NOT NULL DEFAULT 0,
      status           TEXT NOT NULL DEFAULT 'draft',
      stripe_invoice_id TEXT,
      paid_at          TIMESTAMPTZ,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_sub_invoices_org ON subscription_invoices (org_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_sub_invoices_status ON subscription_invoices (status);
  `).catch(() => {});

  // Seed default plans (idempotent)
  for (const p of DEFAULT_PLANS) {
    await pool.query(
      `INSERT INTO subscription_plans (plan_id, code, name, price_cents, billing_interval,
                                        included_quotas, overage_rates, status)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,'active')
       ON CONFLICT (code) DO UPDATE SET
         name = EXCLUDED.name,
         price_cents = EXCLUDED.price_cents,
         included_quotas = EXCLUDED.included_quotas,
         overage_rates = EXCLUDED.overage_rates`,
      [
        'plan_' + p.code,
        p.code,
        p.name,
        p.price_cents,
        p.billing_interval,
        JSON.stringify(p.included_quotas),
        JSON.stringify(p.overage_rates)
      ]
    ).catch(() => {});
  }
}

// ----------------------------------------------------------------------------
// Helpers (exported)
// ----------------------------------------------------------------------------
async function getActiveSubscription(pool, orgId) {
  const r = await pool.query(
    `SELECT s.*, p.included_quotas, p.overage_rates, p.price_cents, p.billing_interval, p.name AS plan_name
       FROM subscriptions s
       JOIN subscription_plans p ON p.code = s.plan_code
      WHERE s.org_id = $1 AND s.status IN ('active','trialing','past_due')
      ORDER BY s.created_at DESC LIMIT 1`,
    [orgId]
  ).catch(() => ({ rows: [] }));
  return r.rows[0] || null;
}

async function checkQuota(pool, orgId, quotaKey, amount) {
  const sub = await getActiveSubscription(pool, orgId);
  const planCode = sub?.plan_code || 'free';

  // Compute usage so far this period (best-effort, joins meter_aggregates if present)
  let used = 0;
  try {
    const period = (() => {
      const d = new Date();
      return d.getUTCFullYear() * 100 + (d.getUTCMonth() + 1);
    })();
    const u = await pool.query(
      `SELECT total_quantity FROM meter_aggregates
        WHERE org_id = $1 AND kind = $2 AND period_yyyymm = $3`,
      [orgId, quotaKey, period]
    ).catch(() => ({ rows: [] }));
    used = parseFloat(u.rows[0]?.total_quantity || 0);
  } catch { used = 0; }

  const includedQuotas = sub?.included_quotas || {};
  const overageRates = sub?.overage_rates || {};
  const limit = includedQuotas[quotaKey];

  // Unlimited (null in JSON) means always allowed, no overage
  if (limit === null) {
    return { allowed: true, remaining: null, plan: planCode, overage_cost_cents: 0, unlimited: true };
  }
  if (typeof limit === 'undefined') {
    return { allowed: false, remaining: 0, plan: planCode, overage_cost_cents: 0, error: 'quota_not_in_plan' };
  }

  const remaining = Math.max(0, Number(limit) - used);
  if (used + amount <= Number(limit)) {
    return { allowed: true, remaining: remaining - amount, plan: planCode, overage_cost_cents: 0 };
  }

  // Over limit; only allow if plan has overage rate for this key
  const overageRate = overageRates[quotaKey];
  if (overageRate === undefined || overageRate === null) {
    return { allowed: false, remaining, plan: planCode, overage_cost_cents: 0, error: 'quota_exceeded' };
  }
  const overageUnits = (used + amount) - Number(limit);
  const overage_cost_cents = Math.ceil(overageUnits * Number(overageRate) * 100);
  return { allowed: true, remaining: 0, plan: planCode, overage_cost_cents, in_overage: true };
}

// ----------------------------------------------------------------------------
// Routes
// ----------------------------------------------------------------------------
function registerSubscriptionsRoutes(app, pool, verifyAgentAuth, auditChain) {
  const stripe = getStripe();

  // Lazy-load org helpers (to avoid circular requires at module load)
  let orgMod = null;
  function loadOrg() { try { orgMod = orgMod || require('./org'); } catch {} return orgMod; }

  async function ensureOrgPermission(req, res, orgId, minRole) {
    const auth = await verifyAgentAuth(req, null);
    if (!auth.valid) { res.status(401).json({ error: auth.error || 'unauthorized' }); return null; }
    const org = loadOrg();
    if (!org) { res.status(500).json({ error: 'org_module_unavailable' }); return null; }
    const ok = await org.requireOrgRole(pool, orgId, auth.subject, minRole);
    if (!ok) { res.status(403).json({ error: `${minRole}_required` }); return null; }
    return auth;
  }

  // GET /v1/subscriptions/plans (public)
  app.get('/v1/subscriptions/plans', async (_req, res) => {
    const r = await pool.query(
      `SELECT code, name, price_cents, billing_interval, included_quotas, overage_rates, status
         FROM subscription_plans WHERE status = 'active' ORDER BY price_cents ASC`
    ).catch(() => ({ rows: [] }));
    return res.json({ plans: r.rows });
  });

  // POST /v1/orgs/:id/subscription
  const SubscribeSchema = z.object({
    plan_code: z.enum(PLAN_CODES),
    trial_days: z.number().int().min(0).max(90).optional(),
    payment_method_id: z.string().optional(),
    billing_interval: z.enum(BILLING_INTERVALS).optional()
  });

  app.post('/v1/orgs/:id/subscription', express.json(), async (req, res) => {
    try {
      const auth = await ensureOrgPermission(req, res, req.params.id, 'admin');
      if (!auth) return;

      const parse = SubscribeSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;

      const planRow = await pool.query(
        `SELECT * FROM subscription_plans WHERE code = $1 AND status = 'active'`,
        [d.plan_code]
      ).catch(() => ({ rows: [] }));
      if (!planRow.rows[0]) return res.status(404).json({ error: 'plan_not_found' });

      // Cancel any existing active sub
      await pool.query(
        `UPDATE subscriptions SET status='cancelled', updated_at=NOW()
          WHERE org_id = $1 AND status IN ('active','trialing','past_due')`,
        [req.params.id]
      ).catch(() => {});

      const subId = genId('sub');
      const now = new Date();
      const trialEnd = d.trial_days ? new Date(Date.now() + d.trial_days * 86400_000) : null;
      const periodStart = trialEnd || now;
      const periodEnd = new Date(periodStart);
      if (d.billing_interval === 'annual') periodEnd.setUTCFullYear(periodEnd.getUTCFullYear() + 1);
      else periodEnd.setUTCMonth(periodEnd.getUTCMonth() + 1);

      let stripeSubId = null;
      let stripeCustomerId = null;
      if (stripe && d.payment_method_id) {
        try {
          const orgRow = await pool.query(
            `SELECT stripe_customer_id, billing_email, name FROM orgs WHERE org_id = $1`,
            [req.params.id]
          ).catch(() => ({ rows: [] }));
          stripeCustomerId = orgRow.rows[0]?.stripe_customer_id || null;
          if (!stripeCustomerId) {
            const customer = await stripe.customers.create({
              email: orgRow.rows[0]?.billing_email || undefined,
              name: orgRow.rows[0]?.name || undefined,
              metadata: { org_id: req.params.id }
            });
            stripeCustomerId = customer.id;
            await pool.query(`UPDATE orgs SET stripe_customer_id = $1 WHERE org_id = $2`,
              [stripeCustomerId, req.params.id]).catch(() => {});
          }
          if (planRow.rows[0].stripe_price_id) {
            const stripeSub = await stripe.subscriptions.create({
              customer: stripeCustomerId,
              items: [{ price: planRow.rows[0].stripe_price_id }],
              default_payment_method: d.payment_method_id,
              trial_end: trialEnd ? Math.floor(trialEnd.getTime() / 1000) : undefined,
              metadata: { org_id: req.params.id, sub_id: subId }
            });
            stripeSubId = stripeSub.id;
          }
        } catch (e) {
          console.warn('[subscriptions] stripe error:', e.message);
        }
      }

      const status = trialEnd ? 'trialing' : 'active';
      await pool.query(
        `INSERT INTO subscriptions (sub_id, org_id, plan_code, status, current_period_start,
                                     current_period_end, trial_end, stripe_subscription_id)
         VALUES ($1,$2,$3,$4,NOW(),$5,$6,$7)`,
        [subId, req.params.id, d.plan_code, status, periodEnd, trialEnd, stripeSubId]
      );
      await pool.query(
        `UPDATE orgs SET plan = $1, updated_at = NOW() WHERE org_id = $2`,
        [d.plan_code, req.params.id]
      ).catch(() => {});

      await pool.query(
        `INSERT INTO subscription_changes (change_id, sub_id, kind, from_plan, to_plan, created_by_did)
         VALUES ($1,$2,'upgrade',NULL,$3,$4)`,
        [genId('chg'), subId, d.plan_code, auth.subject]
      ).catch(() => {});

      await auditChain.append({
        event_type: 'subscription.created', sub_id: subId, org_id: req.params.id,
        plan_code: d.plan_code, status, trial_end: trialEnd,
        stripe_subscription_id: stripeSubId, by_did: auth.subject,
        timestamp: new Date().toISOString()
      });

      return res.status(201).json({
        sub_id: subId, plan_code: d.plan_code, status,
        current_period_end: periodEnd, trial_end: trialEnd,
        stripe_subscription_id: stripeSubId, stub: !stripeSubId
      });
    } catch (e) {
      return res.status(500).json({ error: 'subscribe_failed', message: e.message });
    }
  });

  // GET /v1/orgs/:id/subscription
  app.get('/v1/orgs/:id/subscription', async (req, res) => {
    try {
      const auth = await ensureOrgPermission(req, res, req.params.id, 'viewer');
      if (!auth) return;
      const sub = await getActiveSubscription(pool, req.params.id);
      if (!sub) return res.status(404).json({ error: 'no_active_subscription' });
      return res.json(sub);
    } catch (e) {
      return res.status(500).json({ error: 'fetch_failed', message: e.message });
    }
  });

  // POST /v1/orgs/:id/subscription/upgrade
  const UpgradeSchema = z.object({ new_plan_code: z.enum(PLAN_CODES) });

  app.post('/v1/orgs/:id/subscription/upgrade', express.json(), async (req, res) => {
    try {
      const auth = await ensureOrgPermission(req, res, req.params.id, 'admin');
      if (!auth) return;

      const parse = UpgradeSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const newPlan = parse.data.new_plan_code;

      const cur = await getActiveSubscription(pool, req.params.id);
      if (!cur) return res.status(404).json({ error: 'no_active_subscription' });

      const planRow = await pool.query(
        `SELECT price_cents FROM subscription_plans WHERE code = $1`, [newPlan]
      ).catch(() => ({ rows: [] }));
      if (!planRow.rows[0]) return res.status(404).json({ error: 'plan_not_found' });

      const kind = parseInt(planRow.rows[0].price_cents) > parseInt(cur.price_cents || 0) ? 'upgrade' : 'downgrade';

      await pool.query(
        `UPDATE subscriptions SET plan_code = $1, updated_at = NOW(), cancel_at_period_end = FALSE
          WHERE sub_id = $2`,
        [newPlan, cur.sub_id]
      );
      await pool.query(`UPDATE orgs SET plan = $1, updated_at = NOW() WHERE org_id = $2`,
        [newPlan, req.params.id]).catch(() => {});

      if (stripe && cur.stripe_subscription_id) {
        try {
          const newPlanRow = await pool.query(
            `SELECT stripe_price_id FROM subscription_plans WHERE code = $1`, [newPlan]
          ).catch(() => ({ rows: [] }));
          if (newPlanRow.rows[0]?.stripe_price_id) {
            const sub = await stripe.subscriptions.retrieve(cur.stripe_subscription_id);
            await stripe.subscriptions.update(cur.stripe_subscription_id, {
              items: [{ id: sub.items.data[0].id, price: newPlanRow.rows[0].stripe_price_id }],
              proration_behavior: 'create_prorations'
            });
          }
        } catch (e) {
          console.warn('[subscriptions] stripe upgrade error:', e.message);
        }
      }

      await pool.query(
        `INSERT INTO subscription_changes (change_id, sub_id, kind, from_plan, to_plan, created_by_did)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [genId('chg'), cur.sub_id, kind, cur.plan_code, newPlan, auth.subject]
      ).catch(() => {});

      await auditChain.append({
        event_type: 'subscription.changed', sub_id: cur.sub_id, org_id: req.params.id,
        from_plan: cur.plan_code, to_plan: newPlan, kind,
        by_did: auth.subject, timestamp: new Date().toISOString()
      });

      return res.json({ sub_id: cur.sub_id, plan_code: newPlan, kind });
    } catch (e) {
      return res.status(500).json({ error: 'upgrade_failed', message: e.message });
    }
  });

  // POST /v1/orgs/:id/subscription/cancel
  app.post('/v1/orgs/:id/subscription/cancel', express.json(), async (req, res) => {
    try {
      const auth = await ensureOrgPermission(req, res, req.params.id, 'admin');
      if (!auth) return;
      const atPeriodEnd = req.body && req.body.at_period_end !== false;
      const cur = await getActiveSubscription(pool, req.params.id);
      if (!cur) return res.status(404).json({ error: 'no_active_subscription' });

      if (atPeriodEnd) {
        await pool.query(
          `UPDATE subscriptions SET cancel_at_period_end = TRUE, updated_at = NOW()
            WHERE sub_id = $1`, [cur.sub_id]
        );
      } else {
        await pool.query(
          `UPDATE subscriptions SET status = 'cancelled', cancel_at_period_end = TRUE,
                                     updated_at = NOW() WHERE sub_id = $1`, [cur.sub_id]
        );
        await pool.query(`UPDATE orgs SET plan = 'free', updated_at = NOW() WHERE org_id = $1`,
          [req.params.id]).catch(() => {});
      }

      if (stripe && cur.stripe_subscription_id) {
        try {
          if (atPeriodEnd) {
            await stripe.subscriptions.update(cur.stripe_subscription_id, { cancel_at_period_end: true });
          } else {
            await stripe.subscriptions.cancel(cur.stripe_subscription_id);
          }
        } catch (e) { console.warn('[subscriptions] stripe cancel error:', e.message); }
      }

      await pool.query(
        `INSERT INTO subscription_changes (change_id, sub_id, kind, from_plan, to_plan, created_by_did)
         VALUES ($1,$2,'cancel',$3,$3,$4)`,
        [genId('chg'), cur.sub_id, cur.plan_code, auth.subject]
      ).catch(() => {});

      await auditChain.append({
        event_type: 'subscription.cancelled', sub_id: cur.sub_id, org_id: req.params.id,
        at_period_end: atPeriodEnd, by_did: auth.subject, timestamp: new Date().toISOString()
      });

      return res.json({ sub_id: cur.sub_id, cancel_at_period_end: atPeriodEnd });
    } catch (e) {
      return res.status(500).json({ error: 'cancel_failed', message: e.message });
    }
  });

  // POST /v1/orgs/:id/subscription/reactivate
  app.post('/v1/orgs/:id/subscription/reactivate', express.json(), async (req, res) => {
    try {
      const auth = await ensureOrgPermission(req, res, req.params.id, 'admin');
      if (!auth) return;

      const r = await pool.query(
        `SELECT * FROM subscriptions
          WHERE org_id = $1 AND (cancel_at_period_end = TRUE OR status = 'cancelled')
          ORDER BY created_at DESC LIMIT 1`,
        [req.params.id]
      ).catch(() => ({ rows: [] }));
      if (!r.rows[0]) return res.status(404).json({ error: 'no_cancellable_sub' });
      const cur = r.rows[0];

      const newStatus = (cur.current_period_end && new Date(cur.current_period_end).getTime() > Date.now())
        ? 'active' : 'active';
      await pool.query(
        `UPDATE subscriptions SET status = $1, cancel_at_period_end = FALSE, updated_at = NOW()
          WHERE sub_id = $2`, [newStatus, cur.sub_id]
      );
      await pool.query(`UPDATE orgs SET plan = $1, updated_at = NOW() WHERE org_id = $2`,
        [cur.plan_code, req.params.id]).catch(() => {});

      if (stripe && cur.stripe_subscription_id) {
        try {
          await stripe.subscriptions.update(cur.stripe_subscription_id, { cancel_at_period_end: false });
        } catch (e) { console.warn('[subscriptions] stripe reactivate error:', e.message); }
      }

      await pool.query(
        `INSERT INTO subscription_changes (change_id, sub_id, kind, from_plan, to_plan, created_by_did)
         VALUES ($1,$2,'reactivate',$3,$3,$4)`,
        [genId('chg'), cur.sub_id, cur.plan_code, auth.subject]
      ).catch(() => {});

      await auditChain.append({
        event_type: 'subscription.reactivated', sub_id: cur.sub_id, org_id: req.params.id,
        by_did: auth.subject, timestamp: new Date().toISOString()
      });

      return res.json({ sub_id: cur.sub_id, status: newStatus });
    } catch (e) {
      return res.status(500).json({ error: 'reactivate_failed', message: e.message });
    }
  });

  // GET /v1/orgs/:id/invoices (paginated)
  app.get('/v1/orgs/:id/invoices', async (req, res) => {
    try {
      const auth = await ensureOrgPermission(req, res, req.params.id, 'billing');
      if (!auth) return;
      const limit = Math.min(parseInt(req.query.limit) || 50, 200);
      const offset = Math.max(parseInt(req.query.offset) || 0, 0);
      const r = await pool.query(
        `SELECT * FROM subscription_invoices WHERE org_id = $1
          ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
        [req.params.id, limit, offset]
      ).catch(() => ({ rows: [] }));
      return res.json({ invoices: r.rows, count: r.rows.length, limit, offset });
    } catch (e) {
      return res.status(500).json({ error: 'list_failed', message: e.message });
    }
  });

  // POST /v1/_webhooks/stripe-subscription
  // Uses express.raw so we hold the bytes Stripe actually signed. In production
  // STRIPE_WEBHOOK_SECRET is required — the handler refuses to act on unsigned
  // events to prevent anyone marking invoices paid or cancelling subscriptions.
  app.post('/v1/_webhooks/stripe-subscription', express.raw({ type: '*/*', limit: '2mb' }), async (req, res) => {
    try {
      let event;
      const secret = process.env.STRIPE_WEBHOOK_SECRET;
      if (stripe && secret) {
        const sig = req.headers['stripe-signature'];
        if (!sig) return res.status(400).json({ error: 'stripe_signature_missing' });
        try {
          event = stripe.webhooks.constructEvent(req.body, sig, secret);
        } catch (e) {
          return res.status(400).json({ error: `webhook_signature_invalid: ${e.message}` });
        }
      } else if (process.env.NODE_ENV === 'production') {
        return res.status(503).json({ error: 'webhook_secret_not_configured' });
      } else {
        // Dev fallback: accept unsigned events when STRIPE_WEBHOOK_SECRET is unset
        // AND we're not in production. Local test flows use this.
        try { event = JSON.parse(req.body.toString('utf8')); }
        catch { return res.status(400).json({ error: 'invalid_json' }); }
      }

      const type = event?.type || '';
      const obj = event?.data?.object || {};

      if (type.startsWith('customer.subscription.')) {
        const stripeSubId = obj.id;
        const status = obj.status; // active, trialing, past_due, canceled, etc.
        const periodEnd = obj.current_period_end ? new Date(obj.current_period_end * 1000) : null;
        const cancelAtPeriodEnd = !!obj.cancel_at_period_end;

        let mappedStatus = status;
        if (status === 'canceled') mappedStatus = 'cancelled';
        await pool.query(
          `UPDATE subscriptions
              SET status = $1, current_period_end = COALESCE($2, current_period_end),
                  cancel_at_period_end = $3, updated_at = NOW()
            WHERE stripe_subscription_id = $4`,
          [mappedStatus, periodEnd, cancelAtPeriodEnd, stripeSubId]
        ).catch(() => {});

        await auditChain.append({
          event_type: 'subscription.webhook', kind: type,
          stripe_subscription_id: stripeSubId, status: mappedStatus,
          timestamp: new Date().toISOString()
        });
      } else if (type === 'invoice.payment_succeeded' || type === 'invoice.paid') {
        const stripeInvId = obj.id;
        await pool.query(
          `UPDATE subscription_invoices SET status='paid', paid_at = NOW()
            WHERE stripe_invoice_id = $1`, [stripeInvId]
        ).catch(() => {});
        await auditChain.append({
          event_type: 'subscription.invoice_paid', stripe_invoice_id: stripeInvId,
          timestamp: new Date().toISOString()
        });
      } else if (type === 'invoice.payment_failed') {
        const stripeInvId = obj.id;
        await pool.query(
          `UPDATE subscription_invoices SET status='uncollectible' WHERE stripe_invoice_id = $1`,
          [stripeInvId]
        ).catch(() => {});
        await auditChain.append({
          event_type: 'subscription.invoice_failed', stripe_invoice_id: stripeInvId,
          timestamp: new Date().toISOString()
        });
      }

      return res.json({ received: true });
    } catch (e) {
      console.error('[stripe-subscription webhook]', e);
      return res.status(500).json({ error: 'webhook_failed', message: e.message });
    }
  });

  // Cron: roll over period-ended subs (creates next-period invoice draft)
  registerCron(app, '/v1/_jobs/subscriptions-cycle', async (_req, res) => {
    try {
      const r = await pool.query(
        `SELECT s.*, p.price_cents FROM subscriptions s
           JOIN subscription_plans p ON p.code = s.plan_code
          WHERE s.status IN ('active','trialing','past_due')
            AND s.current_period_end <= NOW()
          LIMIT 200`
      ).catch(() => ({ rows: [] }));
      let processed = 0;
      for (const sub of r.rows) {
        if (sub.cancel_at_period_end) {
          await pool.query(`UPDATE subscriptions SET status='cancelled', updated_at=NOW() WHERE sub_id=$1`,
            [sub.sub_id]).catch(() => {});
          await pool.query(`UPDATE orgs SET plan = 'free', updated_at = NOW() WHERE org_id = $1`,
            [sub.org_id]).catch(() => {});
          continue;
        }
        const invoiceId = genId('subinv');
        const newEnd = new Date(sub.current_period_end);
        newEnd.setUTCMonth(newEnd.getUTCMonth() + 1);
        await pool.query(
          `INSERT INTO subscription_invoices (invoice_id, sub_id, org_id, period_start,
              period_end, base_cents, total_cents, status)
           VALUES ($1,$2,$3,$4,$5,$6,$6,'draft')`,
          [invoiceId, sub.sub_id, sub.org_id, sub.current_period_start, sub.current_period_end,
           parseInt(sub.price_cents || 0)]
        ).catch(() => {});
        await pool.query(
          `UPDATE subscriptions
             SET current_period_start = current_period_end,
                 current_period_end = $1,
                 status = 'active', updated_at = NOW()
           WHERE sub_id = $2`,
          [newEnd, sub.sub_id]
        ).catch(() => {});
        processed++;
      }
      return res.json({ processed });
    } catch (e) {
      return res.status(500).json({ error: 'cycle_failed', message: e.message });
    }
  });
}

module.exports = {
  migrate,
  registerSubscriptionsRoutes,
  getActiveSubscription,
  checkQuota,
  DEFAULT_PLANS,
  PLAN_CODES,
  SUB_STATUSES,
  PLAN_STATUSES,
  BILLING_INTERVALS,
  CHANGE_KINDS,
  INVOICE_STATUSES
};
