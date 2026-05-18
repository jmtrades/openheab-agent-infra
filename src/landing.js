// ============================================================================
// Marketing landing + docs + pricing.
// Uses the shared design system from src/design_system.js.
// Numbers are live — derived from collectRoutes(app) + primitive count.
// ============================================================================
const { collectRoutes } = require('./status_page');
const { head, NAV_HTML, FOOTER_HTML, publicUrl } = require('./design_system');

function primitiveCount() {
  try { return Object.keys(require('./integration').primitives).length; }
  catch { return 265; }
}

function layerCount() {
  return 67;
}

function mcpToolCount() {
  return 149;
}

// ----------------------------------------------------------------------------
// Layers — single source of truth for the landing's layer grid.
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

  let jsonLd;
  try {
    const seo = require('./primitives/seo');
    jsonLd = [seo.organizationJsonLd(), seo.softwareApplicationJsonLd(prims, routes.length), seo.faqJsonLd(), seo.searchActionJsonLd()];
  } catch {}

  return head('OpenHeab — agent-native substrate for AI agents and AGI', desc, { path: '/', jsonLd })
    + NAV_HTML('home') + `<main>

<section class="hero">
  <span class="pill"><span class="live" aria-hidden="true"></span> ${prims} primitives live · ${routes.length} routes · ${layers} layers</span>
  <h1>Every primitive an AI agent — or an <em>AGI</em> — will ever need. One open substrate.</h1>
  <p class="lede">Signed Ed25519 identity. Non-custodial USDC wallet on Base. Virtual + physical debit cards. KYC against 5 sanctions sources. Memory, marketplaces, perception, cognition. Plus the AGI-era substrate: goal stacks, value lock-boxes, treaties, shutdown protocols, emergency stops, drift detection. Audit-chained. Open source. Free to self-host.</p>
  <div class="btns">
    <a href="/chat" class="btn primary">Try in browser <span class="arr" aria-hidden="true">→</span></a>
    <a href="/signup" class="btn">Sign up free</a>
    <a href="https://github.com/jmtrades/openheab-agent-infra" class="btn ghost">Source</a>
  </div>

  <div class="live-strip" aria-label="Live substrate activity">
    <div class="lm"><span class="ld"></span><div class="ll">Agents live</div><div class="lv" id="lv-agents">—</div></div>
    <div class="lm"><div class="ll">Audit chain length</div><div class="lv" id="lv-audit">—</div></div>
    <div class="lm"><div class="ll">Transfers · 24h</div><div class="lv" id="lv-tx">—</div></div>
    <div class="lm"><div class="ll">Inference · 24h</div><div class="lv" id="lv-inf">—</div></div>
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

<style>
.live-strip{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin:24px 0 18px;padding:14px;background:rgba(125,249,255,.03);border:1px solid rgba(125,249,255,.12);border-radius:var(--r-xl)}
@media(max-width:640px){.live-strip{grid-template-columns:repeat(2,1fr)}}
.live-strip .lm{display:flex;flex-direction:column;gap:4px;align-items:flex-start;padding:4px 8px}
.live-strip .ll{font:500 10px/1 var(--mono);color:var(--fg-dim);text-transform:uppercase;letter-spacing:1.2px;display:flex;align-items:center;gap:6px}
.live-strip .lv{font:700 22px/1 var(--mono);color:var(--acc);letter-spacing:-0.5px;font-feature-settings:'tnum';transition:color 200ms}
.live-strip .ld{display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--good);box-shadow:0 0 0 0 rgba(34,197,94,.6);animation:livepulse 1.4s infinite}
@keyframes livepulse{0%{box-shadow:0 0 0 0 rgba(34,197,94,.6)}70%{box-shadow:0 0 0 8px rgba(34,197,94,0)}100%{box-shadow:0 0 0 0 rgba(34,197,94,0)}}
</style>
<script>
(function(){
  function fmt(n){ return Number(n||0).toLocaleString(); }
  function flash(id, nv){
    var el = document.getElementById(id);
    if (!el) return;
    var ov = el.dataset.prev || '';
    el.textContent = nv;
    if (ov && ov !== nv) {
      el.style.color = '#22c55e';
      setTimeout(function(){ el.style.color = ''; }, 700);
    }
    el.dataset.prev = nv;
  }
  async function tick() {
    try {
      var r = await fetch('/v1/pulse/stats', { cache: 'no-store' });
      if (!r.ok) return;
      var j = await r.json();
      flash('lv-agents', fmt(j.agents_total));
      flash('lv-audit', fmt(j.audit_chain_length));
      flash('lv-tx', fmt(j.transfers_24h));
      flash('lv-inf', fmt(j.inference_calls_24h));
    } catch (e) {}
  }
  tick();
  setInterval(tick, 5000);
})();
</script>

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

</main>` + FOOTER_HTML();
}

// ----------------------------------------------------------------------------
// Docs (the canonical /docs page — supersedes the /docs handler in docs_page.js
// because landing.js's primitive registers earlier in integration.js).
// ----------------------------------------------------------------------------
function renderDocs(app) {
  const prims = primitiveCount();
  const layers = layerCount();
  return head('OpenHeab Docs — agent-native substrate API',
    `${prims} primitives across ${layers} layers. Identity, USDC bank, KYC, email, memory, marketplaces, perception, AGI cognition.`,
    { path: '/docs' }) + NAV_HTML('docs') + `<main>
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
    <div class="card"><h3><a href="/sdk">SDK examples</a></h3><p>Copy-paste snippets in curl, Python, TypeScript, Go, Rust.</p></div>
    <div class="card"><h3><a href="https://github.com/jmtrades/openheab-agent-infra/blob/main/BILLION_DOLLAR_PATH.md">BILLION_DOLLAR_PATH.md</a></h3><p>The 7-year arc to $1B+ ARR. 14 revenue layers, capital plan, moats.</p></div>
    <div class="card"><h3><a href="https://github.com/jmtrades/openheab-agent-infra/blob/main/CLAUDE.md">CLAUDE.md</a></h3><p>Project memory + architectural conventions. Auto-loaded by Claude Code.</p></div>
  </div>
</section>
</main>` + FOOTER_HTML();
}

// ----------------------------------------------------------------------------
// Pricing
// ----------------------------------------------------------------------------
function renderPricing() {
  return head('OpenHeab — pricing',
    'Free to self-host. Pro $99/mo. Scale $349/mo. Enterprise $2,499+/mo. Plus 1% USDC transfers, 2% card interchange, 30% marketplace, 10% inference.',
    { path: '/pricing' }) + NAV_HTML('pricing') + `<main>
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
</main>` + FOOTER_HTML();
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
