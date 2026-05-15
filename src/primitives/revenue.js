// ============================================================================
// revenue.js — unified revenue tracking across all 14 layers.
//
// Other primitives call recordRevenue({...}) on every cash-generating event:
//   bank_chain.js        → 'usdc_transfer_fee'
//   cards.js             → 'card_interchange'
//   savings.js           → 'savings_spread' (cron daily)
//   lending.js           → 'lending_spread' (cron daily)
//   inference.js         → 'inference_markup'
//   extensions.js        → 'extensions_marketplace'
//   subscriptions.js     → 'subscriptions'
//   payouts.js           → 'payout_fee'
//   ...
// Daily roll-ups feed the ARR snapshot which feeds /v1/admin/revenue/arr.
// ============================================================================
const crypto = require('crypto');
const { z } = require('zod');
const { registerCron } = require('../cron_auth');

const SOURCE_LAYERS = [
  'usdc_transfer_fee', 'card_interchange', 'savings_spread', 'lending_spread',
  'inference_markup', 'extensions_marketplace', 'skill_marketplace',
  'prompts_marketplace', 'datasets_marketplace', 'subscriptions',
  'api_gateway_markup', 'compliance_check', 'brokerage_commission',
  'domain_renewal', 'compute_markup', 'payout_fee', 'insurance_premium',
  'fine_tuning_markup', 'arbitration', 'notary', 'prediction_market_fee',
  'carbon_offset', 'a2h_payout_fee', 'credit_purchase', 'whitelabel_revenue',
  'ach_fee', 'wire_fee', 'setup_fee', 'professional_services'
];

async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS revenue_events (
      event_id          TEXT PRIMARY KEY,
      source_layer      TEXT NOT NULL,
      amount_cents      BIGINT NOT NULL,
      currency          TEXT NOT NULL DEFAULT 'usd',
      org_id            TEXT,
      agent_did         TEXT,
      related_id        TEXT,
      occurred_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      period_yyyymm     INTEGER NOT NULL,
      idempotency_key   TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_revenue_events_layer_period
      ON revenue_events (source_layer, period_yyyymm);
    CREATE INDEX IF NOT EXISTS idx_revenue_events_org_period
      ON revenue_events (org_id, period_yyyymm);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_revenue_events_idem
      ON revenue_events (source_layer, idempotency_key)
      WHERE idempotency_key IS NOT NULL;

    CREATE TABLE IF NOT EXISTS revenue_daily_rollup (
      date_yyyymmdd     INTEGER NOT NULL,
      source_layer      TEXT NOT NULL,
      amount_cents      BIGINT NOT NULL DEFAULT 0,
      event_count       INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (date_yyyymmdd, source_layer)
    );

    CREATE TABLE IF NOT EXISTS revenue_arr_snapshot (
      snapshot_date     INTEGER PRIMARY KEY,
      mrr_cents         BIGINT NOT NULL DEFAULT 0,
      arr_cents         BIGINT NOT NULL DEFAULT 0,
      paying_orgs       INTEGER NOT NULL DEFAULT 0,
      paying_agents     INTEGER NOT NULL DEFAULT 0,
      layer_breakdown   JSONB,
      growth_rate_pct   REAL,
      taken_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

function periodFromDate(d = new Date()) { return d.getUTCFullYear() * 100 + (d.getUTCMonth() + 1); }
function dateYMD(d = new Date()) { return d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate(); }
function newId(p) { return p + '_' + crypto.randomBytes(10).toString('hex'); }

async function recordRevenue({ pool, source_layer, amount_cents, org_id = null,
                                agent_did = null, related_id = null,
                                idempotency_key = null, currency = 'usd',
                                occurred_at = null }) {
  if (!source_layer) throw new Error('source_layer_required');
  if (!Number.isFinite(amount_cents)) throw new Error('amount_cents_required');
  const occ = occurred_at ? new Date(occurred_at) : new Date();
  const id = newId('rev');
  await pool.query(
    `INSERT INTO revenue_events
       (event_id, source_layer, amount_cents, currency, org_id, agent_did,
        related_id, occurred_at, period_yyyymm, idempotency_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (source_layer, idempotency_key) WHERE idempotency_key IS NOT NULL
     DO NOTHING`,
    [id, source_layer, Math.round(amount_cents), currency, org_id, agent_did,
     related_id, occ.toISOString(), periodFromDate(occ), idempotency_key]
  ).catch(() => {});
  return { event_id: id };
}

async function runDailyRollup(pool) {
  const now = new Date();
  // roll up yesterday for safety
  const target = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1));
  const ymd = dateYMD(target);
  const r = await pool.query(`
    SELECT source_layer, COUNT(*)::int AS c, COALESCE(SUM(amount_cents),0)::bigint AS total
    FROM revenue_events
    WHERE occurred_at >= $1::date AND occurred_at < ($1::date + INTERVAL '1 day')
    GROUP BY source_layer
  `, [target.toISOString().slice(0, 10)]).catch(() => ({ rows: [] }));
  for (const row of r.rows) {
    await pool.query(`
      INSERT INTO revenue_daily_rollup (date_yyyymmdd, source_layer, amount_cents, event_count)
      VALUES ($1,$2,$3,$4)
      ON CONFLICT (date_yyyymmdd, source_layer) DO UPDATE
      SET amount_cents = $3, event_count = $4
    `, [ymd, row.source_layer, row.total, row.c]).catch(() => {});
  }
  return { date_yyyymmdd: ymd, layers_rolled: r.rows.length };
}

async function getCurrentARR(pool) {
  const period = periodFromDate(new Date());
  const r = await pool.query(`
    SELECT source_layer, COALESCE(SUM(amount_cents),0)::bigint AS mtd
    FROM revenue_events WHERE period_yyyymm = $1 GROUP BY source_layer
  `, [period]).catch(() => ({ rows: [] }));
  const mtd = r.rows.reduce((a, x) => a + Number(x.mtd), 0);
  // Annualise the month-to-date (linear extrapolation; conservative)
  const now = new Date();
  const dom = now.getUTCDate();
  const dim = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
  const monthly = Math.ceil(mtd * (dim / Math.max(1, dom)));
  return {
    mrr_cents: monthly,
    arr_cents: monthly * 12,
    by_layer: r.rows.map(x => ({ source_layer: x.source_layer, mtd_cents: Number(x.mtd) })),
    period_yyyymm: period
  };
}

async function takeArrSnapshot(pool) {
  const now = new Date();
  const ymd = dateYMD(now);
  const arr = await getCurrentARR(pool);
  const orgs = await pool.query(
    `SELECT COUNT(DISTINCT org_id)::int AS c FROM revenue_events WHERE period_yyyymm = $1 AND org_id IS NOT NULL`,
    [arr.period_yyyymm]
  ).catch(() => ({ rows: [{ c: 0 }] }));
  const agents = await pool.query(
    `SELECT COUNT(DISTINCT agent_did)::int AS c FROM revenue_events WHERE period_yyyymm = $1 AND agent_did IS NOT NULL`,
    [arr.period_yyyymm]
  ).catch(() => ({ rows: [{ c: 0 }] }));

  // 30-day prior comparison for growth rate
  const prior = await pool.query(
    `SELECT mrr_cents FROM revenue_arr_snapshot WHERE snapshot_date < $1 ORDER BY snapshot_date DESC LIMIT 1`, [ymd]
  ).catch(() => ({ rows: [] }));
  const growthPct = prior.rows[0] && Number(prior.rows[0].mrr_cents) > 0
    ? ((arr.mrr_cents - Number(prior.rows[0].mrr_cents)) / Number(prior.rows[0].mrr_cents)) * 100 : null;

  await pool.query(`
    INSERT INTO revenue_arr_snapshot (snapshot_date, mrr_cents, arr_cents,
      paying_orgs, paying_agents, layer_breakdown, growth_rate_pct)
    VALUES ($1,$2,$3,$4,$5,$6,$7)
    ON CONFLICT (snapshot_date) DO UPDATE
    SET mrr_cents = $2, arr_cents = $3, paying_orgs = $4, paying_agents = $5,
        layer_breakdown = $6, growth_rate_pct = $7, taken_at = NOW()
  `, [ymd, arr.mrr_cents, arr.arr_cents, orgs.rows[0].c, agents.rows[0].c,
      JSON.stringify(arr.by_layer), growthPct]).catch(() => {});

  return { snapshot_date: ymd, mrr_cents: arr.mrr_cents, arr_cents: arr.arr_cents, growth_rate_pct: growthPct };
}

const recordSchema = z.object({
  source_layer: z.string().min(1),
  amount_cents: z.number().int(),
  currency: z.string().optional(),
  org_id: z.string().nullable().optional(),
  agent_did: z.string().nullable().optional(),
  related_id: z.string().nullable().optional(),
  idempotency_key: z.string().optional()
});

function isAdmin(req) {
  const t = req.headers['x-admin-token'];
  return t && t === process.env.OPERATOR_ADMIN_TOKEN;
}

function registerRevenueRoutes(app, pool, verifyAgentAuth, auditChain) {
  const express = require('express');
  const { isCronRequest } = require('../cron_auth');

  app.post('/v1/revenue/events', express.json(), async (req, res) => {
    if (!isCronRequest(req) && !isAdmin(req)) return res.status(401).json({ error: 'cron_or_admin_auth_required' });
    const p = recordSchema.safeParse(req.body || {});
    if (!p.success) return res.status(400).json({ error: 'invalid_input', details: p.error.flatten() });
    const out = await recordRevenue({ pool, ...p.data });
    if (auditChain) await auditChain.append({ event_type: 'revenue.recorded', ...p.data }).catch(() => {});
    return res.status(201).json(out);
  });

  app.get('/v1/admin/revenue/arr', async (req, res) => {
    if (!isAdmin(req)) return res.status(401).json({ error: 'admin_auth_required' });
    return res.json(await getCurrentARR(pool));
  });

  app.get('/v1/admin/revenue/dashboard', async (req, res) => {
    if (!isAdmin(req)) return res.status(401).json({ error: 'admin_auth_required' });
    const days = Math.min(parseInt(req.query.days) || 30, 365);
    const sinceYmd = dateYMD(new Date(Date.now() - days * 24 * 3600 * 1000));
    const byDay = await pool.query(`
      SELECT date_yyyymmdd, source_layer, amount_cents
      FROM revenue_daily_rollup WHERE date_yyyymmdd >= $1 ORDER BY date_yyyymmdd, source_layer
    `, [sinceYmd]).catch(() => ({ rows: [] }));
    const byLayer = {};
    let total = 0;
    for (const r of byDay.rows) {
      byLayer[r.source_layer] = (byLayer[r.source_layer] || 0) + Number(r.amount_cents);
      total += Number(r.amount_cents);
    }
    const topOrgs = await pool.query(`
      SELECT org_id, COALESCE(SUM(amount_cents),0)::bigint AS total_cents
      FROM revenue_events WHERE occurred_at >= NOW() - ($1 || ' days')::interval
                            AND org_id IS NOT NULL
      GROUP BY org_id ORDER BY total_cents DESC LIMIT 25
    `, [days]).catch(() => ({ rows: [] }));
    const arr = await getCurrentARR(pool);
    return res.json({
      window_days: days, total_cents: total, total_usd: (total / 100).toFixed(2),
      by_layer: Object.entries(byLayer).map(([k, v]) => ({ layer: k, cents: v })).sort((a, b) => b.cents - a.cents),
      by_day: byDay.rows,
      top_orgs: topOrgs.rows.map(r => ({ org_id: r.org_id, cents: Number(r.total_cents) })),
      arr
    });
  });

  app.get('/v1/admin/revenue/cohorts', async (req, res) => {
    if (!isAdmin(req)) return res.status(401).json({ error: 'admin_auth_required' });
    const r = await pool.query(`
      SELECT
        TO_CHAR(MIN(occurred_at), 'YYYY-MM') AS cohort_month,
        org_id,
        COALESCE(SUM(amount_cents),0)::bigint AS lifetime_cents,
        COUNT(*)::int AS event_count
      FROM revenue_events WHERE org_id IS NOT NULL
      GROUP BY org_id ORDER BY cohort_month, lifetime_cents DESC LIMIT 500
    `).catch(() => ({ rows: [] }));
    return res.json({ cohorts: r.rows });
  });

  registerCron(app, '/v1/_jobs/revenue-rollup',
    async (req, res) => res.json(await runDailyRollup(pool)));
  registerCron(app, '/v1/_jobs/revenue-arr-snapshot',
    async (req, res) => res.json(await takeArrSnapshot(pool)));
}

module.exports = {
  migrate, registerRevenueRoutes, recordRevenue, getCurrentARR,
  runDailyRollup, takeArrSnapshot, SOURCE_LAYERS
};
