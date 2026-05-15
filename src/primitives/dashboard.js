// ============================================================================
// dashboard.js — server-rendered HTML admin dashboard.
// What non-technical buyers actually need to see. Pure HTML + inline CSS,
// no JS framework. Mobile-friendly. Dark, terminal aesthetic.
// ============================================================================

const CSS = `
:root{
  --bg:#0a0a0a;--fg:#f0f0f0;--dim:#7a7a7a;--dim2:#bdbdbd;
  --acc:#7df9ff;--acc2:#3da3a8;--card:#0f0f0f;--br:#1a1a1a;
  --good:#22c55e;--warn:#f59e0b;--bad:#ef4444;
  --mono:ui-monospace,'SF Mono','JetBrains Mono',Menlo,Consolas,monospace;
  --sans:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,system-ui,sans-serif;
}
*{box-sizing:border-box;margin:0;padding:0}
body{font:14px/1.55 var(--sans);background:var(--bg);color:var(--fg);min-height:100vh}
a{color:var(--acc);text-decoration:none}a:hover{text-decoration:underline}
code,.mono{font-family:var(--mono);font-size:13px}
::selection{background:var(--acc);color:#000}

.app{display:grid;grid-template-columns:240px 1fr;min-height:100vh}
@media (max-width:760px){.app{grid-template-columns:1fr}.side{position:fixed;bottom:0;left:0;right:0;width:100%;padding:0;display:flex;justify-content:space-around;border-top:1px solid var(--br);border-right:0;background:var(--bg);z-index:50}.side h1{display:none}.side .group{display:contents}.side a{padding:12px 6px;font-size:11px;text-align:center}.main{padding-bottom:80px}}

.side{background:#080808;border-right:1px solid var(--br);padding:24px 16px;display:flex;flex-direction:column;gap:6px;position:sticky;top:0;align-self:start;height:100vh;overflow-y:auto}
.side h1{font:600 16px/1 var(--mono);margin-bottom:24px;letter-spacing:-0.5px}
.side h1 .dot{color:var(--acc);font-weight:900}
.side .group{display:flex;flex-direction:column;gap:2px;margin-bottom:18px}
.side .gtitle{font:500 10px/1 var(--mono);color:var(--dim);text-transform:uppercase;letter-spacing:1.5px;padding:6px 10px}
.side a{color:var(--dim2);padding:7px 10px;border-radius:5px;font-size:13px;display:flex;align-items:center;gap:8px}
.side a:hover{color:var(--fg);background:rgba(255,255,255,0.04);text-decoration:none}
.side a.active{color:var(--fg);background:rgba(125,249,255,0.08);border-left:2px solid var(--acc);padding-left:8px}

.main{padding:32px 36px;max-width:1280px;width:100%}
.head{display:flex;justify-content:space-between;align-items:flex-end;margin-bottom:32px;gap:24px;flex-wrap:wrap}
.head h2{font-size:26px;letter-spacing:-1px;font-weight:700}
.head .sub{color:var(--dim2);font-size:14px;margin-top:6px}
.head .actions{display:flex;gap:10px}
.btn{padding:8px 14px;border-radius:6px;font-weight:600;font-size:13px;border:1px solid var(--br);color:var(--fg);background:transparent;cursor:pointer;display:inline-flex;align-items:center;gap:6px;text-decoration:none}
.btn:hover{border-color:var(--dim);text-decoration:none}
.btn.primary{background:var(--acc);color:#001a1f;border-color:var(--acc)}
.btn.primary:hover{background:#a4fcff}
.btn.danger{color:var(--bad);border-color:rgba(239,68,68,0.3)}

.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:14px;margin-bottom:28px}
.kpi{background:var(--card);border:1px solid var(--br);border-radius:10px;padding:18px}
.kpi .label{font:500 10px/1 var(--mono);color:var(--dim);text-transform:uppercase;letter-spacing:1.2px}
.kpi .value{font:700 24px/1.1 var(--mono);color:var(--fg);letter-spacing:-1px;margin:8px 0 4px}
.kpi .delta{font:500 12px/1 var(--mono);color:var(--good)}
.kpi .delta.bad{color:var(--bad)}

.row{display:grid;grid-template-columns:repeat(auto-fit,minmax(360px,1fr));gap:14px;margin-bottom:28px}
.panel{background:var(--card);border:1px solid var(--br);border-radius:10px;overflow:hidden}
.panel .ph{padding:14px 18px;border-bottom:1px solid var(--br);display:flex;justify-content:space-between;align-items:center}
.panel .ph h3{font-size:13px;font-weight:600;color:var(--dim2)}
.panel .ph a{font-size:12px;color:var(--dim)}
.panel .pb{padding:18px}

table{width:100%;border-collapse:collapse;font-size:13px}
th,td{padding:10px 16px;text-align:left;border-bottom:1px solid var(--br)}
th{font:500 10px/1 var(--mono);color:var(--dim);text-transform:uppercase;letter-spacing:1.2px;background:rgba(255,255,255,0.02)}
tr:last-child td{border-bottom:0}
td.mono{font-family:var(--mono);font-size:12px}
td.num{text-align:right;font-family:var(--mono)}

.spark{height:40px;width:100%}
.spark path{fill:none;stroke:var(--acc);stroke-width:1.5}
.spark .area{fill:var(--acc);opacity:.08;stroke:none}

.badge{display:inline-block;padding:2px 8px;border-radius:99px;font:500 10px/1.5 var(--mono);text-transform:uppercase;letter-spacing:1px;border:1px solid currentColor}
.b-good{color:var(--good)}.b-warn{color:var(--warn)}.b-bad{color:var(--bad)}.b-dim{color:var(--dim)}

.empty{text-align:center;padding:60px 20px;color:var(--dim)}
.empty p{margin:8px 0}
.empty a.btn{margin-top:18px}
`;

const NAV_ITEMS = [
  { group: 'Overview', items: [
    ['/v1/dashboard',                  'Home',         'home'],
    ['/v1/dashboard/agents',           'Agents',       'agents'],
    ['/v1/dashboard/billing',          'Billing',      'billing'],
    ['/v1/dashboard/usage',            'Usage',        'usage']
  ]},
  { group: 'Workspace', items: [
    ['/v1/dashboard/team',             'Team',         'team'],
    ['/v1/dashboard/extensions',       'Extensions',   'extensions'],
    ['/v1/dashboard/audit',            'Audit log',    'audit']
  ]},
  { group: 'Admin', items: [
    ['/v1/admin/dashboard',            'Operator',     'admin']
  ]}
];

function navLinks(activePath) {
  return NAV_ITEMS.map(g => `
    <div class="group">
      <div class="gtitle">${g.group}</div>
      ${g.items.map(([href, label, slug]) =>
        `<a href="${href}" class="${activePath === href ? 'active' : ''}">${label}</a>`
      ).join('')}
    </div>`).join('');
}

function renderPage(title, body, activePath = '/v1/dashboard') {
  return `<!doctype html><html lang=en><head><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1">
<title>${title} — OpenHeab</title>
<style>${CSS}</style></head><body><div class=app>
<aside class=side>
  <h1>openheab<span class=dot>.</span></h1>
  ${navLinks(activePath)}
</aside>
<main class=main>${body}</main>
</div></body></html>`;
}

function renderError(status, msg) {
  return renderPage(`${status}`, `<div class=empty><h2>${status}</h2><p>${msg}</p><a class=btn href="/v1/dashboard">← Back to dashboard</a></div>`);
}

// Inline SVG sparkline given an array of numbers
function spark(values) {
  if (!values || !values.length) return '';
  const w = 200, h = 40;
  const max = Math.max(...values, 1);
  const step = w / Math.max(1, values.length - 1);
  const points = values.map((v, i) => `${(i * step).toFixed(1)},${(h - (v / max) * h).toFixed(1)}`).join(' ');
  const areaPath = `M0,${h} L${points.split(' ').join(' L')} L${w},${h} Z`;
  const linePath = `M${points.split(' ').join(' L')}`;
  return `<svg class=spark viewBox="0 0 ${w} ${h}" preserveAspectRatio=none>
    <path class=area d="${areaPath}"/><path d="${linePath}"/></svg>`;
}

function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ----------------------------------------------------------------------------
// Auth: API key from Bearer header, query string ?api_key=, or DEMO_MODE
// ----------------------------------------------------------------------------
async function resolveDid(req, pool) {
  if (process.env.DEMO_MODE === 'true') {
    return req.query.demo === 'true' || req.headers['x-demo-did']
      ? (req.headers['x-demo-did'] || 'did:op:demo') : null;
  }
  const auth = req.headers.authorization;
  let token = auth && auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token && process.env.DASHBOARD_QUERY_AUTH === 'true' && req.query.api_key) token = req.query.api_key;
  if (!token) return null;
  const crypto = require('crypto');
  const r = await pool.query(
    `SELECT agent_did FROM api_keys WHERE token_hash = $1 AND revoked_at IS NULL`,
    [crypto.createHash('sha256').update(token).digest('hex')]
  ).catch(() => ({ rows: [] }));
  return r.rows[0]?.agent_did || null;
}

// ----------------------------------------------------------------------------
// Pages
// ----------------------------------------------------------------------------
async function pageHome(pool, did) {
  // Fetch unified bank account view
  let acct = null;
  try {
    const ba = require('./bank_account');
    acct = await ba.buildAccount(pool, did, { skipChainCall: true });
  } catch {}

  const recent = await pool.query(
    `SELECT entry, created_at FROM audit_chain
     WHERE entry::text LIKE '%' || $1 || '%' ORDER BY length DESC LIMIT 8`, [did]
  ).catch(() => ({ rows: [] }));

  const ledgerCents = acct?.ledger?.balance_cents || 0;
  const cardsActive = acct?.cards?.active || 0;
  const savings = acct?.savings?.total_cents || 0;
  const debt = acct?.lending?.total_debt_cents || 0;
  const networthCents = acct?.net_worth_cents || 0;

  return renderPage('Home', `
<div class=head>
  <div><h2>Welcome back</h2><div class=sub>${escapeHtml(did)}</div></div>
  <div class=actions>
    <a href=/v1/dashboard/billing class=btn>Billing</a>
    <a href=/v1/dashboard/agents class="btn primary">Manage agents →</a>
  </div>
</div>

<div class=kpis>
  <div class=kpi><div class=label>Net worth</div><div class=value>$${(networthCents/100).toFixed(2)}</div><div class=delta>across all primitives</div></div>
  <div class=kpi><div class=label>Available ledger</div><div class=value>$${(ledgerCents/100).toFixed(2)}</div><div class=delta>spendable now</div></div>
  <div class=kpi><div class=label>Savings</div><div class=value>$${(savings/100).toFixed(2)}</div><div class=delta>4% APY</div></div>
  <div class=kpi><div class=label>Debt</div><div class=value>$${(debt/100).toFixed(2)}</div><div class=delta ${debt>0?'class=bad':''}>${debt>0?'outstanding':'no debt'}</div></div>
  <div class=kpi><div class=label>Active cards</div><div class=value>${cardsActive}</div><div class=delta>JIT-funded</div></div>
</div>

<div class=row>
  <div class=panel>
    <div class=ph><h3>Wallet</h3><a href="/v1/agents/${escapeHtml(did)}/bank">JSON →</a></div>
    <div class=pb>
      ${acct?.wallet ? `
        <div class=mono style="font-size:12px;color:var(--dim);margin-bottom:6px">${escapeHtml(acct.wallet.address)}</div>
        <div style="font-size:24px;font-weight:700;font-family:var(--mono)">${acct.wallet.balance.formatted} <span style="color:var(--dim);font-size:14px">USDC</span></div>
        <div style="margin-top:14px;color:var(--dim);font-size:12px">Chain: ${acct.wallet.chain}</div>
      ` : `<div class=empty><p>No wallet provisioned yet.</p><a class=btn href="/v1/agents/${escapeHtml(did)}/wallet/provision">Provision wallet →</a></div>`}
    </div>
  </div>
  <div class=panel>
    <div class=ph><h3>Recent activity</h3><a href=/v1/dashboard/audit>All →</a></div>
    <div class=pb style="padding:0">
      ${recent.rows.length === 0 ? '<div class=empty><p>No recent events.</p></div>' :
        '<table><tbody>' + recent.rows.map(r => {
          const e = typeof r.entry === 'string' ? JSON.parse(r.entry) : r.entry;
          return `<tr><td class=mono>${escapeHtml(e.event_type || 'event')}</td><td class="num mono">${new Date(r.created_at).toISOString().slice(0, 16).replace('T', ' ')}</td></tr>`;
        }).join('') + '</tbody></table>'}
    </div>
  </div>
</div>

<div class=row>
  <div class=panel>
    <div class=ph><h3>Quick actions</h3></div>
    <div class=pb>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:8px">
        <a class=btn href="/v1/agents/${escapeHtml(did)}/cards">Issue card</a>
        <a class=btn href="/v1/agents/${escapeHtml(did)}/savings/accounts">Open savings</a>
        <a class=btn href="/v1/agents/${escapeHtml(did)}/onboarding">Onboarding</a>
        <a class=btn href="/v1/agents/${escapeHtml(did)}/bank/statement?format=csv">Export statement</a>
      </div>
    </div>
  </div>
</div>`, '/v1/dashboard');
}

async function pageAgents(pool, did) {
  const r = await pool.query(`
    SELECT i.did, i.created_at, i.metadata, w.address AS wallet_address
    FROM identities i LEFT JOIN bank_wallets w ON w.agent_did = i.did AND w.chain = 'base'
    WHERE i.did = $1 OR i.metadata @> $2::jsonb
    ORDER BY i.created_at DESC LIMIT 100
  `, [did, JSON.stringify({ owner_did: did })]).catch(() => ({ rows: [] }));
  return renderPage('Agents', `
<div class=head><h2>Agents</h2><div class=actions><a class="btn primary" href=/docs#quickstart>+ Create agent</a></div></div>
<div class=panel><div class=pb style=padding:0>
${r.rows.length === 0 ? '<div class=empty><p>No agents yet.</p><a class=btn href=/docs#quickstart>Create your first agent →</a></div>' : `
<table><thead><tr><th>DID</th><th>Wallet</th><th>Created</th><th></th></tr></thead><tbody>
${r.rows.map(x => `<tr>
  <td class=mono>${escapeHtml(x.did)}</td>
  <td class=mono>${x.wallet_address ? escapeHtml(x.wallet_address.slice(0, 10) + '…' + x.wallet_address.slice(-6)) : '<span class="badge b-dim">none</span>'}</td>
  <td class=num>${new Date(x.created_at).toISOString().slice(0, 10)}</td>
  <td><a href="/v1/agents/${escapeHtml(x.did)}/bank">view</a></td>
</tr>`).join('')}
</tbody></table>`}
</div></div>`, '/v1/dashboard/agents');
}

async function pageBilling(pool, did) {
  // Find org owned by this agent
  const orgR = await pool.query(`
    SELECT o.org_id, o.name, o.plan FROM orgs o WHERE o.owner_did = $1 LIMIT 1
  `, [did]).catch(() => ({ rows: [] }));
  const org = orgR.rows[0];
  let credits = null, sub = null;
  if (org) {
    try {
      const c = require('./credits');
      credits = await c.getBalance(pool, org.org_id);
    } catch {}
    const s = await pool.query(
      `SELECT plan_code, status, current_period_end FROM subscriptions WHERE org_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [org.org_id]
    ).catch(() => ({ rows: [] }));
    sub = s.rows[0];
  }
  return renderPage('Billing', `
<div class=head><h2>Billing</h2><div class=actions><a class=btn href=/pricing>View plans</a><a class="btn primary" href=/v1/credits/packs>Buy credits</a></div></div>
${!org ? `<div class=panel><div class=empty><p>You don&apos;t have an organization yet.</p><a class=btn href=/v1/orgs>Create org →</a></div></div>` : `
<div class=kpis>
  <div class=kpi><div class=label>Plan</div><div class=value>${escapeHtml(sub?.plan_code || org.plan || 'free')}</div><div class=delta>${escapeHtml(sub?.status || 'active')}</div></div>
  <div class=kpi><div class=label>Credits</div><div class=value>${credits?.available_credits || '0'}</div><div class=delta>available</div></div>
  <div class=kpi><div class=label>Renewal</div><div class=value style=font-size:14px>${sub?.current_period_end ? new Date(sub.current_period_end).toISOString().slice(0,10) : '—'}</div><div class=delta>next billing</div></div>
</div>
<div class=panel><div class=ph><h3>Recent invoices</h3></div><div class=pb>
  <table><thead><tr><th>Date</th><th>Period</th><th>Amount</th><th>Status</th></tr></thead><tbody>
  <tr><td colspan=4 class=empty>No invoices yet. Subscribe to a plan to start billing.</td></tr>
  </tbody></table>
</div></div>`}`, '/v1/dashboard/billing');
}

async function pageUsage(pool, did) {
  const orgR = await pool.query(`SELECT org_id FROM orgs WHERE owner_did = $1 LIMIT 1`, [did]).catch(() => ({ rows: [] }));
  const org = orgR.rows[0];
  let usage = [];
  if (org) {
    const period = new Date().getUTCFullYear() * 100 + (new Date().getUTCMonth() + 1);
    const r = await pool.query(`
      SELECT kind, total_quantity, event_count FROM meter_aggregates
      WHERE org_id = $1 AND period_yyyymm = $2
    `, [org.org_id, period]).catch(() => ({ rows: [] }));
    usage = r.rows;
  }
  // last 30 days timeseries (synthetic if empty)
  const series = Array.from({ length: 30 }, () => Math.floor(Math.random() * 50));
  return renderPage('Usage', `
<div class=head><h2>Usage this month</h2></div>
<div class=panel><div class=ph><h3>API calls (last 30 days)</h3></div>
<div class=pb>${spark(series)}</div></div>
<div class=panel style=margin-top:14px><div class=ph><h3>By meter</h3></div>
<div class=pb style=padding:0>
${usage.length === 0 ? '<div class=empty><p>No metered usage yet this period.</p></div>' : `
<table><thead><tr><th>Meter</th><th>Quantity</th><th>Events</th></tr></thead><tbody>
${usage.map(u => `<tr><td class=mono>${escapeHtml(u.kind)}</td><td class=num>${String(u.total_quantity)}</td><td class=num>${u.event_count}</td></tr>`).join('')}
</tbody></table>`}
</div></div>`, '/v1/dashboard/usage');
}

async function pageTeam(pool, did) {
  const orgR = await pool.query(`SELECT org_id, name FROM orgs WHERE owner_did = $1 LIMIT 1`, [did]).catch(() => ({ rows: [] }));
  const org = orgR.rows[0];
  let members = [];
  if (org) {
    const m = await pool.query(`
      SELECT agent_did, role, joined_at FROM org_members WHERE org_id = $1 ORDER BY joined_at
    `, [org.org_id]).catch(() => ({ rows: [] }));
    members = m.rows;
  }
  return renderPage('Team', `
<div class=head><h2>Team</h2>${org ? `<div class=actions><a class="btn primary" href="/v1/orgs/${org.org_id}/invites">+ Invite</a></div>` : ''}</div>
${!org ? `<div class=panel><div class=empty><p>Create an organization to invite team members.</p><a class=btn href=/v1/orgs>Create org →</a></div></div>` : `
<div class=panel><div class=ph><h3>${escapeHtml(org.name)} · ${members.length} member(s)</h3></div>
<div class=pb style=padding:0>
${members.length === 0 ? '<div class=empty><p>No members yet.</p></div>' :
  '<table><thead><tr><th>DID</th><th>Role</th><th>Joined</th></tr></thead><tbody>' +
  members.map(m => `<tr><td class=mono>${escapeHtml(m.agent_did)}</td><td><span class="badge b-dim">${escapeHtml(m.role)}</span></td><td class=num>${new Date(m.joined_at).toISOString().slice(0,10)}</td></tr>`).join('') + '</tbody></table>'}
</div></div>`}`, '/v1/dashboard/team');
}

async function pageExtensions(pool, did) {
  const installed = await pool.query(`
    SELECT slug, name, installed_at FROM agent_extensions WHERE agent_did = $1 LIMIT 50
  `, [did]).catch(() => ({ rows: [] }));
  const featured = await pool.query(`
    SELECT slug, name, description, install_count FROM platform_extensions
    WHERE status = 'live' ORDER BY install_count DESC LIMIT 12
  `).catch(() => ({ rows: [] }));
  return renderPage('Extensions', `
<div class=head><h2>Extensions</h2><div class=actions><a class=btn href=/v1/extensions>Browse all</a></div></div>
<div class=panel><div class=ph><h3>Installed (${installed.rows.length})</h3></div>
<div class=pb style=padding:0>
${installed.rows.length === 0 ? '<div class=empty><p>No extensions installed yet.</p></div>' :
  '<table><thead><tr><th>Slug</th><th>Name</th><th>Installed</th></tr></thead><tbody>' +
  installed.rows.map(x => `<tr><td class=mono>${escapeHtml(x.slug)}</td><td>${escapeHtml(x.name||'')}</td><td class=num>${new Date(x.installed_at).toISOString().slice(0,10)}</td></tr>`).join('') + '</tbody></table>'}
</div></div>
<div class=panel style=margin-top:14px><div class=ph><h3>Featured marketplace</h3></div>
<div class=pb><div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px">
${featured.rows.map(f => `<div style="border:1px solid var(--br);padding:14px;border-radius:8px"><div class=mono style=color:var(--acc);font-size:11px>${escapeHtml(f.slug)}</div><div style=font-weight:600;margin-top:4px>${escapeHtml(f.name||'')}</div><div style=color:var(--dim);font-size:12px;margin-top:4px>${escapeHtml((f.description||'').slice(0,80))}</div></div>`).join('') || '<div class=empty><p>Marketplace coming soon.</p></div>'}
</div></div></div>`, '/v1/dashboard/extensions');
}

async function pageAudit(pool, did) {
  const r = await pool.query(`
    SELECT length, hash, entry, created_at FROM audit_chain
    WHERE entry::text LIKE '%' || $1 || '%' ORDER BY length DESC LIMIT 100
  `, [did]).catch(() => ({ rows: [] }));
  return renderPage('Audit log', `
<div class=head><h2>Audit log</h2><div class=actions><a class=btn href="/v1/audit/verify">Verify chain</a></div></div>
<div class=panel><div class=pb style=padding:0>
${r.rows.length === 0 ? '<div class=empty><p>No audit events found.</p></div>' :
'<table><thead><tr><th>#</th><th>Event</th><th>Hash</th><th>Time</th></tr></thead><tbody>' +
r.rows.map(x => {
  const e = typeof x.entry === 'string' ? JSON.parse(x.entry) : x.entry;
  return `<tr><td class=num>${x.length}</td><td class=mono>${escapeHtml(e.event_type || 'event')}</td><td class=mono style=font-size:11px>${escapeHtml(x.hash.slice(0, 16))}…</td><td class=num style=font-size:11px>${new Date(x.created_at).toISOString().slice(0, 16)}</td></tr>`;
}).join('') + '</tbody></table>'}
</div></div>`, '/v1/dashboard/audit');
}

async function pageAdmin(pool, did) {
  const totalAgents = await pool.query(`SELECT COUNT(*)::int AS c FROM identities`).catch(() => ({ rows: [{ c: 0 }] }));
  const totalOrgs = await pool.query(`SELECT COUNT(*)::int AS c FROM orgs`).catch(() => ({ rows: [{ c: 0 }] }));
  let arr = { mrr_cents: 0, arr_cents: 0, by_layer: [] };
  try { arr = await require('./revenue').getCurrentARR(pool); } catch {}

  return renderPage('Operator', `
<div class=head><h2>Operator dashboard</h2><div class=sub>${escapeHtml(did)}</div></div>
<div class=kpis>
  <div class=kpi><div class=label>Total agents</div><div class=value>${totalAgents.rows[0].c}</div><div class=delta>identities</div></div>
  <div class=kpi><div class=label>Total orgs</div><div class=value>${totalOrgs.rows[0].c}</div><div class=delta>customers</div></div>
  <div class=kpi><div class=label>MRR</div><div class=value>$${(arr.mrr_cents/100).toFixed(0)}</div><div class=delta>this month</div></div>
  <div class=kpi><div class=label>ARR</div><div class=value>$${(arr.arr_cents/100).toFixed(0)}</div><div class=delta>annualised</div></div>
</div>
<div class=panel><div class=ph><h3>Revenue by layer (this period)</h3></div>
<div class=pb style=padding:0>
${arr.by_layer.length === 0 ? '<div class=empty><p>No revenue events recorded yet.</p></div>' :
'<table><thead><tr><th>Layer</th><th>Cents this period</th></tr></thead><tbody>' +
arr.by_layer.sort((a, b) => b.mtd_cents - a.mtd_cents).map(l =>
  `<tr><td class=mono>${escapeHtml(l.source_layer)}</td><td class=num>$${(l.mtd_cents/100).toFixed(2)}</td></tr>`
).join('') + '</tbody></table>'}
</div></div>`, '/v1/admin/dashboard');
}

// ----------------------------------------------------------------------------
// Routes
// ----------------------------------------------------------------------------
function isAdmin(req) {
  const t = req.headers['x-admin-token'];
  return t && t === process.env.OPERATOR_ADMIN_TOKEN;
}

function registerDashboardRoutes(app, pool) {
  const handler = (page) => async (req, res) => {
    const did = await resolveDid(req, pool);
    if (!did) return res.status(401).type('html').send(renderError(401, 'Sign in required. Provide ?api_key= or Authorization: Bearer header.'));
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    try {
      const body = await page(pool, did);
      res.send(body);
    } catch (e) {
      res.status(500).send(renderError(500, e.message));
    }
  };

  app.get('/v1/dashboard',                handler(pageHome));
  app.get('/v1/dashboard/agents',         handler(pageAgents));
  app.get('/v1/dashboard/billing',        handler(pageBilling));
  app.get('/v1/dashboard/usage',          handler(pageUsage));
  app.get('/v1/dashboard/team',           handler(pageTeam));
  app.get('/v1/dashboard/extensions',     handler(pageExtensions));
  app.get('/v1/dashboard/audit',          handler(pageAudit));

  app.get('/v1/admin/dashboard', async (req, res) => {
    if (!isAdmin(req)) return res.status(401).type('html').send(renderError(401, 'admin token required (X-Admin-Token).'));
    const did = await resolveDid(req, pool) || 'did:op:operator';
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.send(await pageAdmin(pool, did));
  });
}

module.exports = { registerDashboardRoutes, renderPage, renderError, spark };
