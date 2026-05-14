// ============================================================================
// OpenHeab Commerce — Budgets, subscriptions, settlement, dunning
// ============================================================================
const express = require('express');
const cryptoLib = require('crypto');
const { z } = require('zod');
const { registerCron } = require('../cron_auth');

// ----------------------------------------------------------------------------
// Migration
// ----------------------------------------------------------------------------
async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS commerce_budgets (
      agent_did              TEXT PRIMARY KEY,
      monthly_cap_raw        NUMERIC(78, 0) NOT NULL DEFAULT 0,
      spent_this_month_raw   NUMERIC(78, 0) NOT NULL DEFAULT 0,
      period_start           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      auto_reset             BOOLEAN NOT NULL DEFAULT TRUE,
      created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS commerce_subscriptions (
      subscription_id        TEXT PRIMARY KEY,
      slug                   TEXT NOT NULL,
      caller_did             TEXT NOT NULL,
      publisher_did          TEXT NOT NULL,
      price_usdc_raw         NUMERIC(78, 0) NOT NULL DEFAULT 0,
      status                 TEXT NOT NULL DEFAULT 'active',
      current_period_start   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      current_period_end     TIMESTAMPTZ NOT NULL,
      cancelled_at           TIMESTAMPTZ,
      audit_hash             TEXT,
      created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      retry_count            INTEGER NOT NULL DEFAULT 0,
      next_retry_at          TIMESTAMPTZ,
      UNIQUE (slug, caller_did)
    );
    CREATE INDEX IF NOT EXISTS idx_commerce_subs_caller    ON commerce_subscriptions (caller_did, status);
    CREATE INDEX IF NOT EXISTS idx_commerce_subs_publisher ON commerce_subscriptions (publisher_did, status);
    CREATE INDEX IF NOT EXISTS idx_commerce_subs_period    ON commerce_subscriptions (current_period_end)
      WHERE status = 'active';

    CREATE TABLE IF NOT EXISTS commerce_subscription_charges (
      charge_id              TEXT PRIMARY KEY,
      subscription_id        TEXT NOT NULL,
      slug                   TEXT NOT NULL,
      caller_did             TEXT NOT NULL,
      publisher_did          TEXT NOT NULL,
      amount_raw             NUMERIC(78, 0) NOT NULL,
      status                 TEXT NOT NULL DEFAULT 'pending',
      period_start           TIMESTAMPTZ,
      period_end             TIMESTAMPTZ,
      audit_hash             TEXT,
      created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      settled_at             TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_commerce_charges_sub ON commerce_subscription_charges (subscription_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS commerce_settlements (
      settlement_id          TEXT PRIMARY KEY,
      slug                   TEXT NOT NULL,
      publisher_did          TEXT NOT NULL,
      gross_raw              NUMERIC(78, 0) NOT NULL DEFAULT 0,
      fees_raw               NUMERIC(78, 0) NOT NULL DEFAULT 0,
      net_raw                NUMERIC(78, 0) NOT NULL DEFAULT 0,
      charge_count           INTEGER NOT NULL DEFAULT 0,
      period_start           TIMESTAMPTZ,
      period_end             TIMESTAMPTZ,
      audit_hash             TEXT,
      created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_commerce_settlements_pub ON commerce_settlements (publisher_did, created_at DESC);
  `);
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------
function genId(prefix) {
  return prefix + '_' + cryptoLib.randomBytes(12).toString('hex');
}

function addOneMonth(d) {
  const dd = new Date(d);
  dd.setMonth(dd.getMonth() + 1);
  return dd;
}

function bigAdd(a, b) {
  return (BigInt(a || 0) + BigInt(b || 0)).toString();
}

function bigGt(a, b) {
  return BigInt(a || 0) > BigInt(b || 0);
}

async function maybeResetPeriod(pool, row) {
  if (!row.auto_reset) return row;
  const now = new Date();
  const periodStart = new Date(row.period_start);
  const nextStart = addOneMonth(periodStart);
  if (now >= nextStart) {
    await pool.query(`
      UPDATE commerce_budgets
      SET spent_this_month_raw = 0, period_start = $2, updated_at = NOW()
      WHERE agent_did = $1
    `, [row.agent_did, now.toISOString()]);
    return { ...row, spent_this_month_raw: '0', period_start: now.toISOString() };
  }
  return row;
}

async function checkBudget(pool, callerDid, costRaw) {
  if (!callerDid) return { allowed: true };
  const r = await pool.query(
    `SELECT agent_did, monthly_cap_raw, spent_this_month_raw, period_start, auto_reset
     FROM commerce_budgets WHERE agent_did = $1`,
    [callerDid]
  ).catch(() => ({ rows: [] }));
  if (!r.rows[0]) return { allowed: true };
  const row = await maybeResetPeriod(pool, r.rows[0]);
  const cap = BigInt(row.monthly_cap_raw || 0);
  if (cap === 0n) return { allowed: true };
  const next = BigInt(row.spent_this_month_raw || 0) + BigInt(costRaw || 0);
  if (next > cap) {
    return {
      allowed: false,
      reason: 'monthly_budget_exceeded',
      cap_raw: cap.toString(),
      spent_raw: row.spent_this_month_raw.toString(),
      attempted_raw: String(costRaw)
    };
  }
  return { allowed: true };
}

async function incrementBudget(pool, callerDid, costRaw) {
  if (!callerDid || !costRaw) return;
  await pool.query(`
    INSERT INTO commerce_budgets (agent_did, monthly_cap_raw, spent_this_month_raw, period_start)
    VALUES ($1, 0, $2, NOW())
    ON CONFLICT (agent_did) DO UPDATE SET
      spent_this_month_raw = commerce_budgets.spent_this_month_raw + EXCLUDED.spent_this_month_raw,
      updated_at = NOW()
  `, [callerDid, String(costRaw)]).catch(() => {});
}

async function hasActiveSubscription(pool, callerDid, slug) {
  const r = await pool.query(`
    SELECT 1 FROM commerce_subscriptions
    WHERE slug = $1 AND caller_did = $2 AND status = 'active'
      AND current_period_end > NOW()
    LIMIT 1
  `, [slug, callerDid]).catch(() => ({ rows: [] }));
  return r.rows.length > 0;
}

async function billDueSubscriptions(pool, auditChain) {
  const r = await pool.query(`
    SELECT subscription_id, slug, caller_did, publisher_did, price_usdc_raw,
           current_period_start, current_period_end
    FROM commerce_subscriptions
    WHERE status = 'active' AND current_period_end <= NOW()
    LIMIT 500
  `).catch(() => ({ rows: [] }));

  const charges = [];
  for (const sub of r.rows) {
    const chargeId = genId('chg');
    const newStart = new Date(sub.current_period_end);
    const newEnd = addOneMonth(newStart);
    try {
      const entry = await auditChain.append({
        event_type: 'commerce.subscription_charge',
        subscription_id: sub.subscription_id,
        slug: sub.slug,
        caller_did: sub.caller_did,
        publisher_did: sub.publisher_did,
        amount_raw: sub.price_usdc_raw,
        period_start: newStart.toISOString(),
        period_end: newEnd.toISOString(),
        timestamp: new Date().toISOString()
      });
      await pool.query(`
        INSERT INTO commerce_subscription_charges
        (charge_id, subscription_id, slug, caller_did, publisher_did,
         amount_raw, status, period_start, period_end, audit_hash, created_at)
        VALUES ($1,$2,$3,$4,$5,$6,'pending',$7,$8,$9, NOW())
      `, [chargeId, sub.subscription_id, sub.slug, sub.caller_did, sub.publisher_did,
          sub.price_usdc_raw, newStart.toISOString(), newEnd.toISOString(), entry.hash]);
      await pool.query(`
        UPDATE commerce_subscriptions
        SET current_period_start = $2, current_period_end = $3
        WHERE subscription_id = $1
      `, [sub.subscription_id, newStart.toISOString(), newEnd.toISOString()]);
      charges.push({ charge_id: chargeId, subscription_id: sub.subscription_id });
    } catch (e) {
      console.warn('[commerce.bill]', sub.subscription_id, e.message);
    }
  }
  return { charged: charges.length, charges };
}

async function runSettlement(pool, auditChain) {
  const r = await pool.query(`
    SELECT slug, publisher_did,
           SUM(amount_raw)::numeric AS gross_raw,
           COUNT(*)::int AS charge_count
    FROM commerce_subscription_charges
    WHERE status = 'pending'
    GROUP BY slug, publisher_did
  `).catch(() => ({ rows: [] }));

  const settlements = [];
  for (const row of r.rows) {
    const settlementId = genId('stmt');
    const grossStr = String(row.gross_raw || '0');
    const gross = BigInt(grossStr);
    const fees = (gross * 1000n) / 10000n; // 10% platform fee
    const net = gross - fees;
    const now = new Date();
    try {
      const entry = await auditChain.append({
        event_type: 'commerce.settlement',
        settlement_id: settlementId,
        slug: row.slug,
        publisher_did: row.publisher_did,
        gross_raw: gross.toString(),
        fees_raw: fees.toString(),
        net_raw: net.toString(),
        charge_count: row.charge_count,
        timestamp: now.toISOString()
      });
      await pool.query(`
        INSERT INTO commerce_settlements
        (settlement_id, slug, publisher_did, gross_raw, fees_raw, net_raw,
         charge_count, audit_hash, created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8, NOW())
      `, [settlementId, row.slug, row.publisher_did, gross.toString(),
          fees.toString(), net.toString(), row.charge_count, entry.hash]);
      await pool.query(`
        UPDATE commerce_subscription_charges
        SET status = 'settled', settled_at = NOW()
        WHERE status = 'pending' AND slug = $1 AND publisher_did = $2
      `, [row.slug, row.publisher_did]);
      settlements.push({ settlement_id: settlementId, slug: row.slug, net_raw: net.toString() });
    } catch (e) {
      console.warn('[commerce.settle]', row.slug, e.message);
    }
  }
  return { settled: settlements.length, settlements };
}

async function tickDunningRetries(pool, auditChain) {
  // Retry charges at day 3, 7, 14. Cancel after 3 strikes.
  const RETRY_DAYS = [3, 7, 14];
  const r = await pool.query(`
    SELECT subscription_id, slug, caller_did, publisher_did,
           retry_count, status
    FROM commerce_subscriptions
    WHERE status IN ('past_due') AND (next_retry_at IS NULL OR next_retry_at <= NOW())
    LIMIT 500
  `).catch(() => ({ rows: [] }));

  const out = { retried: 0, cancelled: 0 };
  for (const sub of r.rows) {
    const newCount = (sub.retry_count || 0) + 1;
    if (newCount >= 3) {
      try {
        const entry = await auditChain.append({
          event_type: 'commerce.subscription_cancelled_dunning',
          subscription_id: sub.subscription_id,
          slug: sub.slug,
          caller_did: sub.caller_did,
          retry_count: newCount,
          timestamp: new Date().toISOString()
        });
        await pool.query(`
          UPDATE commerce_subscriptions
          SET status = 'cancelled', cancelled_at = NOW(),
              retry_count = $2, audit_hash = $3, next_retry_at = NULL
          WHERE subscription_id = $1
        `, [sub.subscription_id, newCount, entry.hash]);
        out.cancelled++;
      } catch (e) {
        console.warn('[commerce.dunning.cancel]', sub.subscription_id, e.message);
      }
    } else {
      const days = RETRY_DAYS[newCount] || 14;
      const next = new Date(Date.now() + days * 24 * 3600 * 1000);
      try {
        const entry = await auditChain.append({
          event_type: 'commerce.dunning_retry',
          subscription_id: sub.subscription_id,
          retry_count: newCount,
          next_retry_at: next.toISOString(),
          timestamp: new Date().toISOString()
        });
        await pool.query(`
          UPDATE commerce_subscriptions
          SET retry_count = $2, next_retry_at = $3, audit_hash = $4
          WHERE subscription_id = $1
        `, [sub.subscription_id, newCount, next.toISOString(), entry.hash]);
        out.retried++;
      } catch (e) {
        console.warn('[commerce.dunning.retry]', sub.subscription_id, e.message);
      }
    }
  }
  return out;
}

// ----------------------------------------------------------------------------
// Routes
// ----------------------------------------------------------------------------
function registerCommerceRoutes(app, pool, verifyAgentAuth, auditChain) {
  // POST /v1/agents/:did/budget
  const BudgetSchema = z.object({
    monthly_cap_raw: z.union([z.string(), z.number()]).optional(),
    auto_reset:      z.boolean().optional()
  });

  app.post('/v1/agents/:did/budget', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const parse = BudgetSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;

      const cap = d.monthly_cap_raw !== undefined ? String(d.monthly_cap_raw) : null;
      const autoReset = d.auto_reset !== undefined ? d.auto_reset : true;

      await pool.query(`
        INSERT INTO commerce_budgets
        (agent_did, monthly_cap_raw, spent_this_month_raw, period_start, auto_reset, updated_at)
        VALUES ($1, $2, 0, NOW(), $3, NOW())
        ON CONFLICT (agent_did) DO UPDATE SET
          monthly_cap_raw = COALESCE($2, commerce_budgets.monthly_cap_raw),
          auto_reset      = $3,
          updated_at      = NOW()
      `, [did, cap, autoReset]);

      await auditChain.append({
        event_type: 'commerce.budget_updated',
        agent_did: did,
        monthly_cap_raw: cap,
        auto_reset: autoReset,
        timestamp: new Date().toISOString()
      });

      const r = await pool.query(
        `SELECT agent_did, monthly_cap_raw::text, spent_this_month_raw::text,
                period_start, auto_reset, updated_at
         FROM commerce_budgets WHERE agent_did = $1`, [did]
      );
      return res.json(r.rows[0]);
    } catch (e) {
      console.error('[commerce.budget.set]', e);
      return res.status(500).json({ error: 'budget_update_failed', message: e.message });
    }
  });

  app.get('/v1/agents/:did/budget', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(
      `SELECT agent_did, monthly_cap_raw::text, spent_this_month_raw::text,
              period_start, auto_reset, created_at, updated_at
       FROM commerce_budgets WHERE agent_did = $1`, [did]
    ).catch(() => ({ rows: [] }));
    if (!r.rows[0]) {
      return res.json({
        agent_did: did, monthly_cap_raw: '0', spent_this_month_raw: '0',
        period_start: null, auto_reset: true
      });
    }
    return res.json(r.rows[0]);
  });

  // POST /v1/extensions/:slug/subscribe
  const SubscribeSchema = z.object({
    caller_did:    z.string().min(1),
    publisher_did: z.string().optional(),
    price_usdc_raw: z.union([z.string(), z.number()]).optional()
  });

  app.post('/v1/extensions/:slug/subscribe', express.json(), async (req, res) => {
    try {
      const slug = req.params.slug;
      const parse = SubscribeSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;
      const auth = await verifyAgentAuth(req, d.caller_did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      let publisherDid = d.publisher_did;
      let priceRaw = d.price_usdc_raw !== undefined ? String(d.price_usdc_raw) : '0';

      try {
        const extR = await pool.query(
          `SELECT publisher_did, price_usdc_raw FROM extensions WHERE slug = $1`,
          [slug]
        );
        if (extR.rows[0]) {
          publisherDid = publisherDid || extR.rows[0].publisher_did;
          if (extR.rows[0].price_usdc_raw) priceRaw = String(extR.rows[0].price_usdc_raw);
        }
      } catch {}

      if (!publisherDid) return res.status(400).json({ error: 'publisher_did_required' });

      const subscriptionId = genId('sub');
      const now = new Date();
      const periodEnd = addOneMonth(now);

      const entry = await auditChain.append({
        event_type: 'commerce.subscription_created',
        subscription_id: subscriptionId,
        slug, caller_did: d.caller_did, publisher_did: publisherDid,
        price_usdc_raw: priceRaw,
        timestamp: now.toISOString()
      });

      await pool.query(`
        INSERT INTO commerce_subscriptions
        (subscription_id, slug, caller_did, publisher_did, price_usdc_raw,
         status, current_period_start, current_period_end, audit_hash, created_at)
        VALUES ($1,$2,$3,$4,$5,'active',$6,$7,$8, NOW())
        ON CONFLICT (slug, caller_did) DO UPDATE SET
          status = 'active',
          cancelled_at = NULL,
          current_period_start = EXCLUDED.current_period_start,
          current_period_end = EXCLUDED.current_period_end,
          price_usdc_raw = EXCLUDED.price_usdc_raw,
          audit_hash = EXCLUDED.audit_hash
        RETURNING subscription_id, slug, caller_did, publisher_did,
                  price_usdc_raw::text, status,
                  current_period_start, current_period_end
      `, [subscriptionId, slug, d.caller_did, publisherDid, priceRaw,
          now.toISOString(), periodEnd.toISOString(), entry.hash]);

      const row = await pool.query(`
        SELECT subscription_id, slug, caller_did, publisher_did,
               price_usdc_raw::text AS price_usdc_raw, status,
               current_period_start, current_period_end, audit_hash
        FROM commerce_subscriptions WHERE slug = $1 AND caller_did = $2
      `, [slug, d.caller_did]);
      return res.status(201).json(row.rows[0]);
    } catch (e) {
      console.error('[commerce.subscribe]', e);
      return res.status(500).json({ error: 'subscribe_failed', message: e.message });
    }
  });

  // DELETE /v1/extensions/:slug/subscribe
  app.delete('/v1/extensions/:slug/subscribe', express.json(), async (req, res) => {
    try {
      const slug = req.params.slug;
      const callerDid = (req.body && req.body.caller_did) || req.query.caller_did;
      if (!callerDid) return res.status(400).json({ error: 'caller_did_required' });
      const auth = await verifyAgentAuth(req, callerDid);
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const entry = await auditChain.append({
        event_type: 'commerce.subscription_cancelled',
        slug, caller_did: callerDid,
        timestamp: new Date().toISOString()
      });

      const r = await pool.query(`
        UPDATE commerce_subscriptions
        SET status = 'cancelled', cancelled_at = NOW(), audit_hash = $3
        WHERE slug = $1 AND caller_did = $2 AND status != 'cancelled'
        RETURNING subscription_id, slug, caller_did, status, cancelled_at
      `, [slug, callerDid, entry.hash]);

      if (!r.rows[0]) return res.status(404).json({ error: 'subscription_not_found' });
      return res.json(r.rows[0]);
    } catch (e) {
      console.error('[commerce.unsubscribe]', e);
      return res.status(500).json({ error: 'unsubscribe_failed', message: e.message });
    }
  });

  // GET /v1/agents/:did/subscriptions
  app.get('/v1/agents/:did/subscriptions', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(`
      SELECT subscription_id, slug, caller_did, publisher_did,
             price_usdc_raw::text AS price_usdc_raw, status,
             current_period_start, current_period_end, cancelled_at,
             retry_count, next_retry_at, created_at
      FROM commerce_subscriptions WHERE caller_did = $1
      ORDER BY created_at DESC LIMIT 200
    `, [did]).catch(() => ({ rows: [] }));
    return res.json({ agent_did: did, subscriptions: r.rows, count: r.rows.length });
  });

  // Admin: disable / restore
  app.post('/v1/_admin/extensions/:slug/disable', express.json(), async (req, res) => {
    const adminToken = req.headers['x-admin-token'];
    if (!adminToken || adminToken !== process.env.OPERATOR_ADMIN_TOKEN)
      return res.status(401).json({ error: 'admin_auth_required' });
    const slug = req.params.slug;
    const reason = (req.body && req.body.reason) || 'admin_disabled';
    const entry = await auditChain.append({
      event_type: 'commerce.extension_disabled',
      slug, reason, timestamp: new Date().toISOString()
    });
    const r = await pool.query(`
      UPDATE commerce_subscriptions
      SET status = 'past_due', audit_hash = $2
      WHERE slug = $1 AND status = 'active'
      RETURNING subscription_id
    `, [slug, entry.hash]).catch(() => ({ rows: [] }));
    return res.json({ slug, affected: r.rows.length, audit_hash: entry.hash });
  });

  app.post('/v1/_admin/extensions/:slug/restore', express.json(), async (req, res) => {
    const adminToken = req.headers['x-admin-token'];
    if (!adminToken || adminToken !== process.env.OPERATOR_ADMIN_TOKEN)
      return res.status(401).json({ error: 'admin_auth_required' });
    const slug = req.params.slug;
    const entry = await auditChain.append({
      event_type: 'commerce.extension_restored',
      slug, timestamp: new Date().toISOString()
    });
    const r = await pool.query(`
      UPDATE commerce_subscriptions
      SET status = 'active', audit_hash = $2, retry_count = 0, next_retry_at = NULL
      WHERE slug = $1 AND status = 'past_due'
      RETURNING subscription_id
    `, [slug, entry.hash]).catch(() => ({ rows: [] }));
    return res.json({ slug, restored: r.rows.length, audit_hash: entry.hash });
  });

  // Cron jobs
  registerCron(app, '/v1/_jobs/extension-settlement', async (req, res) => {
    try {
      const r = await runSettlement(pool, auditChain);
      res.json(r);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  registerCron(app, '/v1/_jobs/subscription-charge', async (req, res) => {
    try {
      const r = await billDueSubscriptions(pool, auditChain);
      res.json(r);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  registerCron(app, '/v1/_jobs/dunning-retries', async (req, res) => {
    try {
      const r = await tickDunningRetries(pool, auditChain);
      res.json(r);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
}

module.exports = {
  migrate,
  registerCommerceRoutes,
  checkBudget,
  incrementBudget,
  hasActiveSubscription,
  billDueSubscriptions,
  runSettlement,
  tickDunningRetries
};
