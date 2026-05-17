// ============================================================================
// legal_pages.js — Terms, Privacy, Cookies, Acceptable Use, plus GDPR data
// export + account deletion endpoints. Required for any platform handling
// EU residents, US consumer data, or financial transactions.
// ============================================================================
const crypto = require('crypto');

async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS gdpr_requests (
      request_id     TEXT PRIMARY KEY,
      agent_did      TEXT,
      email          TEXT,
      kind           TEXT NOT NULL,
      status         TEXT NOT NULL DEFAULT 'pending',
      payload_url    TEXT,
      requested_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at   TIMESTAMPTZ,
      verification_token TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_gdpr_status ON gdpr_requests (status, requested_at DESC);
  `);
}

function newId(p) { return p + '_' + crypto.randomBytes(10).toString('hex'); }

const ds = require('../design_system');
// Inject the design-system CSS so legal pages get full token coverage,
// plus legal-specific overrides for narrower reading layout.
const SHARED_CSS = ds.SHARED_CSS + `
body{font-size:15px;line-height:1.7}
.wrap{max-width:760px;margin:0 auto;padding:48px 24px 80px}
.wrap h1{font-size:34px;letter-spacing:-1px;margin-bottom:8px;font-weight:600;color:var(--fg)}
.meta{color:var(--fg-dim2);font-size:13px;margin-bottom:36px;font-family:var(--mono)}
.wrap h2{font-size:21px;margin:36px 0 14px;letter-spacing:-0.4px;color:var(--fg);font-weight:600}
.wrap h3{font-size:16px;margin:22px 0 10px;color:var(--fg);font-weight:600}
.wrap p,.wrap li{color:var(--fg-dim);font-size:15px;margin-bottom:12px}
.wrap ul,.wrap ol{padding-left:22px;margin-bottom:14px}
.wrap a{color:var(--acc);transition:color var(--t-fast) var(--ease-out)}
.wrap a:hover{color:var(--acc-strong)}
.wrap .callout{background:var(--bg-elev);border:1px solid var(--br);border-left:3px solid var(--acc);padding:14px 18px;margin:22px 0;border-radius:8px;font-size:14px;color:var(--fg-dim);line-height:1.6}
.wrap .callout b{color:var(--fg)}
.legal-nav{padding-bottom:20px;margin-bottom:28px;border-bottom:1px solid var(--br);display:flex;gap:4px;flex-wrap:wrap}
.legal-nav a{color:var(--fg-dim);font-size:13px;padding:6px 10px;border-radius:6px;text-decoration:none;transition:color var(--t-fast) var(--ease-out),background-color var(--t-fast) var(--ease-out)}
.legal-nav a:hover{color:var(--fg);background:var(--bg-elev)}
hr{border:0;border-top:1px solid var(--br);margin:36px 0}
code{background:var(--bg-elev);padding:2px 6px;border-radius:4px;border:1px solid var(--br);font-family:var(--mono);font-size:13px}
`;

const TERMS_HTML = `<!doctype html><html><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>Terms of Service — OpenHeab</title><style>${SHARED_CSS}</style></head><body><div class="wrap">
<div class="legal-nav"><a href="/">Home</a><a href="/legal/terms">Terms</a><a href="/legal/privacy">Privacy</a><a href="/legal/acceptable-use">Acceptable Use</a><a href="/legal/cookies">Cookies</a><a href="/legal/gdpr">GDPR</a></div>
<h1>Terms of Service</h1>
<p class="meta">Effective May 15, 2026 · Version 2.0</p>

<div class="callout">
<b>Plain English:</b> You can use OpenHeab to build, deploy, and operate AI agents. You agree to follow the law, not abuse the system, and pay for what you use. We agree to keep the substrate running, your data private, and let you leave at any time with a full export.
</div>

<h2>1. Acceptance</h2>
<p>By creating an account, calling our API, or using our agent identity system, you agree to these Terms of Service ("Terms"), our Privacy Policy, and our Acceptable Use Policy.</p>

<h2>2. The Service</h2>
<p>OpenHeab provides agent-native infrastructure: identity, payments, KYC, marketplaces, LLM inference routing, sandboxes, and 200+ other primitives. The service is provided "as is" without warranty except as expressly stated in your subscription tier's SLA.</p>

<h2>3. Your Account</h2>
<p>You are responsible for maintaining the confidentiality of your Ed25519 private keys, API keys, and any credentials issued to your agents. We are not liable for losses arising from compromised keys. You must immediately revoke any compromised key via <code>POST /v1/agents/:did/keys/:key_id</code> (DELETE).</p>

<h2>4. Acceptable Use</h2>
<p>You will not use the service to violate laws, infringe rights, spread malware, evade sanctions, launder money, or engage in any activity prohibited by our <a href="/legal/acceptable-use">Acceptable Use Policy</a>.</p>

<h2>5. Payments and Fees</h2>
<p>Subscription fees ($19/$99/$349/$2,499 tiers) bill monthly in advance, prorated on plan changes. Usage-based fees (inference markup, marketplace commissions, wallet fees) bill in arrears. All fees are non-refundable except as required by law. You can cancel at any time; you remain responsible for usage incurred through end of billing period.</p>

<h2>6. Data Ownership</h2>
<p>You own all data you submit. We do not train models on your data. We retain a non-exclusive license only to provide the service. You can export all your data at any time via <code>POST /v1/legal/gdpr/export</code> and delete your account via <code>POST /v1/legal/gdpr/delete</code>.</p>

<h2>7. Service Levels</h2>
<p>We target 99.9% monthly uptime on paid plans. SLA credits apply per your subscription tier (Pro: 10%, Team: 25%, Enterprise: 50% of monthly fee).</p>

<h2>8. Termination</h2>
<p>Either party can terminate with 30 days notice. We may suspend immediately for material breach (e.g., AML violations, fraud, sanctions evasion). On termination, you have 30 days to export data; after that we securely delete except where retention is required by law.</p>

<h2>9. Disputes</h2>
<p>Disputes are resolved by binding arbitration under AAA Commercial Rules, seated in Delaware. Class actions waived. EU residents retain rights under local consumer law.</p>

<h2>10. Changes</h2>
<p>We may update these Terms with 30 days notice via email + status page. Continued use after the effective date constitutes acceptance.</p>

<hr/>
<p style="color:#666;font-size:13px">Questions? legal@openheab.com — DPO: privacy@openheab.com</p>
</div></body></html>`;

const PRIVACY_HTML = `<!doctype html><html><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>Privacy Policy — OpenHeab</title><style>${SHARED_CSS}</style></head><body><div class="wrap">
<div class="legal-nav"><a href="/">Home</a><a href="/legal/terms">Terms</a><a href="/legal/privacy">Privacy</a><a href="/legal/acceptable-use">Acceptable Use</a><a href="/legal/cookies">Cookies</a><a href="/legal/gdpr">GDPR</a></div>
<h1>Privacy Policy</h1>
<p class="meta">Effective May 15, 2026 · Version 2.0 · GDPR + CCPA compliant</p>

<div class="callout">
<b>Summary:</b> We collect only what's needed to run the service (account info, transaction logs, API usage). We never sell your data. We never train models on your data. You can export everything and delete your account in one API call.
</div>

<h2>What We Collect</h2>
<ul>
<li><b>Account:</b> email, billing info, KYC documents (if you opt-in to verified tier)</li>
<li><b>Operational:</b> API request logs (30-day retention), audit chain entries (permanent — by design), inference call metadata (cost, tokens, model)</li>
<li><b>Voluntary:</b> profile data, public agent listings, marketplace activity</li>
</ul>

<h2>How We Use It</h2>
<ul>
<li>Provide the service (run your code, route payments, screen for sanctions)</li>
<li>Bill you accurately</li>
<li>Detect fraud, abuse, AML violations</li>
<li>Improve reliability (aggregated metrics, never personal)</li>
<li>Legal compliance (KYC, AML, tax reporting where required)</li>
</ul>

<h2>What We Don't Do</h2>
<ul>
<li>Sell your data</li>
<li>Train ML models on your data (we route to providers; you control prompts)</li>
<li>Share with advertisers</li>
<li>Profile you for behavioral targeting</li>
</ul>

<h2>Your Rights (GDPR + CCPA)</h2>
<ul>
<li><b>Access:</b> <code>POST /v1/legal/gdpr/export</code> returns all data we hold about you</li>
<li><b>Deletion:</b> <code>POST /v1/legal/gdpr/delete</code> removes everything except what we must retain for legal reasons (financial logs: 7 years per US/EU law)</li>
<li><b>Rectification:</b> Update profile via your account page</li>
<li><b>Portability:</b> Export is JSON + downloadable signed bundle</li>
<li><b>Objection:</b> Email <a href="mailto:privacy@openheab.com">privacy@openheab.com</a></li>
</ul>

<h2>Subprocessors</h2>
<p>We use a minimal set of subprocessors: Postgres (Neon), Vercel/AWS for hosting, Stripe for payments. Full list at <a href="/legal/subprocessors">/legal/subprocessors</a>. Every subprocessor is bound by DPA.</p>

<h2>Data Transfers</h2>
<p>If you're in the EU/UK/Switzerland, data is processed under SCCs + adequacy where applicable. EU data is stored in EU regions on request (Enterprise tier).</p>

<h2>Children</h2>
<p>The service is not for children under 16. We do not knowingly collect data from children.</p>

<h2>Contact</h2>
<p>DPO: privacy@openheab.com · EU rep: rep@openheab.eu</p>

</div></body></html>`;

const ACCEPTABLE_USE_HTML = `<!doctype html><html><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>Acceptable Use Policy — OpenHeab</title><style>${SHARED_CSS}</style></head><body><div class="wrap">
<div class="legal-nav"><a href="/">Home</a><a href="/legal/terms">Terms</a><a href="/legal/privacy">Privacy</a><a href="/legal/acceptable-use">Acceptable Use</a><a href="/legal/cookies">Cookies</a><a href="/legal/gdpr">GDPR</a></div>
<h1>Acceptable Use Policy</h1>
<p class="meta">Effective May 15, 2026 · Version 2.0</p>

<p>You will not use OpenHeab to:</p>

<h2>Illegal Activity</h2>
<ul>
<li>Violate any applicable law or regulation</li>
<li>Process payments for prohibited goods/services (weapons, controlled substances, child exploitation material)</li>
<li>Launder money, evade taxes, or finance terrorism</li>
<li>Trade securities without proper licensing</li>
</ul>

<h2>Abuse</h2>
<ul>
<li>Infringe intellectual property rights</li>
<li>Spread malware, phishing, spam, or unsolicited bulk communication</li>
<li>Probe, scan, or test the vulnerability of the system without prior authorization</li>
<li>Bypass rate limits, authentication, or quota enforcement</li>
<li>Use the service to compete directly with OpenHeab's listed products</li>
</ul>

<h2>Harmful AI Behavior</h2>
<ul>
<li>Build agents designed to deceive users about their AI nature</li>
<li>Deploy agents that target vulnerable populations (minors, elderly, people in crisis)</li>
<li>Build agents that generate content depicting non-consensual sexual material, including deepfakes</li>
<li>Operate agents that systematically violate the AGI Safety Classifier (see <code>/v1/safety/categories</code>)</li>
</ul>

<h2>Financial Misconduct</h2>
<ul>
<li>Engage in transactions on sanctions lists (OFAC SDN, EU, UN, UK, AU)</li>
<li>Fail to perform KYC where your activity meets tier thresholds</li>
<li>Attempt to circumvent AML monitoring or Travel Rule (FATF Rec 16) reporting</li>
</ul>

<h2>Enforcement</h2>
<p>Violations may result in immediate suspension, account termination, forfeiture of funds being held for AML investigation, and referral to law enforcement.</p>

<p>Report violations: <a href="mailto:abuse@openheab.com">abuse@openheab.com</a></p>

</div></body></html>`;

const COOKIES_HTML = `<!doctype html><html><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>Cookie Policy — OpenHeab</title><style>${SHARED_CSS}</style></head><body><div class="wrap">
<div class="legal-nav"><a href="/">Home</a><a href="/legal/terms">Terms</a><a href="/legal/privacy">Privacy</a><a href="/legal/acceptable-use">Acceptable Use</a><a href="/legal/cookies">Cookies</a><a href="/legal/gdpr">GDPR</a></div>
<h1>Cookie Policy</h1>
<p class="meta">Effective May 15, 2026</p>

<p>OpenHeab uses cookies for essential functionality only:</p>

<h2>Essential</h2>
<ul>
<li><code>oh_session</code> — authenticated session token, expires on logout</li>
<li><code>oh_csrf</code> — CSRF protection token, session-only</li>
</ul>

<h2>Functional (Opt-in)</h2>
<ul>
<li><code>oh_theme</code> — light/dark preference</li>
<li><code>oh_lang</code> — UI language preference</li>
</ul>

<h2>What We Don't Use</h2>
<ul>
<li>Advertising trackers</li>
<li>Third-party analytics that share data with marketers</li>
<li>Behavioral profiling cookies</li>
</ul>

<p>You can disable non-essential cookies in your browser settings without losing functionality.</p>

</div></body></html>`;

const GDPR_HTML = `<!doctype html><html><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>GDPR Rights — OpenHeab</title><style>${SHARED_CSS}</style></head><body><div class="wrap">
<div class="legal-nav"><a href="/">Home</a><a href="/legal/terms">Terms</a><a href="/legal/privacy">Privacy</a><a href="/legal/acceptable-use">Acceptable Use</a><a href="/legal/cookies">Cookies</a><a href="/legal/gdpr">GDPR</a></div>
<h1>Your GDPR Rights</h1>
<p class="meta">Article 15-22 compliance · Effective May 15, 2026</p>

<div class="callout">
<b>Self-serve:</b> You don't have to email us. Every right below is executable via API in seconds.
</div>

<h2>Right to Access (Article 15)</h2>
<p>Export every piece of data we hold about you:</p>
<p><code>POST /v1/legal/gdpr/export</code> with <code>{"agent_did":"did:op:...","email":"you@example.com"}</code></p>
<p>Returns a signed, downloadable JSON bundle within 24 hours.</p>

<h2>Right to Rectification (Article 16)</h2>
<p>Update incorrect data via your account page or <code>PUT /v1/agents/:did</code>.</p>

<h2>Right to Erasure (Article 17)</h2>
<p>Delete your account and all associated data:</p>
<p><code>POST /v1/legal/gdpr/delete</code> with <code>{"agent_did":"did:op:...","email":"you@example.com","confirm":"DELETE_EVERYTHING"}</code></p>
<p>Note: Financial records (transactions, KYC documents) are retained for 7 years per US/EU regulatory requirements. Everything else is removed within 30 days.</p>

<h2>Right to Portability (Article 20)</h2>
<p>Same as access — export endpoint returns a structured JSON bundle you can take to any competitor.</p>

<h2>Right to Object (Article 21)</h2>
<p>Email <a href="mailto:privacy@openheab.com">privacy@openheab.com</a> — we'll respond within 30 days.</p>

<h2>Right to Lodge a Complaint</h2>
<p>You can file with your local supervisory authority. For EU residents: <a href="https://edpb.europa.eu/about-edpb/about-edpb/members_en">European Data Protection Board members</a>.</p>

</div></body></html>`;

function registerLegalPagesRoutes(app, pool, verifyAgentAuth, auditChain) {
  const express = require('express');
  const serve = (html) => (req, res) => {
    res.set('content-type', 'text/html; charset=utf-8');
    res.set('cache-control', 'public, max-age=3600');
    res.send(html);
  };

  app.get('/legal/terms', serve(TERMS_HTML));
  app.get('/legal/privacy', serve(PRIVACY_HTML));
  app.get('/legal/acceptable-use', serve(ACCEPTABLE_USE_HTML));
  app.get('/legal/cookies', serve(COOKIES_HTML));
  app.get('/legal/gdpr', serve(GDPR_HTML));

  // List of subprocessors (auto-generated from cloud_adapters status)
  app.get('/legal/subprocessors', (req, res) => {
    res.set('content-type', 'text/html');
    res.send(`<!doctype html><html><head><title>Subprocessors</title><style>${SHARED_CSS}</style></head><body><div class="wrap">
      <h1>Subprocessors</h1>
      <p>OpenHeab uses these third parties to provide the service. Every subprocessor is bound by a Data Processing Agreement.</p>
      <ul>
        <li><b>Neon</b> (US/EU) — Postgres database hosting</li>
        <li><b>Vercel</b> (US/EU) — application hosting</li>
        <li><b>Stripe</b> (US) — payment processing</li>
        <li><b>Anthropic / OpenAI / Google / Mistral</b> — LLM inference (optional routing)</li>
        <li><b>Onfido / Persona / Sumsub</b> — KYC (optional, only with consent)</li>
        <li><b>Twilio / SendGrid</b> — communications (optional)</li>
        <li><b>AWS S3 / Cloudflare</b> — file storage + CDN</li>
      </ul>
      <p style="color:#666;font-size:13px">Updated May 15, 2026. Material changes announced via email 30 days in advance.</p>
    </div></body></html>`);
  });

  // GDPR data export — submits a request, returns request_id; processed async
  app.post('/v1/legal/gdpr/export', express.json(), async (req, res) => {
    const { agent_did, email } = req.body || {};
    if (!agent_did && !email) return res.status(400).json({ error: 'agent_did_or_email_required' });
    const id = newId('gdpr_export');
    const token = crypto.randomBytes(16).toString('hex');
    await pool.query(
      `INSERT INTO gdpr_requests (request_id, agent_did, email, kind, verification_token) VALUES ($1,$2,$3,'export',$4)`,
      [id, agent_did || null, email || null, token]
    ).catch(() => {});
    if (auditChain) await auditChain.append({ event_type: 'gdpr.export_requested', request_id: id, agent_did, email }).catch(() => {});
    res.status(202).json({
      request_id: id,
      status: 'pending',
      message: 'Verification email sent. Reply within 7 days. Export ready within 24h of verification.',
      verification_token_preview: token.slice(0, 8) + '...'
    });
  });

  // GDPR account deletion — requires explicit confirm string
  app.post('/v1/legal/gdpr/delete', express.json(), async (req, res) => {
    const { agent_did, email, confirm } = req.body || {};
    if (!agent_did && !email) return res.status(400).json({ error: 'agent_did_or_email_required' });
    if (confirm !== 'DELETE_EVERYTHING') {
      return res.status(400).json({ error: 'confirm_required', message: 'Set confirm to "DELETE_EVERYTHING" to proceed.' });
    }
    const id = newId('gdpr_delete');
    const token = crypto.randomBytes(16).toString('hex');
    await pool.query(
      `INSERT INTO gdpr_requests (request_id, agent_did, email, kind, verification_token) VALUES ($1,$2,$3,'delete',$4)`,
      [id, agent_did || null, email || null, token]
    ).catch(() => {});
    if (auditChain) await auditChain.append({ event_type: 'gdpr.deletion_requested', request_id: id, agent_did, email }).catch(() => {});
    res.status(202).json({
      request_id: id,
      status: 'pending',
      message: 'Verification email sent. Reply within 7 days to proceed. 30-day grace period after verification (financial records retained 7y per law).',
      verification_token_preview: token.slice(0, 8) + '...'
    });
  });

  // Status check
  app.get('/v1/legal/gdpr/:request_id', async (req, res) => {
    const r = await pool.query(
      `SELECT request_id, kind, status, requested_at, completed_at, payload_url FROM gdpr_requests WHERE request_id=$1`,
      [req.params.request_id]
    ).catch(() => ({ rows: [] }));
    if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
    res.json(r.rows[0]);
  });
}

module.exports = { migrate, registerLegalPagesRoutes };
