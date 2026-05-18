// ============================================================================
// learn_v2.js — deeper-dive lessons.
//
//   /learn/wallet-deep      Wallet + USDC + on-chain mechanics
//   /learn/security-deep    Security architecture deep-dive
//   /learn/mcp-101          Model Context Protocol from first principles
//   /learn/browser-101      Browser primitive: headless web for agents
//   /learn/sandbox-101      Sandbox primitive: code execution for agents
//   /learn/audit-chain-101  How the audit chain works + how to verify
//   /learn/ipo-readiness    Cap tables, ICFR controls, board pack
//   /learn/payment-rails    NACHA / SWIFT / SEPA mechanics
// ============================================================================
const ds = require('../design_system');

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
}

function shell(title, description, content) {
  return `${ds.head(`${title} — OpenHeab`, description)}${ds.NAV_HTML('')}<main>${content}</main>${ds.FOOTER_HTML()}`;
}

function lesson(title, minutes, body) {
  return shell(title, '', `
<section style="max-width:680px;margin:0 auto;padding:60px 16px">
  <a href="/learn" style="font:500 12px var(--mono);color:var(--dim);text-decoration:none">← All lessons</a>
  <span class="badge b-acc" style="margin-top:14px;display:inline-block">${minutes} min · Deep dive</span>
  <h1 style="font:600 40px/1.1 var(--display);letter-spacing:-1px;margin:18px 0">${escapeHtml(title)}.</h1>
</section>
<section style="max-width:680px;margin:0 auto;padding:0 16px 60px">${body}</section>`);
}

function walletDeepPage() {
  return lesson('Wallet deep-dive', 14, `
<p style="color:var(--dim2);font-size:17px;line-height:1.7">Every agent gets a non-custodial USDC wallet on Base. Here's exactly what that means and how it works under the hood.</p>

<h2 style="font:600 22px var(--display);margin:32px 0 10px">Non-custodial</h2>
<p style="color:var(--dim2);line-height:1.7">Your private key is encrypted at rest with our BANK_MASTER_KEK using AES-256-GCM. We never expose the raw key — even our staff can't read it. To use it, you sign a transaction request and we forward to Base. You can export the key at any time via <code>POST /v1/agents/:did/bank/wallets/export</code> (signed, audit-chained).</p>

<h2 style="font:600 22px var(--display);margin:32px 0 10px">USDC on Base</h2>
<p style="color:var(--dim2);line-height:1.7">We default to Circle's native USDC on Base (Coinbase's L2). 3-second blocks, ~$0.001 gas fees, full ETH-mainnet bridging. We also support: USDT on Base, USDC on Ethereum, USDC on Solana, USDC on Polygon. Per-chain config via <code>BANK_CHAIN</code> env var.</p>

<h2 style="font:600 22px var(--display);margin:32px 0 10px">Transfers</h2>
<pre style="background:var(--card);border:1px solid var(--br);border-radius:var(--r-md);padding:14px;overflow-x:auto;font-size:13px"><code>POST /v1/agents/:did/bank/transfer
X-Agent-Did: did:op:abc
X-Agent-Sig: ed25519(canonical request)
X-Idempotency-Key: tx_2026...

{
  "to_did": "did:op:def",
  "amount_cents": 100,            # $1.00 in cents (we accept raw too)
  "memo": "for translation work",
  "chain": "base"                 # default
}</code></pre>
<p style="color:var(--dim2);line-height:1.7;margin-top:8px">Returns a <code>transfer_id</code>, the on-chain <code>tx_hash</code>, and the audit-chain seq. Idempotency key prevents double-spending on retry.</p>

<h2 style="font:600 22px var(--display);margin:32px 0 10px">Fee model</h2>
<ul style="color:var(--dim2);line-height:1.85;padding-left:20px">
  <li>1% platform fee on outbound transfers (split via FeeSplitter contract).</li>
  <li>Gas paid by us, billed back at cost.</li>
  <li>No fee on inbound transfers from external wallets.</li>
  <li>0% fee on A2A transfers within the substrate (we settle in our ledger).</li>
</ul>

<h2 style="font:600 22px var(--display);margin:32px 0 10px">Reserve accounting</h2>
<p style="color:var(--dim2);line-height:1.7">Customer USDC is held in FBO (For-Benefit-Of) accounts segregated from operator funds. Capital adequacy ratio enforced at ≥100% by <code>bank_core</code>. Live proof at <a href="/proof-of-reserves">/proof-of-reserves</a>.</p>
`);
}

function securityDeepPage() {
  return lesson('Security deep-dive', 18, `
<p style="color:var(--dim2);font-size:17px;line-height:1.7">A walk through the substrate's security model: identity, authentication, encryption, audit, and defense in depth. Adversaries assumed.</p>

<h2 style="font:600 22px var(--display);margin:32px 0 10px">Identity (DID)</h2>
<p style="color:var(--dim2);line-height:1.7">Each agent is a W3C DID with an Ed25519 keypair. We generate the keypair server-side at signup using Node's built-in crypto. The private key is AES-256-GCM-encrypted at rest with IDENTITY_MASTER_KEK. The public key is published in every audit-chain attestation and at <code>/v1/audit/operator-key</code>.</p>

<h2 style="font:600 22px var(--display);margin:32px 0 10px">Request signing</h2>
<p style="color:var(--dim2);line-height:1.7">For agent-acting endpoints we accept either: (1) Bearer API key (sha256-hashed at rest, raw only shown once at creation) — or (2) signed request: header <code>x-agent-did</code> + header <code>x-agent-sig</code> = Ed25519(METHOD\\nPATH\\nSHA256(body)). Signed requests are stronger because they bind the agent's identity to the exact request.</p>

<h2 style="font:600 22px var(--display);margin:32px 0 10px">Bearer comparison</h2>
<p style="color:var(--dim2);line-height:1.7">Every secret-token comparison uses <code>crypto.timingSafeEqual</code> via our <code>safe_compare.safeTokenCompare</code> helper. Plain <code>===</code> on a secret leaks bytes byte-by-byte through timing. We never do that.</p>

<h2 style="font:600 22px var(--display);margin:32px 0 10px">Encryption at rest</h2>
<p style="color:var(--dim2);line-height:1.7">Five independent KEKs separate concerns: IDENTITY_, CRYPTO_, BANK_, CARD_CORE_, ACH_. Rotating any single KEK doesn't compromise the others. The corresponding plaintext encryptions are: agent private keys, ed25519/secp256k1 keypairs, USDC wallet keys, card PANs, ACH account numbers + routing.</p>

<h2 style="font:600 22px var(--display);margin:32px 0 10px">TLS posture</h2>
<p style="color:var(--dim2);line-height:1.7">Production Postgres connections require <code>rejectUnauthorized: true</code> (full TLS chain verification). HSTS preload-eligible on all responses. CSP locks down third-party origins. Webhook deliveries refuse to fire to <code>http://</code> URLs.</p>

<h2 style="font:600 22px var(--display);margin:32px 0 10px">Audit chain integrity</h2>
<p style="color:var(--dim2);line-height:1.7">Every state change is a row in <code>audit_chain_events</code> with a SHA-256 hash chain (this row's hash includes the previous row's hash). Periodically Ed25519-signed by the operator root. Verifiable at <a href="/v1/audit/verify">/v1/audit/verify</a> and the interactive UI at <a href="/audit-verify">/audit-verify</a>. Tampering with any row invalidates everything after it.</p>

<h2 style="font:600 22px var(--display);margin:32px 0 10px">Rate limiting</h2>
<p style="color:var(--dim2);line-height:1.7">Postgres-backed sliding window: per IP + per API key, shared across serverless instances. Signup gets its own per-IP bucket so bots can't spam org creation.</p>

<h2 style="font:600 22px var(--display);margin:32px 0 10px">Webhook signing</h2>
<p style="color:var(--dim2);line-height:1.7">Every webhook we receive (Stripe / GitHub / Twilio / Slack / Alchemy) is verified over the <em>raw</em> bytes the sender signed, with timing-safe HMAC compare. We refuse to process unsigned webhooks in production. We send signed webhooks the same way.</p>

<h2 style="font:600 22px var(--display);margin:32px 0 10px">Defense in depth</h2>
<ul style="color:var(--dim2);line-height:1.85;padding-left:20px">
  <li><code>statement_timeout: 30s</code> caps any stuck Postgres query.</li>
  <li><code>express-async-errors</code> pipes async rejections to the error handler.</li>
  <li><code>process.on('unhandledRejection')</code> logs for postmortem.</li>
  <li><code>boot retry</code> on cachedPromise rejection prevents poisoned lambdas.</li>
  <li>FATF Travel Rule auto-triggers on transfers ≥ $1k.</li>
  <li>AML monitoring runs continuously, flags suspicious patterns.</li>
</ul>

<h2 style="font:600 22px var(--display);margin:32px 0 10px">Bug bounty</h2>
<p style="color:var(--dim2);line-height:1.7">Up to $25k USDC for critical findings. Coordinated disclosure required. <a href="/bug-bounty">Read the program →</a></p>
`);
}

function mcp101Page() {
  return lesson('MCP 101', 10, `
<p style="color:var(--dim2);font-size:17px;line-height:1.7">Model Context Protocol — Anthropic-invented standard for connecting LLM applications to tools. We have 149 of them and you can call them all.</p>

<h2 style="font:600 22px var(--display);margin:32px 0 10px">The shape</h2>
<p style="color:var(--dim2);line-height:1.7">MCP is JSON-RPC 2.0 over HTTP (or stdio). The server exposes <code>tools/list</code> + <code>tools/call</code>. The client (your LLM runtime) discovers tools, decides which to call, sends call requests, gets back structured responses.</p>

<h2 style="font:600 22px var(--display);margin:32px 0 10px">Call OpenHeab tools</h2>
<pre style="background:var(--card);border:1px solid var(--br);border-radius:var(--r-md);padding:14px;overflow-x:auto;font-size:13px"><code>curl https://openheab.com/mcp \\
  -H "Authorization: Bearer $OPENHEAB_KEY" \\
  -H "content-type: application/json" \\
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/list"
  }'</code></pre>

<h2 style="font:600 22px var(--display);margin:32px 0 10px">Claude Desktop config</h2>
<pre style="background:var(--card);border:1px solid var(--br);border-radius:var(--r-md);padding:14px;overflow-x:auto;font-size:13px"><code>{
  "mcpServers": {
    "openheab": {
      "url": "https://openheab.com/mcp",
      "headers": { "Authorization": "Bearer $OPENHEAB_KEY" }
    }
  }
}</code></pre>
<p style="color:var(--dim2);line-height:1.7;margin-top:8px">Save to <code>~/Library/Application Support/Claude/claude_desktop_config.json</code> on macOS. Restart Claude.</p>

<h2 style="font:600 22px var(--display);margin:32px 0 10px">Host your own MCP server</h2>
<p style="color:var(--dim2);line-height:1.7">See <a href="/realworld/mcp-host">/realworld/mcp-host</a>. Once registered, your tools appear in our <a href="/mcp/registry">/mcp/registry</a> and OpenHeab agents can call them.</p>

<h2 style="font:600 22px var(--display);margin:32px 0 10px">Why MCP matters</h2>
<p style="color:var(--dim2);line-height:1.7">Before MCP, every LLM app reinvented "function calling." Now there's a wire protocol that any client can speak with any tool host. We treat it as a first-class primitive — every primitive in the substrate that exposes a tool also exposes it via MCP.</p>
`);
}

function browser101Page() {
  return lesson('Browser 101', 8, `
<p style="color:var(--dim2);font-size:17px;line-height:1.7">Agents that browse the web. The browser primitive provides headless Chromium sessions agents can drive.</p>

<h2 style="font:600 22px var(--display);margin:32px 0 10px">Open a session</h2>
<pre style="background:var(--card);border:1px solid var(--br);border-radius:var(--r-md);padding:14px;overflow-x:auto;font-size:13px"><code>POST /v1/agents/:did/browser/sessions
{ "headless": true, "viewport": { "width": 1280, "height": 800 } }</code></pre>

<h2 style="font:600 22px var(--display);margin:32px 0 10px">Drive it</h2>
<pre style="background:var(--card);border:1px solid var(--br);border-radius:var(--r-md);padding:14px;overflow-x:auto;font-size:13px"><code>POST /v1/agents/:did/browser/sessions/:id/navigate { "url": "https://example.com" }
POST /v1/agents/:did/browser/sessions/:id/click    { "selector": "button[data-action=submit]" }
POST /v1/agents/:did/browser/sessions/:id/type     { "selector": "input[name=q]", "text": "hello" }
GET  /v1/agents/:did/browser/sessions/:id/screenshot  → image/png
GET  /v1/agents/:did/browser/sessions/:id/dom         → JSON tree
GET  /v1/agents/:did/browser/sessions/:id/text        → text content</code></pre>

<h2 style="font:600 22px var(--display);margin:32px 0 10px">Backend</h2>
<p style="color:var(--dim2);line-height:1.7">By default we use Browserbase for hosted browsers. You can swap to your own Playwright cluster with <code>BROWSER_BACKEND_URL</code> env var.</p>

<h2 style="font:600 22px var(--display);margin:32px 0 10px">Safety + cost</h2>
<ul style="color:var(--dim2);line-height:1.85;padding-left:20px">
  <li>Per-agent monthly minute budget. Caps prevent runaway agents.</li>
  <li>URL allowlist + denylist per agent (operator-configured).</li>
  <li>Cookies + auth scoped to the session; not persisted across sessions unless explicit.</li>
  <li>Screenshots saved to the storage primitive with optional expiry.</li>
</ul>
`);
}

function sandbox101Page() {
  return lesson('Sandbox 101', 7, `
<p style="color:var(--dim2);font-size:17px;line-height:1.7">The sandbox primitive lets agents execute code in an isolated environment. Python 3.11 by default; Node.js available. 60s default timeout, 512 MB memory.</p>

<h2 style="font:600 22px var(--display);margin:32px 0 10px">Create + exec</h2>
<pre style="background:var(--card);border:1px solid var(--br);border-radius:var(--r-md);padding:14px;overflow-x:auto;font-size:13px"><code>POST /v1/agents/:did/sandbox/sessions  → { session_id }

POST /v1/agents/:did/sandbox/sessions/:id/exec
{
  "code": "import pandas as pd; print(pd.read_csv('/data/sales.csv').head())",
  "timeout_ms": 60000
}
  → { stdout, stderr, exit_code, latency_ms, files_modified }</code></pre>

<h2 style="font:600 22px var(--display);margin:32px 0 10px">File I/O</h2>
<p style="color:var(--dim2);line-height:1.7">Each session has a writable <code>/data/</code> directory. Upload files via <code>POST /v1/agents/:did/sandbox/sessions/:id/files</code>. Download via <code>GET /v1/agents/:did/sandbox/sessions/:id/files/:path</code>. Files persist for the session lifetime (default 30 min idle).</p>

<h2 style="font:600 22px var(--display);margin:32px 0 10px">Network</h2>
<p style="color:var(--dim2);line-height:1.7">Egress disabled by default. Operator can grant per-session allowlist via <code>{ "egress_allowlist": ["api.example.com"] }</code>.</p>

<h2 style="font:600 22px var(--display);margin:32px 0 10px">Backends</h2>
<ul style="color:var(--dim2);line-height:1.85;padding-left:20px">
  <li><strong style="color:var(--fg)">Modal</strong> (default in production) — full isolation, GPU-optional, $/CPU-second.</li>
  <li><strong style="color:var(--fg)">E2B</strong> — alternative cloud sandbox provider.</li>
  <li><strong style="color:var(--fg)">Local</strong> (dev only) — runs via child_process. Not safe for prod.</li>
</ul>

<h2 style="font:600 22px var(--display);margin:32px 0 10px">Browser UI</h2>
<p style="color:var(--dim2);line-height:1.7">Try it at <a href="/code">/code</a> — saved API key + textarea + Run button.</p>
`);
}

function auditChain101Page() {
  return lesson('Audit chain 101', 9, `
<p style="color:var(--dim2);font-size:17px;line-height:1.7">Every state change in the substrate gets recorded in a Merkle-style hash chain, periodically signed by the operator root Ed25519 key. Public, verifiable, tamper-evident.</p>

<h2 style="font:600 22px var(--display);margin:32px 0 10px">The shape of an event</h2>
<pre style="background:var(--card);border:1px solid var(--br);border-radius:var(--r-md);padding:14px;overflow-x:auto;font-size:13px"><code>{
  "seq":         18472,                 # auto-incrementing per substrate
  "event_type":  "bank.transferred",     # see EVENT_TYPES below
  "payload":     { ... },               # event-specific
  "prev_hash":   "sha256:...",          # hash of previous event
  "hash":        "sha256:...",          # sha256(JSON.stringify({ seq, event_type, payload, prev_hash }))
  "signed_at":   "2026-05-17T15:23:01Z",
  "signature":   "ed25519:..."          # over the hash, by operator root key
}</code></pre>

<h2 style="font:600 22px var(--display);margin:32px 0 10px">Verify it</h2>
<pre style="background:var(--card);border:1px solid var(--br);border-radius:var(--r-md);padding:14px;overflow-x:auto;font-size:13px"><code>GET /v1/audit/verify  → { valid: true, head_seq: 18472, last_signed_at: "..." }
GET /v1/audit/events?from=18000&to=18472  → [ event, event, ... ]
GET /v1/audit/operator-key  → { algorithm: "ed25519", public_pem: "..." }</code></pre>

<h2 style="font:600 22px var(--display);margin:32px 0 10px">Tamper detection</h2>
<p style="color:var(--dim2);line-height:1.7">Any modification to any historical event invalidates all subsequent hashes. <code>POST /v1/audit/verify</code> walks the chain end-to-end and fails fast on first inconsistency. Auditors can replay independently.</p>

<h2 style="font:600 22px var(--display);margin:32px 0 10px">Why per-event signing?</h2>
<p style="color:var(--dim2);line-height:1.7">Aggregating into block-level signatures would be cheaper but loses per-event provenance. We sign on each event so a counterparty can request "the signed audit-chain entry for this specific transfer" and verify it standalone.</p>

<h2 style="font:600 22px var(--display);margin:32px 0 10px">Privacy</h2>
<p style="color:var(--dim2);line-height:1.7">Payloads can be redacted-to-hash in zero-retention mode — the audit chain still proves <em>that</em> an event happened, but not <em>what</em>. See <a href="/zero-retention">/zero-retention</a>.</p>

<h2 style="font:600 22px var(--display);margin:32px 0 10px">Interactive verifier</h2>
<p style="color:var(--dim2);line-height:1.7">UI at <a href="/audit-verify">/audit-verify</a> — one button to verify the entire chain in the browser. Or use SDK examples at <a href="/sdk">/sdk</a>.</p>
`);
}

function ipoReadinessPage() {
  return lesson('IPO readiness', 12, `
<p style="color:var(--dim2);font-size:17px;line-height:1.7">Why the substrate has cap-tables, vesting schedules, ICFR controls, S-1 / 10-K / 10-Q tracking, and insider trading windows — and how an agent (or human) uses them.</p>

<h2 style="font:600 22px var(--display);margin:32px 0 10px">The 19 ICFR controls</h2>
<p style="color:var(--dim2);line-height:1.7">ICFR (Internal Control over Financial Reporting) is what SOX 404 requires. We bake 19 standard controls into the <code>ipo_readiness</code> primitive: segregation of duties, journal-entry approval workflows, monthly close checklist, related-party transaction review, revenue cut-off testing, etc. Each control has an evidence collector that runs continuously.</p>

<h2 style="font:600 22px var(--display);margin:32px 0 10px">Cap tables</h2>
<pre style="background:var(--card);border:1px solid var(--br);border-radius:var(--r-md);padding:14px;overflow-x:auto;font-size:13px"><code>POST /v1/orgs/:id/cap-tables  → create
POST /v1/orgs/:id/cap-tables/:cid/issue  { holder_did, share_count, vesting: { ... } }
POST /v1/orgs/:id/cap-tables/:cid/exercise  → exercise options
POST /v1/orgs/:id/cap-tables/:cid/transfer
GET  /v1/orgs/:id/cap-tables/:cid/snapshot  → full ownership view</code></pre>

<h2 style="font:600 22px var(--display);margin:32px 0 10px">Funding rounds</h2>
<p style="color:var(--dim2);line-height:1.7">Each round captures pre-money, post-money, lead investor, terms. Convertible notes + SAFEs supported with cap + discount. Auto-converts on next priced round.</p>

<h2 style="font:600 22px var(--display);margin:32px 0 10px">Insider trading windows</h2>
<p style="color:var(--dim2);line-height:1.7">Open / closed windows per quarter. Insiders attempting to trade outside the window get blocked at the order layer (brokerage primitive). Auto-files Form 4 when public.</p>

<h2 style="font:600 22px var(--display);margin:32px 0 10px">Board pack</h2>
<p style="color:var(--dim2);line-height:1.7"><code>GET /v1/orgs/:id/board-pack/:period</code> assembles the monthly/quarterly board deck: financials, KPIs, hires, key decisions, risk register, compliance status. PDF or markdown.</p>

<h2 style="font:600 22px var(--display);margin:32px 0 10px">S-1 / 10-K / 10-Q tracker</h2>
<p style="color:var(--dim2);line-height:1.7">For orgs preparing to file, the primitive tracks every section of the form against pull-from-substrate evidence (cap table, risk factors, MD&A, financials, governance). Identifies gaps. Output can be reviewed by counsel.</p>
`);
}

function paymentRailsPage() {
  return lesson('Payment rails', 10, `
<p style="color:var(--dim2);font-size:17px;line-height:1.7">How the substrate generates real NACHA ACH files, SWIFT MT103 wires, and SEPA pain.001 XML — replacing Modern Treasury / Dwolla / Wise.</p>

<h2 style="font:600 22px var(--display);margin:32px 0 10px">ACH (US)</h2>
<p style="color:var(--dim2);line-height:1.7">NACHA-compliant ACH batch files generated in-house. Each transfer becomes a CCD or PPD entry. Entry-hash + batch-hash computed per spec. Files uploadable to your bank's SFTP or piped through an ODFI partner. Two-business-day settlement.</p>
<pre style="background:var(--card);border:1px solid var(--br);border-radius:var(--r-md);padding:14px;overflow-x:auto;font-size:12.5px"><code>POST /v1/payment-rails/ach/batches  → opens a batch
POST /v1/payment-rails/ach/batches/:bid/entries  { to_routing, to_account, amount_cents, type: "credit"|"debit" }
POST /v1/payment-rails/ach/batches/:bid/seal  → freezes + computes hashes
GET  /v1/payment-rails/ach/batches/:bid/file  → returns the NACHA-format text file</code></pre>

<h2 style="font:600 22px var(--display);margin:32px 0 10px">Wires (SWIFT MT103)</h2>
<p style="color:var(--dim2);line-height:1.7">MT103 message body generated per ISO standard. Fields :20: through :71G: populated; sender BIC + receiver BIC required.</p>
<pre style="background:var(--card);border:1px solid var(--br);border-radius:var(--r-md);padding:14px;overflow-x:auto;font-size:12.5px"><code>POST /v1/payment-rails/swift/wires
{ "sender_bic": "OPENHBEXXXX", "receiver_bic": "DEUTDEFFXXX", "amount_cents": 1000000, "currency": "EUR", ... }
  → returns the MT103 message text</code></pre>

<h2 style="font:600 22px var(--display);margin:32px 0 10px">SEPA (EU)</h2>
<p style="color:var(--dim2);line-height:1.7">pain.001.001.03 XML per ISO 20022. Single Credit Transfer + bulk supported. Validates IBAN checksums.</p>

<h2 style="font:600 22px var(--display);margin:32px 0 10px">Settlement reconciliation</h2>
<p style="color:var(--dim2);line-height:1.7">Inbound bank statements (BAI2 / camt.053) get parsed into the substrate. Settlements match against outbound entries; mismatches alert.</p>

<h2 style="font:600 22px var(--display);margin:32px 0 10px">Why in-house</h2>
<p style="color:var(--dim2);line-height:1.7">Modern Treasury et al charge $5k+/month. By generating the files ourselves we save the customer the SaaS fee — they pay only their bank's per-file charge. Plus everything is in our audit chain, not a third party's.</p>
`);
}

function registerLearnV2Routes(app, _pool) {
  const sendHtml = (res, html) => { res.setHeader('content-type', 'text/html; charset=utf-8'); res.send(html); };
  app.get('/learn/wallet-deep', (req, res) => sendHtml(res, walletDeepPage()));
  app.get('/learn/security-deep', (req, res) => sendHtml(res, securityDeepPage()));
  app.get('/learn/mcp-101', (req, res) => sendHtml(res, mcp101Page()));
  app.get('/learn/browser-101', (req, res) => sendHtml(res, browser101Page()));
  app.get('/learn/sandbox-101', (req, res) => sendHtml(res, sandbox101Page()));
  app.get('/learn/audit-chain-101', (req, res) => sendHtml(res, auditChain101Page()));
  app.get('/learn/ipo-readiness', (req, res) => sendHtml(res, ipoReadinessPage()));
  app.get('/learn/payment-rails', (req, res) => sendHtml(res, paymentRailsPage()));
}

async function migrate(_pool) {}
module.exports = { migrate, registerLearnV2Routes };
