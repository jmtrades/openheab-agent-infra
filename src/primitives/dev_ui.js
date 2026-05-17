// ============================================================================
// dev_ui.js — front-ends for endpoints that already exist as JSON-only APIs.
//
//   GET /api-keys           UI to list/create/rotate/revoke (wraps api_keys_v2)
//   GET /webhooks           UI to subscribe + see delivery logs (wraps webhooks_v2)
//   GET /usage              token-counter dashboard
//   GET /logs               recent request log
//   GET /openapi-explorer   Swagger-UI-style browser of /openapi.json
//   GET /audit-verify       interactive UI for /v1/audit/verify
//   GET /openheab-cli       polished CLI install page
// ============================================================================
const ds = require('../design_system');

function shell(title, description, content, extraHead = '') {
  return `${ds.head(`${title} — OpenHeab`, description, { extraHead })}${ds.NAV_HTML('')}<main>${content}</main>${ds.FOOTER_HTML()}`;
}

// All these pages do the same thing — they expect the user to paste their
// API key into a localStorage-backed input, and then make authenticated
// fetches from the browser. Standard SPA pattern for self-serve developer UIs.

function apiKeyForm() {
  return `
<div id="auth-card" class="card" style="margin-bottom:24px">
  <h3 style="font:600 14px var(--mono);color:var(--dim);text-transform:uppercase;letter-spacing:1.5px;margin-bottom:10px">Your API key</h3>
  <p style="color:var(--dim2);font-size:13px;line-height:1.6;margin-bottom:10px">Stored in your browser's localStorage. Never sent anywhere except openheab.com.</p>
  <div style="display:flex;gap:8px">
    <input type="password" id="apikey" placeholder="sk_oh_..." style="flex:1">
    <button id="save" class="btn primary">Save</button>
    <button id="clear" class="btn ghost">Clear</button>
  </div>
  <div id="auth-status" style="margin-top:10px;font:500 12px var(--mono);color:var(--dim)"></div>
</div>`;
}

const AUTH_JS = `
function getKey(){ return localStorage.getItem('openheab_key') || ''; }
function setKey(k){ k ? localStorage.setItem('openheab_key', k) : localStorage.removeItem('openheab_key'); paint(); }
function paint(){
  var k = getKey();
  var input = document.getElementById('apikey');
  var status = document.getElementById('auth-status');
  if (input) input.value = k ? k.slice(0,6) + '…' + k.slice(-4) : '';
  if (status) status.innerHTML = k ? '<span style="color:var(--good)">✓ key saved locally</span>' : '<span style="color:var(--dim)">no key — paste one above</span>';
  if (typeof load === 'function' && k) load();
}
document.getElementById('save')?.addEventListener('click', function(){
  var v = document.getElementById('apikey').value.trim();
  if (v && !v.includes('…')) setKey(v);
});
document.getElementById('clear')?.addEventListener('click', function(){ setKey(''); });
async function api(method, path, body){
  var r = await fetch(path, {
    method,
    headers: { 'Authorization': 'Bearer ' + getKey(), 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  var t = await r.text();
  try { return { ok: r.ok, status: r.status, body: JSON.parse(t) }; }
  catch { return { ok: r.ok, status: r.status, body: t }; }
}
paint();
`;

// ----------------------------------------------------------------------------
// /api-keys
// ----------------------------------------------------------------------------
function apiKeysPage() {
  return shell('API Keys', 'Create, list, rotate, revoke API keys.',
`<section style="max-width:980px;margin:0 auto;padding:60px 16px">
  <span class="badge b-acc">API Keys</span>
  <h1 style="font:600 40px/1.1 var(--display);letter-spacing:-1px;margin:18px 0">API Keys.</h1>
  <p style="color:var(--dim2);font-size:15px;line-height:1.6;max-width:680px">Self-serve front-end for the <a href="/mcp/registry/openheab.api-keys.create">api_keys_v2</a> primitive. Raw keys are shown once at creation — store them in your password manager.</p>
</section>
<section style="max-width:980px;margin:0 auto;padding:0 16px 60px">
  ${apiKeyForm()}
  <div class="card" style="margin-bottom:24px">
    <h3 style="font:600 14px var(--mono);color:var(--dim);text-transform:uppercase;letter-spacing:1.5px;margin-bottom:12px">Create new key</h3>
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr auto;gap:8px;align-items:end">
      <label style="display:block"><span style="font:500 11px var(--mono);color:var(--dim);text-transform:uppercase;letter-spacing:1.2px">Label</span><input type="text" id="ck-label" placeholder="my-laptop"></label>
      <label style="display:block"><span style="font:500 11px var(--mono);color:var(--dim);text-transform:uppercase;letter-spacing:1.2px">Scope</span>
        <select id="ck-scope">
          <option value="read_only">read_only</option>
          <option value="read_write" selected>read_write</option>
          <option value="billing_only">billing_only</option>
          <option value="admin">admin</option>
        </select></label>
      <label style="display:block"><span style="font:500 11px var(--mono);color:var(--dim);text-transform:uppercase;letter-spacing:1.2px">Expires in days</span><input type="number" id="ck-ttl" placeholder="(none)" min="1" max="3650"></label>
      <button id="ck-create" class="btn primary">Create</button>
    </div>
    <div id="ck-result" style="margin-top:14px"></div>
  </div>
  <h2 style="font:600 16px var(--mono);color:var(--dim);text-transform:uppercase;letter-spacing:1.5px;margin:24px 0 12px">Your keys</h2>
  <div id="keys-list"></div>
</section>
<script>
async function load(){
  var r = await api('GET', '/v1/me/api-keys');
  var box = document.getElementById('keys-list');
  if (!r.ok) { box.innerHTML = '<div class="card" style="color:var(--bad)">' + (r.body?.error?.message || r.body?.error || ('HTTP ' + r.status)) + '</div>'; return; }
  var keys = r.body?.keys || [];
  if (keys.length === 0) { box.innerHTML = '<div class="card" style="text-align:center;color:var(--dim);padding:48px">No keys yet. Create one above.</div>'; return; }
  box.innerHTML = '<table><thead><tr><th>Label</th><th>Prefix</th><th>Scope</th><th>Created</th><th>Last used</th><th></th></tr></thead><tbody>' +
    keys.map(function(k){
      return '<tr>' +
        '<td><strong>' + esc(k.label || '') + '</strong></td>' +
        '<td style="font:500 12px var(--mono)">' + esc(k.prefix || '') + '…</td>' +
        '<td><span class="badge b-dim">' + esc(k.scope || '') + '</span></td>' +
        '<td style="font:500 11px var(--mono);color:var(--dim)">' + (k.created_at ? new Date(k.created_at).toLocaleDateString() : '') + '</td>' +
        '<td style="font:500 11px var(--mono);color:var(--dim)">' + (k.last_used_at ? new Date(k.last_used_at).toLocaleDateString() : 'never') + '</td>' +
        '<td><button class="btn danger" data-revoke="' + esc(k.key_id) + '">Revoke</button></td>' +
      '</tr>';
    }).join('') + '</tbody></table>';
  box.querySelectorAll('[data-revoke]').forEach(function(btn){
    btn.addEventListener('click', async function(){
      if (!confirm('Revoke this key? It cannot be undone.')) return;
      var r = await api('POST', '/v1/me/api-keys/' + encodeURIComponent(btn.dataset.revoke) + '/revoke');
      if (r.ok) load(); else alert('Failed: ' + (r.body?.error?.message || r.status));
    });
  });
}
function esc(s){ return String(s == null ? '' : s).replace(/[&<>]/g, function(c){return ({'&':'&amp;','<':'&lt;','>':'&gt;'})[c];}); }
document.getElementById('ck-create')?.addEventListener('click', async function(){
  var label = document.getElementById('ck-label').value.trim();
  var scope = document.getElementById('ck-scope').value;
  var ttl = document.getElementById('ck-ttl').value;
  var body = { label: label, scope: scope };
  if (ttl) body.expires_in_days = parseInt(ttl);
  var r = await api('POST', '/v1/me/api-keys', body);
  var box = document.getElementById('ck-result');
  if (!r.ok) { box.innerHTML = '<div style="color:var(--bad);font:500 13px var(--mono)">' + (r.body?.error?.message || ('HTTP ' + r.status)) + '</div>'; return; }
  box.innerHTML = '<div style="padding:12px;background:rgba(34,197,94,.1);border:1px solid var(--good);border-radius:var(--r-md);font:500 13px var(--mono)"><strong>Key created — copy now, won\\'t be shown again:</strong><br><code style="word-break:break-all;color:var(--good)">' + esc(r.body.api_key || r.body.raw_key || '?') + '</code></div>';
  load();
});
${AUTH_JS}
</script>`);
}

// ----------------------------------------------------------------------------
// /webhooks
// ----------------------------------------------------------------------------
function webhooksPage() {
  return shell('Webhooks', 'Subscribe to substrate events.',
`<section style="max-width:980px;margin:0 auto;padding:60px 16px">
  <span class="badge b-acc">Webhooks</span>
  <h1 style="font:600 40px/1.1 var(--display);letter-spacing:-1px;margin:18px 0">Webhooks.</h1>
  <p style="color:var(--dim2);font-size:15px;line-height:1.6;max-width:680px">Subscribe to event streams. Each delivery is HMAC-SHA256-signed with a per-subscription secret; verify with timing-safe compare. Failures auto-retry with exponential backoff.</p>
</section>
<section style="max-width:980px;margin:0 auto;padding:0 16px 60px">
  ${apiKeyForm()}
  <div class="card" style="margin-bottom:24px">
    <h3 style="font:600 14px var(--mono);color:var(--dim);text-transform:uppercase;letter-spacing:1.5px;margin-bottom:12px">Subscribe</h3>
    <div style="display:grid;grid-template-columns:2fr 1fr auto;gap:8px;align-items:end">
      <label style="display:block"><span style="font:500 11px var(--mono);color:var(--dim);text-transform:uppercase;letter-spacing:1.2px">URL</span><input type="url" id="wh-url" placeholder="https://yourapp.com/openheab-webhook"></label>
      <label style="display:block"><span style="font:500 11px var(--mono);color:var(--dim);text-transform:uppercase;letter-spacing:1.2px">Event types (comma-separated, or *)</span><input type="text" id="wh-types" placeholder="bank.transferred,signup.completed"></label>
      <button id="wh-sub" class="btn primary">Subscribe</button>
    </div>
    <div id="wh-result" style="margin-top:14px"></div>
  </div>
  <h2 style="font:600 16px var(--mono);color:var(--dim);text-transform:uppercase;letter-spacing:1.5px;margin:24px 0 12px">Subscriptions</h2>
  <div id="wh-list"></div>
</section>
<script>
async function load(){
  var did = '';
  var meR = await api('GET', '/v1/me');
  if (meR.ok) did = meR.body.did;
  if (!did) { document.getElementById('wh-list').innerHTML = '<div class="card" style="color:var(--bad)">Could not resolve your DID. Check your API key.</div>'; return; }
  var r = await api('GET', '/v1/agents/' + encodeURIComponent(did) + '/webhooks');
  var subs = r.body?.subscriptions || [];
  var box = document.getElementById('wh-list');
  if (subs.length === 0) { box.innerHTML = '<div class="card" style="text-align:center;color:var(--dim);padding:48px">No subscriptions. Add one above.</div>'; return; }
  box.innerHTML = '<table><thead><tr><th>URL</th><th>Events</th><th>Status</th><th>Created</th><th></th></tr></thead><tbody>' +
    subs.map(function(s){ return '<tr>' +
      '<td style="font:500 12px var(--mono);max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(s.target_url || '') + '</td>' +
      '<td style="font:500 11px var(--mono);color:var(--dim2)">' + esc(JSON.stringify(s.event_types || [])) + '</td>' +
      '<td><span class="badge b-' + (s.active ? 'good' : 'dim') + '">' + (s.active ? 'active' : 'paused') + '</span></td>' +
      '<td style="font:500 11px var(--mono);color:var(--dim)">' + (s.created_at ? new Date(s.created_at).toLocaleDateString() : '') + '</td>' +
      '<td><button class="btn danger" data-unsub="' + esc(s.subscription_id) + '" data-did="' + esc(did) + '">Unsubscribe</button></td>' +
    '</tr>'; }).join('') + '</tbody></table>';
  box.querySelectorAll('[data-unsub]').forEach(function(btn){
    btn.addEventListener('click', async function(){
      if (!confirm('Unsubscribe?')) return;
      await api('POST', '/v1/agents/' + encodeURIComponent(btn.dataset.did) + '/webhooks/' + encodeURIComponent(btn.dataset.unsub) + '/unsubscribe');
      load();
    });
  });
}
function esc(s){ return String(s == null ? '' : s).replace(/[&<>]/g, function(c){return ({'&':'&amp;','<':'&lt;','>':'&gt;'})[c];}); }
document.getElementById('wh-sub')?.addEventListener('click', async function(){
  var url = document.getElementById('wh-url').value.trim();
  var types = document.getElementById('wh-types').value.trim();
  var meR = await api('GET', '/v1/me');
  if (!meR.ok) { document.getElementById('wh-result').innerHTML = '<span style="color:var(--bad)">Auth failed</span>'; return; }
  var did = meR.body.did;
  var body = { target_url: url, event_types: types ? types.split(',').map(function(s){return s.trim();}) : ['*'] };
  var r = await api('POST', '/v1/agents/' + encodeURIComponent(did) + '/webhooks/subscribe', body);
  var box = document.getElementById('wh-result');
  if (!r.ok) { box.innerHTML = '<span style="color:var(--bad);font:500 13px var(--mono)">' + (r.body?.error?.message || ('HTTP ' + r.status)) + '</span>'; return; }
  box.innerHTML = '<div style="padding:12px;background:rgba(34,197,94,.1);border:1px solid var(--good);border-radius:var(--r-md);font:500 13px var(--mono)"><strong>Subscribed.</strong> Verify deliveries with this secret (shown once):<br><code style="word-break:break-all;color:var(--good)">' + esc(r.body.signing_secret || '?') + '</code></div>';
  load();
});
${AUTH_JS}
</script>`);
}

// ----------------------------------------------------------------------------
// /usage
// ----------------------------------------------------------------------------
function usagePage() {
  return shell('Usage', 'Token counters + cost tracking.',
`<section style="max-width:980px;margin:0 auto;padding:60px 16px">
  <span class="badge b-acc">Usage</span>
  <h1 style="font:600 40px/1.1 var(--display);letter-spacing:-1px;margin:18px 0">Usage.</h1>
  <p style="color:var(--dim2);font-size:15px;line-height:1.6;max-width:680px">Last 30 days. Inference, transfers, tool calls. Raw data lives in <code>inference_completions</code>, <code>bank_transfers</code>, <code>tool_invocations</code>.</p>
</section>
<section style="max-width:980px;margin:0 auto;padding:0 16px 60px">
  ${apiKeyForm()}
  <div id="usage-data"></div>
</section>
<script>
async function load(){
  var r = await api('GET', '/v1/me/usage');
  var box = document.getElementById('usage-data');
  if (!r.ok) { box.innerHTML = '<div class="card" style="color:var(--bad)">' + (r.body?.error?.message || ('HTTP ' + r.status)) + '</div>'; return; }
  var u = r.body || {};
  function fmt(n){ return Number(n||0).toLocaleString(); }
  function $$(n){ return '$' + (Number(n||0)/100).toFixed(2); }
  box.innerHTML =
    '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px">' +
      '<div class="kpi"><div class="label">Inference calls</div><div class="value">' + fmt(u.inference?.calls) + '</div></div>' +
      '<div class="kpi"><div class="label">Tokens in</div><div class="value">' + fmt(u.inference?.tokens_in) + '</div></div>' +
      '<div class="kpi"><div class="label">Tokens out</div><div class="value">' + fmt(u.inference?.tokens_out) + '</div></div>' +
      '<div class="kpi"><div class="label">Inference cost</div><div class="value">' + $$(u.inference?.cost_cents) + '</div></div>' +
      '<div class="kpi"><div class="label">Transfers</div><div class="value">' + fmt(u.transfers?.count) + '</div></div>' +
      '<div class="kpi"><div class="label">Transfer volume</div><div class="value">' + $$(u.transfers?.volume_cents) + '</div></div>' +
    '</div>';
}
${AUTH_JS}
</script>`);
}

// ----------------------------------------------------------------------------
// /logs
// ----------------------------------------------------------------------------
function logsPage() {
  return shell('Logs', 'Recent request log.',
`<section style="max-width:1100px;margin:0 auto;padding:60px 16px">
  <span class="badge b-acc">Logs</span>
  <h1 style="font:600 40px/1.1 var(--display);letter-spacing:-1px;margin:18px 0">Request Logs.</h1>
  <p style="color:var(--dim2);font-size:15px;line-height:1.6;max-width:680px">Recent requests from your agent. Inference, transfers, tool calls, signed events.</p>
</section>
<section style="max-width:1100px;margin:0 auto;padding:0 16px 60px">
  ${apiKeyForm()}
  <div id="logs-table"></div>
</section>
<script>
async function load(){
  var r = await api('GET', '/v1/me/requests');
  var box = document.getElementById('logs-table');
  if (!r.ok) { box.innerHTML = '<div class="card" style="color:var(--bad)">' + (r.body?.error?.message || ('HTTP ' + r.status)) + '</div>'; return; }
  var rows = r.body?.requests || r.body?.events || [];
  if (rows.length === 0) { box.innerHTML = '<div class="card" style="text-align:center;color:var(--dim);padding:48px">No recent requests.</div>'; return; }
  box.innerHTML = '<table><thead><tr><th>When</th><th>Type</th><th>Detail</th></tr></thead><tbody>' +
    rows.slice(0, 100).map(function(e){
      return '<tr>' +
        '<td style="font:500 11px var(--mono);color:var(--dim);white-space:nowrap">' + (e.created_at ? new Date(e.created_at).toISOString().slice(0, 19).replace('T', ' ') : '') + '</td>' +
        '<td><span class="badge b-dim">' + esc(e.type || e.event_type || e.kind || '?') + '</span></td>' +
        '<td style="font:500 11px var(--mono);color:var(--dim2);max-width:600px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(JSON.stringify(e).slice(0, 200)) + '</td>' +
      '</tr>';
    }).join('') + '</tbody></table>';
}
function esc(s){ return String(s == null ? '' : s).replace(/[&<>]/g, function(c){return ({'&':'&amp;','<':'&lt;','>':'&gt;'})[c];}); }
${AUTH_JS}
</script>`);
}

// ----------------------------------------------------------------------------
// /openapi-explorer
// ----------------------------------------------------------------------------
function openapiExplorerPage() {
  return shell('API Explorer', 'Browse the OpenAPI spec.',
`<section style="max-width:1100px;margin:0 auto;padding:60px 16px 12px">
  <span class="badge b-acc">API Explorer</span>
  <h1 style="font:600 40px/1.1 var(--display);letter-spacing:-1px;margin:18px 0">API Explorer.</h1>
  <p style="color:var(--dim2);font-size:15px;line-height:1.6;max-width:680px">Live, searchable browse of every documented route. Source: <a href="/openapi.json">/openapi.json</a>.</p>
</section>
<section style="max-width:1100px;margin:0 auto;padding:0 16px 60px">
  <input type="search" id="apiq" placeholder="Filter routes by path, method, summary…" style="margin-bottom:18px;font-size:14px">
  <div id="api-list"></div>
</section>
<script>
fetch('/openapi.json').then(r => r.json()).then(spec => {
  var rows = [];
  var paths = spec.paths || {};
  for (var p in paths) {
    for (var m in paths[p]) {
      var op = paths[p][m];
      if (typeof op !== 'object') continue;
      rows.push({ method: m.toUpperCase(), path: p, summary: op.summary || op.description || '', tags: (op.tags || []).join(',') });
    }
  }
  rows.sort(function(a, b){ return a.path.localeCompare(b.path); });
  function render(filter) {
    var f = (filter || '').toLowerCase();
    var html = rows.filter(function(r){
      return !f || r.path.toLowerCase().includes(f) || r.method.toLowerCase().includes(f) || r.summary.toLowerCase().includes(f) || r.tags.toLowerCase().includes(f);
    }).map(function(r){
      var color = r.method === 'GET' ? 'b-acc' : r.method === 'POST' ? 'b-good' : r.method === 'DELETE' ? 'b-bad' : 'b-warn';
      return '<div class="card" style="display:flex;gap:14px;align-items:center;margin-bottom:6px;padding:10px 14px">' +
        '<span class="badge ' + color + '" style="width:56px;text-align:center;flex-shrink:0">' + r.method + '</span>' +
        '<code style="font:500 13px var(--mono);color:var(--acc-dim);flex-shrink:0">' + r.path + '</code>' +
        (r.summary ? '<span style="color:var(--dim2);font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + r.summary + '</span>' : '') +
      '</div>';
    }).join('');
    document.getElementById('api-list').innerHTML = html || '<div class="card" style="text-align:center;color:var(--dim);padding:48px">No matches for "' + filter + '".</div>';
  }
  render('');
  document.getElementById('apiq').addEventListener('input', function(e){ render(e.target.value); });
});
</script>`);
}

// ----------------------------------------------------------------------------
// /audit-verify — interactive
// ----------------------------------------------------------------------------
function auditVerifyPage() {
  return shell('Audit Chain Verify', 'Interactively verify the audit chain.',
`<section style="max-width:780px;margin:0 auto;padding:60px 16px">
  <span class="badge b-acc">Audit Chain Verify</span>
  <h1 style="font:600 40px/1.1 var(--display);letter-spacing:-1px;margin:18px 0">Verify the audit chain.</h1>
  <p style="color:var(--dim2);font-size:15px;line-height:1.6;max-width:680px">Every state change in the substrate gets appended to a Merkle-style SHA-256 chain, Ed25519-signed by the operator root key. This page hits <a href="/v1/audit/verify">/v1/audit/verify</a> and walks the chain locally to confirm continuity.</p>
</section>
<section style="max-width:780px;margin:0 auto;padding:0 16px 60px">
  <button id="verify-btn" class="btn primary" style="padding:14px 24px;font-size:15px">Verify now →</button>
  <div id="verify-result" style="margin-top:24px"></div>
</section>
<script>
document.getElementById('verify-btn').addEventListener('click', async function(){
  var b = document.getElementById('verify-result');
  b.innerHTML = '<div class="card" style="text-align:center;padding:24px;color:var(--dim)">Verifying…</div>';
  try {
    var r = await fetch('/v1/audit/verify');
    var j = await r.json();
    var ok = j.valid !== false && !j.error;
    b.innerHTML = '<div class="card" style="border-color:' + (ok ? 'var(--good)' : 'var(--bad)') + '">' +
      '<div style="display:flex;justify-content:space-between;align-items:center">' +
        '<strong style="font-size:20px;color:' + (ok ? 'var(--good)' : 'var(--bad)') + '">' + (ok ? '✓ Chain valid' : '✗ Verification failed') + '</strong>' +
        '<span style="font:500 12px var(--mono);color:var(--dim)">checked ' + new Date().toISOString() + '</span>' +
      '</div>' +
      '<pre style="margin-top:14px;background:var(--card2);padding:12px;border-radius:var(--r-md);overflow-x:auto;font-size:12px">' + JSON.stringify(j, null, 2) + '</pre>' +
    '</div>';
  } catch (e) {
    b.innerHTML = '<div class="card" style="color:var(--bad)">Error: ' + e.message + '</div>';
  }
});
</script>`);
}

// ----------------------------------------------------------------------------
// /openheab-cli
// ----------------------------------------------------------------------------
function cliPage() {
  return shell('CLI', 'Install the OpenHeab CLI in 60 seconds.',
`<section style="max-width:780px;margin:0 auto;padding:60px 16px">
  <span class="badge b-acc">CLI</span>
  <h1 style="font:600 40px/1.1 var(--display);letter-spacing:-1px;margin:18px 0">OpenHeab CLI.</h1>
  <p style="color:var(--dim2);font-size:15px;line-height:1.6;max-width:680px">A tiny binary that opens a browser, signs you in, drops a credential file, and exposes the substrate as Unix-friendly commands. <code>npx openheab</code> in your terminal.</p>

  <h2 style="font:600 18px var(--display);margin:32px 0 8px">Install</h2>
  <pre style="background:var(--card);border:1px solid var(--br);border-radius:var(--r-md);padding:14px;overflow-x:auto;font-size:13px"><code># npm
npm i -g openheab

# or curl-pipe
curl -sSL https://openheab.com/cli/install.sh | sh

# or npx (no install)
npx openheab signup</code></pre>

  <h2 style="font:600 18px var(--display);margin:32px 0 8px">Common commands</h2>
  <pre style="background:var(--card);border:1px solid var(--br);border-radius:var(--r-md);padding:14px;overflow-x:auto;font-size:13px"><code>openheab signup                            # create identity + wallet + key
openheab me                                # show context
openheab chat "What's the substrate?"      # one-shot chat
openheab keys list                         # list api keys
openheab keys create --label laptop        # mint a new key
openheab webhooks subscribe https://my.app/wh --events bank.transferred
openheab bank balance
openheab bank transfer --to did:op:... --amount 5
openheab agents list                       # browse public directory
openheab agent why did:op:xxx              # interpretability dump
openheab pulse                             # live ops in terminal
openheab audit verify                      # verify chain integrity</code></pre>

  <h2 style="font:600 18px var(--display);margin:32px 0 8px">Authentication</h2>
  <p style="color:var(--dim2);line-height:1.7">The CLI opens a browser, you click "Approve", a credential file is written to <code>~/.openheab/credentials</code> (mode 0600). No copy-paste of API keys.</p>
</section>`);
}

// ----------------------------------------------------------------------------
// Register
// ----------------------------------------------------------------------------
function registerDevUiRoutes(app, _pool) {
  const sendHtml = (res, html) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.send(html);
  };
  app.get('/api-keys', (req, res) => sendHtml(res, apiKeysPage()));
  app.get('/webhooks', (req, res) => sendHtml(res, webhooksPage()));
  app.get('/usage', (req, res) => sendHtml(res, usagePage()));
  app.get('/logs', (req, res) => sendHtml(res, logsPage()));
  app.get('/openapi-explorer', (req, res) => sendHtml(res, openapiExplorerPage()));
  app.get('/audit-verify', (req, res) => sendHtml(res, auditVerifyPage()));
  app.get('/openheab-cli', (req, res) => sendHtml(res, cliPage()));
}

async function migrate(_pool) { /* no schema */ }

module.exports = { migrate, registerDevUiRoutes };
