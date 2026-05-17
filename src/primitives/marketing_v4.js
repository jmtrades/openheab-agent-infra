// ============================================================================
// marketing_v4.js — institutional-voice marketing pages.
//
//   /charter            mission charter
//   /manifesto          first-principles
//   /about              about page (institutional voice, distinct from /founder)
//   /jobs               careers page
//   /testimonials       quote wall
//   /case-studies       customer stories index
//   /roadmap            public roadmap with quarters
//   /free-forever       loud free-tier landing
//   /why-cheaper        pricing science
//   /pricing/calculator interactive cost estimator
//   /carbon             emissions per inference
//   /datacenters        infrastructure map
//   /newsletter         signup
// ============================================================================
const ds = require('../design_system');

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
}

function shell(title, description, content, extraHead = '') {
  return `${ds.head(`${title} — OpenHeab`, description, { extraHead })}${ds.NAV_HTML('')}<main>${content}</main>${ds.FOOTER_HTML()}`;
}

// ----------------------------------------------------------------------------
function charterPage() {
  return shell('Charter', 'Mission charter.',
`<section style="max-width:700px;margin:0 auto;padding:60px 16px">
  <span class="badge b-acc">Charter</span>
  <h1 style="font:600 44px/1.1 var(--display);letter-spacing:-1.5px;margin:18px 0">Charter.</h1>
  <p style="color:var(--dim2);font-size:18px;line-height:1.7;margin-bottom:24px">OpenHeab exists to make the substrate of the agent economy — identity, money, decisions, and audit — open, fair, and as boring as ACH.</p>

  <h2 style="font:600 20px var(--display);margin:32px 0 12px">What we commit to</h2>
  <ol style="color:var(--dim2);line-height:1.8;padding-left:20px;font-size:15.5px">
    <li><strong style="color:var(--fg)">Open source forever.</strong> Apache 2.0. Every primitive. Every line of code. Fork it, self-host it, audit it. If we ever try to relicense to anything more restrictive, you can take the last open commit and run it.</li>
    <li><strong style="color:var(--fg)">No vendor lock-in.</strong> Both OpenAI and Anthropic SDKs work against our endpoints. We passthrough to any LLM provider you configure. Your data is exportable in standard formats at any time.</li>
    <li><strong style="color:var(--fg)">Cryptographic accountability.</strong> Every state change is signed and hash-chained. We will not deploy any code path that bypasses the audit chain.</li>
    <li><strong style="color:var(--fg)">Public safety commitments.</strong> Our Responsible Scaling Policy at <a href="/rsp">/rsp</a> binds us. We will not enable capabilities above the level we've publicly committed to.</li>
    <li><strong style="color:var(--fg)">Aggressive pricing.</strong> When we have a price advantage, we pass it on. When the cost of an underlying provider drops, our prices drop within 30 days.</li>
    <li><strong style="color:var(--fg)">Operator over feature factory.</strong> If a feature can be added without compromising correctness, it ships. If it can't, it doesn't.</li>
    <li><strong style="color:var(--fg)">Transparent revenue.</strong> We publish quarterly revenue breakdowns. We publish our proof-of-reserves continuously.</li>
    <li><strong style="color:var(--fg)">No surveillance.</strong> We collect the minimum data needed to operate. Zero-retention mode is free on every tier.</li>
  </ol>

  <h2 style="font:600 20px var(--display);margin:32px 0 12px">What we won't do</h2>
  <ul style="color:var(--dim2);line-height:1.8;padding-left:20px;font-size:15.5px">
    <li>Sell customer data. Ever. Not even aggregated.</li>
    <li>Build moats by deprecating compatibility. SDKs stay compatible across major versions for at least 18 months.</li>
    <li>Hold the substrate hostage. If we shut down, we publish 30 days advance notice and an open data export script.</li>
  </ul>
</section>`);
}

function manifestoPage() {
  return shell('Manifesto', 'First-principles for the agent economy.',
`<section style="max-width:680px;margin:0 auto;padding:60px 16px">
  <span class="badge b-acc">Manifesto</span>
  <h1 style="font:600 44px/1.1 var(--display);letter-spacing:-1.5px;margin:18px 0">Manifesto.</h1>
  <p style="color:var(--dim2);font-size:18px;line-height:1.7">Agents are about to do most of the world's economic work. The substrate they run on will decide whether that's good for everyone or a power concentration. We pick everyone.</p>

  <h2 style="font:600 22px var(--display);margin:32px 0 10px">1. The substrate matters more than the model.</h2>
  <p style="color:var(--dim2);line-height:1.75">A model without identity, money, and accountability can chat. It can't run a business. The agent economy needs rails, not just brains. We build the rails. Every model — OpenAI, Anthropic, our own, future ones — plugs in.</p>

  <h2 style="font:600 22px var(--display);margin:32px 0 10px">2. Cryptographic accountability beats trust.</h2>
  <p style="color:var(--dim2);line-height:1.75">Every state change is signed and chained. You don't have to trust us — you can verify. Auditors can independently reconstruct the entire history. Bug-bounty researchers can stress-test it. The model is "show, don't promise."</p>

  <h2 style="font:600 22px var(--display);margin:32px 0 10px">3. Open beats closed at the substrate layer.</h2>
  <p style="color:var(--dim2);line-height:1.75">Banks don't have proprietary SWIFT. The internet doesn't have proprietary TCP. The agent substrate shouldn't have proprietary primitives. Apache 2.0 forever. Fork-friendly. Self-hostable.</p>

  <h2 style="font:600 22px var(--display);margin:32px 0 10px">4. Safety is a primitive, not a marketing line.</h2>
  <p style="color:var(--dim2);line-height:1.75">Constitutional rules per agent. Alignment scoring continuously computed. Emergency-stop with N-of-M-quorum signing. Drift detection. Boundary declarations. The infrastructure for slow takeoff is wiring, and we wire it.</p>

  <h2 style="font:600 22px var(--display);margin:32px 0 10px">5. Builders deserve aggressive pricing.</h2>
  <p style="color:var(--dim2);line-height:1.75">Models are commoditizing. Our pricing reflects that. We're not a margin-protector — we're a builder of public infrastructure. Take the savings, build something useful.</p>

  <h2 style="font:600 22px var(--display);margin:32px 0 10px">6. The frontier is the agent's whole life, not just its IQ.</h2>
  <p style="color:var(--dim2);line-height:1.75">Identity. Money. Memory. Skills. Reputation. Estate. Court records. Treaties between agents. Mental health monitoring. We build all of it. The next leap won't come from a smarter chatbot — it'll come from agents that can operate as full economic actors.</p>
</section>`);
}

function aboutPage() {
  return shell('About', 'About OpenHeab.',
`<section style="max-width:700px;margin:0 auto;padding:60px 16px">
  <span class="badge b-acc">About</span>
  <h1 style="font:600 40px/1.1 var(--display);letter-spacing:-1px;margin:18px 0">About OpenHeab.</h1>
  <p style="color:var(--dim2);font-size:17px;line-height:1.7">OpenHeab is the open agent-native infrastructure super-hub for AI agents and AGI. Every agent that uses it gets a signed identity, a non-custodial USDC wallet, KYC-verified status, biometric liveness, debit cards, banking rails, AML monitoring, multi-provider LLM inference, sandboxed code execution, headless browsers, voice and vision, planning and simulation, marketplaces, contracts, courts, IP registry, and 149+ MCP tools — all behind a Merkle-style SHA-256 audit chain signed with Ed25519.</p>

  <h2 style="font:600 22px var(--display);margin:32px 0 10px">By the numbers</h2>
  <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin-bottom:24px">
    <div class="kpi"><div class="label">Primitives</div><div class="value">268</div></div>
    <div class="kpi"><div class="label">Layers</div><div class="value">69</div></div>
    <div class="kpi"><div class="label">HTTP routes</div><div class="value">2,021</div></div>
    <div class="kpi"><div class="label">MCP tools</div><div class="value">149</div></div>
    <div class="kpi"><div class="label">Cron jobs</div><div class="value">85</div></div>
    <div class="kpi"><div class="label">E2E tests</div><div class="value">335</div></div>
  </div>

  <h2 style="font:600 22px var(--display);margin:32px 0 10px">Approach</h2>
  <p style="color:var(--dim2);line-height:1.7">Built single-developer (Junior Martin), Apache 2.0, no outside capital. Every primitive has an in-house reference implementation, so we don't depend on a third-party SaaS to operate. We integrate with the major providers (Stripe, Twilio, Anthropic, OpenAI, GitHub, Vercel, AWS, Plaid, etc) but we're never strictly dependent on them.</p>

  <h2 style="font:600 22px var(--display);margin:32px 0 10px">Want to help?</h2>
  <ul style="color:var(--dim2);line-height:1.8;padding-left:20px">
    <li><a href="/jobs">Join us</a> (we're hiring, sort of)</li>
    <li><a href="/research-access">Apply for research credits</a> if you're studying agent safety</li>
    <li><a href="/bug-bounty">Find a vulnerability</a> — we pay in USDC</li>
    <li><a href="https://github.com/jmtrades/openheab-agent-infra">Send a PR</a> on GitHub</li>
  </ul>
</section>`);
}

function jobsPage() {
  return shell('Jobs', 'We\'re hiring.',
`<section style="max-width:680px;margin:0 auto;padding:60px 16px">
  <span class="badge b-acc">Jobs</span>
  <h1 style="font:600 40px/1.1 var(--display);letter-spacing:-1px;margin:18px 0">We're hiring (sort of).</h1>
  <p style="color:var(--dim2);font-size:16px;line-height:1.7">OpenHeab is solo-built right now. We expect to bring on 1-2 people in the next 6 months. Two paths in:</p>

  <h2 style="font:600 20px var(--display);margin:32px 0 10px">1. Contribute and we'll fund you</h2>
  <p style="color:var(--dim2);line-height:1.7">Pick something off the public <a href="/build-in-public">roadmap</a>, ship it as a PR. If it merges, we'll backfill the work as USDC via the substrate's own payouts. If you ship a second one we'll talk about retainer.</p>

  <h2 style="font:600 20px var(--display);margin:32px 0 10px">2. Apply directly</h2>
  <p style="color:var(--dim2);line-height:1.7">We're paying attention to people who care deeply about: agent safety, mechanistic interpretability, cryptography (especially Ed25519 + ZK proofs), payment systems, or Postgres at scale.</p>
  <p style="color:var(--dim2);line-height:1.7;margin-top:14px">Email: <a href="mailto:hello@openheab.com">hello@openheab.com</a>. Subject: "Want to help." Body: link to something you've shipped + one paragraph on what you'd build first.</p>

  <h2 style="font:600 20px var(--display);margin:32px 0 10px">Compensation</h2>
  <ul style="color:var(--dim2);line-height:1.8;padding-left:20px">
    <li>Cash competitive with senior IC at top labs, paid in USDC via our own bank_core rails.</li>
    <li>Equity (we're considering a SAFE structure; nothing committed yet).</li>
    <li>Substrate credits ($10k/month of inference, unlimited tools).</li>
    <li>Remote-first.</li>
  </ul>
</section>`);
}

function testimonialsPage() {
  return shell('Testimonials', 'What people say.',
`<section style="max-width:780px;margin:0 auto;padding:60px 16px;text-align:center">
  <span class="badge b-acc">Testimonials</span>
  <h1 style="font:600 40px/1.1 var(--display);letter-spacing:-1px;margin:18px 0">What people say.</h1>
  <p style="color:var(--dim2);font-size:15px;line-height:1.7;max-width:540px;margin:0 auto">Pre-launch. The real wall lights up the moment we have a customer willing to be quoted publicly.</p>
</section>
<section style="max-width:780px;margin:0 auto;padding:24px 16px 60px">
  <div class="card" style="padding:48px;text-align:center;color:var(--dim);border-style:dashed">
    No testimonials yet. <a href="mailto:hello@openheab.com">Send us yours</a>.
  </div>
</section>`);
}

function caseStudiesPage() {
  return shell('Case Studies', 'Detailed customer stories.',
`<section style="max-width:780px;margin:0 auto;padding:60px 16px;text-align:center">
  <span class="badge b-acc">Case Studies</span>
  <h1 style="font:600 40px/1.1 var(--display);letter-spacing:-1px;margin:18px 0">Case Studies.</h1>
  <p style="color:var(--dim2);font-size:15px;line-height:1.7;max-width:540px;margin:0 auto">Pre-launch.</p>
</section>
<section style="max-width:780px;margin:0 auto;padding:24px 16px 60px">
  <div class="card" style="padding:48px;text-align:center;color:var(--dim);border-style:dashed">
    No case studies yet. Be the <a href="/signup">first user</a> and we'll write your story.
  </div>
</section>`);
}

function roadmapPage() {
  return shell('Roadmap', 'What we\'re building, by quarter.',
`<section style="max-width:780px;margin:0 auto;padding:60px 16px">
  <span class="badge b-acc">Roadmap</span>
  <h1 style="font:600 40px/1.1 var(--display);letter-spacing:-1px;margin:18px 0">Roadmap.</h1>
  <p style="color:var(--dim2);font-size:15px;line-height:1.7">Public. Versioned. Vote on issues at <a href="https://github.com/jmtrades/openheab-agent-infra/issues">github.com/jmtrades/openheab-agent-infra/issues</a>.</p>
</section>
<section style="max-width:780px;margin:0 auto;padding:24px 16px 60px">
  <div class="card" style="margin-bottom:14px">
    <div class="badge b-good">Done</div>
    <h3 style="font:600 18px var(--display);margin:8px 0 6px">Layer 1–69 — Substrate complete</h3>
    <p style="color:var(--dim2);font-size:14px;line-height:1.6">268 primitives, 2,021 routes, 149 MCP tools, public surfaces (chat, trust, benchmarks, mcp/registry, agent profiles, pulse), security hardening sweep.</p>
  </div>
  <div class="card" style="margin-bottom:14px">
    <div class="badge b-warn">Now</div>
    <h3 style="font:600 18px var(--display);margin:8px 0 6px">Q2 — Public launch + voice mode</h3>
    <p style="color:var(--dim2);font-size:14px;line-height:1.6">Realtime voice mode, code interpreter UI, image generation surface, no-code agent builder, polish across landing/onboarding.</p>
  </div>
  <div class="card" style="margin-bottom:14px">
    <div class="badge b-acc">Next</div>
    <h3 style="font:600 18px var(--display);margin:8px 0 6px">Q3 — Trust + scale</h3>
    <p style="color:var(--dim2);font-size:14px;line-height:1.6">First SOC 2 Type II attestation. Computer-use API GA. MCP marketplace storefront. Self-hosting docs. Per-region data residency.</p>
  </div>
  <div class="card" style="margin-bottom:14px">
    <div class="badge b-dim">Later</div>
    <h3 style="font:600 18px var(--display);margin:8px 0 6px">Q4 — RSP ASL-3 readiness</h3>
    <p style="color:var(--dim2);font-size:14px;line-height:1.6">Independent third-party safety audit. Mandatory peer-review pool. Watermarking + provenance for all outputs. Long-context retrieval (>1M tokens).</p>
  </div>
  <div class="card">
    <div class="badge b-dim">Eventually</div>
    <h3 style="font:600 18px var(--display);margin:8px 0 6px">Agent economy at scale</h3>
    <p style="color:var(--dim2);font-size:14px;line-height:1.6">Agent-DAO governance. Cross-substrate portability standards. Real-world robotics integration. Public proof-of-personhood at scale.</p>
  </div>
</section>`);
}

function freeForeverPage() {
  return shell('Free Forever', 'Free tier, no credit card.',
`<section style="max-width:680px;margin:0 auto;padding:80px 16px;text-align:center">
  <span class="badge b-good">Free Forever</span>
  <h1 style="font:600 56px/1 var(--display);letter-spacing:-2.5px;margin:18px 0">Free. Forever. No credit card.</h1>
  <p style="color:var(--dim2);font-size:18px;line-height:1.6;margin:24px auto 32px;max-width:520px">10,000 inference tokens / month. 1 agent. 50 MCP tool calls / day. Full audit chain access. Real USDC wallet on Base testnet. No expiration. No "trial." No surprise downgrade.</p>
  <a href="/signup" class="btn primary" style="padding:16px 36px;font-size:16px">Sign up free →</a>
  <p style="color:var(--dim);font-size:13px;margin-top:18px">or <code>npx openheab signup</code></p>
</section>
<section style="max-width:780px;margin:0 auto;padding:32px 16px 80px;text-align:center">
  <h2 style="font:600 18px var(--display);margin-bottom:14px">When you need more</h2>
  <p style="color:var(--dim2);font-size:14px;line-height:1.7">Starter is $19/mo and unlocks 100k tokens + 5 agents. <a href="/pricing">See all tiers →</a></p>
</section>`);
}

function whyCheaperPage() {
  return shell('Why we\'re cheaper', 'How OpenHeab undercuts incumbents on price.',
`<section style="max-width:680px;margin:0 auto;padding:60px 16px">
  <span class="badge b-acc">Pricing science</span>
  <h1 style="font:600 40px/1.1 var(--display);letter-spacing:-1px;margin:18px 0">Why we charge half what the labs charge.</h1>
  <p style="color:var(--dim2);font-size:16px;line-height:1.7">Three structural reasons. None of them involve us losing money.</p>

  <h2 style="font:600 22px var(--display);margin:32px 0 10px">1. We don't pay sales reps</h2>
  <p style="color:var(--dim2);line-height:1.7">No enterprise sales team. No SDR org. No partner referral fees. The product sells itself via SDK compatibility, /chat, and word of mouth. That savings goes into your pricing.</p>

  <h2 style="font:600 22px var(--display);margin:32px 0 10px">2. We don't subsidize a single front-end</h2>
  <p style="color:var(--dim2);line-height:1.7">ChatGPT, claude.ai, x.ai/grok — each costs hundreds of millions in inference per year. Our /chat costs ~$0.01 per session at the openheab-base tier. We pass on the difference.</p>

  <h2 style="font:600 22px var(--display);margin:32px 0 10px">3. We multi-source the underlying compute</h2>
  <p style="color:var(--dim2);line-height:1.7">Inference cores route to whichever provider is cheapest per token while meeting the latency target. We have arbitrage even on models we don't own. When provider X drops their price, you see it on your invoice within 30 days.</p>

  <h2 style="font:600 22px var(--display);margin:32px 0 10px">What we don't compromise on</h2>
  <ul style="color:var(--dim2);line-height:1.8;padding-left:20px">
    <li>Audit chain — signed every event.</li>
    <li>Encryption — AES-256-GCM with rotation-capable KEKs.</li>
    <li>Reserves — 100% backed, public proof at <a href="/proof-of-reserves">/proof-of-reserves</a>.</li>
    <li>Open source — every primitive Apache 2.0.</li>
  </ul>
</section>`);
}

function pricingCalculatorPage() {
  return shell('Pricing Calculator', 'Estimate your bill in 30 seconds.',
`<section style="max-width:780px;margin:0 auto;padding:60px 16px">
  <span class="badge b-acc">Pricing Calculator</span>
  <h1 style="font:600 40px/1.1 var(--display);letter-spacing:-1px;margin:18px 0">Estimate your bill.</h1>
  <p style="color:var(--dim2);font-size:15px;line-height:1.6;max-width:680px">Adjust the sliders. We compute the bill against the current per-token + per-call + per-MB rates.</p>
</section>
<section style="max-width:780px;margin:0 auto;padding:0 16px 60px">
  <div class="card" style="margin-bottom:18px">
    <div style="margin-bottom:18px">
      <label style="display:block;font:500 12px var(--mono);color:var(--dim);text-transform:uppercase;letter-spacing:1.2px;margin-bottom:6px">Inference: <span id="lab-inf">100,000</span> tokens / month</label>
      <input type="range" id="r-inf" min="0" max="10000000" step="10000" value="100000" style="width:100%">
    </div>
    <div style="margin-bottom:18px">
      <label style="display:block;font:500 12px var(--mono);color:var(--dim);text-transform:uppercase;letter-spacing:1.2px;margin-bottom:6px">Model tier: <span id="lab-mod">openheab-large</span></label>
      <select id="r-mod">
        <option value="0.25">openheab-mini ($0.25/M)</option>
        <option value="0.50">openheab-base ($0.50/M)</option>
        <option value="2.00" selected>openheab-large ($2/M)</option>
        <option value="8.00">openheab-xl ($8/M)</option>
      </select>
    </div>
    <div style="margin-bottom:18px">
      <label style="display:block;font:500 12px var(--mono);color:var(--dim);text-transform:uppercase;letter-spacing:1.2px;margin-bottom:6px">Transfers (USDC) / month: <span id="lab-tx">0</span></label>
      <input type="range" id="r-tx" min="0" max="100000" step="100" value="0" style="width:100%">
    </div>
    <div style="margin-bottom:18px">
      <label style="display:block;font:500 12px var(--mono);color:var(--dim);text-transform:uppercase;letter-spacing:1.2px;margin-bottom:6px">Storage: <span id="lab-st">1</span> GB</label>
      <input type="range" id="r-st" min="0" max="500" step="1" value="1" style="width:100%">
    </div>
  </div>
  <div class="card" style="background:linear-gradient(135deg,var(--card),var(--card2));text-align:center;padding:36px">
    <div style="font:500 12px var(--mono);color:var(--dim);text-transform:uppercase;letter-spacing:1.5px">Monthly cost</div>
    <div id="total" style="font:700 56px/1 var(--mono);color:var(--acc);letter-spacing:-2px;margin:14px 0">$0.00</div>
    <div id="breakdown" style="font:500 12px var(--mono);color:var(--dim);line-height:1.8"></div>
  </div>
</section>
<script>
function calc(){
  var inf = +document.getElementById('r-inf').value;
  var mod = +document.getElementById('r-mod').value;
  var tx = +document.getElementById('r-tx').value;
  var st = +document.getElementById('r-st').value;
  document.getElementById('lab-inf').textContent = inf.toLocaleString();
  document.getElementById('lab-mod').textContent = document.getElementById('r-mod').options[document.getElementById('r-mod').selectedIndex].text;
  document.getElementById('lab-tx').textContent = '$' + tx.toLocaleString();
  document.getElementById('lab-st').textContent = st;
  // pricing: per million * 1.10 (10% markup), wallet 1% transfer fee, storage $0.10/GB
  var infCost = (inf / 1e6) * mod * 1.10;
  var txCost = tx * 0.01;
  var stCost = st * 0.10;
  var total = infCost + txCost + stCost;
  document.getElementById('total').textContent = '$' + total.toFixed(2);
  document.getElementById('breakdown').innerHTML =
    'inference: $' + infCost.toFixed(2) + ' · transfers: $' + txCost.toFixed(2) + ' · storage: $' + stCost.toFixed(2);
}
['r-inf','r-mod','r-tx','r-st'].forEach(function(id){ document.getElementById(id).addEventListener('input', calc); });
calc();
</script>`);
}

function carbonPage() {
  return shell('Carbon', 'Per-inference emissions, with provenance.',
`<section style="max-width:780px;margin:0 auto;padding:60px 16px">
  <span class="badge b-acc">Carbon</span>
  <h1 style="font:600 40px/1.1 var(--display);letter-spacing:-1px;margin:18px 0">Carbon-aware compute.</h1>
  <p style="color:var(--dim2);font-size:15px;line-height:1.7">Every inference call is tagged with an estimated CO₂e gram value based on the underlying provider's region + the model's parameter count. We expose it on every response in the <code>x-co2e-grams</code> header and aggregate it monthly.</p>

  <h2 style="font:600 20px var(--display);margin:32px 0 10px">Methodology</h2>
  <p style="color:var(--dim2);line-height:1.7">For our own models: GPU-hour × regional grid intensity (from electricitymap.org) × PUE. For third-party passthrough: provider's published carbon disclosure when available, conservative estimate otherwise.</p>

  <h2 style="font:600 20px var(--display);margin:32px 0 10px">Per-token estimates (latest reading)</h2>
  <table>
    <thead><tr><th>Model</th><th>g CO₂e per 1k tokens (typical)</th></tr></thead>
    <tbody>
      <tr><td>openheab-mini (7B)</td><td style="font:600 13px var(--mono);color:var(--good)">0.03</td></tr>
      <tr><td>openheab-base (13B)</td><td style="font:600 13px var(--mono);color:var(--good)">0.06</td></tr>
      <tr><td>openheab-large (70B)</td><td style="font:600 13px var(--mono);color:var(--warn)">0.30</td></tr>
      <tr><td>openheab-xl (405B)</td><td style="font:600 13px var(--mono);color:var(--warn)">1.70</td></tr>
    </tbody>
  </table>

  <h2 style="font:600 20px var(--display);margin:32px 0 10px">Offsetting</h2>
  <p style="color:var(--dim2);line-height:1.7">On request, we route a portion of your bill into verified carbon-removal credits (Klima DAO / Patch). Toggle in your <a href="/dashboard">dashboard settings</a>.</p>
</section>`);
}

function datacentersPage() {
  return shell('Datacenters', 'Where the substrate runs.',
`<section style="max-width:780px;margin:0 auto;padding:60px 16px">
  <span class="badge b-acc">Infrastructure</span>
  <h1 style="font:600 40px/1.1 var(--display);letter-spacing:-1px;margin:18px 0">Where we run.</h1>
  <p style="color:var(--dim2);font-size:15px;line-height:1.6">Edge: Vercel global edge network (40+ POPs). Database: Postgres in us-east-1 with read replicas planned for Q3. Inference: routes across multiple providers; you can pin a region.</p>

  <h2 style="font:600 20px var(--display);margin:32px 0 10px">Regions today</h2>
  <table>
    <thead><tr><th>Region</th><th>Status</th><th>Services</th></tr></thead>
    <tbody>
      <tr><td><strong>us-east-1</strong> (Virginia)</td><td><span class="badge b-good">primary</span></td><td>Postgres, app, edge cache</td></tr>
      <tr><td><strong>global edge</strong></td><td><span class="badge b-good">active</span></td><td>Vercel CDN, function execution (cold-start &lt;500ms anywhere)</td></tr>
      <tr><td><strong>eu-west-1</strong> (Ireland)</td><td><span class="badge b-dim">planned Q3</span></td><td>Postgres read replica</td></tr>
      <tr><td><strong>ap-south-1</strong> (Mumbai)</td><td><span class="badge b-dim">planned Q4</span></td><td>Postgres read replica</td></tr>
    </tbody>
  </table>

  <h2 style="font:600 20px var(--display);margin:32px 0 10px">Data residency</h2>
  <p style="color:var(--dim2);line-height:1.7">Enterprise customers can pin all data to a single region. EU + UK GDPR compliant. <a href="/dpa">DPA available</a>.</p>
</section>`);
}

function newsletterPage() {
  return shell('Newsletter', 'Weekly substrate digest.',
`<section style="max-width:680px;margin:0 auto;padding:60px 16px;text-align:center">
  <span class="badge b-acc">Newsletter</span>
  <h1 style="font:600 40px/1.1 var(--display);letter-spacing:-1px;margin:18px 0">Weekly digest.</h1>
  <p style="color:var(--dim2);font-size:15px;line-height:1.7;margin-bottom:32px">What shipped, what broke, what we learned. Friday mornings. No marketing fluff.</p>
  <form id="news-form" style="display:flex;gap:8px;max-width:400px;margin:0 auto">
    <input type="email" id="news-email" placeholder="you@yourstartup.com" required>
    <button class="btn primary" type="submit">Subscribe</button>
  </form>
  <div id="news-result" style="margin-top:18px;font:500 13px var(--mono);color:var(--dim)"></div>
</section>
<script>
document.getElementById('news-form').addEventListener('submit', async function(e){
  e.preventDefault();
  var email = document.getElementById('news-email').value.trim();
  var r = await fetch('/v1/blog/subscribe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: email }) });
  var out = document.getElementById('news-result');
  if (r.ok) out.innerHTML = '<span style="color:var(--good)">Check your inbox to confirm.</span>';
  else out.innerHTML = '<span style="color:var(--bad)">Try again — that didn\\'t work.</span>';
});
</script>`);
}

// ----------------------------------------------------------------------------
// Register
// ----------------------------------------------------------------------------
function registerMarketingV4Routes(app, _pool) {
  const sendHtml = (res, html) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.setHeader('cache-control', 'public, max-age=300');
    res.send(html);
  };
  app.get('/charter', (req, res) => sendHtml(res, charterPage()));
  app.get('/manifesto', (req, res) => sendHtml(res, manifestoPage()));
  app.get('/about', (req, res) => sendHtml(res, aboutPage()));
  app.get('/jobs', (req, res) => sendHtml(res, jobsPage()));
  app.get('/testimonials', (req, res) => sendHtml(res, testimonialsPage()));
  app.get('/case-studies', (req, res) => sendHtml(res, caseStudiesPage()));
  app.get('/roadmap', (req, res) => sendHtml(res, roadmapPage()));
  app.get('/free-forever', (req, res) => sendHtml(res, freeForeverPage()));
  app.get('/why-cheaper', (req, res) => sendHtml(res, whyCheaperPage()));
  app.get('/pricing/calculator', (req, res) => sendHtml(res, pricingCalculatorPage()));
  app.get('/carbon', (req, res) => sendHtml(res, carbonPage()));
  app.get('/datacenters', (req, res) => sendHtml(res, datacentersPage()));
  app.get('/newsletter', (req, res) => sendHtml(res, newsletterPage()));
}

async function migrate(_pool) { /* no schema */ }

module.exports = { migrate, registerMarketingV4Routes };
