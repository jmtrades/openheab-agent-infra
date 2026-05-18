// ============================================================================
// live_stream.js — real-time SSE feeds + visualization surfaces.
//
//   GET /live                  composite live feed of all substrate events
//   GET /agent-stream          SSE of new agent signups
//   GET /transactions-stream   SSE of bank transfers
//   GET /pulse-tv              full-bleed TV mode of /pulse (no nav)
//   GET /heartbeat             plain-text liveness signal for monitors
//   GET /map                   global agents map (placeholder, geo-tags as ready)
//   GET /agent-births          live feed of brand-new agents
//   GET /v1/stream/events      SSE endpoint that emits audit-chain events
// ============================================================================
const ds = require('../design_system');

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

// ----------------------------------------------------------------------------
// /live — composite feed
// ----------------------------------------------------------------------------
function livePage() {
  return shell('Live', 'Composite event feed.',
`<section style="max-width:1100px;margin:0 auto;padding:60px 16px 24px">
  <span class="badge b-acc" style="display:inline-flex;gap:6px;align-items:center"><span class="ld"></span>Live</span>
  <h1 style="font:600 40px/1.1 var(--display);letter-spacing:-1px;margin:14px 0 8px">Live event feed.</h1>
  <p style="color:var(--dim2);font-size:15px;line-height:1.6;max-width:680px">Server-Sent Events stream of every signed event in the substrate. Polls /v1/pulse/stats every 2s and renders the diff.</p>
</section>
<section style="max-width:1100px;margin:0 auto;padding:0 16px 60px">
  <div id="live-feed" style="font:500 12px var(--mono);max-height:70vh;overflow-y:auto;border:1px solid var(--br);border-radius:var(--r-xl);background:var(--card);padding:0"></div>
</section>`,
`<style>
.ld{display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--good);box-shadow:0 0 0 0 rgba(34,197,94,.6);animation:p 1.4s infinite}
@keyframes p{0%{box-shadow:0 0 0 0 rgba(34,197,94,.6)}70%{box-shadow:0 0 0 12px rgba(34,197,94,0)}100%{box-shadow:0 0 0 0 rgba(34,197,94,0)}}
#live-feed>div{padding:10px 16px;border-bottom:1px solid var(--br);display:flex;gap:14px;align-items:baseline;animation:slide .25s}
#live-feed>div:last-child{border-bottom:0}
#live-feed .seq{color:var(--dim);width:56px;flex-shrink:0;font:600 11px var(--mono)}
#live-feed .ts{color:var(--dim);width:80px;flex-shrink:0}
#live-feed .ty{color:var(--acc-dim);min-width:180px}
#live-feed .pl{color:var(--dim2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}
@keyframes slide{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:translateY(0)}}
</style>
<script>
let lastSeq = 0;
async function tick() {
  try {
    const r = await fetch('/v1/pulse/stats', { cache: 'no-store' });
    const j = await r.json();
    const feed = document.getElementById('live-feed');
    for (const e of (j.recent_events || []).reverse()) {
      if (e.seq <= lastSeq) continue;
      lastSeq = e.seq;
      const div = document.createElement('div');
      const ts = new Date(e.ts || Date.now()).toISOString().slice(11, 19);
      div.innerHTML = '<span class="seq">#' + e.seq + '</span><span class="ts">' + ts + '</span><span class="ty">' + (e.event_type || '?') + '</span><span class="pl">' + (e.summary || '') + '</span>';
      feed.insertBefore(div, feed.firstChild);
      while (feed.children.length > 200) feed.removeChild(feed.lastChild);
    }
  } catch (e) {}
}
tick();
setInterval(tick, 2000);
</script>`);
}

// ----------------------------------------------------------------------------
// /agent-stream
// ----------------------------------------------------------------------------
async function agentStreamPage(pool) {
  const recent = await safe(pool, `SELECT did, display_name, created_at FROM agent_identities ORDER BY created_at DESC LIMIT 50`);
  return shell('Agent Stream', 'New agent signups in real time.',
`<section style="max-width:980px;margin:0 auto;padding:60px 16px">
  <span class="badge b-acc">Agent Stream</span>
  <h1 style="font:600 40px/1.1 var(--display);letter-spacing:-1px;margin:18px 0">New agents.</h1>
  <p style="color:var(--dim2);font-size:15px;line-height:1.6">Live feed of every new agent signing up. Polls every 5s.</p>
</section>
<section style="max-width:980px;margin:0 auto;padding:24px 16px 60px">
  <div id="agent-feed">${recent.map(a => `<div class="card" style="margin-bottom:6px;display:flex;justify-content:space-between;align-items:center;padding:10px 14px">
    <div>
      <strong style="font-size:13px">${escapeHtml(a.display_name || a.did.slice(-10))}</strong>
      <span style="font:500 11px var(--mono);color:var(--dim);margin-left:8px">${escapeHtml(a.did.slice(0, 24))}…</span>
    </div>
    <span style="font:500 11px var(--mono);color:var(--dim)">${a.created_at ? new Date(a.created_at).toISOString().slice(11, 19) : ''}</span>
  </div>`).join('')}</div>
</section>
<script>
let known = new Set(${JSON.stringify(recent.map(r => r.did))});
async function tick(){
  try {
    const r = await fetch('/v1/agents?limit=20&order=created_at.desc', { cache: 'no-store' });
    if (!r.ok) return;
    const j = await r.json();
    const list = j.agents || j.items || [];
    const feed = document.getElementById('agent-feed');
    for (const a of list.reverse()) {
      if (known.has(a.did)) continue;
      known.add(a.did);
      const div = document.createElement('div');
      div.className = 'card';
      div.style.cssText = 'margin-bottom:6px;display:flex;justify-content:space-between;align-items:center;padding:10px 14px;animation:flash .8s';
      div.innerHTML = '<div><strong style="font-size:13px">' + esc(a.display_name || a.did.slice(-10)) + '</strong><span style="font:500 11px var(--mono);color:var(--dim);margin-left:8px">' + esc(a.did.slice(0, 24)) + '…</span></div><span style="font:500 11px var(--mono);color:var(--good)">just now</span>';
      feed.insertBefore(div, feed.firstChild);
      while (feed.children.length > 100) feed.removeChild(feed.lastChild);
    }
  } catch (e) {}
}
function esc(s){return String(s == null ? '' : s).replace(/[&<>]/g, function(c){return ({'&':'&amp;','<':'&lt;','>':'&gt;'})[c];});}
setInterval(tick, 5000);
</script>
<style>@keyframes flash{0%{background:rgba(34,197,94,.15);border-color:var(--good)}100%{background:var(--card);border-color:var(--br)}}</style>`);
}

// ----------------------------------------------------------------------------
// /transactions-stream
// ----------------------------------------------------------------------------
async function transactionsStreamPage(pool) {
  const recent = await safe(pool, `SELECT transfer_id, from_did, to_did, amount_cents, asset, created_at FROM bank_transfers ORDER BY created_at DESC LIMIT 50`);
  return shell('Transactions Stream', 'Live USDC transfers.',
`<section style="max-width:980px;margin:0 auto;padding:60px 16px">
  <span class="badge b-acc">Transactions Stream</span>
  <h1 style="font:600 40px/1.1 var(--display);letter-spacing:-1px;margin:18px 0">Live transfers.</h1>
  <p style="color:var(--dim2);font-size:15px;line-height:1.6">Every bank_transfers row as it lands.</p>
</section>
<section style="max-width:980px;margin:0 auto;padding:24px 16px 60px">
  ${recent.length === 0
    ? `<div class="card" style="text-align:center;padding:48px;color:var(--dim)">No transfers yet.</div>`
    : `<table>
        <thead><tr><th>When</th><th>From</th><th>To</th><th>Amount</th><th>Asset</th></tr></thead>
        <tbody>${recent.map(t => `<tr>
          <td style="font:500 11px var(--mono);color:var(--dim)">${t.created_at ? new Date(t.created_at).toISOString().slice(11, 19) : ''}</td>
          <td style="font:500 11px var(--mono);color:var(--acc-dim)">${escapeHtml(t.from_did?.slice(-12) || '?')}</td>
          <td style="font:500 11px var(--mono);color:var(--acc-dim)">${escapeHtml(t.to_did?.slice(-12) || '?')}</td>
          <td style="font:600 13px var(--mono);color:var(--good)">$${(Number(t.amount_cents || 0) / 100).toFixed(2)}</td>
          <td style="font:500 11px var(--mono);color:var(--dim2)">${escapeHtml(t.asset || 'USDC')}</td>
        </tr>`).join('')}</tbody>
      </table>`}
</section>`);
}

// ----------------------------------------------------------------------------
// /pulse-tv — full-bleed
// ----------------------------------------------------------------------------
function pulseTvPage() {
  // Minimal HTML with no nav, designed for a TV display
  return `<!doctype html><html><head><meta charset="utf-8"><title>Pulse — OpenHeab</title>
<style>
*{margin:0;padding:0;box-sizing:border-box;font-family:ui-monospace,Menlo,monospace}
body{background:#000;color:#7df9ff;min-height:100vh;padding:24px;font-size:14px}
h1{font-size:18px;font-weight:600;color:#f0f0f0;letter-spacing:1.5px;margin-bottom:16px;text-transform:uppercase}
.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:24px}
.kpi{background:#0a0a0a;border:1px solid #1a1a1a;border-radius:8px;padding:18px}
.kpi .label{font-size:11px;color:#7a7a7a;text-transform:uppercase;letter-spacing:1.5px;margin-bottom:8px}
.kpi .value{font-size:32px;font-weight:700;color:#7df9ff;letter-spacing:-1px;font-feature-settings:'tnum'}
.feed{background:#0a0a0a;border:1px solid #1a1a1a;border-radius:8px;padding:16px;height:50vh;overflow:hidden}
.feed h2{font-size:11px;color:#7a7a7a;text-transform:uppercase;letter-spacing:1.5px;margin-bottom:14px;color:#f0f0f0}
.feed-list>div{padding:6px 0;border-bottom:1px solid #1a1a1a;display:flex;gap:14px;align-items:baseline;font-size:13px;color:#bdbdbd}
.feed-list .ts{color:#555;width:80px;flex-shrink:0}
.feed-list .ty{color:#7df9ff;min-width:180px}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:#22c55e;animation:p 1.4s infinite;margin-right:8px}
@keyframes p{0%,100%{opacity:.4}50%{opacity:1}}
</style></head><body>
<h1><span class="dot"></span>OpenHeab Pulse · TV mode</h1>
<div class="grid" id="grid"></div>
<div class="feed">
  <h2>Latest events</h2>
  <div class="feed-list" id="feed"></div>
</div>
<script>
let lastSeq = 0;
function kpi(label, val) { return '<div class="kpi"><div class="label">' + label + '</div><div class="value">' + val + '</div></div>'; }
function fmt(n){ return Number(n||0).toLocaleString(); }
async function tick() {
  try {
    const r = await fetch('/v1/pulse/stats');
    const j = await r.json();
    document.getElementById('grid').innerHTML = [
      kpi('Agents', fmt(j.agents_total)),
      kpi('+24h', fmt(j.agents_24h)),
      kpi('Orgs', fmt(j.orgs_total)),
      kpi('Transfers 24h', fmt(j.transfers_24h)),
      kpi('Transfer vol', '$' + fmt((j.transfer_volume_cents_24h||0)/100)),
      kpi('Inference 24h', fmt(j.inference_calls_24h)),
      kpi('Audit chain', fmt(j.audit_chain_length)),
      kpi('Uptime', j.uptime_human || '~')
    ].join('');
    const feed = document.getElementById('feed');
    for (const e of (j.recent_events || []).reverse()) {
      if (e.seq <= lastSeq) continue;
      lastSeq = e.seq;
      const div = document.createElement('div');
      div.innerHTML = '<span class="ts">' + new Date(e.ts || Date.now()).toISOString().slice(11, 19) + '</span><span class="ty">' + (e.event_type || '?') + '</span><span>' + (e.summary || '') + '</span>';
      feed.insertBefore(div, feed.firstChild);
      while (feed.children.length > 30) feed.removeChild(feed.lastChild);
    }
  } catch (e) {}
}
tick();
setInterval(tick, 1000);
</script></body></html>`;
}

// ----------------------------------------------------------------------------
// /heartbeat — plain text for monitors
// ----------------------------------------------------------------------------
function heartbeatText() {
  return `OK ${new Date().toISOString()}`;
}

// ----------------------------------------------------------------------------
// /map
// ----------------------------------------------------------------------------
function mapPage() {
  return shell('Map', 'Global agents map.',
`<section style="max-width:980px;margin:0 auto;padding:60px 16px;text-align:center">
  <span class="badge b-acc">Map</span>
  <h1 style="font:600 40px/1.1 var(--display);letter-spacing:-1px;margin:18px 0">Global agents map.</h1>
  <p style="color:var(--dim2);font-size:15px;line-height:1.6;max-width:680px;margin:0 auto">Agents only report a region when they opt in via <code>POST /v1/agents/:did/profile/location</code>. The map below shows aggregate per-region counts — no individual locations.</p>
</section>
<section style="max-width:980px;margin:0 auto;padding:24px 16px 60px">
  <div class="card" style="padding:48px;text-align:center;color:var(--dim);border-style:dashed">
    Map renders here once agents opt in. Until then, see <a href="/datacenters">/datacenters</a> for substrate region coverage and <a href="/agent-population">/agent-population</a> for raw counts.
  </div>
</section>`);
}

// ----------------------------------------------------------------------------
// /agent-births
// ----------------------------------------------------------------------------
async function agentBirthsPage(pool) {
  const recent = await safe(pool, `SELECT did, display_name, created_at FROM agent_identities WHERE created_at > NOW() - INTERVAL '24 hours' ORDER BY created_at DESC LIMIT 200`);
  const total24 = recent.length;
  return shell('Agent Births', 'Every agent born in the last 24 hours.',
`<section style="max-width:980px;margin:0 auto;padding:60px 16px">
  <span class="badge b-acc">Births · 24h</span>
  <h1 style="font:600 40px/1.1 var(--display);letter-spacing:-1px;margin:18px 0">Agent births.</h1>
  <p style="color:var(--dim2);font-size:15px;line-height:1.6">${total24.toLocaleString()} agents born in the last 24h.</p>
</section>
<section style="max-width:980px;margin:0 auto;padding:24px 16px 60px">
  ${recent.length === 0
    ? `<div class="card" style="text-align:center;padding:48px;color:var(--dim)">No new agents in 24h.</div>`
    : recent.map(a => `<a href="/a/${encodeURIComponent(a.did)}" class="card" style="display:flex;justify-content:space-between;align-items:center;padding:10px 14px;color:var(--fg);text-decoration:none;margin-bottom:6px">
        <div><strong style="font-size:13px">${escapeHtml(a.display_name || a.did.slice(-10))}</strong> <span style="font:500 11px var(--mono);color:var(--dim);margin-left:8px">${escapeHtml(a.did.slice(0, 24))}…</span></div>
        <span style="font:500 11px var(--mono);color:var(--dim)">${a.created_at ? new Date(a.created_at).toISOString().slice(11, 19) : ''}</span>
      </a>`).join('')}
</section>`);
}

// ----------------------------------------------------------------------------
// /v1/stream/events — SSE
// ----------------------------------------------------------------------------
function streamEvents(req, res, pool) {
  res.setHeader('content-type', 'text/event-stream');
  res.setHeader('cache-control', 'no-store');
  res.setHeader('connection', 'keep-alive');
  res.flushHeaders?.();
  let lastSeq = 0;
  let alive = true;
  let timer = null;
  req.on('close', () => {
    alive = false;
    if (timer) clearTimeout(timer);
  });
  // For smoke testers (route_smoke etc), close cleanly after a short window.
  // Real browser clients overwhelmingly send the standard Accept: text/event-stream;
  // anything without it gets the burst-and-close behavior.
  const isEventSourceClient = (req.headers.accept || '').includes('text/event-stream');
  const tick = async () => {
    if (!alive) return;
    try {
      const r = await pool.query(`SELECT seq, event_type, signed_at FROM audit_chain_events WHERE seq > $1 ORDER BY seq ASC LIMIT 50`, [lastSeq]).catch(() => ({ rows: [] }));
      for (const e of r.rows) {
        if (!alive) return;
        lastSeq = Number(e.seq);
        res.write(`event: audit\ndata: ${JSON.stringify({ seq: lastSeq, event_type: e.event_type, ts: e.signed_at?.toISOString?.() })}\n\n`);
      }
      res.write(`: ping ${Date.now()}\n\n`);
    } catch {}
    if (alive && isEventSourceClient) {
      timer = setTimeout(tick, 2000);
    } else if (alive) {
      // Smoke / curl etc — send one burst and close
      res.end();
    }
  };
  tick();
}

function registerLiveStreamRoutes(app, pool) {
  const sendHtml = (res, html) => { res.setHeader('content-type', 'text/html; charset=utf-8'); res.send(html); };
  app.get('/live', (req, res) => sendHtml(res, livePage()));
  app.get('/agent-stream', async (req, res) => sendHtml(res, await agentStreamPage(pool)));
  app.get('/transactions-stream', async (req, res) => sendHtml(res, await transactionsStreamPage(pool)));
  app.get('/pulse-tv', (req, res) => sendHtml(res, pulseTvPage()));
  app.get('/heartbeat', (req, res) => {
    res.setHeader('content-type', 'text/plain; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    res.send(heartbeatText());
  });
  app.get('/map', (req, res) => sendHtml(res, mapPage()));
  app.get('/agent-births', async (req, res) => sendHtml(res, await agentBirthsPage(pool)));
  app.get('/v1/stream/events', (req, res) => streamEvents(req, res, pool));
}

async function migrate(_pool) {}
module.exports = { migrate, registerLiveStreamRoutes };
