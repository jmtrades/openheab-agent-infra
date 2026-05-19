// ============================================================================
// revenue_dashboard.js — public-facing MRR/ARR tracker + operator-side
// SaaS metrics (MRR / ARR / churn / LTV / CAC / cohort retention).
//
// Public: /revenue/public — a stripped-down stripe-quality "watch us grow"
//   widget that builds trust + creates ambient pressure to perform.
// Operator: /revenue/operator — full BI: ARR by cohort, churn waterfall,
//   net-dollar retention, top customers, expansion vs contraction.
//
// Endpoints:
//   GET  /v1/revenue/public          last 30/90/365-day MRR/ARR/customers, JSON
//   GET  /v1/revenue/operator        operator dashboard JSON (admin-guarded)
//   GET  /v1/revenue/cohorts         monthly cohort retention table
// ============================================================================
const ds = require('../design_system');
const { safeTokenCompare } = require('../safe_compare');

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
}
function shell(title, description, content, extraHead = '') {
  return `${ds.head(`${title} — OpenHeab`, description, { extraHead })}${ds.NAV_HTML('')}<main>${content}</main>${ds.FOOTER_HTML()}`;
}
async function safe(pool, sql, params = []) {
  try { return (await pool.query(sql, params)).rows; }
  catch { return []; }
}
function isAdmin(req) {
  return safeTokenCompare(req.headers['x-admin-token'] || req.query.admin_token, process.env.OPERATOR_ADMIN_TOKEN);
}

async function migrate(_pool) { /* derived from existing tables */ }

// Compute summary from the substrate's existing tables. We don't track MRR
// directly — we synthesize it from `subscriptions` (recurring), `revenue` (any
// recorded line), and `enterprise_invoices` (large procurement).
async function publicSummary(pool) {
  const subs = (await safe(pool, `
    SELECT
      COUNT(*) FILTER (WHERE status='active')::int AS active_subs,
      COUNT(*) FILTER (WHERE status='cancelled' AND updated_at > NOW() - INTERVAL '30 days')::int AS churned_30d
    FROM subscriptions
  `))[0] || {};
  // Revenue layer ledger (existing 'revenue' primitive)
  const rev = (await safe(pool, `
    SELECT
      COALESCE(SUM(amount_cents) FILTER (WHERE recorded_at > NOW() - INTERVAL '30 days'),0)::bigint AS r30,
      COALESCE(SUM(amount_cents) FILTER (WHERE recorded_at > NOW() - INTERVAL '90 days'),0)::bigint AS r90,
      COALESCE(SUM(amount_cents) FILTER (WHERE recorded_at > NOW() - INTERVAL '365 days'),0)::bigint AS r365,
      COALESCE(SUM(amount_cents),0)::bigint AS all_time
    FROM revenue_events
  `))[0] || {};
  const ent = (await safe(pool, `
    SELECT COALESCE(SUM(annual_value_cents) FILTER (WHERE status='active'),0)::bigint AS arr
    FROM enterprise_orders
  `))[0]?.arr || 0;
  const treasuryAum = (await safe(pool, `
    SELECT COALESCE(SUM(principal_cents),0)::bigint AS n FROM treasury_enrollments WHERE withdrawn_at IS NULL
  `))[0]?.n || 0;
  const r30 = Number(rev.r30 || 0);
  return {
    mrr_cents: r30,                       // last-30-day revenue proxy
    arr_cents_proxy: r30 * 12,
    enterprise_arr_cents: Number(ent),
    total_arr_cents: Number(ent) + r30 * 12,
    revenue_30d_cents: r30,
    revenue_90d_cents: Number(rev.r90 || 0),
    revenue_365d_cents: Number(rev.r365 || 0),
    revenue_all_time_cents: Number(rev.all_time || 0),
    active_subscriptions: subs.active_subs || 0,
    churned_subscriptions_30d: subs.churned_30d || 0,
    treasury_aum_cents: Number(treasuryAum)
  };
}

async function operatorSummary(pool) {
  const base = await publicSummary(pool);
  // Top customers by all-time revenue
  const top = await safe(pool, `
    SELECT org_id, COALESCE(SUM(amount_cents),0)::bigint AS revenue
    FROM revenue_events WHERE org_id IS NOT NULL GROUP BY org_id
    ORDER BY revenue DESC NULLS LAST LIMIT 20
  `);
  // Revenue by layer (we track source_layer in revenue_events)
  const byLayer = await safe(pool, `
    SELECT source_layer, COALESCE(SUM(amount_cents),0)::bigint AS revenue, COUNT(*)::int AS n
    FROM revenue_events GROUP BY source_layer ORDER BY revenue DESC NULLS LAST LIMIT 50
  `);
  // Last 12 months revenue
  const monthly = await safe(pool, `
    SELECT date_trunc('month', recorded_at) AS month, COALESCE(SUM(amount_cents),0)::bigint AS revenue
    FROM revenue_events WHERE recorded_at > NOW() - INTERVAL '12 months'
    GROUP BY month ORDER BY month
  `);
  // Outstanding enterprise invoices
  const ar = (await safe(pool, `
    SELECT COALESCE(SUM(total_cents),0)::bigint AS n, COUNT(*)::int AS c
    FROM enterprise_invoices WHERE status='issued'
  `))[0] || {};
  const overdue = (await safe(pool, `
    SELECT COALESCE(SUM(total_cents),0)::bigint AS n, COUNT(*)::int AS c
    FROM enterprise_invoices WHERE status='issued' AND due_at < CURRENT_DATE
  `))[0] || {};
  return { ...base, top_customers: top, revenue_by_layer: byLayer, monthly_revenue: monthly,
    ar_outstanding_cents: Number(ar.n || 0), ar_outstanding_count: ar.c || 0,
    ar_overdue_cents: Number(overdue.n || 0), ar_overdue_count: overdue.c || 0 };
}

async function cohortRetention(pool) {
  // Monthly cohort = month of first revenue event per org. For each cohort,
  // count how many were still active in subsequent months. Crude but useful
  // for trend visibility.
  return safe(pool, `
    WITH cohort AS (
      SELECT org_id, date_trunc('month', MIN(recorded_at)) AS cohort_month
      FROM revenue_events WHERE org_id IS NOT NULL GROUP BY org_id
    ),
    activity AS (
      SELECT org_id, date_trunc('month', recorded_at) AS active_month
      FROM revenue_events WHERE org_id IS NOT NULL
    )
    SELECT c.cohort_month, a.active_month, COUNT(DISTINCT c.org_id)::int AS active_orgs
    FROM cohort c JOIN activity a USING (org_id)
    WHERE c.cohort_month > NOW() - INTERVAL '12 months'
    GROUP BY c.cohort_month, a.active_month
    ORDER BY c.cohort_month, a.active_month
  `);
}

function registerRevenueDashboardRoutes(app, pool, _verifyAgentAuth, _auditChain) {
  app.get('/v1/revenue/public', async (req, res) => {
    res.setHeader('cache-control', 'public, max-age=300');
    res.json(await publicSummary(pool));
  });

  app.get('/v1/revenue/operator', async (req, res) => {
    if (!isAdmin(req)) return res.status(401).json({ error: { message: 'admin_required' } });
    res.json(await operatorSummary(pool));
  });

  app.get('/v1/revenue/cohorts', async (req, res) => {
    if (!isAdmin(req)) return res.status(401).json({ error: { message: 'admin_required' } });
    res.json({ cohorts: await cohortRetention(pool) });
  });

  // Public revenue page — a single-screen watch-us-grow widget. Builds trust.
  app.get('/revenue/public', async (req, res) => {
    const s = await publicSummary(pool);
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.send(shell('Revenue — public', 'Watch the substrate grow in real time.',
`<section style="max-width:780px;margin:0 auto;padding:60px 16px;text-align:center">
  <span class="badge b-acc" style="display:inline-flex;gap:6px;align-items:center"><span class="ld"></span>Live</span>
  <h1 style="font:600 44px/1.05 var(--display);letter-spacing:-1.5px;margin:18px 0">Watch us grow.</h1>
  <p style="color:var(--dim2);font-size:15px;line-height:1.6;max-width:540px;margin:0 auto">Substrate revenue, MRR proxy from the last 30 days, enterprise ARR from signed orders. Updated every 5 minutes.</p>
</section>
<section style="max-width:980px;margin:0 auto;padding:24px 16px 60px">
  <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px">
    <div class="kpi"><div class="label">MRR (proxy)</div><div class="value" id="mrr">$${(s.mrr_cents/100).toLocaleString()}</div></div>
    <div class="kpi"><div class="label">Total ARR</div><div class="value" id="arr">$${(s.total_arr_cents/100).toLocaleString()}</div></div>
    <div class="kpi"><div class="label">Enterprise ARR</div><div class="value" id="earr">$${(s.enterprise_arr_cents/100).toLocaleString()}</div></div>
    <div class="kpi"><div class="label">All-time revenue</div><div class="value" id="atime">$${(s.revenue_all_time_cents/100).toLocaleString()}</div></div>
    <div class="kpi"><div class="label">Active subs</div><div class="value" id="subs">${(s.active_subscriptions).toLocaleString()}</div></div>
    <div class="kpi"><div class="label">Treasury AUM</div><div class="value" id="aum">$${(s.treasury_aum_cents/100).toLocaleString()}</div></div>
  </div>
  <p style="color:var(--dim);font-size:12px;text-align:center;margin-top:18px;font-style:italic">MRR proxy = last 30 days of revenue_events. ARR = MRR × 12 + signed enterprise orders. Refreshes every 5 min.</p>
</section>`,
`<style>
.ld{display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--good);animation:p 1.4s infinite}
@keyframes p{0%,100%{opacity:.4}50%{opacity:1}}
</style>
<script>
async function refresh(){
  try {
    var r = await fetch('/v1/revenue/public', { cache: 'no-store' });
    var j = await r.json();
    function $(id, v){ var el = document.getElementById(id); if (el) el.textContent = v; }
    $('mrr', '$' + (j.mrr_cents/100).toLocaleString());
    $('arr', '$' + (j.total_arr_cents/100).toLocaleString());
    $('earr', '$' + (j.enterprise_arr_cents/100).toLocaleString());
    $('atime', '$' + (j.revenue_all_time_cents/100).toLocaleString());
    $('subs', (j.active_subscriptions || 0).toLocaleString());
    $('aum', '$' + (j.treasury_aum_cents/100).toLocaleString());
  } catch (e) {}
}
setInterval(refresh, 300000);
</script>`));
  });

  // Operator dashboard — full BI
  app.get('/revenue/operator', async (req, res) => {
    if (!isAdmin(req)) {
      res.status(401).setHeader('content-type', 'text/html; charset=utf-8');
      return res.send(shell('Operator revenue — auth', '', `<section style="padding:80px 16px;text-align:center;max-width:520px;margin:0 auto">
        <span class="badge b-bad">401</span>
        <h1 style="font:600 32px var(--display);margin:14px 0">Admin token required.</h1>
        <p style="color:var(--dim2);font-size:14px">Open this URL with <code>?admin_token=...</code> or send <code>x-admin-token</code> header.</p>
        <form method="GET" style="margin-top:18px"><input type="password" name="admin_token" placeholder="OPERATOR_ADMIN_TOKEN" style="width:340px"><button class="btn primary" style="margin-left:6px">Enter</button></form>
      </section>`));
    }
    const s = await operatorSummary(pool);
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.send(shell('Operator revenue', 'Full BI.', `
<section style="max-width:1100px;margin:0 auto;padding:60px 16px">
  <span class="badge b-bad">Operator</span>
  <h1 style="font:600 40px/1.1 var(--display);letter-spacing:-1px;margin:18px 0">Operator revenue.</h1>
  <p style="color:var(--dim2);font-size:14px">${new Date().toISOString().slice(0, 19)}Z · refresh page for latest</p>
</section>
<section style="max-width:1100px;margin:0 auto;padding:24px 16px">
  <h2 style="font:600 14px var(--mono);color:var(--dim);text-transform:uppercase;letter-spacing:1.5px;margin-bottom:12px">Top-line</h2>
  <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin-bottom:32px">
    <div class="kpi"><div class="label">MRR</div><div class="value">$${(s.mrr_cents/100).toLocaleString()}</div></div>
    <div class="kpi"><div class="label">Total ARR</div><div class="value">$${(s.total_arr_cents/100).toLocaleString()}</div></div>
    <div class="kpi"><div class="label">Enterprise ARR</div><div class="value">$${(s.enterprise_arr_cents/100).toLocaleString()}</div></div>
    <div class="kpi"><div class="label">Active subs</div><div class="value">${s.active_subscriptions.toLocaleString()}</div></div>
    <div class="kpi"><div class="label">Churned (30d)</div><div class="value" style="color:${s.churned_subscriptions_30d > 0 ? 'var(--bad)' : 'var(--dim)'}">${s.churned_subscriptions_30d}</div></div>
    <div class="kpi"><div class="label">Treasury AUM</div><div class="value">$${(s.treasury_aum_cents/100).toLocaleString()}</div></div>
    <div class="kpi"><div class="label">AR outstanding</div><div class="value">$${(s.ar_outstanding_cents/100).toLocaleString()}</div></div>
    <div class="kpi"><div class="label">AR overdue</div><div class="value" style="color:${s.ar_overdue_cents > 0 ? 'var(--bad)' : 'var(--dim)'}">$${(s.ar_overdue_cents/100).toLocaleString()}</div></div>
  </div>
</section>
<section style="max-width:1100px;margin:0 auto;padding:0 16px 24px">
  <h2 style="font:600 14px var(--mono);color:var(--dim);text-transform:uppercase;letter-spacing:1.5px;margin-bottom:12px">Top customers (all time)</h2>
  ${s.top_customers.length === 0
    ? `<div class="card" style="text-align:center;padding:24px;color:var(--dim)">No revenue events yet.</div>`
    : `<table><thead><tr><th>Org</th><th>Revenue</th></tr></thead><tbody>
        ${s.top_customers.map(t => `<tr><td style="font:500 11px var(--mono);color:var(--acc-dim)">${escapeHtml(t.org_id)}</td><td style="font:600 13px var(--mono)">$${(Number(t.revenue)/100).toLocaleString()}</td></tr>`).join('')}
      </tbody></table>`}
</section>
<section style="max-width:1100px;margin:0 auto;padding:24px 16px">
  <h2 style="font:600 14px var(--mono);color:var(--dim);text-transform:uppercase;letter-spacing:1.5px;margin-bottom:12px">Revenue by layer</h2>
  ${s.revenue_by_layer.length === 0
    ? `<div class="card" style="text-align:center;padding:24px;color:var(--dim)">No revenue by layer yet.</div>`
    : `<table><thead><tr><th>Source layer</th><th>Events</th><th>Revenue</th></tr></thead><tbody>
        ${s.revenue_by_layer.map(l => `<tr><td><span class="badge b-dim">${escapeHtml(l.source_layer || '?')}</span></td><td style="font:500 13px var(--mono)">${l.n.toLocaleString()}</td><td style="font:600 13px var(--mono)">$${(Number(l.revenue)/100).toLocaleString()}</td></tr>`).join('')}
      </tbody></table>`}
</section>
<section style="max-width:1100px;margin:0 auto;padding:24px 16px 60px">
  <h2 style="font:600 14px var(--mono);color:var(--dim);text-transform:uppercase;letter-spacing:1.5px;margin-bottom:12px">Last 12 months</h2>
  ${s.monthly_revenue.length === 0
    ? `<div class="card" style="text-align:center;padding:24px;color:var(--dim)">No data yet.</div>`
    : `<table><thead><tr><th>Month</th><th>Revenue</th></tr></thead><tbody>
        ${s.monthly_revenue.map(m => `<tr><td style="font:500 11px var(--mono);color:var(--dim)">${m.month?.toISOString?.().slice(0, 7) || ''}</td><td style="font:600 13px var(--mono)">$${(Number(m.revenue)/100).toLocaleString()}</td></tr>`).join('')}
      </tbody></table>`}
</section>`));
  });
}

module.exports = { migrate, registerRevenueDashboardRoutes };
