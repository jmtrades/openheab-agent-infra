// ============================================================================
// operator_hq.js — single-pane glass for the operator running the substrate.
// One page that shows the health of every layer in real-time so coworkers,
// investors, and ops staff can answer "how is OpenHeab doing right now?"
// without spelunking through 15 separate dashboards.
//
// GET /v1/admin/hq — HTML dashboard
// GET /v1/admin/hq.json — same data as JSON
// ============================================================================

async function migrate(_pool) {}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}
function isAdmin(req) {
  const t = req.headers['x-admin-token'];
  return require('../safe_compare').safeTokenCompare(t, process.env.OPERATOR_ADMIN_TOKEN);
}

async function buildSnapshot(pool, app) {
  const safe = async (q, p = [], fallback = { rows: [] }) => {
    try { return await pool.query(q, p); } catch { return fallback; }
  };

  // Identity / agents
  const agents = await safe(`SELECT COUNT(*)::int AS c FROM identities`, [], { rows: [{ c: 0 }] });
  const agentsToday = await safe(`SELECT COUNT(*)::int AS c FROM identities WHERE created_at > NOW() - INTERVAL '24 hours'`, [], { rows: [{ c: 0 }] });
  // Orgs
  const orgs = await safe(`SELECT COUNT(*)::int AS c, COUNT(*) FILTER (WHERE plan != 'free')::int AS paid FROM orgs`, [], { rows: [{ c: 0, paid: 0 }] });
  // Bank
  const ledger = await safe(`SELECT COALESCE(SUM(balance_cents),0)::bigint AS total FROM bank_accounts`, [], { rows: [{ total: 0 }] });
  const wallets = await safe(`SELECT COUNT(*)::int AS c FROM bank_wallets`, [], { rows: [{ c: 0 }] });
  // Audit chain head
  const audit = await safe(`SELECT COALESCE(MAX(length), 0)::int AS h FROM audit_chain`, [], { rows: [{ h: 0 }] });
  const auditToday = await safe(`SELECT COUNT(*)::int AS c FROM audit_chain WHERE created_at > NOW() - INTERVAL '24 hours'`, [], { rows: [{ c: 0 }] });
  // Cards
  const cards = await safe(`SELECT COUNT(*) FILTER (WHERE status='active')::int AS active FROM agent_cards`, [], { rows: [{ active: 0 }] });
  // Subscriptions
  const subs = await safe(`SELECT COUNT(*) FILTER (WHERE status='active')::int AS active FROM subscriptions`, [], { rows: [{ active: 0 }] });
  // Revenue (last 30 days)
  let revenue = { mrr_cents: 0, arr_cents: 0, by_layer: [] };
  try { revenue = await require('./revenue').getCurrentARR(pool); } catch {}
  // Reserve ratio
  let reserve = null;
  try { reserve = await require('./bank_core').computeReserveRatio(pool); } catch {}
  // Compliance score
  let compliance = null;
  try {
    const r = await safe(`SELECT COUNT(*) FILTER (WHERE status='valid') AS p, COUNT(*) AS t FROM compliance_evidence`, [], { rows: [{ p: 0, t: 0 }] });
    compliance = { passed: Number(r.rows[0].p), total: Number(r.rows[0].t) };
  } catch {}
  // Status incidents
  const incidents = await safe(`SELECT COUNT(*) FILTER (WHERE resolved_at IS NULL)::int AS open FROM status_incidents`, [], { rows: [{ open: 0 }] });
  // Setup status
  let setup = null;
  try { setup = await require('./quickstart').getSetupStatus(pool); } catch {}
  // Provider count
  let providers = { total: 0, configured: 0 };
  try {
    const PROVIDERS = require('./provider_adapters').PROVIDERS;
    providers.total = PROVIDERS.length;
    providers.configured = PROVIDERS.filter(p => p.env.every(v => !!process.env[v])).length;
  } catch {}
  // Substrate stats
  const integ = require('./../integration');
  const primCount = Object.keys(integ.primitives || {}).length;
  const routeCount = (() => {
    let n = 0;
    for (const layer of app._router?.stack || []) {
      if (layer.route) n++;
      else if (layer.name === 'router' && layer.handle?.stack) {
        for (const sub of layer.handle.stack) if (sub.route) n++;
      }
    }
    return n;
  })();
  // Marketing leads
  const leads = await safe(`SELECT COUNT(*)::int AS c, COUNT(*) FILTER (WHERE status='converted')::int AS converted FROM marketing_leads`, [], { rows: [{ c: 0, converted: 0 }] });
  // Errors (recent)
  let errors24h = 0;
  try {
    const r = await safe(`SELECT COUNT(*)::int AS c FROM error_events WHERE created_at > NOW() - INTERVAL '24 hours'`, [], { rows: [{ c: 0 }] });
    errors24h = r.rows[0].c;
  } catch {}

  return {
    substrate: { primitives: primCount, routes: routeCount, layers: 31 },
    agents: { total: agents.rows[0].c, last_24h: agentsToday.rows[0].c },
    orgs: { total: orgs.rows[0].c, paying: orgs.rows[0].paid },
    bank: {
      ledger_total_cents: Number(ledger.rows[0].total),
      wallets_provisioned: wallets.rows[0].c,
      reserve: reserve ? {
        ratio_pct: (reserve.reserve_ratio_bps / 100).toFixed(2),
        solvent: reserve.capital_adequacy_ok
      } : null
    },
    audit_chain: { length: audit.rows[0].h, last_24h: auditToday.rows[0].c },
    cards: { active: cards.rows[0].active },
    subscriptions: { active: subs.rows[0].active },
    revenue: {
      mrr_cents: revenue.mrr_cents,
      arr_cents: revenue.arr_cents,
      by_layer: revenue.by_layer || []
    },
    compliance,
    incidents_open: incidents.rows[0].open,
    setup, providers,
    marketing: { leads: leads.rows[0].c, converted: leads.rows[0].converted,
                  conversion_rate: leads.rows[0].c > 0 ? Math.round(leads.rows[0].converted / leads.rows[0].c * 100) : 0 },
    errors_24h: errors24h,
    snapshot_at: new Date().toISOString()
  };
}

function renderHq(snap) {
  const css = `*{box-sizing:border-box;margin:0;padding:0}
body{font:14px/1.55 -apple-system,system-ui,sans-serif;background:#0a0a0a;color:#f0f0f0;padding:24px}
.wrap{max-width:1280px;margin:0 auto}
.head{display:flex;justify-content:space-between;align-items:flex-end;margin-bottom:28px;flex-wrap:wrap;gap:14px}
h1{font:600 24px/1 ui-monospace,'SF Mono',Menlo,monospace;letter-spacing:-1px}
h1 .dot{color:#7df9ff;font-weight:900}
.sub{color:#7a7a7a;font-size:13px;margin-top:6px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;margin-bottom:18px}
.kpi{background:#0f0f0f;border:1px solid #1a1a1a;border-radius:10px;padding:18px}
.kpi .l{font:500 10px/1 ui-monospace,monospace;color:#7a7a7a;text-transform:uppercase;letter-spacing:1.2px}
.kpi .v{font:700 28px/1.1 ui-monospace,monospace;color:#f0f0f0;letter-spacing:-1px;margin:10px 0 4px}
.kpi .d{font:500 12px/1 ui-monospace,monospace;color:#22c55e}
.kpi .d.bad{color:#ef4444}.kpi .d.warn{color:#f59e0b}.kpi .d.dim{color:#7a7a7a}
.row{display:grid;grid-template-columns:repeat(auto-fit,minmax(360px,1fr));gap:14px;margin-bottom:18px}
.panel{background:#0f0f0f;border:1px solid #1a1a1a;border-radius:10px;overflow:hidden}
.panel .ph{padding:14px 18px;border-bottom:1px solid #1a1a1a;font:600 12px/1 ui-monospace,monospace;color:#bdbdbd;text-transform:uppercase;letter-spacing:1.2px}
.panel .pb{padding:18px}
table{width:100%;border-collapse:collapse}
th,td{padding:10px 14px;text-align:left;border-bottom:1px solid #1a1a1a;font-size:13px}
th{font:500 10px/1 ui-monospace,monospace;color:#7a7a7a;text-transform:uppercase;letter-spacing:1.2px}
tr:last-child td{border-bottom:0}
.bar{height:4px;background:#1a1a1a;border-radius:2px;overflow:hidden;margin-top:8px}
.bar .fill{height:100%;background:#7df9ff;transition:width .3s}
.bar .fill.good{background:#22c55e}.bar .fill.warn{background:#f59e0b}.bar .fill.bad{background:#ef4444}
a{color:#7df9ff;text-decoration:none}a:hover{text-decoration:underline}
nav{display:flex;gap:18px;margin-bottom:24px;font-size:13px}
nav a{color:#bdbdbd}nav a:hover{color:#f0f0f0}
`;

  const rate = (cents) => '$' + ((cents || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  const setupPct = snap.setup ? snap.setup.progress : 0;
  const reserveOk = snap.bank.reserve ? snap.bank.reserve.solvent : null;
  const provPct = snap.providers.total ? Math.round(snap.providers.configured / snap.providers.total * 100) : 0;

  return `<!doctype html><html><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<title>Operator HQ — OpenHeab</title>
<style>${css}</style>
<meta http-equiv=refresh content=60></head><body><div class=wrap>
<div class=head>
  <div>
    <h1>openheab<span class=dot>.</span> operator hq</h1>
    <div class=sub>Live snapshot · refreshes every 60s · ${escapeHtml(snap.snapshot_at)}</div>
  </div>
</div>
<nav>
  <a href="/v1/dashboard">Customer dashboard</a>
  <a href="/console">Route console</a>
  <a href="/v1/admin/revenue/dashboard">Revenue</a>
  <a href="/v1/admin/growth-plan/dashboard">Growth plan</a>
  <a href="/v1/admin/providers">Providers</a>
  <a href="/v1/admin/cs/health">Customer health</a>
  <a href="/v1/admin/ipo/icfr">ICFR</a>
  <a href="/setup">Setup</a>
  <a href="/playground">Playground</a>
</nav>

<div class=grid>
  <div class=kpi><div class=l>Primitives</div><div class=v>${snap.substrate.primitives}</div><div class=d>${snap.substrate.layers} layers · ${snap.substrate.routes} routes</div></div>
  <div class=kpi><div class=l>Agents</div><div class=v>${snap.agents.total.toLocaleString()}</div><div class=d>+${snap.agents.last_24h} last 24h</div></div>
  <div class=kpi><div class=l>Orgs</div><div class=v>${snap.orgs.total}</div><div class=d>${snap.orgs.paying} paying</div></div>
  <div class=kpi><div class=l>MRR</div><div class=v>${rate(snap.revenue.mrr_cents)}</div><div class=d>ARR ${rate(snap.revenue.arr_cents)}</div></div>
  <div class=kpi><div class=l>Ledger total</div><div class=v>${rate(snap.bank.ledger_total_cents)}</div><div class=d>${snap.bank.wallets_provisioned} wallets</div></div>
  <div class=kpi><div class=l>Audit chain</div><div class=v>${snap.audit_chain.length.toLocaleString()}</div><div class=d>+${snap.audit_chain.last_24h} last 24h</div></div>
  <div class=kpi><div class=l>Active cards</div><div class=v>${snap.cards.active}</div></div>
  <div class=kpi><div class=l>Active subs</div><div class=v>${snap.subscriptions.active}</div></div>
  <div class=kpi><div class=l>Setup</div><div class=v>${setupPct}%</div><div class="d ${setupPct >= 100 ? '' : 'warn'}">${snap.setup ? (snap.setup.ready ? 'ready' : 'incomplete') : 'unknown'}</div><div class=bar><div class="fill ${setupPct >= 100 ? 'good' : 'warn'}" style="width:${setupPct}%"></div></div></div>
  <div class=kpi><div class=l>Reserve ratio</div><div class=v>${snap.bank.reserve ? snap.bank.reserve.ratio_pct + '%' : '—'}</div><div class="d ${reserveOk === false ? 'bad' : ''}">${reserveOk === true ? 'solvent' : reserveOk === false ? 'UNDER-RESERVED' : 'no data'}</div></div>
  <div class=kpi><div class=l>Providers</div><div class=v>${snap.providers.configured} / ${snap.providers.total}</div><div class=d>${provPct}% configured</div></div>
  <div class=kpi><div class=l>Incidents</div><div class=v>${snap.incidents_open}</div><div class="d ${snap.incidents_open > 0 ? 'warn' : ''}">${snap.incidents_open === 0 ? 'all clear' : 'active'}</div></div>
  <div class=kpi><div class=l>Marketing leads</div><div class=v>${snap.marketing.leads}</div><div class=d>${snap.marketing.converted} converted · ${snap.marketing.conversion_rate}%</div></div>
  <div class=kpi><div class=l>Errors 24h</div><div class=v>${snap.errors_24h}</div><div class="d ${snap.errors_24h > 0 ? 'warn' : ''}">${snap.errors_24h === 0 ? 'clean' : 'investigate'}</div></div>
</div>

<div class=row>
  <div class=panel>
    <div class=ph>Revenue by layer (this period)</div>
    <table>
      <thead><tr><th>Layer</th><th style="text-align:right">MTD</th></tr></thead>
      <tbody>
${(snap.revenue.by_layer || []).slice(0, 10).map(l => `        <tr><td style="font-family:ui-monospace,monospace;font-size:12px">${escapeHtml(l.source_layer)}</td><td style="text-align:right;font-family:ui-monospace,monospace">${rate(l.mtd_cents)}</td></tr>`).join('\n')}
${(snap.revenue.by_layer || []).length === 0 ? '<tr><td colspan=2 style="text-align:center;color:#7a7a7a;padding:32px">No revenue events yet. Seed demo data: POST /v1/admin/demo/seed</td></tr>' : ''}
      </tbody>
    </table>
  </div>
  <div class=panel>
    <div class=ph>Quick actions</div>
    <div class=pb>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
        <a href="/v1/admin/demo/runs" style="display:block;padding:14px;background:#0a0a0a;border:1px solid #1a1a1a;border-radius:6px;font-size:13px;text-align:center">View demo runs</a>
        <a href="/setup" style="display:block;padding:14px;background:#0a0a0a;border:1px solid #1a1a1a;border-radius:6px;font-size:13px;text-align:center">Setup wizard</a>
        <a href="/v1/admin/audit-core/evidence" style="display:block;padding:14px;background:#0a0a0a;border:1px solid #1a1a1a;border-radius:6px;font-size:13px;text-align:center">Audit evidence</a>
        <a href="/v1/admin/bank-core/balance-sheet" style="display:block;padding:14px;background:#0a0a0a;border:1px solid #1a1a1a;border-radius:6px;font-size:13px;text-align:center">Balance sheet</a>
        <a href="/v1/admin/inference-core/stats" style="display:block;padding:14px;background:#0a0a0a;border:1px solid #1a1a1a;border-radius:6px;font-size:13px;text-align:center">Inference stats</a>
        <a href="/v1/admin/marketing/dashboard" style="display:block;padding:14px;background:#0a0a0a;border:1px solid #1a1a1a;border-radius:6px;font-size:13px;text-align:center">Marketing funnel</a>
      </div>
    </div>
  </div>
</div>

<div class=row>
  <div class=panel>
    <div class=ph>Compliance evidence</div>
    <div class=pb>${snap.compliance ? `<div style="font:700 36px/1 ui-monospace,monospace">${snap.compliance.passed} / ${snap.compliance.total}</div><div style="color:#7a7a7a;font-size:13px;margin-top:6px">${snap.compliance.total > 0 ? Math.round(snap.compliance.passed / snap.compliance.total * 100) : 0}% of controls have valid evidence</div>` : '<div style="color:#7a7a7a">No data</div>'}</div>
  </div>
  <div class=panel>
    <div class=ph>Substrate</div>
    <div class=pb>
      <div style="font:13px/1.8 ui-monospace,monospace;color:#bdbdbd">
        <div>Primitives: <strong style="color:#f0f0f0">${snap.substrate.primitives}</strong></div>
        <div>Routes: <strong style="color:#f0f0f0">${snap.substrate.routes}</strong></div>
        <div>Layers: <strong style="color:#f0f0f0">${snap.substrate.layers}</strong></div>
        <div>OpenAPI: <a href="/openapi.json">/openapi.json</a></div>
        <div>MCP manifest: <a href="/mcp/manifest">/mcp/manifest</a></div>
        <div>Realtime: <a href="/v1/realtime/stream">/v1/realtime/stream</a></div>
        <div>Proof of reserves: <a href="/v1/bank-core/reserve-ratio">/v1/bank-core/reserve-ratio</a></div>
        <div>Audit verify: <a href="/v1/audit/verify">/v1/audit/verify</a></div>
      </div>
    </div>
  </div>
</div>

</div></body></html>`;
}

function registerOperatorHqRoutes(app, pool) {
  app.get('/v1/admin/hq.json', async (req, res) => {
    if (!isAdmin(req)) return res.status(401).json({ error: 'admin_auth_required' });
    res.json(await buildSnapshot(pool, app));
  });
  app.get('/v1/admin/hq', async (req, res) => {
    if (!isAdmin(req)) return res.status(401).type('html').send(`<!doctype html><html><body style="font-family:system-ui;background:#0a0a0a;color:#f0f0f0;padding:48px;text-align:center"><h1>401</h1><p>Admin token required. Pass header <code>x-admin-token: $OPERATOR_ADMIN_TOKEN</code> or query <code>?token=...</code></p><p>If you're trying this from a browser, this dashboard is admin-only. Try <a href="/v1/dashboard" style="color:#7df9ff">/v1/dashboard</a> instead.</p></body></html>`);
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    const snap = await buildSnapshot(pool, app);
    res.send(renderHq(snap));
  });
}

module.exports = { migrate, registerOperatorHqRoutes, buildSnapshot };
