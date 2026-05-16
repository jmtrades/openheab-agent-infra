// ============================================================================
// catalog_pages.js — three public HTML showcases that Anthropic-quality
// platforms ship:
//   - /models   — provider-neutral catalog of LLM models you can route to
//   - /tools    — every MCP tool the substrate exposes, by category
//   - /runbook  — operator SRE playbooks for common incidents
// All read-only, cached, fast.
// ============================================================================

async function migrate(pool) {}

// Provider-neutral model catalog (pricing rounded; route to cheapest provider)
const MODELS = [
  // Anthropic
  { id: 'claude-haiku',     provider: 'anthropic', tier: 'fast',   ctx: 200_000, in_per_1m: 25,   out_per_1m: 125,   modalities: ['text', 'image'] },
  { id: 'claude-sonnet',    provider: 'anthropic', tier: 'mid',    ctx: 200_000, in_per_1m: 300,  out_per_1m: 1500,  modalities: ['text', 'image'] },
  { id: 'claude-opus',      provider: 'anthropic', tier: 'best',   ctx: 200_000, in_per_1m: 1500, out_per_1m: 7500,  modalities: ['text', 'image'] },
  // OpenAI
  { id: 'gpt-4o-mini',      provider: 'openai',    tier: 'fast',   ctx: 128_000, in_per_1m: 15,   out_per_1m: 60,    modalities: ['text', 'image', 'audio'] },
  { id: 'gpt-4o',           provider: 'openai',    tier: 'mid',    ctx: 128_000, in_per_1m: 250,  out_per_1m: 1000,  modalities: ['text', 'image', 'audio'] },
  { id: 'o1',               provider: 'openai',    tier: 'best',   ctx: 200_000, in_per_1m: 1500, out_per_1m: 6000,  modalities: ['text'] },
  // Google
  { id: 'gemini-flash',     provider: 'google',    tier: 'fast',   ctx: 1_000_000, in_per_1m: 7,  out_per_1m: 30,    modalities: ['text', 'image', 'audio', 'video'] },
  { id: 'gemini-pro',       provider: 'google',    tier: 'mid',    ctx: 2_000_000, in_per_1m: 125, out_per_1m: 500,  modalities: ['text', 'image', 'audio', 'video'] },
  // Mistral / Together (cheap open weights)
  { id: 'mistral-large',    provider: 'mistral',   tier: 'mid',    ctx: 128_000, in_per_1m: 200,  out_per_1m: 600,   modalities: ['text'] },
  { id: 'llama-70b',        provider: 'together',  tier: 'mid',    ctx: 128_000, in_per_1m: 60,   out_per_1m: 60,    modalities: ['text'] },
  { id: 'qwen-72b',         provider: 'together',  tier: 'mid',    ctx: 32_000,  in_per_1m: 60,   out_per_1m: 60,    modalities: ['text'] }
];

// Tool categories — pulled dynamically from MCP server when available
function gatherTools() {
  try {
    const { TOOLS } = require('./mcp_server');
    if (!Array.isArray(TOOLS)) return { total: 0, by_category: {} };
    const groups = {};
    for (const t of TOOLS) {
      const cat = (t.name || '').split('_')[0] || 'misc';
      (groups[cat] = groups[cat] || []).push({ name: t.name, description: t.description || '' });
    }
    return { total: TOOLS.length, by_category: groups };
  } catch { return { total: 0, by_category: {} }; }
}

const RUNBOOKS = [
  {
    slug: 'high-5xx-rate',
    title: 'High 5xx rate on /v1/* routes',
    severity: 'P1',
    steps: [
      'Check `/v1/_health/deep` — is overall green/yellow/red?',
      'Check `/v1/_health/deep/launchready` — what specific checks are failing?',
      'Tail logs: `vercel logs <project> --since=15m`. Grep for "error" + recent request_ids.',
      'Check DB: `psql $DATABASE_URL -c "SELECT version(), pg_pool_status();"`',
      'Check rate limiter table: `SELECT COUNT(*) FROM rate_limits WHERE blocked_at > NOW() - INTERVAL \'5 min\'`',
      'If DB is the problem: scale Neon or fail over to read-replica.',
      'If a specific primitive: disable it temporarily by removing from PRIMITIVE_NAMES in src/integration.js and redeploy.',
      'Declare incident: `POST /v1/_admin/uptime/incidents` with severity=major.',
      'When resolved: `POST /v1/_admin/uptime/incidents/:id/resolve`.'
    ]
  },
  {
    slug: 'kyc-provider-down',
    title: 'KYC verification provider is down',
    severity: 'P2',
    steps: [
      'Identify which provider: Onfido / Persona / Sumsub / in-house kyc_core.',
      'Test connectivity: `curl https://api.onfido.com/v3/check_summary` (auth required).',
      'If provider is up but our integration broke: check `adapter_calls` table for recent errors.',
      'Switch the default provider via env: `KYC_DEFAULT_PROVIDER=kyc_core` (falls back to in-house).',
      'Queue any pending KYC submissions: `SELECT subject_id FROM kyc_subjects WHERE status=\'submitted\' AND created_at < NOW() - INTERVAL \'1 hour\'`',
      'When resolved: backfill via `POST /v1/_jobs/rescreen-agents` with x-cron-secret.'
    ]
  },
  {
    slug: 'stripe-webhook-failure',
    title: 'Stripe webhooks failing / payments stalling',
    severity: 'P1',
    steps: [
      'Check Stripe dashboard → Webhooks → recent deliveries. What status codes?',
      'Verify STRIPE_WEBHOOK_SECRET in Vercel env matches the endpoint secret in Stripe.',
      'Look at /v1/_webhooks/stripe logs for "signature_invalid" or "verification_failed".',
      'If we accepted+failed: replay from Stripe dashboard (Resend selected events).',
      'If we rejected: check Vercel deploy time — env mismatch after rotation?',
      'Worst case: disable Stripe in pricing_page TIERS, point new signups to free until resolved.'
    ]
  },
  {
    slug: 'audit-chain-integrity-fail',
    title: 'Audit chain verification reports invalid',
    severity: 'P0',
    steps: [
      'STOP. This is a data-integrity event. Page founder + compliance officer.',
      'Run `GET /v1/audit/verify` and capture the failing length + hash.',
      'Snapshot the audit_chain table: `pg_dump -t audit_chain`.',
      'Identify the first invalid row: walk chain, recompute SHA-256(canonical + prev_hash), find first mismatch.',
      'Determine if compromise vs corruption: check Postgres WAL + replication lag.',
      'Restore from backup if corruption: `POST /v1/admin/backup/list`, pick last-known-good, restore audit_chain rows < broken length.',
      'Generate incident report. SAR / breach notification may be required by regulators.'
    ]
  },
  {
    slug: 'agent-fraud-detected',
    title: 'AML / fraud detector flagged an agent',
    severity: 'P2',
    steps: [
      'Pull the agent\'s record: `GET /v1/agents/:did` + `GET /v1/agents/:did/kyc` + `GET /v1/agents/:did/transactions`.',
      'Cross-reference with `aml_alerts` table for related flags.',
      'If high confidence (sanctions hit / structuring pattern):',
      '  → freeze: `POST /v1/admin/quarantine/:did` with x-admin-token',
      '  → notify compliance officer',
      '  → consider SAR filing in `kyc_advanced.generateSar(did)`',
      'If false positive: clear via `POST /v1/admin/agents/:did/clear-flag` and document why.'
    ]
  },
  {
    slug: 'database-out-of-space',
    title: 'Postgres disk usage > 80%',
    severity: 'P1',
    steps: [
      'Check Neon dashboard for storage trend.',
      'Identify top tables by size: `SELECT pg_size_pretty(pg_total_relation_size(oid)) FROM pg_class ORDER BY pg_total_relation_size(oid) DESC LIMIT 20`.',
      'Most likely culprits: audit_chain, inference_calls, audit_chain, webhook_deliveries_v2.',
      'Prune webhook_deliveries_v2 > 90 days (PII-free, regenerable from audit chain): `DELETE FROM webhook_deliveries_v2 WHERE created_at < NOW() - INTERVAL \'90 days\'`.',
      'Prune marketing_pageviews > 1 year: same pattern.',
      'NEVER prune audit_chain — it\'s append-only by design.',
      'Scale Neon plan to next tier.'
    ]
  }
];

function renderModelsPage() {
  return `<!doctype html><html><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>Models — OpenHeab</title>
<meta name="description" content="Every LLM you can route to via OpenHeab: Anthropic, OpenAI, Google, Mistral, Together. Provider-neutral, cheapest-first routing.">
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
table { width: 100%; border-collapse: collapse; background: #14141c; border-radius: 12px; overflow: hidden; }
th, td { padding: 12px 16px; text-align: left; border-bottom: 1px solid #1f1f2a; font-size: 14px; }
th { background: #1a1a25; color: #888; font-weight: 500; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; }
td.mono { font-family: 'SF Mono', monospace; }
td.right { text-align: right; font-family: 'SF Mono', monospace; color: #aaa; }
.pill { display: inline-block; padding: 2px 8px; border-radius: 100px; font-size: 11px; font-weight: 600; background: #1f1f2a; color: #aaa; }
.pill.anthropic { background: #be552015; color: #be5520; }
.pill.openai    { background: #10a37f15; color: #10a37f; }
.pill.google    { background: #4285f415; color: #4285f4; }
.pill.mistral   { background: #ff7a0015; color: #ff7a00; }
.pill.together  { background: #6366f115; color: #818cf8; }
.modality { display: inline-block; padding: 1px 7px; margin-right: 4px; border-radius: 4px; background: #20202a; color: #888; font-size: 11px; font-family: monospace; }
.footer { color: #555; font-size: 12px; margin-top: 48px; text-align: center; }
.footer a { color: #888; margin: 0 8px; }
.callout { background: #14141c; border-left: 3px solid #4f46e5; padding: 14px 20px; margin: 24px 0; border-radius: 4px; font-size: 14px; color: #c5c5d5; }
</style></head><body>
<div class="wrap">

<nav class="nav">
  <a class="logo" href="/">OpenHeab</a>
  <div class="links">
    <a href="/models" style="color:#fff">Models</a>
    <a href="/tools">Tools</a>
    <a href="/docs">Docs</a>
    <a href="/pricing">Pricing</a>
    <a href="/sdk">SDK</a>
    <a href="/dashboard">Dashboard</a>
  </div>
</nav>

<h1>Models</h1>
<p class="subtitle">Every LLM you can route to via <code>POST /v1/agents/$DID/inference</code>. We pick the cheapest provider supporting your model + modalities. BYO provider keys on Pro+.</p>

<div class="callout">
  <b>Pricing shown is per 1M tokens in cents</b> (raw provider cost; OpenHeab adds 2&ndash;10% markup depending on your tier — Free 5%, Pro 2%, Enterprise 0%).
</div>

<table>
  <thead><tr><th>Model</th><th>Provider</th><th>Tier</th><th>Context</th><th>Modalities</th><th class="right">Input ¢/1M</th><th class="right">Output ¢/1M</th></tr></thead>
  <tbody>
${MODELS.map(m => `
    <tr>
      <td class="mono">${m.id}</td>
      <td><span class="pill ${m.provider}">${m.provider}</span></td>
      <td>${m.tier}</td>
      <td class="right">${(m.ctx).toLocaleString()}</td>
      <td>${m.modalities.map(x => `<span class="modality">${x}</span>`).join('')}</td>
      <td class="right">${m.in_per_1m}¢</td>
      <td class="right">${m.out_per_1m}¢</td>
    </tr>
`).join('')}
  </tbody>
</table>

<div class="footer">
  Try it: <code style="background:#14141c;padding:3px 7px;border-radius:4px">curl -X POST /v1/agents/$DID/inference -d '{"model":"claude-haiku","messages":[...]}'</code>
  &nbsp; · &nbsp; <a href="/models.json">JSON feed</a>
</div>

</div></body></html>`;
}

function renderToolsPage() {
  const tools = gatherTools();
  const categories = Object.entries(tools.by_category).sort(([a], [b]) => a.localeCompare(b));

  return `<!doctype html><html><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>Tools — OpenHeab MCP Catalog</title>
<meta name="description" content="Every tool the OpenHeab MCP server exposes: ${tools.total}+ tools across ${categories.length} categories. Plug into Claude, Cursor, VS Code, or any MCP client.">
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
.stats { display: flex; gap: 14px; margin-bottom: 32px; }
.stat { background: #14141c; padding: 14px 20px; border-radius: 10px; }
.stat .v { font-size: 24px; font-weight: 700; }
.stat .l { font-size: 11px; color: #888; text-transform: uppercase; letter-spacing: 0.5px; }
.cat { margin-bottom: 28px; }
.cat h2 { font-size: 14px; color: #818cf8; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 12px; font-weight: 600; }
.cat ul { list-style: none; display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 8px; }
.cat li { background: #14141c; padding: 10px 14px; border-radius: 6px; border-left: 2px solid #25253a; }
.cat li .name { font-family: 'SF Mono', monospace; font-size: 13px; color: #fff; }
.cat li .desc { font-size: 12px; color: #888; margin-top: 2px; line-height: 1.4; }
.search { width: 100%; padding: 10px 14px; background: #14141c; border: 1px solid #1f1f2a; color: #fff; border-radius: 8px; font-size: 14px; margin-bottom: 28px; outline: none; }
.search:focus { border-color: #4f46e5; }
.footer { color: #555; font-size: 12px; margin-top: 48px; text-align: center; }
</style></head><body>
<div class="wrap">

<nav class="nav">
  <a class="logo" href="/">OpenHeab</a>
  <div class="links">
    <a href="/models">Models</a>
    <a href="/tools" style="color:#fff">Tools</a>
    <a href="/docs">Docs</a>
    <a href="/pricing">Pricing</a>
    <a href="/sdk">SDK</a>
    <a href="/dashboard">Dashboard</a>
  </div>
</nav>

<h1>MCP Tools</h1>
<p class="subtitle">${tools.total} tools agents can call via the OpenHeab MCP server at <code>/mcp</code>. Add it to Claude Desktop, Cursor, or any MCP-aware client and every tool below is immediately available.</p>

<div class="stats">
  <div class="stat"><div class="v">${tools.total}</div><div class="l">Total tools</div></div>
  <div class="stat"><div class="v">${categories.length}</div><div class="l">Categories</div></div>
  <div class="stat"><div class="v">JSON-RPC 2.0</div><div class="l">Protocol</div></div>
</div>

<input class="search" placeholder="Filter tools (try: kyc, wallet, transfer, inference)" oninput="filter(this.value)" id="search"/>

<div id="tools">
${categories.map(([cat, items]) => `
  <div class="cat" data-cat="${escapeHtml(cat)}">
    <h2>${escapeHtml(cat)} <span style="color:#444;font-weight:400">· ${items.length}</span></h2>
    <ul>
${items.map(t => `      <li><div class="name">${escapeHtml(t.name)}</div><div class="desc">${escapeHtml(String(t.description || '').slice(0, 100))}</div></li>`).join('\n')}
    </ul>
  </div>
`).join('')}
</div>

<div class="footer">
  Machine-readable: <a href="/mcp" style="color:#888">POST /mcp tools/list</a> · <a href="/tools.json" style="color:#888">tools.json</a>
</div>

</div>
<script>
function filter(q) {
  q = (q || '').toLowerCase();
  document.querySelectorAll('#tools .cat').forEach(c => {
    const items = c.querySelectorAll('li');
    let any = false;
    items.forEach(li => {
      const txt = li.textContent.toLowerCase();
      const match = !q || txt.includes(q);
      li.style.display = match ? '' : 'none';
      if (match) any = true;
    });
    c.style.display = any ? '' : 'none';
  });
}
</script>
</body></html>`;
}

function renderRunbookPage() {
  return `<!doctype html><html><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>SRE Runbook — OpenHeab</title>
<meta name="description" content="Operator playbooks for common incidents. Page on-call, follow steps, resolve.">
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Inter', sans-serif; background: #0a0a0f; color: #e7e7ee; line-height: 1.6; }
.wrap { max-width: 880px; margin: 0 auto; padding: 48px 24px 80px; }
.nav { display: flex; justify-content: space-between; align-items: center; margin-bottom: 40px; }
.nav .logo { font-weight: 700; font-size: 18px; color: #fff; text-decoration: none; }
.nav .links a { color: #888; margin-left: 20px; font-size: 14px; text-decoration: none; }
.nav .links a:hover { color: #fff; }
h1 { font-size: 36px; font-weight: 700; letter-spacing: -0.8px; margin-bottom: 10px; }
.subtitle { color: #888; margin-bottom: 36px; }
.runbook { background: #14141c; border: 1px solid #1a1a25; border-radius: 12px; padding: 24px 28px; margin-bottom: 14px; }
.runbook h2 { font-size: 18px; margin-bottom: 6px; display: flex; justify-content: space-between; align-items: center; gap: 16px; }
.sev { display: inline-block; padding: 2px 10px; border-radius: 100px; font-size: 10px; font-weight: 700; letter-spacing: 0.5px; }
.sev.P0 { background: #ef444420; color: #ef4444; }
.sev.P1 { background: #f9731620; color: #f97316; }
.sev.P2 { background: #eab30820; color: #eab308; }
.sev.P3 { background: #3b82f620; color: #3b82f6; }
ol { padding-left: 22px; margin-top: 12px; }
ol li { padding: 6px 0; color: #c5c5d5; font-size: 14px; line-height: 1.6; }
ol li code { background: #0f0f17; padding: 2px 6px; border-radius: 4px; font-size: 12px; color: #c5c5d5; }
.footer { color: #555; font-size: 12px; margin-top: 48px; text-align: center; }
.callout { background: #ef444410; border-left: 3px solid #ef4444; padding: 14px 20px; margin: 24px 0; border-radius: 4px; font-size: 14px; color: #fca5a5; }
</style></head><body>

<div class="wrap">
<nav class="nav">
  <a class="logo" href="/">OpenHeab</a>
  <div class="links">
    <a href="/admin">Admin</a>
    <a href="/launch">Launch board</a>
    <a href="/status">Status</a>
    <a href="/runbook" style="color:#fff">Runbook</a>
    <a href="/v1/_health/deep">Deep health</a>
  </div>
</nav>

<h1>SRE Runbook</h1>
<p class="subtitle">Operator playbooks for common incidents. Find your scenario, follow the steps. Page <code>oncall@</code> if you're stuck.</p>

<div class="callout">
  <b>Before doing anything destructive</b>: snapshot the audit_chain, take a DB backup (<code>POST /v1/admin/backup/create</code> with admin token), declare the incident on /status.
</div>

${RUNBOOKS.map(r => `
<div class="runbook" id="${r.slug}">
  <h2>${escapeHtml(r.title)}<span class="sev ${r.severity}">${r.severity}</span></h2>
  <ol>
${r.steps.map(s => `    <li>${escapeHtml(s).replace(/`([^`]+)`/g, '<code>$1</code>')}</li>`).join('\n')}
  </ol>
</div>
`).join('')}

<div class="footer">
  Add a runbook: edit <code>src/primitives/catalog_pages.js</code> RUNBOOKS array · contributions welcome
</div>

</div></body></html>`;
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

function registerCatalogPagesRoutes(app) {
  app.get('/models', (req, res) => {
    res.set('content-type', 'text/html; charset=utf-8');
    res.set('cache-control', 'public, max-age=3600');
    res.send(renderModelsPage());
  });
  app.get('/models.json', (req, res) => res.json({ models: MODELS }));

  app.get('/tools', (req, res) => {
    res.set('content-type', 'text/html; charset=utf-8');
    res.set('cache-control', 'public, max-age=300');
    res.send(renderToolsPage());
  });
  app.get('/tools.json', (req, res) => res.json(gatherTools()));

  app.get('/runbook', (req, res) => {
    res.set('content-type', 'text/html; charset=utf-8');
    res.set('cache-control', 'public, max-age=3600');
    res.send(renderRunbookPage());
  });
  app.get('/runbook.json', (req, res) => res.json({ runbooks: RUNBOOKS }));
}

module.exports = { migrate, registerCatalogPagesRoutes, MODELS, RUNBOOKS, gatherTools };
