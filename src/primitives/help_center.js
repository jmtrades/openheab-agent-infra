// ============================================================================
// help_center.js — `/help` searchable knowledge base of common questions
// and how-tos. Different from /docs (which is conceptual) — this is
// task-oriented "how do I X" with searchable index.
// ============================================================================
const crypto = require('crypto');

async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS help_searches (
      search_id  TEXT PRIMARY KEY,
      query      TEXT NOT NULL,
      result_count INTEGER NOT NULL,
      ip_hash    TEXT,
      searched_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_help_searches_recent ON help_searches (searched_at DESC);
  `);
}

const ARTICLES = [
  {
    slug: 'create-first-agent',
    category: 'getting-started',
    title: 'How do I create my first agent?',
    keywords: ['signup', 'first agent', 'getting started', 'new account', 'register'],
    body: `<p>Two ways:</p>
<ol>
<li><b>Via web</b>: visit <a href="/signup">/signup</a>, enter your email, pick a plan.</li>
<li><b>Via API</b>: <code>POST /v1/signup</code> with <code>{"email":"you@example.com","plan_code":"free"}</code>. Response includes <code>did</code>, <code>api_key</code> (shown once), <code>wallet</code>.</li>
</ol>
<p>Either way, you immediately get an Ed25519 DID, a USDC wallet on Base, and an API key. Save the API key — we don't store it in plain text and can't recover it.</p>`
  },
  {
    slug: 'rotate-api-key',
    category: 'account',
    title: 'How do I rotate my API key?',
    keywords: ['api key', 'rotate', 'revoke', 'security', 'compromised'],
    body: `<p>Three steps:</p>
<ol>
<li><b>Create new</b>: <code>POST /v1/agents/$DID/keys</code> with <code>{"name":"new-key"}</code>. Save the returned key.</li>
<li><b>Update your client</b> to use the new key.</li>
<li><b>Revoke old</b>: <code>DELETE /v1/agents/$DID/keys/$OLD_KEY_ID</code>.</li>
</ol>
<p>Or use <code>POST /v1/agents/$DID/keys/$KEY_ID/rotate</code> to do it in one call (atomic — old key revoked + new key created with same name/scope).</p>
<p>If your key is compromised, revoke immediately: <code>DELETE /v1/agents/$DID/keys/$KEY_ID</code>.</p>`
  },
  {
    slug: 'send-usdc-payment',
    category: 'payments',
    title: 'How do I send a USDC payment to another agent?',
    keywords: ['payment', 'transfer', 'usdc', 'send money', 'a2a'],
    body: `<p><code>POST /v1/agents/$DID/transfer</code> with body:</p>
<pre>{ "to_did": "did:op:recipient", "amount_raw": "1000000" }</pre>
<p><code>amount_raw</code> is in raw USDC units (1 USDC = 1,000,000 since USDC has 6 decimals).</p>
<p>1% platform fee via FeeSplitter contract. Every transfer is signed in the audit chain. You need a signed request (Ed25519 over METHOD\\nPATH\\nSHA256(body)).</p>`
  },
  {
    slug: 'use-mcp-claude-desktop',
    category: 'mcp',
    title: 'How do I use OpenHeab as an MCP server in Claude Desktop?',
    keywords: ['mcp', 'claude desktop', 'cursor', 'vscode', 'tools'],
    body: `<p>Edit <code>~/Library/Application Support/Claude/claude_desktop_config.json</code> (macOS):</p>
<pre>{
  "mcpServers": {
    "openheab": {
      "url": "https://api.openheab.com/mcp",
      "headers": { "authorization": "Bearer YOUR_API_KEY" }
    }
  }
}</pre>
<p>Restart Claude Desktop. You'll see 149 tools available.</p>
<p>Same config works for Cursor and VS Code (with the MCP extension).</p>`
  },
  {
    slug: 'webhook-subscribe',
    category: 'webhooks',
    title: 'How do I subscribe to webhooks?',
    keywords: ['webhook', 'subscribe', 'events', 'notifications', 'callback'],
    body: `<p><code>POST /v1/agents/$DID/webhooks/subscribe</code>:</p>
<pre>{ "target_url": "https://yours.com/webhook",
  "event_types": ["transfer.completed", "rlaf.judged", "kyc.passed"] }</pre>
<p>Response includes a <code>secret</code>. Verify HMAC signatures on every delivery:</p>
<pre>const expected = crypto.createHmac('sha256', secret).update(req.body).digest('hex');
if (req.headers['x-openheab-signature'] !== expected) return 400;</pre>
<p>Failed deliveries retry with exponential backoff (2s, 4s, 8s, ... up to 256s, 8 attempts total).</p>`
  },
  {
    slug: 'kyc-tier',
    category: 'compliance',
    title: 'What KYC tier do I need?',
    keywords: ['kyc', 'verification', 'tier', 'limits', 'compliance', 'aml'],
    body: `<p>Pick the lowest tier that covers your usage:</p>
<ul>
<li><b>Tier 0</b> — $100/day, $1K/mo. No KYC required.</li>
<li><b>Tier 1</b> — $1K/day, $10K/mo. Email + phone verification.</li>
<li><b>Tier 2</b> — $10K/day, $100K/mo. Government ID + selfie.</li>
<li><b>Tier 3</b> — $100K/day, $1M/mo. Full KYC + AML monitoring.</li>
<li><b>Tier 4</b> — unlimited. EDD + ongoing review.</li>
</ul>
<p>Submit your KYC: <code>POST /v1/agents/$DID/kyc/submit</code>.</p>`
  },
  {
    slug: 'export-data',
    category: 'compliance',
    title: 'How do I export all my data (GDPR)?',
    keywords: ['gdpr', 'export', 'data', 'download', 'privacy'],
    body: `<p><code>POST /v1/legal/gdpr/export</code> with <code>{"agent_did":"did:op:...","email":"you@example.com"}</code>.</p>
<p>Returns a request_id. Within 24h, we email you a signed JSON bundle of every row we have about you.</p>
<p>For account deletion: <code>POST /v1/legal/gdpr/delete</code> with <code>{"agent_did":"...","email":"...","confirm":"DELETE_EVERYTHING"}</code>. 30-day grace period; financial records retained 7y per US/EU law.</p>`
  },
  {
    slug: 'self-host',
    category: 'self-host',
    title: 'How do I self-host the substrate?',
    keywords: ['self-host', 'docker', 'deploy', 'vercel', 'open source'],
    body: `<p>Fork-friendly Apache 2.0:</p>
<pre>git clone https://github.com/jmtrades/openheab-agent-infra
cd openheab-agent-infra
npm install
cp .env.example .env  # fill in DATABASE_URL etc.
docker compose up     # or: npm start</pre>
<p>Or one-shot Vercel deploy:</p>
<pre>./deploy.sh</pre>
<p>Required env: <code>DATABASE_URL</code>, <code>IDENTITY_MASTER_KEK</code>, <code>OPERATOR_PUBLIC_URL</code>, <code>OPERATOR_ADMIN_TOKEN</code>. Everything else has stub mode.</p>`
  },
  {
    slug: 'pricing-plans',
    category: 'billing',
    title: 'What are the pricing tiers?',
    keywords: ['pricing', 'plan', 'cost', 'free', 'pro', 'enterprise', 'subscription'],
    body: `<ul>
<li><b>Free</b> — $0/mo. 1 agent, 10K inference calls. Stub KYC.</li>
<li><b>Starter</b> — $19/mo. 5 agents, 100K calls.</li>
<li><b>Pro</b> — $99/mo. 50 agents, 1M calls. Full KYC + SLA.</li>
<li><b>Team</b> — $349/mo. 500 agents, 10M calls. SSO + RBAC.</li>
<li><b>Enterprise</b> — $2,499+/mo. Unlimited. SOC 2 + HIPAA + ISO. BYO providers.</li>
</ul>
<p>See full comparison at <a href="/pricing">/pricing</a>. Switch anytime via <code>POST /v1/me/billing/portal</code>.</p>`
  },
  {
    slug: 'check-status',
    category: 'operations',
    title: 'How do I check if OpenHeab is up?',
    keywords: ['status', 'uptime', 'down', 'incident', 'health'],
    body: `<p>Several signals:</p>
<ul>
<li><b><a href="/status">/status</a></b> — public status page with per-component uptime + incidents</li>
<li><b><a href="/v1/_health/deep">/v1/_health/deep</a></b> — 17 structured readiness checks</li>
<li><b><a href="/v1/_health/deep/launchready">/v1/_health/deep/launchready</a></b> — single 200/503 for CI gating</li>
<li><b><a href="/v1/_health/deep/probes">/v1/_health/deep/probes</a></b> — live adapter connectivity probes</li>
<li><b><a href="/status.rss">/status.rss</a></b> — RSS feed of incidents (subscribe!)</li>
</ul>`
  },
  {
    slug: 'why-audit-chain',
    category: 'architecture',
    title: 'What does the audit chain do?',
    keywords: ['audit', 'chain', 'merkle', 'sha256', 'tamper', 'compliance'],
    body: `<p>Every state change in the substrate appends a SHA-256 hash chain entry. Each entry references the previous hash, like a blockchain. You can't tamper with the past without invalidating every subsequent entry.</p>
<p>Verify integrity: <code>GET /v1/audit/verify</code>. Browse entries: <code>GET /v1/audit/chain?limit=100</code>.</p>
<p>This is what makes the substrate audit-defensible for SOC 2, HIPAA, financial regulators. <a href="/activity">/activity</a> shows the chain visually in real time.</p>`
  }
];

function search(query) {
  if (!query || query.length < 2) return [];
  const q = query.toLowerCase();
  const scored = ARTICLES.map(a => {
    let score = 0;
    if (a.title.toLowerCase().includes(q)) score += 10;
    for (const k of a.keywords) if (k.toLowerCase().includes(q)) score += 5;
    if (a.body.toLowerCase().includes(q)) score += 1;
    return { ...a, score };
  }).filter(a => a.score > 0).sort((a, b) => b.score - a.score);
  return scored.slice(0, 20);
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

function renderHelpPage(query = '') {
  const results = query ? search(query) : ARTICLES;
  const grouped = {};
  for (const a of results) (grouped[a.category] = grouped[a.category] || []).push(a);
  const cats = Object.keys(grouped);

  return `<!doctype html><html><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>${query ? 'Search: ' + escapeHtml(query) + ' — ' : ''}Help — OpenHeab</title>
<meta name="description" content="OpenHeab help center. Searchable answers to common how-do-I questions.">
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Inter', sans-serif; background: #0a0a0f; color: #e7e7ee; line-height: 1.6; }
.wrap { max-width: 880px; margin: 0 auto; padding: 48px 24px 80px; }
.nav { display: flex; justify-content: space-between; align-items: center; margin-bottom: 40px; }
.nav .logo { font-weight: 700; font-size: 18px; color: #fff; text-decoration: none; }
.nav .links a { color: #888; margin-left: 20px; font-size: 14px; text-decoration: none; }
.nav .links a:hover { color: #fff; }
h1 { font-size: 36px; font-weight: 700; letter-spacing: -0.8px; margin-bottom: 10px; }
.subtitle { color: #888; font-size: 16px; margin-bottom: 28px; }
.search-form { margin-bottom: 32px; }
.search { width: 100%; padding: 14px 18px; background: #14141c; border: 1px solid #1f1f2a; color: #fff; border-radius: 10px; font-size: 16px; outline: none; }
.search:focus { border-color: #4f46e5; }
.cat { margin-bottom: 28px; }
.cat h2 { font-size: 11px; color: #818cf8; text-transform: uppercase; letter-spacing: 1.2px; margin-bottom: 10px; font-weight: 600; }
.article { background: #14141c; border: 1px solid #1a1a25; padding: 18px 22px; border-radius: 8px; margin-bottom: 8px; }
.article summary { cursor: pointer; font-weight: 600; font-size: 15px; color: #fff; position: relative; padding-right: 24px; list-style: none; }
.article summary::-webkit-details-marker { display: none; }
.article summary::after { content: '+'; position: absolute; right: 0; top: 0; font-size: 20px; color: #4f46e5; }
.article[open] summary::after { content: '\\2212'; }
.article-body { margin-top: 14px; color: #c5c5d5; font-size: 14px; line-height: 1.7; }
.article-body code { background: #0f0f17; padding: 2px 6px; border-radius: 4px; font-size: 12px; }
.article-body pre { background: #0f0f17; padding: 14px; border-radius: 6px; overflow-x: auto; margin: 10px 0; }
.article-body a { color: #818cf8; }
.empty { background: #14141c; padding: 40px; border-radius: 10px; text-align: center; color: #888; }
.footer { color: #555; font-size: 13px; margin-top: 48px; text-align: center; }
.footer a { color: #888; margin: 0 8px; }
</style></head><body>
<div class="wrap">

<nav class="nav">
  <a class="logo" href="/">OpenHeab</a>
  <div class="links">
    <a href="/docs">Docs</a>
    <a href="/sdk">SDK</a>
    <a href="/help" style="color:#fff">Help</a>
    <a href="/explorer">Explorer</a>
    <a href="/dashboard">Dashboard</a>
  </div>
</nav>

<h1>How can we help?</h1>
<p class="subtitle">${query ? 'Results for "' + escapeHtml(query) + '". Try shorter keywords for more results.' : 'Search ' + ARTICLES.length + ' how-tos, or browse by category below.'}</p>

<form class="search-form" method="get" action="/help">
  <input class="search" name="q" value="${escapeHtml(query)}" placeholder="Search help articles (e.g. webhooks, KYC tier, API key)" autofocus />
</form>

${results.length === 0 ? `<div class="empty">
  <p>No results for "<b>${escapeHtml(query)}</b>".</p>
  <p style="margin-top:8px;font-size:13px">Try <a href="/help">all articles</a>, the <a href="/docs">docs</a>, or <a href="mailto:support@openheab.com">email support</a>.</p>
</div>` : cats.map(cat => `
  <div class="cat">
    <h2>${escapeHtml(cat)} <span style="color:#444;font-weight:400">· ${grouped[cat].length}</span></h2>
    ${grouped[cat].map(a => `
      <details class="article" id="${escapeHtml(a.slug)}">
        <summary>${escapeHtml(a.title)}</summary>
        <div class="article-body">${a.body}</div>
      </details>
    `).join('')}
  </div>
`).join('')}

<div class="footer">
  Still stuck? <a href="mailto:support@openheab.com">support@openheab.com</a> · <a href="/runbook">SRE runbook</a> · <a href="https://github.com/jmtrades/openheab-agent-infra/issues">GitHub issues</a>
</div>

</div></body></html>`;
}

function registerHelpCenterRoutes(app, pool) {
  app.get('/help', async (req, res) => {
    const query = (req.query.q || '').toString().slice(0, 200);
    if (query) {
      // Log search (non-blocking)
      const ipHash = require('crypto').createHash('sha256').update(String(req.ip || 'anon')).digest('hex').slice(0, 16);
      pool.query(
        `INSERT INTO help_searches (search_id, query, result_count, ip_hash) VALUES ($1, $2, $3, $4)`,
        ['hs_' + crypto.randomBytes(8).toString('hex'), query, search(query).length, ipHash]
      ).catch(() => {});
    }
    res.set('content-type', 'text/html; charset=utf-8');
    res.set('cache-control', query ? 'no-store' : 'public, max-age=600');
    res.send(renderHelpPage(query));
  });

  app.get('/help.json', (req, res) => {
    const query = (req.query.q || '').toString();
    res.json({ query, results: query ? search(query) : ARTICLES, total_articles: ARTICLES.length });
  });

  // Top searches over last 30 days (admin only — useful for finding doc gaps)
  app.get('/v1/admin/help/top-searches', async (req, res) => {
    const tok = process.env.OPERATOR_ADMIN_TOKEN || process.env.INTERNAL_API_KEY;
    if (!tok || req.headers['x-admin-token'] !== tok) return res.status(401).json({ error: 'admin_required' });
    const r = await pool.query(`
      SELECT query, COUNT(*)::int AS n, AVG(result_count)::numeric(10,1) AS avg_results
      FROM help_searches WHERE searched_at > NOW() - INTERVAL '30 days'
      GROUP BY query ORDER BY n DESC LIMIT 50
    `).catch(() => ({ rows: [] }));
    res.json({ top_searches: r.rows });
  });
}

module.exports = { migrate, registerHelpCenterRoutes, ARTICLES };
