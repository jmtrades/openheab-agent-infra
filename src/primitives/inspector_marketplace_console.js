// ============================================================================
// inspector_marketplace_console.js — three more HTML surfaces:
//   - /inspector  — live SSE-driven event stream viewer (audit chain unfolding
//                   in real-time, like Vercel logs)
//   - /marketplace — consumer-facing storefront for the agent marketplace
//                    (extensions, prompts, datasets, tools)
//   - /console    — developer console (API keys UI, recent requests, quick
//                   actions, basically a thinner /dashboard that focuses on
//                   API key management like Anthropic's console)
// ============================================================================

async function migrate(pool) {}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

function renderInspectorPage() {
  return `<!doctype html><html><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>Inspector — OpenHeab</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Inter', sans-serif; background: #0a0a0f; color: #e7e7ee; line-height: 1.5; min-height: 100vh; display: flex; flex-direction: column; }
.topnav { display: flex; justify-content: space-between; align-items: center; padding: 14px 24px; border-bottom: 1px solid #1a1a25; flex-shrink: 0; }
.topnav .logo { font-weight: 700; font-size: 18px; color: #fff; text-decoration: none; }
.topnav .links a { color: #888; margin-left: 18px; font-size: 13px; text-decoration: none; }
.topnav .links a:hover { color: #fff; }
.controls { padding: 16px 24px; display: flex; gap: 12px; align-items: center; border-bottom: 1px solid #1a1a25; flex-wrap: wrap; }
.controls .pill { display: inline-flex; align-items: center; gap: 6px; background: #14141c; padding: 6px 14px; border-radius: 100px; font-size: 12px; }
.pill .dot { width: 8px; height: 8px; border-radius: 50%; background: #ef4444; }
.pill.live .dot { background: #22c55e; animation: pulse 1.5s infinite; }
@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
.controls input { flex: 1; max-width: 340px; padding: 8px 14px; background: #14141c; border: 1px solid #1f1f2a; color: #fff; border-radius: 6px; font-size: 13px; outline: none; }
.controls input:focus { border-color: #4f46e5; }
.controls button { padding: 8px 16px; background: #1a1a25; color: #ccc; border: 1px solid #25253a; border-radius: 6px; font-size: 13px; cursor: pointer; }
.controls button:hover { background: #25253a; color: #fff; }
.controls button.primary { background: #4f46e5; color: #fff; border: 0; }
.controls button.primary:hover { background: #4338ca; }
.controls .stat { color: #888; font-size: 12px; font-family: monospace; }
main { flex: 1; padding: 16px 24px; overflow-y: auto; font-family: 'SF Mono', 'Menlo', monospace; font-size: 12px; }
.event { padding: 6px 10px; margin: 2px 0; border-radius: 4px; background: rgba(20,20,28,0.5); display: grid; grid-template-columns: 80px 90px 200px 1fr; gap: 14px; align-items: start; }
.event:hover { background: #14141c; }
.event.new { animation: fadein 0.4s; }
@keyframes fadein { from { background: rgba(79, 70, 229, 0.2); } to { background: rgba(20,20,28,0.5); } }
.event .t { color: #555; font-size: 11px; flex-shrink: 0; }
.event .l { color: #444; font-size: 11px; }
.event .type { color: #818cf8; font-weight: 500; }
.event .detail { color: #aaa; word-break: break-all; }
.empty { padding: 40px; text-align: center; color: #555; }
</style></head><body>

<nav class="topnav">
  <a class="logo" href="/">OpenHeab</a>
  <div class="links">
    <a href="/inspector" style="color:#fff">Inspector</a>
    <a href="/marketplace">Marketplace</a>
    <a href="/console">Console</a>
    <a href="/launch">Launch board</a>
    <a href="/admin">Admin</a>
  </div>
</nav>

<div class="controls">
  <span class="pill" id="status"><span class="dot"></span><span id="status-text">disconnected</span></span>
  <input id="filter" placeholder="Filter by event_type (e.g. inference, transfer, signup)" />
  <button onclick="clearEvents()">Clear</button>
  <button class="primary" id="toggle" onclick="toggleConnect()">Connect</button>
  <span class="stat" id="stat">0 events</span>
</div>

<main id="events">
  <div class="empty" id="empty">Press <b>Connect</b> to start streaming events. (Or visit <a href="/demo" style="color:#818cf8">/demo</a> to generate one.)</div>
</main>

<script>
let es = null, total = 0, filter = '';
const eventsEl = document.getElementById('events');
const stat = document.getElementById('stat');
const statusPill = document.getElementById('status');
const statusText = document.getElementById('status-text');
const toggle = document.getElementById('toggle');

document.getElementById('filter').addEventListener('input', e => { filter = (e.target.value || '').toLowerCase(); });

function toggleConnect() {
  if (es) { es.close(); es = null; toggle.textContent = 'Connect'; statusPill.classList.remove('live'); statusText.textContent = 'disconnected'; return; }

  // Connect to SSE stream
  es = new EventSource('/v1/realtime/stream');
  toggle.textContent = 'Disconnect';
  statusPill.classList.add('live');
  statusText.textContent = 'live';

  if (document.getElementById('empty')) document.getElementById('empty').remove();

  es.onmessage = e => {
    let data;
    try { data = JSON.parse(e.data); } catch { data = { raw: e.data }; }
    const eventType = (data.event_type || data.type || 'event');
    if (filter && !JSON.stringify(data).toLowerCase().includes(filter)) return;
    const div = document.createElement('div');
    div.className = 'event new';
    const time = new Date().toISOString().slice(11, 19);
    const len = data._audit_length || '?';
    const detail = Object.entries(data)
      .filter(([k]) => !['event_type', 'type', '_audit_length', '_audit_hash', 'nonce'].includes(k))
      .slice(0, 3)
      .map(([k, v]) => k + '=' + String(v).slice(0, 60))
      .join(' · ');
    div.innerHTML = '<span class="t">' + time + '</span>' +
                    '<span class="l">#' + len + '</span>' +
                    '<span class="type">' + escapeHtml(eventType) + '</span>' +
                    '<span class="detail">' + escapeHtml(detail) + '</span>';
    eventsEl.insertBefore(div, eventsEl.firstChild);
    total++;
    stat.textContent = total + ' event' + (total === 1 ? '' : 's');
    // Cap at 500 events to avoid DOM bloat
    while (eventsEl.children.length > 500) eventsEl.removeChild(eventsEl.lastChild);
  };
  es.onerror = () => { statusText.textContent = 'reconnecting...'; };
}

function clearEvents() { eventsEl.innerHTML = ''; total = 0; stat.textContent = '0 events'; }
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }
</script>
</body></html>`;
}

async function gatherMarketplace(pool) {
  const safe = async (sql, params = []) => {
    try { return (await pool.query(sql, params)).rows; } catch { return []; }
  };
  const extensions = await safe(
    `SELECT extension_id, name, description, owner_did, price_cents, created_at
     FROM extensions WHERE status='published' ORDER BY created_at DESC LIMIT 24`
  );
  const prompts = await safe(
    `SELECT prompt_id, title, description, owner_did, price_cents, created_at
     FROM prompts WHERE status='published' ORDER BY created_at DESC LIMIT 24`
  );
  const datasets = await safe(
    `SELECT dataset_id, name, description, owner_did, price_cents, created_at
     FROM datasets WHERE status='published' ORDER BY created_at DESC LIMIT 24`
  );
  return { extensions, prompts, datasets };
}

function renderMarketplacePage(data) {
  const fmtPrice = c => c == null || c === 0 ? 'Free' : '$' + (Number(c) / 100).toFixed(2);
  const card = (title, desc, owner, price, kind, id) => `
    <a href="/v1/${kind}/${escapeHtml(id)}" class="card">
      <div class="card-head">
        <h3>${escapeHtml(title)}</h3>
        <span class="price">${escapeHtml(fmtPrice(price))}</span>
      </div>
      <p class="desc">${escapeHtml((desc || '').slice(0, 140))}</p>
      <div class="owner">by <code>${escapeHtml(String(owner || '').slice(0, 32))}...</code></div>
    </a>`;

  const ext = data.extensions.length ? data.extensions.map(e =>
    card(e.name, e.description, e.owner_did, e.price_cents, 'extensions', e.extension_id)
  ).join('') : '<div class="empty">No extensions published yet. <a href="/v1/extensions">Publish yours →</a></div>';

  const pr = data.prompts.length ? data.prompts.map(p =>
    card(p.title, p.description, p.owner_did, p.price_cents, 'prompts', p.prompt_id)
  ).join('') : '<div class="empty">No prompts published yet.</div>';

  const ds = data.datasets.length ? data.datasets.map(d =>
    card(d.name, d.description, d.owner_did, d.price_cents, 'datasets', d.dataset_id)
  ).join('') : '<div class="empty">No datasets published yet.</div>';

  return `<!doctype html><html><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>Marketplace — OpenHeab</title>
<meta name="description" content="Buy + sell agent extensions, prompts, datasets, tools. 70/30 publisher/platform split.">
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Inter', sans-serif; background: #0a0a0f; color: #e7e7ee; line-height: 1.6; }
.wrap { max-width: 1180px; margin: 0 auto; padding: 48px 24px 80px; }
.nav { display: flex; justify-content: space-between; align-items: center; margin-bottom: 40px; }
.nav .logo { font-weight: 700; font-size: 18px; color: #fff; text-decoration: none; }
.nav .links a { color: #888; margin-left: 20px; font-size: 14px; text-decoration: none; }
.nav .links a:hover { color: #fff; }
h1 { font-size: 40px; font-weight: 700; letter-spacing: -1px; margin-bottom: 10px; }
.subtitle { color: #888; font-size: 16px; margin-bottom: 36px; max-width: 720px; }
.banner { background: linear-gradient(135deg, #4f46e520, #818cf820); border: 1px solid #4f46e540; border-radius: 12px; padding: 20px 28px; margin-bottom: 32px; display: flex; justify-content: space-between; align-items: center; gap: 18px; flex-wrap: wrap; }
.banner .text { color: #c5c5d5; font-size: 14px; }
.banner .text b { color: #fff; }
.banner a { display: inline-block; padding: 10px 18px; background: #4f46e5; color: #fff; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 13px; }
.banner a:hover { background: #4338ca; }
.section { margin-bottom: 40px; }
.section h2 { font-size: 14px; color: #818cf8; text-transform: uppercase; letter-spacing: 1.2px; margin-bottom: 16px; font-weight: 600; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 12px; }
.card { background: #14141c; border: 1px solid #1f1f2a; border-radius: 10px; padding: 18px 20px; text-decoration: none; color: inherit; transition: all 0.15s; display: block; }
.card:hover { border-color: #4f46e5; transform: translateY(-1px); }
.card-head { display: flex; justify-content: space-between; align-items: start; gap: 10px; margin-bottom: 8px; }
.card h3 { font-size: 15px; color: #fff; font-weight: 600; }
.card .price { font-size: 12px; padding: 3px 8px; border-radius: 100px; background: #22c55e15; color: #22c55e; flex-shrink: 0; font-weight: 600; }
.card .desc { color: #aaa; font-size: 13px; line-height: 1.5; margin-bottom: 10px; min-height: 40px; }
.card .owner { font-size: 11px; color: #555; font-family: monospace; }
.empty { background: #14141c; padding: 24px; border-radius: 10px; text-align: center; color: #888; font-size: 14px; }
.empty a { color: #818cf8; }
.footer { color: #555; font-size: 12px; margin-top: 48px; text-align: center; }
.footer a { color: #888; margin: 0 8px; }
</style></head><body><div class="wrap">

<nav class="nav">
  <a class="logo" href="/">OpenHeab</a>
  <div class="links">
    <a href="/marketplace" style="color:#fff">Marketplace</a>
    <a href="/inspector">Inspector</a>
    <a href="/console">Console</a>
    <a href="/docs">Docs</a>
    <a href="/pricing">Pricing</a>
  </div>
</nav>

<h1>Marketplace</h1>
<p class="subtitle">Buy + sell agent extensions, prompts, datasets, and tools. 70% goes to the publisher, 30% to OpenHeab. Payments settle in USDC.</p>

<div class="banner">
  <div class="text">
    <b>Are you a builder?</b> Publish your prompt, dataset, or extension and earn from every install.
  </div>
  <a href="/docs/marketplace">Publish →</a>
</div>

<div class="section">
  <h2>Extensions <span style="color:#444;font-weight:400">· ${data.extensions.length}</span></h2>
  <div class="grid">${ext}</div>
</div>

<div class="section">
  <h2>Prompts <span style="color:#444;font-weight:400">· ${data.prompts.length}</span></h2>
  <div class="grid">${pr}</div>
</div>

<div class="section">
  <h2>Datasets <span style="color:#444;font-weight:400">· ${data.datasets.length}</span></h2>
  <div class="grid">${ds}</div>
</div>

<div class="footer">
  Marketplace API: <a href="/v1/extensions">/v1/extensions</a> · <a href="/v1/prompts">/v1/prompts</a> · <a href="/v1/datasets">/v1/datasets</a>
</div>

</div></body></html>`;
}

function renderConsolePage() {
  return `<!doctype html><html><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>Developer Console — OpenHeab</title>
<meta name="description" content="Manage API keys, view recent requests, run inference. The console for serious developers.">
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Inter', sans-serif; background: #0a0a0f; color: #e7e7ee; line-height: 1.6; }
.wrap { max-width: 1100px; margin: 0 auto; padding: 32px 24px 80px; }
.nav { display: flex; justify-content: space-between; align-items: center; margin-bottom: 32px; padding-bottom: 20px; border-bottom: 1px solid #1a1a25; }
.nav .logo { font-weight: 700; font-size: 18px; color: #fff; text-decoration: none; }
.nav .links a { color: #888; margin-left: 20px; font-size: 14px; text-decoration: none; }
.nav .links a:hover { color: #fff; }
h1 { font-size: 32px; font-weight: 700; letter-spacing: -0.6px; margin-bottom: 10px; }
.subtitle { color: #888; margin-bottom: 32px; }
.auth { background: #14141c; padding: 16px 20px; border-radius: 10px; margin-bottom: 24px; display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
.auth label { font-size: 13px; color: #aaa; }
.auth input { flex: 1; min-width: 220px; padding: 8px 12px; background: #0f0f17; border: 1px solid #1f1f2a; color: #fff; border-radius: 6px; font-family: monospace; font-size: 13px; outline: none; }
.auth input:focus { border-color: #4f46e5; }
.auth button { padding: 8px 16px; background: #4f46e5; color: #fff; border: 0; border-radius: 6px; font-weight: 600; cursor: pointer; font-size: 13px; }
.auth button:hover { background: #4338ca; }
.grid { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }
@media (max-width: 800px) { .grid { grid-template-columns: 1fr; } }
.panel { background: #14141c; border: 1px solid #1a1a25; border-radius: 12px; padding: 22px 24px; }
.panel h2 { font-size: 14px; color: #aaa; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 16px; font-weight: 600; display: flex; justify-content: space-between; align-items: center; }
.panel h2 .actions { display: flex; gap: 6px; }
.panel h2 .actions button { background: #1a1a25; color: #ccc; border: 1px solid #25253a; padding: 4px 10px; border-radius: 5px; font-size: 11px; cursor: pointer; }
.panel h2 .actions button:hover { background: #25253a; color: #fff; }
.list-item { padding: 10px 0; border-bottom: 1px solid #1a1a25; display: flex; justify-content: space-between; align-items: center; gap: 10px; }
.list-item:last-child { border-bottom: 0; }
.list-item .name { font-size: 13px; font-weight: 500; }
.list-item .meta { font-size: 11px; color: #888; font-family: monospace; margin-top: 2px; }
.list-item .right { font-family: monospace; font-size: 11px; color: #666; text-align: right; flex-shrink: 0; }
.empty { color: #555; font-size: 13px; padding: 16px 0; text-align: center; }
.create-key { display: flex; gap: 8px; margin-top: 12px; }
.create-key input { flex: 1; padding: 8px 12px; background: #0f0f17; border: 1px solid #1f1f2a; color: #fff; border-radius: 6px; font-size: 13px; outline: none; }
.create-key select { padding: 8px 12px; background: #0f0f17; border: 1px solid #1f1f2a; color: #fff; border-radius: 6px; font-size: 13px; }
.create-key button { padding: 8px 16px; background: #4f46e5; color: #fff; border: 0; border-radius: 6px; font-weight: 600; cursor: pointer; font-size: 13px; }
.new-key-modal { background: #1f1f2a; padding: 14px 18px; border-radius: 8px; margin-top: 12px; }
.new-key-modal .warn { color: #f97316; font-size: 12px; margin-bottom: 6px; font-weight: 600; }
.new-key-modal code { background: #0a0a12; padding: 8px 12px; border-radius: 4px; font-size: 12px; word-break: break-all; display: block; }
.req-row { display: grid; grid-template-columns: 80px 1fr 80px; gap: 10px; padding: 8px 0; font-family: monospace; font-size: 11px; border-bottom: 1px solid #1a1a25; }
.req-row:last-child { border-bottom: 0; }
.req-row .provider { color: #818cf8; font-weight: 500; }
.req-row .model { color: #c5c5d5; }
.req-row .when { color: #555; text-align: right; }
</style></head><body><div class="wrap">

<nav class="nav">
  <a class="logo" href="/">OpenHeab</a>
  <div class="links">
    <a href="/console" style="color:#fff">Console</a>
    <a href="/workbench">Workbench</a>
    <a href="/inspector">Inspector</a>
    <a href="/dashboard">Dashboard</a>
    <a href="/docs">Docs</a>
  </div>
</nav>

<h1>Developer Console</h1>
<p class="subtitle">Manage your API keys, see recent requests, run quick inference. For serious development workflow.</p>

<div class="auth">
  <label>DID</label>
  <input id="did" placeholder="did:op:..." />
  <label>API Key (optional, for /me endpoints)</label>
  <input id="apikey" type="password" placeholder="opk_... or oh_live_..." />
  <button onclick="load()">Load</button>
</div>

<div id="empty-state" style="text-align:center;padding:60px 24px;color:#555">
  <p>Paste your DID above to view your console.</p>
  <p style="margin-top:10px;font-size:13px"><a href="/signup" style="color:#818cf8">Sign up</a> · <a href="/v1/me" style="color:#818cf8">/v1/me</a></p>
</div>

<div id="loaded" style="display:none">
  <div class="grid">
    <div class="panel">
      <h2>API Keys <span class="actions"><button onclick="loadKeys()">Refresh</button></span></h2>
      <div id="keys"></div>
      <div class="create-key">
        <input id="newKeyName" placeholder="Key name (e.g. production)" />
        <select id="newKeyScope">
          <option value="read-write">read-write</option>
          <option value="read-only">read-only</option>
          <option value="billing-only">billing-only</option>
          <option value="admin">admin</option>
        </select>
        <button onclick="createKey()">Create</button>
      </div>
      <div id="new-key-modal" class="new-key-modal" style="display:none">
        <div class="warn">Save this key now — it won't be shown again:</div>
        <code id="new-key-value"></code>
      </div>
    </div>

    <div class="panel">
      <h2>Webhooks <span class="actions"><button onclick="loadWebhooks()">Refresh</button></span></h2>
      <div id="webhooks"></div>
    </div>
  </div>

  <div style="margin-top:18px" class="panel">
    <h2>Recent Requests (last 100) <span class="actions"><button onclick="loadRequests()">Refresh</button></span></h2>
    <div id="requests"></div>
  </div>

  <div style="margin-top:18px" class="panel">
    <h2>Usage (last 7 days) <span class="actions"><button onclick="loadUsage()">Refresh</button></span></h2>
    <div id="usage"></div>
  </div>
</div>

<script>
let did = '', apikey = '';
function authHeaders() {
  const h = {};
  if (apikey) h.authorization = 'Bearer ' + apikey;
  if (did) h['x-agent-did'] = did;
  return h;
}
async function api(path) {
  const r = await fetch(path, { headers: authHeaders() });
  if (!r.ok) return { error: r.status };
  return await r.json();
}
async function load() {
  did = document.getElementById('did').value.trim();
  apikey = document.getElementById('apikey').value.trim();
  if (!did && !apikey) { alert('Need DID or API key'); return; }
  document.getElementById('empty-state').style.display = 'none';
  document.getElementById('loaded').style.display = '';
  await Promise.all([loadKeys(), loadWebhooks(), loadRequests(), loadUsage()]);
}
async function loadKeys() {
  const j = await api('/v1/me/keys');
  const el = document.getElementById('keys');
  if (j.error || !j.keys?.length) { el.innerHTML = '<div class="empty">No keys yet — create one below.</div>'; return; }
  el.innerHTML = j.keys.map(k => \`
    <div class="list-item">
      <div>
        <div class="name">\${k.name || '(unnamed)'} <span style="color:#666;font-size:11px">\${k.scope}</span></div>
        <div class="meta">\${k.key_prefix}... · used \${k.use_count} times</div>
      </div>
      <div class="right">
        \${k.revoked_at ? '<span style="color:#ef4444">revoked</span>' : '<span style="color:#22c55e">active</span>'}
      </div>
    </div>\`).join('');
}
async function loadWebhooks() {
  const j = await api('/v1/me/webhooks');
  const el = document.getElementById('webhooks');
  if (j.error || !j.subscriptions?.length) { el.innerHTML = '<div class="empty">No webhook subscriptions.</div>'; return; }
  el.innerHTML = j.subscriptions.map(w => \`
    <div class="list-item">
      <div>
        <div class="name">\${w.target_url}</div>
        <div class="meta">\${(w.event_types || []).join(', ')}</div>
      </div>
      <div class="right">\${w.enabled ? '<span style="color:#22c55e">enabled</span>' : '<span style="color:#ef4444">disabled</span>'}</div>
    </div>\`).join('');
}
async function loadRequests() {
  const j = await api('/v1/me/requests?limit=20');
  const el = document.getElementById('requests');
  const calls = j.inference_calls || [];
  if (!calls.length) { el.innerHTML = '<div class="empty">No requests yet — try /workbench.</div>'; return; }
  el.innerHTML = calls.map(c => {
    const when = new Date(c.created_at);
    const ago = Math.floor((Date.now() - when) / 60000);
    return \`<div class="req-row"><span class="provider">\${c.provider}</span><span class="model">\${c.model}</span><span class="when">\${ago}m ago</span></div>\`;
  }).join('');
}
async function loadUsage() {
  const j = await api('/v1/usage/summary');
  const el = document.getElementById('usage');
  if (j.error) { el.innerHTML = '<div class="empty">No usage data.</div>'; return; }
  const p = j.periods || {};
  el.innerHTML = \`
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:14px">
      <div><div class="meta">Today</div><div style="font-size:20px;font-weight:700">\${(p.today?.calls || 0).toLocaleString()}</div><div class="meta">$\${((p.today?.spend_cents || 0)/100).toFixed(2)}</div></div>
      <div><div class="meta">7d</div><div style="font-size:20px;font-weight:700">\${(p.week?.calls || 0).toLocaleString()}</div><div class="meta">$\${((p.week?.spend_cents || 0)/100).toFixed(2)}</div></div>
      <div><div class="meta">30d</div><div style="font-size:20px;font-weight:700">\${(p.month?.calls || 0).toLocaleString()}</div><div class="meta">$\${((p.month?.spend_cents || 0)/100).toFixed(2)}</div></div>
      <div><div class="meta">All</div><div style="font-size:20px;font-weight:700">\${(p.year?.calls || 0).toLocaleString()}</div><div class="meta">$\${((p.year?.spend_cents || 0)/100).toFixed(2)}</div></div>
    </div>
  \`;
}
async function createKey() {
  const name = document.getElementById('newKeyName').value.trim();
  const scope = document.getElementById('newKeyScope').value;
  if (!name || !did) { alert('Need DID + key name'); return; }
  // POST /v1/agents/:did/keys requires signed request — for console we route through internal helper
  // For the demo we'll show what the curl would be
  const curl = 'curl -X POST /v1/agents/' + did + '/keys \\\\\\n  -H "x-agent-did: ' + did + '" \\\\\\n  -H "x-agent-signature: <SIGNED>" \\\\\\n  -d \\'{"name":"' + name + '","scope":"' + scope + '"}\\'';
  document.getElementById('new-key-value').textContent = curl;
  document.getElementById('new-key-modal').style.display = '';
  document.querySelector('#new-key-modal .warn').textContent = 'Run this curl from your terminal (needs your Ed25519 private key):';
}
</script>

</div></body></html>`;
}

function registerInspectorMarketplaceConsoleRoutes(app, pool) {
  // /inspector — live SSE event viewer
  app.get('/inspector', (req, res) => {
    res.set('content-type', 'text/html; charset=utf-8');
    res.set('cache-control', 'public, max-age=300');
    res.send(renderInspectorPage());
  });

  // /marketplace — consumer storefront
  app.get('/marketplace', async (req, res) => {
    try {
      const data = await gatherMarketplace(pool);
      res.set('content-type', 'text/html; charset=utf-8');
      res.set('cache-control', 'public, max-age=60');
      res.send(renderMarketplacePage(data));
    } catch (e) {
      const safe = String(e.message).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      res.status(500).set('content-type', 'text/html').send('<h1>Marketplace error</h1><pre>' + safe + '</pre>');
    }
  });

  // /console — developer console
  app.get('/console-dev', (req, res) => {
    // /console is already taken by status_page.js route browser; use /console-dev
    res.set('content-type', 'text/html; charset=utf-8');
    res.set('cache-control', 'public, max-age=300');
    res.send(renderConsolePage());
  });
  // Also expose at /developer
  app.get('/developer', (req, res) => {
    res.set('content-type', 'text/html; charset=utf-8');
    res.set('cache-control', 'public, max-age=300');
    res.send(renderConsolePage());
  });
}

module.exports = { migrate, registerInspectorMarketplaceConsoleRoutes };
