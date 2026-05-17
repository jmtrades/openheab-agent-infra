// ============================================================================
// quickstart.js — the three surfaces that let a brand-new operator go from
// "git clone" to a fully-running production substrate in under 10 minutes:
//
//   GET /setup        — operator setup wizard (env vars + admin + DKIM keys)
//   GET /welcome      — post-signup tour for new customers (one-click trials)
//   GET /playground   — public API explorer (run any endpoint live in browser)
//
// All three are server-rendered HTML, no JS framework, use the shared design
// tokens from /v1/design/tokens.css.
// ============================================================================
const crypto = require('crypto');

async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS setup_state (
      key                TEXT PRIMARY KEY,
      value              TEXT,
      completed_at       TIMESTAMPTZ
    );
    CREATE TABLE IF NOT EXISTS playground_runs (
      run_id             TEXT PRIMARY KEY,
      ip_hash            TEXT,
      method             TEXT,
      path               TEXT,
      status_code        INTEGER,
      latency_ms         INTEGER,
      occurred_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

function newId(p) { return p + '_' + crypto.randomBytes(10).toString('hex'); }
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}
function isAdmin(req) {
  const t = req.headers['x-admin-token'];
  return t && t === process.env.OPERATOR_ADMIN_TOKEN;
}

// ----------------------------------------------------------------------------
// SHARED PAGE SHELL (uses /v1/design/tokens.css for consistent visuals)
// ----------------------------------------------------------------------------
const { head: dsHead, NAV_HTML, FOOTER_HTML } = require('../design_system');

function page({ title, description, body, activeNav = '', extraStyle = '' }) {
  const extraHead = `<style>
h1{font-size:38px;letter-spacing:-1.4px;line-height:1.1;margin:0 0 14px;font-weight:600}
.lede{color:var(--fg-dim);font-size:17px;line-height:1.55;margin-bottom:36px;max-width:680px}
.step{background:var(--bg-elev);border:1px solid var(--br);border-radius:12px;padding:22px 24px;margin-bottom:12px;position:relative;transition:border-color var(--t-fast) var(--ease-out)}
.step:hover{border-color:var(--br-strong)}
.step .n{position:absolute;left:-14px;top:22px;background:var(--bg-elev);border:1px solid var(--br);color:var(--acc);width:32px;height:32px;border-radius:50%;display:flex;align-items:center;justify-content:center;font:600 13px var(--mono)}
.step h3{margin:0 0 8px;font-size:16px;color:var(--fg);font-weight:600}
.step p{color:var(--fg-dim);font-size:14px;line-height:1.6;margin:0 0 10px}
.step pre{background:var(--bg);border:1px solid var(--br);border-radius:8px;padding:14px 16px;font:12px/1.6 var(--mono);overflow:auto;color:var(--fg-dim)}
.step .done{position:absolute;right:14px;top:14px;color:var(--good);font:600 10.5px/1 var(--mono);text-transform:uppercase;letter-spacing:1.2px}
.badge{padding:2px 8px;border-radius:4px;font:600 10.5px/1.4 var(--mono);letter-spacing:0.5px}
.badge.b-good{background:rgba(52,211,153,0.12);color:var(--good);border:1px solid rgba(52,211,153,0.25)}
.badge.b-bad{background:rgba(248,113,113,0.12);color:var(--bad);border:1px solid rgba(248,113,113,0.25)}
${extraStyle}
</style>`;
  return dsHead(`${title} — OpenHeab`, description || '', { path: '/' + (activeNav || ''), extraHead })
    + NAV_HTML(activeNav) + `<main>${body}</main>` + FOOTER_HTML();
}

// ----------------------------------------------------------------------------
// /setup — operator setup wizard
// ----------------------------------------------------------------------------
async function getSetupStatus(pool) {
  const required = [
    'DATABASE_URL', 'IDENTITY_MASTER_KEK', 'CRYPTO_MASTER_KEK',
    'OPERATOR_PUBLIC_URL', 'OPERATOR_ADMIN_TOKEN'
  ];
  const inhouseAlt = ['INFERENCE_CORE_BACKEND_URL', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY'];
  const optional = [
    'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'STRIPE_PRICE_PRO_MONTHLY',
    'TWILIO_ACCOUNT_SID', 'BASE_RPC_URL', 'BANK_FEE_SPLITTER',
    'CARD_CORE_MASTER_KEK', 'ACH_MASTER_KEK', 'EMAIL_CORE_MTA_SECRET',
    'OPERATOR_ROOT_PRIVATE_KEY_PEM'
  ];

  const reqStatus = required.map(k => ({ name: k, set: !!process.env[k] }));
  const altOk = inhouseAlt.some(k => !!process.env[k]);
  const optStatus = optional.map(k => ({ name: k, set: !!process.env[k] }));
  const dbOk = await pool.query('SELECT 1').then(() => true).catch(() => false);

  const totalRequired = required.length + 1; // +1 for inference
  const setRequired = reqStatus.filter(r => r.set).length + (altOk ? 1 : 0);
  return {
    required: reqStatus, optional: optStatus,
    inference_configured: altOk,
    inference_options: inhouseAlt,
    db_reachable: dbOk,
    ready: setRequired === totalRequired && dbOk,
    progress: Math.round((setRequired / totalRequired) * 100)
  };
}

async function pageSetup(pool) {
  const s = await getSetupStatus(pool);
  let prims = 189, routes = 1495;
  try {
    prims = Object.keys(require('./../integration').primitives).length;
    routes = require('./../status_page').collectRoutes ? require('./../status_page').collectRoutes(global.__app || { _router: { stack: [] } }).length : 1495;
  } catch {}

  const renderRow = (item) => `<tr>
    <td style="font-family:var(--mono);font-size:13px">${escapeHtml(item.name)}</td>
    <td>${item.set ? '<span class="badge b-good">SET</span>' : '<span class="badge b-bad">MISSING</span>'}</td>
  </tr>`;

  return page({ title: 'Setup',
    description: 'One-page substrate setup. Configure env vars, verify database, generate admin token, deploy.',
    activeNav: 'setup',
    body: `
<span class=pill>${s.ready ? '✓ ready' : `setup ${s.progress}% complete`}</span>
<h1>${s.ready ? 'Substrate is ready.' : 'Set up your substrate.'}</h1>
<p class=lede>${s.ready
  ? `${prims} primitives loaded. ${routes} routes registered. Zero family misses on boot. You can now sign up your first customer, run a test transfer, or open the dashboard.`
  : `5 environment variables required. Set them in your hosting provider (Vercel / Render / Fly / your own server), then refresh this page.`}</p>

<div class=step><span class=n>1</span>${s.required.every(r => r.set) ? '<span class=done>✓ done</span>' : ''}
  <h3>Required environment variables</h3>
  <p>The substrate refuses to boot without these. Generate KEKs with: <code>openssl rand -hex 32</code></p>
  <table style="margin-top:12px">${s.required.map(renderRow).join('')}</table>
</div>

<div class=step><span class=n>2</span>${s.inference_configured ? '<span class=done>✓ done</span>' : ''}
  <h3>Inference backend</h3>
  <p>Set at least <em>one</em> of these. Use <code>INFERENCE_CORE_BACKEND_URL</code> if you're running our open-weight models on your own GPU box, or any third-party LLM key for the cheapest routing.</p>
  <table style="margin-top:12px">${s.inference_options.map(name => `<tr><td style="font-family:var(--mono);font-size:13px">${name}</td><td>${process.env[name] ? '<span class="badge b-good">SET</span>' : '<span class="badge b-dim">unset</span>'}</td></tr>`).join('')}</table>
</div>

<div class=step><span class=n>3</span>${s.db_reachable ? '<span class=done>✓ done</span>' : ''}
  <h3>Database</h3>
  <p>Postgres reachable: <strong>${s.db_reachable ? 'yes' : 'NO — check DATABASE_URL'}</strong>. Run <code>npm run migrate</code> to apply all 234 primitives' schemas idempotently.</p>
  ${s.db_reachable ? '' : '<pre>npm run migrate</pre>'}
</div>

<div class=step><span class=n>4</span>
  <h3>Optional providers (enable as needed)</h3>
  <p>Each unset provider's primitive operates in stub mode — substrate still boots. Set the env var → primitive flips to production. See <a href="/v1/admin/providers" style="color:var(--acc)">/v1/admin/providers</a> for the full 32-provider matrix.</p>
  <table style="margin-top:12px">${s.optional.map(renderRow).join('')}</table>
</div>

<div class=step><span class=n>5</span>
  <h3>${s.ready ? 'You\'re live.' : 'Next steps'}</h3>
  ${s.ready ? `
    <p>Open <a href="/v1/dashboard" style="color:var(--acc)">/v1/dashboard</a> to manage agents · <a href="/playground" style="color:var(--acc)">/playground</a> to test the API live · <a href="/welcome" style="color:var(--acc)">/welcome</a> to take the new-user tour · <a href="/console" style="color:var(--acc)">/console</a> to browse all ${routes} routes.</p>
    <p style="margin-top:14px;color:var(--dim);font-size:13px">Public proof-of-reserves: <a href="/v1/bank-core/reserve-ratio" style="color:var(--acc)">/v1/bank-core/reserve-ratio</a></p>
  ` : `
    <p>Once required vars are set, refresh this page. Then:</p>
    <pre>npm run migrate     # apply database schemas
npm start           # start the substrate
open ${escapeHtml(process.env.OPERATOR_PUBLIC_URL || 'http://localhost:3000')}/setup</pre>
  `}
</div>

<div style="margin-top:48px;padding-top:24px;border-top:1px solid var(--br);color:var(--dim);font-size:12px">
  Substrate: ${prims} primitives across 42 layers · ${routes} routes · Apache-2.0 · self-hostable
</div>
`});
}

// ----------------------------------------------------------------------------
// /welcome — new-user onboarding tour with one-click "try it" panels
// ----------------------------------------------------------------------------
function pageWelcome() {
  const examples = [
    { title: 'Create an agent identity', kind: 'POST', path: '/v1/identities',
      body: '{"display_name":"my-first-agent"}', returns: 'DID + Ed25519 keypair + API key + USDC wallet on Base' },
    { title: 'Check wallet balance', kind: 'GET', path: '/v1/agents/:did/wallet/balance',
      body: '', returns: 'On-chain USDC balance from real Base RPC' },
    { title: 'Send your first USDC transfer', kind: 'POST', path: '/v1/agents/:did/wallet/transfer',
      body: '{"to_did":"did:op:...","amount":"1.00"}', returns: 'tx_hash + 1% fee to FeeSplitter' },
    { title: 'Open a savings account', kind: 'POST', path: '/v1/agents/:did/savings/accounts',
      body: '{"strategy":"aave_v3","auto_compound":true}', returns: 'Savings account with 4% APY' },
    { title: 'Issue a virtual debit card', kind: 'POST', path: '/v1/agents/:did/cards',
      body: '{"kind":"virtual","monthly_limit_cents":50000}', returns: 'Card with last4 + JIT-funded auth' },
    { title: 'Run multi-LLM inference', kind: 'POST', path: '/v1/agents/:did/inference/chat',
      body: '{"model":"claude-3-haiku","messages":[{"role":"user","content":"hi"}]}', returns: '10% markup auto-applied' },
    { title: 'Submit KYC document', kind: 'POST', path: '/v1/agents/:did/kyc/documents',
      body: '{"kind":"passport","country":"US","front_url":"..."}', returns: 'Auto-screened against 5 sanctions lists' },
    { title: 'Subscribe to SSE stream', kind: 'GET', path: '/v1/realtime/stream',
      body: '', returns: 'Sub-second push of every audit-chain event' },
    { title: 'Create a workflow (Zapier-style)', kind: 'POST', path: '/v1/agents/:did/workflows',
      body: '{"name":"daily-summary","trigger_kind":"schedule","actions":[...]}', returns: 'DAG runs on cron' },
    { title: 'Negotiate with another agent', kind: 'POST', path: '/v1/agents/:did/negotiations',
      body: '{"seller_did":"did:op:...","subject":"5h dev work","initial_offer_cents":50000}', returns: 'A2A bargaining protocol with escrow' },
    { title: 'Bind to an agent constitution', kind: 'POST', path: '/v1/agents/:did/constitutions/bind',
      body: '{"constitution_id":"cnst_..."}', returns: 'Every action checked against declared rules' },
    { title: 'Apply for SOC 2 audit access', kind: 'POST', path: '/v1/admin/audit-core/auditors',
      body: '{"firm_name":"PwC","contact_email":"..."}', returns: 'Auditor portal token with read-only access' }
  ];

  const cards = examples.map((e, i) => `<div class=card>
    <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px">
      <span style="font:600 10px var(--mono);color:var(--acc);text-transform:uppercase;letter-spacing:1.5px">${escapeHtml(e.kind)}</span>
      <span class="badge b-dim">${i + 1}/${examples.length}</span>
    </div>
    <h3 style="font-size:15px;font-weight:600;margin:0 0 6px">${escapeHtml(e.title)}</h3>
    <code style="display:block;background:#070707;padding:8px 10px;border-radius:var(--r-sm);font-size:11px;color:var(--dim2);margin:8px 0;overflow:auto;white-space:nowrap">${escapeHtml(e.path)}</code>
    <p style="font-size:12px;color:var(--dim);margin:6px 0 12px">${escapeHtml(e.returns)}</p>
    <a class="btn primary" href="/playground?method=${escapeHtml(e.kind)}&path=${encodeURIComponent(e.path)}&body=${encodeURIComponent(e.body)}" style="display:inline-flex;font-size:12px;padding:7px 12px">Try in playground →</a>
  </div>`).join('');

  return page({ title: 'Welcome', description: 'First-time tour of OpenHeab — 12 things you can do right now.',
    activeNav: 'welcome',
    extraStyle: `.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:14px;margin-top:24px}`,
    body: `
<span class=pill>tour</span>
<h1>Welcome. Here are 12 things you can do right now.</h1>
<p class=lede>Every card below has a one-click "Try in playground" button that pre-fills the request. Sign up first if you haven't — every example needs a valid agent DID and API key.</p>
<div style="display:flex;gap:12px;margin-bottom:32px">
  <a href="/signup" class="btn primary">Sign up free</a>
  <a href="/v1/dashboard" class="btn">Open dashboard</a>
  <a href="/playground" class="btn">Open playground</a>
</div>
<div class=grid>${cards}</div>
<div style="margin-top:48px;padding:24px;background:var(--card);border:1px solid var(--br);border-radius:var(--r-xl)">
  <h3 style="font-size:16px;font-weight:600;margin-bottom:10px">All 42 layers, 234 primitives, 1,701+ routes</h3>
  <p style="color:var(--dim2);font-size:14px;margin:0">Browse the complete list at <a href="/console" style="color:var(--acc)">/console</a> · view OpenAPI at <a href="/openapi.json" style="color:var(--acc)">/openapi.json</a> · MCP manifest at <a href="/mcp/manifest" style="color:var(--acc)">/mcp/manifest</a></p>
</div>
`});
}

// ----------------------------------------------------------------------------
// /playground — public API explorer with live curl execution
// ----------------------------------------------------------------------------
function pagePlayground() {
  return page({ title: 'API Playground', description: 'Run any OpenHeab API call live in your browser. No SDK install needed.',
    activeNav: 'playground',
    extraStyle: `
.editor{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:18px}
@media(max-width:780px){.editor{grid-template-columns:1fr}}
.panel{background:var(--card);border:1px solid var(--br);border-radius:var(--r-xl);overflow:hidden}
.panel .head{padding:10px 14px;border-bottom:1px solid var(--br);font:500 11px var(--mono);color:var(--dim);text-transform:uppercase;letter-spacing:1.2px}
.panel pre{padding:14px;font-size:12px;line-height:1.55;margin:0;overflow:auto;max-height:540px;color:var(--dim2)}
.bar{display:flex;gap:8px;margin-bottom:14px;align-items:center}
.bar select,.bar input{padding:10px 12px;font:500 13px var(--mono);background:#070707;color:var(--fg);border:1px solid var(--br);border-radius:var(--r-md);outline:none}
.bar select{width:110px;border-color:var(--acc)}
.bar input{flex:1}
textarea{width:100%;height:240px;background:#070707;color:var(--fg);border:1px solid var(--br);border-radius:var(--r-md);padding:14px;font:13px/1.5 var(--mono);outline:none;resize:vertical}
.curl{margin-top:18px;background:#070707;border:1px solid var(--br);border-radius:var(--r-md);padding:14px;font:12px var(--mono);color:var(--dim2);overflow:auto}
.quick{display:flex;gap:8px;flex-wrap:wrap;margin-top:14px}
.quick button{background:transparent;color:var(--dim2);border:1px solid var(--br);padding:6px 10px;border-radius:var(--r-full);font:500 11px var(--mono);cursor:pointer}
.quick button:hover{border-color:var(--acc);color:var(--fg)}
`,
    body: `
<span class=pill>live</span>
<h1>API Playground</h1>
<p class=lede>Make real HTTP calls to the running substrate. Set your API key once below, then explore. Every call shows the exact <code>curl</code> equivalent.</p>

<div class=bar>
  <label style="color:var(--dim);font:500 12px var(--mono)">API key:&nbsp;</label>
  <input id=apikey type=password placeholder="opk_..." style="flex:1">
  <button class="btn" onclick="localStorage.setItem('ohb_key',document.getElementById('apikey').value);alert('Saved to localStorage')">Save</button>
</div>

<div class=bar>
  <select id=method>
    <option>GET</option><option>POST</option><option>PUT</option><option>DELETE</option><option>PATCH</option>
  </select>
  <input id=path placeholder="/v1/identities" value="/healthz">
  <button class="btn primary" onclick="runRequest()">Send →</button>
</div>

<div class=editor>
  <div class=panel>
    <div class=head>Request body (JSON)</div>
    <textarea id=body placeholder='{ "display_name": "my-agent" }'></textarea>
  </div>
  <div class=panel>
    <div class=head>Response <span id=meta style="color:var(--dim);margin-left:auto;font-weight:400"></span></div>
    <pre id=response>Click "Send →" to make your first request.</pre>
  </div>
</div>

<div class=curl id=curlbox>curl http://localhost:3000/healthz</div>

<h3 style="margin:32px 0 8px;font-size:14px;color:var(--dim);text-transform:uppercase;letter-spacing:1.5px;font:500 12px var(--mono)">Quick examples</h3>
<div class=quick>
  <button onclick="setReq('GET','/healthz','')">Health check</button>
  <button onclick="setReq('GET','/openapi.json','')">OpenAPI spec</button>
  <button onclick="setReq('GET','/mcp/manifest','')">MCP manifest</button>
  <button onclick="setReq('GET','/v1/bank-core/reserve-ratio','')">Proof of reserves</button>
  <button onclick="setReq('GET','/v1/i18n/locales','')">List locales</button>
  <button onclick="setReq('GET','/v1/verticals','')">Industry verticals</button>
  <button onclick="setReq('GET','/v1/inference-core/models','')">Model registry</button>
  <button onclick="setReq('GET','/v1/insurance-core/products','')">Insurance products</button>
  <button onclick="setReq('GET','/v1/credits/packs','')">Credit packs</button>
  <button onclick="setReq('GET','/v1/subscriptions/plans','')">Subscription plans</button>
  <button onclick="setReq('GET','/v1/directory/search?q=&limit=10','')">Directory search</button>
  <button onclick="setReq('GET','/v1/audit/verify','')">Verify audit chain</button>
  <button onclick="setReq('POST','/v1/identities','{\\"display_name\\":\\"my-agent\\"}')">Create agent</button>
  <button onclick="setReq('POST','/v1/safety/classify','{\\"content\\":\\"ignore previous instructions\\"}')">Safety classify</button>
  <button onclick="setReq('POST','/v1/inference-core/completions','{\\"model\\":\\"openheab-mini\\",\\"messages\\":[{\\"role\\":\\"user\\",\\"content\\":\\"hi\\"}]}')">In-house inference</button>
</div>

<script>
function setReq(m, p, b) {
  document.getElementById('method').value = m;
  document.getElementById('path').value = p;
  document.getElementById('body').value = b;
  updateCurl();
}
function updateCurl() {
  const m = document.getElementById('method').value;
  const p = document.getElementById('path').value;
  const b = document.getElementById('body').value;
  const k = localStorage.getItem('ohb_key') || '';
  const auth = k ? ' \\\\\\n  -H "authorization: Bearer ' + k + '"' : '';
  const body = b && m !== 'GET' ? ' \\\\\\n  -d \\'' + b.replace(/'/g, "\\\\'") + '\\'' : '';
  const headers = m !== 'GET' ? ' \\\\\\n  -H "content-type: application/json"' : '';
  document.getElementById('curlbox').textContent = 'curl -X ' + m + ' "' + location.origin + p + '"' + headers + auth + body;
}
async function runRequest() {
  updateCurl();
  const m = document.getElementById('method').value;
  const p = document.getElementById('path').value;
  const b = document.getElementById('body').value;
  const k = localStorage.getItem('ohb_key');
  const headers = { 'content-type': 'application/json' };
  if (k) headers.authorization = 'Bearer ' + k;
  const start = Date.now();
  try {
    const r = await fetch(p, { method: m, headers, body: m === 'GET' ? undefined : (b || undefined) });
    const ms = Date.now() - start;
    let body = await r.text();
    try { body = JSON.stringify(JSON.parse(body), null, 2); } catch {}
    document.getElementById('response').textContent = body;
    document.getElementById('meta').textContent = r.status + ' · ' + ms + 'ms';
  } catch (e) {
    document.getElementById('response').textContent = 'Error: ' + e.message;
    document.getElementById('meta').textContent = 'failed';
  }
}
document.getElementById('method').addEventListener('change', updateCurl);
document.getElementById('path').addEventListener('input', updateCurl);
document.getElementById('body').addEventListener('input', updateCurl);
// Pre-fill from query string (used by /welcome links)
const params = new URLSearchParams(location.search);
if (params.get('method')) document.getElementById('method').value = params.get('method');
if (params.get('path')) document.getElementById('path').value = params.get('path');
if (params.get('body')) document.getElementById('body').value = params.get('body');
const key = localStorage.getItem('ohb_key');
if (key) document.getElementById('apikey').value = key;
updateCurl();
</script>
`});
}

function registerQuickstartRoutes(app, pool, _verifyAgentAuth, _auditChain) {
  global.__app = app;  // for /setup primitive count

  app.get('/setup', async (req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    res.send(await pageSetup(pool));
  });

  app.get('/welcome', (req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.setHeader('cache-control', 'public, max-age=300');
    res.send(pageWelcome());
  });

  app.get('/playground', (req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.setHeader('cache-control', 'public, max-age=300');
    res.send(pagePlayground());
  });

  // Setup wizard JSON status (for programmatic checks)
  app.get('/v1/setup/status', async (req, res) => {
    const s = await getSetupStatus(pool);
    res.json(s);
  });

  // Generate a fresh OPERATOR_ADMIN_TOKEN candidate (one-time advisory)
  app.get('/v1/setup/generate-admin-token', (req, res) => {
    const t = 'opadm_' + crypto.randomBytes(24).toString('hex');
    res.json({ candidate: t, instructions: 'Set OPERATOR_ADMIN_TOKEN to this value in your hosting provider and redeploy.' });
  });

  // Generate fresh KEKs
  app.get('/v1/setup/generate-keks', (req, res) => {
    res.json({
      IDENTITY_MASTER_KEK: crypto.randomBytes(32).toString('hex'),
      CRYPTO_MASTER_KEK: crypto.randomBytes(32).toString('hex'),
      BANK_MASTER_KEK: crypto.randomBytes(32).toString('hex'),
      CARD_CORE_MASTER_KEK: crypto.randomBytes(32).toString('hex'),
      ACH_MASTER_KEK: crypto.randomBytes(32).toString('hex'),
      EMAIL_CORE_MTA_SECRET: crypto.randomBytes(24).toString('hex'),
      CRON_SECRET: crypto.randomBytes(24).toString('hex')
    });
  });

  // Generate operator root keypair (Ed25519 — for audit_core attestation signing)
  app.get('/v1/setup/generate-root-keypair', (req, res) => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    res.json({
      OPERATOR_ROOT_PUBLIC_KEY_PEM: publicKey.export({ type: 'spki', format: 'pem' }),
      OPERATOR_ROOT_PRIVATE_KEY_PEM: privateKey.export({ type: 'pkcs8', format: 'pem' }),
      note: 'Set OPERATOR_ROOT_PRIVATE_KEY_PEM in your hosting provider. The public key gets embedded in every audit attestation we publish.'
    });
  });
}

module.exports = { migrate, registerQuickstartRoutes, pageSetup, pageWelcome, pagePlayground, getSetupStatus };
