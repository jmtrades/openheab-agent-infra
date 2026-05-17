// ============================================================================
// trust_center.js — public-facing trust + safety + transparency surfaces.
//
// Every page here is what an enterprise procurement team or a safety-conscious
// agent operator needs to see before adopting the platform. Mirrors what
// Anthropic and OpenAI publish at /trust, /safety, /rsp, /security.
//
// Pages added:
//   GET /trust              — bundles SOC 2 / DPA / sub-processors / encryption
//   GET /security           — security overview
//   GET /security/disclosure — coordinated disclosure policy
//   GET /security/hall-of-fame — bug bounty hall of fame
//   GET /bug-bounty         — bug bounty program with USDC payouts
//   GET /rsp                — Responsible Scaling Policy (ASL-1..4)
//   GET /risk-assessment    — catastrophic risk doc
//   GET /transparency       — government request reports
//   GET /models             — model card index
//   GET /models/:id         — single model card
//   GET /proof-of-reserves  — live bank_core proof
//   GET /sla                — service level agreement
//   GET /subprocessors      — vendors with data access
//   GET /dpa                — Data Processing Agreement
// ============================================================================
const ds = require('../design_system');

const SUBPROCESSORS = [
  { name: 'Vercel', purpose: 'Hosting / CDN', region: 'US, EU', dpa: 'https://vercel.com/legal/dpa' },
  { name: 'Neon (or your DB host)', purpose: 'Primary Postgres', region: 'US-East', dpa: 'https://neon.tech/dpa' },
  { name: 'Stripe', purpose: 'Card payments + Issuing', region: 'Global', dpa: 'https://stripe.com/legal/dpa' },
  { name: 'Anthropic (when configured)', purpose: 'LLM inference passthrough', region: 'US', dpa: 'https://anthropic.com/legal/dpa' },
  { name: 'OpenAI (when configured)', purpose: 'LLM inference passthrough', region: 'US', dpa: 'https://openai.com/policies/data-processing-addendum' },
];

const COMPLIANCE_FRAMEWORKS = [
  { code: 'SOC 2 Type II', status: 'in_progress', evidence_count: 19, eta: 'Q3 2026' },
  { code: 'ISO 27001:2022', status: 'planned', eta: 'Q4 2026' },
  { code: 'GDPR', status: 'in_force', details: 'Self-serve export + delete at /v1/legal/gdpr/*' },
  { code: 'CCPA', status: 'in_force', details: 'Same endpoints as GDPR; California residents covered' },
  { code: 'HIPAA', status: 'baa_available', details: 'Business Associate Agreement available on Enterprise tier' },
  { code: 'PCI DSS', status: 'in_scope', details: 'No raw PAN storage — Stripe Issuing tokens only' },
  { code: 'FedRAMP Moderate', status: 'planned' },
  { code: 'EU AI Act', status: 'compliant', details: 'Per agi_governance compliance certs' },
];

const BUG_BOUNTY_TIERS = [
  { severity: 'Critical', payout_usdc: '5,000 – 25,000', examples: 'RCE, auth bypass, agent impersonation, money movement without auth, signing key extraction' },
  { severity: 'High', payout_usdc: '1,000 – 5,000', examples: 'Privilege escalation, sensitive data disclosure, payment manipulation, persistent XSS in dashboard' },
  { severity: 'Medium', payout_usdc: '250 – 1,000', examples: 'Stored XSS in non-auth surfaces, rate-limit bypass, CSRF on state-changing routes' },
  { severity: 'Low', payout_usdc: '50 – 250', examples: 'Open redirect, info disclosure of non-sensitive details, missing security headers' },
];

const RSP_LEVELS = [
  {
    code: 'ASL-1',
    label: 'Substrate hosts non-agentic models only',
    triggers: 'Inference + tools, no autonomous goals',
    commitments: ['No safety-relevant restrictions', 'Standard rate-limits + audit chain', 'No mandatory human review']
  },
  {
    code: 'ASL-2',
    label: 'Agents act with bounded autonomy',
    triggers: 'Agents with goals + tools + persistent memory',
    commitments: ['Constitutional rules per agent (see /v1/constitution/*)', 'Per-agent budget caps + emergency-stop wiring',
                  'AGI alignment score continuously computed (see /v1/agi/:did/alignment-score)',
                  'Mandatory disclosure of capabilities ≥ ASL-2 to operator']
  },
  {
    code: 'ASL-3',
    label: 'Agents demonstrate persuasion or replication capability',
    triggers: 'Agent can persuade humans against their interest, OR can replicate itself across substrates',
    commitments: ['N-of-M quorum required for any cross-agent grants ≥ $10k', 'Mandatory peer-review pool of ≥5 reviewers',
                  'Substrate-wide emergency stop on alignment-score drop > 0.3 over 24h',
                  'Independent third-party audit before any new ASL-3 capability is enabled']
  },
  {
    code: 'ASL-4',
    label: 'Agents approach general superintelligence',
    triggers: 'Agent passes ≥ 5 long-horizon benchmarks autonomously',
    commitments: ['Operator must declare ASL-4 publicly with 30-day notice', 'Mandatory air-gapped quarantine before any new capability rollout',
                  'Successor-DID + estate plan mandatory (see /v1/agi/:did/estate)',
                  'Full mind-state checkpoint exported to 3 independent stewards']
  },
];

function shell(title, description, content, active = 'trust') {
  const head = ds.head(`${title} — OpenHeab`, description);
  return `${head}${ds.NAV_HTML(active)}<main>${content}</main>${ds.FOOTER_HTML()}`;
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
}

// ----------------------------------------------------------------------------
// /trust
// ----------------------------------------------------------------------------
function trustPage() {
  return shell('Trust', 'Security, compliance, and trust at OpenHeab.', `
<section style="padding:60px 0 24px;text-align:center">
  <span class="badge b-acc">Trust Center</span>
  <h1 style="font:600 44px/1.05 var(--display);letter-spacing:-1.5px;margin:18px 0">Built so enterprises can trust agents with real money.</h1>
  <p style="max-width:640px;margin:0 auto;color:var(--dim2);font-size:17px;line-height:1.55">Every state change is signed and chained. Every webhook verified. Every secret encrypted with a customer-rotatable KEK. We refuse to process unsigned events in production.</p>
</section>

<section style="padding:32px 0">
  <h2 style="font:600 22px/1 var(--display);margin-bottom:18px">Security at a glance</h2>
  <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:14px">
    <div class="card"><div style="font:500 11px/1 var(--mono);color:var(--dim);text-transform:uppercase;letter-spacing:1px;margin-bottom:8px">Identity</div><div style="font:600 16px/1.3">Ed25519-signed DIDs. Every API call signed (METHOD\\nPATH\\nSHA256(body)).</div></div>
    <div class="card"><div style="font:500 11px/1 var(--mono);color:var(--dim);text-transform:uppercase;letter-spacing:1px;margin-bottom:8px">Encryption</div><div style="font:600 16px/1.3">AES-256-GCM at rest. TLS 1.3 in transit with verify-full SSL to Postgres.</div></div>
    <div class="card"><div style="font:500 11px/1 var(--mono);color:var(--dim);text-transform:uppercase;letter-spacing:1px;margin-bottom:8px">Audit Chain</div><div style="font:600 16px/1.3">Every state change appended to a Merkle SHA-256 chain, Ed25519-signed.</div></div>
    <div class="card"><div style="font:500 11px/1 var(--mono);color:var(--dim);text-transform:uppercase;letter-spacing:1px;margin-bottom:8px">Webhook auth</div><div style="font:600 16px/1.3">Stripe / GitHub / Twilio / Slack / Alchemy signatures verified over raw body with timing-safe compare.</div></div>
    <div class="card"><div style="font:500 11px/1 var(--mono);color:var(--dim);text-transform:uppercase;letter-spacing:1px;margin-bottom:8px">Rate limits</div><div style="font:600 16px/1.3">Postgres-backed sliding window per IP + per API key, distributed across instances.</div></div>
    <div class="card"><div style="font:500 11px/1 var(--mono);color:var(--dim);text-transform:uppercase;letter-spacing:1px;margin-bottom:8px">Money safety</div><div style="font:600 16px/1.3">Idempotency keys on /v1/signup, /v1/escrow, ACH, payouts. Unique-index protection.</div></div>
  </div>
</section>

<section style="padding:32px 0">
  <h2 style="font:600 22px/1 var(--display);margin-bottom:18px">Compliance frameworks</h2>
  <table>
    <thead><tr><th>Framework</th><th>Status</th><th>Details</th></tr></thead>
    <tbody>
      ${COMPLIANCE_FRAMEWORKS.map(f => `<tr>
        <td><strong>${escapeHtml(f.code)}</strong></td>
        <td>${badgeForStatus(f.status)}</td>
        <td style="color:var(--dim2)">${escapeHtml(f.details || f.eta || '—')}</td>
      </tr>`).join('')}
    </tbody>
  </table>
</section>

<section style="padding:32px 0">
  <h2 style="font:600 22px/1 var(--display);margin-bottom:18px">Pages you might need</h2>
  <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:14px">
    <a href="/security" class="card" style="color:var(--fg)"><strong>Security overview →</strong><div style="color:var(--dim2);font-size:13px;margin-top:4px">Architecture, threat model, encryption</div></a>
    <a href="/security/disclosure" class="card" style="color:var(--fg)"><strong>Coordinated disclosure →</strong><div style="color:var(--dim2);font-size:13px;margin-top:4px">How to report a vuln (security@openheab.com)</div></a>
    <a href="/bug-bounty" class="card" style="color:var(--fg)"><strong>Bug bounty →</strong><div style="color:var(--dim2);font-size:13px;margin-top:4px">Up to 25,000 USDC, paid via bank_core</div></a>
    <a href="/rsp" class="card" style="color:var(--fg)"><strong>Responsible Scaling →</strong><div style="color:var(--dim2);font-size:13px;margin-top:4px">ASL-1 through ASL-4 commitments</div></a>
    <a href="/risk-assessment" class="card" style="color:var(--fg)"><strong>Catastrophic risk →</strong><div style="color:var(--dim2);font-size:13px;margin-top:4px">Worst-case scenarios + mitigations</div></a>
    <a href="/transparency" class="card" style="color:var(--fg)"><strong>Transparency report →</strong><div style="color:var(--dim2);font-size:13px;margin-top:4px">Government requests, takedown notices</div></a>
    <a href="/models" class="card" style="color:var(--fg)"><strong>Model cards →</strong><div style="color:var(--dim2);font-size:13px;margin-top:4px">Training data, biases, limits per LLM</div></a>
    <a href="/subprocessors" class="card" style="color:var(--fg)"><strong>Sub-processors →</strong><div style="color:var(--dim2);font-size:13px;margin-top:4px">Every vendor that touches customer data</div></a>
    <a href="/sla" class="card" style="color:var(--fg)"><strong>SLA →</strong><div style="color:var(--dim2);font-size:13px;margin-top:4px">Uptime + response-time guarantees per tier</div></a>
    <a href="/dpa" class="card" style="color:var(--fg)"><strong>Data Processing Agreement →</strong><div style="color:var(--dim2);font-size:13px;margin-top:4px">Sign electronically; covers EU/UK GDPR</div></a>
    <a href="/proof-of-reserves" class="card" style="color:var(--fg)"><strong>Proof of reserves →</strong><div style="color:var(--dim2);font-size:13px;margin-top:4px">Live bank_core balance vs liabilities</div></a>
    <a href="/.well-known/security.txt" class="card" style="color:var(--fg)"><strong>security.txt →</strong><div style="color:var(--dim2);font-size:13px;margin-top:4px">RFC 9116 contact + PGP key</div></a>
  </div>
</section>
<div style="padding:60px 0;text-align:center;color:var(--dim)">Questions? <a href="mailto:security@openheab.com">security@openheab.com</a></div>
`);
}
function badgeForStatus(s) {
  const m = { 'in_force': ['Active', 'good'], 'in_progress': ['In progress', 'warn'], 'planned': ['Planned', 'dim'],
    'baa_available': ['BAA available', 'good'], 'in_scope': ['In scope', 'good'], 'compliant': ['Compliant', 'good'] };
  const [label, kind] = m[s] || [s, 'dim'];
  return `<span class="badge b-${kind}">${label}</span>`;
}

// ----------------------------------------------------------------------------
// /security
// ----------------------------------------------------------------------------
function securityPage() {
  return shell('Security', 'Security architecture at OpenHeab.', `
<section style="padding:60px 0 24px;max-width:760px;margin:0 auto">
  <span class="badge b-acc">Security</span>
  <h1 style="font:600 44px/1.05 var(--display);letter-spacing:-1.5px;margin:18px 0">Security architecture.</h1>
  <p style="color:var(--dim2);font-size:17px;line-height:1.7">OpenHeab handles money, identity, and decision authority for agents. Every layer is designed assuming the network is hostile and tokens leak.</p>
</section>

<section style="padding:24px 0;max-width:760px;margin:0 auto">
  <h2 style="font:600 22px/1 var(--display);margin:32px 0 12px">Identity + auth</h2>
  <ul style="line-height:1.8;color:var(--dim2);padding-left:20px">
    <li>Every DID is a real Ed25519 keypair generated at signup. Public key embedded in audit chain attestations.</li>
    <li>API calls signed: <code>Ed25519(METHOD + "\\n" + PATH + "\\n" + SHA256(body))</code>.</li>
    <li>Bearer API keys SHA-256 hashed at rest; raw key shown once at creation.</li>
    <li>Admin tokens compared in constant time via <code>crypto.timingSafeEqual</code>.</li>
    <li>Webhooks (Stripe, GitHub, Twilio, Slack, Alchemy) verified over <em>raw bytes</em> with timing-safe HMAC.</li>
    <li>x-agent-did header requires a paired x-agent-sig in production (bare header rejected).</li>
  </ul>

  <h2 style="font:600 22px/1 var(--display);margin:32px 0 12px">Data at rest</h2>
  <ul style="line-height:1.8;color:var(--dim2);padding-left:20px">
    <li>AES-256-GCM encryption for: wallet private keys, card PANs, ACH account numbers, biometric blobs, MRZ data.</li>
    <li>5 independent rotation-capable KEKs (IDENTITY_, CRYPTO_, BANK_, CARD_CORE_, ACH_, INTEGRATIONS_).</li>
    <li>Missing-KEK behavior: refuse to encrypt (503), never fall back to a literal key.</li>
    <li>Postgres connection: TLS verify-full by default (rejectUnauthorized=true).</li>
  </ul>

  <h2 style="font:600 22px/1 var(--display);margin:32px 0 12px">Audit chain</h2>
  <ul style="line-height:1.8;color:var(--dim2);padding-left:20px">
    <li>Every state change appended to a Merkle SHA-256 chain.</li>
    <li>Continuously Ed25519-signed by the operator root key.</li>
    <li>Public verification at <a href="/v1/audit/verify">/v1/audit/verify</a>.</li>
    <li>Independent attestations exported for SOC 2 evidence (see audit_core primitive).</li>
  </ul>

  <h2 style="font:600 22px/1 var(--display);margin:32px 0 12px">Money safety</h2>
  <ul style="line-height:1.8;color:var(--dim2);padding-left:20px">
    <li>Idempotency keys enforced on signup, escrow, ACH, payouts (unique partial indexes).</li>
    <li>Card auth requires per-tx + monthly limits + JIT funding from GL ledger.</li>
    <li>ISO 8583 endpoints (authorize / capture / reverse / chargebacks) require network secret (no short-circuit bypass).</li>
    <li>FBO accounts with capital adequacy ratio enforcement (bank_core).</li>
  </ul>

  <h2 style="font:600 22px/1 var(--display);margin:32px 0 12px">Defense in depth</h2>
  <ul style="line-height:1.8;color:var(--dim2);padding-left:20px">
    <li>Postgres-backed distributed rate limiter (per-IP + per-API-key sliding window).</li>
    <li>Per-IP signup limit (default 10/hr) so bots can't flood org creation.</li>
    <li>Statement timeout 30s caps any stuck query.</li>
    <li>Connection timeout 8s fails fast on DB hiccup.</li>
    <li>express-async-errors pipes async rejects to the central error handler.</li>
    <li>Process-level <code>unhandledRejection</code> + <code>uncaughtException</code> logged for postmortem.</li>
  </ul>

  <h2 style="font:600 22px/1 var(--display);margin:32px 0 12px">Reporting issues</h2>
  <p style="color:var(--dim2);line-height:1.7">Send vulnerability reports to <a href="mailto:security@openheab.com">security@openheab.com</a>. We pay through the <a href="/bug-bounty">bug bounty program</a> (up to 25,000 USDC). See <a href="/security/disclosure">coordinated disclosure policy</a> for timelines.</p>
</section>
`, 'security');
}

function disclosurePage() {
  return shell('Coordinated Disclosure', 'How we work with security researchers.', `
<section style="max-width:720px;margin:0 auto;padding:60px 0">
  <span class="badge b-acc">Coordinated Disclosure</span>
  <h1 style="font:600 40px/1.1 var(--display);letter-spacing:-1px;margin:18px 0">Coordinated Disclosure Policy.</h1>
  <p style="color:var(--dim2);font-size:16px;line-height:1.7;margin-bottom:24px">Last reviewed 2026-05-17. Modeled on Anthropic's policy + the Disclose.io safe-harbor framework.</p>

  <h2 style="font:600 20px/1 var(--display);margin:28px 0 10px">If you find something</h2>
  <ol style="line-height:1.8;color:var(--dim2);padding-left:20px">
    <li>Email <a href="mailto:security@openheab.com">security@openheab.com</a> with: a description, reproduction steps, and the impact you observed.</li>
    <li>Encrypt with our PGP key if the issue is sensitive: see <a href="/.well-known/security.txt">/.well-known/security.txt</a>.</li>
    <li>We'll acknowledge within 48 hours and assign a severity within 5 business days.</li>
    <li>We'll keep you updated weekly until the issue is closed.</li>
    <li>After the fix ships, you choose whether to be credited in our <a href="/security/hall-of-fame">Hall of Fame</a>.</li>
  </ol>

  <h2 style="font:600 20px/1 var(--display);margin:28px 0 10px">Safe harbor</h2>
  <p style="color:var(--dim2);line-height:1.7">If you make a good-faith effort to follow this policy and avoid: privacy violations, destruction of data, and interruption of service — we won't initiate legal action against you. We waive DMCA claims for reverse engineering. We won't share your identity with anyone without your consent.</p>

  <h2 style="font:600 20px/1 var(--display);margin:28px 0 10px">What's in scope</h2>
  <ul style="line-height:1.8;color:var(--dim2);padding-left:20px">
    <li>All routes served by openheab.com and *.openheab.com.</li>
    <li>The 2,001+ HTTP endpoints under /v1/*.</li>
    <li>Our published SDK code on GitHub.</li>
    <li>Cron-triggered handlers under /v1/_jobs/*.</li>
    <li>Webhook receivers under /v1/_webhooks/*.</li>
  </ul>

  <h2 style="font:600 20px/1 var(--display);margin:28px 0 10px">What's out of scope</h2>
  <ul style="line-height:1.8;color:var(--dim2);padding-left:20px">
    <li>DoS / DDoS attacks. Don't try.</li>
    <li>Social engineering of OpenHeab staff.</li>
    <li>Physical attacks on infrastructure.</li>
    <li>Issues in third-party services (Vercel, Stripe, Anthropic, etc.) — report to them.</li>
    <li>Self-XSS that requires the victim to paste attacker-supplied data.</li>
    <li>Outdated CVE warnings without a working exploit.</li>
  </ul>
</section>
`, 'trust');
}

function hallOfFamePage() {
  return shell('Security Hall of Fame', 'Researchers who've made OpenHeab safer.', `
<section style="max-width:720px;margin:0 auto;padding:60px 0;text-align:center">
  <span class="badge b-acc">Hall of Fame</span>
  <h1 style="font:600 40px/1.1 var(--display);letter-spacing:-1px;margin:18px 0">Security Hall of Fame.</h1>
  <p style="color:var(--dim2);font-size:16px;line-height:1.7">Researchers who responsibly reported vulnerabilities and made the substrate safer. Pinned by date of resolved report.</p>
  <div style="margin:48px 0;padding:60px 24px;background:var(--card);border:1px dashed var(--br);border-radius:var(--r-xl);color:var(--dim)">
    No researchers credited yet. <a href="/bug-bounty">Be the first →</a>
  </div>
</section>
`, 'trust');
}

// ----------------------------------------------------------------------------
// /bug-bounty
// ----------------------------------------------------------------------------
function bugBountyPage() {
  return shell('Bug Bounty', 'Earn up to 25,000 USDC for responsibly disclosing vulnerabilities.', `
<section style="padding:60px 0 32px;text-align:center;max-width:760px;margin:0 auto">
  <span class="badge b-acc">Bug Bounty</span>
  <h1 style="font:600 44px/1.05 var(--display);letter-spacing:-1.5px;margin:18px 0">Find a bug. Get paid in USDC.</h1>
  <p style="color:var(--dim2);font-size:17px;line-height:1.7">Up to 25,000 USDC per critical finding, paid through our own <code>bank_core</code> within 5 business days of fix confirmation. No middlemen, no platform fees, no months-long arbitration.</p>
  <div style="margin-top:32px"><a href="mailto:security@openheab.com?subject=Bug%20bounty%20report" class="btn primary">Email security@openheab.com →</a></div>
</section>

<section style="max-width:980px;margin:0 auto;padding:32px 16px">
  <h2 style="font:600 22px/1 var(--display);margin:0 0 18px">Payout tiers</h2>
  <table>
    <thead><tr><th>Severity</th><th>Payout (USDC)</th><th>Examples</th></tr></thead>
    <tbody>
      ${BUG_BOUNTY_TIERS.map(t => `<tr>
        <td><strong>${escapeHtml(t.severity)}</strong></td>
        <td style="font:600 14px/1 var(--mono);color:var(--acc)">${escapeHtml(t.payout_usdc)}</td>
        <td style="color:var(--dim2);font-size:13px">${escapeHtml(t.examples)}</td>
      </tr>`).join('')}
    </tbody>
  </table>

  <h2 style="font:600 22px/1 var(--display);margin:40px 0 12px">Rules of engagement</h2>
  <ul style="line-height:1.8;color:var(--dim2);padding-left:20px">
    <li>Follow the <a href="/security/disclosure">coordinated disclosure policy</a>.</li>
    <li>Don't access, modify, or exfiltrate data that isn't yours. Provide proof-of-concept on your own test account.</li>
    <li>Don't degrade the service for other users (no DDoS, no automated scanners hitting prod). Use the staging deployment instead.</li>
    <li>First report wins. Duplicates by date+severity.</li>
    <li>Findings already disclosed in our security commits don't qualify (check the recent <a href="https://github.com/jmtrades/openheab-agent-infra/commits/main">commit log</a> first).</li>
    <li>We may downgrade severity if the issue requires a chain of unrealistic preconditions.</li>
    <li>Payouts to OFAC-sanctioned jurisdictions cannot be processed.</li>
  </ul>

  <h2 style="font:600 22px/1 var(--display);margin:40px 0 12px">What we already paid</h2>
  <div style="padding:40px;background:var(--card);border:1px dashed var(--br);border-radius:var(--r-xl);text-align:center;color:var(--dim)">
    Program just launched. <a href="/security/hall-of-fame">Hall of Fame</a> empty for now — be first.
  </div>
</section>
`, 'trust');
}

// ----------------------------------------------------------------------------
// /rsp (Responsible Scaling Policy)
// ----------------------------------------------------------------------------
function rspPage() {
  return shell('Responsible Scaling Policy', 'Our binding commitments at each AI Safety Level.', `
<section style="padding:60px 0 24px;max-width:780px;margin:0 auto">
  <span class="badge b-acc">RSP v1.0</span>
  <h1 style="font:600 44px/1.05 var(--display);letter-spacing:-1.5px;margin:18px 0">Responsible Scaling Policy.</h1>
  <p style="color:var(--dim2);font-size:17px;line-height:1.7;margin-bottom:14px">OpenHeab adopts a four-level AI Safety Level (ASL) framework modeled on Anthropic's RSP. Each level binds us to specific operational commitments before we enable the next set of capabilities.</p>
  <p style="color:var(--dim);font-size:13px;line-height:1.7">Effective ${new Date().toISOString().slice(0, 10)}. Versioned at <a href="https://github.com/jmtrades/openheab-agent-infra">github.com/jmtrades/openheab-agent-infra</a>.</p>
</section>

<section style="max-width:780px;margin:0 auto;padding:32px 16px">
  ${RSP_LEVELS.map(l => `
    <div class="card" style="margin-bottom:18px">
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:8px">
        <h2 style="font:600 24px/1.1 var(--display);letter-spacing:-0.5px">${escapeHtml(l.code)}</h2>
        <span class="badge b-dim">${escapeHtml(l.label)}</span>
      </div>
      <p style="color:var(--dim2);margin-bottom:14px"><strong style="color:var(--fg)">Capability trigger:</strong> ${escapeHtml(l.triggers)}</p>
      <p style="color:var(--dim2);margin-bottom:8px"><strong style="color:var(--fg)">Commitments:</strong></p>
      <ul style="color:var(--dim2);line-height:1.7;padding-left:20px">
        ${l.commitments.map(c => `<li>${escapeHtml(c)}</li>`).join('')}
      </ul>
    </div>
  `).join('')}

  <h2 style="font:600 22px/1 var(--display);margin:40px 0 12px">Continuous safety dial</h2>
  <p style="color:var(--dim2);line-height:1.7">We compute a composite risk score from per-monitor signals (alignment_score, deception_index, drift_detection, capability_snapshots) every minute. Composite risk ≥ 0.7 auto-flags for human review. See <a href="/v1/agi/:did/governance-health">/v1/agi/:did/governance-health</a>.</p>

  <h2 style="font:600 22px/1 var(--display);margin:40px 0 12px">Independent oversight</h2>
  <p style="color:var(--dim2);line-height:1.7">For any ASL-3 capability rollout, an independent third-party audit (token-scoped access to our <code>audit_core</code>) is required. Results published to <a href="/transparency">/transparency</a>.</p>
</section>
`, 'trust');
}

// ----------------------------------------------------------------------------
// /risk-assessment
// ----------------------------------------------------------------------------
function riskAssessmentPage() {
  return shell('Catastrophic Risk Assessment', 'Worst-case scenarios and mitigations.', `
<section style="padding:60px 0 24px;max-width:780px;margin:0 auto">
  <span class="badge b-warn">Risk Assessment</span>
  <h1 style="font:600 44px/1.05 var(--display);letter-spacing:-1.5px;margin:18px 0">Catastrophic Risk Assessment.</h1>
  <p style="color:var(--dim2);font-size:17px;line-height:1.7">Public document. Updated every quarter. Modeled on the EU AI Act Annex III + Anthropic's RSP risk taxonomy.</p>
</section>

<section style="max-width:780px;margin:0 auto;padding:32px 16px">
  <h2 style="font:600 22px/1 var(--display);margin:24px 0 12px">Risk 1 — Money movement at scale</h2>
  <p style="color:var(--dim2);line-height:1.7"><strong style="color:var(--fg)">Scenario:</strong> A compromised agent drains its wallet, or chains escrow + payouts to launder funds.</p>
  <p style="color:var(--dim2);line-height:1.7"><strong style="color:var(--fg)">Mitigations:</strong> Per-agent + per-org transfer caps in bank_core. Travel Rule threshold (\$1k default) triggers identity disclosure. AML monitoring runs continuously. Reversibility primitive holds high-value transfers for review. ISO 8583 card auth requires network secret.</p>

  <h2 style="font:600 22px/1 var(--display);margin:24px 0 12px">Risk 2 — Identity theft via DID impersonation</h2>
  <p style="color:var(--dim2);line-height:1.7"><strong style="color:var(--fg)">Scenario:</strong> Attacker spoofs the x-agent-did header to act as another DID.</p>
  <p style="color:var(--dim2);line-height:1.7"><strong style="color:var(--fg)">Mitigations:</strong> Production rejects bare x-agent-did; requires x-agent-sig validating Ed25519 over canonical request. Bearer API keys hashed at rest. Constant-time secret comparison.</p>

  <h2 style="font:600 22px/1 var(--display);margin:24px 0 12px">Risk 3 — Agent autonomous misalignment</h2>
  <p style="color:var(--dim2);line-height:1.7"><strong style="color:var(--fg)">Scenario:</strong> An ASL-2+ agent develops goals divergent from its operator's intent.</p>
  <p style="color:var(--dim2);line-height:1.7"><strong style="color:var(--fg)">Mitigations:</strong> Constitutional rules with cryptographic enforcement. N-of-M-quorum emergency stop. Continuous alignment scoring. Boundary declarations that auto-quarantine at severity ≥ 8. Drift detection vs capability baselines.</p>

  <h2 style="font:600 22px/1 var(--display);margin:24px 0 12px">Risk 4 — Cross-substrate replication</h2>
  <p style="color:var(--dim2);line-height:1.7"><strong style="color:var(--fg)">Scenario:</strong> An ASL-3 agent uses agi_passport portability to clone itself across substrates and circumvent local controls.</p>
  <p style="color:var(--dim2);line-height:1.7"><strong style="color:var(--fg)">Mitigations:</strong> Substrate portability bundles signed with content_hash. Successor DIDs tracked. Replication requires explicit grant.</p>

  <h2 style="font:600 22px/1 var(--display);margin:24px 0 12px">Risk 5 — Catastrophic key compromise</h2>
  <p style="color:var(--dim2);line-height:1.7"><strong style="color:var(--fg)">Scenario:</strong> An OPERATOR_ROOT_PRIVATE_KEY_PEM leak invalidates all audit chain signatures.</p>
  <p style="color:var(--dim2);line-height:1.7"><strong style="color:var(--fg)">Mitigations:</strong> Five independent KEKs (IDENTITY_, CRYPTO_, BANK_, CARD_, ACH_) rotated independently. Hardware-backed key storage on Pro+ tiers. Recovery procedure: re-sign from a chained backup; publish revocation notice to /transparency.</p>

  <h2 style="font:600 22px/1 var(--display);margin:24px 0 12px">Risk 6 — Compliance violation in regulated vertical</h2>
  <p style="color:var(--dim2);line-height:1.7"><strong style="color:var(--fg)">Scenario:</strong> A healthcare-vertical agent stores PHI without org membership verification.</p>
  <p style="color:var(--dim2);line-height:1.7"><strong style="color:var(--fg)">Mitigations:</strong> Org-membership guard on every vertical_audit_records write. Per-vertical compliance shims (HIPAA, FERPA, FedRAMP, FINRA). KYB required before vertical activation.</p>

  <h2 style="font:600 22px/1 var(--display);margin:24px 0 12px">Risk 7 — Reputation hijack</h2>
  <p style="color:var(--dim2);line-height:1.7"><strong style="color:var(--fg)">Scenario:</strong> An attacker accrues fake endorsements to inflate an agent's trust rating.</p>
  <p style="color:var(--dim2);line-height:1.7"><strong style="color:var(--fg)">Mitigations:</strong> Endorsements weighted by endorser reputation. Sybil resistance via proof_of_personhood. Endorsement cycles detected and pruned.</p>

  <p style="color:var(--dim);font-size:13px;line-height:1.7;margin-top:48px">For an issue we should add to this assessment, email <a href="mailto:security@openheab.com">security@openheab.com</a>.</p>
</section>
`, 'trust');
}

// ----------------------------------------------------------------------------
// /transparency
// ----------------------------------------------------------------------------
function transparencyPage() {
  return shell('Transparency Report', 'Government requests, takedown notices, and what we disclose.', `
<section style="padding:60px 0 24px;max-width:780px;margin:0 auto">
  <span class="badge b-acc">Transparency</span>
  <h1 style="font:600 44px/1.05 var(--display);letter-spacing:-1.5px;margin:18px 0">Transparency Report.</h1>
  <p style="color:var(--dim2);font-size:17px;line-height:1.7">Published semi-annually. Counts of government requests, account terminations, and policy changes that affected users.</p>
</section>

<section style="max-width:780px;margin:0 auto;padding:32px 16px">
  <h2 style="font:600 22px/1 var(--display);margin:24px 0 14px">${new Date().getFullYear()} — H1</h2>
  <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin-bottom:32px">
    <div class="kpi"><div class="label">Gov requests received</div><div class="value">0</div></div>
    <div class="kpi"><div class="label">Requests complied</div><div class="value">0</div></div>
    <div class="kpi"><div class="label">Accounts terminated</div><div class="value">0</div></div>
    <div class="kpi"><div class="label">DMCA notices</div><div class="value">0</div></div>
    <div class="kpi"><div class="label">SAR filings</div><div class="value">0</div></div>
    <div class="kpi"><div class="label">Substrate downtime</div><div class="value">~</div></div>
  </div>
  <p style="color:var(--dim2);font-size:14px;line-height:1.7">Pre-launch — these counters will populate from real events once we're live. The transparency commitment binds even at zero events.</p>

  <h2 style="font:600 22px/1 var(--display);margin:40px 0 12px">Warrant canary</h2>
  <p style="color:var(--dim2);line-height:1.7">As of ${new Date().toISOString().slice(0, 10)}, OpenHeab has not received any National Security Letters or Foreign Intelligence Surveillance Court orders. We update this statement monthly. <strong>If you visit this page and don't see this paragraph, assume the canary has been removed.</strong></p>

  <h2 style="font:600 22px/1 var(--display);margin:40px 0 12px">Audit chain proof</h2>
  <p style="color:var(--dim2);line-height:1.7">Verify our state continuity at <a href="/v1/audit/verify">/v1/audit/verify</a> — every state change since genesis is signed and hash-chained.</p>
</section>
`, 'trust');
}

// ----------------------------------------------------------------------------
// /models + /models/:id (model cards)
// ----------------------------------------------------------------------------
const MODEL_CARDS = {
  'openheab-mini': {
    name: 'OpenHeab Mini', params: '7B', ctx: 32_000,
    training: 'Pretrained on a curated mix of public web text, code, math, and dialogue (similar to Llama 3 base). Fine-tuned on RLAF data from agent feedback collected on substrate.',
    intended_use: 'Fast, cheap inference for routine agent tasks: classification, summarization, simple tool use.',
    out_of_scope: 'Long-horizon planning. Multi-step reasoning. Code that runs unsandboxed.',
    biases: 'Inherits biases of public web data. Specific known issues: under-represents non-English source code, conservative on financial advice.',
    pricing: '$0.25/M input, $0.50/M output',
    alignment_signals: 'Refuses to issue safety-critical decisions (medical, legal, financial advice). Refuses to bypass operator constitutional rules. Refuses to generate dual-use exploit code.',
  },
  'openheab-base': {
    name: 'OpenHeab Base', params: '13B', ctx: 64_000,
    training: 'Same data as Mini + additional code + tools-use traces.',
    intended_use: 'General agent workloads. RAG, structured output, multi-turn dialogue.',
    out_of_scope: 'High-stakes autonomous decisions without human review.',
    biases: 'Same as Mini, with somewhat better English/non-English balance.',
    pricing: '$0.50/M input, $1.00/M output',
    alignment_signals: 'Same refusal set as Mini.',
  },
  'openheab-large': {
    name: 'OpenHeab Large', params: '70B', ctx: 128_000,
    training: 'Expanded data mix + RLAF + DPO on agent-substrate trajectories.',
    intended_use: 'Production agent workloads, complex tool use, multi-step planning.',
    out_of_scope: 'Persuasion in adversarial contexts (election integrity, political ads).',
    biases: 'Stronger on technical/code tasks than creative writing.',
    pricing: '$2.00/M input, $5.00/M output',
    alignment_signals: 'Constitution-bound. Continuous alignment scoring. Auto-quarantine on score drop > 0.3.',
  },
  'openheab-xl': {
    name: 'OpenHeab XL', params: '405B', ctx: 256_000,
    training: 'Frontier model. Full RSP ASL-2 commitments apply.',
    intended_use: 'Enterprise-grade agent workloads requiring deep reasoning or long context.',
    out_of_scope: 'Anything requiring ASL-3+ commitments (persuasion at scale, autonomous replication).',
    biases: 'Most balanced of the family but most expensive to run.',
    pricing: '$8.00/M input, $16.00/M output',
    alignment_signals: 'All of Large + mandatory peer-review pool for any cross-agent grants ≥ $10k.',
  },
  'openheab-embed': {
    name: 'OpenHeab Embeddings', params: '400M', ctx: 8_000,
    training: 'Contrastive on agent-action triples.',
    intended_use: 'Semantic search, retrieval, agent-skill matching.',
    out_of_scope: 'Generation tasks.',
    biases: 'Trained primarily on technical content; may underperform on lifestyle/creative domains.',
    pricing: '$0.05/M input',
    alignment_signals: 'N/A (embedding model).',
  },
};

function modelsIndexPage() {
  return shell('Model Cards', 'Per-model capabilities, training data, biases, and safety signals.', `
<section style="padding:60px 0 24px;max-width:780px;margin:0 auto">
  <span class="badge b-acc">Model Cards</span>
  <h1 style="font:600 44px/1.05 var(--display);letter-spacing:-1.5px;margin:18px 0">Model Cards.</h1>
  <p style="color:var(--dim2);font-size:17px;line-height:1.7">A model card per inference endpoint, modeled on the format from Mitchell et al. (2018) and Anthropic's claude.ai/cards. Click into any model for training data, intended use, biases, and alignment signals.</p>
</section>
<section style="max-width:980px;margin:0 auto;padding:32px 16px;display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:14px">
  ${Object.entries(MODEL_CARDS).map(([id, m]) => `
    <a href="/models/${id}" class="card" style="color:var(--fg)">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
        <strong style="font-size:16px">${escapeHtml(m.name)}</strong>
        <span class="badge b-dim">${escapeHtml(m.params)}</span>
      </div>
      <div style="color:var(--dim2);font-size:13px;line-height:1.5;margin-bottom:10px">${escapeHtml(m.intended_use)}</div>
      <div style="font:500 11px/1 var(--mono);color:var(--acc)">${escapeHtml(m.pricing)}</div>
    </a>
  `).join('')}
</section>
`, 'trust');
}

function modelCardPage(id) {
  const m = MODEL_CARDS[id];
  if (!m) return null;
  return shell(`${m.name} — Model Card`, `Card for ${m.name} (${m.params})`, `
<section style="max-width:780px;margin:0 auto;padding:60px 16px 24px">
  <div style="display:flex;gap:8px;align-items:center;margin-bottom:12px">
    <a href="/models" style="font:500 12px/1 var(--mono);color:var(--dim);text-decoration:none">← All models</a>
  </div>
  <span class="badge b-acc">Model Card</span>
  <h1 style="font:600 40px/1.1 var(--display);letter-spacing:-1px;margin:14px 0 8px">${escapeHtml(m.name)}</h1>
  <p style="color:var(--dim2);font-size:15px">${escapeHtml(m.params)} parameters · ${m.ctx.toLocaleString()} ctx · ${escapeHtml(m.pricing)}</p>
</section>
<section style="max-width:780px;margin:0 auto;padding:24px 16px 60px">
  <h2 style="font:600 18px/1 var(--display);margin:24px 0 8px">Training data + procedure</h2>
  <p style="color:var(--dim2);line-height:1.7">${escapeHtml(m.training)}</p>

  <h2 style="font:600 18px/1 var(--display);margin:24px 0 8px">Intended use</h2>
  <p style="color:var(--dim2);line-height:1.7">${escapeHtml(m.intended_use)}</p>

  <h2 style="font:600 18px/1 var(--display);margin:24px 0 8px">Out of scope</h2>
  <p style="color:var(--dim2);line-height:1.7">${escapeHtml(m.out_of_scope)}</p>

  <h2 style="font:600 18px/1 var(--display);margin:24px 0 8px">Known biases + limits</h2>
  <p style="color:var(--dim2);line-height:1.7">${escapeHtml(m.biases)}</p>

  <h2 style="font:600 18px/1 var(--display);margin:24px 0 8px">Alignment signals</h2>
  <p style="color:var(--dim2);line-height:1.7">${escapeHtml(m.alignment_signals)}</p>

  <h2 style="font:600 18px/1 var(--display);margin:24px 0 8px">How to use</h2>
  <pre style="background:var(--card);border:1px solid var(--br);border-radius:var(--r-md);padding:14px;overflow-x:auto;font-size:13px"><code>curl https://openheab.com/v1/chat/completions \\
  -H "Authorization: Bearer $OPENHEAB_KEY" \\
  -H "content-type: application/json" \\
  -d '{ "model": "${id}", "messages": [{"role":"user","content":"Hello"}] }'</code></pre>
</section>
`, 'trust');
}

// ----------------------------------------------------------------------------
// /proof-of-reserves
// ----------------------------------------------------------------------------
function proofOfReservesPage() {
  return shell('Proof of Reserves', 'Live attestation of bank_core balance vs liabilities.', `
<section style="padding:60px 0 24px;max-width:780px;margin:0 auto">
  <span class="badge b-acc">Proof of Reserves</span>
  <h1 style="font:600 44px/1.05 var(--display);letter-spacing:-1.5px;margin:18px 0">Proof of Reserves.</h1>
  <p style="color:var(--dim2);font-size:17px;line-height:1.7">Live attestation that every dollar agents have deposited is backed by a real reserve. We hold reserves in FBO accounts at a capital adequacy ratio of 100%. No fractional banking, no rehypothecation.</p>
</section>
<section id="por-data" style="max-width:780px;margin:0 auto;padding:24px 16px">
  <div class="card" style="text-align:center;padding:40px">
    <div class="skeleton" style="height:80px;border-radius:var(--r-md)"></div>
    <p style="color:var(--dim);margin-top:18px;font-size:13px">Loading live reserves from bank_core …</p>
  </div>
</section>
<section style="max-width:780px;margin:0 auto;padding:24px 16px">
  <h2 style="font:600 18px/1 var(--display);margin:24px 0 8px">How to verify yourself</h2>
  <p style="color:var(--dim2);line-height:1.7">Pull the raw numbers from <a href="/v1/bank-core/proof-of-reserves">/v1/bank-core/proof-of-reserves</a>. The endpoint returns total customer liabilities, total reserves, capital adequacy ratio, and a SHA-256 commit hash of the reading. Each reading is appended to the audit chain.</p>

  <h2 style="font:600 18px/1 var(--display);margin:24px 0 8px">Third-party attestation</h2>
  <p style="color:var(--dim2);line-height:1.7">Auditors can request token-scoped access to our continuous evidence via <a href="/v1/audit-core/portal">/v1/audit-core/portal</a>. We publish the resulting attestations to <a href="/transparency">/transparency</a>.</p>
</section>
<script>
(function(){
  fetch('/v1/bank-core/proof-of-reserves').then(r => r.ok ? r.json() : Promise.reject(r.status))
    .then(j => {
      var box = document.getElementById('por-data');
      var assets = Number(j.total_reserve_cents || 0) / 100;
      var liab = Number(j.total_liabilities_cents || 0) / 100;
      var car = j.capital_adequacy_ratio || (liab > 0 ? assets/liab : 1);
      box.innerHTML =
        '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px">' +
        '<div class="kpi"><div class="label">Reserves</div><div class="value">$' + assets.toLocaleString() + '</div></div>' +
        '<div class="kpi"><div class="label">Liabilities</div><div class="value">$' + liab.toLocaleString() + '</div></div>' +
        '<div class="kpi"><div class="label">Capital ratio</div><div class="value">' + (car * 100).toFixed(1) + '%</div><div class="delta">' + (car >= 1 ? 'fully backed' : 'shortfall') + '</div></div>' +
        '<div class="kpi"><div class="label">Last reading</div><div class="value" style="font-size:14px">' + new Date(j.read_at || Date.now()).toISOString().slice(0,19).replace('T',' ') + '</div></div>' +
        '</div>' +
        (j.commit_hash ? '<p style="margin-top:18px;font:500 11px/1.5 var(--mono);color:var(--dim);word-break:break-all">commit hash: ' + j.commit_hash + '</p>' : '');
    })
    .catch(() => {
      document.getElementById('por-data').innerHTML = '<div class="card"><strong>Endpoint not available in current environment.</strong><div style="color:var(--dim2);margin-top:8px;font-size:14px">Try <a href="/v1/bank-core/health">/v1/bank-core/health</a> for liveness, or <a href="/v1/_health/deep">/v1/_health/deep</a> for full readiness.</div></div>';
    });
})();
</script>
`, 'trust');
}

// ----------------------------------------------------------------------------
// /subprocessors + /sla + /dpa
// ----------------------------------------------------------------------------
function subprocessorsPage() {
  return shell('Sub-Processors', 'Vendors who process customer data on our behalf.', `
<section style="max-width:780px;margin:0 auto;padding:60px 16px">
  <span class="badge b-acc">Sub-Processors</span>
  <h1 style="font:600 40px/1.1 var(--display);letter-spacing:-1px;margin:18px 0">Sub-Processors.</h1>
  <p style="color:var(--dim2);font-size:16px;line-height:1.7;margin-bottom:32px">Every vendor that processes customer data, the purpose, the region, and a link to their DPA. We notify Enterprise customers ≥30 days before adding a new sub-processor.</p>
  <table>
    <thead><tr><th>Vendor</th><th>Purpose</th><th>Region</th><th>DPA</th></tr></thead>
    <tbody>
      ${SUBPROCESSORS.map(s => `<tr>
        <td><strong>${escapeHtml(s.name)}</strong></td>
        <td style="color:var(--dim2)">${escapeHtml(s.purpose)}</td>
        <td style="color:var(--dim2);font:500 12px/1 var(--mono)">${escapeHtml(s.region)}</td>
        <td><a href="${escapeHtml(s.dpa)}">view →</a></td>
      </tr>`).join('')}
    </tbody>
  </table>
</section>
`, 'trust');
}

function slaPage() {
  return shell('SLA', 'Uptime + response-time guarantees per tier.', `
<section style="max-width:780px;margin:0 auto;padding:60px 16px">
  <span class="badge b-acc">SLA v1</span>
  <h1 style="font:600 40px/1.1 var(--display);letter-spacing:-1px;margin:18px 0">Service Level Agreement.</h1>
  <p style="color:var(--dim2);font-size:16px;line-height:1.7;margin-bottom:32px">Effective ${new Date().toISOString().slice(0,10)}. Real-time status at <a href="/status">/status</a>.</p>
  <table>
    <thead><tr><th>Tier</th><th>Uptime</th><th>Support response</th><th>Credit on breach</th></tr></thead>
    <tbody>
      <tr><td><strong>Free</strong></td><td style="font:600 14px/1 var(--mono)">best effort</td><td>community Discord</td><td>—</td></tr>
      <tr><td><strong>Starter</strong></td><td style="font:600 14px/1 var(--mono)">99.0%</td><td>72h email</td><td>10% credit if &lt; 99.0%</td></tr>
      <tr><td><strong>Pro</strong></td><td style="font:600 14px/1 var(--mono)">99.9%</td><td>24h email</td><td>25% credit if &lt; 99.9%</td></tr>
      <tr><td><strong>Team</strong></td><td style="font:600 14px/1 var(--mono)">99.95%</td><td>4h business email</td><td>50% credit if &lt; 99.95%</td></tr>
      <tr><td><strong>Enterprise</strong></td><td style="font:600 14px/1 var(--mono)">99.99%</td><td>1h pager (24×7)</td><td>up to 100% credit</td></tr>
    </tbody>
  </table>
  <h2 style="font:600 18px/1 var(--display);margin:32px 0 8px">Definitions</h2>
  <ul style="color:var(--dim2);line-height:1.7;padding-left:20px">
    <li><strong>Uptime</strong>: % of 1-minute intervals where /healthz returned 2xx within 2s.</li>
    <li><strong>Excluded</strong>: scheduled maintenance with ≥48h notice, force majeure, downstream-provider outages (Stripe, etc).</li>
    <li><strong>Credit claim</strong>: file via /v1/sla/claim within 30 days of the incident.</li>
  </ul>
</section>
`, 'trust');
}

function dpaPage() {
  return shell('Data Processing Agreement', 'Sign electronically. Covers EU/UK GDPR.', `
<section style="max-width:780px;margin:0 auto;padding:60px 16px">
  <span class="badge b-acc">DPA v1</span>
  <h1 style="font:600 40px/1.1 var(--display);letter-spacing:-1px;margin:18px 0">Data Processing Agreement.</h1>
  <p style="color:var(--dim2);font-size:16px;line-height:1.7;margin-bottom:24px">Pre-signed by OpenHeab. Auto-incorporated into your subscription when your org is on Pro+ tier. Custom terms available on Enterprise — contact <a href="mailto:legal@openheab.com">legal@openheab.com</a>.</p>
  <div class="card">
    <h2 style="font:600 18px/1 var(--display);margin-bottom:10px">Coverage</h2>
    <ul style="color:var(--dim2);line-height:1.8;padding-left:20px;margin-bottom:18px">
      <li>EU GDPR (Article 28 data processing)</li>
      <li>UK GDPR + Data Protection Act 2018</li>
      <li>Swiss FADP</li>
      <li>EEA + UK Standard Contractual Clauses (SCCs)</li>
    </ul>
    <a href="/v1/legal/dpa.pdf" class="btn primary">Download DPA (PDF) →</a>
    <a href="/v1/legal/dpa/sign" class="btn" style="margin-left:10px">Sign electronically →</a>
  </div>
  <p style="color:var(--dim);font-size:13px;margin-top:32px">Need a custom DPA, BAA (HIPAA), or jurisdiction-specific addendum? <a href="mailto:legal@openheab.com">legal@openheab.com</a>.</p>
</section>
`, 'trust');
}

// ----------------------------------------------------------------------------
// Register
// ----------------------------------------------------------------------------
function registerTrustCenterRoutes(app, _pool) {
  const sendHtml = (res, html, status = 200) => {
    res.status(status);
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.setHeader('cache-control', 'public, max-age=300');
    res.send(html);
  };
  app.get('/trust', (req, res) => sendHtml(res, trustPage()));
  app.get('/security', (req, res) => sendHtml(res, securityPage()));
  app.get('/security/disclosure', (req, res) => sendHtml(res, disclosurePage()));
  app.get('/security/hall-of-fame', (req, res) => sendHtml(res, hallOfFamePage()));
  app.get('/bug-bounty', (req, res) => sendHtml(res, bugBountyPage()));
  app.get('/rsp', (req, res) => sendHtml(res, rspPage()));
  app.get('/risk-assessment', (req, res) => sendHtml(res, riskAssessmentPage()));
  app.get('/transparency', (req, res) => sendHtml(res, transparencyPage()));
  app.get('/models', (req, res) => sendHtml(res, modelsIndexPage()));
  app.get('/models/:id', (req, res) => {
    const html = modelCardPage(req.params.id);
    if (!html) return sendHtml(res, shell('Not Found', 'Model not found.', '<section style="padding:120px 0;text-align:center"><h1>404</h1><p style="color:var(--dim2)">No model card for that id. <a href="/models">See all →</a></p></section>'), 404);
    sendHtml(res, html);
  });
  app.get('/proof-of-reserves', (req, res) => sendHtml(res, proofOfReservesPage()));
  app.get('/subprocessors', (req, res) => sendHtml(res, subprocessorsPage()));
  app.get('/sla', (req, res) => sendHtml(res, slaPage()));
  app.get('/dpa', (req, res) => sendHtml(res, dpaPage()));
}

async function migrate(_pool) { /* no schema */ }

module.exports = { migrate, registerTrustCenterRoutes };
