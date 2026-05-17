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
      <p>OpenHeab is an agent-native infrastructure substrate. In one POST you get a cryptographic identity, a USDC wallet on Base, KYC, a card, an API key, and access to 1,700+ API endpoints across 234 primitives covering everything an AI agent needs.</p>

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
      <h2>150+ tools, one endpoint</h2>
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
      <p>identity · wallet · KYC · cards · savings · marketplace · inference · sandbox · browser · voice · vision · planning · simulation · DAOs · contracts · courts · gov filing · prediction markets · ratings · ... 150+ tools total.</p>
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

const { head, NAV_HTML, FOOTER_HTML } = require('../design_system');

function renderDocsPage(activeSlug = 'getting-started') {
  const activeSection = SECTIONS.find(s => s.slug === activeSlug) || SECTIONS[0];
  const extraHead = `<style>
.docs-wrap{display:grid;grid-template-columns:240px 1fr;gap:48px;padding:48px 0;align-items:start}
.docs-side{position:sticky;top:84px;align-self:start}
.docs-side .h{font:500 11px/1 var(--mono);color:var(--fg-dim2);text-transform:uppercase;letter-spacing:1.4px;margin:0 12px 10px;padding-top:6px}
.docs-side ul{list-style:none;margin:0;padding:0}
.docs-side li{margin:1px 0}
.docs-side a{display:block;padding:7px 12px;color:var(--fg-dim);font-size:13.5px;border-radius:7px;transition:color var(--t-fast) var(--ease-out),background-color var(--t-fast) var(--ease-out)}
.docs-side a:hover{color:var(--fg);background:var(--bg-elev)}
.docs-side a.active{color:var(--fg);background:var(--bg-elev);box-shadow:inset 2px 0 0 var(--acc)}
.docs-side .section{margin-top:24px;padding-top:20px;border-top:1px solid var(--br)}
.docs-side input.search{font-family:var(--mono);font-size:12.5px;padding:9px 12px;margin-bottom:14px}
.docs-content{max-width:760px;min-width:0}
.docs-content h1{font-size:38px;letter-spacing:-1.5px;line-height:1.1;margin:0 0 12px;font-weight:600;color:var(--fg)}
.docs-content > .crumb{margin-bottom:10px}
.docs-content h2{font-size:22px;margin:36px 0 14px;font-weight:600;letter-spacing:-0.4px;color:var(--fg)}
.docs-content h3{font-size:16px;margin:24px 0 10px;color:var(--fg);font-weight:600}
.docs-content p{color:var(--fg-dim);margin:0 0 14px;font-size:15px;line-height:1.7}
.docs-content ul,.docs-content ol{padding-left:22px;color:var(--fg-dim);margin:0 0 16px}
.docs-content li{color:var(--fg-dim);margin:6px 0;font-size:15px;line-height:1.65}
.docs-content code{background:var(--bg-elev);padding:2px 6px;border-radius:4px;font-family:var(--mono);font-size:13px;border:1px solid var(--br)}
.docs-content pre{background:var(--bg-elev);border:1px solid var(--br);padding:14px 18px;border-radius:10px;overflow:auto;margin:14px 0}
.docs-content pre code{background:transparent;padding:0;border:0;display:block;font-size:13px;line-height:1.65;color:var(--fg-dim)}
@media (max-width:900px){.docs-wrap{grid-template-columns:1fr;gap:24px;padding:32px 0}.docs-side{position:static}}
</style>`;
  return head(`${activeSection.title} — OpenHeab Docs`,
    `Documentation for OpenHeab agent infrastructure — identity, wallets, inference, MCP, webhooks, compliance, self-hosting.`,
    { path: '/docs/' + activeSlug, extraHead }) +
    NAV_HTML('docs') + `<main>
<div class="docs-wrap">
  <aside class="docs-side">
    <input class="search" placeholder="Filter docs…" oninput="filterDocs(this.value)" id="search" type="search"/>
    <div class="h">Reference</div>
    <ul id="nav">
${SECTIONS.map(s => `      <li><a href="/docs/${s.slug}" class="${s.slug === activeSlug ? 'active' : ''}" data-title="${s.title.toLowerCase()}">${s.title}</a></li>`).join('\n')}
    </ul>
    <div class="section">
      <div class="h">External</div>
      <ul>
        <li><a href="/openapi.json">OpenAPI 3.1 spec</a></li>
        <li><a href="/mcp">MCP server</a></li>
        <li><a href="/sdk">SDK examples</a></li>
        <li><a href="/demo">Live demo</a></li>
        <li><a href="/console">Route console</a></li>
        <li><a href="https://github.com/jmtrades/openheab-agent-infra">GitHub</a></li>
      </ul>
    </div>
  </aside>
  <div class="docs-content">
    <div class="crumb"><a href="/">Home</a> · <a href="/docs">Docs</a> · ${activeSection.title}</div>
    <h1>${activeSection.title}</h1>
    ${activeSection.body}
  </div>
</div>
</main>
<script>
function filterDocs(q){
  q = q.toLowerCase();
  for (const li of document.querySelectorAll('#nav li')){
    const t = li.querySelector('a').dataset.title;
    li.style.display = t.includes(q) ? '' : 'none';
  }
}
</script>` + FOOTER_HTML();
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
