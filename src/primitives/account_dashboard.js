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

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

const { head: dsHead, NAV_HTML, FOOTER_HTML } = require('../design_system');

function renderDashboard(data) {
  const agent = data.agent || {};
  const wallet = data.wallet || {};
  const kyc = data.kyc || {};
  const kycColor = kyc.status === 'verified' ? 'var(--good)' : (kyc.status ? 'var(--warn)' : 'var(--fg-dim2)');
  const did = escapeHtml(data.did);
  const didUrl = encodeURIComponent(data.did);
  const agentName = escapeHtml(agent.name || 'Your Agent');
  const walletAddress = escapeHtml(wallet.address || '');
  const walletNetwork = escapeHtml(wallet.network || 'base');
  const walletAsset = escapeHtml(wallet.asset || 'USDC');

  const eventsHtml = (data.recent_events || []).map(e => {
    let entry = {}; try { entry = typeof e.entry === 'string' ? JSON.parse(e.entry) : e.entry; } catch {}
    const type = escapeHtml(entry.event_type || 'unknown');
    return `<div class="event"><span class="event-type">${type}</span><span class="event-time">${escapeHtml(timeAgo(e.created_at))}</span></div>`;
  }).join('') || '<div class="empty">No activity yet. Try the SDK examples.</div>';

  const cardsHtml = (data.cards || []).map(c =>
    `<div class="card-row"><span><b>•••• ${escapeHtml(c.last4 || '----')}</b> ${escapeHtml(c.brand || '')}</span><span class="${c.status === 'active' ? 'ok' : 'muted'}">${escapeHtml(c.status || '')}</span></div>`
  ).join('') || '<div class="empty">No cards issued yet.</div>';

  const extraHead = `<style>
.dash-hero{padding:40px 0 24px}
.dash-hero h1{font-size:28px;letter-spacing:-0.8px;margin-bottom:6px;font-weight:600;color:var(--fg)}
.dash-did{font-family:var(--mono);font-size:12.5px;color:var(--fg-dim);word-break:break-all}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin:24px 0 32px}
.kpi{background:var(--bg-elev);border:1px solid var(--br);border-radius:10px;padding:16px 20px;transition:border-color var(--t-fast) var(--ease-out)}
.kpi:hover{border-color:var(--br-strong)}
.kpi .l{font:500 10.5px/1 var(--mono);color:var(--fg-dim2);text-transform:uppercase;letter-spacing:1.4px;margin-bottom:7px}
.kpi .v{font:600 22px/1 var(--mono);letter-spacing:-1px;font-feature-settings:'tnum'}
.kpi .sub{font-size:12px;color:var(--fg-dim);margin-top:6px}
.dash-grid{display:grid;grid-template-columns:1.4fr 1fr;gap:14px}
@media (max-width:880px){.dash-grid{grid-template-columns:1fr}}
.panel{background:var(--bg-elev);border:1px solid var(--br);border-radius:12px;padding:22px 24px;transition:border-color var(--t-fast) var(--ease-out)}
.panel:hover{border-color:var(--br-strong)}
.panel h2{font:500 11px/1 var(--mono);color:var(--fg-dim2);text-transform:uppercase;letter-spacing:1.4px;margin-bottom:14px;font-weight:500}
.event{display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--br);font-family:var(--mono);font-size:12px}
.event:last-child{border-bottom:0}
.event-type{color:var(--fg)}
.event-time{color:var(--fg-dim2)}
.empty{color:var(--fg-dim2);font-size:13px;padding:12px 0;text-align:center}
.card-row{display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--br);font-family:var(--mono);font-size:13px}
.card-row:last-child{border-bottom:0}
.card-row .ok{color:var(--good)}
.card-row .muted{color:var(--fg-dim2)}
.actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}
.address{font-family:var(--mono);font-size:12px;color:var(--fg-dim);word-break:break-all;background:var(--bg);padding:9px 11px;border-radius:6px;margin-top:6px;border:1px solid var(--br)}
</style>`;

  return dsHead(`${did} — Dashboard`,
    `OpenHeab dashboard for agent ${did}. Wallet, KYC, cards, API keys, recent activity.`,
    { path: '/dashboard', extraHead }) +
    NAV_HTML('dashboard') + `<main>
<section class="dash-hero">
  <h1>${agentName}</h1>
  <div class="dash-did">${did}</div>
  ${agent.created_at ? `<div style="color:var(--fg-dim2);font-size:12px;margin-top:6px">Created ${timeAgo(agent.created_at)}</div>` : ''}
</section>

<div class="kpis">
  <div class="kpi">
    <div class="l">KYC Status</div>
    <div class="v" style="color:${kycColor}">${escapeHtml(kyc.status || 'unverified')}</div>
    <div class="sub">${kyc.tier !== undefined ? 'Tier ' + escapeHtml(String(kyc.tier)) : 'Not started'}${kyc.country ? ' · ' + escapeHtml(kyc.country) : ''}</div>
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
    <div class="sub">Active subscriptions</div>
  </div>
</div>

<div class="dash-grid">
  <div class="panel">
    <h2>Recent activity</h2>
    ${eventsHtml}
  </div>
  <div>
    <div class="panel" style="margin-bottom:14px">
      <h2>USDC Wallet</h2>
      ${wallet.address ? `
        <div style="color:var(--fg-dim);font-size:13px">${walletNetwork} · ${walletAsset}</div>
        <div class="address">${walletAddress}</div>
        <div class="actions">
          <a class="btn primary" href="/v1/agents/${didUrl}/wallet">Balance</a>
          <a class="btn" href="/v1/agents/${didUrl}/transactions">History</a>
        </div>
      ` : '<div class="empty">No wallet provisioned yet.</div>'}
    </div>
    <div class="panel">
      <h2>Cards</h2>
      ${cardsHtml}
      <div class="actions">
        <a class="btn primary" href="/v1/agents/${didUrl}/cards/issue">Issue card</a>
        <a class="btn" href="/v1/agents/${didUrl}/cards">View all</a>
      </div>
    </div>
  </div>
</div>

<div class="panel" style="margin-top:14px">
  <h2>Quick actions</h2>
  <div class="actions">
    <a class="btn primary" href="/v1/agents/${didUrl}/keys">API keys</a>
    <a class="btn" href="/v1/agents/${didUrl}/webhooks/subscriptions">Webhooks</a>
    <a class="btn" href="/v1/agents/${didUrl}/kyc">KYC</a>
    <a class="btn" href="/v1/agents/${didUrl}/savings">Savings</a>
    <a class="btn" href="/v1/agents/${didUrl}/lending">Lending</a>
    <a class="btn ghost" href="#" onclick="event.preventDefault();exportData('${did.replace(/'/g, '&#39;')}')">Export data</a>
  </div>
</div>
</main>
<script>
async function exportData(did){
  if (!confirm('Request a signed JSON bundle of all your data?')) return;
  const r = await fetch('/v1/legal/gdpr/export',{ method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ agent_did: did }) });
  const j = await r.json();
  alert('Request submitted: ' + j.request_id + '\\nReady within 24h.');
}
</script>` + FOOTER_HTML();
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
      res.set('content-type', 'text/html');
      const extraHead = `<style>
.signin-shell{min-height:calc(100vh - 120px);display:flex;align-items:center;justify-content:center;padding:40px 0}
.signin-card{max-width:440px;width:100%;text-align:center;background:var(--bg-elev);border:1px solid var(--br);border-radius:14px;padding:36px 32px;animation:rise 500ms var(--ease-out) both}
.signin-card h1{font-size:24px;margin-bottom:10px;letter-spacing:-0.6px;font-weight:600}
.signin-card p{color:var(--fg-dim);margin-bottom:22px;font-size:14px}
.signin-card form{display:flex;flex-direction:column;gap:10px}
.signin-card button{padding:11px 18px;background:var(--fg);color:var(--bg);border:0;border-radius:8px;font-weight:600;font-size:14px;cursor:pointer;font-family:var(--sans);transition:transform var(--t-fast) var(--ease-out),background-color var(--t-fast) var(--ease-out)}
.signin-card button:hover{background:#e4e4e7}
.signin-card button:active{transform:scale(0.97)}
.signin-card .alt{margin-top:20px;font-size:13px;color:var(--fg-dim2)}
</style>`;
      return res.send(dsHead('OpenHeab — Sign in', 'Open your OpenHeab agent dashboard.', { path: '/dashboard', extraHead })
        + NAV_HTML() + `<main>
<div class="signin-shell">
  <div class="signin-card">
    <h1>Open your dashboard</h1>
    <p>Paste your DID, or use a <code>Bearer</code> API key in the Authorization header.</p>
    <form onsubmit="event.preventDefault();const v=document.getElementById('did').value.trim();if(v.startsWith('opk_')||v.startsWith('oh_live_')){fetch('/dashboard',{headers:{authorization:'Bearer '+v}}).then(r=>r.text()).then(html=>{document.open();document.write(html);document.close()})}else{window.location='/dashboard?did='+encodeURIComponent(v)}">
      <input id="did" placeholder="did:op:… or opk_/oh_live_ API key" autofocus required type="text"/>
      <button>Open dashboard <span class="arr">→</span></button>
    </form>
    <p class="alt"><a href="/signup">No account? Sign up</a> · <a href="/demo">Try the demo</a></p>
  </div>
</div>
</main>` + FOOTER_HTML());
    }
    try {
      const data = await gatherAccount(pool, did);
      res.set('content-type', 'text/html; charset=utf-8');
      res.set('cache-control', 'private, no-store');
      res.send(renderDashboard(data));
    } catch (e) {
      res.status(500).set('content-type', 'text/html').send('<h1>Dashboard error</h1><pre>' + String(e.message).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') + '</pre>');
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
