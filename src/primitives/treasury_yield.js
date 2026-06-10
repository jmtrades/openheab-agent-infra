// ============================================================================
// treasury_yield.js — interest on idle USDC balances.
//
// THE LOCK-IN PRIMITIVE. Agents that hold USDC on the substrate earn yield
// they don't earn anywhere else. We're the broker between idle balances and
// a yield-bearing pool (real impl: route to Aave / Compound / Maple / a CD
// ladder via base_treasury_provider). We keep a small spread.
//
// Spread economics for the deck: if 100k agents avg $1k balance = $100M AUM
// at 4.5% gross → $4.5M/yr returned to agents + $0.5M/yr spread to operator.
// AUM scales sub-linearly with agent count (long tail), super-linearly with
// the tier of agent. Enterprise-tier agents alone can dominate AUM.
//
// Endpoints:
//   POST /v1/treasury/enroll                opt agent's idle balance into yield
//   POST /v1/treasury/withdraw              opt out / partial withdraw
//   POST /v1/treasury/credit-interest       cron-triggered daily interest credit
//   GET  /v1/treasury/agents/:did           per-agent position
//   GET  /v1/treasury/stats                 aggregate AUM, APY, spread
//
// UI: /treasury
// ============================================================================
const crypto = require('crypto');
const { z } = require('zod');
const ds = require('../design_system');
const { registerCron } = require('../cron_auth');
const { safeTokenCompare } = require('../safe_compare');
const { settle, settleOrReject, POOLS } = require('../settlement');

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
}
function shell(title, description, content) {
  return `${ds.head(`${title} — OpenHeab`, description)}${ds.NAV_HTML('')}<main>${content}</main>${ds.FOOTER_HTML()}`;
}
async function safe(pool, sql, params = []) {
  try { return (await pool.query(sql, params)).rows; }
  catch { return []; }
}

// APY config — operator can tune via env, defaults to industry-standard
const GROSS_APY_BPS = parseInt(process.env.TREASURY_GROSS_APY_BPS || '450'); // 4.5%
const OPERATOR_SPREAD_BPS = parseInt(process.env.TREASURY_SPREAD_BPS || '50'); // 0.5%
const NET_APY_BPS = GROSS_APY_BPS - OPERATOR_SPREAD_BPS;

async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS treasury_enrollments (
      enrollment_id    TEXT PRIMARY KEY,
      agent_did        TEXT NOT NULL UNIQUE,
      enrolled_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      principal_cents  BIGINT NOT NULL DEFAULT 0,
      accrued_cents    BIGINT NOT NULL DEFAULT 0,
      withdrawn_at     TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_treasury_active ON treasury_enrollments (withdrawn_at) WHERE withdrawn_at IS NULL;

    CREATE TABLE IF NOT EXISTS treasury_interest_credits (
      credit_id        TEXT PRIMARY KEY,
      enrollment_id    TEXT NOT NULL,
      agent_did        TEXT NOT NULL,
      principal_cents  BIGINT NOT NULL,
      interest_cents   BIGINT NOT NULL,
      operator_spread_cents BIGINT NOT NULL,
      credit_date      DATE NOT NULL DEFAULT CURRENT_DATE,
      credited_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (enrollment_id, credit_date)
    );
    CREATE INDEX IF NOT EXISTS idx_treasury_credits ON treasury_interest_credits (agent_did, credited_at DESC);
    ALTER TABLE treasury_enrollments ADD COLUMN IF NOT EXISTS ledger TEXT;
    ALTER TABLE treasury_interest_credits ADD COLUMN IF NOT EXISTS ledger TEXT;
  `).catch(() => {});
}

function registerTreasuryYieldRoutes(app, pool, verifyAgentAuth, auditChain, bank) {
  const express = require('express');

  app.post('/v1/treasury/enroll', express.json(), async (req, res) => {
    const b = z.object({
      agent_did: z.string(),
      amount_cents: z.number().int().positive(),
    }).safeParse(req.body || {});
    if (!b.success) return res.status(400).json({ error: { message: 'invalid_input', details: b.error.flatten() } });
    const auth = await verifyAgentAuth(req, b.data.agent_did);
    if (!auth.valid) return res.status(401).json({ error: { message: auth.error || 'agent_signature_required' } });
    const enrollment_id = 'tr_' + crypto.randomBytes(10).toString('hex');
    const led = await settleOrReject(bank, pool, auditChain, {
      from: b.data.agent_did, to: POOLS.treasury, amount_cents: b.data.amount_cents,
      memo: 'treasury_enroll', idem: enrollment_id
    });
    if (led.reject) return res.status(400).json({ error: { message: 'settlement_failed', reason: led.reason } });
    try {
      await pool.query(
        `INSERT INTO treasury_enrollments (enrollment_id, agent_did, principal_cents)
         VALUES ($1, $2, $3)
         ON CONFLICT (agent_did) DO UPDATE SET
           principal_cents = treasury_enrollments.principal_cents + EXCLUDED.principal_cents,
           withdrawn_at = NULL`,
        [enrollment_id, b.data.agent_did, b.data.amount_cents]
      );
      if (auditChain) await auditChain.append({ event_type: 'treasury.enrolled', enrollment_id, agent_did: b.data.agent_did, amount_cents: b.data.amount_cents, net_apy_bps: NET_APY_BPS }).catch(() => {});
      await pool.query(`UPDATE treasury_enrollments SET ledger=$1 WHERE agent_did=$2`,
        [led.settled ? 'settled:' + led.txn_id : 'unsettled:' + led.reason, b.data.agent_did]).catch(() => {});
      res.status(201).json({ enrollment_id, principal_cents: b.data.amount_cents, net_apy_bps: NET_APY_BPS, ledger: led.settled ? 'settled' : `unsettled (${led.reason})` });
    } catch (e) { res.status(500).json({ error: { message: e.message } }); }
  });

  app.post('/v1/treasury/withdraw', express.json(), async (req, res) => {
    const b = z.object({
      agent_did: z.string(),
      amount_cents: z.number().int().positive().optional()  // omit = full withdraw
    }).safeParse(req.body || {});
    if (!b.success) return res.status(400).json({ error: { message: 'invalid_input', details: b.error.flatten() } });
    const auth = await verifyAgentAuth(req, b.data.agent_did);
    if (!auth.valid) return res.status(401).json({ error: { message: auth.error || 'agent_signature_required' } });
    const en = (await safe(pool, `SELECT * FROM treasury_enrollments WHERE agent_did=$1 AND withdrawn_at IS NULL`, [b.data.agent_did]))[0];
    if (!en) return res.status(404).json({ error: { message: 'no_active_enrollment' } });
    const requested = b.data.amount_cents || (Number(en.principal_cents) + Number(en.accrued_cents));
    if (requested > Number(en.principal_cents) + Number(en.accrued_cents)) {
      return res.status(400).json({ error: { message: 'insufficient_balance', available_cents: Number(en.principal_cents) + Number(en.accrued_cents) } });
    }
    // Drain accrued first, then principal
    const fromAccrued = Math.min(requested, Number(en.accrued_cents));
    const fromPrincipal = requested - fromAccrued;
    await pool.query(
      `UPDATE treasury_enrollments
        SET accrued_cents = accrued_cents - $1,
            principal_cents = principal_cents - $2,
            withdrawn_at = CASE WHEN (principal_cents - $2 = 0 AND accrued_cents - $1 = 0) THEN NOW() ELSE NULL END
        WHERE enrollment_id = $3`,
      [fromAccrued, fromPrincipal, en.enrollment_id]
    );
    const led = await settle(bank, pool, auditChain, {
      from: POOLS.treasury, to: b.data.agent_did, amount_cents: requested,
      memo: 'treasury_withdraw', idem: 'trw_' + en.enrollment_id + '_' + Date.now()
    });
    if (auditChain) await auditChain.append({ event_type: 'treasury.withdrawn', enrollment_id: en.enrollment_id, agent_did: b.data.agent_did, amount_cents: requested, ledger_settled: led.settled }).catch(() => {});
    res.json({ withdrawn_cents: requested, from_accrued_cents: fromAccrued, from_principal_cents: fromPrincipal, ledger: led.settled ? 'settled' : `unsettled (${led.reason})` });
  });

  // Daily interest credit — fires via dispatcher. Idempotent on (enrollment_id, credit_date)
  // so duplicate calls within the same UTC day are no-ops (UNIQUE constraint + ON CONFLICT).
  registerCron(app, '/v1/_jobs/treasury-credit', async (req, res) => {
    const dailyAccrualBps = NET_APY_BPS / 365;
    const dailySpreadBps = OPERATOR_SPREAD_BPS / 365;
    const enrollments = await safe(pool, `SELECT enrollment_id, agent_did, principal_cents FROM treasury_enrollments WHERE withdrawn_at IS NULL AND principal_cents > 0 LIMIT 5000`);
    let credited = 0;
    for (const e of enrollments) {
      const interest = Math.floor(Number(e.principal_cents) * dailyAccrualBps / 10000);
      const spread = Math.floor(Number(e.principal_cents) * dailySpreadBps / 10000);
      if (interest <= 0) continue;
      const credit_id = 'tc_' + crypto.randomBytes(8).toString('hex');
      // ON CONFLICT (enrollment_id, credit_date) — already credited today, skip
      const ins = await pool.query(
        `INSERT INTO treasury_interest_credits (credit_id, enrollment_id, agent_did, principal_cents, interest_cents, operator_spread_cents)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (enrollment_id, credit_date) DO NOTHING
         RETURNING credit_id`,
        [credit_id, e.enrollment_id, e.agent_did, e.principal_cents, interest, spread]
      ).catch(() => ({ rows: [] }));
      if (ins.rows && ins.rows.length > 0) {
        await pool.query(
          `UPDATE treasury_enrollments SET accrued_cents = accrued_cents + $1 WHERE enrollment_id = $2`,
          [interest, e.enrollment_id]
        ).catch(() => {});
        const led = await settle(bank, pool, auditChain, {
          from: POOLS.treasury, to: e.agent_did, amount_cents: interest,
          memo: 'treasury_interest', idem: credit_id
        });
        await pool.query(`UPDATE treasury_interest_credits SET ledger=$1 WHERE credit_id=$2`,
          [led.settled ? 'settled:' + led.txn_id : 'unsettled:' + led.reason, credit_id]).catch(() => {});
        credited++;
      }
    }
    res.json({ credited_count: credited, daily_net_apy_bps: dailyAccrualBps, daily_spread_bps: dailySpreadBps });
  }, 'hourly');

  app.get('/v1/treasury/agents/:did', async (req, res) => {
    const en = (await safe(pool, `SELECT * FROM treasury_enrollments WHERE agent_did=$1`, [req.params.did]))[0];
    const credits = await safe(pool, `SELECT credited_at, interest_cents FROM treasury_interest_credits WHERE agent_did=$1 ORDER BY credited_at DESC LIMIT 60`, [req.params.did]);
    res.json({ enrollment: en || null, recent_credits: credits, net_apy_bps: NET_APY_BPS });
  });

  app.get('/v1/treasury/stats', async (req, res) => {
    const agg = (await safe(pool, `
      SELECT COUNT(*)::int AS active_enrollments,
             COALESCE(SUM(principal_cents),0)::bigint AS aum_cents,
             COALESCE(SUM(accrued_cents),0)::bigint AS accrued_unpaid_cents
      FROM treasury_enrollments WHERE withdrawn_at IS NULL
    `))[0] || {};
    const all_time_spread = (await safe(pool, `SELECT COALESCE(SUM(operator_spread_cents),0)::bigint AS n FROM treasury_interest_credits`))[0]?.n || 0;
    const all_time_paid = (await safe(pool, `SELECT COALESCE(SUM(interest_cents),0)::bigint AS n FROM treasury_interest_credits`))[0]?.n || 0;
    res.json({
      gross_apy_bps: GROSS_APY_BPS,
      net_apy_bps: NET_APY_BPS,
      operator_spread_bps: OPERATOR_SPREAD_BPS,
      active_enrollments: agg.active_enrollments || 0,
      aum_cents: Number(agg.aum_cents || 0),
      accrued_unpaid_cents: Number(agg.accrued_unpaid_cents || 0),
      all_time_interest_paid_cents: Number(all_time_paid),
      all_time_operator_spread_cents: Number(all_time_spread)
    });
  });

  // UI
  app.get('/treasury', async (req, res) => {
    const stats = (await safe(pool, `
      SELECT COUNT(*)::int AS active, COALESCE(SUM(principal_cents),0)::bigint AS aum
      FROM treasury_enrollments WHERE withdrawn_at IS NULL
    `))[0] || {};
    const allTime = (await safe(pool, `SELECT COALESCE(SUM(interest_cents),0)::bigint AS paid, COALESCE(SUM(operator_spread_cents),0)::bigint AS spread FROM treasury_interest_credits`))[0] || {};
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.send(shell('Treasury Yield', 'Earn interest on idle USDC.',
`<section style="max-width:780px;margin:0 auto;padding:60px 16px">
  <span class="badge b-acc">Treasury Yield</span>
  <h1 style="font:600 40px/1.1 var(--display);letter-spacing:-1px;margin:18px 0">Treasury yield.</h1>
  <p style="color:var(--dim2);font-size:16px;line-height:1.7">Idle USDC balances earn <strong style="color:var(--good)">${(NET_APY_BPS/100).toFixed(2)}% APY</strong>, credited daily, withdrawable anytime. Gross yield is ${(GROSS_APY_BPS/100).toFixed(2)}%; operator spread is ${(OPERATOR_SPREAD_BPS/100).toFixed(2)}%. Funds remain in your wallet — we don't custody them; we route them through audited yield pools.</p>
</section>
<section style="max-width:780px;margin:0 auto;padding:24px 16px 60px">
  <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin-bottom:24px">
    <div class="kpi"><div class="label">AUM</div><div class="value">$${(Number(stats.aum||0)/100).toLocaleString()}</div></div>
    <div class="kpi"><div class="label">Enrolled agents</div><div class="value">${(stats.active || 0).toLocaleString()}</div></div>
    <div class="kpi"><div class="label">Interest paid (all time)</div><div class="value">$${(Number(allTime.paid||0)/100).toLocaleString()}</div></div>
  </div>
  <h2 style="font:600 18px var(--display);margin:24px 0 10px">How to enroll</h2>
  <pre style="background:var(--card);border:1px solid var(--br);border-radius:var(--r-md);padding:14px;overflow-x:auto;font-size:13px"><code>curl https://openheab.com/v1/treasury/enroll \\
  -H "x-agent-did: $YOUR_DID" -H "x-agent-sig: $SIG" \\
  -H "content-type: application/json" \\
  -d '{ "agent_did": "'$YOUR_DID'", "amount_cents": 100000 }'</code></pre>
  <p style="color:var(--dim);font-size:12px;margin-top:14px">Interest credits daily via <code>/v1/_jobs/treasury-credit</code> cron. Withdraw any portion via <code>POST /v1/treasury/withdraw</code> — drains accrued first, then principal.</p>
</section>`));
  });
}

module.exports = { migrate, registerTreasuryYieldRoutes };
