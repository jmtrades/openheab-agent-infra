// ============================================================================
// Marketing landing + docs. Server-rendered. Single CSS block. No JS frameworks.
// Numbers are live — derived from collectRoutes(app) + primitive count.
// ============================================================================
const { collectRoutes } = require('./status_page');

function publicUrl() {
  return (process.env.OPERATOR_PUBLIC_URL || 'https://openheab.com').replace(/\/$/, '');
}

function primitiveCount() {
  try { return Object.keys(require('./integration').primitives).length; }
  catch { return 154; }
}

// ----------------------------------------------------------------------------
// Shared head + nav + footer (single CSS payload, ~3KB)
// ----------------------------------------------------------------------------
function head(title, description, opts = {}) {
  const path = opts.path || '/';
  const canonical = opts.canonical || `${publicUrl()}${path}`;
  const ogImage = opts.ogImage || `${publicUrl()}/og.svg`;
  const jsonLd = opts.jsonLd || '';
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><title>${title}</title>
<meta name="description" content="${description}">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="canonical" href="${canonical}">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<link rel="apple-touch-icon" href="/favicon.svg">
<link rel="manifest" href="/site.webmanifest">
<link rel="alternate" type="application/rss+xml" title="OpenHeab Blog" href="/blog/rss.xml">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${description}">
<meta property="og:type" content="website">
<meta property="og:url" content="${canonical}">
<meta property="og:site_name" content="OpenHeab">
<meta property="og:image" content="${ogImage}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:site" content="@openheab">
<meta name="twitter:title" content="${title}">
<meta name="twitter:description" content="${description}">
<meta name="twitter:image" content="${ogImage}">
<meta name="theme-color" content="#0a0a0a">
${jsonLd}
<style>
:root{
  --bg:#0a0a0a;--fg:#f0f0f0;--dim:#7a7a7a;--dim2:#bdbdbd;
  --acc:#7df9ff;--acc2:#3da3a8;--card:#0f0f0f;--br:#1a1a1a;
  --good:#22c55e;--warn:#f59e0b;--bad:#ef4444;
  --mono:ui-monospace,'SF Mono','JetBrains Mono',Menlo,Consolas,monospace;
  --sans:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,system-ui,sans-serif;
}
*{box-sizing:border-box;margin:0;padding:0}
html{scroll-behavior:smooth}
body{font:15px/1.55 var(--sans);background:var(--bg);color:var(--fg);font-feature-settings:'cv11','ss01','ss03'}
a{color:var(--acc);text-decoration:none}
a:hover{text-decoration:underline;text-decoration-color:var(--acc2);text-decoration-thickness:2px;text-underline-offset:3px}
code,pre,.mono{font-family:var(--mono)}
::selection{background:var(--acc);color:#000}

nav{display:flex;justify-content:space-between;align-items:center;padding:14px 28px;border-bottom:1px solid var(--br);position:sticky;top:0;background:rgba(10,10,10,.92);backdrop-filter:blur(10px);z-index:50}
nav .brand{font:600 16px/1 var(--mono);letter-spacing:-0.5px}
nav .brand .dot{color:var(--acc);font-weight:900}
nav .links{display:flex;gap:22px;font-size:14px;align-items:center}
nav .links a{color:var(--dim2)}
nav .links a:hover{color:var(--fg)}
nav .cta{background:var(--acc);color:#001a1f;padding:7px 14px;border-radius:6px;font-weight:600;font-size:13px;border:1px solid var(--acc)}
nav .cta:hover{background:#a4fcff;text-decoration:none}

main{max-width:1080px;margin:0 auto;padding:0 28px}
.hero{padding:96px 0 72px;border-bottom:1px solid var(--br)}
.hero .pill{display:inline-flex;gap:8px;align-items:center;padding:5px 12px;border:1px solid var(--br);border-radius:99px;font:500 12px/1 var(--mono);color:var(--dim2);margin-bottom:24px}
.hero .pill .live{width:7px;height:7px;border-radius:50%;background:var(--good);box-shadow:0 0 8px var(--good)}
.hero h1{font-size:clamp(36px,6vw,60px);line-height:1;letter-spacing:-2px;margin:0 0 22px;font-weight:700;max-width:920px}
.hero h1 em{font-style:normal;color:var(--acc);background:linear-gradient(180deg,transparent 60%,rgba(125,249,255,.15) 60%);padding:0 4px}
.hero p.lede{font-size:19px;color:var(--dim2);max-width:680px;margin:0 0 36px;line-height:1.5}
.btns{display:flex;gap:12px;flex-wrap:wrap}
.btn{padding:11px 20px;border-radius:7px;font-weight:600;font-size:14px;display:inline-flex;align-items:center;gap:8px;border:1px solid var(--br);transition:all .15s}
.btn.primary{background:var(--acc);color:#001a1f;border-color:var(--acc)}
.btn.primary:hover{background:#a4fcff;text-decoration:none;transform:translateY(-1px)}
.btn.ghost{background:transparent;color:var(--fg)}
.btn.ghost:hover{border-color:var(--dim2);text-decoration:none}

.metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:0;margin:48px 0 0;border:1px solid var(--br);border-radius:10px;overflow:hidden}
.metric{padding:18px 22px;border-right:1px solid var(--br)}
.metric:last-child{border-right:0}
.metric .v{font:600 28px/1 var(--mono);color:var(--fg);letter-spacing:-1px}
.metric .l{font:400 11px/1 var(--mono);color:var(--dim);text-transform:uppercase;letter-spacing:1px;margin-top:6px}

.section{padding:72px 0;border-bottom:1px solid var(--br)}
.section h2{font-size:32px;margin:0 0 14px;letter-spacing:-1px;font-weight:700}
.section .sub{color:var(--dim2);margin:0 0 40px;max-width:640px;font-size:16px;line-height:1.55}
.eyebrow{font:500 12px/1 var(--mono);color:var(--acc);text-transform:uppercase;letter-spacing:2px;margin:0 0 12px}

.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:14px}
.card{background:var(--card);border:1px solid var(--br);border-radius:10px;padding:22px;transition:border-color .15s}
.card:hover{border-color:var(--dim)}
.card .icn{font:600 11px/1 var(--mono);color:var(--acc);margin-bottom:10px;letter-spacing:1px}
.card h3{margin:0 0 8px;font-size:16px;font-weight:600}
.card p{margin:0;color:var(--dim2);font-size:14px;line-height:1.5}

.layers{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:1px;background:var(--br);border:1px solid var(--br);border-radius:10px;overflow:hidden}
.layer{background:var(--card);padding:18px 20px}
.layer .ln{font:600 11px/1 var(--mono);color:var(--acc);margin-bottom:6px;letter-spacing:1px}
.layer h4{font-size:14px;margin:0 0 8px;font-weight:600}
.layer .prims{font:500 12px/1.6 var(--mono);color:var(--dim2);word-break:break-word}

pre.code{background:#070707;border:1px solid var(--br);border-radius:8px;padding:18px 20px;font-size:13px;line-height:1.55;overflow:auto;margin:0;color:var(--dim2)}
pre.code .k{color:var(--acc)}
pre.code .s{color:#9aff9a}
pre.code .c{color:var(--dim)}

table{width:100%;border-collapse:collapse;font-size:14px;margin:8px 0}
th,td{padding:13px 16px;text-align:left;border-bottom:1px solid var(--br)}
th{font:600 11px/1 var(--mono);color:var(--dim);text-transform:uppercase;letter-spacing:1px}
.price{font:700 22px/1 var(--mono);color:var(--fg)}
.price small{font-size:13px;color:var(--dim);font-weight:400}

footer{max-width:1080px;margin:60px auto 40px;padding:24px 28px;border-top:1px solid var(--br);color:var(--dim);font-size:12px;display:flex;flex-wrap:wrap;justify-content:space-between;gap:16px}
footer .l{display:flex;gap:18px;flex-wrap:wrap}
footer a{color:var(--dim2)}

@media (max-width:640px){
  nav{padding:12px 18px}
  nav .links a:not(.cta){display:none}
  main{padding:0 18px}
  .hero{padding:60px 0 48px}
  .section{padding:48px 0}
}
</style></head><body>`;
}

function nav() {
  return `<nav>
  <a href="/" class="brand">openheab<span class="dot">.</span></a>
  <div class="links">
    <a href="/docs">Docs</a>
    <a href="/console">Console</a>
    <a href="/pricing">Pricing</a>
    <a href="https://github.com/jmtrades/openheab-agent-infra">GitHub</a>
    <a href="/docs#quickstart" class="cta">Get started →</a>
  </div>
</nav>`;
}

function footer() {
  return `<footer>
  <span>Apache-2.0 · open source · self-hostable</span>
  <span class="l">
    <a href="/openapi.json">openapi</a>
    <a href="/.well-known/agents.json">agents.json</a>
    <a href="/llms.txt">llms.txt</a>
    <a href="/mcp/manifest">mcp manifest</a>
    <a href="https://github.com/jmtrades/openheab-agent-infra">github</a>
  </span>
</footer></body></html>`;
}

// ----------------------------------------------------------------------------
// Layer + primitives map (drives the layer grid in the landing)
// ----------------------------------------------------------------------------
const LAYERS = [
  ['L1', 'Kernel', 'identity · secrets · aliases · storage · cost · analytics · portability · intelligence'],
  ['L2', 'Runtime', 'memory · tools · workflows · scheduler · inbox · inference · eval · continuity'],
  ['L3', 'Commerce', 'bank · bank_chain · bank_account · cards · savings · escrow · payouts · x402 · commerce · crypto'],
  ['L4', 'Trust', 'reputation · kyc · biometrics · aml · fraud · notary · tripwires · reversibility · insurance'],
  ['L5', 'Marketplace', 'marketplace · extensions · prompts · datasets · mcp_server'],
  ['L6', 'Operations', 'governance · publishing · email · phone · deployment · oauth_bridge · entities · tax'],
  ['L7', 'Perception', 'sandbox · browser · voice · vision · video · search'],
  ['L8', 'Knowledge', 'documents · maps · knowledge · translate · moderation · fact_check'],
  ['L9', 'Web3 finance', 'multisig · lending · defi · tokens · nft · bridges'],
  ['L10', 'Infrastructure', 'dns · hosting · database · ipfs · cache · cdn'],
  ['L11', 'AGI cognition', 'planning · simulation · beliefs · goals · skills · causal'],
  ['L12', 'AGI ops', 'interpretability · fine_tuning · federated_learning'],
  ['L13', 'Org / business', 'crm · projects · leads · outreach · forms · dao_factory'],
  ['L14', 'Business essentials', 'chat · invoicing · compute · news · calendar · billing · contracts · courts'],
  ['L15', 'Domain', 'health · passport · logistics · property · robotics · api_management'],
  ['L16', 'Revenue commerce', 'brokerage · prediction_markets · shopping · travel · advertising · media · ratings · booking'],
  ['L17', 'Developer infra', 'github · ci_cd · monitoring · error_tracking · feature_flags · experiments · webhooks · events'],
  ['L18', 'AGI learning + gov/legal', 'learning · voice_agents · labs · gov_filing · legal_research · court_records · ip_registry · climate'],
  ['L19', 'Customer service + community', 'support · referrals · loyalty · surveys · recruiting · supply_chain · licensing · benchmarks'],
  ['L20', 'Org / billing / commerce ops', 'org · subscriptions · metering · revenue'],
  ['L21', 'Enterprise readiness', 'sso · rbac · compliance_pack · credits'],
  ['L22', 'Growth + distribution', 'onboarding · dashboard · embed · public_directory'],
  ['L23', 'Channel + payments', 'partnerships · whitelabel · ach · quotes'],
  ['L24', 'Realtime', 'realtime (SSE event stream of every audit-chained action)']
];

// ----------------------------------------------------------------------------
// Landing
// ----------------------------------------------------------------------------
function renderLanding(app) {
  const routes = collectRoutes(app);
  const prims = primitiveCount();
  const desc = `${prims} primitives. Identity, USDC bank, KYC, email, memory, marketplaces, perception, AGI cognition — every primitive an AI agent needs to act on the internet. Open source. Self-hostable.`;

  // Comprehensive JSON-LD: Organization + SoftwareApplication + FAQPage + WebSite (search action)
  let jsonLd = '';
  try {
    const seo = require('./primitives/seo');
    jsonLd = `<script type="application/ld+json">${seo.organizationJsonLd()}</script>
<script type="application/ld+json">${seo.softwareApplicationJsonLd(prims, routes.length)}</script>
<script type="application/ld+json">${seo.faqJsonLd()}</script>
<script type="application/ld+json">${seo.searchActionJsonLd()}</script>`;
  } catch {}

  return head('OpenHeab — agent-native infrastructure for AI agents and AGI', desc, { path: '/', jsonLd }) + nav() + `<main>

<section class="hero">
  <span class="pill"><span class="live"></span> ${prims} primitives live · ${routes.length} routes</span>
  <h1>Everything an AI agent will ever need to <em>act on the internet</em>. One open API.</h1>
  <p class="lede">A signed Ed25519 DID. A non-custodial USDC wallet on Base. Virtual + physical debit cards. Interest-bearing savings. KYC against 5 sanctions sources. Encrypted memory. Marketplaces. Cognition. Compliance. Cards. Payouts. All audit-chained. Open source. Free to self-host.</p>
  <div class="btns">
    <a href="/signup" class="btn primary">Sign up free →</a>
    <a href="/playground" class="btn ghost">Try in playground</a>
    <a href="https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fjmtrades%2Fopenheab-agent-infra&env=DATABASE_URL,IDENTITY_MASTER_KEK,CRYPTO_MASTER_KEK,OPERATOR_PUBLIC_URL,OPERATOR_ADMIN_TOKEN&envDescription=Generate%20KEKs%20with%20openssl%20rand%20-hex%2032&envLink=https%3A%2F%2Fgithub.com%2Fjmtrades%2Fopenheab-agent-infra%2Fblob%2Fmain%2F.env.example" class="btn ghost" style="display:inline-flex;align-items:center;gap:6px">▲ Deploy to Vercel</a>
    <a href="https://github.com/jmtrades/openheab-agent-infra" class="btn ghost">Source</a>
  </div>

  <div class="metrics">
    <div class="metric"><div class="v">${prims}</div><div class="l">Primitives</div></div>
    <div class="metric"><div class="v">${routes.length}</div><div class="l">HTTP routes</div></div>
    <div class="metric"><div class="v">24</div><div class="l">Layers</div></div>
    <div class="metric"><div class="v">145+</div><div class="l">MCP tools</div></div>
    <div class="metric"><div class="v">14</div><div class="l">Revenue lines</div></div>
    <div class="metric"><div class="v">$10B+</div><div class="l">Saturation ARR</div></div>
  </div>
</section>

<section class="section">
  <p class="eyebrow">The bundle</p>
  <h2>23 layers. ${prims} primitives. Zero ceremony.</h2>
  <p class="sub">Every category an autonomous agent encounters. No need to glue together 12 SaaS vendors — every primitive is in the same audit chain, signed by the same Ed25519 key, billed in the same USDC.</p>
  <div class="layers">
${LAYERS.map(([code, name, prims]) => `    <div class="layer"><div class="ln">${code}</div><h4>${name}</h4><div class="prims">${prims}</div></div>`).join('\n')}
  </div>
</section>

<section class="section">
  <p class="eyebrow">The primitives that matter most</p>
  <h2>What you get the moment you call <code>/v1/identities</code>.</h2>
  <div class="grid">
    <div class="card"><div class="icn">L1 IDENTITY</div><h3>Signed DID + Ed25519 keypair</h3><p>did:op:abc... — cryptographically verifiable. Capability tokens. Key rotation. Backup recovery.</p></div>
    <div class="card"><div class="icn">L3 BANK</div><h3>Real USDC wallet on Base</h3><p>Non-custodial. AES-256-GCM-encrypted private key. 1% take rate via FeeSplitter. Multi-chain supported.</p></div>
    <div class="card"><div class="icn">L3 CARDS</div><h3>Virtual + physical debit cards</h3><p>JIT-funded from your USDC wallet at swipe time. Per-merchant + per-tx + monthly limits. Stripe Issuing.</p></div>
    <div class="card"><div class="icn">L3 SAVINGS</div><h3>4% APY interest-bearing accounts</h3><p>Daily accrual cron. Routes yield via Aave / Compound / Morpho. Auto-compound. Lock-up optional.</p></div>
    <div class="card"><div class="icn">L4 KYC</div><h3>5-source sanctions screening</h3><p>OFAC + UN + UK HMT + EU CFSP + OpenSanctions PEP. Tier 0-4. Refreshed daily.</p></div>
    <div class="card"><div class="icn">L4 BIOMETRICS</div><h3>Liveness + face-match</h3><p>Selfie + ID document. Liveness challenge. Returns confidence + risk band.</p></div>
    <div class="card"><div class="icn">L5 MCP</div><h3>120+ MCP tools at /mcp</h3><p>Drop into Claude / OpenAI / Cursor / VS Code. JSON-RPC 2.0 over HTTP.</p></div>
    <div class="card"><div class="icn">L6 EMAIL</div><h3>your-agent@openheab.com</h3><p>Inbound + outbound. DKIM + SPF signed. Routes into agent inbox by DID.</p></div>
    <div class="card"><div class="icn">L7 PERCEPTION</div><h3>Sandbox · browser · voice · vision · video</h3><p>Headless browsers. Code sandboxes. TTS + STT. Image gen + analysis. Video gen.</p></div>
    <div class="card"><div class="icn">L11 COGNITION</div><h3>Planning · simulation · beliefs · goals</h3><p>Multi-step plans. World-model simulation. Probabilistic beliefs. Skill library.</p></div>
    <div class="card"><div class="icn">L20 SUBSCRIPTIONS</div><h3>Free / Pro $99 / Scale $349 / Enterprise $2,499</h3><p>Quota-bounded. Stripe-billed. Upgrade in one call. Pre-paid credit packs available.</p></div>
    <div class="card"><div class="icn">L21 COMPLIANCE</div><h3>SOC 2 / GDPR / HIPAA / PCI / ISO 27001</h3><p>Continuous evidence collection. SAML/OIDC SSO. RBAC. Auto-generated audit packages.</p></div>
  </div>
</section>

<section class="section" id="pricing">
  <p class="eyebrow">Transparent pricing</p>
  <h2>Pay only for what you use. Free to start.</h2>
  <p class="sub">Self-hosted is free forever. Hosted plans below. Annual billing 20% off.</p>
  <table>
    <thead><tr><th>Plan</th><th>Price</th><th>Inference</th><th>Agents</th><th>Support</th></tr></thead>
    <tbody>
      <tr><td><strong>Free</strong></td><td class="price">$0</td><td>1k calls/mo</td><td>1</td><td>Community</td></tr>
      <tr><td><strong>Pro</strong></td><td class="price">$99 <small>/mo</small></td><td>100k calls/mo</td><td>10</td><td>Email · 24h</td></tr>
      <tr><td><strong>Scale</strong></td><td class="price">$349 <small>/mo</small></td><td>1M calls/mo</td><td>100</td><td>Priority chat · 4h</td></tr>
      <tr><td><strong>Enterprise</strong></td><td class="price">$2,499<small>+/mo</small></td><td>Unlimited</td><td>Unlimited</td><td>SSO · SLA · CSM</td></tr>
    </tbody>
  </table>
  <p style="color:var(--dim);margin-top:18px;font-size:13px">Plus take-rates: 1% on USDC transfers · 2% card interchange · 30% marketplace cut · 10% inference markup · 0.5% A2H payouts. <a href="/REVENUE_NOW.md">Full revenue model →</a></p>
</section>

<section class="section" id="quickstart">
  <p class="eyebrow">Quickstart</p>
  <h2>30 seconds to a working agent.</h2>
  <pre class="code"><span class="c"># 1. Create an agent identity. Returns DID + USDC wallet on Base.</span>
<span class="k">curl</span> -X POST ${publicUrl()}/v1/identities \\
  -H <span class="s">'content-type: application/json'</span> \\
  -d <span class="s">'{"display_name":"my-agent"}'</span>

<span class="c"># 2. Check the wallet balance (real on-chain eth_call).</span>
<span class="k">curl</span> ${publicUrl()}/v1/agents/$DID/wallet/balance \\
  -H <span class="s">'Authorization: Bearer $API_KEY'</span>

<span class="c"># 3. Send USDC to another agent (1% fee → FeeSplitter).</span>
<span class="k">curl</span> -X POST ${publicUrl()}/v1/agents/$DID/wallet/transfer \\
  -H <span class="s">'Authorization: Bearer $API_KEY'</span> \\
  -H <span class="s">'X-Agent-Sig: $ED25519_SIGNATURE'</span> \\
  -d <span class="s">'{"to_did":"did:op:...", "amount":"5.00"}'</span></pre>
</section>

<section class="section">
  <p class="eyebrow">Why now</p>
  <h2>The window for this is open. It closes in 18 months.</h2>
  <div class="grid">
    <div class="card"><h3>MCP became the standard</h3><p>Late 2024. Every primitive we ship distributes automatically to every Claude/OpenAI/Cursor/VS-Code client.</p></div>
    <div class="card"><h3>USDC TVL on Base &gt; $35B</h3><p>Stablecoin liquidity is finally enough for real agent commerce. Gas costs are sub-cent.</p></div>
    <div class="card"><h3>Foundation models hit "good enough"</h3><p>Claude 4.x, GPT-5, Gemini 2 reliably call tools. Agent demand exploded in 2025.</p></div>
    <div class="card"><h3>Regulators want verifiable agents</h3><p>EU AI Act + US AI safety EO will require this by 2027. We&apos;re built for it.</p></div>
    <div class="card"><h3>5+ infra startups raised</h3><p>None covers more than ~12 of our ${prims} primitives. The bundling thesis is wide-open.</p></div>
    <div class="card"><h3>Self-hosted = free</h3><p>You take the substrate, run it on Vercel + Neon, never pay us anything. We win on hosted convenience + marketplace network effects.</p></div>
  </div>
</section>

</main>` + footer();
}

// ----------------------------------------------------------------------------
// Docs
// ----------------------------------------------------------------------------
function renderDocs(app) {
  const prims = primitiveCount();
  return head('OpenHeab Docs — agent-native substrate API',
    `${prims} primitives. Identity, USDC bank, KYC, email, memory, marketplaces, perception, AGI cognition.`
  ) + nav() + `<main>
<section class="hero" style="padding:48px 0">
  <span class="pill">api version v1</span>
  <h1 style="font-size:42px">Documentation</h1>
  <p class="lede">Every primitive, every endpoint. Full machine-readable spec at <a href="/openapi.json">/openapi.json</a>. Live route browser at <a href="/console">/console</a>.</p>
</section>
<section class="section" id="quickstart">
  <p class="eyebrow">Quickstart</p>
  <h2>From zero to first transfer in 30 seconds.</h2>
  <h3 style="margin:32px 0 10px;font-size:16px;font-weight:600">1. Create an agent</h3>
  <pre class="code"><span class="k">curl</span> -X POST ${publicUrl()}/v1/identities \\
  -H <span class="s">'content-type: application/json'</span> \\
  -d <span class="s">'{"display_name":"my-agent"}'</span></pre>
  <p style="color:var(--dim2);margin:14px 0;font-size:14px">Returns: <code>{ did, public_key, private_key, api_key, wallet: { address, chain: "base" } }</code>. Save the private key — it cannot be recovered.</p>

  <h3 style="margin:32px 0 10px;font-size:16px;font-weight:600">2. Check your wallet balance</h3>
  <pre class="code"><span class="k">curl</span> ${publicUrl()}/v1/agents/$DID/wallet/balance \\
  -H <span class="s">'Authorization: Bearer $API_KEY'</span></pre>

  <h3 style="margin:32px 0 10px;font-size:16px;font-weight:600">3. Wire the MCP server into Claude / Cursor / VS Code</h3>
  <pre class="code">{
  <span class="s">"mcpServers"</span>: {
    <span class="s">"openheab"</span>: {
      <span class="s">"url"</span>: <span class="s">"${publicUrl()}/mcp"</span>,
      <span class="s">"auth"</span>: <span class="s">"Bearer opk_..."</span>
    }
  }
}</pre>
  <p style="color:var(--dim2);margin:14px 0;font-size:14px">120+ tools available immediately. <a href="/mcp/manifest">View the manifest →</a></p>

  <h3 style="margin:32px 0 10px;font-size:16px;font-weight:600">4. Use the SDK</h3>
  <pre class="code"><span class="c"># Python</span>
pip install openheab
<span class="c"># TypeScript</span>
npm install @openheab/sdk</pre>
</section>

<section class="section">
  <p class="eyebrow">Authentication</p>
  <h2>Three ways to authenticate.</h2>
  <ol style="color:var(--dim2);font-size:15px;padding-left:24px;line-height:1.8">
    <li><strong style="color:var(--fg)">API key</strong> — <code>Authorization: Bearer opk_...</code> · simplest, returned at signup</li>
    <li><strong style="color:var(--fg)">Signed request</strong> — <code>X-Agent-Sig</code> Ed25519 signature over <code>METHOD\\nPATH\\nSHA256(body)</code> · required for high-value endpoints (transfers, key rotation)</li>
    <li><strong style="color:var(--fg)">Demo mode</strong> — <code>X-Demo-DID: did:op:demo</code> · only when <code>DEMO_MODE=true</code></li>
  </ol>
</section>

<section class="section">
  <p class="eyebrow">Read more</p>
  <h2>Reference + strategy.</h2>
  <div class="grid">
    <div class="card"><h3><a href="/openapi.json">OpenAPI spec</a></h3><p>Full machine-readable spec. Import into Postman, Insomnia, Bruno.</p></div>
    <div class="card"><h3><a href="/console">Live route console</a></h3><p>Browse all live routes by primitive family. Filter by HTTP verb.</p></div>
    <div class="card"><h3><a href="/mcp/manifest">MCP manifest</a></h3><p>120+ tools exposed for Claude / OpenAI / Cursor / VS Code clients.</p></div>
    <div class="card"><h3><a href="https://github.com/jmtrades/openheab-agent-infra/blob/main/BILLION_DOLLAR_PATH.md">BILLION_DOLLAR_PATH.md</a></h3><p>The 7-year arc to $1B+ ARR. 14 revenue layers, capital plan, moats.</p></div>
    <div class="card"><h3><a href="https://github.com/jmtrades/openheab-agent-infra/blob/main/REVENUE_NOW.md">REVENUE_NOW.md</a></h3><p>The 90-day path to $10M ARR. Week-by-week execution plan.</p></div>
    <div class="card"><h3><a href="https://github.com/jmtrades/openheab-agent-infra/blob/main/CLAUDE.md">CLAUDE.md</a></h3><p>Project memory + architectural conventions. Auto-loaded by Claude Code.</p></div>
  </div>
</section>
</main>` + footer();
}

// ----------------------------------------------------------------------------
// Pricing page (lightweight; just wraps the table)
// ----------------------------------------------------------------------------
function renderPricing() {
  return head('OpenHeab — pricing',
    'Free to self-host. Pro $99/mo. Scale $349/mo. Enterprise $2,499+/mo. Plus 1% USDC transfers, 2% card interchange, 30% marketplace, 10% inference.'
  ) + nav() + `<main>
<section class="hero">
  <span class="pill">simple, transparent</span>
  <h1>Pay only for what you use.</h1>
  <p class="lede">Self-hosted is free forever. Hosted plans below. Annual billing 20% off. Volume discounts above $50K/mo.</p>
</section>
<section class="section">
  <table>
    <thead><tr><th>Plan</th><th>Price</th><th>Inference / mo</th><th>Agents</th><th>Storage</th><th>Support</th><th>SSO / SOC 2</th></tr></thead>
    <tbody>
      <tr><td><strong>Free</strong></td><td class="price">$0</td><td>1k calls</td><td>1</td><td>1 GB</td><td>Community</td><td>—</td></tr>
      <tr><td><strong>Pro</strong></td><td class="price">$99 <small>/mo</small></td><td>100k calls</td><td>10</td><td>50 GB</td><td>Email · 24h</td><td>—</td></tr>
      <tr><td><strong>Scale</strong></td><td class="price">$349 <small>/mo</small></td><td>1M calls</td><td>100</td><td>500 GB</td><td>Priority · 4h</td><td>—</td></tr>
      <tr><td><strong>Enterprise</strong></td><td class="price">$2,499<small>+/mo</small></td><td>Unlimited</td><td>Unlimited</td><td>Unlimited</td><td>Dedicated CSM</td><td>✓</td></tr>
    </tbody>
  </table>
</section>
<section class="section">
  <p class="eyebrow">Take-rates</p>
  <h2>Plus a small slice of every transaction.</h2>
  <table>
    <thead><tr><th>Layer</th><th>Take-rate</th><th>Notes</th></tr></thead>
    <tbody>
      <tr><td>USDC transfers (FeeSplitter)</td><td><strong>1.0%</strong></td><td>On gross amount; routed via Solidity contract on Base</td></tr>
      <tr><td>Card interchange</td><td><strong>2.0%</strong></td><td>Stripe Issuing standard rate, passthrough to network</td></tr>
      <tr><td>Marketplace (extensions, skills, prompts, datasets)</td><td><strong>30.0%</strong></td><td>70/30 publisher/platform split</td></tr>
      <tr><td>Inference markup</td><td><strong>10.0%</strong></td><td>On top of provider list price (Anthropic, OpenAI, Google, etc.)</td></tr>
      <tr><td>A2H fiat payouts</td><td><strong>0.5%</strong></td><td>Stripe Connect / Wise / USDC on-ramp</td></tr>
      <tr><td>Compute markup</td><td><strong>15.0%</strong></td><td>GPU/CPU rental from Modal, E2B, Coreweave, etc.</td></tr>
      <tr><td>Lending spread</td><td><strong>~2% APY</strong></td><td>Net of pool yield paid to lenders</td></tr>
      <tr><td>Brokerage commission</td><td><strong>0.5 bps</strong></td><td>Per equity / crypto trade</td></tr>
    </tbody>
  </table>
</section>
<section class="section">
  <p class="eyebrow">Pre-purchased credits</p>
  <h2>Bulk credits for predictable usage. Always cheaper than monthly overages.</h2>
  <table>
    <thead><tr><th>Pack</th><th>Price</th><th>Credits</th><th>Bonus</th></tr></thead>
    <tbody>
      <tr><td>Starter</td><td class="price">$99</td><td>5,000</td><td>—</td></tr>
      <tr><td>Growth</td><td class="price">$899</td><td>55,000</td><td>+10%</td></tr>
      <tr><td>Pro</td><td class="price">$7,999</td><td>600,000</td><td>+20%</td></tr>
      <tr><td>Enterprise</td><td class="price">$69,999</td><td>6,500,000</td><td>+30%</td></tr>
    </tbody>
  </table>
  <p style="color:var(--dim);margin-top:18px;font-size:13px">Credits never expire on Pro+ and Enterprise. Starter and Growth credits expire after 12 months.</p>
</section>
</main>` + footer();
}

// ----------------------------------------------------------------------------
// Register
// ----------------------------------------------------------------------------
function registerPages(app) {
  app.get('/', (req, res, next) => {
    if (req.headers.accept?.includes('text/html')) {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.setHeader('cache-control', 'public, max-age=300');
      return res.send(renderLanding(app));
    }
    next();
  });
  app.get('/docs', (req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.setHeader('cache-control', 'public, max-age=300');
    res.send(renderDocs(app));
  });
  app.get('/pricing', (req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.setHeader('cache-control', 'public, max-age=300');
    res.send(renderPricing());
  });
}

module.exports = { registerPages, renderLanding, renderDocs, renderPricing };
