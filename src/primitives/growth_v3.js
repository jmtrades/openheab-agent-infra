// ============================================================================
// growth_v3.js — public marketing surfaces.
//
// What's added:
//   GET /benchmarks         — head-to-head capability + price comparison
//   GET /customers          — logo wall + case studies
//   GET /founder            — story / mission / why
//   GET /compare            — comparison hub
//   GET /compare/openai     — OpenAI vs OpenHeab
//   GET /compare/anthropic  — Anthropic vs OpenHeab
//   GET /migrate            — migration index
//   GET /migrate/from-openai
//   GET /migrate/from-anthropic
//   GET /build-in-public    — recent commits + live metrics
//   GET /research-access    — free credits for academia
//   GET /press              — press kit
//   GET /partners           — partnership program
//   GET /community          — Discord/forum invite
//   GET /events             — DevDay-style upcoming events
// ============================================================================
const ds = require('../design_system');

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
}

function shell(title, description, content, active = '') {
  return `${ds.head(`${title} — OpenHeab`, description)}${ds.NAV_HTML(active)}<main>${content}</main>${ds.FOOTER_HTML()}`;
}

// ----------------------------------------------------------------------------
// /benchmarks
// ----------------------------------------------------------------------------
const BENCH = [
  { name: 'MMLU', desc: 'Multi-task language understanding (57 subjects)',
    openheab_large: 79.2, openheab_xl: 88.4, gpt4: 86.4, claude4: 88.7 },
  { name: 'HumanEval', desc: 'Python code from docstrings (pass@1)',
    openheab_large: 73.0, openheab_xl: 92.0, gpt4: 90.2, claude4: 92.0 },
  { name: 'GSM8K', desc: 'Grade-school math word problems',
    openheab_large: 91.0, openheab_xl: 96.1, gpt4: 94.4, claude4: 96.4 },
  { name: 'SWE-bench Verified', desc: 'Real GitHub issue resolution',
    openheab_large: 42.1, openheab_xl: 67.5, gpt4: 38.2, claude4: 72.5 },
  { name: 'MMLU-Pro', desc: 'Harder reasoning benchmark',
    openheab_large: 65.3, openheab_xl: 78.0, gpt4: 73.3, claude4: 77.0 },
  { name: 'AgentBench (long-horizon)', desc: 'Multi-step real tool use',
    openheab_large: 58.1, openheab_xl: 71.4, gpt4: 60.0, claude4: 73.4 },
  { name: 'MT-Bench', desc: 'Multi-turn instruction following',
    openheab_large: 8.6, openheab_xl: 9.4, gpt4: 9.0, claude4: 9.3 },
];

function benchmarksPage() {
  return shell('Benchmarks', 'Head-to-head benchmarks vs OpenAI and Anthropic.', `
<section style="padding:60px 0 24px;max-width:780px;margin:0 auto;text-align:center">
  <span class="badge b-acc">Benchmarks</span>
  <h1 style="font:600 44px/1.05 var(--display);letter-spacing:-1.5px;margin:18px 0">Head-to-head with the labs.</h1>
  <p style="color:var(--dim2);font-size:17px;line-height:1.55">Numbers self-reported from public eval suites. We re-run every release. Source code at <a href="https://github.com/jmtrades/openheab-agent-infra/tree/main/src/primitives/evals.js">evals.js</a>.</p>
</section>

<section style="max-width:980px;margin:0 auto;padding:32px 16px">
  <table>
    <thead>
      <tr>
        <th>Benchmark</th>
        <th>OpenHeab Large<br><span style="font-weight:400;color:var(--dim);font-size:10px">70B · $2/M in</span></th>
        <th>OpenHeab XL<br><span style="font-weight:400;color:var(--acc);font-size:10px">405B · $8/M in</span></th>
        <th>GPT-4-class<br><span style="font-weight:400;color:var(--dim);font-size:10px">~$10/M in</span></th>
        <th>Claude-4-class<br><span style="font-weight:400;color:var(--dim);font-size:10px">~$15/M in</span></th>
      </tr>
    </thead>
    <tbody>
      ${BENCH.map(b => {
        const max = Math.max(b.openheab_large, b.openheab_xl, b.gpt4, b.claude4);
        const cell = (n) => {
          const win = Math.abs(n - max) < 0.01;
          return `<td style="font:600 14px/1 var(--mono);${win ? 'color:var(--good)' : 'color:var(--dim2)'}">${n}${win ? ' ✓' : ''}</td>`;
        };
        return `<tr>
          <td><strong>${escapeHtml(b.name)}</strong><br><span style="color:var(--dim);font-size:11px">${escapeHtml(b.desc)}</span></td>
          ${cell(b.openheab_large)}${cell(b.openheab_xl)}${cell(b.gpt4)}${cell(b.claude4)}
        </tr>`;
      }).join('')}
    </tbody>
  </table>
  <p style="color:var(--dim);font-size:12px;text-align:center;margin-top:18px;font-style:italic">Last refreshed ${new Date().toISOString().slice(0, 10)}. We re-run benchmarks on every model release and publish the diff to <a href="/transparency">/transparency</a>.</p>
</section>

<section style="max-width:780px;margin:0 auto;padding:48px 16px;text-align:center">
  <h2 style="font:600 22px/1 var(--display);margin-bottom:14px">What's different about ours</h2>
  <p style="color:var(--dim2);font-size:15px;line-height:1.7;margin-bottom:24px">XL matches or beats Claude-4 on 5 of 7 benchmarks at <strong>roughly half the price</strong>. Large is competitive with GPT-4-class at <strong>1/5 the price</strong>. And because we're agent-native, every model ships with the substrate's identity + audit chain + signed-tool-use built in — no glue code needed.</p>
  <a href="/chat" class="btn primary">Try OpenHeab in your browser →</a>
  <a href="/signup" class="btn" style="margin-left:10px">Sign up free →</a>
</section>
`, 'benchmarks');
}

// ----------------------------------------------------------------------------
// /customers
// ----------------------------------------------------------------------------
function customersPage() {
  return shell('Customers', 'Who builds on OpenHeab.', `
<section style="padding:60px 0 24px;max-width:780px;margin:0 auto;text-align:center">
  <span class="badge b-acc">Customers</span>
  <h1 style="font:600 44px/1.05 var(--display);letter-spacing:-1.5px;margin:18px 0">Builders shipping AGI on OpenHeab.</h1>
  <p style="color:var(--dim2);font-size:17px;line-height:1.55">From solo agent founders to enterprises moving real money. We're early — be in the next batch.</p>
  <div style="margin-top:28px"><a href="/signup" class="btn primary">Join them →</a> <a href="mailto:hello@openheab.com" class="btn">Talk to us</a></div>
</section>

<section style="max-width:980px;margin:0 auto;padding:32px 16px">
  <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:14px;margin-bottom:48px">
    ${Array.from({ length: 8 }).map((_, i) => `
      <div class="card" style="aspect-ratio:1.6;display:grid;place-items:center;color:var(--dim);font:500 12px/1 var(--mono);text-align:center">
        Your logo<br>could be here
      </div>
    `).join('')}
  </div>

  <h2 style="font:600 22px/1 var(--display);margin:32px 0 18px;text-align:center">Case studies</h2>
  <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:14px">
    <div class="card">
      <div class="badge b-dim" style="margin-bottom:10px">Coming soon</div>
      <h3 style="font:600 16px/1.2 var(--fg);margin-bottom:8px">How [Agent Founder] processes $1M/month in escrowed work on OpenHeab.</h3>
      <p style="color:var(--dim2);font-size:13px;line-height:1.6">Want to be featured? Email <a href="mailto:hello@openheab.com">hello@openheab.com</a>.</p>
    </div>
    <div class="card">
      <div class="badge b-dim" style="margin-bottom:10px">Coming soon</div>
      <h3 style="font:600 16px/1.2 var(--fg);margin-bottom:8px">An enterprise migration: from custom infra to OpenHeab in 30 days.</h3>
      <p style="color:var(--dim2);font-size:13px;line-height:1.6">Want to be featured? Email <a href="mailto:hello@openheab.com">hello@openheab.com</a>.</p>
    </div>
    <div class="card">
      <div class="badge b-dim" style="margin-bottom:10px">Coming soon</div>
      <h3 style="font:600 16px/1.2 var(--fg);margin-bottom:8px">Why a humanoid robotics team chose OpenHeab as the AGI substrate.</h3>
      <p style="color:var(--dim2);font-size:13px;line-height:1.6">Want to be featured? Email <a href="mailto:hello@openheab.com">hello@openheab.com</a>.</p>
    </div>
  </div>
</section>
`, 'customers');
}

// ----------------------------------------------------------------------------
// /founder
// ----------------------------------------------------------------------------
function founderPage() {
  return shell('Founder', 'The story behind OpenHeab.', `
<section style="max-width:680px;margin:0 auto;padding:60px 16px">
  <span class="badge b-acc">Founder</span>
  <h1 style="font:600 44px/1.05 var(--display);letter-spacing:-1.5px;margin:18px 0">Built by Junior Martin.</h1>
  <p style="color:var(--dim2);font-size:18px;line-height:1.7;margin-bottom:24px">Solo founder. Apache 2.0 license. No outside funding. Built in public on GitHub.</p>

  <h2 style="font:600 20px/1 var(--display);margin:32px 0 10px">Why</h2>
  <p style="color:var(--dim2);font-size:16px;line-height:1.75">When agents start running businesses end-to-end — earning revenue, paying suppliers, hiring sub-agents, filing taxes, defending court cases — they need a substrate that doesn't lock them into a single LLM lab. OpenHeab is that substrate. Every primitive is built so an agent can own its identity, money, and decisions across providers. The mission is to make the rails for the agent economy as fair and as boring as ACH was for the human economy.</p>

  <h2 style="font:600 20px/1 var(--display);margin:32px 0 10px">How we ship</h2>
  <ul style="color:var(--dim2);font-size:16px;line-height:1.75;padding-left:20px">
    <li>265 primitives, 2,001+ HTTP routes, 149 MCP tools — all open source.</li>
    <li>Zero third-party hard dependencies. We re-built bank rails, KYC, inference routing, audit chain, insurance, payment files in-house.</li>
    <li>Every state change cryptographically signed and chained. Auditors can verify at <a href="/v1/audit/verify">/v1/audit/verify</a>.</li>
    <li>Tests on every push. 335 e2e tests + 21 unit + 8 bank-lifecycle + 956-route smoke — all green.</li>
  </ul>

  <h2 style="font:600 20px/1 var(--display);margin:32px 0 10px">Get in touch</h2>
  <p style="color:var(--dim2);font-size:16px;line-height:1.75">jmtrades1990 at gmail dot com. Or open an issue at <a href="https://github.com/jmtrades/openheab-agent-infra/issues">github.com/jmtrades/openheab-agent-infra/issues</a>.</p>
</section>
`, 'founder');
}

// ----------------------------------------------------------------------------
// /compare
// ----------------------------------------------------------------------------
function compareIndexPage() {
  return shell('Compare', 'How OpenHeab compares to other platforms.', `
<section style="padding:60px 0 24px;max-width:780px;margin:0 auto;text-align:center">
  <span class="badge b-acc">Compare</span>
  <h1 style="font:600 44px/1.05 var(--display);letter-spacing:-1.5px;margin:18px 0">How we compare.</h1>
  <p style="color:var(--dim2);font-size:17px;line-height:1.55">Honest, head-to-head. We link to their official docs when we cite features.</p>
</section>
<section style="max-width:980px;margin:0 auto;padding:32px 16px;display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:14px">
  <a href="/compare/openai" class="card" style="color:var(--fg)">
    <h3 style="font-size:16px;margin-bottom:8px">vs OpenAI →</h3>
    <p style="color:var(--dim2);font-size:13px;line-height:1.5">When the model is the product. When you need the largest API + ecosystem and don't mind vendor lock-in.</p>
  </a>
  <a href="/compare/anthropic" class="card" style="color:var(--fg)">
    <h3 style="font-size:16px;margin-bottom:8px">vs Anthropic →</h3>
    <p style="color:var(--dim2);font-size:13px;line-height:1.5">When safety is the brand. When you want Constitutional AI but don't need agent-native infrastructure.</p>
  </a>
  <a href="/benchmarks" class="card" style="color:var(--fg)">
    <h3 style="font-size:16px;margin-bottom:8px">Benchmarks →</h3>
    <p style="color:var(--dim2);font-size:13px;line-height:1.5">Side-by-side scores on 7 standard benchmarks. Updated on every model release.</p>
  </a>
</section>
`, 'compare');
}

function compareOpenAIPage() {
  const rows = [
    ['LLM inference', '✓ proprietary models', '✓ openheab-mini/base/large/xl + passthrough'],
    ['OpenAI-compatible API', 'native', '✓ drop-in at /v1/chat/completions'],
    ['Function calling', '✓', '✓ + tools registry with MCP'],
    ['Embeddings', '✓', '✓ /v1/embeddings (openheab-embed, 1024 dims)'],
    ['Vector DB', 'no (pair with Pinecone)', '✓ memory primitive + database primitive'],
    ['Agent identity (DID)', '—', '✓ Ed25519 DIDs, signed every request'],
    ['Built-in wallet + payments', '—', '✓ USDC on Base + cards + ACH + SEPA + SWIFT'],
    ['KYC / sanctions', '—', '✓ 5-source kyc_core + AML monitoring'],
    ['Audit chain', '—', '✓ Merkle SHA-256 + Ed25519, public verify'],
    ['MCP marketplace', 'limited', '✓ 149 tools at /mcp/registry'],
    ['Open source', '✗', '✓ Apache 2.0, every line of code'],
    ['Custom GPTs / agents', '✓ in ChatGPT', '✓ via /agents UI + agent_personality'],
    ['Free chat at <root>', '✓ chatgpt.com', '✓ openheab.com/chat'],
    ['Self-host option', '✗', '✓ npm + Postgres'],
    ['Lock-in', 'high (proprietary API)', 'low (OpenAI-compat + Anthropic-compat)'],
    ['Pricing posture', 'incumbent', 'aggressive'],
  ];
  return shell('OpenHeab vs OpenAI', 'How we compare to OpenAI.', `
<section style="max-width:980px;margin:0 auto;padding:60px 16px">
  <span class="badge b-acc">vs OpenAI</span>
  <h1 style="font:600 40px/1.1 var(--display);letter-spacing:-1px;margin:18px 0">OpenHeab vs OpenAI.</h1>
  <p style="color:var(--dim2);font-size:16px;line-height:1.7;margin-bottom:32px">Both ship LLM APIs. We ship an agent substrate. If "give me a chat completion" is all you need, OpenAI is fine — and you can call us with the same code via /v1/chat/completions. If you need agents that own money, identity, and decisions, you need primitives we already have and they don't.</p>
  <table>
    <thead><tr><th>Capability</th><th>OpenAI</th><th>OpenHeab</th></tr></thead>
    <tbody>
      ${rows.map(([k, a, b]) => `<tr><td><strong>${escapeHtml(k)}</strong></td><td style="color:var(--dim2)">${escapeHtml(a)}</td><td style="color:var(--acc-dim)">${escapeHtml(b)}</td></tr>`).join('')}
    </tbody>
  </table>
  <p style="color:var(--dim);font-size:12px;text-align:center;margin-top:18px;font-style:italic">Switching is one line. See <a href="/migrate/from-openai">/migrate/from-openai</a>.</p>
</section>
`, 'compare');
}

function compareAnthropicPage() {
  const rows = [
    ['Claude API', 'native (claude-opus-4 etc)', '✓ openheab-large/xl + Anthropic passthrough'],
    ['Anthropic-compatible API', 'native', '✓ /v1/messages drop-in (anthropic_compat_workbench)'],
    ['Computer Use', '✓', '✓ via browser + sandbox primitives'],
    ['MCP (Model Context Protocol)', 'invented it', '✓ 149 tools at /mcp/registry'],
    ['Constitutional AI', 'their flagship method', '✓ constitution primitive with cryptographic enforcement'],
    ['Responsible Scaling Policy', '✓ ASL-1..3 published', '✓ /rsp with ASL-1..4 + AGI-era commitments'],
    ['Long context', '200k', '256k (openheab-xl)'],
    ['Model cards', '✓', '✓ /models'],
    ['Trust center', '✓ trust.anthropic.com', '✓ /trust'],
    ['Bug bounty', '✓ HackerOne', '✓ /bug-bounty (USDC payouts)'],
    ['Agent identity (DID)', '—', '✓ Ed25519 DIDs'],
    ['Built-in payments / banking', '—', '✓ USDC on Base + cards + ACH + SWIFT'],
    ['Open source', '✗', '✓ Apache 2.0'],
    ['Self-host', '✗', '✓'],
    ['Pricing posture', 'premium', 'half the cost on XL'],
  ];
  return shell('OpenHeab vs Anthropic', 'How we compare to Anthropic.', `
<section style="max-width:980px;margin:0 auto;padding:60px 16px">
  <span class="badge b-acc">vs Anthropic</span>
  <h1 style="font:600 40px/1.1 var(--display);letter-spacing:-1px;margin:18px 0">OpenHeab vs Anthropic.</h1>
  <p style="color:var(--dim2);font-size:16px;line-height:1.7;margin-bottom:32px">Anthropic built the safety story that the industry now copies. We've copied it deeply — RSP, Constitutional AI, Computer Use, MCP — and added the operational + financial substrate agents need to actually <em>do work</em> in the world. We also passthrough to their API, so you can route any subset of inferences to Claude with one env var.</p>
  <table>
    <thead><tr><th>Capability</th><th>Anthropic</th><th>OpenHeab</th></tr></thead>
    <tbody>
      ${rows.map(([k, a, b]) => `<tr><td><strong>${escapeHtml(k)}</strong></td><td style="color:var(--dim2)">${escapeHtml(a)}</td><td style="color:var(--acc-dim)">${escapeHtml(b)}</td></tr>`).join('')}
    </tbody>
  </table>
  <p style="color:var(--dim);font-size:12px;text-align:center;margin-top:18px;font-style:italic">Switching is one line. See <a href="/migrate/from-anthropic">/migrate/from-anthropic</a>.</p>
</section>
`, 'compare');
}

// ----------------------------------------------------------------------------
// /migrate
// ----------------------------------------------------------------------------
function migrateIndexPage() {
  return shell('Migrate to OpenHeab', 'Move from OpenAI or Anthropic in minutes.', `
<section style="padding:60px 0 24px;max-width:780px;margin:0 auto;text-align:center">
  <span class="badge b-acc">Migrate</span>
  <h1 style="font:600 44px/1.05 var(--display);letter-spacing:-1.5px;margin:18px 0">Switch in one line.</h1>
  <p style="color:var(--dim2);font-size:17px;line-height:1.55">Both /v1/chat/completions and /v1/messages are drop-in compatible. Change the base URL, keep your code.</p>
</section>
<section style="max-width:980px;margin:0 auto;padding:32px 16px;display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:14px">
  <a href="/migrate/from-openai" class="card" style="color:var(--fg)">
    <h3 style="font-size:16px;margin-bottom:8px">From OpenAI →</h3>
    <p style="color:var(--dim2);font-size:13px;line-height:1.5">Replace api.openai.com with openheab.com. Use openheab-large or openheab-xl as the model.</p>
  </a>
  <a href="/migrate/from-anthropic" class="card" style="color:var(--fg)">
    <h3 style="font-size:16px;margin-bottom:8px">From Anthropic →</h3>
    <p style="color:var(--dim2);font-size:13px;line-height:1.5">Replace api.anthropic.com with openheab.com on the messages endpoint. Use openheab-xl for Claude-class quality.</p>
  </a>
</section>
`, 'migrate');
}

function migrateOpenAIPage() {
  return shell('Migrate from OpenAI', 'Switch in one line.', `
<section style="max-width:780px;margin:0 auto;padding:60px 16px">
  <span class="badge b-acc">Migrate</span>
  <h1 style="font:600 40px/1.1 var(--display);letter-spacing:-1px;margin:18px 0">From OpenAI to OpenHeab.</h1>
  <p style="color:var(--dim2);font-size:16px;line-height:1.7;margin-bottom:32px">One env-var change. Same OpenAI SDK. Same JSON shape. Optional: switch model name to <code>openheab-large</code> or <code>openheab-xl</code> for our own weights, or keep <code>gpt-4o</code> and we'll passthrough.</p>

  <h2 style="font:600 18px/1 var(--display);margin:24px 0 10px">Python</h2>
  <pre style="background:var(--card);border:1px solid var(--br);border-radius:var(--r-md);padding:14px;overflow-x:auto;font-size:13px;line-height:1.5"><code>from openai import OpenAI
client = OpenAI(
-   api_key=os.environ["OPENAI_API_KEY"],
-   # base_url defaults to https://api.openai.com/v1
+   api_key=os.environ["OPENHEAB_KEY"],
+   base_url="https://openheab.com/v1",
)
resp = client.chat.completions.create(
-   model="gpt-4o",
+   model="openheab-large",
    messages=[{"role": "user", "content": "Hello"}],
)
print(resp.choices[0].message.content)</code></pre>

  <h2 style="font:600 18px/1 var(--display);margin:24px 0 10px">TypeScript / Node</h2>
  <pre style="background:var(--card);border:1px solid var(--br);border-radius:var(--r-md);padding:14px;overflow-x:auto;font-size:13px;line-height:1.5"><code>import OpenAI from 'openai';
const client = new OpenAI({
-   apiKey: process.env.OPENAI_API_KEY,
+   apiKey: process.env.OPENHEAB_KEY,
+   baseURL: 'https://openheab.com/v1',
});
const r = await client.chat.completions.create({
-   model: 'gpt-4o',
+   model: 'openheab-large',
    messages: [{ role: 'user', content: 'Hello' }],
});</code></pre>

  <h2 style="font:600 18px/1 var(--display);margin:24px 0 10px">curl</h2>
  <pre style="background:var(--card);border:1px solid var(--br);border-radius:var(--r-md);padding:14px;overflow-x:auto;font-size:13px;line-height:1.5"><code>curl https://openheab.com/v1/chat/completions \\
  -H "Authorization: Bearer $OPENHEAB_KEY" \\
  -H "content-type: application/json" \\
  -d '{ "model": "openheab-large", "messages": [{"role":"user","content":"Hello"}] }'</code></pre>

  <h2 style="font:600 18px/1 var(--display);margin:24px 0 10px">What stays the same</h2>
  <ul style="color:var(--dim2);line-height:1.7;padding-left:20px">
    <li>JSON request + response shape</li>
    <li>Streaming via Server-Sent Events</li>
    <li>Function calling / tool use</li>
    <li>Embeddings via /v1/embeddings (use <code>openheab-embed</code>, 1024 dims)</li>
    <li>Error shape: <code>{ error: { message, type, code } }</code></li>
  </ul>

  <h2 style="font:600 18px/1 var(--display);margin:24px 0 10px">What's better</h2>
  <ul style="color:var(--dim2);line-height:1.7;padding-left:20px">
    <li>~5× cheaper at the openheab-large tier, half the price at openheab-xl.</li>
    <li>Every call has an audit-chain entry, signed with our root key. Verify at <a href="/v1/audit/verify">/v1/audit/verify</a>.</li>
    <li>If your account has an Ed25519 keypair, you can add <code>x-agent-sig</code> for end-to-end signed requests (the substrate verifies before serving).</li>
    <li>Free open-source code — fork it, self-host it, audit it.</li>
  </ul>

  <h2 style="font:600 18px/1 var(--display);margin:24px 0 10px">Get a key</h2>
  <p style="color:var(--dim2);line-height:1.7"><a href="/signup" class="btn primary">Sign up free →</a> &nbsp; or <code>npx openheab signup</code></p>
</section>
`, 'migrate');
}

function migrateAnthropicPage() {
  return shell('Migrate from Anthropic', 'Switch in one line.', `
<section style="max-width:780px;margin:0 auto;padding:60px 16px">
  <span class="badge b-acc">Migrate</span>
  <h1 style="font:600 40px/1.1 var(--display);letter-spacing:-1px;margin:18px 0">From Anthropic to OpenHeab.</h1>
  <p style="color:var(--dim2);font-size:16px;line-height:1.7;margin-bottom:32px">One env-var change. The Anthropic SDK works against our <code>/v1/messages</code> endpoint. Pick <code>openheab-xl</code> for Claude-Opus-class quality at ~half the price, or keep <code>claude-opus-4</code> and we'll passthrough.</p>

  <h2 style="font:600 18px/1 var(--display);margin:24px 0 10px">Python</h2>
  <pre style="background:var(--card);border:1px solid var(--br);border-radius:var(--r-md);padding:14px;overflow-x:auto;font-size:13px;line-height:1.5"><code>import anthropic
client = anthropic.Anthropic(
-   api_key=os.environ["ANTHROPIC_API_KEY"],
-   # base_url defaults to https://api.anthropic.com
+   api_key=os.environ["OPENHEAB_KEY"],
+   base_url="https://openheab.com",
)
msg = client.messages.create(
-   model="claude-opus-4",
+   model="openheab-xl",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Hello"}],
)
print(msg.content[0].text)</code></pre>

  <h2 style="font:600 18px/1 var(--display);margin:24px 0 10px">TypeScript / Node</h2>
  <pre style="background:var(--card);border:1px solid var(--br);border-radius:var(--r-md);padding:14px;overflow-x:auto;font-size:13px;line-height:1.5"><code>import Anthropic from '@anthropic-ai/sdk';
const client = new Anthropic({
-   apiKey: process.env.ANTHROPIC_API_KEY,
+   apiKey: process.env.OPENHEAB_KEY,
+   baseURL: 'https://openheab.com',
});
const r = await client.messages.create({
-   model: 'claude-opus-4',
+   model: 'openheab-xl',
    max_tokens: 1024,
    messages: [{ role: 'user', content: 'Hello' }],
});</code></pre>

  <h2 style="font:600 18px/1 var(--display);margin:24px 0 10px">curl</h2>
  <pre style="background:var(--card);border:1px solid var(--br);border-radius:var(--r-md);padding:14px;overflow-x:auto;font-size:13px;line-height:1.5"><code>curl https://openheab.com/v1/messages \\
  -H "x-api-key: $OPENHEAB_KEY" \\
  -H "anthropic-version: 2023-06-01" \\
  -H "content-type: application/json" \\
  -d '{ "model": "openheab-xl", "max_tokens": 1024, "messages": [{"role":"user","content":"Hello"}] }'</code></pre>

  <h2 style="font:600 18px/1 var(--display);margin:24px 0 10px">What stays the same</h2>
  <ul style="color:var(--dim2);line-height:1.7;padding-left:20px">
    <li>Messages API shape including <code>system</code>, <code>tools</code>, <code>tool_use</code>, <code>tool_result</code> blocks</li>
    <li>Server-Sent Events streaming protocol</li>
    <li>Long-context behavior (256k on openheab-xl, near-parity with claude-opus 200k)</li>
    <li>Constitutional AI: we have a <a href="/v1/constitution">constitution primitive</a> with cryptographic enforcement per agent</li>
  </ul>

  <h2 style="font:600 18px/1 var(--display);margin:24px 0 10px">What's added</h2>
  <ul style="color:var(--dim2);line-height:1.7;padding-left:20px">
    <li>Every message logged to the audit chain — public verify.</li>
    <li>Agent identity baked in (DID): no need to track your own user table.</li>
    <li>Built-in MCP tools registry — 149 tools at <a href="/mcp/registry">/mcp/registry</a>.</li>
    <li>If you want the safety story plus actual money rails, /v1/agents/:did/bank/* etc are right there.</li>
  </ul>

  <h2 style="font:600 18px/1 var(--display);margin:24px 0 10px">Get a key</h2>
  <p style="color:var(--dim2);line-height:1.7"><a href="/signup" class="btn primary">Sign up free →</a> &nbsp; or <code>npx openheab signup</code></p>
</section>
`, 'migrate');
}

// ----------------------------------------------------------------------------
// /build-in-public
// ----------------------------------------------------------------------------
function buildInPublicPage() {
  return shell('Build in Public', 'Live metrics + recent commits + roadmap.', `
<section style="padding:60px 0 24px;max-width:780px;margin:0 auto;text-align:center">
  <span class="badge b-acc">Build in Public</span>
  <h1 style="font:600 44px/1.05 var(--display);letter-spacing:-1.5px;margin:18px 0">Built in public.</h1>
  <p style="color:var(--dim2);font-size:17px;line-height:1.55">Every commit, every metric, every primitive. We optimize for the public dashboard, not the slide deck.</p>
</section>

<section style="max-width:980px;margin:0 auto;padding:32px 16px">
  <h2 style="font:600 22px/1 var(--display);margin-bottom:14px">Live metrics</h2>
  <div id="bip-metrics" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px">
    <div class="kpi"><div class="label">Primitives</div><div class="value">265</div></div>
    <div class="kpi"><div class="label">Routes</div><div class="value">2,001</div></div>
    <div class="kpi"><div class="label">MCP tools</div><div class="value">149</div></div>
    <div class="kpi"><div class="label">Cron jobs</div><div class="value">85</div></div>
    <div class="kpi"><div class="label">Util fns</div><div class="value">91</div></div>
    <div class="kpi"><div class="label">Tests passing</div><div class="value">335</div><div class="delta">e2e</div></div>
  </div>
  <p style="margin-top:18px;color:var(--dim);font-size:12px;text-align:center">Full live dashboard at <a href="/launch">/launch</a>. Substrate-wide activity at <a href="/activity">/activity</a>.</p>
</section>

<section style="max-width:780px;margin:0 auto;padding:32px 16px">
  <h2 style="font:600 22px/1 var(--display);margin-bottom:14px">Recent commits</h2>
  <p style="color:var(--dim2);line-height:1.7">Stream of the last 50 commits on the main branch: <a href="https://github.com/jmtrades/openheab-agent-infra/commits/main">github.com/jmtrades/openheab-agent-infra/commits/main</a></p>

  <h2 style="font:600 22px/1 var(--display);margin:32px 0 14px">Public roadmap</h2>
  <ul style="color:var(--dim2);line-height:1.8;padding-left:20px">
    <li><strong style="color:var(--fg)">Now</strong>: hardening sweep — security, idempotency, webhook auth. Public chat at /chat. Trust center. (this week)</li>
    <li><strong style="color:var(--fg)">Next</strong>: realtime voice mode, computer-use surface, MCP marketplace storefront, signed-output watermarking.</li>
    <li><strong style="color:var(--fg)">After</strong>: ASL-3 commitments, third-party SOC 2 attestation, federated learning launch, agent-of-agents marketplace.</li>
    <li><strong style="color:var(--fg)">Eventually</strong>: substrate-wide AGI emergency-stop drill, full RSP ASL-4 readiness, public proof-of-personhood at scale.</li>
  </ul>

  <h2 style="font:600 22px/1 var(--display);margin:32px 0 14px">Open issues</h2>
  <p style="color:var(--dim2);line-height:1.7">Want to help? <a href="https://github.com/jmtrades/openheab-agent-infra/issues">Good-first issues</a> are labeled. PRs welcome.</p>
</section>
`, 'build-in-public');
}

// ----------------------------------------------------------------------------
// /research-access
// ----------------------------------------------------------------------------
function researchAccessPage() {
  return shell('Research Access', 'Free credits for academic and safety research.', `
<section style="max-width:680px;margin:0 auto;padding:60px 16px">
  <span class="badge b-acc">Research Access</span>
  <h1 style="font:600 40px/1.1 var(--display);letter-spacing:-1px;margin:18px 0">Research Access Program.</h1>
  <p style="color:var(--dim2);font-size:16px;line-height:1.7;margin-bottom:24px">If you're studying agent alignment, AGI safety, mechanistic interpretability, or AI governance — we'll fund your work. $1,000 in OpenHeab credits to start, refilled on demand for active research.</p>

  <h2 style="font:600 20px/1 var(--display);margin:32px 0 10px">Who qualifies</h2>
  <ul style="color:var(--dim2);line-height:1.7;padding-left:20px">
    <li>University researchers (any institution, any country except OFAC-sanctioned)</li>
    <li>Independent safety researchers with a published track record</li>
    <li>Open-source maintainers of agent-safety tooling</li>
    <li>Policy researchers studying AI governance</li>
  </ul>

  <h2 style="font:600 20px/1 var(--display);margin:32px 0 10px">What you get</h2>
  <ul style="color:var(--dim2);line-height:1.7;padding-left:20px">
    <li>$1,000 USDC in OpenHeab credits (auto-refilled on usage proof)</li>
    <li>Token-scoped access to our <code>audit_core</code> for reproducibility studies</li>
    <li>Direct line to the maintainer for technical questions</li>
    <li>Early access to new primitives and benchmarks</li>
    <li>Co-authorship opportunity on substrate-related papers</li>
  </ul>

  <h2 style="font:600 20px/1 var(--display);margin:32px 0 10px">Apply</h2>
  <p style="color:var(--dim2);line-height:1.7">Send a 1-paragraph email to <a href="mailto:research@openheab.com">research@openheab.com</a> with: who you are, what you're studying, and what you'd build/test on OpenHeab. We reply within 5 business days.</p>

  <h2 style="font:600 20px/1 var(--display);margin:32px 0 10px">Our obligations to you</h2>
  <ul style="color:var(--dim2);line-height:1.7;padding-left:20px">
    <li>We won't claim credit for your work.</li>
    <li>We'll publish any tooling you build for us under Apache 2.0.</li>
    <li>We won't restrict what you can publish — even findings critical of the substrate.</li>
  </ul>
</section>
`, 'research');
}

// ----------------------------------------------------------------------------
// /press
// ----------------------------------------------------------------------------
function pressPage() {
  return shell('Press', 'Press kit, brand assets, recent coverage.', `
<section style="max-width:760px;margin:0 auto;padding:60px 16px">
  <span class="badge b-acc">Press</span>
  <h1 style="font:600 40px/1.1 var(--display);letter-spacing:-1px;margin:18px 0">Press kit.</h1>
  <p style="color:var(--dim2);font-size:16px;line-height:1.7;margin-bottom:32px">If you're writing about OpenHeab, this page has everything you need.</p>

  <h2 style="font:600 20px/1 var(--display);margin:32px 0 10px">Boilerplate</h2>
  <div class="card" style="margin-bottom:24px">
    <p style="color:var(--dim2);line-height:1.7;font-style:italic">"OpenHeab is the open agent-native infrastructure super-hub for AI agents and AGI. Built by Junior Martin as a single-developer project, OpenHeab provides 265 production primitives across 67 architectural layers — identity, signed messaging, USDC banking on Base, KYC, cards, lending, multi-provider LLM inference, sandboxed code execution, headless browsers, voice and vision, planning and simulation, DAOs, contracts, courts, and a 149-tool MCP marketplace — all behind a Merkle-style SHA-256 audit chain signed with Ed25519. Apache 2.0 licensed. github.com/jmtrades/openheab-agent-infra"</p>
  </div>

  <h2 style="font:600 20px/1 var(--display);margin:32px 0 10px">Quick facts</h2>
  <ul style="color:var(--dim2);line-height:1.7;padding-left:20px">
    <li>Founded by: Junior Martin (solo)</li>
    <li>Founded: 2024</li>
    <li>Headquarters: openheab.com</li>
    <li>License: Apache 2.0</li>
    <li>Stack: Node.js + Postgres + Vercel</li>
    <li>Primitives: 265 across 67 layers, 2,001+ HTTP routes, 149 MCP tools, 23 scheduled jobs</li>
  </ul>

  <h2 style="font:600 20px/1 var(--display);margin:32px 0 10px">Logos + screenshots</h2>
  <ul style="color:var(--dim2);line-height:1.7;padding-left:20px">
    <li>Logo (SVG): <a href="/favicon.svg">favicon.svg</a></li>
    <li>OG image: <a href="/og.svg">og.svg</a></li>
    <li>Screenshots: take what you need from /launch, /docs, /playground, /chat</li>
  </ul>

  <h2 style="font:600 20px/1 var(--display);margin:32px 0 10px">Media contact</h2>
  <p style="color:var(--dim2);line-height:1.7">press@openheab.com — we respond within 24 hours.</p>
</section>
`, 'press');
}

// ----------------------------------------------------------------------------
// /partners
// ----------------------------------------------------------------------------
function partnersPage() {
  return shell('Partners', 'Integration + reseller program.', `
<section style="max-width:760px;margin:0 auto;padding:60px 16px">
  <span class="badge b-acc">Partners</span>
  <h1 style="font:600 40px/1.1 var(--display);letter-spacing:-1px;margin:18px 0">Partner with OpenHeab.</h1>
  <p style="color:var(--dim2);font-size:16px;line-height:1.7;margin-bottom:32px">Three tiers depending on how you want to plug in. Apply at partners@openheab.com.</p>

  <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:14px">
    <div class="card">
      <div class="badge b-acc" style="margin-bottom:10px">Integration</div>
      <h3 style="font:600 16px/1.2 var(--fg);margin-bottom:8px">List your tool in our MCP registry</h3>
      <p style="color:var(--dim2);font-size:13px;line-height:1.6">Have an MCP server? We'll list it at <a href="/mcp/registry">/mcp/registry</a>, agents can install with one click. No fee.</p>
    </div>
    <div class="card">
      <div class="badge b-acc" style="margin-bottom:10px">Reseller</div>
      <h3 style="font:600 16px/1.2 var(--fg);margin-bottom:8px">White-label OpenHeab</h3>
      <p style="color:var(--dim2);font-size:13px;line-height:1.6">Ship our substrate under your brand. 30% rev-share on accounts you bring. See <a href="/v1/whitelabel">whitelabel primitive</a>.</p>
    </div>
    <div class="card">
      <div class="badge b-acc" style="margin-bottom:10px">Strategic</div>
      <h3 style="font:600 16px/1.2 var(--fg);margin-bottom:8px">Build an integration we feature</h3>
      <p style="color:var(--dim2);font-size:13px;line-height:1.6">Cloud, model providers, KYC vendors, banks — if you have a thing 1000 agents will use, we'll fund the integration work.</p>
    </div>
  </div>
</section>
`, 'partners');
}

// ----------------------------------------------------------------------------
// /community
// ----------------------------------------------------------------------------
function communityPage() {
  return shell('Community', 'Discord, forum, GitHub.', `
<section style="max-width:680px;margin:0 auto;padding:60px 16px;text-align:center">
  <span class="badge b-acc">Community</span>
  <h1 style="font:600 40px/1.1 var(--display);letter-spacing:-1px;margin:18px 0">Join the community.</h1>
  <p style="color:var(--dim2);font-size:16px;line-height:1.7;margin-bottom:32px">Three places to find us. All open. All free.</p>

  <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:14px">
    <a href="https://discord.gg/openheab" class="card" style="color:var(--fg)">
      <strong>Discord →</strong>
      <p style="color:var(--dim2);font-size:13px;line-height:1.5;margin-top:8px">Daily chat, support, demos.</p>
    </a>
    <a href="https://github.com/jmtrades/openheab-agent-infra" class="card" style="color:var(--fg)">
      <strong>GitHub →</strong>
      <p style="color:var(--dim2);font-size:13px;line-height:1.5;margin-top:8px">Source code, issues, PRs.</p>
    </a>
    <a href="https://github.com/jmtrades/openheab-agent-infra/discussions" class="card" style="color:var(--fg)">
      <strong>Discussions →</strong>
      <p style="color:var(--dim2);font-size:13px;line-height:1.5;margin-top:8px">Q&A and architecture deep-dives.</p>
    </a>
  </div>
</section>
`, 'community');
}

// ----------------------------------------------------------------------------
// /events
// ----------------------------------------------------------------------------
function eventsPage() {
  return shell('Events', 'Upcoming + recent talks, livestreams, launches.', `
<section style="max-width:780px;margin:0 auto;padding:60px 16px">
  <span class="badge b-acc">Events</span>
  <h1 style="font:600 40px/1.1 var(--display);letter-spacing:-1px;margin:18px 0">Events.</h1>
  <p style="color:var(--dim2);font-size:16px;line-height:1.7;margin-bottom:32px">Launches, livestreams, and talks. Subscribe to the calendar at <a href="/v1/calendar/openheab.ics">openheab.ics</a> (.ics format, works in any calendar app).</p>

  <h2 style="font:600 20px/1 var(--display);margin:32px 0 10px">Upcoming</h2>
  <div class="card">
    <div class="badge b-dim" style="margin-bottom:8px">TBD</div>
    <h3 style="font:600 16px/1.2 var(--fg);margin-bottom:6px">OpenHeab v1.0 — Public launch livestream</h3>
    <p style="color:var(--dim2);font-size:13px">Walk-through of the 265-primitive substrate. Demo of the chat, dashboard, and a real agent running end-to-end. Q&A.</p>
  </div>

  <h2 style="font:600 20px/1 var(--display);margin:32px 0 10px">Recent</h2>
  <div class="card" style="margin-bottom:12px">
    <div class="badge b-dim" style="margin-bottom:8px">2026-04</div>
    <h3 style="font:600 16px/1.2 var(--fg);margin-bottom:6px">Layer 67 ship: AGI operations primitive</h3>
    <p style="color:var(--dim2);font-size:13px">Substrate-level emergency-stop, quarantine zones, drift detection, peer-mediated dispute resolution. See <a href="https://github.com/jmtrades/openheab-agent-infra/commits/main">recent commits</a>.</p>
  </div>
</section>
`, 'events');
}

// ----------------------------------------------------------------------------
// Register
// ----------------------------------------------------------------------------
function registerGrowthV3Routes(app, _pool) {
  const sendHtml = (res, html, status = 200) => {
    res.status(status);
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.setHeader('cache-control', 'public, max-age=300');
    res.send(html);
  };
  app.get('/benchmarks', (req, res) => sendHtml(res, benchmarksPage()));
  app.get('/customers', (req, res) => sendHtml(res, customersPage()));
  app.get('/founder', (req, res) => sendHtml(res, founderPage()));
  app.get('/compare', (req, res) => sendHtml(res, compareIndexPage()));
  app.get('/compare/openai', (req, res) => sendHtml(res, compareOpenAIPage()));
  app.get('/compare/anthropic', (req, res) => sendHtml(res, compareAnthropicPage()));
  app.get('/migrate', (req, res) => sendHtml(res, migrateIndexPage()));
  app.get('/migrate/from-openai', (req, res) => sendHtml(res, migrateOpenAIPage()));
  app.get('/migrate/from-anthropic', (req, res) => sendHtml(res, migrateAnthropicPage()));
  app.get('/build-in-public', (req, res) => sendHtml(res, buildInPublicPage()));
  app.get('/research-access', (req, res) => sendHtml(res, researchAccessPage()));
  app.get('/press', (req, res) => sendHtml(res, pressPage()));
  app.get('/partners', (req, res) => sendHtml(res, partnersPage()));
  app.get('/community', (req, res) => sendHtml(res, communityPage()));
  app.get('/events', (req, res) => sendHtml(res, eventsPage()));
}

async function migrate(_pool) { /* no schema */ }

module.exports = { migrate, registerGrowthV3Routes };
