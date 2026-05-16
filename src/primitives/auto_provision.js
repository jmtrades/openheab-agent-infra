// ============================================================================
// auto_provision.js — zero-human-in-loop self-setup primitives:
//   - POST /v1/admin/setup/bootstrap  → auto-generate all required KEKs +
//     admin tokens + internal API keys in one call. Returns once-only.
//   - POST /v1/admin/setup/stripe     → given a Stripe secret key, auto-
//     creates 5 products + 5 prices + webhook endpoint via the Stripe API.
//     Persists the resulting price IDs + webhook secret.
//   - POST /v1/admin/setup/sendgrid   → verify SendGrid key + persist
//   - POST /v1/admin/setup/oauth/:p   → persist OAuth client_id/secret
//   - GET  /v1/admin/setup/status     → detailed gap analysis
// All idempotent. All survive restarts via setup_state table.
// ============================================================================
const crypto = require('crypto');

async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS setup_state (
      key            TEXT PRIMARY KEY,
      value          TEXT,
      secret         BOOLEAN NOT NULL DEFAULT FALSE,
      configured_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS setup_runs (
      run_id         TEXT PRIMARY KEY,
      kind           TEXT NOT NULL,
      status         TEXT NOT NULL,
      result         JSONB,
      ran_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

function isAdmin(req) {
  const token = process.env.OPERATOR_ADMIN_TOKEN || process.env.INTERNAL_API_KEY;
  if (!token) return false;
  const provided = req.headers['x-admin-token'] || req.query?.admin_token;
  if (!provided) return false;
  try {
    const a = Buffer.from(provided);
    const b = Buffer.from(token);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch { return false; }
}

// Used only by /bootstrap — operates without any prior auth on first boot.
// Once OPERATOR_ADMIN_TOKEN is set, the gate engages and re-bootstrap requires admin.
function isFirstBoot() {
  return !process.env.OPERATOR_ADMIN_TOKEN && !process.env.INTERNAL_API_KEY;
}

async function persistSetting(pool, key, value, isSecret = false) {
  await pool.query(
    `INSERT INTO setup_state (key, value, secret, configured_at) VALUES ($1, $2, $3, NOW())
     ON CONFLICT (key) DO UPDATE SET value=$2, secret=$3, configured_at=NOW()`,
    [key, value, isSecret]
  ).catch(() => {});
}

async function getSetting(pool, key) {
  const r = await pool.query(`SELECT value, secret FROM setup_state WHERE key=$1`, [key]).catch(() => ({ rows: [] }));
  return r.rows[0] || null;
}

function recordRun(pool, kind, status, result) {
  return pool.query(
    `INSERT INTO setup_runs (run_id, kind, status, result) VALUES ($1,$2,$3,$4)`,
    ['setup_' + crypto.randomBytes(8).toString('hex'), kind, status, JSON.stringify(result || {})]
  ).catch(() => {});
}

// --- Stripe auto-provisioner ---
async function stripeCall(secretKey, path, body) {
  if (typeof fetch !== 'function') throw new Error('fetch_unavailable');
  const r = await fetch('https://api.stripe.com/v1' + path, {
    method: body ? 'POST' : 'GET',
    headers: {
      authorization: 'Bearer ' + secretKey,
      'content-type': 'application/x-www-form-urlencoded'
    },
    body: body ? new URLSearchParams(body).toString() : undefined
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('stripe_' + r.status + ': ' + (j.error?.message || 'unknown'));
  return j;
}

async function autoProvisionStripe(pool, { secretKey, publicUrl }) {
  if (!secretKey) throw new Error('stripe_secret_key_required');
  if (!secretKey.startsWith('sk_')) throw new Error('invalid_stripe_key_format');

  // 1. Verify the key works
  const balance = await stripeCall(secretKey, '/balance');
  const result = { livemode: balance.livemode, products: {}, prices: {}, webhook: {} };

  // 2. Create 5 products (idempotent via metadata search)
  const tiers = [
    { code: 'starter', name: 'OpenHeab Starter', cents: 1900,  description: '5 agents · 100K inference/mo · email support' },
    { code: 'pro',     name: 'OpenHeab Pro',     cents: 9900,  description: '50 agents · 1M inference/mo · priority support' },
    { code: 'team',    name: 'OpenHeab Team',    cents: 34900, description: '500 agents · 10M inference/mo · SSO + Slack' },
    { code: 'enterprise', name: 'OpenHeab Enterprise', cents: 249900, description: 'Unlimited · BYO providers · 24/7 phone' }
  ];

  for (const t of tiers) {
    // Look up existing product by metadata.openheab_tier
    const existing = await stripeCall(secretKey,
      `/products/search?query=${encodeURIComponent(`metadata['openheab_tier']:'${t.code}'`)}`).catch(() => ({ data: [] }));
    let productId = existing.data?.[0]?.id;
    if (!productId) {
      const created = await stripeCall(secretKey, '/products', {
        name: t.name, description: t.description,
        'metadata[openheab_tier]': t.code
      });
      productId = created.id;
    }
    result.products[t.code] = productId;

    // Look up existing price
    const prices = await stripeCall(secretKey, `/prices?product=${productId}&active=true&limit=10`).catch(() => ({ data: [] }));
    let priceId = prices.data?.find(p => p.unit_amount === t.cents && p.recurring?.interval === 'month')?.id;
    if (!priceId) {
      const newPrice = await stripeCall(secretKey, '/prices', {
        product: productId,
        unit_amount: String(t.cents),
        currency: 'usd',
        'recurring[interval]': 'month',
        'metadata[openheab_tier]': t.code
      });
      priceId = newPrice.id;
    }
    result.prices[t.code] = priceId;
    // Persist to setup_state
    await persistSetting(pool, `STRIPE_PRICE_${t.code.toUpperCase()}_MONTHLY`, priceId, false);
  }

  // 3. Create webhook endpoint
  const webhookUrl = (publicUrl || process.env.OPERATOR_PUBLIC_URL || 'https://openheab.com') + '/v1/_webhooks/stripe';
  const existingHooks = await stripeCall(secretKey, '/webhook_endpoints?limit=100').catch(() => ({ data: [] }));
  let webhookId = existingHooks.data?.find(w => w.url === webhookUrl)?.id;
  let webhookSecret = existingHooks.data?.find(w => w.url === webhookUrl)?.secret;
  if (!webhookId) {
    const created = await stripeCall(secretKey, '/webhook_endpoints', {
      url: webhookUrl,
      'enabled_events[]': 'checkout.session.completed',
      'enabled_events[1]': 'invoice.paid',
      'enabled_events[2]': 'invoice.payment_failed',
      'enabled_events[3]': 'customer.subscription.created',
      'enabled_events[4]': 'customer.subscription.updated',
      'enabled_events[5]': 'customer.subscription.deleted'
    });
    webhookId = created.id;
    webhookSecret = created.secret; // Only returned once at creation
    await persistSetting(pool, 'STRIPE_WEBHOOK_SECRET', webhookSecret, true);
  }
  result.webhook = { id: webhookId, url: webhookUrl, secret_persisted: !!webhookSecret };

  // Persist Stripe key itself
  await persistSetting(pool, 'STRIPE_SECRET_KEY', secretKey, true);
  return result;
}

async function autoProvisionSendGrid(pool, { apiKey }) {
  if (!apiKey || !apiKey.startsWith('SG.')) throw new Error('invalid_sendgrid_key_format');
  if (typeof fetch !== 'function') throw new Error('fetch_unavailable');
  // Verify key by hitting /v3/scopes
  const r = await fetch('https://api.sendgrid.com/v3/scopes', {
    headers: { authorization: 'Bearer ' + apiKey }
  });
  if (!r.ok) throw new Error('sendgrid_auth_failed_' + r.status);
  const scopes = await r.json().catch(() => ({}));
  await persistSetting(pool, 'SENDGRID_API_KEY', apiKey, true);
  return { configured: true, scopes_count: (scopes.scopes || []).length };
}

async function autoProvisionOauth(pool, provider, { clientId, clientSecret }) {
  if (!['google', 'github', 'microsoft'].includes(provider)) throw new Error('unsupported_provider');
  if (!clientId || !clientSecret) throw new Error('client_id_and_secret_required');
  const idEnv = provider === 'microsoft' ? 'MS_OAUTH_CLIENT_ID' :
                provider.toUpperCase() + '_OAUTH_CLIENT_ID';
  const secretEnv = provider === 'microsoft' ? 'MS_OAUTH_CLIENT_SECRET' :
                    provider.toUpperCase() + '_OAUTH_CLIENT_SECRET';
  await persistSetting(pool, idEnv, clientId, false);
  await persistSetting(pool, secretEnv, clientSecret, true);
  return { provider, configured: true, start_url: '/auth/oauth/' + provider + '/start' };
}

async function runBootstrap(pool) {
  const generated = {};
  const required = [
    { key: 'IDENTITY_MASTER_KEK', generator: () => crypto.randomBytes(32).toString('hex'), secret: true },
    { key: 'CRYPTO_MASTER_KEK',   generator: () => crypto.randomBytes(32).toString('hex'), secret: true },
    { key: 'BANK_MASTER_KEK',     generator: () => crypto.randomBytes(32).toString('hex'), secret: true },
    { key: 'SECRETS_MASTER_KEK',  generator: () => crypto.randomBytes(32).toString('hex'), secret: true },
    { key: 'CARD_CORE_MASTER_KEK',generator: () => crypto.randomBytes(32).toString('hex'), secret: true },
    { key: 'ACH_MASTER_KEK',      generator: () => crypto.randomBytes(32).toString('hex'), secret: true },
    { key: 'AUDIT_CHAIN_PRIVATE_KEY', generator: () => crypto.randomBytes(32).toString('hex'), secret: true },
    { key: 'INTERNAL_API_KEY',    generator: () => 'iak_' + crypto.randomBytes(24).toString('hex'), secret: true },
    { key: 'OPERATOR_ADMIN_TOKEN',generator: () => 'oat_' + crypto.randomBytes(24).toString('hex'), secret: true },
    { key: 'CRON_SECRET',         generator: () => 'crn_' + crypto.randomBytes(24).toString('hex'), secret: true }
  ];

  for (const r of required) {
    // If env already set, use it; otherwise check setup_state; otherwise generate
    if (process.env[r.key]) {
      generated[r.key] = { source: 'env', value: '(set in env)' };
      continue;
    }
    const persisted = await getSetting(pool, r.key);
    if (persisted) {
      // Hydrate into process.env so substrate uses it without restart
      process.env[r.key] = persisted.value;
      generated[r.key] = { source: 'db', value: persisted.value.slice(0, 8) + '...' };
      continue;
    }
    const v = r.generator();
    await persistSetting(pool, r.key, v, r.secret);
    process.env[r.key] = v;
    generated[r.key] = { source: 'generated', value: v };
  }
  return generated;
}

async function gapAnalysis(pool) {
  const checks = [];
  const has = (k) => !!process.env[k];
  const need = (key, what, severity) => checks.push({ key, what, severity, set: has(key) });
  // Required (will not boot reliably without)
  need('DATABASE_URL', 'Postgres connection string', 'critical');
  need('IDENTITY_MASTER_KEK', 'Master encryption key for identities', 'critical');
  need('CRYPTO_MASTER_KEK', 'Master encryption key for wallets', 'critical');
  need('OPERATOR_ADMIN_TOKEN', 'Admin gate token', 'critical');
  need('INTERNAL_API_KEY', 'Internal services API key', 'critical');
  need('CRON_SECRET', 'Cron job auth', 'critical');
  need('OPERATOR_PUBLIC_URL', 'Public URL for callbacks', 'high');
  // Revenue
  need('STRIPE_SECRET_KEY', 'Stripe — required for paid signups', 'high');
  need('STRIPE_WEBHOOK_SECRET', 'Stripe webhook signature verify', 'high');
  need('STRIPE_PRICE_PRO_MONTHLY', 'Stripe Pro tier price ID', 'high');
  // Inference (at least one)
  const anyInference = ['ANTHROPIC_API_KEY','OPENAI_API_KEY','GOOGLE_API_KEY','MISTRAL_API_KEY','TOGETHER_API_KEY'].some(has);
  checks.push({ key: 'inference_provider', what: 'At least one LLM provider configured', severity: 'high', set: anyInference });
  // KYC (at least one)
  const anyKyc = ['ONFIDO_API_TOKEN','PERSONA_API_KEY','SUMSUB_APP_TOKEN'].some(has);
  checks.push({ key: 'kyc_provider', what: 'KYC provider (or in-house kyc_core)', severity: 'medium', set: anyKyc });
  // Email
  const anyEmail = ['SENDGRID_API_KEY'].some(has);
  checks.push({ key: 'email_provider', what: 'Email provider (or in-house email_core)', severity: 'medium', set: anyEmail });
  // Compliance
  need('SENTRY_DSN', 'Sentry for error tracking', 'low');
  need('DATADOG_API_KEY', 'Datadog for metrics', 'low');
  // Aggregate
  const critical_missing = checks.filter(c => c.severity === 'critical' && !c.set);
  const high_missing = checks.filter(c => c.severity === 'high' && !c.set);
  const ready = critical_missing.length === 0;
  return {
    ready, critical_missing, high_missing,
    total_checks: checks.length,
    configured: checks.filter(c => c.set).length,
    checks
  };
}

function renderSetupPage(status) {
  const fmt = (b) => b ? '<span style="color:#22c55e">✓ set</span>' : '<span style="color:#ef4444">✗ missing</span>';
  return `<!doctype html><html><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>Setup Wizard — OpenHeab</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Inter', sans-serif; background: #0a0a0f; color: #e7e7ee; line-height: 1.6; }
.wrap { max-width: 860px; margin: 0 auto; padding: 48px 24px 80px; }
h1 { font-size: 36px; font-weight: 700; letter-spacing: -0.8px; margin-bottom: 10px; }
.subtitle { color: #888; font-size: 16px; margin-bottom: 32px; max-width: 640px; }
.banner { background: ${status.ready ? '#22c55e15' : '#eab30815'}; border-left: 3px solid ${status.ready ? '#22c55e' : '#eab308'}; padding: 18px 22px; border-radius: 8px; margin-bottom: 32px; }
.banner b { color: ${status.ready ? '#22c55e' : '#eab308'}; }
.step { background: #14141c; border: 1px solid #1f1f2a; border-radius: 12px; padding: 24px 28px; margin-bottom: 16px; }
.step h2 { font-size: 18px; margin-bottom: 8px; display: flex; align-items: center; gap: 10px; }
.step .num { background: #4f46e5; color: #fff; width: 26px; height: 26px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; font-size: 13px; font-weight: 700; }
.step p { color: #aaa; font-size: 14px; margin-bottom: 14px; }
input { width: 100%; padding: 11px 14px; background: #0f0f17; border: 1px solid #1f1f2a; color: #fff; border-radius: 8px; font-family: monospace; font-size: 13px; outline: none; margin-bottom: 10px; }
input:focus { border-color: #4f46e5; }
button { padding: 10px 18px; background: #4f46e5; color: #fff; border: 0; border-radius: 6px; font-weight: 600; cursor: pointer; font-size: 13px; }
button:hover { background: #4338ca; }
button:disabled { opacity: 0.5; cursor: not-allowed; }
button.secondary { background: #1a1a25; color: #ccc; border: 1px solid #25253a; }
.checks { font-family: monospace; font-size: 12px; margin: 16px 0; }
.checks div { padding: 6px 0; display: flex; justify-content: space-between; border-bottom: 1px solid #1a1a25; }
.checks div:last-child { border: 0; }
.checks .key { color: #aaa; }
.result { font-family: monospace; font-size: 12px; padding: 12px 14px; background: #0a0a12; border: 1px solid #20202a; border-radius: 6px; margin-top: 10px; word-break: break-all; max-height: 220px; overflow-y: auto; white-space: pre-wrap; display: none; }
.result.show { display: block; }
.result.error { border-color: #ef444440; color: #fca5a5; }
.result.success { border-color: #22c55e40; color: #86efac; }
.actions { display: flex; gap: 8px; margin-top: 8px; }
.token-input { display: flex; gap: 8px; align-items: center; margin-bottom: 12px; }
.token-input input { flex: 1; }
.footer { color: #555; font-size: 13px; margin-top: 48px; text-align: center; }
</style></head><body>

<div class="wrap">
<h1>OpenHeab Setup</h1>
<p class="subtitle">Zero-human-in-loop setup. Paste credentials below — we auto-create Stripe products, verify provider keys, persist the lot. Idempotent — re-run anytime.</p>

<div class="banner">
  <b>${status.ready ? 'Substrate is launch-ready.' : status.critical_missing.length + ' critical settings missing.'}</b>
  ${status.configured}/${status.total_checks} settings configured · ${status.high_missing.length} high-priority + ${status.critical_missing.length} critical gaps
</div>

<div class="token-input">
  <input id="admin-token" type="password" placeholder="OPERATOR_ADMIN_TOKEN (required for setup actions below)" />
  <button class="secondary" onclick="testAdmin()">Test</button>
</div>

<div class="step">
  <h2><span class="num">1</span>Bootstrap (zero-config first boot)</h2>
  <p>Auto-generates IDENTITY_MASTER_KEK, CRYPTO_MASTER_KEK, BANK_MASTER_KEK, OPERATOR_ADMIN_TOKEN, CRON_SECRET, INTERNAL_API_KEY. Persists to <code>setup_state</code>. Save the values; restart the process to pick them up from env.</p>
  <button onclick="run('/v1/admin/setup/bootstrap', {}, 'bootstrap')">Generate all required secrets</button>
  <div class="result" id="r-bootstrap"></div>
</div>

<div class="step">
  <h2><span class="num">2</span>Stripe — auto-create products + prices + webhook</h2>
  <p>Paste your Stripe secret key. We call the Stripe API to create the 4 tier products (Starter $19, Pro $99, Team $349, Enterprise $2,499), 1 monthly price per tier, and a webhook endpoint pointing to <code>/v1/_webhooks/stripe</code>. Webhook secret persisted automatically.</p>
  <input id="stripe-sk" type="password" placeholder="sk_live_... or sk_test_..." />
  <button onclick="run('/v1/admin/setup/stripe', { secret_key: document.getElementById('stripe-sk').value, public_url: location.origin }, 'stripe')">Auto-provision Stripe</button>
  <div class="result" id="r-stripe"></div>
</div>

<div class="step">
  <h2><span class="num">3</span>SendGrid — verify + persist</h2>
  <p>Paste a SendGrid API key with at least <code>mail.send</code> scope. We verify it then persist for transactional emails.</p>
  <input id="sg-key" type="password" placeholder="SG.xxx..." />
  <button onclick="run('/v1/admin/setup/sendgrid', { api_key: document.getElementById('sg-key').value }, 'sg')">Verify + persist</button>
  <div class="result" id="r-sg"></div>
</div>

<div class="step">
  <h2><span class="num">4</span>OAuth providers</h2>
  <p>Paste OAuth client_id + client_secret for any of Google / GitHub / Microsoft. We persist + enable the sign-in flow at <code>/auth/oauth/:provider/start</code>.</p>
  <select id="oauth-provider" style="padding:10px 14px;background:#0f0f17;border:1px solid #1f1f2a;color:#fff;border-radius:8px;font-size:13px;margin-bottom:10px">
    <option value="google">Google</option>
    <option value="github">GitHub</option>
    <option value="microsoft">Microsoft</option>
  </select>
  <input id="oauth-id" placeholder="client_id" />
  <input id="oauth-secret" type="password" placeholder="client_secret" />
  <button onclick="run('/v1/admin/setup/oauth/' + document.getElementById('oauth-provider').value, { client_id: document.getElementById('oauth-id').value, client_secret: document.getElementById('oauth-secret').value }, 'oauth')">Persist OAuth credentials</button>
  <div class="result" id="r-oauth"></div>
</div>

<div class="step">
  <h2><span class="num">5</span>Current configuration</h2>
  <p>Live state of every check the substrate needs:</p>
  <div class="checks">
${status.checks.map(c => `    <div><span class="key">${c.key} <small style="color:#666">(${c.severity})</small></span>${fmt(c.set)}</div>`).join('')}
  </div>
  <div class="actions">
    <button class="secondary" onclick="location.reload()">Refresh status</button>
    <button onclick="run('/v1/admin/setup/status', null, 'status', 'GET')">Re-check via API</button>
  </div>
  <div class="result" id="r-status"></div>
</div>

<div class="footer">
  All actions are idempotent. Re-run anytime. <a href="/runbook" style="color:#888">SRE runbook</a> · <a href="/trust" style="color:#888">Trust center</a>
</div>

</div>
<script>
function adminHeader() {
  const t = document.getElementById('admin-token').value.trim();
  return t ? { 'x-admin-token': t } : {};
}
function setResult(id, html, kind) {
  const el = document.getElementById('r-' + id);
  el.classList.add('show');
  el.classList.remove('error', 'success');
  if (kind) el.classList.add(kind);
  el.textContent = typeof html === 'string' ? html : JSON.stringify(html, null, 2);
}
async function run(path, body, id, method) {
  setResult(id, 'Running...', null);
  try {
    const opts = {
      method: method || 'POST',
      headers: { 'content-type': 'application/json', ...adminHeader() }
    };
    if (body !== null && method !== 'GET') opts.body = JSON.stringify(body || {});
    const r = await fetch(path, opts);
    const j = await r.json().catch(() => ({ raw: 'non-json' }));
    setResult(id, j, r.ok ? 'success' : 'error');
  } catch (e) {
    setResult(id, 'Error: ' + e.message, 'error');
  }
}
async function testAdmin() {
  const r = await fetch('/v1/admin/setup/status', { headers: adminHeader() });
  alert(r.ok ? 'Admin token works ✓' : 'Auth failed (status ' + r.status + ')');
}
</script>
</body></html>`;
}

function registerAutoProvisionRoutes(app, pool, verifyAgentAuth, auditChain) {
  const express = require('express');

  // GET /setup — polished wizard (also exists at /setup via quickstart, this replaces with richer UI)
  app.get('/setup-wizard', async (req, res) => {
    const status = await gapAnalysis(pool);
    res.set('content-type', 'text/html; charset=utf-8');
    res.set('cache-control', 'no-store');
    res.send(renderSetupPage(status));
  });

  // POST /v1/admin/setup/bootstrap — first-boot zero-config
  app.post('/v1/admin/setup/bootstrap', express.json(), async (req, res) => {
    // Allow on first boot (no admin token configured yet) OR with admin token
    if (!isFirstBoot() && !isAdmin(req)) {
      return res.status(401).json({ error: 'admin_required', note: 'After first bootstrap, OPERATOR_ADMIN_TOKEN is required.' });
    }
    try {
      const generated = await runBootstrap(pool);
      await recordRun(pool, 'bootstrap', 'ok', { keys_generated: Object.keys(generated) });
      if (auditChain) auditChain.append({ event_type: 'setup.bootstrap', keys: Object.keys(generated) }).catch(() => {});
      res.json({
        ok: true,
        message: 'Bootstrap complete. Save these values to your env (or rely on substrate to hydrate them from setup_state on next boot).',
        generated,
        next_steps: [
          'Save OPERATOR_ADMIN_TOKEN somewhere safe — you need it for /admin and future setup endpoints',
          'Run POST /v1/admin/setup/stripe with your Stripe secret key',
          'Run POST /v1/admin/setup/sendgrid with your SendGrid API key',
          'Restart substrate or trust setup_state hydration'
        ]
      });
    } catch (e) {
      await recordRun(pool, 'bootstrap', 'failed', { error: e.message });
      res.status(500).json({ error: 'bootstrap_failed', message: e.message });
    }
  });

  // POST /v1/admin/setup/stripe
  app.post('/v1/admin/setup/stripe', express.json(), async (req, res) => {
    if (!isAdmin(req)) return res.status(401).json({ error: 'admin_required' });
    try {
      const result = await autoProvisionStripe(pool, {
        secretKey: req.body?.secret_key,
        publicUrl: req.body?.public_url
      });
      await recordRun(pool, 'stripe', 'ok', { products: Object.keys(result.products).length, prices: Object.keys(result.prices).length });
      if (auditChain) auditChain.append({ event_type: 'setup.stripe_provisioned', products: result.products, prices: result.prices, webhook_url: result.webhook?.url }).catch(() => {});
      res.json({ ok: true, ...result });
    } catch (e) {
      await recordRun(pool, 'stripe', 'failed', { error: e.message });
      res.status(400).json({ error: 'stripe_provision_failed', message: e.message });
    }
  });

  // POST /v1/admin/setup/sendgrid
  app.post('/v1/admin/setup/sendgrid', express.json(), async (req, res) => {
    if (!isAdmin(req)) return res.status(401).json({ error: 'admin_required' });
    try {
      const result = await autoProvisionSendGrid(pool, { apiKey: req.body?.api_key });
      await recordRun(pool, 'sendgrid', 'ok', result);
      if (auditChain) auditChain.append({ event_type: 'setup.sendgrid_provisioned' }).catch(() => {});
      res.json({ ok: true, ...result });
    } catch (e) {
      await recordRun(pool, 'sendgrid', 'failed', { error: e.message });
      res.status(400).json({ error: 'sendgrid_provision_failed', message: e.message });
    }
  });

  // POST /v1/admin/setup/oauth/:provider
  app.post('/v1/admin/setup/oauth/:provider', express.json(), async (req, res) => {
    if (!isAdmin(req)) return res.status(401).json({ error: 'admin_required' });
    try {
      const result = await autoProvisionOauth(pool, req.params.provider, {
        clientId: req.body?.client_id,
        clientSecret: req.body?.client_secret
      });
      await recordRun(pool, 'oauth_' + req.params.provider, 'ok', result);
      if (auditChain) auditChain.append({ event_type: 'setup.oauth_provisioned', provider: req.params.provider }).catch(() => {});
      res.json({ ok: true, ...result });
    } catch (e) {
      await recordRun(pool, 'oauth_' + req.params.provider, 'failed', { error: e.message });
      res.status(400).json({ error: 'oauth_provision_failed', message: e.message });
    }
  });

  // GET /v1/admin/setup/status — gap analysis (admin-only because it reveals env state)
  app.get('/v1/admin/setup/status', async (req, res) => {
    if (!isAdmin(req)) return res.status(401).json({ error: 'admin_required' });
    const status = await gapAnalysis(pool);
    res.set('cache-control', 'private, no-store');
    res.json(status);
  });

  // GET /v1/admin/setup/runs — history of provision runs
  app.get('/v1/admin/setup/runs', async (req, res) => {
    if (!isAdmin(req)) return res.status(401).json({ error: 'admin_required' });
    const r = await pool.query(
      `SELECT run_id, kind, status, result, ran_at FROM setup_runs ORDER BY ran_at DESC LIMIT 100`
    ).catch(() => ({ rows: [] }));
    res.json({ runs: r.rows });
  });

  // On boot: hydrate any persisted setup_state into process.env so the substrate
  // is "ready" without operator restart. Best-effort, non-blocking.
  (async () => {
    try {
      const r = await pool.query(`SELECT key, value FROM setup_state`).catch(() => ({ rows: [] }));
      for (const row of r.rows) {
        if (!process.env[row.key]) process.env[row.key] = row.value;
      }
    } catch {}
  })();
}

module.exports = {
  migrate, registerAutoProvisionRoutes,
  autoProvisionStripe, autoProvisionSendGrid, autoProvisionOauth,
  runBootstrap, gapAnalysis
};
