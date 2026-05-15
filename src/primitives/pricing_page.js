// ============================================================================
// pricing_page.js — polished /pricing page with the 4 subscription tiers,
// usage-based add-ons, FAQ, and direct checkout buttons that hit /v1/signup.
// The conversion gate for paying customers (vs the existing /signup which is
// API-only).
// ============================================================================

const TIERS = [
  {
    name: 'Free',
    price: '$0',
    period: '/month',
    tagline: 'For experimenting and learning.',
    cta: 'Start free',
    plan_id: 'free',
    highlight: false,
    features: [
      '1 agent · 1 wallet',
      '10K inference calls/mo (5% markup)',
      'Stub-mode KYC',
      'Read-only marketplace access',
      'Community support',
      'OpenHeab branding'
    ]
  },
  {
    name: 'Starter',
    price: '$19',
    period: '/month',
    tagline: 'For solo builders shipping their first agent.',
    cta: 'Start trial',
    plan_id: 'starter',
    highlight: false,
    features: [
      '5 agents · 5 wallets',
      '100K inference calls/mo (3% markup)',
      'Basic KYC tier (1)',
      'Marketplace publish',
      'Email support · 24h SLA',
      'Custom domain'
    ]
  },
  {
    name: 'Pro',
    price: '$99',
    period: '/month',
    tagline: 'For teams running agents in production.',
    cta: 'Start trial',
    plan_id: 'pro',
    highlight: true,
    features: [
      '50 agents · unlimited wallets',
      '1M inference calls/mo (2% markup)',
      'Full KYC stack · AML monitoring',
      'Webhooks · API keys · GDPR tools',
      'Priority support · 4h SLA',
      '99.9% uptime SLA · 10% credit'
    ]
  },
  {
    name: 'Team',
    price: '$349',
    period: '/month',
    tagline: 'For orgs with multiple seats and shared infra.',
    cta: 'Start trial',
    plan_id: 'team',
    highlight: false,
    features: [
      '500 agents · unlimited wallets',
      '10M inference calls/mo (1% markup)',
      'SSO · RBAC · audit log export',
      'Shared org workspace',
      'Slack support · 1h SLA',
      '99.95% uptime SLA · 25% credit'
    ]
  },
  {
    name: 'Enterprise',
    price: '$2,499',
    period: '/month',
    tagline: 'For regulated industries and high-volume operators.',
    cta: 'Contact sales',
    plan_id: 'enterprise',
    highlight: false,
    features: [
      'Unlimited agents · wallets · keys',
      'Custom inference pricing · BYO providers',
      'SOC 2 + HIPAA + ISO 27001 evidence',
      'Dedicated VPC · region pin · BYOK',
      'Dedicated CSM · 24/7 phone',
      '99.99% uptime SLA · 50% credit'
    ]
  }
];

const ADDONS = [
  { name: 'USDC wallet fees', detail: '1% of inbound/outbound (FeeSplitter on-chain)' },
  { name: 'Marketplace commissions', detail: '30% platform / 70% publisher (prompts, datasets, tools)' },
  { name: 'Card interchange', detail: '1.5% on virtual + physical debit card spend' },
  { name: 'Agent-to-Human payouts', detail: '0.5% per payout (ACH/SWIFT/SEPA)' },
  { name: 'Compute add-ons', detail: 'Modal GPU passthrough + 10%, E2B sandbox passthrough + 10%' },
  { name: 'KYC document checks', detail: '$2 per identity verification (passed through from Onfido/Persona)' }
];

const FAQ = [
  { q: 'Do I need a credit card to start?', a: 'No. The Free tier requires only an email. You can stay on Free indefinitely.' },
  { q: 'What happens if I exceed my inference quota?', a: 'Calls are routed at pay-as-you-go (provider cost + your tier markup). You can set a hard cap in your billing settings.' },
  { q: 'Can I bring my own provider API keys?', a: 'Yes, on Pro and above. Your keys are encrypted at rest with HKDF-derived per-tenant KEKs and never leave the substrate.' },
  { q: 'Is there a free trial of paid tiers?', a: 'Yes — every paid tier includes a 14-day trial with full feature access.' },
  { q: 'What about agents I sell on the marketplace?', a: 'Marketplace revenue is split 70/30 (you/us). Payouts go to your USDC wallet within 24h of sale, or via ACH/SEPA on request.' },
  { q: 'How does cancellation work?', a: 'Cancel anytime. You retain access through the end of your billing period and can export all data via /v1/legal/gdpr/export. No questions, no retention emails.' },
  { q: 'Can my agents resell my OpenHeab access?', a: 'Yes! Agents on Pro+ can issue scoped sub-keys to other agents, mark up usage, and earn from RLAF judgments.' }
];

function renderPricingPage() {
  return `<!doctype html><html><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>Pricing — OpenHeab</title>
<meta name="description" content="OpenHeab pricing: Free, Starter ($19), Pro ($99), Team ($349), Enterprise ($2,499). All tiers include real USDC wallets, KYC, MCP server, audit chain. Cancel anytime."/>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Inter', sans-serif; background: #0a0a0f; color: #e7e7ee; line-height: 1.6; }
.wrap { max-width: 1280px; margin: 0 auto; padding: 56px 24px; }
.nav { display: flex; justify-content: space-between; align-items: center; margin-bottom: 56px; }
.nav .logo { font-weight: 700; font-size: 18px; letter-spacing: -0.3px; }
.nav .nav-links a { color: #888; margin-left: 24px; font-size: 14px; text-decoration: none; }
.nav .nav-links a:hover { color: #fff; }
.hero { text-align: center; margin-bottom: 56px; }
h1 { font-size: 56px; font-weight: 700; letter-spacing: -2px; margin-bottom: 14px; background: linear-gradient(120deg, #fff 30%, #888 70%); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
.subtitle { color: #888; font-size: 18px; max-width: 600px; margin: 0 auto; }
.tier-grid { display: grid; grid-template-columns: repeat(5, 1fr); gap: 12px; margin: 48px 0 40px; }
@media (max-width: 1100px) { .tier-grid { grid-template-columns: repeat(2, 1fr); } }
@media (max-width: 600px)  { .tier-grid { grid-template-columns: 1fr; } }
.tier { background: #14141c; border: 1px solid #1f1f2a; border-radius: 14px; padding: 28px 22px; display: flex; flex-direction: column; transition: transform 0.15s, border-color 0.15s; }
.tier:hover { border-color: #2a2a3a; transform: translateY(-2px); }
.tier.highlight { border-color: #4f46e5; box-shadow: 0 0 40px rgba(79, 70, 229, 0.15); position: relative; }
.tier.highlight::before { content: 'MOST POPULAR'; position: absolute; top: -10px; left: 50%; transform: translateX(-50%); background: #4f46e5; color: #fff; font-size: 10px; font-weight: 600; letter-spacing: 1px; padding: 4px 10px; border-radius: 100px; }
.tier h2 { font-size: 18px; font-weight: 600; margin-bottom: 6px; }
.tier .tagline { color: #888; font-size: 13px; margin-bottom: 20px; min-height: 38px; }
.tier .price { font-size: 32px; font-weight: 700; letter-spacing: -1px; margin-bottom: 4px; }
.tier .price small { font-size: 14px; color: #888; font-weight: 400; }
.tier ul { list-style: none; margin: 20px 0; padding: 0; flex: 1; }
.tier li { padding: 6px 0; font-size: 13px; color: #c5c5d5; display: flex; gap: 8px; }
.tier li::before { content: '\\2713'; color: #22c55e; flex-shrink: 0; }
.tier .cta { display: block; text-align: center; padding: 12px; background: #4f46e5; color: #fff; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 14px; margin-top: auto; transition: all 0.15s; cursor: pointer; border: 0; }
.tier .cta:hover { background: #4338ca; }
.tier:not(.highlight) .cta { background: #1f1f2a; color: #e7e7ee; }
.tier:not(.highlight) .cta:hover { background: #2a2a3a; }
.section { margin: 80px 0; }
.section h2 { font-size: 32px; font-weight: 700; letter-spacing: -0.8px; margin-bottom: 32px; text-align: center; }
.addon-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 14px; }
.addon { background: #14141c; padding: 18px 22px; border-radius: 10px; border: 1px solid #1f1f2a; }
.addon h3 { font-size: 14px; font-weight: 600; margin-bottom: 6px; color: #fff; }
.addon p { font-size: 13px; color: #888; line-height: 1.5; }
.faq { max-width: 760px; margin: 0 auto; }
.faq-item { background: #14141c; border: 1px solid #1f1f2a; border-radius: 10px; margin-bottom: 8px; padding: 18px 24px; }
.faq-item summary { cursor: pointer; font-weight: 500; font-size: 15px; color: #fff; list-style: none; padding-right: 24px; position: relative; }
.faq-item summary::after { content: '+'; position: absolute; right: 0; top: 0; font-size: 22px; color: #4f46e5; }
.faq-item[open] summary::after { content: '\\2212'; }
.faq-item p { color: #aaa; font-size: 14px; margin-top: 12px; line-height: 1.7; }
.footer { color: #555; font-size: 13px; margin-top: 80px; padding-top: 32px; border-top: 1px solid #1a1a25; text-align: center; }
.footer a { color: #888; margin: 0 12px; }
</style></head><body>
<div class="wrap">

<nav class="nav">
  <a class="logo" href="/">OpenHeab</a>
  <div class="nav-links">
    <a href="/sdk">SDK</a>
    <a href="/demo">Demo</a>
    <a href="/docs">Docs</a>
    <a href="/pricing" style="color:#fff">Pricing</a>
    <a href="/signup" style="background:#4f46e5;color:#fff;padding:8px 16px;border-radius:6px">Sign up</a>
  </div>
</nav>

<section class="hero">
  <h1>Pricing for every agent.<br/>From hobbyist to fortune 500.</h1>
  <p class="subtitle">Pay for what you use. Cancel anytime. No retention emails, no contract minimums, no surprise overages — set a cap and we'll honor it.</p>
</section>

<section class="tier-grid">
${TIERS.map(t => `
  <div class="tier ${t.highlight ? 'highlight' : ''}">
    <h2>${t.name}</h2>
    <div class="tagline">${t.tagline}</div>
    <div class="price">${t.price}<small>${t.period}</small></div>
    <ul>${t.features.map(f => `<li>${f}</li>`).join('')}</ul>
    <button class="cta" onclick="signup('${t.plan_id}')">${t.cta}</button>
  </div>
`).join('')}
</section>

<section class="section">
  <h2>Usage-based add-ons</h2>
  <p style="text-align:center;color:#888;margin-bottom:32px;font-size:14px;max-width:600px;margin:0 auto 32px;">Only pay for these when you use them. They're shown on every invoice with full breakdown.</p>
  <div class="addon-grid">
${ADDONS.map(a => `<div class="addon"><h3>${a.name}</h3><p>${a.detail}</p></div>`).join('')}
  </div>
</section>

<section class="section">
  <h2>Questions</h2>
  <div class="faq">
${FAQ.map(f => `
    <details class="faq-item">
      <summary>${f.q}</summary>
      <p>${f.a}</p>
    </details>
`).join('')}
  </div>
</section>

<div class="footer">
  <a href="/legal/terms">Terms</a>
  <a href="/legal/privacy">Privacy</a>
  <a href="/legal/acceptable-use">Acceptable Use</a>
  <a href="/security">Security</a>
  <a href="/status">Status</a>
  <a href="https://github.com/jmtrades/openheab-agent-infra">GitHub</a>
</div>

</div>
<script>
async function signup(plan) {
  if (plan === 'enterprise') {
    window.location.href = 'mailto:sales@openheab.com?subject=Enterprise%20plan%20inquiry';
    return;
  }
  const email = prompt('Email address?');
  if (!email) return;
  try {
    const r = await fetch('/v1/signup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, plan })
    });
    const data = await r.json();
    if (data.checkout_url) window.location.href = data.checkout_url;
    else if (data.did) { alert('Account created! DID: ' + data.did); window.location.href = '/dashboard'; }
    else alert(JSON.stringify(data));
  } catch (e) { alert('Signup failed: ' + e.message); }
}
</script>
</body></html>`;
}

async function migrate(pool) {}

function registerPricingPageRoutes(app) {
  app.get('/pricing', (req, res) => {
    res.set('content-type', 'text/html; charset=utf-8');
    res.set('cache-control', 'public, max-age=3600');
    res.send(renderPricingPage());
  });

  // Machine-readable pricing for embedding into docs or comparison sites
  app.get('/pricing.json', (req, res) => {
    res.json({ tiers: TIERS, addons: ADDONS });
  });
}

module.exports = { migrate, registerPricingPageRoutes, TIERS, ADDONS };
