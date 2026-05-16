// ============================================================================
// admin_ui.js — operator-facing `/admin` HTML console. Shows cross-tenant
// state: agent counts, revenue, recent signups, top-spending agents,
// adapter health, audit chain integrity. The page operators open every
// morning. Gated by OPERATOR_ADMIN_TOKEN (header: x-admin-token).
// ============================================================================
const crypto = require('crypto');

async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_access_log (
      log_id      TEXT PRIMARY KEY,
      action      TEXT NOT NULL,
      ip_hash     TEXT,
      ua_hash     TEXT,
      path        TEXT,
      result      TEXT NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_admin_access_recent ON admin_access_log (created_at DESC);
  `);
}

function isAdmin(req) {
  const token = process.env.OPERATOR_ADMIN_TOKEN || process.env.INTERNAL_API_KEY;
  if (!token) return process.env.NODE_ENV !== 'production'; // dev mode: open
  const provided = req.headers['x-admin-token'] || req.query?.admin_token;
  if (!provided) return false;
  // Constant-time comparison to prevent timing attacks
  try {
    const a = Buffer.from(provided);
    const b = Buffer.from(token);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch { return false; }
}

async function logAccess(pool, req, action, result) {
  try {
    const ipHash = crypto.createHash('sha256').update(String(req.ip || req.headers['x-forwarded-for'] || 'anon')).digest('hex').slice(0, 16);
    const uaHash = crypto.createHash('sha256').update(String(req.headers['user-agent'] || 'anon')).digest('hex').slice(0, 16);
    await pool.query(
      `INSERT INTO admin_access_log (log_id, action, ip_hash, ua_hash, path, result) VALUES ($1,$2,$3,$4,$5,$6)`,
      ['adm_' + crypto.randomBytes(8).toString('hex'), action, ipHash, uaHash, req.path, result]
    ).catch(() => {});
  } catch {}
}

async function gatherAdminState(pool) {
  const data = {};
  const safe = async (sql, params = []) => {
    try { return (await pool.query(sql, params)).rows; } catch { return []; }
  };

  // System-wide counters
  data.counts = {
    agents: (await safe(`SELECT COUNT(*)::int AS n FROM agent_identities`))[0]?.n || 0,
    wallets: (await safe(`SELECT COUNT(*)::int AS n FROM wallets`))[0]?.n || 0,
    kyc_subjects: (await safe(`SELECT COUNT(*)::int AS n FROM kyc_subjects`))[0]?.n || 0,
    audit_events: (await safe(`SELECT COUNT(*)::int AS n FROM audit_chain`))[0]?.n || 0,
    inference_calls: (await safe(`SELECT COUNT(*)::int AS n FROM inference_calls`))[0]?.n || 0,
    api_keys_active: (await safe(`SELECT COUNT(*)::int AS n FROM api_keys_v2 WHERE revoked_at IS NULL`))[0]?.n || 0,
    cards: (await safe(`SELECT COUNT(*)::int AS n FROM cards`))[0]?.n || 0,
    webhooks_active: (await safe(`SELECT COUNT(*)::int AS n FROM webhook_subscriptions_v2 WHERE enabled = TRUE`))[0]?.n || 0
  };

  // 24h activity
  data.last_24h = {
    new_agents: (await safe(`SELECT COUNT(*)::int AS n FROM agent_identities WHERE created_at > NOW() - INTERVAL '24 hours'`))[0]?.n || 0,
    inference_calls: (await safe(`SELECT COUNT(*)::int AS n FROM inference_calls WHERE created_at > NOW() - INTERVAL '24 hours'`))[0]?.n || 0,
    audit_events: (await safe(`SELECT COUNT(*)::int AS n FROM audit_chain WHERE created_at > NOW() - INTERVAL '24 hours'`))[0]?.n || 0,
    revenue_cents: (await safe(`SELECT COALESCE(SUM(cost_cents),0)::bigint AS n FROM inference_calls WHERE created_at > NOW() - INTERVAL '24 hours'`))[0]?.n || 0
  };

  // Revenue all-time
  data.revenue = {
    inference_cents: (await safe(`SELECT COALESCE(SUM(cost_cents),0)::bigint AS n FROM inference_calls`))[0]?.n || 0,
    subscriptions_cents: 0,  // placeholder for subscription revenue
    marketplace_cents: 0
  };

  // Recent signups
  data.recent_signups = await safe(
    `SELECT did, name, created_at FROM agent_identities ORDER BY created_at DESC LIMIT 10`
  );

  // Top spenders
  data.top_spenders = await safe(`
    SELECT agent_did, COUNT(*)::int AS calls, COALESCE(SUM(cost_cents),0)::bigint AS spend_cents
    FROM inference_calls WHERE created_at > NOW() - INTERVAL '30 days'
    GROUP BY agent_did ORDER BY spend_cents DESC LIMIT 10
  `);

  // KYC tier distribution
  data.kyc_by_tier = await safe(`
    SELECT COALESCE(tier::text, 'none') AS tier, COUNT(*)::int AS n
    FROM kyc_subjects GROUP BY tier ORDER BY tier
  `);

  // Adapter status (best-effort)
  try {
    const { configuredAdapters } = require('./production_checks');
    data.adapters = configuredAdapters();
  } catch {}

  // Recent audit events
  data.recent_events = await safe(
    `SELECT length, entry, created_at FROM audit_chain ORDER BY length DESC LIMIT 20`
  );

  return data;
}

function fmtCents(c) {
  return '$' + (Number(c || 0) / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function timeAgo(t) {
  if (!t) return 'never';
  const diff = Date.now() - new Date(t).getTime();
  if (diff < 60_000) return Math.floor(diff / 1000) + 's ago';
  if (diff < 3_600_000) return Math.floor(diff / 60_000) + 'm ago';
  if (diff < 86_400_000) return Math.floor(diff / 3_600_000) + 'h ago';
  return Math.floor(diff / 86_400_000) + 'd ago';
}

function renderAdminPage(data) {
  const fmt = n => Number(n || 0).toLocaleString();
  const adapters = data.adapters || {};
  const adapterCount = Object.values(adapters).filter(Boolean).length;
  const adapterTotal = Object.keys(adapters).length;

  const recent = (data.recent_events || []).map(e => {
    let entry = {}; try { entry = typeof e.entry === 'string' ? JSON.parse(e.entry) : e.entry; } catch {}
    return `<tr><td class="mono">${entry.event_type || 'unknown'}</td><td class="mono small">${(entry.agent_did || entry.did || '').slice(0,32)}</td><td class="muted right">${timeAgo(e.created_at)}</td></tr>`;
  }).join('') || '<tr><td colspan="3" class="muted center">No events yet</td></tr>';

  const signups = (data.recent_signups || []).map(s =>
    `<tr><td>${s.name || '—'}</td><td class="mono small">${s.did.slice(0,32)}</td><td class="muted right">${timeAgo(s.created_at)}</td></tr>`
  ).join('') || '<tr><td colspan="3" class="muted center">No signups yet</td></tr>';

  const spenders = (data.top_spenders || []).map(s =>
    `<tr><td class="mono small">${s.agent_did.slice(0,32)}</td><td class="right">${fmt(s.calls)}</td><td class="right">${fmtCents(s.spend_cents)}</td></tr>`
  ).join('') || '<tr><td colspan="3" class="muted center">No usage yet</td></tr>';

  const kycTiers = (data.kyc_by_tier || []).map(k =>
    `<tr><td>Tier ${k.tier}</td><td class="right">${fmt(k.n)}</td></tr>`
  ).join('') || '<tr><td colspan="2" class="muted center">No KYC records</td></tr>';

  return `<!doctype html><html><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>Operator Admin — OpenHeab</title>
<meta http-equiv="refresh" content="60"/>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Inter', sans-serif; background: #0a0a0f; color: #e7e7ee; line-height: 1.6; }
.wrap { max-width: 1280px; margin: 0 auto; padding: 32px 24px 60px; }
.topnav { display: flex; justify-content: space-between; margin-bottom: 32px; align-items: center; padding-bottom: 18px; border-bottom: 1px solid #1a1a25; }
.brand { font-weight: 700; font-size: 18px; letter-spacing: -0.3px; }
.brand .tag { background: #ef4444; color: white; font-size: 10px; font-weight: 700; padding: 2px 8px; border-radius: 4px; letter-spacing: 1px; margin-left: 8px; }
.nav-links a { color: #888; margin-left: 18px; font-size: 13px; text-decoration: none; }
.nav-links a:hover { color: #fff; }
h2 { font-size: 12px; color: #888; text-transform: uppercase; letter-spacing: 1.2px; margin: 32px 0 14px; font-weight: 500; }
.kpi-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; }
.kpi { background: #14141c; border: 1px solid #1a1a25; padding: 14px 18px; border-radius: 8px; }
.kpi .l { font-size: 10px; color: #888; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px; }
.kpi .v { font-size: 22px; font-weight: 700; letter-spacing: -0.5px; }
.kpi.green { border-left: 3px solid #22c55e; }
.kpi.indigo { border-left: 3px solid #4f46e5; }
.grid { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; margin: 18px 0; }
@media (max-width: 800px) { .grid { grid-template-columns: 1fr; } }
.panel { background: #14141c; border: 1px solid #1a1a25; border-radius: 10px; padding: 18px 22px; }
table { width: 100%; border-collapse: collapse; }
td, th { padding: 8px 4px; border-bottom: 1px solid #1a1a25; font-size: 13px; }
th { color: #888; font-weight: 500; text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; }
td.mono { font-family: 'SF Mono', monospace; }
td.small { font-size: 12px; }
td.right, th.right { text-align: right; }
td.center { text-align: center; padding: 14px 4px; }
td.muted, .muted { color: #666; }
.adapter-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 6px; margin-top: 8px; }
.adapter { padding: 6px 10px; background: #14141c; border-radius: 4px; font-size: 11px; font-family: monospace; display: flex; justify-content: space-between; border-left: 2px solid #555; }
.adapter.ok { border-left-color: #22c55e; }
.adapter span { color: #888; }
.actions { display: flex; gap: 8px; flex-wrap: wrap; margin: 16px 0; }
.btn { padding: 8px 14px; background: #1a1a25; color: #ccc; text-decoration: none; border-radius: 6px; font-size: 13px; border: 1px solid #25253a; cursor: pointer; }
.btn:hover { background: #25253a; color: #fff; }
.btn.primary { background: #4f46e5; border-color: transparent; color: #fff; }
.btn.danger { background: #7f1d1d; border-color: transparent; color: #fff; }
</style></head><body><div class="wrap">

<nav class="topnav">
  <div class="brand">OpenHeab <span class="tag">ADMIN</span></div>
  <div class="nav-links">
    <a href="/launch">Launch board</a>
    <a href="/v1/_health/deep">Deep health</a>
    <a href="/v1/_health/deep/launchready">Launch ready</a>
    <a href="/activity">Activity</a>
    <a href="/openapi.json">OpenAPI</a>
    <span style="color:#666">Auto-refresh 60s · ${new Date().toISOString().slice(11, 19)} UTC</span>
  </div>
</nav>

<h2>System-wide counters</h2>
<div class="kpi-row">
  <div class="kpi indigo"><div class="l">Agents</div><div class="v">${fmt(data.counts?.agents)}</div></div>
  <div class="kpi"><div class="l">Wallets</div><div class="v">${fmt(data.counts?.wallets)}</div></div>
  <div class="kpi"><div class="l">KYC Subjects</div><div class="v">${fmt(data.counts?.kyc_subjects)}</div></div>
  <div class="kpi"><div class="l">Cards</div><div class="v">${fmt(data.counts?.cards)}</div></div>
  <div class="kpi"><div class="l">Audit Events</div><div class="v">${fmt(data.counts?.audit_events)}</div></div>
  <div class="kpi"><div class="l">Inference Calls</div><div class="v">${fmt(data.counts?.inference_calls)}</div></div>
  <div class="kpi"><div class="l">Active API Keys</div><div class="v">${fmt(data.counts?.api_keys_active)}</div></div>
  <div class="kpi"><div class="l">Active Webhooks</div><div class="v">${fmt(data.counts?.webhooks_active)}</div></div>
</div>

<h2>Last 24 hours</h2>
<div class="kpi-row">
  <div class="kpi green"><div class="l">New Agents</div><div class="v">${fmt(data.last_24h?.new_agents)}</div></div>
  <div class="kpi"><div class="l">Inference</div><div class="v">${fmt(data.last_24h?.inference_calls)}</div></div>
  <div class="kpi"><div class="l">Audit Events</div><div class="v">${fmt(data.last_24h?.audit_events)}</div></div>
  <div class="kpi green"><div class="l">Revenue (24h)</div><div class="v">${fmtCents(data.last_24h?.revenue_cents)}</div></div>
  <div class="kpi green"><div class="l">Revenue (all-time)</div><div class="v">${fmtCents(data.revenue?.inference_cents)}</div></div>
</div>

<div class="grid">
  <div class="panel">
    <h2 style="margin-top:0">Recent signups</h2>
    <table><thead><tr><th>Name</th><th>DID</th><th class="right">When</th></tr></thead><tbody>${signups}</tbody></table>
  </div>
  <div class="panel">
    <h2 style="margin-top:0">Top spenders (30d)</h2>
    <table><thead><tr><th>Agent</th><th class="right">Calls</th><th class="right">Spend</th></tr></thead><tbody>${spenders}</tbody></table>
  </div>
</div>

<div class="grid">
  <div class="panel">
    <h2 style="margin-top:0">Recent audit events</h2>
    <table><thead><tr><th>Type</th><th>Agent</th><th class="right">When</th></tr></thead><tbody>${recent}</tbody></table>
  </div>
  <div class="panel">
    <h2 style="margin-top:0">KYC by tier</h2>
    <table><thead><tr><th>Tier</th><th class="right">Count</th></tr></thead><tbody>${kycTiers}</tbody></table>
  </div>
</div>

<h2>Provider adapters (${adapterCount}/${adapterTotal} configured)</h2>
<div class="adapter-grid">
${Object.entries(adapters).map(([k, v]) =>
  `<div class="adapter ${v ? 'ok' : ''}">${k}<span>${v ? 'LIVE' : 'stub'}</span></div>`
).join('')}
</div>

<h2>Admin actions</h2>
<div class="actions">
  <a class="btn primary" href="/v1/admin/backup/create" onclick="event.preventDefault();triggerBackup()">Run backup now</a>
  <a class="btn" href="/v1/admin/backup/list">View backups</a>
  <a class="btn" href="/v1/audit/verify">Verify audit chain</a>
  <a class="btn" href="/v1/_jobs/rlaf-reward-model-update?cron_secret=${process.env.CRON_SECRET || ''}">Run RLAF cron</a>
  <a class="btn" href="/v1/_jobs/webhook-deliver?cron_secret=${process.env.CRON_SECRET || ''}">Drain webhook queue</a>
  <a class="btn danger" href="#" onclick="event.preventDefault();alert('Use /v1/admin/quarantine/:did with x-admin-token to quarantine an agent.')">Quarantine agent</a>
</div>

</div>
<script>
async function triggerBackup() {
  const token = prompt('Admin token?');
  if (!token) return;
  const r = await fetch('/v1/admin/backup/create', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-admin-token': token },
    body: '{}'
  });
  const j = await r.json();
  alert(JSON.stringify(j, null, 2));
}
</script>
</body></html>`;
}

function registerAdminUiRoutes(app, pool) {
  app.get('/admin', async (req, res) => {
    if (!isAdmin(req)) {
      await logAccess(pool, req, 'admin_ui.access', 'denied');
      res.set('content-type', 'text/html');
      return res.status(401).send(`<!doctype html><html><head><title>Admin</title>
<style>body{font-family:-apple-system,sans-serif;background:#0a0a0f;color:#e7e7ee;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.box{max-width:420px;padding:48px;text-align:center}h1{font-size:28px;margin-bottom:14px;letter-spacing:-0.5px}
p{color:#888;margin-bottom:20px}input{width:100%;padding:12px 14px;background:#14141c;border:1px solid #1f1f2a;color:#fff;border-radius:8px;font-family:monospace;margin-bottom:12px;outline:none}
input:focus{border-color:#4f46e5}button{padding:12px 24px;background:#4f46e5;color:#fff;border:0;border-radius:8px;font-weight:600;cursor:pointer;width:100%}</style></head><body>
<div class="box"><h1>Operator admin</h1><p>Enter your OPERATOR_ADMIN_TOKEN</p>
<form onsubmit="event.preventDefault();window.location='/admin?admin_token='+encodeURIComponent(document.getElementById('t').value)">
<input id="t" type="password" autofocus required/><button>Open admin</button></form>
</div></body></html>`);
    }
    try {
      await logAccess(pool, req, 'admin_ui.access', 'allowed');
      const data = await gatherAdminState(pool);
      res.set('content-type', 'text/html; charset=utf-8');
      res.set('cache-control', 'private, no-store');
      res.send(renderAdminPage(data));
    } catch (e) {
      res.status(500).set('content-type', 'text/html').send('<h1>Admin error</h1><pre>' + e.message + '</pre>');
    }
  });

  // Admin access log viewer — see who's tried to access /admin
  app.get('/v1/admin/access-log', async (req, res) => {
    if (!isAdmin(req)) return res.status(401).json({ error: 'admin_required' });
    const r = await pool.query(
      `SELECT log_id, action, ip_hash, ua_hash, path, result, created_at
       FROM admin_access_log ORDER BY created_at DESC LIMIT 200`
    ).catch(() => ({ rows: [] }));
    res.json({ access_log: r.rows });
  });

  app.get('/admin.json', async (req, res) => {
    if (!isAdmin(req)) return res.status(401).json({ error: 'admin_required' });
    await logAccess(pool, req, 'admin_ui.json', 'allowed');
    const data = await gatherAdminState(pool);
    res.json(data);
  });
}

module.exports = { migrate, registerAdminUiRoutes, gatherAdminState };
