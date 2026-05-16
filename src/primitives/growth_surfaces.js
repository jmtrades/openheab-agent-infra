// ============================================================================
// growth_surfaces.js — three more conversion/expansion surfaces:
//   - /referrals      — public referral program page + tracking
//   - /compare-models — pick 2 models, same prompt → side-by-side results
//   - /v1/charts/...  — inline-SVG chart widgets (sparkline, bar, donut) for
//                        embedding into /dashboard, /admin, /launch without
//                        pulling in a chart library
// ============================================================================
const crypto = require('crypto');

async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS referral_links (
      ref_code      TEXT PRIMARY KEY,
      referrer_did  TEXT NOT NULL,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      clicks        INTEGER NOT NULL DEFAULT 0,
      signups       INTEGER NOT NULL DEFAULT 0,
      paid_signups  INTEGER NOT NULL DEFAULT 0,
      total_credit_cents BIGINT NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_referral_links_referrer ON referral_links (referrer_did);

    CREATE TABLE IF NOT EXISTS referral_events (
      event_id      TEXT PRIMARY KEY,
      ref_code      TEXT NOT NULL,
      event_kind    TEXT NOT NULL,
      visitor_hash  TEXT,
      converted_did TEXT,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_referral_events_code ON referral_events (ref_code, created_at DESC);
  `);
}

async function resolveAgent(pool, req) {
  try { return await require('./me_endpoints').resolveAgentFromRequest(pool, req); }
  catch { return null; }
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

function newRefCode() {
  // Short, URL-safe, no ambiguous chars (no 0/O/1/l)
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let code = '';
  const bytes = crypto.randomBytes(8);
  for (let i = 0; i < 8; i++) code += alphabet[bytes[i] % alphabet.length];
  return code;
}

function renderReferralsPage() {
  return `<!doctype html><html><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>Referrals — OpenHeab</title>
<meta name="description" content="Refer agents to OpenHeab and earn 25% of their first year's subscription. Paid in USDC.">
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Inter', sans-serif; background: #0a0a0f; color: #e7e7ee; line-height: 1.6; }
.wrap { max-width: 760px; margin: 0 auto; padding: 48px 24px 80px; }
.nav { display: flex; justify-content: space-between; align-items: center; margin-bottom: 40px; }
.nav .logo { font-weight: 700; font-size: 18px; color: #fff; text-decoration: none; }
.nav .links a { color: #888; margin-left: 20px; font-size: 14px; text-decoration: none; }
.nav .links a:hover { color: #fff; }
.hero { text-align: center; padding: 40px 0; }
h1 { font-size: 44px; font-weight: 700; letter-spacing: -1.2px; margin-bottom: 12px; background: linear-gradient(135deg, #fff 30%, #818cf8 90%); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
.subtitle { color: #aaa; font-size: 18px; max-width: 560px; margin: 0 auto 28px; }
.payouts { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; margin: 28px 0; }
.payout { background: #14141c; border: 1px solid #1f1f2a; padding: 18px 16px; border-radius: 10px; text-align: center; }
.payout .pct { font-size: 28px; font-weight: 700; color: #22c55e; }
.payout .l { font-size: 11px; color: #888; text-transform: uppercase; letter-spacing: 0.5px; margin-top: 4px; }
.gen-form { background: #14141c; border: 1px solid #1f1f2a; padding: 28px; border-radius: 14px; margin: 32px 0; }
.gen-form label { display: block; font-size: 11px; color: #888; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 6px; font-weight: 600; }
.gen-form input { width: 100%; padding: 12px 14px; background: #0f0f17; border: 1px solid #1f1f2a; color: #fff; border-radius: 8px; font-family: monospace; font-size: 14px; outline: none; }
.gen-form input:focus { border-color: #4f46e5; }
.gen-form button { width: 100%; padding: 12px; background: #4f46e5; color: #fff; border: 0; border-radius: 8px; font-weight: 600; cursor: pointer; font-size: 14px; margin-top: 14px; }
.gen-form button:hover { background: #4338ca; }
.result { background: #181822; border: 1px solid #2a2a36; padding: 20px; border-radius: 10px; margin-top: 18px; display: none; }
.result.show { display: block; }
.result .label { font-size: 11px; color: #888; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 6px; font-weight: 600; }
.result .code { display: flex; gap: 8px; align-items: center; }
.result .code input { flex: 1; background: #0a0a12; padding: 10px 14px; border: 1px solid #20202a; color: #fff; border-radius: 6px; font-family: monospace; font-size: 14px; outline: none; }
.result .code button { padding: 10px 16px; background: #1a1a25; border: 1px solid #25253a; color: #ccc; border-radius: 6px; cursor: pointer; font-size: 12px; }
.result .stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-top: 14px; padding-top: 14px; border-top: 1px solid #2a2a36; font-family: monospace; font-size: 12px; }
.result .stats div { text-align: center; }
.result .stats .v { font-size: 18px; font-weight: 700; color: #fff; }
.result .stats .l { color: #666; font-size: 10px; text-transform: uppercase; }
section { margin: 32px 0; }
section h2 { font-size: 18px; margin-bottom: 12px; font-weight: 600; }
section p, section li { color: #c5c5d5; margin-bottom: 8px; font-size: 14px; }
section ol { padding-left: 22px; }
.footer { color: #555; font-size: 12px; margin-top: 48px; text-align: center; }
.footer a { color: #888; margin: 0 8px; }
</style></head><body><div class="wrap">

<nav class="nav">
  <a class="logo" href="/">OpenHeab</a>
  <div class="links">
    <a href="/referrals" style="color:#fff">Referrals</a>
    <a href="/pricing">Pricing</a>
    <a href="/dashboard">Dashboard</a>
    <a href="/docs">Docs</a>
  </div>
</nav>

<div class="hero">
  <h1>Earn 25% recurring</h1>
  <p class="subtitle">Refer an agent or org to OpenHeab. We pay you <b>25% of their first year's subscription revenue</b>. Settled monthly in USDC.</p>
</div>

<div class="payouts">
  <div class="payout"><div class="pct">25%</div><div class="l">Year-1 commission</div></div>
  <div class="payout"><div class="pct">10%</div><div class="l">Years 2-3</div></div>
  <div class="payout"><div class="pct">$25</div><div class="l">Per Free signup that activates</div></div>
  <div class="payout"><div class="pct">USDC</div><div class="l">Settlement currency</div></div>
</div>

<div class="gen-form">
  <label>Your DID</label>
  <input id="did" placeholder="did:op:..." />
  <button onclick="generate()">Generate my referral link</button>
  <div class="result" id="result">
    <div class="label">Your link</div>
    <div class="code">
      <input id="link" readonly />
      <button onclick="copyLink()">Copy</button>
    </div>
    <div class="stats">
      <div><div class="v" id="s-clicks">0</div><div class="l">Clicks</div></div>
      <div><div class="v" id="s-signups">0</div><div class="l">Signups</div></div>
      <div><div class="v" id="s-paid">0</div><div class="l">Paid</div></div>
      <div><div class="v" id="s-earned">$0</div><div class="l">Earned</div></div>
    </div>
  </div>
</div>

<section>
  <h2>How it works</h2>
  <ol>
    <li>Generate your unique referral link (above). Format: <code>openheab.com/?ref=YOUR_CODE</code>.</li>
    <li>Share it. Embed in your blog, OSS README, Twitter bio, Slack signature.</li>
    <li>When someone signs up via your link and subscribes to a paid plan, we attribute the conversion.</li>
    <li>You earn 25% of their first-year subscription, 10% in years 2-3, plus $25 per Free user that activates (15+ API calls).</li>
    <li>We settle monthly on the 1st. Default: USDC to your wallet. Optional: ACH/wire on request.</li>
  </ol>
</section>

<section>
  <h2>The math</h2>
  <p>Refer 10 Pro customers ($99/mo each). At 25%, that's <b>$247.50/mo recurring</b> from those 10 alone. Refer 100? <b>$2,475/mo</b>. The substrate is sticky — agents migrate, but rarely off the substrate they ship on.</p>
</section>

<section>
  <h2>Terms</h2>
  <ul>
    <li>Self-referrals (you create both accounts) → forfeit all rewards.</li>
    <li>No spam. We reverse commissions on accounts created via UGC spam, comment spam, paid clickfarms.</li>
    <li>No fraud. Disputed/refunded subscriptions reverse the commission.</li>
    <li>Pay-out floor: $50 USDC. Below that, accumulates until next cycle.</li>
    <li>You can withdraw any time via <code>POST /v1/agents/$DID/referrals/payout</code>.</li>
  </ul>
</section>

<div class="footer">
  Questions? <a href="mailto:partners@openheab.com">partners@openheab.com</a> · <a href="/v1/agents/$DID/referrals">API for referral stats</a>
</div>

</div>
<script>
async function generate() {
  const did = document.getElementById('did').value.trim();
  if (!did) { alert('Need your DID'); return; }
  const r = await fetch('/v1/referrals/generate', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ referrer_did: did })
  });
  const j = await r.json();
  if (j.error) { alert(j.error); return; }
  document.getElementById('link').value = window.location.origin + '/?ref=' + j.ref_code;
  document.getElementById('s-clicks').textContent = j.clicks || 0;
  document.getElementById('s-signups').textContent = j.signups || 0;
  document.getElementById('s-paid').textContent = j.paid_signups || 0;
  document.getElementById('s-earned').textContent = '$' + ((j.total_credit_cents || 0) / 100).toFixed(2);
  document.getElementById('result').classList.add('show');
}
function copyLink() {
  const el = document.getElementById('link');
  el.select(); document.execCommand('copy');
  event.target.textContent = 'Copied'; setTimeout(() => event.target.textContent = 'Copy', 1500);
}
</script>
</body></html>`;
}

function renderCompareModelsPage() {
  return `<!doctype html><html><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>Compare Models — OpenHeab</title>
<meta name="description" content="Pick 2 LLMs, send the same prompt, see them side-by-side.">
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Inter', sans-serif; background: #0a0a0f; color: #e7e7ee; line-height: 1.5; }
.wrap { max-width: 1280px; margin: 0 auto; padding: 24px; }
.nav { display: flex; justify-content: space-between; align-items: center; margin-bottom: 28px; padding-bottom: 18px; border-bottom: 1px solid #1a1a25; }
.nav .logo { font-weight: 700; font-size: 18px; color: #fff; text-decoration: none; }
.nav .links a { color: #888; margin-left: 18px; font-size: 13px; text-decoration: none; }
.nav .links a:hover { color: #fff; }
h1 { font-size: 28px; font-weight: 700; letter-spacing: -0.6px; margin-bottom: 6px; }
.subtitle { color: #888; font-size: 14px; margin-bottom: 24px; }
.controls { background: #14141c; padding: 18px 22px; border-radius: 12px; margin-bottom: 18px; }
.controls .row { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; margin-bottom: 12px; }
.controls .row:last-child { margin-bottom: 0; }
.controls label { font-size: 12px; color: #888; text-transform: uppercase; letter-spacing: 0.5px; font-weight: 600; }
.controls input, .controls select { padding: 9px 12px; background: #0f0f17; border: 1px solid #1f1f2a; color: #fff; border-radius: 6px; font-size: 13px; font-family: inherit; outline: none; }
.controls input { flex: 1; min-width: 200px; font-family: monospace; }
.controls input:focus, .controls select:focus { border-color: #4f46e5; }
.controls textarea { width: 100%; padding: 12px 14px; background: #0f0f17; border: 1px solid #1f1f2a; color: #fff; border-radius: 6px; font-family: 'SF Mono', monospace; font-size: 13px; min-height: 100px; outline: none; }
.controls textarea:focus { border-color: #4f46e5; }
.controls .actions { display: flex; gap: 10px; align-items: center; margin-top: 12px; }
.controls button { padding: 10px 22px; background: #4f46e5; color: #fff; border: 0; border-radius: 6px; font-weight: 600; cursor: pointer; font-size: 14px; }
.controls button:hover { background: #4338ca; }
.controls button:disabled { opacity: 0.5; cursor: not-allowed; }
.controls .status { color: #888; font-size: 12px; font-family: monospace; }
.results { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
@media (max-width: 800px) { .results { grid-template-columns: 1fr; } }
.col { background: #14141c; border: 1px solid #1f1f2a; border-radius: 12px; padding: 18px 22px; min-height: 240px; }
.col .head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; padding-bottom: 10px; border-bottom: 1px solid #1f1f2a; }
.col .name { font-weight: 600; font-size: 14px; color: #fff; font-family: monospace; }
.col .meta { font-size: 11px; color: #888; font-family: monospace; }
.col .output { color: #c5c5d5; font-size: 13px; line-height: 1.7; white-space: pre-wrap; font-family: 'SF Mono', monospace; min-height: 100px; }
.col .stats { display: flex; gap: 14px; margin-top: 14px; padding-top: 10px; border-top: 1px solid #1f1f2a; font-family: monospace; font-size: 11px; color: #666; }
.col.loading { background: #14141c; }
.col.loading .output::after { content: '...'; animation: dot 1s infinite; }
@keyframes dot { 0%, 20% { content: '.'; } 40% { content: '..'; } 60%, 100% { content: '...'; } }
.empty { color: #555; font-size: 13px; text-align: center; padding: 30px 0; }
</style></head><body><div class="wrap">

<nav class="nav">
  <a class="logo" href="/">OpenHeab</a>
  <div class="links">
    <a href="/compare-models" style="color:#fff">Compare</a>
    <a href="/workbench">Workbench</a>
    <a href="/models">Models</a>
    <a href="/dashboard">Dashboard</a>
  </div>
</nav>

<h1>Compare Models</h1>
<p class="subtitle">Pick two models, send the same prompt, see them side by side. Tokens + latency + cost shown for each.</p>

<div class="controls">
  <div class="row">
    <label>Auth (API key OR DID)</label>
    <input id="auth" type="password" placeholder="oh_live_... or paste did:op:..." />
  </div>
  <div class="row">
    <label>Model A</label>
    <select id="modelA">
      <option value="claude-haiku">claude-haiku</option>
      <option value="gpt-4o-mini" selected>gpt-4o-mini</option>
      <option value="gemini-flash">gemini-flash</option>
      <option value="llama-70b">llama-70b</option>
    </select>
    <label>Model B</label>
    <select id="modelB">
      <option value="claude-haiku" selected>claude-haiku</option>
      <option value="gpt-4o-mini">gpt-4o-mini</option>
      <option value="gemini-flash">gemini-flash</option>
      <option value="llama-70b">llama-70b</option>
    </select>
  </div>
  <textarea id="prompt" placeholder="Type your prompt...">Explain the OpenHeab substrate in one sentence.</textarea>
  <div class="actions">
    <button onclick="compare()" id="go">Compare →</button>
    <span class="status" id="status"></span>
  </div>
</div>

<div class="results">
  <div class="col" id="colA"><div class="head"><span class="name" id="nameA">Model A</span><span class="meta" id="metaA"></span></div><div class="output" id="outA"><div class="empty">Press <b>Compare</b> to run both models.</div></div><div class="stats" id="statsA"></div></div>
  <div class="col" id="colB"><div class="head"><span class="name" id="nameB">Model B</span><span class="meta" id="metaB"></span></div><div class="output" id="outB"><div class="empty">Press <b>Compare</b> to run both models.</div></div><div class="stats" id="statsB"></div></div>
</div>

<script>
async function compare() {
  const auth = document.getElementById('auth').value.trim();
  if (!auth) { alert('Need API key or DID'); return; }
  const isDid = auth.startsWith('did:');
  const modelA = document.getElementById('modelA').value;
  const modelB = document.getElementById('modelB').value;
  const prompt = document.getElementById('prompt').value.trim();
  if (!prompt) { alert('Need prompt'); return; }
  const headers = { 'content-type': 'application/json' };
  if (isDid) headers['x-agent-did'] = auth; else headers.authorization = 'Bearer ' + auth;
  document.getElementById('go').disabled = true;
  document.getElementById('nameA').textContent = modelA;
  document.getElementById('nameB').textContent = modelB;
  document.getElementById('outA').textContent = '';
  document.getElementById('outB').textContent = '';
  document.getElementById('colA').classList.add('loading');
  document.getElementById('colB').classList.add('loading');
  setStatus('Calling both models in parallel...');
  const tStart = Date.now();
  const [a, b] = await Promise.all([
    runOne(headers, modelA, prompt),
    runOne(headers, modelB, prompt)
  ]);
  setStatus('Done in ' + (Date.now() - tStart) + 'ms total (parallel)');
  document.getElementById('go').disabled = false;
  fill('A', a, modelA);
  fill('B', b, modelB);
}
async function runOne(headers, model, prompt) {
  const t0 = Date.now();
  try {
    const r = await fetch('/v1/chat/completions', {
      method: 'POST', headers, body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }] })
    });
    const j = await r.json();
    return { ...j, _latency_ms: Date.now() - t0 };
  } catch (e) { return { error: e.message, _latency_ms: Date.now() - t0 }; }
}
function fill(side, result, model) {
  const col = document.getElementById('col' + side);
  col.classList.remove('loading');
  const out = document.getElementById('out' + side);
  const meta = document.getElementById('meta' + side);
  const stats = document.getElementById('stats' + side);
  if (result.error) { out.textContent = 'Error: ' + (result.error.message || result.error); return; }
  out.textContent = result.choices?.[0]?.message?.content || '(empty response)';
  const u = result.usage || {};
  meta.textContent = (u.total_tokens || 0) + ' tokens · ' + result._latency_ms + 'ms';
  stats.innerHTML = '<span>prompt: ' + (u.prompt_tokens || 0) + '</span>' +
                    '<span>output: ' + (u.completion_tokens || 0) + '</span>' +
                    '<span>latency: ' + result._latency_ms + 'ms</span>' +
                    (result._openheab_stub ? '<span style="color:#eab308">STUB</span>' : '');
}
function setStatus(s) { document.getElementById('status').textContent = s; }
</script>
</body></html>`;
}

// --- Inline SVG chart helpers (no dep) ---

function svgSparkline(values, opts = {}) {
  const w = opts.width || 180, h = opts.height || 40, color = opts.color || '#818cf8';
  if (!values || values.length === 0) return `<svg width="${w}" height="${h}"></svg>`;
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const range = max - min || 1;
  const stride = w / Math.max(values.length - 1, 1);
  const pts = values.map((v, i) => {
    const x = i * stride;
    const y = h - ((v - min) / range) * h;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg">
    <polyline points="${pts.join(' ')}" fill="none" stroke="${color}" stroke-width="1.5"/>
    <polyline points="0,${h} ${pts.join(' ')} ${w},${h}" fill="${color}" fill-opacity="0.15" stroke="none"/>
  </svg>`;
}

function svgBars(values, opts = {}) {
  const w = opts.width || 240, h = opts.height || 80, color = opts.color || '#4f46e5';
  if (!values || values.length === 0) return `<svg width="${w}" height="${h}"></svg>`;
  const max = Math.max(...values, 1);
  const bw = w / values.length;
  const bars = values.map((v, i) => {
    const bh = max > 0 ? (v / max) * h : 0;
    return `<rect x="${i * bw + 1}" y="${h - bh}" width="${bw - 2}" height="${bh}" fill="${color}" rx="1"/>`;
  });
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg">${bars.join('')}</svg>`;
}

function svgDonut(slices, opts = {}) {
  const w = opts.width || 120, h = opts.height || 120, inner = opts.inner || 30;
  const cx = w / 2, cy = h / 2, r = Math.min(w, h) / 2;
  const total = slices.reduce((s, x) => s + Math.max(0, Number(x.value || 0)), 0);
  if (total <= 0) return `<svg width="${w}" height="${h}"><circle cx="${cx}" cy="${cy}" r="${r - 1}" fill="none" stroke="#1a1a25" stroke-width="${r - inner}"/></svg>`;
  let angle = -Math.PI / 2;
  const arcs = slices.map((s, i) => {
    const v = Math.max(0, Number(s.value || 0));
    const ang = (v / total) * Math.PI * 2;
    if (ang <= 0) return '';
    const x1 = cx + Math.cos(angle) * r;
    const y1 = cy + Math.sin(angle) * r;
    const x2 = cx + Math.cos(angle + ang) * r;
    const y2 = cy + Math.sin(angle + ang) * r;
    const large = ang > Math.PI ? 1 : 0;
    angle += ang;
    return `<path d="M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2} Z" fill="${s.color || '#4f46e5'}" />`;
  });
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg">
    ${arcs.join('')}
    <circle cx="${cx}" cy="${cy}" r="${inner}" fill="#0a0a0f"/>
  </svg>`;
}

function registerGrowthSurfacesRoutes(app, pool, verifyAgentAuth, auditChain) {
  const express = require('express');

  // /referrals
  app.get('/referrals', (req, res) => {
    res.set('content-type', 'text/html; charset=utf-8');
    res.set('cache-control', 'public, max-age=3600');
    res.send(renderReferralsPage());
  });

  // /compare-models
  app.get('/compare-models', (req, res) => {
    res.set('content-type', 'text/html; charset=utf-8');
    res.set('cache-control', 'public, max-age=3600');
    res.send(renderCompareModelsPage());
  });

  // POST /v1/referrals/generate — idempotent: returns existing if already created
  app.post('/v1/referrals/generate', express.json(), async (req, res) => {
    const did = req.body?.referrer_did;
    if (!did || !did.startsWith('did:')) return res.status(400).json({ error: 'invalid_referrer_did' });
    // Idempotent: return existing if any
    const existing = await pool.query(
      `SELECT ref_code, clicks, signups, paid_signups, total_credit_cents FROM referral_links WHERE referrer_did=$1 ORDER BY created_at ASC LIMIT 1`,
      [did]
    ).catch(() => ({ rows: [] }));
    if (existing.rows[0]) return res.json(existing.rows[0]);
    const code = newRefCode();
    await pool.query(
      `INSERT INTO referral_links (ref_code, referrer_did) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [code, did]
    );
    if (auditChain) auditChain.append({ event_type: 'referral.created', ref_code: code, referrer_did: did }).catch(() => {});
    res.status(201).json({ ref_code: code, clicks: 0, signups: 0, paid_signups: 0, total_credit_cents: 0 });
  });

  // GET /v1/referrals/:code — public stats (no PII)
  app.get('/v1/referrals/:code', async (req, res) => {
    const r = await pool.query(
      `SELECT ref_code, clicks, signups, paid_signups, total_credit_cents, created_at FROM referral_links WHERE ref_code=$1`,
      [req.params.code]
    ).catch(() => ({ rows: [] }));
    if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
    res.json(r.rows[0]);
  });

  // POST /v1/referrals/:code/click — record a click (call from landing if ?ref= present)
  app.post('/v1/referrals/:code/click', async (req, res) => {
    const ipHash = crypto.createHash('sha256').update(String(req.ip || 'anon')).digest('hex').slice(0, 16);
    await pool.query(`UPDATE referral_links SET clicks=clicks+1 WHERE ref_code=$1`, [req.params.code]).catch(() => {});
    await pool.query(
      `INSERT INTO referral_events (event_id, ref_code, event_kind, visitor_hash) VALUES ($1,$2,'click',$3)`,
      ['re_' + crypto.randomBytes(8).toString('hex'), req.params.code, ipHash]
    ).catch(() => {});
    res.json({ recorded: true });
  });

  // GET /v1/charts/sparkline.svg?values=1,2,3,4,5 — embeddable inline chart
  app.get('/v1/charts/sparkline.svg', (req, res) => {
    const values = String(req.query.values || '').split(',').map(Number).filter(n => !isNaN(n));
    res.set('content-type', 'image/svg+xml');
    res.set('cache-control', 'public, max-age=60');
    res.send(svgSparkline(values, {
      width: parseInt(req.query.w) || 180,
      height: parseInt(req.query.h) || 40,
      color: req.query.color || '#818cf8'
    }));
  });

  // GET /v1/charts/bars.svg?values=1,2,3,4,5
  app.get('/v1/charts/bars.svg', (req, res) => {
    const values = String(req.query.values || '').split(',').map(Number).filter(n => !isNaN(n));
    res.set('content-type', 'image/svg+xml');
    res.set('cache-control', 'public, max-age=60');
    res.send(svgBars(values, {
      width: parseInt(req.query.w) || 240,
      height: parseInt(req.query.h) || 80,
      color: req.query.color || '#4f46e5'
    }));
  });

  // GET /v1/charts/donut.svg?slices=10:red,20:blue,30:green
  app.get('/v1/charts/donut.svg', (req, res) => {
    const slices = String(req.query.slices || '').split(',').map(s => {
      const [v, c] = s.split(':');
      return { value: Number(v) || 0, color: '#' + (c || '4f46e5') };
    }).filter(s => s.value > 0);
    res.set('content-type', 'image/svg+xml');
    res.set('cache-control', 'public, max-age=60');
    res.send(svgDonut(slices, {
      width: parseInt(req.query.w) || 120,
      height: parseInt(req.query.h) || 120,
      inner: parseInt(req.query.inner) || 30
    }));
  });
}

module.exports = { migrate, registerGrowthSurfacesRoutes, svgSparkline, svgBars, svgDonut };
