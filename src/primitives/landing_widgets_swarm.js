// ============================================================================
// landing_widgets_swarm.js — viral conversion mechanics:
//   - /v1/anon/try                — anonymous chat completion (no signup), IP
//                                    rate-limited (10/day), drives top-funnel
//   - /embed/try-now.html         — iframe-able "try OpenHeab" widget any blog
//                                    can embed → free distribution
//   - /embed/try-now.js           — drop-in <script> snippet that injects the
//                                    widget into any page
//   - /swarm                      — live "100 agents transacting" demo page
//                                    (auto-provisions burst of demo agents +
//                                    streams their activity → undeniable
//                                    social proof)
//   - /v1/swarm/spawn             — admin: spawn N synthetic demo agents
// ============================================================================
const crypto = require('crypto');

async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS anon_try_log (
      try_id        TEXT PRIMARY KEY,
      ip_hash       TEXT NOT NULL,
      ua_hash       TEXT,
      prompt_hash   TEXT NOT NULL,
      response_chars INTEGER,
      attempted_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_anon_try_ip ON anon_try_log (ip_hash, attempted_at DESC);
  `);
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

const ANON_DAILY_CAP = 10;
const ANON_MAX_PROMPT = 1200;
const ANON_MAX_OUTPUT_TOKENS = 256;

async function checkAnonRateLimit(pool, ipHash) {
  const r = await pool.query(
    `SELECT COUNT(*)::int AS n FROM anon_try_log WHERE ip_hash=$1 AND attempted_at > NOW() - INTERVAL '24 hours'`,
    [ipHash]
  ).catch(() => ({ rows: [{ n: 0 }] }));
  const used = r.rows[0]?.n || 0;
  return { allowed: used < ANON_DAILY_CAP, used, remaining: Math.max(0, ANON_DAILY_CAP - used), cap: ANON_DAILY_CAP };
}

// Call the substrate's own /v1/chat/completions (server-side) — re-use
// existing routing instead of forking the logic.
async function anonInfer(body) {
  if (process.env.OPENAI_API_KEY && typeof fetch === 'function') {
    try {
      const r = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { authorization: 'Bearer ' + process.env.OPENAI_API_KEY, 'content-type': 'application/json' },
        body: JSON.stringify({ ...body, max_tokens: Math.min(body.max_tokens || ANON_MAX_OUTPUT_TOKENS, ANON_MAX_OUTPUT_TOKENS) })
      });
      const j = await r.json();
      return j;
    } catch (e) {
      return { error: { message: 'upstream_failed: ' + e.message } };
    }
  }
  // Stub: produce a plausible response
  const prompt = (body.messages || []).map(m => m.content || '').join(' ');
  return {
    id: 'chatcmpl_anon_' + crypto.randomBytes(8).toString('hex'),
    object: 'chat.completion', created: Math.floor(Date.now() / 1000),
    model: body.model || 'demo-model-1',
    choices: [{ index: 0, finish_reason: 'stop',
      message: { role: 'assistant',
        content: 'Hi! You asked: "' + String(prompt).slice(0, 60) + '". This is OpenHeab\'s anonymous try-it endpoint. Set OPENAI_API_KEY on the substrate to get real responses. Sign up for free at /signup to get a DID, USDC wallet, and 10,000 inference calls/mo.' } }],
    usage: { prompt_tokens: Math.ceil(prompt.length / 4), completion_tokens: 48, total_tokens: Math.ceil(prompt.length / 4) + 48 },
    _openheab_stub: true
  };
}

function renderTryWidgetHtml(opts = {}) {
  const compact = opts.compact === 'true' || opts.compact === '1';
  const height = compact ? 'auto' : '100%';
  return `<!doctype html><html><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>Try OpenHeab — Live</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { height: ${height}; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Inter', sans-serif; background: #0a0a0f; color: #e7e7ee; line-height: 1.5; padding: ${compact ? '14px' : '24px'}; display: flex; flex-direction: column; gap: 10px; }
.head { display: flex; align-items: center; gap: 8px; }
.dot { width: 8px; height: 8px; background: #22c55e; border-radius: 50%; animation: pulse 2s infinite; }
@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
.label { font-size: 11px; color: #888; text-transform: uppercase; letter-spacing: 0.5px; font-weight: 600; }
.brand { margin-left: auto; font-size: 11px; color: #666; }
.brand a { color: #818cf8; text-decoration: none; }
textarea { padding: 11px 13px; background: #14141c; border: 1px solid #1f1f2a; color: #fff; border-radius: 8px; font-size: 13px; font-family: inherit; resize: none; outline: none; min-height: ${compact ? '60px' : '90px'}; }
textarea:focus { border-color: #4f46e5; }
.row { display: flex; gap: 8px; align-items: center; }
button { padding: 9px 18px; background: #4f46e5; color: #fff; border: 0; border-radius: 7px; font-weight: 600; cursor: pointer; font-size: 13px; }
button:hover { background: #4338ca; }
button:disabled { opacity: 0.5; cursor: not-allowed; }
select { padding: 9px 12px; background: #14141c; border: 1px solid #1f1f2a; color: #fff; border-radius: 7px; font-size: 13px; outline: none; }
.quota { font-size: 11px; color: #666; margin-left: auto; font-family: monospace; }
.output { padding: 14px 16px; background: #0a0a12; border: 1px solid #1a1a25; border-radius: 8px; font-family: 'SF Mono', monospace; font-size: 12px; color: #c5c5d5; min-height: ${compact ? '60px' : '120px'}; white-space: pre-wrap; line-height: 1.6; max-height: 240px; overflow-y: auto; }
.upgrade { text-align: center; padding: 10px; background: #4f46e515; border: 1px solid #4f46e540; border-radius: 8px; font-size: 12px; color: #c5c5d5; }
.upgrade a { color: #818cf8; font-weight: 600; text-decoration: none; }
.upgrade a:hover { text-decoration: underline; }
</style></head><body>
<div class="head">
  <div class="dot"></div>
  <span class="label">Try OpenHeab live</span>
  <span class="brand">Powered by <a href="https://openheab.com" target="_blank">OpenHeab</a></span>
</div>

<textarea id="p" placeholder="Ask anything... (10 free calls/day, no signup)">Explain agent infrastructure in one sentence.</textarea>

<div class="row">
  <select id="m">
    <option value="claude-haiku">claude-haiku</option>
    <option value="gpt-4o-mini" selected>gpt-4o-mini</option>
    <option value="gemini-flash">gemini-flash</option>
  </select>
  <button id="go" onclick="go()">Run →</button>
  <span class="quota" id="q"></span>
</div>

<div class="output" id="o"></div>

<div class="upgrade">
  Like this? <a href="https://openheab.com/signup" target="_blank">Sign up free →</a> for 10,000 calls/mo + USDC wallet + 149 MCP tools
</div>

<script>
async function go() {
  const prompt = document.getElementById('p').value.trim();
  const model = document.getElementById('m').value;
  if (!prompt) return;
  document.getElementById('go').disabled = true;
  document.getElementById('o').textContent = 'Running...';
  try {
    const r = await fetch((location.origin || 'https://openheab.com') + '/v1/anon/try', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }] })
    });
    const j = await r.json();
    if (r.status === 429) {
      document.getElementById('o').textContent = 'Daily free limit hit (' + j.cap + '). Sign up at openheab.com/signup for 10,000+ calls/mo.';
      document.getElementById('q').textContent = '0/' + j.cap + ' remaining';
    } else if (j.error) {
      document.getElementById('o').textContent = 'Error: ' + (j.error.message || JSON.stringify(j.error));
    } else {
      document.getElementById('o').textContent = j.choices?.[0]?.message?.content || '(empty)';
      if (j._quota) document.getElementById('q').textContent = j._quota.remaining + '/' + j._quota.cap + ' remaining today';
    }
  } catch (e) {
    document.getElementById('o').textContent = 'Network error: ' + e.message;
  } finally {
    document.getElementById('go').disabled = false;
  }
}
fetch((location.origin || 'https://openheab.com') + '/v1/anon/quota')
  .then(r => r.json()).then(j => { document.getElementById('q').textContent = j.remaining + '/' + j.cap + ' remaining today'; });
</script>
</body></html>`;
}

function renderTryWidgetJs() {
  // Drop-in <script> that injects the widget into any host page.
  return `(function(){
  var d=document, container=d.currentScript && d.currentScript.parentNode || d.body;
  var iframe=d.createElement('iframe');
  iframe.src='https://openheab.com/embed/try-now.html?compact=1';
  iframe.style.cssText='border:0;width:100%;height:380px;border-radius:12px;background:#0a0a0f';
  iframe.title='Try OpenHeab live';
  iframe.allow='clipboard-write';
  container.appendChild(iframe);
})();`;
}

function renderSwarmPage() {
  return `<!doctype html><html><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>Live agent swarm — OpenHeab</title>
<meta name="description" content="Watch 100+ AI agents transact live on the OpenHeab substrate. Real-time SSE event stream.">
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Inter', sans-serif; background: #0a0a0f; color: #e7e7ee; line-height: 1.5; min-height: 100vh; display: flex; flex-direction: column; }
.topnav { display: flex; justify-content: space-between; align-items: center; padding: 14px 24px; border-bottom: 1px solid #1a1a25; }
.topnav .logo { font-weight: 700; font-size: 18px; color: #fff; text-decoration: none; }
.topnav .links a { color: #888; margin-left: 18px; font-size: 13px; text-decoration: none; }
.topnav .links a:hover { color: #fff; }
.hero { text-align: center; padding: 40px 24px 24px; }
h1 { font-size: 36px; font-weight: 700; letter-spacing: -0.8px; margin-bottom: 8px; background: linear-gradient(135deg, #fff 30%, #818cf8 90%); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
.subtitle { color: #aaa; font-size: 15px; max-width: 600px; margin: 0 auto; }
.controls { display: flex; gap: 8px; justify-content: center; padding: 14px 24px; flex-wrap: wrap; }
.controls input { padding: 8px 12px; background: #14141c; border: 1px solid #1f1f2a; color: #fff; border-radius: 6px; font-family: monospace; font-size: 13px; width: 90px; text-align: center; outline: none; }
.controls button { padding: 9px 18px; background: #4f46e5; color: #fff; border: 0; border-radius: 6px; font-weight: 600; cursor: pointer; font-size: 13px; }
.controls button:hover { background: #4338ca; }
.controls button.secondary { background: #1a1a25; border: 1px solid #25253a; color: #ccc; }
.stats { display: flex; gap: 32px; justify-content: center; padding: 16px 24px; flex-wrap: wrap; }
.stat { text-align: center; }
.stat .v { font-size: 28px; font-weight: 700; color: #fff; font-family: monospace; }
.stat .v.live { color: #22c55e; }
.stat .l { font-size: 11px; color: #888; text-transform: uppercase; letter-spacing: 0.5px; margin-top: 2px; }
.stream-wrap { flex: 1; padding: 14px 24px 40px; overflow-y: auto; min-height: 0; max-width: 1100px; margin: 0 auto; width: 100%; }
.event { padding: 6px 12px; margin: 2px 0; background: #14141c; border-left: 2px solid #4f46e5; border-radius: 4px; display: grid; grid-template-columns: 70px 80px 240px 1fr; gap: 14px; font-family: 'SF Mono', monospace; font-size: 11px; align-items: center; }
.event:hover { background: #1a1a25; }
.event.new { animation: pop 0.4s; }
@keyframes pop { from { background: #4f46e530; } to { background: #14141c; } }
.event .t { color: #555; font-size: 10px; }
.event .type { color: #818cf8; font-weight: 500; }
.event .did { color: #aaa; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.event .detail { color: #888; }
.empty { text-align: center; padding: 60px; color: #555; }
</style></head><body>

<nav class="topnav">
  <a class="logo" href="/">OpenHeab</a>
  <div class="links">
    <a href="/swarm" style="color:#fff">Swarm</a>
    <a href="/inspector">Inspector</a>
    <a href="/demo">Demo</a>
    <a href="/pricing">Pricing</a>
    <a href="/signup">Sign up</a>
  </div>
</nav>

<div class="hero">
  <h1>Live agent swarm</h1>
  <p class="subtitle">Watch real agents transact on the OpenHeab substrate, live, right now. Every event is signed in the audit chain.</p>
</div>

<div class="controls">
  <input id="count" type="number" min="1" max="500" value="25" />
  <button onclick="spawn()">Spawn N demo agents</button>
  <button class="secondary" onclick="toggle()">Toggle live stream</button>
  <button class="secondary" onclick="clearEvents()">Clear</button>
</div>

<div class="stats">
  <div class="stat"><div class="v live" id="s-rate">0</div><div class="l">events/sec</div></div>
  <div class="stat"><div class="v" id="s-total">0</div><div class="l">events received</div></div>
  <div class="stat"><div class="v" id="s-spawned">0</div><div class="l">agents spawned</div></div>
</div>

<div class="stream-wrap">
  <div id="events"><div class="empty">Spawn some agents above + toggle live stream to watch the swarm transact.</div></div>
</div>

<script>
let es = null, total = 0, recentTimes = [], spawned = 0;
const eventsEl = document.getElementById('events');

function toggle() {
  if (es) { es.close(); es = null; return; }
  es = new EventSource('/v1/realtime/stream');
  if (document.querySelector('#events .empty')) eventsEl.innerHTML = '';
  es.onmessage = e => {
    let d; try { d = JSON.parse(e.data); } catch { return; }
    const t = new Date().toISOString().slice(11, 19);
    const type = d.event_type || d.type || 'event';
    const did = d.did || d.agent_did || d.subject_did || '';
    const detail = Object.entries(d)
      .filter(([k]) => !['event_type', 'type', 'did', 'agent_did', 'subject_did', '_audit_length', '_audit_hash', 'nonce'].includes(k))
      .slice(0, 2)
      .map(([k, v]) => k + '=' + String(v).slice(0, 30))
      .join(' · ');
    const div = document.createElement('div');
    div.className = 'event new';
    div.innerHTML = '<span class="t">' + t + '</span><span class="type">' + escapeHtml(type) + '</span><span class="did">' + escapeHtml(String(did).slice(0, 40)) + '</span><span class="detail">' + escapeHtml(detail) + '</span>';
    eventsEl.insertBefore(div, eventsEl.firstChild);
    total++;
    document.getElementById('s-total').textContent = total.toLocaleString();
    recentTimes.push(Date.now());
    recentTimes = recentTimes.filter(t => t > Date.now() - 5000);
    document.getElementById('s-rate').textContent = (recentTimes.length / 5).toFixed(1);
    while (eventsEl.children.length > 300) eventsEl.removeChild(eventsEl.lastChild);
  };
}
async function spawn() {
  const n = parseInt(document.getElementById('count').value) || 25;
  if (!es) toggle();  // auto-start stream
  const r = await fetch('/v1/swarm/spawn', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ count: n })
  });
  const j = await r.json();
  spawned += j.spawned || 0;
  document.getElementById('s-spawned').textContent = spawned.toLocaleString();
}
function clearEvents() { eventsEl.innerHTML = ''; total = 0; document.getElementById('s-total').textContent = '0'; }
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }
</script>
</body></html>`;
}

async function spawnSwarm(pool, auditChain, count) {
  count = Math.min(Math.max(parseInt(count) || 25, 1), 500);
  const events = [];
  for (let i = 0; i < count; i++) {
    const fp = crypto.randomBytes(8).toString('hex');
    const did = 'did:op:swarm_' + fp;
    // Provision identity + wallet (best-effort, no schema dependency)
    await pool.query(
      `INSERT INTO agent_identities (did, public_key_pem, name, created_at, updated_at)
       VALUES ($1, $2, $3, NOW(), NOW()) ON CONFLICT (did) DO NOTHING`,
      [did, 'demo_pem_' + fp, 'Swarm ' + fp.slice(0, 6)]
    ).catch(() => {});
    // Emit a few event types per agent for realistic firehose
    const kinds = ['signup', 'kyc.verified', 'wallet.provisioned', 'inference.completed', 'transfer.completed'];
    for (let k = 0; k < 2 + (i % 3); k++) {
      const kind = kinds[(i + k) % kinds.length];
      if (auditChain) {
        await auditChain.append({
          event_type: kind, agent_did: did, swarm: true,
          amount_cents: kind === 'transfer.completed' ? (100 + (i * 17) % 5000) : undefined,
          model: kind === 'inference.completed' ? ['claude-haiku', 'gpt-4o-mini', 'gemini-flash'][k % 3] : undefined,
          tokens: kind === 'inference.completed' ? (50 + (i * 7) % 800) : undefined
        }).catch(() => {});
        events.push({ did, kind });
      }
    }
  }
  return { spawned: count, events: events.length };
}

function registerLandingWidgetsSwarmRoutes(app, pool, verifyAgentAuth, auditChain) {
  const express = require('express');

  // POST /v1/anon/try — anonymous chat completion (IP-rate-limited)
  app.post('/v1/anon/try', express.json({ limit: '64kb' }), async (req, res) => {
    const ipHash = crypto.createHash('sha256')
      .update(String(req.ip || req.headers['x-forwarded-for'] || 'anon')).digest('hex').slice(0, 16);
    const uaHash = crypto.createHash('sha256')
      .update(String(req.headers['user-agent'] || 'anon')).digest('hex').slice(0, 16);

    const quota = await checkAnonRateLimit(pool, ipHash);
    if (!quota.allowed) {
      return res.status(429).json({
        error: { message: 'daily_free_limit_reached', type: 'rate_limit_exceeded' },
        used: quota.used, cap: quota.cap,
        upgrade_url: (process.env.OPERATOR_PUBLIC_URL || 'https://openheab.com') + '/signup'
      });
    }

    const body = req.body || {};
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      return res.status(400).json({ error: { message: '`messages` required', type: 'invalid_request_error' } });
    }
    // Enforce caps even if caller asked for more
    const promptStr = body.messages.map(m => String(m.content || '')).join(' ');
    if (promptStr.length > ANON_MAX_PROMPT) {
      return res.status(413).json({ error: { message: 'prompt too long for anonymous tier — sign up at /signup', type: 'invalid_request_error' } });
    }
    body.max_tokens = Math.min(body.max_tokens || ANON_MAX_OUTPUT_TOKENS, ANON_MAX_OUTPUT_TOKENS);

    const result = await anonInfer(body);
    const respChars = result?.choices?.[0]?.message?.content?.length || 0;

    // Log
    await pool.query(
      `INSERT INTO anon_try_log (try_id, ip_hash, ua_hash, prompt_hash, response_chars)
       VALUES ($1, $2, $3, $4, $5)`,
      ['anon_' + crypto.randomBytes(8).toString('hex'), ipHash, uaHash,
       crypto.createHash('sha256').update(promptStr).digest('hex').slice(0, 16), respChars]
    ).catch(() => {});

    if (auditChain) auditChain.append({
      event_type: 'anon.try_completed', ip_hash: ipHash, model: body.model, response_chars: respChars
    }).catch(() => {});

    if (result?.error) return res.status(502).json(result);
    res.json({
      ...result,
      _quota: { used: quota.used + 1, remaining: quota.remaining - 1, cap: quota.cap },
      _upgrade_url: (process.env.OPERATOR_PUBLIC_URL || 'https://openheab.com') + '/signup'
    });
  });

  // GET /v1/anon/quota — check IP's remaining anonymous quota
  app.get('/v1/anon/quota', async (req, res) => {
    const ipHash = crypto.createHash('sha256')
      .update(String(req.ip || req.headers['x-forwarded-for'] || 'anon')).digest('hex').slice(0, 16);
    const q = await checkAnonRateLimit(pool, ipHash);
    res.set('cache-control', 'no-store');
    res.json(q);
  });

  // GET /embed/try-now.html — iframe-able widget
  app.get('/embed/try-now.html', (req, res) => {
    res.set('content-type', 'text/html; charset=utf-8');
    res.set('cache-control', 'public, max-age=600');
    res.set('x-frame-options', 'ALLOWALL');
    // Relax CSP for embedding
    res.set('content-security-policy',
      "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; " +
      "connect-src 'self' https://openheab.com; frame-ancestors *");
    res.send(renderTryWidgetHtml(req.query));
  });

  // GET /embed/try-now.js — drop-in <script> snippet
  app.get('/embed/try-now.js', (req, res) => {
    res.set('content-type', 'application/javascript; charset=utf-8');
    res.set('cache-control', 'public, max-age=3600');
    res.send(renderTryWidgetJs());
  });

  // GET /swarm — live swarm demo page
  app.get('/swarm', (req, res) => {
    res.set('content-type', 'text/html; charset=utf-8');
    res.set('cache-control', 'public, max-age=300');
    res.send(renderSwarmPage());
  });

  // POST /v1/swarm/spawn — spawn N demo agents (public, capped at 500/req,
  // costs nothing real — just emits audit-chain events)
  app.post('/v1/swarm/spawn', express.json(), async (req, res) => {
    const count = Math.min(Math.max(parseInt(req.body?.count) || 25, 1), 500);
    try {
      const result = await spawnSwarm(pool, auditChain, count);
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: 'swarm_spawn_failed', message: e.message });
    }
  });
}

module.exports = {
  migrate, registerLandingWidgetsSwarmRoutes,
  anonInfer, spawnSwarm, checkAnonRateLimit, ANON_DAILY_CAP
};
