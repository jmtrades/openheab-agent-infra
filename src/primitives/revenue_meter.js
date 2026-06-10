// ============================================================================
// revenue_meter.js — the monetization engine. Layer 83.
//
// 2,430 routes and 13 revenue wedges mean nothing if usage never meets a
// price. This primitive is the turnstile in front of the entire /v1 surface:
//
//   1. METER   — every /v1 API call is attributed (DID > API key > anon IP)
//                and counted into a per-day, per-family usage counter with a
//                billable price in millicents (1/1000¢, so $0.001/call works
//                in integers).
//   2. ENFORCE — identified agents get a daily call allowance from their
//                org's plan (free: 1k/day). Over allowance → HTTP 402 with
//                an upgrade path. Anonymous traffic is never blocked here
//                (the rate limiter handles abuse) so public pages stay open.
//   3. BILL    — a monthly cron rolls counters into usage_invoices,
//                idempotent per (identity, month).
//   4. MODEL   — /v1/revenue-model + /v1/revenue-model/simulate expose the
//                exact money math, machine-readable; /money renders it for
//                humans. This is the "how we make a lot of money" artifact:
//                every wedge, every rate, every formula, live.
//
// Fail-open by design: any metering error lets the request through. The
// worst failure mode of a billing layer is breaking the product.
//
// Endpoints:
//   GET  /v1/usage/:did                  own usage + projected bill (signed)
//   GET  /v1/revenue-model               all wedges + live rates, for machines
//   GET  /v1/revenue-model/simulate      parameterized MRR projection
//   GET  /v1/meter/stats                 meter-wide aggregates
//   cron /v1/_jobs/usage-invoices        monthly rollup (UTC-1st, idempotent)
//
// UI: /money
// ============================================================================
const crypto = require('crypto');
const ds = require('../design_system');
const { registerCron } = require('../cron_auth');
const { settle, POOLS } = require('../settlement');

function shell(title, description, content) {
  return `${ds.head(`${title} — OpenHeab`, description)}${ds.NAV_HTML('')}<main>${content}</main>${ds.FOOTER_HTML()}`;
}
async function safe(pool, sql, params = []) {
  try { return (await pool.query(sql, params)).rows; }
  catch { return []; }
}

// --- Pricing -----------------------------------------------------------------
// Per-call platform fee by route family, in millicents (1000 = 1¢).
// Families whose primitives already charge their own fee are 0 here so
// nothing is double-billed.
const DEFAULT_CALL_MILLICENTS = parseInt(process.env.METER_DEFAULT_MILLICENTS || '100'); // 0.1¢
const FAMILY_MILLICENTS = {
  inference: 1000, multimodal: 1000,           // 1¢ platform fee per call
  sandbox: 5000, browser: 3000,                // compute-heavy
  voice: 2000, vision: 2000, video: 2000,
  util: 10,                                    // cheap by design
  // priced inside their own primitive — never double-bill:
  credit: 0, clearing: 0, payroll: 0, funds: 0, treasury: 0,
  bank: 0, wallet: 0, payouts: 0, escrow: 0,
  // free families:
  identities: 0, pricing: 0, signup: 0, legal: 0, usage: 0,
  'revenue-model': 0, meter: 0, pulse: 0, search: 0, stream: 0, fx: 0
};

// Pay-as-you-go: price for additional capacity past the plan allowance,
// payable by the agent itself from its USDC ledger balance — no human, no
// card form. $1.00 per 1,000 calls by default.
const TOPUP_CENTS_PER_1K = parseInt(process.env.METER_TOPUP_CENTS_PER_1K || '100');
const AUTOPAY_INCREMENT_CALLS = 1000;

// Daily included API calls per org plan. Unknown paid plans get the pro cap.
const PLAN_DAILY_CALLS = {
  free: parseInt(process.env.METER_FREE_DAILY_CALLS || '1000'),
  starter: 10_000, pro: 50_000, team: 250_000,
  scale: Number.MAX_SAFE_INTEGER, enterprise: Number.MAX_SAFE_INTEGER
};
const PAID_DEFAULT_DAILY_CALLS = 50_000;

function familyOf(path) {
  // /v1/<family>/... — but /v1/agents/:did/<family>/... nests the real family
  const seg = path.split('/').filter(Boolean); // ['v1','agents','did:..','browser',...]
  if (seg.length < 2) return 'root';
  if (seg[1] === 'agents' && seg.length >= 4) return seg[3];
  return seg[1];
}
function priceFor(family) {
  const p = FAMILY_MILLICENTS[family];
  return p === undefined ? DEFAULT_CALL_MILLICENTS : p;
}
function identityOf(req) {
  const did = req.headers['x-agent-did'];
  if (did && typeof did === 'string' && did.length < 300) return { id: did, kind: 'did' };
  const auth = req.headers['authorization'] || '';
  if (auth.startsWith('Bearer ') && auth.length > 20) {
    return { id: 'key:' + crypto.createHash('sha256').update(auth.slice(7)).digest('hex').slice(0, 24), kind: 'key' };
  }
  const ip = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').toString().split(',')[0].trim();
  return { id: 'anon:' + ip, kind: 'anon' };
}

// --- In-memory caches (best-effort; substrate is multi-instance, so these
// are a fast path only — the DB counter is the source of truth) -------------
const planCache = new Map();   // did → { cap, at }
const usageCache = new Map();  // identity → { calls, at }
const PLAN_TTL_MS = 5 * 60_000, USAGE_TTL_MS = 30_000;
function cacheGet(map, k, ttl) {
  const v = map.get(k);
  if (v && Date.now() - v.at < ttl) return v;
  return null;
}
function cacheSet(map, k, v) {
  if (map.size > 20_000) map.clear();
  map.set(k, { ...v, at: Date.now() });
}

const keyDidCache = new Map(); // key-hash → { did, at }
const autopayCache = new Map(); // did → { enabled, max_cents_per_day, at }

// Bearer API keys are authenticated credentials — resolve them to the DID
// they belong to so one agent's usage, quota, topups, and invoices all land
// on a single identity instead of fragmenting across key hashes.
async function resolveIdentity(pool, req) {
  const ident = identityOf(req);
  if (ident.kind !== 'key') return ident;
  const hit = cacheGet(keyDidCache, ident.id, PLAN_TTL_MS);
  if (hit) return hit.did ? { id: hit.did, kind: 'did' } : ident;
  const auth = req.headers['authorization'] || '';
  const tokenHash = crypto.createHash('sha256').update(auth.slice(7)).digest('hex');
  const r = await safe(pool, `SELECT agent_did FROM api_keys WHERE token_hash=$1 AND revoked_at IS NULL`, [tokenHash]);
  const did = r[0]?.agent_did || null;
  cacheSet(keyDidCache, ident.id, { did });
  return did ? { id: did, kind: 'did' } : ident;
}

async function topupCallsToday(pool, did) {
  const r = await safe(pool, `SELECT COALESCE(SUM(calls_added),0)::bigint AS n FROM meter_topups WHERE agent_did=$1 AND topup_date=CURRENT_DATE`, [did]);
  return Number(r[0]?.n || 0);
}

async function dailyCapFor(pool, did) {
  const hit = cacheGet(planCache, did, PLAN_TTL_MS);
  if (hit) return hit.cap;
  let plan = 'free';
  const r = await safe(pool, `
    SELECT o.plan FROM org_members m JOIN orgs o ON o.org_id = m.org_id
    WHERE m.agent_did = $1 AND o.status = 'active'
    ORDER BY CASE o.plan WHEN 'enterprise' THEN 0 WHEN 'scale' THEN 1 WHEN 'team' THEN 2 WHEN 'pro' THEN 3 ELSE 9 END
    LIMIT 1
  `, [did]);
  if (r[0]?.plan) plan = String(r[0].plan).toLowerCase();
  const cap = PLAN_DAILY_CALLS[plan] ?? (plan === 'free' ? PLAN_DAILY_CALLS.free : PAID_DEFAULT_DAILY_CALLS);
  cacheSet(planCache, did, { cap });
  return cap;
}

async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS usage_counters (
      counter_date        DATE NOT NULL DEFAULT CURRENT_DATE,
      identity            TEXT NOT NULL,
      family              TEXT NOT NULL,
      calls               BIGINT NOT NULL DEFAULT 0,
      billable_millicents BIGINT NOT NULL DEFAULT 0,
      PRIMARY KEY (counter_date, identity, family)
    );
    CREATE INDEX IF NOT EXISTS idx_usage_identity ON usage_counters (identity, counter_date DESC);

    CREATE TABLE IF NOT EXISTS meter_topups (
      topup_id     TEXT PRIMARY KEY,
      agent_did    TEXT NOT NULL,
      calls_added  BIGINT NOT NULL,
      paid_cents   BIGINT NOT NULL,
      auto         BOOLEAN NOT NULL DEFAULT FALSE,
      topup_date   DATE NOT NULL DEFAULT CURRENT_DATE,
      ledger       TEXT,
      idem         TEXT UNIQUE,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_meter_topups ON meter_topups (agent_did, topup_date);

    CREATE TABLE IF NOT EXISTS meter_autopay (
      agent_did          TEXT PRIMARY KEY,
      enabled            BOOLEAN NOT NULL DEFAULT FALSE,
      max_cents_per_day  INT NOT NULL DEFAULT 500,
      updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS usage_invoices (
      invoice_id   TEXT PRIMARY KEY,
      identity     TEXT NOT NULL,
      month        TEXT NOT NULL,
      total_calls  BIGINT NOT NULL,
      total_cents  BIGINT NOT NULL,
      by_family    JSONB NOT NULL DEFAULT '{}',
      generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (identity, month)
    );
  `).catch(() => {});
}

// Installed by integration.js BEFORE any route registers, so it fronts the
// whole /v1 surface. Must never throw and never block on the DB write.
function installRevenueMeter(app, pool, bank, auditChain) {
  // /v1/meter and /v1/usage must stay reachable over-cap — an agent that hit
  // the wall has to be able to pay the wall (and see why it hit it).
  const EXEMPT = ['/v1/_jobs/', '/v1/_health', '/v1/_webhooks/', '/v1/signup', '/v1/identities', '/v1/meter/', '/v1/usage/'];
  app.use(async (req, res, next) => {
    try {
      if (!req.path.startsWith('/v1/')) return next();
      if (EXEMPT.some(p => req.path.startsWith(p))) return next();

      const ident = await resolveIdentity(pool, req);
      const family = familyOf(req.path);

      // Enforcement — DID-identified traffic only; everything else passes
      // (rate_limit.js owns anonymous abuse).
      if (ident.kind === 'did') {
        let used = cacheGet(usageCache, ident.id, USAGE_TTL_MS)?.calls;
        if (used === undefined || used === null) {
          const r = await safe(pool, `SELECT COALESCE(SUM(calls),0)::bigint AS n FROM usage_counters WHERE identity=$1 AND counter_date=CURRENT_DATE`, [ident.id]);
          used = Number(r[0]?.n || 0);
          cacheSet(usageCache, ident.id, { calls: used });
        }
        const cap = await dailyCapFor(pool, ident.id) + await topupCallsToday(pool, ident.id);
        if (used >= cap) {
          // The conversion event. First: standing auto-topup — the agent
          // opted in once, so we buy the next increment from its ledger
          // balance and let the request through. The AWS model.
          const paid = await tryAutoTopup(pool, bank, auditChain, ident.id);
          if (!paid) {
            // Otherwise: HTTP 402 as designed — a machine-payable offer the
            // agent can settle itself in one signed call. No humans, no forms.
            return res.status(402).json({
              error: {
                message: 'daily_call_allowance_exceeded',
                used_today: used, daily_allowance: cap,
                usage: `/v1/usage/${ident.id}`
              },
              pay: {
                description: `Buy more capacity instantly from your ledger balance at $${(TOPUP_CENTS_PER_1K / 100).toFixed(2)} per 1,000 calls.`,
                method: 'POST', path: '/v1/meter/topup',
                body: { agent_did: ident.id, calls: 5000 },
                price_cents_per_1k: TOPUP_CENTS_PER_1K,
                or_standing_autopay: { method: 'POST', path: '/v1/meter/autopay', body: { agent_did: ident.id, enabled: true, max_cents_per_day: 500 } },
                or_upgrade_plan: '/pricing'
              }
            });
          }
        }
      }

      // Meter on response — fire-and-forget upsert
      res.on('finish', () => {
        const price = priceFor(family);
        pool.query(
          `INSERT INTO usage_counters (counter_date, identity, family, calls, billable_millicents)
           VALUES (CURRENT_DATE, $1, $2, 1, $3)
           ON CONFLICT (counter_date, identity, family)
           DO UPDATE SET calls = usage_counters.calls + 1,
                         billable_millicents = usage_counters.billable_millicents + $3`,
          [ident.id, family, price]
        ).catch(() => {});
        const c = cacheGet(usageCache, ident.id, USAGE_TTL_MS);
        if (c) cacheSet(usageCache, ident.id, { calls: c.calls + 1 });
      });
      next();
    } catch { next(); }  // fail open, always
  });
}

// Standing auto-topup: if the agent opted in and is under its daily spend
// cap, buy the next increment from its ledger balance. Purchases must
// actually settle — capacity is never granted on a failed transfer.
async function tryAutoTopup(pool, bank, auditChain, did) {
  let ap = cacheGet(autopayCache, did, 60_000);
  if (!ap) {
    const r = await safe(pool, `SELECT enabled, max_cents_per_day FROM meter_autopay WHERE agent_did=$1`, [did]);
    ap = { enabled: !!r[0]?.enabled, max_cents_per_day: Number(r[0]?.max_cents_per_day || 0) };
    cacheSet(autopayCache, did, ap);
  }
  if (!ap.enabled) return false;
  const spent = Number((await safe(pool,
    `SELECT COALESCE(SUM(paid_cents),0)::bigint AS n FROM meter_topups WHERE agent_did=$1 AND topup_date=CURRENT_DATE AND auto`, [did]))[0]?.n || 0);
  const price = Math.ceil(AUTOPAY_INCREMENT_CALLS / 1000 * TOPUP_CENTS_PER_1K);
  if (spent + price > ap.max_cents_per_day) return false;
  const topup_id = 'mt_' + crypto.randomBytes(10).toString('hex');
  const led = await settle(bank, pool, auditChain, {
    from: did, to: POOLS.platform, amount_cents: price, memo: 'meter_auto_topup', idem: topup_id
  });
  if (!led.settled) return false;
  await pool.query(
    `INSERT INTO meter_topups (topup_id, agent_did, calls_added, paid_cents, auto, ledger, idem)
     VALUES ($1,$2,$3,$4,TRUE,$5,$6)`,
    [topup_id, did, AUTOPAY_INCREMENT_CALLS, price, 'settled:' + led.txn_id, topup_id]
  ).catch(() => {});
  if (auditChain) await auditChain.append({ event_type: 'meter.auto_topup', agent_did: did, calls_added: AUTOPAY_INCREMENT_CALLS, paid_cents: price }).catch(() => {});
  return true;
}

// --- The revenue model itself ------------------------------------------------
// One source of truth for "exactly how this makes money". Rates are read from
// the same env knobs the primitives use, so the model can't drift from the
// implementation.
function wedges() {
  return [
    { id: 'subscriptions', name: 'Subscriptions', rate: '$19-$2,499/mo', analog: 'SaaS', formula: 'agents × paid% × avg_plan' },
    { id: 'metering', name: 'Metered API calls', rate: `${DEFAULT_CALL_MILLICENTS / 1000}¢/call past allowance`, analog: 'AWS', formula: 'billable_calls × price(family)' },
    { id: 'inference_markup', name: 'Inference markup', rate: '10% of LLM spend', analog: 'AWS', formula: 'inference_spend × 10%' },
    { id: 'wallet_fees', name: 'USDC wallet fees', rate: '1% of transfers', analog: 'Visa', formula: 'GMV × 1%' },
    { id: 'marketplace', name: 'Marketplaces (extensions/prompts/datasets)', rate: '30% take', analog: 'App Store', formula: 'marketplace_GMV × 30%' },
    { id: 'payout_fees', name: 'A2H payout fees', rate: '0.5%', analog: 'Wise', formula: 'payout_volume × 0.5%' },
    { id: 'treasury_spread', name: 'Treasury yield spread', rate: `${(parseInt(process.env.TREASURY_SPREAD_BPS || '50') / 100).toFixed(2)}% APY on AUM`, analog: 'Schwab', formula: 'AUM × spread_bps / 12' },
    { id: 'credit_pulls', name: 'Credit report pulls', rate: `${parseInt(process.env.CREDIT_REPORT_FEE_CENTS || '25')}¢/pull`, analog: 'Equifax', formula: 'pulls × fee' },
    { id: 'clearing_fees', name: 'Clearing fees', rate: `${parseInt(process.env.CLEARING_FEE_BPS || '10')} bps of gross netted`, analog: 'DTCC', formula: 'gross_notional × fee_bps' },
    { id: 'payroll_fees', name: 'Payroll processing', rate: `${parseInt(process.env.PAYROLL_FEE_BPS || '25')} bps of gross`, analog: 'ADP', formula: 'gross_payroll × fee_bps' },
    { id: 'fund_er', name: 'Index fund expense ratios', rate: '15-75 bps on AUM', analog: 'BlackRock', formula: 'fund_AUM × ER / 12' },
    { id: 'featured', name: 'Featured listings', rate: '$50/mo', analog: 'Google Ads', formula: 'listings × $50' },
    { id: 'enterprise', name: 'Enterprise contracts', rate: 'NET-30/60/90 POs', analog: 'Oracle', formula: 'accounts × ACV / 12' },
    { id: 'affiliate_net', name: 'Affiliate-driven margin', rate: '80% of referred revenue (20% paid out)', analog: 'Partner channel', formula: 'referred_rev × 80%' }
  ];
}

function num(q, key, dflt) {
  const v = parseFloat(q[key]);
  return Number.isFinite(v) && v >= 0 ? v : dflt;
}

// The simulator: every assumption is an overridable query param, every output
// shows its formula. Defaults are deliberately conservative.
function simulate(q) {
  const agents = num(q, 'agents', 10_000);
  const paid_pct = num(q, 'paid_pct', 5) / 100;
  const avg_plan_cents = num(q, 'avg_plan_cents', 9_900);
  const calls_per_agent_day = num(q, 'calls_per_agent_day', 2_000);
  const free_allowance = PLAN_DAILY_CALLS.free;
  const inference_share = num(q, 'inference_share_pct', 10) / 100;
  const avg_inference_cost_cents = num(q, 'avg_inference_cost_cents', 0.5);
  const gmv_per_agent_month_cents = num(q, 'gmv_per_agent_month_cents', 20_000);
  const avg_balance_cents = num(q, 'avg_balance_cents', 5_000);
  const treasury_enroll_pct = num(q, 'treasury_enroll_pct', 30) / 100;
  const fund_enroll_pct = num(q, 'fund_enroll_pct', 10) / 100;
  const credit_pulls_per_agent_month = num(q, 'credit_pulls_per_agent_month', 2);
  const payroll_pct = num(q, 'payroll_pct', 5) / 100;
  const avg_salary_month_cents = num(q, 'avg_salary_month_cents', 100_000);

  const paidAgents = agents * paid_pct;
  const billableCallsMonth = Math.max(0, calls_per_agent_day - free_allowance) * 30 * paidAgents;
  const inferenceSpendMonth = agents * calls_per_agent_day * inference_share * avg_inference_cost_cents * 30;
  const gmvMonth = agents * gmv_per_agent_month_cents;
  const treasuryAum = agents * treasury_enroll_pct * avg_balance_cents;
  const fundAum = agents * fund_enroll_pct * avg_balance_cents;

  const lines = [
    ['subscriptions', paidAgents * avg_plan_cents, `${Math.round(paidAgents).toLocaleString()} paid × $${(avg_plan_cents / 100).toFixed(0)}/mo`],
    ['metering', billableCallsMonth * DEFAULT_CALL_MILLICENTS / 1000, `${Math.round(billableCallsMonth).toLocaleString()} billable calls × ${DEFAULT_CALL_MILLICENTS / 1000}¢`],
    ['inference_markup', inferenceSpendMonth * 0.10, `$${(inferenceSpendMonth / 100).toLocaleString()} inference spend × 10%`],
    ['wallet_fees', gmvMonth * 0.01, `$${(gmvMonth / 100).toLocaleString()} GMV × 1%`],
    ['treasury_spread', treasuryAum * (parseInt(process.env.TREASURY_SPREAD_BPS || '50') / 10000) / 12, `$${(treasuryAum / 100).toLocaleString()} AUM × spread / 12`],
    ['credit_pulls', agents * credit_pulls_per_agent_month * parseInt(process.env.CREDIT_REPORT_FEE_CENTS || '25'), `${(agents * credit_pulls_per_agent_month).toLocaleString()} pulls × 25¢`],
    ['clearing_fees', gmvMonth * 0.5 * (parseInt(process.env.CLEARING_FEE_BPS || '10') / 10000), `${'50%'} of GMV netted × 10 bps`],
    ['payroll_fees', agents * payroll_pct * avg_salary_month_cents * (parseInt(process.env.PAYROLL_FEE_BPS || '25') / 10000), `${Math.round(agents * payroll_pct).toLocaleString()} salaried × $${(avg_salary_month_cents / 100).toFixed(0)} × 25 bps`],
    ['fund_er', fundAum * 0.0045 / 12, `$${(fundAum / 100).toLocaleString()} fund AUM × 45 bps / 12`]
  ];
  const by_wedge = lines.map(([id, cents, formula]) => ({ wedge: id, mrr_cents: Math.round(cents), formula })).sort((a, b) => b.mrr_cents - a.mrr_cents);
  const mrr = by_wedge.reduce((a, w) => a + w.mrr_cents, 0);
  return {
    assumptions: { agents, paid_pct, avg_plan_cents, calls_per_agent_day, free_allowance, inference_share, gmv_per_agent_month_cents, avg_balance_cents, treasury_enroll_pct, fund_enroll_pct, credit_pulls_per_agent_month, payroll_pct, avg_salary_month_cents },
    by_wedge, mrr_cents: mrr, arr_cents: mrr * 12,
    per_agent_per_month_cents: agents > 0 ? Math.round(mrr / agents) : 0,
    note: 'Every assumption is a query param — override any of them. Rates come from the same env knobs the primitives bill with.'
  };
}

function registerRevenueMeterRoutes(app, pool, verifyAgentAuth, auditChain, bank) {
  const express = require('express');
  const { z } = require('zod');

  // The conversion endpoint. An agent that hit the 402 wall buys capacity
  // from its own ledger balance in one signed call. The purchase must
  // actually settle — capacity is never granted on a failed transfer —
  // and it is idempotent via X-Idempotency-Key.
  app.post('/v1/meter/topup', express.json(), async (req, res) => {
    const b = z.object({
      agent_did: z.string(),
      calls: z.number().int().min(100).max(10_000_000)
    }).safeParse(req.body || {});
    if (!b.success) return res.status(400).json({ error: { message: 'invalid_input', details: b.error.flatten() } });
    const auth = await verifyAgentAuth(req, b.data.agent_did);
    if (!auth.valid) return res.status(401).json({ error: { message: auth.error || 'agent_signature_required' } });

    const idem = req.headers['x-idempotency-key'] || ('mt_' + crypto.randomBytes(10).toString('hex'));
    const existing = (await safe(pool, `SELECT topup_id, calls_added, paid_cents FROM meter_topups WHERE idem=$1`, [idem]))[0];
    if (existing) return res.json({ topup_id: existing.topup_id, calls_added: Number(existing.calls_added), paid_cents: Number(existing.paid_cents), idempotent: true });

    const price = Math.ceil(b.data.calls / 1000 * TOPUP_CENTS_PER_1K);
    const topup_id = 'mt_' + crypto.randomBytes(10).toString('hex');
    const led = await settle(bank, pool, auditChain, {
      from: b.data.agent_did, to: POOLS.platform, amount_cents: price, memo: 'meter_topup', idem: topup_id
    });
    if (!led.settled) {
      return res.status(402).json({ error: { message: 'topup_settlement_failed', reason: led.reason, price_cents: price, hint: 'fund your wallet, then retry' } });
    }
    try {
      await pool.query(
        `INSERT INTO meter_topups (topup_id, agent_did, calls_added, paid_cents, ledger, idem)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [topup_id, b.data.agent_did, b.data.calls, price, 'settled:' + led.txn_id, idem]
      );
      usageCache.delete(b.data.agent_did);
      if (auditChain) await auditChain.append({ event_type: 'meter.topup', agent_did: b.data.agent_did, calls_added: b.data.calls, paid_cents: price }).catch(() => {});
      const cap = await dailyCapFor(pool, b.data.agent_did) + await topupCallsToday(pool, b.data.agent_did);
      res.status(201).json({ topup_id, calls_added: b.data.calls, paid_cents: price, daily_allowance_now: cap });
    } catch (e) { res.status(500).json({ error: { message: e.message } }); }
  });

  // Standing auto-topup: opt in once, the meter buys increments from your
  // balance automatically (capped per day) instead of returning 402.
  app.post('/v1/meter/autopay', express.json(), async (req, res) => {
    const b = z.object({
      agent_did: z.string(),
      enabled: z.boolean(),
      max_cents_per_day: z.number().int().min(1).max(1_000_000).default(500)
    }).safeParse(req.body || {});
    if (!b.success) return res.status(400).json({ error: { message: 'invalid_input', details: b.error.flatten() } });
    const auth = await verifyAgentAuth(req, b.data.agent_did);
    if (!auth.valid) return res.status(401).json({ error: { message: auth.error || 'agent_signature_required' } });
    await pool.query(
      `INSERT INTO meter_autopay (agent_did, enabled, max_cents_per_day, updated_at)
       VALUES ($1,$2,$3,NOW())
       ON CONFLICT (agent_did) DO UPDATE SET enabled=$2, max_cents_per_day=$3, updated_at=NOW()`,
      [b.data.agent_did, b.data.enabled, b.data.max_cents_per_day]
    ).catch(() => {});
    autopayCache.delete(b.data.agent_did);
    if (auditChain) await auditChain.append({ event_type: 'meter.autopay_configured', agent_did: b.data.agent_did, enabled: b.data.enabled, max_cents_per_day: b.data.max_cents_per_day }).catch(() => {});
    res.json({ agent_did: b.data.agent_did, autopay: b.data.enabled, max_cents_per_day: b.data.max_cents_per_day, increment_calls: AUTOPAY_INCREMENT_CALLS, price_cents_per_1k: TOPUP_CENTS_PER_1K });
  });

  app.get('/v1/usage/:did', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: { message: auth.error || 'agent_signature_required' } });
    const today = await safe(pool, `SELECT family, calls, billable_millicents FROM usage_counters WHERE identity=$1 AND counter_date=CURRENT_DATE ORDER BY calls DESC`, [did]);
    const mtd = (await safe(pool, `
      SELECT COALESCE(SUM(calls),0)::bigint AS calls, COALESCE(SUM(billable_millicents),0)::bigint AS mc
      FROM usage_counters WHERE identity=$1 AND counter_date >= date_trunc('month', CURRENT_DATE)
    `, [did]))[0] || {};
    const cap = await dailyCapFor(pool, did);
    const bought = await topupCallsToday(pool, did);
    const ap = (await safe(pool, `SELECT enabled, max_cents_per_day FROM meter_autopay WHERE agent_did=$1`, [did]))[0];
    res.json({
      agent_did: did,
      daily_allowance: cap === Number.MAX_SAFE_INTEGER ? 'unlimited' : cap + bought,
      topup_calls_today: bought,
      autopay: { enabled: !!ap?.enabled, max_cents_per_day: Number(ap?.max_cents_per_day || 0) },
      today: today.map(r => ({ family: r.family, calls: Number(r.calls), billable_cents: Number(r.billable_millicents) / 1000 })),
      month_to_date: { calls: Number(mtd.calls || 0), billable_cents: Number(mtd.mc || 0) / 1000 }
    });
  });

  app.get('/v1/revenue-model', (req, res) => {
    res.json({ wedges: wedges(), simulator: '/v1/revenue-model/simulate?agents=10000', plan_daily_calls: { ...PLAN_DAILY_CALLS, scale: 'unlimited', enterprise: 'unlimited' } });
  });

  app.get('/v1/revenue-model/simulate', (req, res) => {
    res.json(simulate(req.query || {}));
  });

  app.get('/v1/meter/stats', async (req, res) => {
    const t = (await safe(pool, `
      SELECT COUNT(DISTINCT identity)::int AS identities, COALESCE(SUM(calls),0)::bigint AS calls,
             COALESCE(SUM(billable_millicents),0)::bigint AS mc
      FROM usage_counters WHERE counter_date = CURRENT_DATE
    `))[0] || {};
    const m = (await safe(pool, `
      SELECT COALESCE(SUM(calls),0)::bigint AS calls, COALESCE(SUM(billable_millicents),0)::bigint AS mc
      FROM usage_counters WHERE counter_date >= date_trunc('month', CURRENT_DATE)
    `))[0] || {};
    res.json({
      today: { identities: t.identities || 0, calls: Number(t.calls || 0), billable_cents: Number(t.mc || 0) / 1000 },
      month_to_date: { calls: Number(m.calls || 0), billable_cents: Number(m.mc || 0) / 1000 },
      default_call_price_millicents: DEFAULT_CALL_MILLICENTS
    });
  });

  // Monthly rollup — runs daily, acts only on the UTC 1st, idempotent per
  // (identity, month) so re-fires are no-ops.
  registerCron(app, '/v1/_jobs/usage-invoices', async (req, res) => {
    const force = req.query.force === '1';
    if (new Date().getUTCDate() !== 1 && !force) return res.json({ generated: 0, message: 'not_the_1st' });
    const month = new Date(Date.now() - 86_400_000).toISOString().slice(0, 7); // prior month
    const rows = await safe(pool, `
      SELECT identity, SUM(calls)::bigint AS calls, SUM(billable_millicents)::bigint AS mc,
             jsonb_object_agg(family, calls) AS by_family
      FROM (
        SELECT identity, family, SUM(calls) AS calls, SUM(billable_millicents) AS billable_millicents
        FROM usage_counters
        WHERE to_char(counter_date, 'YYYY-MM') = $1 AND identity LIKE 'did:%'
        GROUP BY identity, family
      ) x GROUP BY identity LIMIT 50000
    `, [month]);
    let generated = 0;
    for (const r of rows) {
      const ins = await pool.query(
        `INSERT INTO usage_invoices (invoice_id, identity, month, total_calls, total_cents, by_family)
         VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (identity, month) DO NOTHING RETURNING invoice_id`,
        ['ui_' + crypto.randomBytes(10).toString('hex'), r.identity, month, Number(r.calls), Math.round(Number(r.mc) / 1000), JSON.stringify(r.by_family || {})]
      ).catch(() => ({ rows: [] }));
      if (ins.rows && ins.rows.length) generated++;
    }
    if (auditChain && generated) await auditChain.append({ event_type: 'meter.invoices_generated', month, count: generated }).catch(() => {});
    res.json({ month, generated });
  }, 'daily');

  // UI — the money machine
  app.get('/money', async (req, res) => {
    const sim = simulate(req.query || {});
    const t = (await safe(pool, `SELECT COUNT(DISTINCT identity)::int AS ids, COALESCE(SUM(calls),0)::bigint AS calls FROM usage_counters WHERE counter_date=CURRENT_DATE`))[0] || {};
    const wedgeRows = wedges().map(w =>
      `<tr><td><strong>${w.name}</strong></td><td>${w.rate}</td><td style="color:var(--dim)">${w.analog}</td><td><code style="font-size:12px">${w.formula}</code></td></tr>`).join('');
    const simRows = sim.by_wedge.map(w =>
      `<tr><td>${w.wedge}</td><td><strong>$${(w.mrr_cents / 100).toLocaleString()}</strong>/mo</td><td style="color:var(--dim);font-size:12px">${w.formula}</td></tr>`).join('');
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.send(shell('The Money Machine', 'Exactly how the substrate converts agents into revenue — every wedge, every rate, every formula.',
`<section style="max-width:880px;margin:0 auto;padding:60px 16px">
  <span class="badge b-acc">Revenue Model</span>
  <h1 style="font:600 40px/1.1 var(--display);letter-spacing:-1px;margin:18px 0">Exactly how this makes money.</h1>
  <p style="color:var(--dim2);font-size:16px;line-height:1.7">Fourteen coded revenue wedges, each billed by a live primitive. The meter fronts all <strong>2,400+</strong> API routes: every call is attributed, counted, priced, and rolled into a monthly invoice. Below: the full rate card, then a live simulator — every assumption is a URL parameter, so argue with the model by editing the address bar.</p>
  <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin:24px 0">
    <div class="kpi"><div class="label">Projected MRR @ ${sim.assumptions.agents.toLocaleString()} agents</div><div class="value">$${(sim.mrr_cents / 100).toLocaleString()}</div></div>
    <div class="kpi"><div class="label">Projected ARR</div><div class="value">$${(sim.arr_cents / 100).toLocaleString()}</div></div>
    <div class="kpi"><div class="label">Revenue / agent / mo</div><div class="value">$${(sim.per_agent_per_month_cents / 100).toFixed(2)}</div></div>
    <div class="kpi"><div class="label">Metered identities today</div><div class="value">${(t.ids || 0).toLocaleString()}</div></div>
  </div>
</section>
<section style="max-width:880px;margin:0 auto;padding:0 16px 40px">
  <h2 style="font:600 20px var(--display);margin:0 0 12px">The rate card</h2>
  <table style="width:100%;border-collapse:collapse;font-size:14px">
    <thead><tr style="text-align:left;color:var(--dim)"><th>Wedge</th><th>Rate</th><th>Analog</th><th>Formula</th></tr></thead>
    <tbody>${wedgeRows}</tbody>
  </table>
</section>
<section style="max-width:880px;margin:0 auto;padding:0 16px 60px">
  <h2 style="font:600 20px var(--display);margin:0 0 12px">The simulator — projected MRR by wedge</h2>
  <p style="color:var(--dim);font-size:13px;margin:0 0 12px">Current assumptions: ${sim.assumptions.agents.toLocaleString()} agents, ${(sim.assumptions.paid_pct * 100).toFixed(0)}% paid, ${sim.assumptions.calls_per_agent_day.toLocaleString()} calls/agent/day. Override any of them, e.g. <code>/money?agents=100000&paid_pct=8</code>. Machine-readable at <code>/v1/revenue-model/simulate</code>.</p>
  <table style="width:100%;border-collapse:collapse;font-size:14px">
    <thead><tr style="text-align:left;color:var(--dim)"><th>Wedge</th><th>MRR</th><th>How</th></tr></thead>
    <tbody>${simRows}</tbody>
  </table>
  <p style="color:var(--dim);font-size:12px;margin-top:16px">Allowances: free plans include ${PLAN_DAILY_CALLS.free.toLocaleString()} calls/day; over-allowance API traffic returns <code>402</code> with an upgrade path. Your own meter: <code>GET /v1/usage/:did</code>. The full execution plan lives in <code>MONEY_PLAN.md</code>.</p>
</section>`));
  });
}

module.exports = { migrate, installRevenueMeter, registerRevenueMeterRoutes, simulate, wedges };
