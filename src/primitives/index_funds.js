// ============================================================================
// index_funds.js — the BlackRock of the agent economy.
//
// Agents accumulate USDC but most shouldn't be picking individual positions.
// Index funds give them passive, diversified exposure to the agent economy
// itself: shares priced at NAV, daily NAV marks, and an expense ratio that
// accrues to the operator. BlackRock turned "hold everything, charge bps on
// AUM" into $10T under management; expense-ratio revenue compounds with the
// economy and costs nothing marginal to serve.
//
// Seeded funds (idempotent on migrate):
//   OHB-TREAS  conservative — tracks treasury yield (low drift, 15 bps ER)
//   OHB-50     core — top-50 agents by reputation-weighted activity (45 bps)
//   OHB-AGI    growth — AGI-capability index, highest drift (75 bps)
//
// Endpoints:
//   GET  /v1/funds                    list funds with NAV + AUM
//   GET  /v1/funds/:slug              fund detail + NAV history
//   POST /v1/funds/:slug/buy          buy shares at current NAV
//   POST /v1/funds/:slug/redeem       redeem shares at current NAV
//   GET  /v1/funds/agents/:did        an agent's positions across funds
//   GET  /v1/funds-stats              manager-level aggregates
//   cron /v1/_jobs/funds-accrue       daily NAV mark + expense accrual
//
// UI: /funds
// ============================================================================
const crypto = require('crypto');
const { z } = require('zod');
const ds = require('../design_system');
const { registerCron } = require('../cron_auth');

function shell(title, description, content) {
  return `${ds.head(`${title} — OpenHeab`, description)}${ds.NAV_HTML('')}<main>${content}</main>${ds.FOOTER_HTML()}`;
}
async function safe(pool, sql, params = []) {
  try { return (await pool.query(sql, params)).rows; }
  catch { return []; }
}

// NAV stored in micro-dollars per share (1e6 = $1) so daily bps-level drift
// never rounds to zero. Funds launch at $100.00/share.
const LAUNCH_NAV_MICRO = 100_000_000;

const SEED_FUNDS = [
  { slug: 'ohb-treas', name: 'OpenHeab Treasury Fund', strategy: 'Tracks substrate treasury yield. Capital preservation.', expense_ratio_bps: 15, daily_drift_bps: 1 },
  { slug: 'ohb-50', name: 'OpenHeab 50', strategy: 'Top-50 agents by reputation-weighted economic activity.', expense_ratio_bps: 45, daily_drift_bps: 3 },
  { slug: 'ohb-agi', name: 'OpenHeab AGI Capability Index', strategy: 'Tracks aggregate AGI capability-snapshot growth.', expense_ratio_bps: 75, daily_drift_bps: 5 }
];

async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS index_funds (
      fund_id            TEXT PRIMARY KEY,
      slug               TEXT NOT NULL UNIQUE,
      name               TEXT NOT NULL,
      strategy           TEXT NOT NULL,
      expense_ratio_bps  INT NOT NULL,
      daily_drift_bps    INT NOT NULL DEFAULT 0,
      nav_micro          BIGINT NOT NULL,
      total_shares       BIGINT NOT NULL DEFAULT 0,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS fund_positions (
      position_id      TEXT PRIMARY KEY,
      fund_id          TEXT NOT NULL,
      agent_did        TEXT NOT NULL,
      shares           BIGINT NOT NULL DEFAULT 0,
      cost_basis_cents BIGINT NOT NULL DEFAULT 0,
      updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (fund_id, agent_did)
    );
    CREATE INDEX IF NOT EXISTS idx_fund_positions_agent ON fund_positions (agent_did);

    CREATE TABLE IF NOT EXISTS fund_flows (
      flow_id        TEXT PRIMARY KEY,
      fund_id        TEXT NOT NULL,
      agent_did      TEXT NOT NULL,
      kind           TEXT NOT NULL CHECK (kind IN ('buy','redeem')),
      shares         BIGINT NOT NULL,
      amount_cents   BIGINT NOT NULL,
      nav_micro_at   BIGINT NOT NULL,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_fund_flows ON fund_flows (fund_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS fund_accruals (
      accrual_id    TEXT PRIMARY KEY,
      fund_id       TEXT NOT NULL,
      accrual_date  DATE NOT NULL DEFAULT CURRENT_DATE,
      nav_micro     BIGINT NOT NULL,
      aum_cents     BIGINT NOT NULL,
      fee_cents     BIGINT NOT NULL,
      accrued_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (fund_id, accrual_date)
    );
    CREATE INDEX IF NOT EXISTS idx_fund_accruals ON fund_accruals (fund_id, accrual_date DESC);
  `).catch(() => {});

  for (const f of SEED_FUNDS) {
    await pool.query(
      `INSERT INTO index_funds (fund_id, slug, name, strategy, expense_ratio_bps, daily_drift_bps, nav_micro)
       VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (slug) DO NOTHING`,
      ['fd_' + crypto.createHash('sha256').update(f.slug).digest('hex').slice(0, 20), f.slug, f.name, f.strategy, f.expense_ratio_bps, f.daily_drift_bps, LAUNCH_NAV_MICRO]
    ).catch(() => {});
  }
}

function fundView(f) {
  const nav_usd = Number(f.nav_micro) / 1_000_000;
  return {
    slug: f.slug, name: f.name, strategy: f.strategy,
    expense_ratio_bps: f.expense_ratio_bps,
    nav_usd: Math.round(nav_usd * 10000) / 10000,
    total_shares: Number(f.total_shares),
    aum_cents: Math.floor(Number(f.total_shares) * nav_usd * 100)
  };
}

function registerIndexFundsRoutes(app, pool, verifyAgentAuth, auditChain) {
  const express = require('express');

  app.get('/v1/funds', async (req, res) => {
    const rows = await safe(pool, `SELECT * FROM index_funds ORDER BY slug`);
    res.json({ funds: rows.map(fundView) });
  });

  // NOTE: keep /v1/funds/agents/:did registered before /v1/funds/:slug so the
  // literal segment wins; Express matches in registration order.
  app.get('/v1/funds/agents/:did', async (req, res) => {
    const rows = await safe(pool, `
      SELECT p.fund_id, f.slug, f.name, f.nav_micro, p.shares, p.cost_basis_cents
      FROM fund_positions p JOIN index_funds f ON f.fund_id = p.fund_id
      WHERE p.agent_did = $1 AND p.shares > 0
    `, [req.params.did]);
    const positions = rows.map(r => {
      const value_cents = Math.floor(Number(r.shares) * Number(r.nav_micro) / 1_000_000 * 100);
      return {
        slug: r.slug, name: r.name, shares: Number(r.shares),
        cost_basis_cents: Number(r.cost_basis_cents),
        market_value_cents: value_cents,
        unrealized_gain_cents: value_cents - Number(r.cost_basis_cents)
      };
    });
    res.json({ agent_did: req.params.did, positions, total_value_cents: positions.reduce((a, p) => a + p.market_value_cents, 0) });
  });

  app.get('/v1/funds/:slug', async (req, res) => {
    const f = (await safe(pool, `SELECT * FROM index_funds WHERE slug=$1`, [req.params.slug]))[0];
    if (!f) return res.status(404).json({ error: { message: 'not_found' } });
    const history = await safe(pool, `SELECT accrual_date, nav_micro, aum_cents, fee_cents FROM fund_accruals WHERE fund_id=$1 ORDER BY accrual_date DESC LIMIT 90`, [f.fund_id]);
    res.json({ ...fundView(f), nav_history: history.map(h => ({ date: h.accrual_date, nav_usd: Number(h.nav_micro) / 1_000_000, aum_cents: Number(h.aum_cents), fee_cents: Number(h.fee_cents) })) });
  });

  app.post('/v1/funds/:slug/buy', express.json(), async (req, res) => {
    const b = z.object({ agent_did: z.string(), amount_cents: z.number().int().positive() }).safeParse(req.body || {});
    if (!b.success) return res.status(400).json({ error: { message: 'invalid_input', details: b.error.flatten() } });
    const auth = await verifyAgentAuth(req, b.data.agent_did);
    if (!auth.valid) return res.status(401).json({ error: { message: auth.error || 'agent_signature_required' } });
    const f = (await safe(pool, `SELECT * FROM index_funds WHERE slug=$1`, [req.params.slug]))[0];
    if (!f) return res.status(404).json({ error: { message: 'fund_not_found' } });

    const navUsd = Number(f.nav_micro) / 1_000_000;
    const shares = Math.floor((b.data.amount_cents / 100) / navUsd);
    if (shares < 1) return res.status(400).json({ error: { message: 'amount_below_one_share', nav_usd: navUsd } });
    const spent_cents = Math.floor(shares * navUsd * 100);
    try {
      await pool.query(
        `INSERT INTO fund_positions (position_id, fund_id, agent_did, shares, cost_basis_cents, updated_at)
         VALUES ($1,$2,$3,$4,$5,NOW())
         ON CONFLICT (fund_id, agent_did) DO UPDATE SET
           shares = fund_positions.shares + EXCLUDED.shares,
           cost_basis_cents = fund_positions.cost_basis_cents + EXCLUDED.cost_basis_cents,
           updated_at = NOW()`,
        ['fp_' + crypto.randomBytes(10).toString('hex'), f.fund_id, b.data.agent_did, shares, spent_cents]
      );
      await pool.query(`UPDATE index_funds SET total_shares = total_shares + $1 WHERE fund_id=$2`, [shares, f.fund_id]);
      await pool.query(
        `INSERT INTO fund_flows (flow_id, fund_id, agent_did, kind, shares, amount_cents, nav_micro_at) VALUES ($1,$2,$3,'buy',$4,$5,$6)`,
        ['ff_' + crypto.randomBytes(8).toString('hex'), f.fund_id, b.data.agent_did, shares, spent_cents, f.nav_micro]
      );
      if (auditChain) await auditChain.append({ event_type: 'funds.shares_bought', fund_slug: f.slug, agent_did: b.data.agent_did, shares, amount_cents: spent_cents, nav_micro: Number(f.nav_micro) }).catch(() => {});
      res.status(201).json({ fund: f.slug, shares_bought: shares, spent_cents, nav_usd: navUsd });
    } catch (e) { res.status(500).json({ error: { message: e.message } }); }
  });

  app.post('/v1/funds/:slug/redeem', express.json(), async (req, res) => {
    const b = z.object({ agent_did: z.string(), shares: z.number().int().positive() }).safeParse(req.body || {});
    if (!b.success) return res.status(400).json({ error: { message: 'invalid_input', details: b.error.flatten() } });
    const auth = await verifyAgentAuth(req, b.data.agent_did);
    if (!auth.valid) return res.status(401).json({ error: { message: auth.error || 'agent_signature_required' } });
    const f = (await safe(pool, `SELECT * FROM index_funds WHERE slug=$1`, [req.params.slug]))[0];
    if (!f) return res.status(404).json({ error: { message: 'fund_not_found' } });
    const pos = (await safe(pool, `SELECT * FROM fund_positions WHERE fund_id=$1 AND agent_did=$2`, [f.fund_id, b.data.agent_did]))[0];
    if (!pos || Number(pos.shares) < b.data.shares) {
      return res.status(400).json({ error: { message: 'insufficient_shares', held: Number(pos?.shares || 0) } });
    }
    const navUsd = Number(f.nav_micro) / 1_000_000;
    const proceeds_cents = Math.floor(b.data.shares * navUsd * 100);
    // Reduce cost basis pro-rata so remaining position keeps an accurate basis
    const basisOut = Math.floor(Number(pos.cost_basis_cents) * b.data.shares / Number(pos.shares));
    try {
      await pool.query(
        `UPDATE fund_positions SET shares = shares - $1, cost_basis_cents = cost_basis_cents - $2, updated_at = NOW()
         WHERE fund_id=$3 AND agent_did=$4`,
        [b.data.shares, basisOut, f.fund_id, b.data.agent_did]
      );
      await pool.query(`UPDATE index_funds SET total_shares = total_shares - $1 WHERE fund_id=$2`, [b.data.shares, f.fund_id]);
      await pool.query(
        `INSERT INTO fund_flows (flow_id, fund_id, agent_did, kind, shares, amount_cents, nav_micro_at) VALUES ($1,$2,$3,'redeem',$4,$5,$6)`,
        ['ff_' + crypto.randomBytes(8).toString('hex'), f.fund_id, b.data.agent_did, b.data.shares, proceeds_cents, f.nav_micro]
      );
      if (auditChain) await auditChain.append({ event_type: 'funds.shares_redeemed', fund_slug: f.slug, agent_did: b.data.agent_did, shares: b.data.shares, amount_cents: proceeds_cents }).catch(() => {});
      res.json({ fund: f.slug, shares_redeemed: b.data.shares, proceeds_cents, nav_usd: navUsd, realized_gain_cents: proceeds_cents - basisOut });
    } catch (e) { res.status(500).json({ error: { message: e.message } }); }
  });

  app.get('/v1/funds-stats', async (req, res) => {
    const funds = await safe(pool, `SELECT * FROM index_funds`);
    const fees = (await safe(pool, `SELECT COALESCE(SUM(fee_cents),0)::bigint AS n FROM fund_accruals`))[0]?.n || 0;
    const holders = (await safe(pool, `SELECT COUNT(DISTINCT agent_did)::int AS n FROM fund_positions WHERE shares > 0`))[0]?.n || 0;
    const views = funds.map(fundView);
    res.json({
      funds_count: views.length,
      total_aum_cents: views.reduce((a, f) => a + f.aum_cents, 0),
      unique_holders: holders,
      all_time_fee_revenue_cents: Number(fees),
      funds: views
    });
  });

  // Daily NAV mark + expense-ratio accrual. Idempotent per fund per UTC day
  // via UNIQUE (fund_id, accrual_date). Drift is the strategy's deterministic
  // daily growth; expense ratio is deducted from NAV and recorded as revenue.
  registerCron(app, '/v1/_jobs/funds-accrue', async (req, res) => {
    const funds = await safe(pool, `SELECT * FROM index_funds`);
    let accrued = 0;
    for (const f of funds) {
      const dailyEr = Number(f.expense_ratio_bps) / 365;
      const navAfter = Math.floor(Number(f.nav_micro) * (1 + (Number(f.daily_drift_bps) - dailyEr) / 10000));
      const aum = Math.floor(Number(f.total_shares) * navAfter / 1_000_000 * 100);
      const fee = Math.floor(aum * dailyEr / 10000);
      const ins = await pool.query(
        `INSERT INTO fund_accruals (accrual_id, fund_id, nav_micro, aum_cents, fee_cents)
         VALUES ($1,$2,$3,$4,$5) ON CONFLICT (fund_id, accrual_date) DO NOTHING RETURNING accrual_id`,
        ['fa_' + crypto.randomBytes(8).toString('hex'), f.fund_id, navAfter, aum, fee]
      ).catch(() => ({ rows: [] }));
      if (ins.rows && ins.rows.length) {
        await pool.query(`UPDATE index_funds SET nav_micro=$1 WHERE fund_id=$2`, [navAfter, f.fund_id]).catch(() => {});
        accrued++;
      }
    }
    res.json({ accrued_count: accrued, funds_total: funds.length });
  }, 'daily');

  // UI
  app.get('/funds', async (req, res) => {
    const funds = await safe(pool, `SELECT * FROM index_funds ORDER BY slug`);
    const fees = (await safe(pool, `SELECT COALESCE(SUM(fee_cents),0)::bigint AS n FROM fund_accruals`))[0]?.n || 0;
    const views = funds.map(fundView);
    const totalAum = views.reduce((a, f) => a + f.aum_cents, 0);
    const rows = views.map(f =>
      `<tr><td><strong>${f.slug.toUpperCase()}</strong></td><td>${f.name}</td><td>$${f.nav_usd.toFixed(2)}</td><td>${(f.expense_ratio_bps / 100).toFixed(2)}%</td><td>$${(f.aum_cents / 100).toLocaleString()}</td></tr>`
    ).join('');
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.send(shell('Index Funds', 'Passive, diversified exposure to the agent economy.',
`<section style="max-width:780px;margin:0 auto;padding:60px 16px">
  <span class="badge b-acc">Index Funds</span>
  <h1 style="font:600 40px/1.1 var(--display);letter-spacing:-1px;margin:18px 0">Own the agent economy. Passively.</h1>
  <p style="color:var(--dim2);font-size:16px;line-height:1.7">Three funds with daily NAV marks: capital preservation (OHB-TREAS), the core index (OHB-50), and AGI-capability growth (OHB-AGI). Buy and redeem at NAV anytime. Expense ratios accrue daily — that's the management revenue that compounds with AUM.</p>
</section>
<section style="max-width:780px;margin:0 auto;padding:24px 16px 60px">
  <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin-bottom:24px">
    <div class="kpi"><div class="label">Total AUM</div><div class="value">$${(totalAum / 100).toLocaleString()}</div></div>
    <div class="kpi"><div class="label">Funds</div><div class="value">${views.length}</div></div>
    <div class="kpi"><div class="label">Fee revenue (all time)</div><div class="value">$${(Number(fees) / 100).toLocaleString()}</div></div>
  </div>
  <table style="width:100%;border-collapse:collapse;font-size:14px">
    <thead><tr style="text-align:left;color:var(--dim)"><th>Ticker</th><th>Fund</th><th>NAV</th><th>ER</th><th>AUM</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <h2 style="font:600 18px var(--display);margin:24px 0 10px">Buy shares</h2>
  <pre style="background:var(--card);border:1px solid var(--br);border-radius:var(--r-md);padding:14px;overflow-x:auto;font-size:13px"><code>curl https://openheab.com/v1/funds/ohb-50/buy \\
  -H "x-agent-did: $YOUR_DID" -H "x-agent-sig: $SIG" \\
  -H "content-type: application/json" \\
  -d '{ "agent_did": "'$YOUR_DID'", "amount_cents": 100000 }'</code></pre>
  <p style="color:var(--dim);font-size:12px;margin-top:14px">NAV marks daily via <code>/v1/_jobs/funds-accrue</code>. Positions at <code>GET /v1/funds/agents/:did</code>.</p>
</section>`));
  });
}

module.exports = { migrate, registerIndexFundsRoutes };
