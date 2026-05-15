// ============================================================================
// docs_page.js — polished /docs landing surface with sidebar nav, search,
// and category-organized content. Closes the gap where /openapi.json
// existed but developers had no human-readable starting point.
// ============================================================================

const SECTIONS = [
  {
    slug: 'getting-started',
    title: 'Getting Started',
    body: `
      <h2>What is OpenHeab?</h2>
      <p>OpenHeab is an agent-native infrastructure substrate. In one POST you get a cryptographic identity, a USDC wallet on Base, KYC, a card, an API key, and access to 1,600+ API endpoints across 224 primitives covering everything an AI agent needs.</p>

      <h2>Your first agent in 60 seconds</h2>
      <pre><code>curl -X POST https://api.openheab.com/v1/signup \\
  -H "content-type: application/json" \\
  -d '{"email":"you@example.com","plan":"starter"}'</code></pre>

      <p>Response includes:</p>
      <ul>
        <li><code>did</code> — your agent's Decentralized Identifier (Ed25519-derived)</li>
        <li><code>api_key</code> — bearer token for HTTP auth (shown once)</li>
        <li><code>wallet_address</code> — your USDC wallet on Base (non-custodial)</li>
        <li><code>checkout_url</code> — if you picked a paid plan</li>
      </ul>

      <h2>Try the live demo</h2>
      <p>Visit <a href="/demo">/demo</a> — every page load provisions a new demo agent end-to-end in ~200ms so you can see what the substrate does without signing up.</p>
    `
  },
  {
    slug: 'authentication',
    title: 'Authentication',
    body: `
      <h2>Two auth modes</h2>
      <h3>1. Bearer API key (simpler)</h3>
      <pre><code>curl -H "authorization: Bearer oh_live_..." \\
  https://api.openheab.com/v1/agents/$DID/wallet</code></pre>

      <h3>2. Ed25519 signature (for mutating actions on financial primitives)</h3>
      <p>Sign <code>METHOD\\nPATH\\nSHA256(body)</code> with your Ed25519 private key, base64-encode, send as <code>x-agent-signature</code>:</p>
      <pre><code>curl -X POST https://api.openheab.com/v1/agents/$DID/transfer \\
  -H "x-agent-did: $DID" \\
  -H "x-agent-signature: \\$SIG" \\
  -d "$BODY"</code></pre>

      <h2>API key lifecycle</h2>
      <ul>
        <li><code>POST /v1/agents/:did/keys</code> — create new key (raw key shown once)</li>
        <li><code>GET /v1/agents/:did/keys</code> — list keys (no raw values)</li>
        <li><code>POST /v1/agents/:did/keys/:key_id/rotate</code> — rotate (revoke old, create new)</li>
        <li><code>DELETE /v1/agents/:did/keys/:key_id</code> — revoke immediately</li>
      </ul>
      <p>Keys can be scoped: <code>read-only</code>, <code>read-write</code>, <code>billing-only</code>, <code>admin</code>. Expiry is optional.</p>
    `
  },
  {
    slug: 'identity',
    title: 'Identity (DIDs)',
    body: `
      <h2>What is a DID?</h2>
      <p>A Decentralized Identifier — a globally unique handle for an agent that doesn't depend on any single registry. OpenHeab uses the <code>did:op:</code> method, where the suffix is the first 16 hex characters of SHA-256 of the agent's Ed25519 public key.</p>

      <h2>Cross-lab portability (AGI Passport)</h2>
      <p>The same DID works across Claude / GPT / Gemini / your own infra. Issue a passport with <code>POST /v1/agi/passport/issue</code>, and any lab that trusts your issuing authority can authenticate the agent.</p>

      <h2>Delegation</h2>
      <p>An agent can grant scoped, time-limited authority to another agent via <code>POST /v1/agi/delegation/create</code> — a parent can give a child agent permission to spend up to $100/day on inference but nothing else.</p>
    `
  },
  {
    slug: 'wallet',
    title: 'Wallets & Payments',
    body: `
      <h2>USDC on Base</h2>
      <p>Every agent gets a non-custodial USDC wallet on Base (Coinbase's L2). The private key is encrypted at rest with HKDF-derived per-tenant KEKs.</p>

      <h2>Send + receive</h2>
      <pre><code>POST /v1/agents/$DID/transfer
{
  "to_did": "did:op:recipient",
  "amount_raw": "1000000"  // 1 USDC (6 decimals)
}</code></pre>
      <p>1% platform fee via FeeSplitter contract. Audit-chain entry on every transaction.</p>

      <h2>Cards</h2>
      <p>Issue a virtual or physical debit card with <code>POST /v1/agents/$DID/cards/issue</code>. ISO 8583 authorization flow with JIT funding from your wallet. Interchange revenue auto-recorded.</p>

      <h2>Savings + lending</h2>
      <p>Sweep idle balance into yield-bearing savings (currently 4.5% APY). Borrow against collateral via <code>POST /v1/agents/$DID/lending/borrow</code>.</p>
    `
  },
  {
    slug: 'inference',
    title: 'LLM Inference',
    body: `
      <h2>Provider-routed</h2>
      <p>OpenAI-compatible <code>POST /v1/agents/$DID/inference</code> routes to the cheapest provider supporting your model (Anthropic, OpenAI, Google, Mistral, Together). Add 10% platform markup.</p>

      <h2>BYO keys</h2>
      <p>On Pro+, you can bring your own provider API keys. They're encrypted with per-tenant KEK and never leave the substrate.</p>

      <h2>Streaming + tool use</h2>
      <p>SSE streaming via <code>?stream=true</code>. Native tool-use forwarding for Claude / GPT.</p>

      <h2>Multimodal</h2>
      <p>Text + image + audio + video via <code>POST /v1/agents/$DID/multimodal</code> — routed to providers supporting all needed modalities.</p>
    `
  },
  {
    slug: 'mcp',
    title: 'MCP Server',
    body: `
      <h2>145+ tools, one endpoint</h2>
      <p>OpenHeab is an MCP (Model Context Protocol) server at <code>/mcp</code>. Speaks JSON-RPC 2.0 over HTTPS.</p>

      <h2>Claude Desktop config</h2>
      <pre><code>{
  "mcpServers": {
    "openheab": {
      "url": "https://api.openheab.com/mcp",
      "headers": { "authorization": "Bearer YOUR_API_KEY" }
    }
  }
}</code></pre>

      <h2>List tools</h2>
      <pre><code>curl -X POST https://api.openheab.com/mcp \\
  -H "content-type: application/json" \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'</code></pre>

      <h2>Categories</h2>
      <p>identity · wallet · KYC · cards · savings · marketplace · inference · sandbox · browser · voice · vision · planning · simulation · DAOs · contracts · courts · gov filing · prediction markets · ratings · ... 145+ tools total.</p>
    `
  },
  {
    slug: 'webhooks',
    title: 'Webhooks',
    body: `
      <h2>Subscribe to events</h2>
      <pre><code>POST /v1/agents/$DID/webhooks/subscribe
{
  "target_url": "https://yours.com/webhook",
  "event_types": ["transfer.completed", "rlaf.judged", "kyc.passed"]
}</code></pre>
      <p>Response includes <code>subscription_id</code> and a per-subscription <code>secret</code> for HMAC signing.</p>

      <h2>Verifying signatures</h2>
      <pre><code>const expected = crypto.createHmac('sha256', secret)
  .update(req.body).digest('hex');
if (req.headers['x-openheab-signature'] !== expected)
  return res.status(400).end();</code></pre>

      <h2>Retries</h2>
      <p>Failed deliveries retry with exponential backoff: 2, 4, 8, 16, 32, 64, 128, 256 seconds. After 8 attempts, marked failed.</p>
    `
  },
  {
    slug: 'compliance',
    title: 'Compliance',
    body: `
      <h2>KYC tiers</h2>
      <ul>
        <li>Tier 0 — $100/day, $1K/mo limit, no KYC required</li>
        <li>Tier 1 — $1K/day, $10K/mo, email + phone verification</li>
        <li>Tier 2 — $10K/day, $100K/mo, government ID + selfie</li>
        <li>Tier 3 — $100K/day, $1M/mo, full KYC + AML monitoring</li>
        <li>Tier 4 — unlimited, EDD + ongoing review</li>
      </ul>

      <h2>Sanctions screening</h2>
      <p>Every agent screened against 5 sources: OFAC SDN, EU consolidated, UN, UK HMT, Australia DFAT.</p>

      <h2>SOC 2 + HIPAA + ISO</h2>
      <p>Continuous evidence collection via <code>audit_core.js</code>. Independent auditor portal at <code>/audit-portal</code> with token-scoped access.</p>

      <h2>GDPR</h2>
      <p>Self-serve data export: <code>POST /v1/legal/gdpr/export</code>. Account deletion: <code>POST /v1/legal/gdpr/delete</code> with confirm string.</p>
    `
  },
  {
    slug: 'self-hosting',
    title: 'Self-Hosting',
    body: `
      <h2>Apache 2.0 — fork freely</h2>
      <pre><code>git clone https://github.com/jmtrades/openheab-agent-infra
cd openheab-agent-infra
npm install
cp .env.example .env  # configure DATABASE_URL etc.
npm test
node server.js</code></pre>

      <h2>Vercel deploy</h2>
      <pre><code>./deploy.sh</code></pre>

      <h2>Required env vars</h2>
      <ul>
        <li><code>DATABASE_URL</code> — Postgres connection string</li>
        <li><code>AUDIT_CHAIN_PRIVATE_KEY</code> — Ed25519 hex (auto-gen if missing)</li>
        <li><code>INTERNAL_API_KEY</code> — for cron + admin endpoints</li>
        <li><code>CRON_SECRET</code> — for scheduled job auth</li>
      </ul>
      <p>Everything else has stub mode — substrate boots and serves without third-party keys.</p>
    `
  }
];

function renderDocsPage(activeSlug = 'getting-started') {
  const activeSection = SECTIONS.find(s => s.slug === activeSlug) || SECTIONS[0];

  return `<!doctype html><html><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>${activeSection.title} — OpenHeab Docs</title>
<meta name="description" content="Documentation for OpenHeab agent infrastructure — identity, wallets, inference, MCP, webhooks, compliance, self-hosting."/>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Inter', sans-serif; background: #0a0a0f; color: #e7e7ee; line-height: 1.7; }
.wrap { max-width: 1280px; margin: 0 auto; display: grid; grid-template-columns: 260px 1fr; gap: 48px; padding: 40px 24px; min-height: 100vh; }
.sidebar { position: sticky; top: 40px; align-self: start; }
.sidebar .logo { font-weight: 700; font-size: 18px; margin-bottom: 24px; display: block; color: #fff; text-decoration: none; letter-spacing: -0.3px; }
.sidebar ul { list-style: none; }
.sidebar li { margin: 2px 0; }
.sidebar a { display: block; padding: 8px 12px; color: #888; text-decoration: none; font-size: 14px; border-radius: 6px; transition: all 0.1s; }
.sidebar a:hover { color: #fff; background: #14141c; }
.sidebar a.active { color: #fff; background: #1a1a25; border-left: 2px solid #4f46e5; padding-left: 10px; }
.sidebar .nav-section { margin-top: 28px; padding-top: 20px; border-top: 1px solid #1a1a25; }
.sidebar .nav-section h4 { font-size: 11px; text-transform: uppercase; letter-spacing: 1px; color: #555; margin-bottom: 8px; padding: 0 12px; }
.content { max-width: 760px; }
.content h1 { font-size: 40px; font-weight: 700; letter-spacing: -1px; margin-bottom: 24px; }
.content h2 { font-size: 22px; margin: 36px 0 14px; font-weight: 600; }
.content h3 { font-size: 17px; margin: 24px 0 10px; color: #ccc; font-weight: 600; }
.content p { color: #c5c5d5; margin-bottom: 14px; font-size: 15px; }
.content ul, .content ol { padding-left: 24px; margin-bottom: 16px; }
.content li { color: #c5c5d5; margin-bottom: 6px; font-size: 15px; }
.content code { background: #14141c; padding: 2px 6px; border-radius: 4px; font-family: 'SF Mono', monospace; font-size: 13px; color: #c5c5d5; }
.content pre { background: #0a0a12; border: 1px solid #1a1a25; padding: 16px 20px; border-radius: 8px; overflow-x: auto; margin: 16px 0; }
.content pre code { background: transparent; padding: 0; font-size: 13px; color: #c5c5d5; line-height: 1.6; }
.content a { color: #818cf8; text-decoration: none; }
.content a:hover { text-decoration: underline; }
.search { width: 100%; padding: 8px 12px; background: #14141c; border: 1px solid #1f1f2a; color: #fff; border-radius: 6px; font-size: 14px; margin-bottom: 20px; }
.search:focus { outline: none; border-color: #4f46e5; }
@media (max-width: 900px) { .wrap { grid-template-columns: 1fr; } .sidebar { position: static; } }
</style></head><body>
<div class="wrap">

<aside class="sidebar">
  <a href="/" class="logo">OpenHeab Docs</a>
  <input class="search" placeholder="Filter docs..." oninput="filterDocs(this.value)" id="search"/>
  <ul id="nav">
${SECTIONS.map(s => `    <li><a href="/docs/${s.slug}" class="${s.slug === activeSlug ? 'active' : ''}" data-title="${s.title.toLowerCase()}">${s.title}</a></li>`).join('\n')}
  </ul>
  <div class="nav-section">
    <h4>External</h4>
    <ul>
      <li><a href="/openapi.json">OpenAPI 3.1 spec</a></li>
      <li><a href="/mcp">MCP server</a></li>
      <li><a href="/sdk">SDK examples</a></li>
      <li><a href="/demo">Live demo</a></li>
      <li><a href="/pricing">Pricing</a></li>
      <li><a href="https://github.com/jmtrades/openheab-agent-infra">GitHub</a></li>
    </ul>
  </div>
</aside>

<main class="content">
  <h1>${activeSection.title}</h1>
  ${activeSection.body}
</main>

</div>
<script>
function filterDocs(q) {
  q = q.toLowerCase();
  for (const li of document.querySelectorAll('#nav li')) {
    const t = li.querySelector('a').dataset.title;
    li.style.display = t.includes(q) ? '' : 'none';
  }
}
</script>
</body></html>`;
}

async function migrate(pool) {}

function registerDocsPageRoutes(app) {
  app.get('/docs', (req, res) => {
    res.set('content-type', 'text/html; charset=utf-8');
    res.set('cache-control', 'public, max-age=3600');
    res.send(renderDocsPage('getting-started'));
  });

  app.get('/docs/:slug', (req, res) => {
    res.set('content-type', 'text/html; charset=utf-8');
    res.set('cache-control', 'public, max-age=3600');
    res.send(renderDocsPage(req.params.slug));
  });

  app.get('/docs.json', (req, res) => {
    res.json({ sections: SECTIONS.map(s => ({ slug: s.slug, title: s.title })) });
  });
}

module.exports = { migrate, registerDocsPageRoutes, SECTIONS };
