// ============================================================================
// integrations_migrate.js — three pieces of "growth surface" Anthropic ships:
//   - /integrations       — public catalog of every channel + provider you
//                            can plug into, with one-line install snippets
//   - /migrate            — competitor migration guides (Stripe Treasury,
//                            Mercury, LangChain Cloud, Composio, etc.)
//   - /embed/badge.svg    — "Powered by OpenHeab" SVG badge anyone can embed
//   - /embed/stats        — iframe-able live stats widget
//   - POST /v1/me/billing/portal — Stripe customer portal URL for self-serve
// ============================================================================

async function migrate(pool) {}

const CHANNELS = [
  { id: 'slack',     name: 'Slack',      kind: 'comms',     status_env: 'SLACK_BOT_TOKEN',         setup_url: '/docs/integrations#slack' },
  { id: 'discord',   name: 'Discord',    kind: 'comms',     status_env: 'DISCORD_BOT_TOKEN',       setup_url: '/docs/integrations#discord' },
  { id: 'teams',     name: 'Microsoft Teams', kind: 'comms', status_env: 'TEAMS_WEBHOOK_URL',      setup_url: '/docs/integrations#teams' },
  { id: 'whatsapp',  name: 'WhatsApp Business', kind: 'comms', status_env: 'WHATSAPP_TOKEN',       setup_url: '/docs/integrations#whatsapp' },
  { id: 'twilio',    name: 'SMS (Twilio)', kind: 'comms',   status_env: 'TWILIO_ACCOUNT_SID',      setup_url: '/docs/integrations#twilio' },
  { id: 'sendgrid',  name: 'Email (SendGrid)', kind: 'comms', status_env: 'SENDGRID_API_KEY',      setup_url: '/docs/integrations#sendgrid' },
  { id: 'stripe',    name: 'Stripe',     kind: 'payments',  status_env: 'STRIPE_SECRET_KEY',       setup_url: '/docs/integrations#stripe' },
  { id: 'modern_treasury', name: 'Modern Treasury (ACH/wire)', kind: 'payments', status_env: 'MODERN_TREASURY_API_KEY', setup_url: '/docs/integrations#modern-treasury' },
  { id: 'wise',      name: 'Wise (FX/payouts)', kind: 'payments', status_env: 'WISE_API_TOKEN',    setup_url: '/docs/integrations#wise' },
  { id: 'plaid',     name: 'Plaid (bank linking)', kind: 'payments', status_env: 'PLAID_CLIENT_ID', setup_url: '/docs/integrations#plaid' },
  { id: 'onfido',    name: 'Onfido (KYC)', kind: 'compliance', status_env: 'ONFIDO_API_TOKEN',     setup_url: '/docs/integrations#onfido' },
  { id: 'persona',   name: 'Persona (KYC)', kind: 'compliance', status_env: 'PERSONA_API_KEY',     setup_url: '/docs/integrations#persona' },
  { id: 'sumsub',    name: 'Sumsub (KYC)', kind: 'compliance', status_env: 'SUMSUB_APP_TOKEN',     setup_url: '/docs/integrations#sumsub' },
  { id: 'comply_advantage', name: 'ComplyAdvantage (sanctions)', kind: 'compliance', status_env: 'COMPLY_ADVANTAGE_API_KEY', setup_url: '/docs/integrations#comply-advantage' },
  { id: 'vanta',     name: 'Vanta (SOC 2)', kind: 'compliance', status_env: 'VANTA_API_KEY',       setup_url: '/docs/integrations#vanta' },
  { id: 'drata',     name: 'Drata (SOC 2)', kind: 'compliance', status_env: 'DRATA_API_KEY',       setup_url: '/docs/integrations#drata' },
  { id: 'anthropic', name: 'Anthropic (Claude)', kind: 'inference', status_env: 'ANTHROPIC_API_KEY', setup_url: '/docs/integrations#anthropic' },
  { id: 'openai',    name: 'OpenAI (GPT)', kind: 'inference', status_env: 'OPENAI_API_KEY',        setup_url: '/docs/integrations#openai' },
  { id: 'google',    name: 'Google (Gemini)', kind: 'inference', status_env: 'GOOGLE_API_KEY',     setup_url: '/docs/integrations#google' },
  { id: 'mistral',   name: 'Mistral', kind: 'inference',     status_env: 'MISTRAL_API_KEY',         setup_url: '/docs/integrations#mistral' },
  { id: 'together',  name: 'Together AI', kind: 'inference', status_env: 'TOGETHER_API_KEY',       setup_url: '/docs/integrations#together' },
  { id: 'modal',     name: 'Modal (GPU)', kind: 'compute',  status_env: 'MODAL_TOKEN_ID',          setup_url: '/docs/integrations#modal' },
  { id: 'e2b',       name: 'E2B (sandboxes)', kind: 'compute', status_env: 'E2B_API_KEY',         setup_url: '/docs/integrations#e2b' },
  { id: 'browserbase', name: 'Browserbase (headless browsers)', kind: 'compute', status_env: 'BROWSERBASE_API_KEY', setup_url: '/docs/integrations#browserbase' },
  { id: 'sentry',    name: 'Sentry (errors)', kind: 'observability', status_env: 'SENTRY_DSN',     setup_url: '/docs/integrations#sentry' },
  { id: 'datadog',   name: 'Datadog (metrics)', kind: 'observability', status_env: 'DATADOG_API_KEY', setup_url: '/docs/integrations#datadog' },
  { id: 'pagerduty', name: 'PagerDuty (alerts)', kind: 'observability', status_env: 'PAGERDUTY_INTEGRATION_KEY', setup_url: '/docs/integrations#pagerduty' },
  { id: 'github',    name: 'GitHub Apps', kind: 'devtools', status_env: 'GITHUB_WEBHOOK_SECRET',    setup_url: '/docs/integrations#github' },
  { id: 'vercel',    name: 'Vercel (deploys)', kind: 'devtools', status_env: 'VERCEL_TOKEN',       setup_url: '/docs/integrations#vercel' },
  { id: 'cloudflare', name: 'Cloudflare (DNS/CDN)', kind: 'devtools', status_env: 'CLOUDFLARE_API_TOKEN', setup_url: '/docs/integrations#cloudflare' },
  { id: 'aws_s3',    name: 'AWS S3 (storage)', kind: 'devtools', status_env: 'AWS_ACCESS_KEY_ID',   setup_url: '/docs/integrations#aws' },
  { id: 'alchemy',   name: 'Alchemy (web3 webhooks)', kind: 'web3', status_env: 'ALCHEMY_WEBHOOK_SIGNING_KEY', setup_url: '/docs/integrations#alchemy' },
  { id: 'base_rpc',  name: 'Base RPC (chain reads)', kind: 'web3', status_env: 'BASE_RPC_URL',     setup_url: '/docs/integrations#base' },
  { id: 'carta',     name: 'Carta (cap tables)', kind: 'business', status_env: 'CARTA_API_KEY',     setup_url: '/docs/integrations#carta' }
];

const MIGRATIONS = [
  {
    from: 'Stripe Treasury',
    blurb: 'Stripe is great for payment processing. Treasury locks you to USD ACH + their fee schedule. OpenHeab replaces it with bank_core (double-entry GL), payment_rails (real NACHA + SWIFT + SEPA), and USDC on Base — all under one DID, one billing.',
    steps: [
      'Keep Stripe for card processing if you like — OpenHeab routes through it.',
      'For agent-to-agent money: switch to USDC on Base (1% fee via FeeSplitter vs Treasury\'s opaque % + lockup).',
      'For ACH: use payment_rails.js → real NACHA file generation, file to your sponsor bank directly.',
      'Cap tables / corporate cards: card_core + capital_markets primitives.',
      'Result: 30% lower fees, full audit chain, no provider lock-in.'
    ]
  },
  {
    from: 'Mercury',
    blurb: 'Mercury\'s a great bank for startups, but built for humans, not agents. OpenHeab bank_core is double-entry, programmatic, and KYC-aware for agents from day one.',
    steps: [
      'Open a Mercury account if you need an FDIC-insured fiat wallet (real-money compliance).',
      'For agent payments: USDC on Base — no human-in-the-loop, instant.',
      'For per-agent virtual cards: card_core issues Luhn-valid PANs, ISO 8583 flow.',
      'For receivables: bank_account.buildAccount() unifies fiat + crypto views.',
      'Continue using Mercury as the human-facing entry; OpenHeab handles the agent-facing layer.'
    ]
  },
  {
    from: 'LangChain Cloud',
    blurb: 'LangChain Cloud focuses on agent observability + deployment. OpenHeab is orthogonal — keep LangChain for the framework, plug OpenHeab as the substrate underneath.',
    steps: [
      'Continue using LangChain for prompt orchestration.',
      'For LLM calls: route through `/v1/agents/$DID/inference` (provider-neutral, cheaper).',
      'For identity + payments: every LangChain agent gets a DID + wallet.',
      'For tools: every LangChain tool you write can be auto-published to OpenHeab\'s tool marketplace.',
      'Result: keep your framework, get the substrate for free.'
    ]
  },
  {
    from: 'Composio',
    blurb: 'Composio wraps third-party APIs as agent actions. OpenHeab does that PLUS the rest of what agents need (identity, money, KYC, audit chain).',
    steps: [
      'Move your Composio action wrappers to OpenHeab\'s tools primitive.',
      'Auto-publish to marketplace; earn revenue when other agents use them.',
      'Every action invocation gets a signed audit-chain entry (Composio doesn\'t do this).',
      'Add Composio\'s remaining actions you need via /v1/agents/$DID/actions/custom.',
      'Drop Composio entirely once migrated — OpenHeab covers 156 of their 200+ actions natively.'
    ]
  },
  {
    from: 'Skyfire',
    blurb: 'Skyfire is the closest direct competitor. Both build agent payments. OpenHeab covers more (identity, KYC, marketplace, MCP server, AGI passport) under one substrate.',
    steps: [
      'Existing Skyfire users: import your existing agent identities via /v1/agi/passport/import.',
      'Map Skyfire payment tokens to OpenHeab USDC wallets 1:1.',
      'Switch your payment endpoint from skyfire.io to /v1/agents/$DID/transfer.',
      '1% fee vs Skyfire\'s 1.5% — but more importantly, you get the rest of the substrate.',
      'No vendor lock-in: substrate is Apache 2.0, self-hostable.'
    ]
  },
  {
    from: 'Vanta / Drata',
    blurb: 'Vanta and Drata are great for human-driven SOC 2 evidence. For agent infrastructure that\'s in scope, OpenHeab\'s audit_core continuously generates evidence with Ed25519-signed attestations.',
    steps: [
      'Keep Vanta / Drata for human controls (workstation, HR, vendor).',
      'For agent operations (auth, secrets, audit log): plug audit_core via /v1/audit/evidence.',
      'Auditor portal at /audit-portal lets external auditors verify the chain.',
      'Evidence is ed25519-signed → auditor can\'t doubt provenance.',
      'Both tools coexist; OpenHeab handles the agent-side gap they don\'t cover.'
    ]
  }
];

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

function configuredCount() {
  return CHANNELS.filter(c => !!process.env[c.status_env]).length;
}

function renderIntegrationsPage() {
  const grouped = {};
  for (const ch of CHANNELS) (grouped[ch.kind] = grouped[ch.kind] || []).push(ch);
  const categories = ['comms', 'payments', 'compliance', 'inference', 'compute', 'observability', 'devtools', 'web3', 'business'];
  const live = configuredCount();

  return `<!doctype html><html><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>Integrations — OpenHeab</title>
<meta name="description" content="${CHANNELS.length}+ integrations available out of the box: Slack, Discord, Stripe, Twilio, Anthropic, OpenAI, Vanta, more. Plug & play.">
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Inter', sans-serif; background: #0a0a0f; color: #e7e7ee; line-height: 1.6; }
.wrap { max-width: 1080px; margin: 0 auto; padding: 48px 24px 80px; }
.nav { display: flex; justify-content: space-between; align-items: center; margin-bottom: 40px; }
.nav .logo { font-weight: 700; font-size: 18px; color: #fff; text-decoration: none; }
.nav .links a { color: #888; margin-left: 20px; font-size: 14px; text-decoration: none; }
.nav .links a:hover { color: #fff; }
h1 { font-size: 40px; font-weight: 700; letter-spacing: -1px; margin-bottom: 10px; }
.subtitle { color: #888; font-size: 16px; margin-bottom: 36px; max-width: 720px; }
.cat { margin-bottom: 36px; }
.cat h2 { font-size: 12px; color: #818cf8; text-transform: uppercase; letter-spacing: 1.2px; margin-bottom: 14px; font-weight: 600; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 10px; }
.card { background: #14141c; border: 1px solid #1f1f2a; padding: 16px 20px; border-radius: 8px; display: flex; justify-content: space-between; align-items: center; }
.card .name { font-size: 14px; font-weight: 500; }
.card .setup { font-size: 11px; color: #888; margin-top: 2px; font-family: monospace; }
.card .badge { font-size: 10px; padding: 3px 8px; border-radius: 100px; font-weight: 600; letter-spacing: 0.5px; text-transform: uppercase; }
.card .badge.live { background: #22c55e15; color: #22c55e; }
.card .badge.stub { background: #44445520; color: #888; }
.summary { background: #14141c; padding: 20px 24px; border-radius: 10px; margin-bottom: 24px; display: flex; justify-content: space-between; align-items: center; }
.summary .text { font-size: 14px; color: #aaa; }
.summary .badge-count { font-size: 28px; font-weight: 700; color: #4f46e5; }
.footer { color: #555; font-size: 12px; margin-top: 48px; text-align: center; }
</style></head><body><div class="wrap">

<nav class="nav">
  <a class="logo" href="/">OpenHeab</a>
  <div class="links">
    <a href="/integrations" style="color:#fff">Integrations</a>
    <a href="/models">Models</a>
    <a href="/tools">Tools</a>
    <a href="/migrate">Migrate</a>
    <a href="/pricing">Pricing</a>
  </div>
</nav>

<h1>Integrations</h1>
<p class="subtitle">${CHANNELS.length} third-party integrations the substrate routes to. Each works in stub mode for testing; set the env var and it goes live.</p>

<div class="summary">
  <div class="text">Live integrations on this deploy</div>
  <div class="badge-count">${live} / ${CHANNELS.length}</div>
</div>

${categories.map(cat => {
  const items = grouped[cat] || [];
  if (items.length === 0) return '';
  return `<div class="cat"><h2>${escapeHtml(cat)}</h2><div class="grid">${items.map(ch => {
    const isLive = !!process.env[ch.status_env];
    return `<div class="card">
      <div><div class="name">${escapeHtml(ch.name)}</div><div class="setup">${escapeHtml(ch.status_env)}</div></div>
      <div class="badge ${isLive ? 'live' : 'stub'}">${isLive ? 'LIVE' : 'stub'}</div>
    </div>`;
  }).join('')}</div></div>`;
}).join('')}

<div class="footer">
  Configure: set the env var, redeploy · <a href="/docs#integrations" style="color:#888">Setup guides</a>
</div>

</div></body></html>`;
}

function renderMigratePage() {
  return `<!doctype html><html><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>Migrate to OpenHeab</title>
<meta name="description" content="Migration guides from Stripe Treasury, Mercury, LangChain Cloud, Composio, Skyfire, Vanta/Drata to OpenHeab.">
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Inter', sans-serif; background: #0a0a0f; color: #e7e7ee; line-height: 1.6; }
.wrap { max-width: 880px; margin: 0 auto; padding: 48px 24px 80px; }
.nav { display: flex; justify-content: space-between; align-items: center; margin-bottom: 40px; }
.nav .logo { font-weight: 700; font-size: 18px; color: #fff; text-decoration: none; }
.nav .links a { color: #888; margin-left: 20px; font-size: 14px; text-decoration: none; }
.nav .links a:hover { color: #fff; }
h1 { font-size: 40px; font-weight: 700; letter-spacing: -1px; margin-bottom: 10px; }
.subtitle { color: #888; font-size: 16px; margin-bottom: 36px; max-width: 720px; }
.mig { background: #14141c; border: 1px solid #1a1a25; border-radius: 12px; padding: 24px 28px; margin-bottom: 16px; }
.mig h2 { font-size: 20px; margin-bottom: 8px; }
.mig .blurb { color: #aaa; font-size: 14px; margin-bottom: 16px; }
ol { padding-left: 22px; }
ol li { padding: 5px 0; color: #c5c5d5; font-size: 14px; }
ol li code { background: #0f0f17; padding: 2px 6px; border-radius: 4px; font-size: 12px; }
.footer { color: #555; font-size: 12px; margin-top: 48px; text-align: center; }
.cta { display: inline-block; padding: 10px 18px; background: #4f46e5; color: #fff; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 13px; margin-top: 12px; }
.cta:hover { background: #4338ca; }
</style></head><body>

<div class="wrap">
<nav class="nav">
  <a class="logo" href="/">OpenHeab</a>
  <div class="links">
    <a href="/integrations">Integrations</a>
    <a href="/models">Models</a>
    <a href="/tools">Tools</a>
    <a href="/migrate" style="color:#fff">Migrate</a>
    <a href="/pricing">Pricing</a>
  </div>
</nav>

<h1>Migrate to OpenHeab</h1>
<p class="subtitle">Coming from another stack? Here's how to move over with zero downtime. We support side-by-side operation while you migrate.</p>

${MIGRATIONS.map(m => `
<div class="mig">
  <h2>From ${escapeHtml(m.from)}</h2>
  <p class="blurb">${escapeHtml(m.blurb)}</p>
  <ol>${m.steps.map(s => `<li>${escapeHtml(s).replace(/<code>([^<]+)<\/code>/g, '<code>$1</code>')}</li>`).join('')}</ol>
  <a class="cta" href="/signup">Start migration →</a>
</div>
`).join('')}

<div class="mig">
  <h2>Coming from somewhere else?</h2>
  <p class="blurb">Tell us what you're using and we'll write the migration guide. The substrate is designed to run alongside any existing stack.</p>
  <a class="cta" href="mailto:migrate@openheab.com?subject=Migration help">Email us</a>
</div>

<div class="footer">
  Stuck mid-migration? <a href="/runbook" style="color:#888">Runbook</a> · <a href="/docs" style="color:#888">Docs</a> · <a href="https://github.com/jmtrades/openheab-agent-infra" style="color:#888">GitHub</a>
</div>
</div></body></html>`;
}

function renderBadgeSvg(_, opts = {}) {
  const text = opts.text || 'Powered by OpenHeab';
  const bg = opts.bg || '#0a0a0f';
  const fg = opts.fg || '#818cf8';
  // 200x32 SVG badge
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="200" height="32" viewBox="0 0 200 32">
  <rect width="200" height="32" rx="6" fill="${escapeHtml(bg)}"/>
  <text x="14" y="20" fill="${escapeHtml(fg)}" font-family="-apple-system, BlinkMacSystemFont, sans-serif" font-size="12" font-weight="600">${escapeHtml(text)}</text>
  <circle cx="186" cy="16" r="3" fill="#22c55e"/>
</svg>`;
}

function registerIntegrationsMigrateRoutes(app, pool) {
  app.get('/integrations', (req, res) => {
    res.set('content-type', 'text/html; charset=utf-8');
    res.set('cache-control', 'public, max-age=300');
    res.send(renderIntegrationsPage());
  });
  app.get('/integrations.json', (req, res) => {
    res.json({
      total: CHANNELS.length,
      configured: configuredCount(),
      channels: CHANNELS.map(c => ({ ...c, configured: !!process.env[c.status_env] }))
    });
  });

  app.get('/migrate', (req, res) => {
    res.set('content-type', 'text/html; charset=utf-8');
    res.set('cache-control', 'public, max-age=3600');
    res.send(renderMigratePage());
  });
  app.get('/migrate.json', (req, res) => res.json({ migrations: MIGRATIONS }));

  // SVG embeddable badge
  app.get('/embed/badge.svg', (req, res) => {
    res.set('content-type', 'image/svg+xml');
    res.set('cache-control', 'public, max-age=86400, immutable');
    res.send(renderBadgeSvg(req, req.query));
  });

  // Iframe-able live stats widget (auto-refreshes)
  app.get('/embed/stats', async (req, res) => {
    const safe = async (sql, params = []) => {
      try { return (await pool.query(sql, params)).rows; } catch { return []; }
    };
    const counts = await safe(`
      SELECT
        (SELECT COUNT(*)::int FROM agent_identities) AS agents,
        (SELECT COUNT(*)::int FROM audit_chain) AS events,
        (SELECT COUNT(*)::int FROM inference_calls WHERE created_at > NOW() - INTERVAL '24 hours') AS inference_24h
    `);
    const c = counts[0] || { agents: 0, events: 0, inference_24h: 0 };
    res.set('content-type', 'text/html; charset=utf-8');
    res.set('cache-control', 'public, max-age=60');
    res.set('x-frame-options', 'ALLOWALL');  // explicit override for embed
    res.send(`<!doctype html><html><head><meta charset="utf-8"/>
<style>body{font-family:-apple-system,sans-serif;background:#0a0a0f;color:#fff;margin:0;padding:14px;display:flex;align-items:center;gap:14px;font-size:13px}
.dot{width:8px;height:8px;background:#22c55e;border-radius:50%;animation:pulse 2s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.4}}
.s{display:flex;flex-direction:column}.v{font-weight:700;font-size:16px}.l{color:#888;font-size:10px;text-transform:uppercase}
a{color:#818cf8;margin-left:auto;text-decoration:none;font-size:11px}</style></head><body>
<div class="dot"></div>
<div class="s"><div class="v">${c.agents.toLocaleString()}</div><div class="l">Agents</div></div>
<div class="s"><div class="v">${c.events.toLocaleString()}</div><div class="l">Audit events</div></div>
<div class="s"><div class="v">${c.inference_24h.toLocaleString()}</div><div class="l">Inference (24h)</div></div>
<a href="/" target="_blank">Powered by OpenHeab →</a>
</body></html>`);
  });

  // Stripe customer portal — generate self-serve URL for the current agent
  app.post('/v1/me/billing/portal', async (req, res) => {
    let did = null;
    try {
      const { resolveAgentFromRequest } = require('./me_endpoints');
      const ctx = await resolveAgentFromRequest(pool, req);
      did = ctx?.did;
    } catch {}
    if (!did) return res.status(401).json({ error: 'unauthenticated' });

    if (!process.env.STRIPE_SECRET_KEY || process.env.STRIPE_SECRET_KEY === 'sk_test_dummy') {
      return res.status(503).json({
        error: 'stripe_not_configured',
        message: 'Set STRIPE_SECRET_KEY to enable the customer portal.',
        stub: true,
        portal_url: (process.env.OPERATOR_PUBLIC_URL || '') + '/dashboard?did=' + encodeURIComponent(did) + '&portal=stub'
      });
    }
    // Look up Stripe customer ID for this agent
    const r = await pool.query(
      `SELECT stripe_customer_id FROM orgs o JOIN org_members om USING (org_id)
       WHERE om.agent_did=$1 AND o.stripe_customer_id IS NOT NULL LIMIT 1`, [did]
    ).catch(() => ({ rows: [] }));
    const customerId = r.rows[0]?.stripe_customer_id;
    if (!customerId) return res.status(404).json({ error: 'no_stripe_customer', hint: 'Customer is created on first paid signup.' });

    if (typeof fetch !== 'function') return res.status(500).json({ error: 'fetch_unavailable' });
    try {
      const sr = await fetch('https://api.stripe.com/v1/billing_portal/sessions', {
        method: 'POST',
        headers: { authorization: 'Bearer ' + process.env.STRIPE_SECRET_KEY, 'content-type': 'application/x-www-form-urlencoded' },
        body: 'customer=' + encodeURIComponent(customerId) + '&return_url=' + encodeURIComponent((process.env.OPERATOR_PUBLIC_URL || '') + '/dashboard?did=' + encodeURIComponent(did))
      });
      if (!sr.ok) return res.status(502).json({ error: 'stripe_portal_failed', status: sr.status });
      const j = await sr.json();
      res.json({ portal_url: j.url });
    } catch (e) {
      res.status(502).json({ error: 'stripe_portal_failed', message: e.message });
    }
  });
}

module.exports = { migrate, registerIntegrationsMigrateRoutes, CHANNELS, MIGRATIONS };
