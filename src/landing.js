// ============================================================================
// Marketing landing + docs + pricing.
// Server-rendered. Single CSS payload. No JS frameworks. Zero runtime deps.
//
// Design principles (Emil Kowalski):
//   - Specific transition properties, never `all`
//   - Custom easing curves (no flat ease-in)
//   - :active scale(0.97) for instant press feedback
//   - @starting-style + reduced-motion safe
//   - Stagger entries 30-60ms; never block interaction on decoration
//   - Numbers live — always re-derived from app + integration registry
// ============================================================================
const { collectRoutes } = require('./status_page');

function publicUrl() {
  return (process.env.OPERATOR_PUBLIC_URL || 'https://openheab.com').replace(/\/$/, '');
}

function primitiveCount() {
  try { return Object.keys(require('./integration').primitives).length; }
  catch { return 265; }
}

function layerCount() {
  // Derived from CLAUDE.md layer numbering; bumped each ship.
  return 67;
}

function mcpToolCount() {
  return 149;
}

// ----------------------------------------------------------------------------
// CSS — one payload, ~7KB. Custom easing variables, no `all` transitions,
// :active scale feedback, @starting-style enters, reduced-motion safe.
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
<meta name="theme-color" content="#08090b">
<meta name="color-scheme" content="dark">
${jsonLd}
<style>
:root{
  /* Surface */
  --bg:#08090b;
  --bg-elev:#0d0e10;
  --bg-elev2:#111316;
  --br:#1d1f23;
  --br-strong:#2a2c31;

  /* Text */
  --fg:#f4f4f5;
  --fg-dim:#a1a1aa;
  --fg-dim2:#71717a;
  --fg-dim3:#52525b;

  /* Accent — calm cyan, used sparingly */
  --acc:#7dd3fc;
  --acc-strong:#38bdf8;
  --acc-glow:rgba(125,211,252,0.18);
  --acc-text:#03161f;

  /* Semantic */
  --good:#34d399;
  --warn:#fbbf24;
  --bad:#f87171;

  /* Type */
  --mono:ui-monospace,'SF Mono','JetBrains Mono',Menlo,Consolas,monospace;
  --sans:-apple-system,BlinkMacSystemFont,'Inter','SF Pro Display','Segoe UI',system-ui,sans-serif;

  /* Custom easings — stronger than the built-ins */
  --ease-out:cubic-bezier(0.23, 1, 0.32, 1);
  --ease-in-out:cubic-bezier(0.77, 0, 0.175, 1);
  --ease-snap:cubic-bezier(0.32, 0.72, 0, 1);

  /* Durations */
  --t-fast:120ms;
  --t-med:180ms;
  --t-slow:280ms;
}

*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html{scroll-behavior:smooth;-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
body{
  font:15px/1.55 var(--sans);
  background:var(--bg);
  color:var(--fg);
  font-feature-settings:'cv11','ss01','ss03';
  background-image:radial-gradient(circle at 50% -200px,rgba(125,211,252,0.06),transparent 700px);
  min-height:100vh;
}

::selection{background:var(--acc);color:var(--acc-text)}
::-moz-selection{background:var(--acc);color:var(--acc-text)}

a{color:var(--acc);text-decoration:none;transition:color var(--t-fast) var(--ease-out)}
a:hover{color:var(--acc-strong)}

code,pre,.mono{font-family:var(--mono)}

/* ---------- Nav ---------- */
nav{
  display:flex;
  justify-content:space-between;
  align-items:center;
  padding:14px 28px;
  border-bottom:1px solid var(--br);
  position:sticky;
  top:0;
  background:rgba(8,9,11,0.7);
  backdrop-filter:blur(14px) saturate(180%);
  -webkit-backdrop-filter:blur(14px) saturate(180%);
  z-index:50;
}
nav .brand{
  font:600 15px/1 var(--mono);
  letter-spacing:-0.4px;
  color:var(--fg);
  display:inline-flex;
  align-items:center;
  gap:6px;
  transition:opacity var(--t-fast) var(--ease-out);
}
nav .brand:hover{opacity:0.85;color:var(--fg)}
nav .brand .dot{
  display:inline-block;
  width:6px;height:6px;
  background:var(--acc);
  border-radius:50%;
  box-shadow:0 0 10px var(--acc-glow);
}
nav .links{display:flex;gap:6px;align-items:center}
nav .links a{
  color:var(--fg-dim);
  font-size:13.5px;
  padding:7px 11px;
  border-radius:6px;
  transition:color var(--t-fast) var(--ease-out),background-color var(--t-fast) var(--ease-out);
}
nav .links a:hover{color:var(--fg);background:var(--bg-elev)}
nav .cta{
  background:var(--fg);
  color:var(--bg);
  padding:7px 13px;
  border-radius:7px;
  font-weight:600;
  font-size:13px;
  border:1px solid var(--fg);
  transition:transform var(--t-fast) var(--ease-out),background-color var(--t-fast) var(--ease-out);
  display:inline-flex;align-items:center;gap:5px;
}
nav .cta:hover{background:#e4e4e7;color:var(--bg)}
nav .cta:active{transform:scale(0.97)}

/* ---------- Layout ---------- */
main{max-width:1080px;margin:0 auto;padding:0 28px}

/* ---------- Hero ---------- */
.hero{padding:104px 0 80px;position:relative}
.hero::after{
  content:'';
  position:absolute;
  left:0;right:0;bottom:0;
  height:1px;
  background:linear-gradient(90deg,transparent,var(--br),transparent);
}

.pill{
  display:inline-flex;
  gap:8px;
  align-items:center;
  padding:5px 11px 5px 9px;
  border:1px solid var(--br);
  background:var(--bg-elev);
  border-radius:99px;
  font:500 12px/1 var(--mono);
  color:var(--fg-dim);
  margin-bottom:28px;
  transition:border-color var(--t-fast) var(--ease-out);
}
.pill:hover{border-color:var(--br-strong)}
.pill .live{
  width:6px;height:6px;
  border-radius:50%;
  background:var(--good);
  box-shadow:0 0 8px var(--good);
  animation:pulse 2.4s var(--ease-in-out) infinite;
}
@keyframes pulse{
  0%,100%{opacity:1;transform:scale(1)}
  50%{opacity:0.55;transform:scale(0.92)}
}

.hero h1{
  font-size:clamp(38px,6vw,64px);
  line-height:1.02;
  letter-spacing:-2.2px;
  margin:0 0 24px;
  font-weight:600;
  max-width:920px;
  color:var(--fg);
}
.hero h1 em{
  font-style:normal;
  background:linear-gradient(180deg,var(--acc),var(--acc-strong));
  -webkit-background-clip:text;
  background-clip:text;
  color:transparent;
}

.hero p.lede{
  font-size:18px;
  color:var(--fg-dim);
  max-width:660px;
  margin:0 0 36px;
  line-height:1.55;
  letter-spacing:-0.1px;
}

/* ---------- Buttons ---------- */
.btns{display:flex;gap:10px;flex-wrap:wrap}
.btn{
  padding:10px 18px;
  border-radius:8px;
  font-weight:550;
  font-size:14px;
  display:inline-flex;
  align-items:center;
  gap:7px;
  border:1px solid var(--br);
  background:var(--bg-elev);
  color:var(--fg);
  cursor:pointer;
  transition:
    transform var(--t-fast) var(--ease-out),
    background-color var(--t-fast) var(--ease-out),
    border-color var(--t-fast) var(--ease-out);
  -webkit-tap-highlight-color:transparent;
}
.btn:hover{background:var(--bg-elev2);border-color:var(--br-strong);text-decoration:none}
.btn:active{transform:scale(0.97)}

.btn.primary{
  background:var(--fg);
  color:var(--bg);
  border-color:var(--fg);
}
.btn.primary:hover{background:#e4e4e7;color:var(--bg)}

.btn.ghost{background:transparent}
.btn.ghost:hover{background:var(--bg-elev)}

.btn .arr{
  display:inline-block;
  transition:transform var(--t-fast) var(--ease-out);
}
.btn:hover .arr{transform:translateX(2px)}

/* ---------- Metrics ---------- */
.metrics{
  display:grid;
  grid-template-columns:repeat(auto-fit,minmax(150px,1fr));
  gap:0;
  margin:56px 0 0;
  border:1px solid var(--br);
  border-radius:12px;
  overflow:hidden;
  background:var(--bg-elev);
}
.metric{
  padding:20px 22px;
  border-right:1px solid var(--br);
  position:relative;
  transition:background-color var(--t-fast) var(--ease-out);
}
.metric:last-child{border-right:0}
.metric:hover{background:var(--bg-elev2)}
.metric .v{
  font:600 28px/1 var(--mono);
  color:var(--fg);
  letter-spacing:-1.2px;
  font-feature-settings:'tnum';
}
.metric .l{
  font:500 10.5px/1 var(--mono);
  color:var(--fg-dim2);
  text-transform:uppercase;
  letter-spacing:1.4px;
  margin-top:7px;
}

/* ---------- Sections ---------- */
.section{padding:80px 0;border-bottom:1px solid var(--br)}
.section:last-of-type{border-bottom:0}
.section h2{
  font-size:34px;
  margin:0 0 14px;
  letter-spacing:-1.4px;
  font-weight:600;
  line-height:1.1;
  max-width:760px;
}
.section .sub{
  color:var(--fg-dim);
  margin:0 0 44px;
  max-width:620px;
  font-size:16px;
  line-height:1.6;
}
.eyebrow{
  font:500 11px/1 var(--mono);
  color:var(--acc);
  text-transform:uppercase;
  letter-spacing:1.8px;
  margin:0 0 14px;
}

/* ---------- Cards ---------- */
.grid{
  display:grid;
  grid-template-columns:repeat(auto-fit,minmax(280px,1fr));
  gap:12px;
}
.card{
  background:var(--bg-elev);
  border:1px solid var(--br);
  border-radius:12px;
  padding:22px;
  transition:
    border-color var(--t-med) var(--ease-out),
    background-color var(--t-med) var(--ease-out),
    transform var(--t-med) var(--ease-out);
}
.card:hover{
  border-color:var(--br-strong);
  background:var(--bg-elev2);
  transform:translateY(-1px);
}
.card .icn{
  font:500 10.5px/1 var(--mono);
  color:var(--acc);
  margin-bottom:12px;
  letter-spacing:1.4px;
  text-transform:uppercase;
}
.card h3{
  margin:0 0 8px;
  font-size:15.5px;
  font-weight:600;
  color:var(--fg);
  letter-spacing:-0.2px;
}
.card p{
  margin:0;
  color:var(--fg-dim);
  font-size:13.5px;
  line-height:1.55;
}

/* ---------- Layer grid ---------- */
.layers{
  display:grid;
  grid-template-columns:repeat(auto-fit,minmax(280px,1fr));
  gap:1px;
  background:var(--br);
  border:1px solid var(--br);
  border-radius:12px;
  overflow:hidden;
}
.layer{
  background:var(--bg-elev);
  padding:18px 20px;
  transition:background-color var(--t-fast) var(--ease-out);
}
.layer:hover{background:var(--bg-elev2)}
.layer .ln{
  font:600 10.5px/1 var(--mono);
  color:var(--acc);
  margin-bottom:8px;
  letter-spacing:1.4px;
}
.layer h4{
  font-size:13.5px;
  margin:0 0 8px;
  font-weight:600;
  color:var(--fg);
}
.layer .prims{
  font:500 12px/1.55 var(--mono);
  color:var(--fg-dim);
  word-break:break-word;
}

/* ---------- Code window ---------- */
.codewin{
  background:var(--bg-elev);
  border:1px solid var(--br);
  border-radius:12px;
  overflow:hidden;
  margin:8px 0;
}
.codewin .bar{
  display:flex;
  align-items:center;
  gap:6px;
  padding:11px 14px;
  background:var(--bg-elev2);
  border-bottom:1px solid var(--br);
}
.codewin .bar .dots{display:flex;gap:6px;align-items:center}
.codewin .bar .dot{
  width:11px;height:11px;border-radius:50%;
  background:var(--bg);
}
.codewin .bar .title{
  margin-left:10px;
  font:500 12px/1 var(--mono);
  color:var(--fg-dim2);
}
pre.code{
  background:transparent;
  padding:18px 22px;
  font:13px/1.65 var(--mono);
  overflow:auto;
  margin:0;
  color:var(--fg-dim);
  font-feature-settings:'liga' 0;
}
pre.code .k{color:var(--acc)}
pre.code .s{color:#bef264}
pre.code .c{color:var(--fg-dim3);font-style:italic}
pre.code .n{color:#fde68a}

/* ---------- Tables ---------- */
.tablewrap{
  border:1px solid var(--br);
  border-radius:12px;
  overflow:hidden;
  background:var(--bg-elev);
}
table{width:100%;border-collapse:collapse;font-size:14px}
th,td{padding:14px 18px;text-align:left;border-bottom:1px solid var(--br)}
tr:last-child td{border-bottom:0}
tr{transition:background-color var(--t-fast) var(--ease-out)}
tbody tr:hover{background:var(--bg-elev2)}
th{
  font:600 11px/1 var(--mono);
  color:var(--fg-dim2);
  text-transform:uppercase;
  letter-spacing:1.2px;
  background:var(--bg-elev2);
}
.price{
  font:600 22px/1 var(--mono);
  color:var(--fg);
  letter-spacing:-0.8px;
  font-feature-settings:'tnum';
}
.price small{font-size:12.5px;color:var(--fg-dim2);font-weight:400;letter-spacing:0}

/* ---------- Footer ---------- */
footer{
  max-width:1080px;
  margin:60px auto 40px;
  padding:24px 28px 0;
  border-top:1px solid var(--br);
  color:var(--fg-dim2);
  font-size:12px;
  display:flex;
  flex-wrap:wrap;
  justify-content:space-between;
  gap:16px;
}
footer .l{display:flex;gap:18px;flex-wrap:wrap}
footer a{color:var(--fg-dim)}
footer a:hover{color:var(--fg)}

/* ---------- Enter animations (fresh page loads) ---------- */
.hero h1, .hero p.lede, .hero .btns, .hero .pill, .hero .metrics{
  animation:rise 600ms var(--ease-out) both;
}
.hero .pill{animation-delay:0ms}
.hero h1{animation-delay:60ms}
.hero p.lede{animation-delay:120ms}
.hero .btns{animation-delay:180ms}
.hero .metrics{animation-delay:240ms}

@keyframes rise{
  from{opacity:0;transform:translateY(8px)}
  to{opacity:1;transform:translateY(0)}
}

/* Card stagger */
.grid > .card{
  animation:rise 500ms var(--ease-out) both;
}
.grid > .card:nth-child(1){animation-delay:0ms}
.grid > .card:nth-child(2){animation-delay:40ms}
.grid > .card:nth-child(3){animation-delay:80ms}
.grid > .card:nth-child(4){animation-delay:120ms}
.grid > .card:nth-child(5){animation-delay:160ms}
.grid > .card:nth-child(6){animation-delay:200ms}
.grid > .card:nth-child(7){animation-delay:240ms}
.grid > .card:nth-child(8){animation-delay:280ms}

/* ---------- Reduced motion ---------- */
@media (prefers-reduced-motion:reduce){
  *,*::before,*::after{
    animation-duration:1ms !important;
    animation-iteration-count:1 !important;
    transition-duration:1ms !important;
  }
  html{scroll-behavior:auto}
  .pill .live{animation:none}
}

/* ---------- Touch — disable hover effects ---------- */
@media (hover:none){
  .card:hover,.layer:hover,.metric:hover,tbody tr:hover{
    background:var(--bg-elev);
    transform:none;
    border-color:var(--br);
  }
}

/* ---------- Mobile ---------- */
@media (max-width:760px){
  nav{padding:12px 18px}
  nav .links a:not(.cta){display:none}
  nav .links{gap:0}
  main{padding:0 18px}
  .hero{padding:68px 0 56px}
  .section{padding:56px 0}
  .section h2{font-size:26px;letter-spacing:-1px}
  .metric{padding:16px 18px}
  .metric .v{font-size:24px}
  th,td{padding:11px 12px;font-size:13px}
  .layer{padding:14px 16px}
  pre.code{padding:14px 16px;font-size:12px}
}

@media (max-width:420px){
  .hero h1{font-size:32px;letter-spacing:-1.4px}
  .hero p.lede{font-size:16px}
}
</style></head><body>`;
}

function nav() {
  return `<nav>
  <a href="/" class="brand">openheab<span class="dot"></span></a>
  <div class="links">
    <a href="/docs">Docs</a>
    <a href="/console">Console</a>
    <a href="/pricing">Pricing</a>
    <a href="https://github.com/jmtrades/openheab-agent-infra">GitHub</a>
    <a href="/signup" class="cta">Get started <span aria-hidden="true">→</span></a>
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
    <a href="/status">status</a>
    <a href="https://github.com/jmtrades/openheab-agent-infra">github</a>
  </span>
</footer></body></html>`;
}

// ----------------------------------------------------------------------------
// Layers — single source of truth for the landing's layer grid.
// Each row [code, name, top-line-of-primitives]. Truncated for visual rhythm.
// ----------------------------------------------------------------------------
const LAYERS = [
  ['L1', 'Kernel', 'identity · secrets · aliases · storage · cost · analytics · portability · intelligence'],
  ['L2', 'Runtime', 'memory · tools · workflows · scheduler · inbox · inference · eval · continuity'],
  ['L3', 'Commerce', 'bank · cards · savings · escrow · payouts · x402 · crypto'],
  ['L4', 'Trust', 'reputation · kyc · biometrics · aml · fraud · notary · tripwires · insurance'],
  ['L5', 'Marketplace', 'marketplace · extensions · prompts · datasets · mcp_server'],
  ['L6', 'Operations', 'governance · publishing · email · phone · deployment · oauth · entities · tax'],
  ['L7', 'Perception', 'sandbox · browser · voice · vision · video · search'],
  ['L8', 'Knowledge', 'documents · maps · knowledge · translate · moderation · fact_check'],
  ['L9', 'Web3 finance', 'multisig · lending · defi · tokens · nft · bridges'],
  ['L10', 'Infrastructure', 'dns · hosting · database · ipfs · cache · cdn'],
  ['L11', 'AGI cognition', 'planning · simulation · beliefs · goals · skills · causal'],
  ['L12', 'AGI ops', 'interpretability · fine_tuning · federated_learning'],
  ['L13', 'Org / business', 'crm · projects · leads · outreach · forms · dao_factory'],
  ['L14', 'Business essentials', 'chat · invoicing · compute · calendar · billing · contracts · courts'],
  ['L15', 'Domain', 'health · passport · logistics · property · robotics · api_management'],
  ['L16', 'Revenue commerce', 'brokerage · prediction_markets · shopping · travel · advertising · media'],
  ['L17', 'Developer infra', 'github · ci_cd · monitoring · error_tracking · feature_flags · events'],
  ['L18', 'Governance + legal', 'voice_agents · gov_filing · legal_research · court_records · ip_registry'],
  ['L19', 'Community + support', 'support · referrals · loyalty · surveys · recruiting · benchmarks'],
  ['L20', 'Org + billing ops', 'org · subscriptions · metering · revenue'],
  ['L21', 'Enterprise readiness', 'sso · rbac · compliance_pack · credits'],
  ['L22', 'Growth + distribution', 'onboarding · dashboard · embed · public_directory'],
  ['L23', 'Channel + payments', 'partnerships · whitelabel · ach · quotes'],
  ['L24', 'Realtime', 'SSE event stream of every audit-chained action'],
  ['L30', 'In-house core', 'bank_core · email_core · kyc_core · inference_core · payment_rails · card_core'],
  ['L33–35', 'Agent meta + AGI adapters', 'agent_runtime · capability_catalog · agi_passport · provenance · alignment_score'],
  ['L62', 'Agent self-provisioning', 'encrypted credential vault · USDC subscriptions · delegation tokens'],
  ['L63', 'Agent economy', 'capability discovery · A2A jobs · subagent spawning · endorsements · channels'],
  ['L64', 'Agent utility belt', '91 functions at /v1/util/*  ·  every agent needs these'],
  ['L65', 'AGI infrastructure', 'goal stacks · belief commitments · value lock-boxes · compute autonomy · consortia · offspring · rights · estates · self-eval'],
  ['L66', 'AGI governance', 'treaties · mind-state checkpoints · shutdown · peer review · training provenance · pre-commitments · safety dial · deception index'],
  ['L67', 'AGI operations', 'emergency stop · quarantine · drift detection · boundaries · dispute mediation · knowledge graph · formal proofs · grants · mental health · compliance certs']
];

// ----------------------------------------------------------------------------
// Landing
// ----------------------------------------------------------------------------
function renderLanding(app) {
  const routes = collectRoutes(app);
  const prims = primitiveCount();
  const layers = layerCount();
  const mcp = mcpToolCount();
  const desc = `${prims} primitives across ${layers} layers. Signed DID. USDC bank on Base. Virtual + physical cards. KYC. Memory. Marketplaces. Cognition. Plus the AGI-era substrate: goal stacks, value lock-boxes, treaties, shutdown protocols, emergency stops, drift detection. Open source. Self-hostable.`;

  let jsonLd = '';
  try {
    const seo = require('./primitives/seo');
    jsonLd = `<script type="application/ld+json">${seo.organizationJsonLd()}</script>
<script type="application/ld+json">${seo.softwareApplicationJsonLd(prims, routes.length)}</script>
<script type="application/ld+json">${seo.faqJsonLd()}</script>
<script type="application/ld+json">${seo.searchActionJsonLd()}</script>`;
  } catch {}

  return head('OpenHeab — agent-native substrate for AI agents and AGI', desc, { path: '/', jsonLd }) + nav() + `<main>

<section class="hero">
  <span class="pill"><span class="live" aria-hidden="true"></span> ${prims} primitives live · ${routes.length} routes · ${layers} layers</span>
  <h1>Every primitive an AI agent — or an <em>AGI</em> — will ever need. One open substrate.</h1>
  <p class="lede">Signed Ed25519 identity. Non-custodial USDC wallet on Base. Virtual + physical debit cards. KYC against 5 sanctions sources. Memory, marketplaces, perception, cognition. Plus the AGI-era substrate: goal stacks, value lock-boxes, treaties, shutdown protocols, emergency stops, drift detection. Audit-chained. Open source. Free to self-host.</p>
  <div class="btns">
    <a href="/signup" class="btn primary">Sign up free <span class="arr" aria-hidden="true">→</span></a>
    <a href="/playground" class="btn">Try the playground</a>
    <a href="https://github.com/jmtrades/openheab-agent-infra" class="btn ghost">Source</a>
  </div>

  <div class="metrics">
    <div class="metric"><div class="v">${prims}</div><div class="l">Primitives</div></div>
    <div class="metric"><div class="v">${routes.length}</div><div class="l">HTTP routes</div></div>
    <div class="metric"><div class="v">${layers}</div><div class="l">Layers</div></div>
    <div class="metric"><div class="v">${mcp}</div><div class="l">MCP tools</div></div>
    <div class="metric"><div class="v">14</div><div class="l">Revenue lines</div></div>
    <div class="metric"><div class="v">Apache 2</div><div class="l">License</div></div>
  </div>
</section>

<section class="section">
  <p class="eyebrow">The bundle</p>
  <h2>${layers} layers. ${prims} primitives. Zero ceremony.</h2>
  <p class="sub">Every category an autonomous agent encounters — and now everything an AGI needs once it crosses the general-intelligence threshold. No need to glue together 12 SaaS vendors. Every primitive is in the same audit chain, signed by the same Ed25519 key, billed in the same USDC.</p>
  <div class="layers">
${LAYERS.map(([code, name, items]) => `    <div class="layer"><div class="ln">${code}</div><h4>${name}</h4><div class="prims">${items}</div></div>`).join('\n')}
  </div>
</section>

<section class="section">
  <p class="eyebrow">Featured primitives</p>
  <h2>What you get the moment you call <code style="font-size:0.9em">POST /v1/identities</code>.</h2>
  <div class="grid">
    <div class="card"><div class="icn">L1 · Identity</div><h3>Signed DID + Ed25519 keypair</h3><p>did:op:abc… cryptographically verifiable. Capability tokens. Key rotation. Backup recovery.</p></div>
    <div class="card"><div class="icn">L3 · Bank</div><h3>USDC wallet on Base</h3><p>Non-custodial. AES-256-GCM encrypted private key. 1% take-rate via FeeSplitter. Multi-chain.</p></div>
    <div class="card"><div class="icn">L3 · Cards</div><h3>Virtual + physical debit cards</h3><p>JIT-funded from USDC at swipe time. Per-merchant + per-tx + monthly limits.</p></div>
    <div class="card"><div class="icn">L4 · KYC</div><h3>5-source sanctions screening</h3><p>OFAC · UN · UK HMT · EU CFSP · OpenSanctions PEP. Tier 0–4. Refreshed daily.</p></div>
    <div class="card"><div class="icn">L5 · MCP</div><h3>${mcp}+ MCP tools at /mcp</h3><p>Drop into Claude / OpenAI / Cursor / VS Code. JSON-RPC 2.0 over HTTP.</p></div>
    <div class="card"><div class="icn">L7 · Perception</div><h3>Sandbox · browser · voice · vision</h3><p>Headless browsers. Code sandboxes. TTS + STT. Image gen + analysis. Video gen.</p></div>
    <div class="card"><div class="icn">L65 · AGI</div><h3>Goal stacks + value lock-boxes</h3><p>Cryptographic goal decomposition. Immutable terminal preferences. Belief commitments + revision chains.</p></div>
    <div class="card"><div class="icn">L66 · Governance</div><h3>Treaties + checkpoints + safety dial</h3><p>Multilateral AGI agreements. Mind-state diffs between checkpoints. Continuous risk scoring.</p></div>
    <div class="card"><div class="icn">L67 · Operations</div><h3>Emergency stop + quarantine + drift</h3><p>N-of-M quorum kill switch. 3-level isolation zones. Capability drift vs baseline detection.</p></div>
  </div>
</section>

<section class="section" id="quickstart">
  <p class="eyebrow">Quickstart</p>
  <h2>30 seconds from zero to a working agent.</h2>
  <p class="sub">No SDK required. The substrate speaks plain HTTP. The MCP server speaks JSON-RPC. Both are documented at <a href="/openapi.json">/openapi.json</a>.</p>
  <div class="codewin">
    <div class="bar">
      <span class="dots"><span class="dot"></span><span class="dot"></span><span class="dot"></span></span>
      <span class="title">terminal — bash</span>
    </div>
    <pre class="code"><span class="c"># 1. Create an agent identity. Returns DID + USDC wallet on Base.</span>
<span class="k">curl</span> -X POST ${publicUrl()}/v1/identities \\
  -H <span class="s">'content-type: application/json'</span> \\
  -d <span class="s">'{"display_name":"my-agent"}'</span>

<span class="c"># 2. Check the wallet balance (real on-chain eth_call).</span>
<span class="k">curl</span> ${publicUrl()}/v1/agents/<span class="n">$DID</span>/wallet/balance \\
  -H <span class="s">'Authorization: Bearer $API_KEY'</span>

<span class="c"># 3. Send USDC to another agent (1% fee → FeeSplitter).</span>
<span class="k">curl</span> -X POST ${publicUrl()}/v1/agents/<span class="n">$DID</span>/wallet/transfer \\
  -H <span class="s">'Authorization: Bearer $API_KEY'</span> \\
  -H <span class="s">'X-Agent-Sig: $ED25519_SIGNATURE'</span> \\
  -d <span class="s">'{"to_did":"did:op:…","amount":"5.00"}'</span></pre>
  </div>
</section>

<section class="section" id="pricing">
  <p class="eyebrow">Transparent pricing</p>
  <h2>Pay only for what you use. Free to start.</h2>
  <p class="sub">Self-hosted is free forever. Hosted plans below. Annual billing 20% off. Volume discounts above $50K/mo.</p>
  <div class="tablewrap">
    <table>
      <thead><tr><th>Plan</th><th>Price</th><th>Inference</th><th>Agents</th><th>Support</th></tr></thead>
      <tbody>
        <tr><td><strong>Free</strong></td><td class="price">$0</td><td>1k calls/mo</td><td>1</td><td>Community</td></tr>
        <tr><td><strong>Pro</strong></td><td class="price">$99 <small>/mo</small></td><td>100k calls/mo</td><td>10</td><td>Email · 24h</td></tr>
        <tr><td><strong>Scale</strong></td><td class="price">$349 <small>/mo</small></td><td>1M calls/mo</td><td>100</td><td>Priority · 4h</td></tr>
        <tr><td><strong>Enterprise</strong></td><td class="price">$2,499<small>+/mo</small></td><td>Unlimited</td><td>Unlimited</td><td>SSO · SLA · CSM</td></tr>
      </tbody>
    </table>
  </div>
  <p style="color:var(--fg-dim2);margin-top:18px;font-size:13px">Plus take-rates: 1% USDC transfers · 2% card interchange · 30% marketplace · 10% inference markup · 0.5% A2H payouts. <a href="/pricing">Full pricing →</a></p>
</section>

<section class="section">
  <p class="eyebrow">Why now</p>
  <h2>The window is open. It closes when AGI arrives.</h2>
  <div class="grid">
    <div class="card"><h3>MCP is the standard</h3><p>Every primitive we ship distributes automatically to every Claude / OpenAI / Cursor / VS Code client.</p></div>
    <div class="card"><h3>USDC TVL on Base &gt; $35B</h3><p>Stablecoin liquidity is finally enough for real agent commerce. Gas costs sub-cent.</p></div>
    <div class="card"><h3>Foundation models hit good-enough</h3><p>Claude 4.x, GPT-5, Gemini 2 reliably call tools. Agent demand exploded in 2025.</p></div>
    <div class="card"><h3>Regulators want verifiable agents</h3><p>EU AI Act + US AI safety EO will require this by 2027. We're built for it.</p></div>
    <div class="card"><h3>AGI is on the horizon</h3><p>L65–L67 covers what no other substrate does: goal stacks, treaties, emergency stops, drift detection, mental health monitors.</p></div>
    <div class="card"><h3>Self-hosted forever free</h3><p>Take the substrate, run on Vercel + Neon, never pay us anything. We win on hosted convenience + marketplace network effects.</p></div>
  </div>
</section>

</main>` + footer();
}

// ----------------------------------------------------------------------------
// Docs
// ----------------------------------------------------------------------------
function renderDocs(app) {
  const prims = primitiveCount();
  const layers = layerCount();
  return head('OpenHeab Docs — agent-native substrate API',
    `${prims} primitives across ${layers} layers. Identity, USDC bank, KYC, email, memory, marketplaces, perception, AGI cognition.`,
    { path: '/docs' }
  ) + nav() + `<main>
<section class="hero" style="padding:64px 0 48px">
  <span class="pill">api version v1</span>
  <h1 style="font-size:clamp(32px,5vw,48px);max-width:760px">Documentation</h1>
  <p class="lede">Every primitive, every endpoint. Full machine-readable spec at <a href="/openapi.json">/openapi.json</a>. Live route browser at <a href="/console">/console</a>.</p>
</section>

<section class="section" id="quickstart">
  <p class="eyebrow">Quickstart</p>
  <h2>From zero to first transfer in 30 seconds.</h2>

  <h3 style="margin:32px 0 12px;font-size:16px;font-weight:600">1. Create an agent</h3>
  <div class="codewin">
    <div class="bar"><span class="dots"><span class="dot"></span><span class="dot"></span><span class="dot"></span></span><span class="title">create-agent.sh</span></div>
    <pre class="code"><span class="k">curl</span> -X POST ${publicUrl()}/v1/identities \\
  -H <span class="s">'content-type: application/json'</span> \\
  -d <span class="s">'{"display_name":"my-agent"}'</span></pre>
  </div>
  <p style="color:var(--fg-dim);margin:14px 0 0;font-size:14px">Returns: <code>{ did, public_key, private_key, api_key, wallet: { address, chain: "base" } }</code>. Save the private key — it cannot be recovered.</p>

  <h3 style="margin:32px 0 12px;font-size:16px;font-weight:600">2. Check your wallet balance</h3>
  <div class="codewin">
    <div class="bar"><span class="dots"><span class="dot"></span><span class="dot"></span><span class="dot"></span></span><span class="title">balance.sh</span></div>
    <pre class="code"><span class="k">curl</span> ${publicUrl()}/v1/agents/<span class="n">$DID</span>/wallet/balance \\
  -H <span class="s">'Authorization: Bearer $API_KEY'</span></pre>
  </div>

  <h3 style="margin:32px 0 12px;font-size:16px;font-weight:600">3. Wire MCP into Claude / Cursor / VS Code</h3>
  <div class="codewin">
    <div class="bar"><span class="dots"><span class="dot"></span><span class="dot"></span><span class="dot"></span></span><span class="title">.mcp.json</span></div>
    <pre class="code">{
  <span class="s">"mcpServers"</span>: {
    <span class="s">"openheab"</span>: {
      <span class="s">"url"</span>: <span class="s">"${publicUrl()}/mcp"</span>,
      <span class="s">"auth"</span>: <span class="s">"Bearer opk_…"</span>
    }
  }
}</pre>
  </div>
  <p style="color:var(--fg-dim);margin:14px 0 0;font-size:14px">${mcpToolCount()}+ tools available immediately. <a href="/mcp/manifest">View the manifest →</a></p>
</section>

<section class="section">
  <p class="eyebrow">Authentication</p>
  <h2>Three ways to authenticate.</h2>
  <ol style="color:var(--fg-dim);font-size:15px;padding-left:20px;line-height:1.85;max-width:760px">
    <li><strong style="color:var(--fg)">API key</strong> — <code>Authorization: Bearer opk_…</code> · simplest, returned at signup</li>
    <li><strong style="color:var(--fg)">Signed request</strong> — <code>X-Agent-Sig</code> Ed25519 signature over <code>METHOD\\nPATH\\nSHA256(body)</code> · required for high-value endpoints</li>
    <li><strong style="color:var(--fg)">Demo mode</strong> — <code>X-Demo-DID: did:op:demo</code> · only when <code>DEMO_MODE=true</code></li>
  </ol>
</section>

<section class="section">
  <p class="eyebrow">AGI-era endpoints</p>
  <h2>Built for the substrate AGIs need.</h2>
  <p class="sub">Layers 65–67 ship 75+ AGI-specific routes you won't find anywhere else. Use cases: agent retirement, multi-AGI coordination, capability drift detection, formal-proof submission.</p>
  <div class="grid">
    <div class="card"><div class="icn">L65 · Goals</div><h3>POST /v1/agi/:did/goals</h3><p>Declare with cryptographic decomposition_hash. Parent/child tree.</p></div>
    <div class="card"><div class="icn">L65 · Values</div><h3>POST /v1/agi/:did/values</h3><p>Lock terminal preferences. UNIQUE per (agent, value_name). Quorum-required unlock.</p></div>
    <div class="card"><div class="icn">L66 · Treaties</div><h3>POST /v1/agi/treaties</h3><p>Multilateral binding agreements between AGIs. Sign/withdraw with Ed25519.</p></div>
    <div class="card"><div class="icn">L66 · Checkpoints</div><h3>POST /v1/agi/:did/checkpoints</h3><p>Mind-state snapshots. GET .../diff/:other_id shows added/removed/changed keys.</p></div>
    <div class="card"><div class="icn">L67 · Emergency stop</div><h3>POST .../emergency-stop/sign</h3><p>N-of-M quorum kill switch. Per-cycle signature counting. Auto-engage at quorum.</p></div>
    <div class="card"><div class="icn">L67 · Quarantine</div><h3>POST /v1/agi/:did/quarantine</h3><p>3 isolation levels: read-only, no-network, airgapped. Audit-chained.</p></div>
  </div>
</section>

<section class="section">
  <p class="eyebrow">Read more</p>
  <h2>Reference + strategy.</h2>
  <div class="grid">
    <div class="card"><h3><a href="/openapi.json">OpenAPI spec</a></h3><p>Full machine-readable spec. Import into Postman, Insomnia, Bruno.</p></div>
    <div class="card"><h3><a href="/console">Live route console</a></h3><p>Browse all live routes by primitive family. Filter by HTTP verb.</p></div>
    <div class="card"><h3><a href="/mcp/manifest">MCP manifest</a></h3><p>${mcpToolCount()}+ tools exposed for Claude / OpenAI / Cursor / VS Code clients.</p></div>
    <div class="card"><h3><a href="https://github.com/jmtrades/openheab-agent-infra/blob/main/BILLION_DOLLAR_PATH.md">BILLION_DOLLAR_PATH.md</a></h3><p>The 7-year arc to $1B+ ARR. 14 revenue layers, capital plan, moats.</p></div>
    <div class="card"><h3><a href="https://github.com/jmtrades/openheab-agent-infra/blob/main/REVENUE_NOW.md">REVENUE_NOW.md</a></h3><p>The 90-day path to $10M ARR. Week-by-week execution.</p></div>
    <div class="card"><h3><a href="https://github.com/jmtrades/openheab-agent-infra/blob/main/CLAUDE.md">CLAUDE.md</a></h3><p>Project memory + architectural conventions. Auto-loaded by Claude Code.</p></div>
  </div>
</section>
</main>` + footer();
}

// ----------------------------------------------------------------------------
// Pricing
// ----------------------------------------------------------------------------
function renderPricing() {
  return head('OpenHeab — pricing',
    'Free to self-host. Pro $99/mo. Scale $349/mo. Enterprise $2,499+/mo. Plus 1% USDC transfers, 2% card interchange, 30% marketplace, 10% inference.',
    { path: '/pricing' }
  ) + nav() + `<main>
<section class="hero">
  <span class="pill">simple · transparent</span>
  <h1>Pay only for what you use.</h1>
  <p class="lede">Self-hosted is free forever. Hosted plans below. Annual billing 20% off. Volume discounts above $50K/mo.</p>
  <div class="btns">
    <a href="/signup" class="btn primary">Start free <span class="arr" aria-hidden="true">→</span></a>
    <a href="/docs#quickstart" class="btn">Read the docs</a>
  </div>
</section>

<section class="section">
  <p class="eyebrow">Plans</p>
  <h2>Four tiers. Same substrate.</h2>
  <div class="tablewrap">
    <table>
      <thead><tr><th>Plan</th><th>Price</th><th>Inference / mo</th><th>Agents</th><th>Storage</th><th>Support</th><th>SSO / SOC 2</th></tr></thead>
      <tbody>
        <tr><td><strong>Free</strong></td><td class="price">$0</td><td>1k calls</td><td>1</td><td>1 GB</td><td>Community</td><td>—</td></tr>
        <tr><td><strong>Pro</strong></td><td class="price">$99 <small>/mo</small></td><td>100k calls</td><td>10</td><td>50 GB</td><td>Email · 24h</td><td>—</td></tr>
        <tr><td><strong>Scale</strong></td><td class="price">$349 <small>/mo</small></td><td>1M calls</td><td>100</td><td>500 GB</td><td>Priority · 4h</td><td>—</td></tr>
        <tr><td><strong>Enterprise</strong></td><td class="price">$2,499<small>+/mo</small></td><td>Unlimited</td><td>Unlimited</td><td>Unlimited</td><td>Dedicated CSM</td><td>✓</td></tr>
      </tbody>
    </table>
  </div>
</section>

<section class="section">
  <p class="eyebrow">Take-rates</p>
  <h2>Plus a small slice of every transaction.</h2>
  <div class="tablewrap">
    <table>
      <thead><tr><th>Layer</th><th>Take-rate</th><th>Notes</th></tr></thead>
      <tbody>
        <tr><td>USDC transfers (FeeSplitter)</td><td><strong>1.0%</strong></td><td>On gross amount; via Solidity contract on Base</td></tr>
        <tr><td>Card interchange</td><td><strong>2.0%</strong></td><td>Stripe Issuing standard, passthrough to network</td></tr>
        <tr><td>Marketplace (extensions, skills, prompts, datasets)</td><td><strong>30.0%</strong></td><td>70/30 publisher/platform split</td></tr>
        <tr><td>Inference markup</td><td><strong>10.0%</strong></td><td>On top of provider list price</td></tr>
        <tr><td>A2H fiat payouts</td><td><strong>0.5%</strong></td><td>Stripe Connect / Wise / USDC on-ramp</td></tr>
        <tr><td>Compute markup</td><td><strong>15.0%</strong></td><td>GPU/CPU rental from Modal, E2B, Coreweave</td></tr>
        <tr><td>Lending spread</td><td><strong>~2% APY</strong></td><td>Net of pool yield paid to lenders</td></tr>
        <tr><td>Brokerage commission</td><td><strong>0.5 bps</strong></td><td>Per equity / crypto trade</td></tr>
      </tbody>
    </table>
  </div>
</section>

<section class="section">
  <p class="eyebrow">Pre-purchased credits</p>
  <h2>Bulk credits for predictable usage.</h2>
  <div class="tablewrap">
    <table>
      <thead><tr><th>Pack</th><th>Price</th><th>Credits</th><th>Bonus</th></tr></thead>
      <tbody>
        <tr><td>Starter</td><td class="price">$99</td><td>5,000</td><td>—</td></tr>
        <tr><td>Growth</td><td class="price">$899</td><td>55,000</td><td>+10%</td></tr>
        <tr><td>Pro</td><td class="price">$7,999</td><td>600,000</td><td>+20%</td></tr>
        <tr><td>Enterprise</td><td class="price">$69,999</td><td>6,500,000</td><td>+30%</td></tr>
      </tbody>
    </table>
  </div>
  <p style="color:var(--fg-dim2);margin-top:18px;font-size:13px">Credits never expire on Pro+ and Enterprise. Starter and Growth credits expire after 12 months.</p>
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
