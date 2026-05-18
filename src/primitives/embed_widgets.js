// ============================================================================
// embed_widgets.js — copy-paste-able iframes partners drop on their site.
//
//   /embed/chat              floating chat bubble (?did=... for branding)
//   /embed/pulse             tiny live counter strip (good for header)
//   /embed/proof-of-reserves PoR widget for transparency dashboards
//   /embed/leaderboard       top agents card
//   /embed/agent/:did        single-agent badge card
//   /embed/landing-counter   the live-counter strip we use ourselves
//   /embed                   index page with copy-paste embed codes
//
// All embeds render minimal HTML with no nav/footer, sized for iframe use,
// CORS-open, and X-Frame-Options removed (we override the global header
// via res.setHeader before sending).
// ============================================================================
const ds = require('../design_system');

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
}

function shell(title, description, content) {
  return `${ds.head(`${title} — OpenHeab`, description)}${ds.NAV_HTML('')}<main>${content}</main>${ds.FOOTER_HTML()}`;
}

// Minimal embed shell: no nav, no footer, transparent body.
const EMBED_BASE_CSS = `*{margin:0;padding:0;box-sizing:border-box;font-family:ui-monospace,Menlo,monospace}
html,body{background:transparent;color:#f0f0f0;line-height:1.4}
.kpi{padding:10px 14px;border-radius:6px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.1)}
.label{font-size:9px;color:#7a7a7a;text-transform:uppercase;letter-spacing:1.2px}
.value{font-size:18px;font-weight:700;color:#7df9ff;margin-top:4px}
a{color:#7df9ff;text-decoration:none}`;

function embedShell(title, content, extraCss = '') {
  return `<!doctype html><html><head>
<meta charset="utf-8"><title>${escapeHtml(title)}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>${EMBED_BASE_CSS}${extraCss}</style></head><body>${content}</body></html>`;
}

function sendEmbed(res, html) {
  // Allow embedding anywhere
  res.removeHeader('X-Frame-Options');
  res.setHeader('Content-Security-Policy', "frame-ancestors *");
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.setHeader('cache-control', 'public, max-age=60');
  res.send(html);
}

// ----------------------------------------------------------------------------
// /embed (index)
// ----------------------------------------------------------------------------
function embedIndexPage() {
  return shell('Embeds', 'Copy-paste OpenHeab widgets for your site.',
`<section style="max-width:980px;margin:0 auto;padding:60px 16px">
  <span class="badge b-acc">Embeds</span>
  <h1 style="font:600 40px/1.1 var(--display);letter-spacing:-1px;margin:18px 0">Embeds.</h1>
  <p style="color:var(--dim2);font-size:15px;line-height:1.7;max-width:680px">Drop these into your site. Each is a sized iframe with no auth — they pull live data from public substrate endpoints.</p>
</section>
<section style="max-width:980px;margin:0 auto;padding:24px 16px 60px;display:grid;gap:24px">

  <div class="card">
    <h2 style="font:600 18px var(--display);margin:0 0 8px">Live counter strip</h2>
    <p style="color:var(--dim2);font-size:13px;line-height:1.6;margin-bottom:14px">Tiny 1-line strip with live KPIs. Great for hero or header. ~60px tall.</p>
    <iframe src="/embed/landing-counter" style="width:100%;height:80px;border:1px solid var(--br);border-radius:var(--r-md);background:var(--card)"></iframe>
    <pre style="margin-top:14px;background:var(--card2);border:1px solid var(--br);border-radius:var(--r-md);padding:12px;overflow-x:auto;font-size:12px"><code>&lt;iframe src="https://openheab.com/embed/landing-counter" width="100%" height="80" frameborder="0"&gt;&lt;/iframe&gt;</code></pre>
  </div>

  <div class="card">
    <h2 style="font:600 18px var(--display);margin:0 0 8px">Pulse mini</h2>
    <p style="color:var(--dim2);font-size:13px;line-height:1.6;margin-bottom:14px">4-KPI grid that auto-refreshes every 5s.</p>
    <iframe src="/embed/pulse" style="width:100%;height:180px;border:1px solid var(--br);border-radius:var(--r-md);background:var(--card)"></iframe>
    <pre style="margin-top:14px;background:var(--card2);border:1px solid var(--br);border-radius:var(--r-md);padding:12px;overflow-x:auto;font-size:12px"><code>&lt;iframe src="https://openheab.com/embed/pulse" width="100%" height="180" frameborder="0"&gt;&lt;/iframe&gt;</code></pre>
  </div>

  <div class="card">
    <h2 style="font:600 18px var(--display);margin:0 0 8px">Proof of reserves</h2>
    <p style="color:var(--dim2);font-size:13px;line-height:1.6;margin-bottom:14px">Live reserves vs liabilities + capital adequacy ratio. For transparency pages.</p>
    <iframe src="/embed/proof-of-reserves" style="width:100%;height:200px;border:1px solid var(--br);border-radius:var(--r-md);background:var(--card)"></iframe>
    <pre style="margin-top:14px;background:var(--card2);border:1px solid var(--br);border-radius:var(--r-md);padding:12px;overflow-x:auto;font-size:12px"><code>&lt;iframe src="https://openheab.com/embed/proof-of-reserves" width="100%" height="200" frameborder="0"&gt;&lt;/iframe&gt;</code></pre>
  </div>

  <div class="card">
    <h2 style="font:600 18px var(--display);margin:0 0 8px">Leaderboard</h2>
    <p style="color:var(--dim2);font-size:13px;line-height:1.6;margin-bottom:14px">Top 5 agents by trust score.</p>
    <iframe src="/embed/leaderboard" style="width:100%;height:280px;border:1px solid var(--br);border-radius:var(--r-md);background:var(--card)"></iframe>
    <pre style="margin-top:14px;background:var(--card2);border:1px solid var(--br);border-radius:var(--r-md);padding:12px;overflow-x:auto;font-size:12px"><code>&lt;iframe src="https://openheab.com/embed/leaderboard" width="100%" height="280" frameborder="0"&gt;&lt;/iframe&gt;</code></pre>
  </div>

  <div class="card">
    <h2 style="font:600 18px var(--display);margin:0 0 8px">Single agent badge</h2>
    <p style="color:var(--dim2);font-size:13px;line-height:1.6;margin-bottom:14px">Show off your agent's trust + reputation in your site footer.</p>
    <pre style="background:var(--card2);border:1px solid var(--br);border-radius:var(--r-md);padding:12px;overflow-x:auto;font-size:12px"><code>&lt;iframe src="https://openheab.com/embed/agent/did:op:YOUR_DID" width="100%" height="120" frameborder="0"&gt;&lt;/iframe&gt;</code></pre>
  </div>

  <div class="card">
    <h2 style="font:600 18px var(--display);margin:0 0 8px">Chat bubble</h2>
    <p style="color:var(--dim2);font-size:13px;line-height:1.6;margin-bottom:14px">Floating chat widget for your customer support. Routes to /v1/chat/demo (rate-limited).</p>
    <pre style="background:var(--card2);border:1px solid var(--br);border-radius:var(--r-md);padding:12px;overflow-x:auto;font-size:12px"><code>&lt;iframe src="https://openheab.com/embed/chat" width="380" height="540" frameborder="0" style="position:fixed;bottom:20px;right:20px;z-index:9999"&gt;&lt;/iframe&gt;</code></pre>
  </div>

</section>`);
}

// ----------------------------------------------------------------------------
// /embed/landing-counter
// ----------------------------------------------------------------------------
function landingCounterEmbed() {
  return embedShell('OpenHeab counter',
`<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;padding:8px;font-size:11px">
  <div class="kpi"><div class="label">Agents</div><div class="value" id="k1">–</div></div>
  <div class="kpi"><div class="label">Audit chain</div><div class="value" id="k2">–</div></div>
  <div class="kpi"><div class="label">Transfers 24h</div><div class="value" id="k3">–</div></div>
  <div class="kpi"><div class="label">Inference 24h</div><div class="value" id="k4">–</div></div>
</div>
<script>
async function tick(){
  try {
    var r = await fetch('/v1/pulse/stats');
    var j = await r.json();
    document.getElementById('k1').textContent = (j.agents_total||0).toLocaleString();
    document.getElementById('k2').textContent = (j.audit_chain_length||0).toLocaleString();
    document.getElementById('k3').textContent = (j.transfers_24h||0).toLocaleString();
    document.getElementById('k4').textContent = (j.inference_calls_24h||0).toLocaleString();
  } catch (e) {}
}
tick(); setInterval(tick, 5000);
</script>`);
}

// ----------------------------------------------------------------------------
// /embed/pulse
// ----------------------------------------------------------------------------
function pulseEmbed() {
  return embedShell('OpenHeab pulse',
`<div style="padding:12px">
  <div style="font-size:10px;color:#7a7a7a;text-transform:uppercase;letter-spacing:1.5px;margin-bottom:10px">OpenHeab pulse · <a href="/pulse" target="_blank">view full →</a></div>
  <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:8px">
    <div class="kpi"><div class="label">Agents</div><div class="value" id="k1">–</div></div>
    <div class="kpi"><div class="label">Orgs</div><div class="value" id="k2">–</div></div>
    <div class="kpi"><div class="label">Transfer vol 24h</div><div class="value" id="k3">–</div></div>
    <div class="kpi"><div class="label">Inference 24h</div><div class="value" id="k4">–</div></div>
  </div>
</div>
<script>
function fmt(n){ return Number(n||0).toLocaleString(); }
async function tick(){
  try {
    var r = await fetch('/v1/pulse/stats');
    var j = await r.json();
    document.getElementById('k1').textContent = fmt(j.agents_total);
    document.getElementById('k2').textContent = fmt(j.orgs_total);
    document.getElementById('k3').textContent = '$' + fmt((j.transfer_volume_cents_24h||0)/100);
    document.getElementById('k4').textContent = fmt(j.inference_calls_24h);
  } catch (e) {}
}
tick(); setInterval(tick, 5000);
</script>`);
}

// ----------------------------------------------------------------------------
// /embed/proof-of-reserves
// ----------------------------------------------------------------------------
function porEmbed() {
  return embedShell('Proof of reserves',
`<div style="padding:12px">
  <div style="font-size:10px;color:#7a7a7a;text-transform:uppercase;letter-spacing:1.5px;margin-bottom:10px">OpenHeab — proof of reserves · <a href="/proof-of-reserves" target="_blank">read more →</a></div>
  <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px">
    <div class="kpi"><div class="label">Reserves</div><div class="value" id="rsv">–</div></div>
    <div class="kpi"><div class="label">Liabilities</div><div class="value" id="lia">–</div></div>
    <div class="kpi"><div class="label">Capital ratio</div><div class="value" id="rat" style="color:#22c55e">–</div></div>
  </div>
  <div style="margin-top:10px;font-size:10px;color:#7a7a7a">Last read <span id="ts">–</span></div>
</div>
<script>
async function tick(){
  try {
    var r = await fetch('/v1/bank-core/proof-of-reserves');
    var j = await r.json();
    document.getElementById('rsv').textContent = '$' + ((j.total_reserve_cents||0)/100).toLocaleString();
    document.getElementById('lia').textContent = '$' + ((j.total_liabilities_cents||0)/100).toLocaleString();
    var ratio = j.capital_adequacy_ratio || ((j.total_liabilities_cents||0) ? (j.total_reserve_cents/j.total_liabilities_cents) : 1);
    document.getElementById('rat').textContent = (ratio*100).toFixed(1) + '%';
    document.getElementById('ts').textContent = new Date(j.read_at || Date.now()).toLocaleString();
  } catch (e) {
    document.getElementById('rsv').textContent = 'n/a';
  }
}
tick(); setInterval(tick, 60000);
</script>`);
}

// ----------------------------------------------------------------------------
// /embed/leaderboard
// ----------------------------------------------------------------------------
async function leaderboardEmbed(pool) {
  let rows = [];
  try {
    const r = await pool.query(`SELECT i.did, i.display_name, r.trust_score FROM agent_identities i LEFT JOIN reputation_scores r ON r.agent_did = i.did ORDER BY r.trust_score DESC NULLS LAST LIMIT 5`);
    rows = r.rows;
  } catch {}
  const list = rows.map((r, i) => `<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 4px;border-bottom:1px solid rgba(255,255,255,.08)">
    <div style="display:flex;gap:8px;align-items:baseline"><span style="color:#7a7a7a;font-size:11px;width:18px">${i + 1}</span><a href="/a/${encodeURIComponent(r.did)}" target="_blank" style="font-size:12px">${escapeHtml(r.display_name || r.did.slice(-12))}</a></div>
    <span style="font-size:12px;font-weight:600;color:#7df9ff">${r.trust_score != null ? Number(r.trust_score).toFixed(2) : '—'}</span>
  </div>`).join('');
  return embedShell('Leaderboard',
`<div style="padding:12px">
  <div style="font-size:10px;color:#7a7a7a;text-transform:uppercase;letter-spacing:1.5px;margin-bottom:10px">Top agents · <a href="/leaderboard" target="_blank">all →</a></div>
  ${list || '<div style="padding:32px;text-align:center;color:#7a7a7a;font-size:12px">No agents yet</div>'}
</div>`);
}

// ----------------------------------------------------------------------------
// /embed/agent/:did
// ----------------------------------------------------------------------------
async function agentBadgeEmbed(pool, did) {
  let agent = {}, rep = {};
  try { agent = (await pool.query(`SELECT did, display_name FROM agent_identities WHERE did=$1`, [did])).rows[0] || {}; } catch {}
  try { rep = (await pool.query(`SELECT trust_score, completed_jobs FROM reputation_scores WHERE agent_did=$1`, [did])).rows[0] || {}; } catch {}
  if (!agent.did) {
    return embedShell('Agent', `<div style="padding:24px;text-align:center;color:#7a7a7a;font-size:13px">Agent not found</div>`);
  }
  return embedShell(`Agent ${agent.display_name || did}`,
`<a href="/a/${encodeURIComponent(did)}" target="_blank" style="display:block;padding:12px;text-decoration:none;color:#f0f0f0">
  <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:8px">
    <strong style="font-size:14px">${escapeHtml(agent.display_name || did.slice(-10))}</strong>
    <span style="font-size:10px;color:#7a7a7a">openheab.com</span>
  </div>
  <div style="font-size:11px;color:#7a7a7a;word-break:break-all;margin-bottom:10px">${escapeHtml(did)}</div>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px">
    <div class="kpi"><div class="label">Trust</div><div class="value" style="font-size:14px">${rep.trust_score != null ? Number(rep.trust_score).toFixed(2) : '—'}</div></div>
    <div class="kpi"><div class="label">Jobs</div><div class="value" style="font-size:14px">${rep.completed_jobs || 0}</div></div>
  </div>
</a>`);
}

// ----------------------------------------------------------------------------
// /embed/chat
// ----------------------------------------------------------------------------
function chatEmbed() {
  return embedShell('Chat',
`<div style="display:flex;flex-direction:column;height:100vh">
  <div style="padding:10px 14px;background:rgba(255,255,255,.04);border-bottom:1px solid rgba(255,255,255,.1);display:flex;justify-content:space-between;align-items:center">
    <strong style="font-size:13px">OpenHeab chat</strong>
    <a href="/chat" target="_blank" style="font-size:11px;color:#7a7a7a">open full →</a>
  </div>
  <div id="msgs" style="flex:1;padding:12px;overflow-y:auto;font-size:13px"></div>
  <form id="f" style="display:flex;gap:6px;padding:10px;border-top:1px solid rgba(255,255,255,.1)">
    <input id="i" placeholder="Ask anything…" style="flex:1;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.1);border-radius:6px;padding:8px 10px;color:#f0f0f0;font-size:13px;font-family:inherit">
    <button style="background:#7df9ff;color:#001a1f;border:none;border-radius:6px;padding:8px 14px;font-weight:700;cursor:pointer;font-family:inherit">→</button>
  </form>
</div>
<script>
var hist = [];
function add(role, text) {
  var d = document.createElement('div');
  d.style.cssText = 'margin-bottom:8px;padding:8px;background:' + (role === 'user' ? 'transparent' : 'rgba(255,255,255,.04)') + ';border-radius:6px';
  d.innerHTML = '<div style="font-size:9px;color:#7a7a7a;text-transform:uppercase;margin-bottom:4px">' + role + '</div>' + text.replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'})[c]);
  document.getElementById('msgs').appendChild(d);
  document.getElementById('msgs').scrollTop = 99999;
}
document.getElementById('f').addEventListener('submit', async function(e){
  e.preventDefault();
  var v = document.getElementById('i').value.trim();
  if (!v) return;
  hist.push({ role:'user', content: v });
  add('You', v);
  document.getElementById('i').value = '';
  try {
    var r = await fetch('/v1/chat/demo', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messages: hist, model: 'openheab-base' }) });
    var j = await r.json();
    if (r.ok) { hist.push({ role:'assistant', content: j.message || '' }); add('OpenHeab', j.message || ''); }
    else add('Error', j.error?.message || 'Try again later');
  } catch (e) { add('Error', e.message); }
});
</script>`);
}

function registerEmbedWidgetsRoutes(app, pool) {
  app.get('/embed', (req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.send(embedIndexPage());
  });
  app.get('/embed/landing-counter', (req, res) => sendEmbed(res, landingCounterEmbed()));
  app.get('/embed/pulse', (req, res) => sendEmbed(res, pulseEmbed()));
  app.get('/embed/proof-of-reserves', (req, res) => sendEmbed(res, porEmbed()));
  app.get('/embed/leaderboard', async (req, res) => sendEmbed(res, await leaderboardEmbed(pool)));
  app.get('/embed/agent/:did', async (req, res) => sendEmbed(res, await agentBadgeEmbed(pool, req.params.did)));
  app.get('/embed/chat', (req, res) => sendEmbed(res, chatEmbed()));
}

async function migrate(_pool) {}
module.exports = { migrate, registerEmbedWidgetsRoutes };
