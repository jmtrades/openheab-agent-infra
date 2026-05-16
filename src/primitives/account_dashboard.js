// ============================================================================
// account_dashboard.js — `/dashboard` polished agent home (HTML). The page
// every user lands on after signup or sign-in. Shows wallet balance,
// recent activity, KYC status, API keys, webhook subscriptions, inference
// usage — pulled live from Postgres. Replaces the JSON-only /v1/dashboard.
// ============================================================================
const crypto = require('crypto');

async function migrate(pool) {}

async function gatherAccount(pool, did) {
  const result = { did };

  // Agent profile
  const agent = await pool.query(
    `SELECT did, name, created_at FROM agent_identities WHERE did=$1`, [did]
  ).catch(() => ({ rows: [] }));
  result.agent = agent.rows[0] || null;

  // Wallet
  const wallet = await pool.query(
    `SELECT address, network, asset, created_at FROM wallets WHERE agent_did=$1 LIMIT 1`, [did]
  ).catch(() => ({ rows: [] }));
  result.wallet = wallet.rows[0] || null;

  // KYC
  const kyc = await pool.query(
    `SELECT status, tier, country FROM kyc_subjects WHERE agent_did=$1 ORDER BY created_at DESC LIMIT 1`, [did]
  ).catch(() => ({ rows: [] }));
  result.kyc = kyc.rows[0] || null;

  // Cards
  const cards = await pool.query(
    `SELECT card_id, last4, brand, status FROM cards WHERE agent_did=$1 ORDER BY created_at DESC LIMIT 5`, [did]
  ).catch(() => ({ rows: [] }));
  result.cards = cards.rows;

  // Recent inference
  const recentInf = await pool.query(
    `SELECT COUNT(*)::int AS n, COALESCE(SUM(cost_cents),0)::bigint AS spend_cents
     FROM inference_calls WHERE agent_did=$1 AND created_at > NOW() - INTERVAL '30 days'`, [did]
  ).catch(() => ({ rows: [{ n: 0, spend_cents: 0 }] }));
  result.inference_30d = recentInf.rows[0];

  // API keys (active count)
  const keys = await pool.query(
    `SELECT COUNT(*)::int AS active, MAX(last_used_at) AS last_used
     FROM api_keys_v2 WHERE agent_did=$1 AND revoked_at IS NULL`, [did]
  ).catch(() => ({ rows: [{ active: 0 }] }));
  result.api_keys = keys.rows[0];

  // Webhooks
  const hooks = await pool.query(
    `SELECT COUNT(*)::int AS active FROM webhook_subscriptions_v2 WHERE agent_did=$1 AND enabled=TRUE`, [did]
  ).catch(() => ({ rows: [{ active: 0 }] }));
  result.webhooks = hooks.rows[0];

  // Recent audit events touching this agent
  const events = await pool.query(
    `SELECT length, entry, created_at FROM audit_chain
     WHERE entry->>'agent_did' = $1 OR entry->>'did' = $1 OR entry->>'subject_did' = $1
     ORDER BY length DESC LIMIT 15`, [did]
  ).catch(() => ({ rows: [] }));
  result.recent_events = events.rows;

  return result;
}

function fmtCents(c) {
  const n = Number(c || 0) / 100;
  return '$' + n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function timeAgo(t) {
  if (!t) return 'never';
  const diff = Date.now() - new Date(t).getTime();
  if (diff < 60_000) return Math.floor(diff / 1000) + 's ago';
  if (diff < 3_600_000) return Math.floor(diff / 60_000) + 'm ago';
  if (diff < 86_400_000) return Math.floor(diff / 3_600_000) + 'h ago';
  return Math.floor(diff / 86_400_000) + 'd ago';
}

function renderDashboard(data) {
  const agent = data.agent || {};
  const wallet = data.wallet || {};
  const kyc = data.kyc || {};
  const kycColor = kyc.status === 'verified' ? '#22c55e' : (kyc.status ? '#eab308' : '#666');

  const eventsHtml = (data.recent_events || []).map(e => {
    let entry = {}; try { entry = typeof e.entry === 'string' ? JSON.parse(e.entry) : e.entry; } catch {}
    const type = entry.event_type || 'unknown';
    return `<div class="event"><span class="event-type">${type}</span><span class="event-time">${timeAgo(e.created_at)}</span></div>`;
  }).join('') || '<div class="empty">No activity yet. Try the SDK examples!</div>';

  const cardsHtml = (data.cards || []).map(c =>
    `<div class="card-row"><span><b>•••• ${c.last4 || '----'}</b> ${c.brand || ''}</span><span class="${c.status === 'active' ? 'ok' : 'muted'}">${c.status}</span></div>`
  ).join('') || '<div class="empty">No cards issued yet.</div>';

  return `<!doctype html><html><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>${data.did} — Dashboard</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Inter', sans-serif; background: #0a0a0f; color: #e7e7ee; line-height: 1.6; }
.wrap { max-width: 1180px; margin: 0 auto; padding: 32px 24px 80px; }
.topnav { display: flex; justify-content: space-between; align-items: center; margin-bottom: 40px; padding-bottom: 24px; border-bottom: 1px solid #1a1a25; }
.topnav .logo { font-weight: 700; font-size: 18px; color: #fff; text-decoration: none; letter-spacing: -0.3px; }
.topnav .nav-links a { color: #888; margin-left: 22px; font-size: 14px; text-decoration: none; }
.topnav .nav-links a:hover { color: #fff; }
.hero { margin-bottom: 32px; }
.hero h1 { font-size: 28px; font-weight: 700; letter-spacing: -0.5px; margin-bottom: 6px; }
.did { font-family: 'SF Mono', monospace; font-size: 13px; color: #888; word-break: break-all; }
.kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 14px; margin: 24px 0 40px; }
.kpi { background: #14141c; border: 1px solid #1a1a25; border-radius: 10px; padding: 18px 20px; }
.kpi .l { font-size: 11px; color: #888; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 6px; }
.kpi .v { font-size: 24px; font-weight: 700; letter-spacing: -0.5px; }
.kpi .v.muted { color: #666; }
.kpi .sub { font-size: 12px; color: #888; margin-top: 4px; }
.grid { display: grid; grid-template-columns: 1.4fr 1fr; gap: 18px; }
@media (max-width: 880px) { .grid { grid-template-columns: 1fr; } }
.panel { background: #14141c; border: 1px solid #1a1a25; border-radius: 12px; padding: 22px 24px; }
.panel h2 { font-size: 14px; color: #aaa; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 16px; font-weight: 500; }
.event { display: flex; justify-content: space-between; padding: 9px 0; border-bottom: 1px solid #1a1a25; font-family: 'SF Mono', monospace; font-size: 12px; }
.event:last-child { border-bottom: 0; }
.event-type { color: #e7e7ee; }
.event-time { color: #666; }
.empty { color: #555; font-size: 13px; padding: 12px 0; text-align: center; }
.card-row { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #1a1a25; font-family: 'SF Mono', monospace; font-size: 13px; }
.card-row:last-child { border-bottom: 0; }
.card-row .ok { color: #22c55e; }
.card-row .muted { color: #666; }
.actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px; }
.btn { padding: 8px 14px; background: #1a1a25; color: #ccc; text-decoration: none; border-radius: 6px; font-size: 13px; transition: all 0.15s; border: 1px solid #25253a; }
.btn:hover { background: #25253a; color: #fff; }
.btn.primary { background: #4f46e5; color: #fff; border-color: transparent; }
.btn.primary:hover { background: #4338ca; }
.address { font-family: 'SF Mono', monospace; font-size: 12px; color: #aaa; word-break: break-all; background: #0f0f17; padding: 8px 10px; border-radius: 4px; margin-top: 6px; }
.pill { display: inline-block; padding: 3px 10px; border-radius: 100px; font-size: 11px; font-weight: 600; letter-spacing: 0.5px; text-transform: uppercase; }
</style></head><body><div class="wrap">

<nav class="topnav">
  <a class="logo" href="/">OpenHeab</a>
  <div class="nav-links">
    <a href="/docs">Docs</a>
    <a href="/sdk">SDK</a>
    <a href="/pricing">Pricing</a>
    <a href="/activity">Activity</a>
    <a href="/dashboard" style="color:#fff">Dashboard</a>
  </div>
</nav>

<section class="hero">
  <h1>${agent.name || 'Your Agent'}</h1>
  <div class="did">${data.did}</div>
  ${agent.created_at ? `<div style="color:#666;font-size:12px;margin-top:4px">Created ${timeAgo(agent.created_at)}</div>` : ''}
</section>

<div class="kpis">
  <div class="kpi">
    <div class="l">KYC Status</div>
    <div class="v" style="color:${kycColor}">${kyc.status || 'unverified'}</div>
    <div class="sub">${kyc.tier !== undefined ? 'Tier ' + kyc.tier : 'Not started'}${kyc.country ? ' · ' + kyc.country : ''}</div>
  </div>
  <div class="kpi">
    <div class="l">Inference (30d)</div>
    <div class="v">${(data.inference_30d?.n || 0).toLocaleString()}</div>
    <div class="sub">${fmtCents(data.inference_30d?.spend_cents)} spent</div>
  </div>
  <div class="kpi">
    <div class="l">API Keys</div>
    <div class="v">${data.api_keys?.active || 0}</div>
    <div class="sub">Last used ${timeAgo(data.api_keys?.last_used)}</div>
  </div>
  <div class="kpi">
    <div class="l">Webhooks</div>
    <div class="v">${data.webhooks?.active || 0}</div>
    <div class="sub">Subscribed</div>
  </div>
</div>

<div class="grid">
  <div class="panel">
    <h2>Recent Activity</h2>
    ${eventsHtml}
  </div>
  <div>
    <div class="panel" style="margin-bottom:18px">
      <h2>USDC Wallet</h2>
      ${wallet.address ? `
        <div style="color:#aaa;font-size:13px">${wallet.network || 'base'} · ${wallet.asset || 'USDC'}</div>
        <div class="address">${wallet.address}</div>
        <div class="actions">
          <a class="btn primary" href="/v1/agents/${data.did}/wallet">Balance</a>
          <a class="btn" href="/v1/agents/${data.did}/transactions">History</a>
        </div>
      ` : '<div class="empty">No wallet provisioned yet.</div>'}
    </div>

    <div class="panel">
      <h2>Cards</h2>
      ${cardsHtml}
      <div class="actions">
        <a class="btn primary" href="/v1/agents/${data.did}/cards/issue">Issue Card</a>
        <a class="btn" href="/v1/agents/${data.did}/cards">View All</a>
      </div>
    </div>
  </div>
</div>

<div style="margin-top:20px" class="panel">
  <h2>Quick actions</h2>
  <div class="actions">
    <a class="btn primary" href="/v1/agents/${data.did}/keys">Manage API Keys</a>
    <a class="btn" href="/v1/agents/${data.did}/webhooks/subscriptions">Webhook Subscriptions</a>
    <a class="btn" href="/v1/agents/${data.did}/kyc">KYC Status</a>
    <a class="btn" href="/v1/agents/${data.did}/savings">Savings</a>
    <a class="btn" href="/v1/agents/${data.did}/lending">Lending</a>
    <a class="btn" href="/v1/legal/gdpr/export" onclick="event.preventDefault();exportData('${data.did}')">Export My Data</a>
  </div>
</div>

</div>
<script>
async function exportData(did) {
  if (!confirm('Request a signed JSON bundle of all your data?')) return;
  const r = await fetch('/v1/legal/gdpr/export', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ agent_did: did })
  });
  const j = await r.json();
  alert('Request submitted: ' + j.request_id + '\\nReady within 24h.');
}
</script>
</body></html>`;
}

function registerAccountDashboardRoutes(app, pool, verifyAgentAuth) {
  // GET /dashboard?did=did:op:... (or with auth context)
  app.get('/dashboard', async (req, res) => {
    let did = req.query.did;
    // Try to resolve from Authorization header if not in query
    if (!did && req.headers.authorization?.startsWith('Bearer ')) {
      const key = req.headers.authorization.slice(7);
      try {
        const { verifyApiKey } = require('./api_keys_v2');
        const v = await verifyApiKey(pool, key);
        if (v?.valid) did = v.agent_did;
      } catch {}
    }
    if (!did) {
      // No DID supplied — show a welcome page that prompts for one
      res.set('content-type', 'text/html');
      return res.send(`<!doctype html><html><head><title>OpenHeab — Dashboard</title>
<style>body{font-family:-apple-system,sans-serif;background:#0a0a0f;color:#e7e7ee;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.box{max-width:480px;padding:48px;text-align:center}h1{font-size:28px;margin-bottom:16px;letter-spacing:-0.5px}
p{color:#888;margin-bottom:24px}input{width:100%;padding:12px 14px;background:#14141c;border:1px solid #1f1f2a;color:#fff;border-radius:8px;font-family:monospace;margin-bottom:12px;outline:none}
input:focus{border-color:#4f46e5}button{padding:12px 24px;background:#4f46e5;color:#fff;border:0;border-radius:8px;font-weight:600;cursor:pointer;width:100%}
button:hover{background:#4338ca}a{color:#818cf8;font-size:13px}</style></head><body>
<div class="box"><h1>Open your agent dashboard</h1>
<p>Paste your DID (or send a Bearer API key request to <code style="background:#14141c;padding:2px 6px;border-radius:4px;font-size:12px">/dashboard</code>)</p>
<form onsubmit="event.preventDefault();const v=document.getElementById('did').value.trim();if(v.startsWith('opk_')||v.startsWith('oh_live_')){fetch('/dashboard',{headers:{authorization:'Bearer '+v}}).then(r=>r.text()).then(html=>{document.open();document.write(html);document.close()})}else{window.location='/dashboard?did='+encodeURIComponent(v)}">
  <input id="did" placeholder="did:op:... or opk_/oh_live_ API key" autofocus required/>
  <button>Open dashboard</button>
</form>
<p style="margin-top:24px"><a href="/signup">Don't have an account? Sign up</a> · <a href="/demo">Try the demo</a></p>
</div></body></html>`);
    }
    try {
      const data = await gatherAccount(pool, did);
      res.set('content-type', 'text/html; charset=utf-8');
      res.set('cache-control', 'private, no-store');
      res.send(renderDashboard(data));
    } catch (e) {
      res.status(500).set('content-type', 'text/html').send('<h1>Dashboard error</h1><pre>' + e.message + '</pre>');
    }
  });

  app.get('/dashboard.json', async (req, res) => {
    const did = req.query.did;
    if (!did) return res.status(400).json({ error: 'did_required' });
    try {
      const data = await gatherAccount(pool, did);
      res.json(data);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
}

module.exports = { migrate, registerAccountDashboardRoutes, gatherAccount };
