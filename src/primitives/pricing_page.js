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

const { head, NAV_HTML, FOOTER_HTML } = require('../design_system');

function renderPricingPage() {
  const extraHead = `<style>
.tier-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;margin:32px 0 40px}
.tier{background:var(--bg-elev);border:1px solid var(--br);border-radius:14px;padding:26px 22px;display:flex;flex-direction:column;transition:border-color var(--t-med) var(--ease-out),background-color var(--t-med) var(--ease-out),transform var(--t-med) var(--ease-out);position:relative;animation:rise 500ms var(--ease-out) both}
.tier:nth-child(1){animation-delay:0ms}.tier:nth-child(2){animation-delay:40ms}.tier:nth-child(3){animation-delay:80ms}.tier:nth-child(4){animation-delay:120ms}.tier:nth-child(5){animation-delay:160ms}
.tier:hover{border-color:var(--br-strong);background:var(--bg-elev2);transform:translateY(-1px)}
.tier.highlight{border-color:var(--acc-strong);box-shadow:0 0 28px rgba(125,211,252,0.08)}
.tier.highlight::before{content:'MOST POPULAR';position:absolute;top:-10px;left:50%;transform:translateX(-50%);background:var(--acc);color:var(--acc-text);font:600 9.5px/1 var(--mono);letter-spacing:1.4px;padding:5px 11px;border-radius:99px}
.tier h2{font-size:16px;font-weight:600;margin-bottom:6px;color:var(--fg);letter-spacing:-0.2px}
.tier .tagline{color:var(--fg-dim);font-size:12.5px;margin-bottom:18px;min-height:36px;line-height:1.5}
.tier .price-big{font:600 30px/1 var(--mono);letter-spacing:-1.2px;margin-bottom:4px;color:var(--fg);font-feature-settings:'tnum'}
.tier .price-big small{font-size:13px;color:var(--fg-dim2);font-weight:400;letter-spacing:0}
.tier ul.feat{list-style:none;margin:18px 0;padding:0;flex:1}
.tier ul.feat li{padding:5px 0;font-size:13px;color:var(--fg-dim);display:flex;gap:8px;line-height:1.5}
.tier ul.feat li::before{content:'\\2713';color:var(--good);flex-shrink:0;font-weight:700}
.tier .cta-btn{display:block;text-align:center;padding:11px;background:var(--bg-elev2);color:var(--fg);text-decoration:none;border-radius:8px;font-weight:600;font-size:13.5px;margin-top:auto;cursor:pointer;border:1px solid var(--br);transition:transform var(--t-fast) var(--ease-out),background-color var(--t-fast) var(--ease-out),border-color var(--t-fast) var(--ease-out)}
.tier .cta-btn:hover{background:var(--bg-elev);border-color:var(--br-strong)}
.tier .cta-btn:active{transform:scale(0.97)}
.tier.highlight .cta-btn{background:var(--fg);color:var(--bg);border-color:var(--fg)}
.tier.highlight .cta-btn:hover{background:#e4e4e7}
.addon-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px}
.addon{background:var(--bg-elev);padding:18px 22px;border-radius:10px;border:1px solid var(--br);transition:border-color var(--t-fast) var(--ease-out)}
.addon:hover{border-color:var(--br-strong)}
.addon h3{font-size:14px;font-weight:600;margin-bottom:6px;color:var(--fg)}
.addon p{font-size:13px;color:var(--fg-dim);line-height:1.5;margin:0}
.faq{max-width:760px}
.faq-item{background:var(--bg-elev);border:1px solid var(--br);border-radius:10px;margin-bottom:8px;padding:16px 22px;transition:border-color var(--t-fast) var(--ease-out)}
.faq-item:hover{border-color:var(--br-strong)}
.faq-item summary{cursor:pointer;font-weight:500;font-size:14.5px;color:var(--fg);list-style:none;padding-right:24px;position:relative}
.faq-item summary::-webkit-details-marker{display:none}
.faq-item summary::after{content:'+';position:absolute;right:0;top:-2px;font-size:20px;color:var(--acc);transition:transform var(--t-fast) var(--ease-out)}
.faq-item[open] summary::after{content:'\\2212'}
.faq-item p{color:var(--fg-dim);font-size:14px;margin-top:12px;line-height:1.7}
</style>`;
  return head('Pricing — OpenHeab',
    'OpenHeab pricing: Free, Starter $19, Pro $99, Team $349, Enterprise $2,499. All tiers include real USDC wallets, KYC, MCP server, audit chain. Cancel anytime.',
    { path: '/pricing', extraHead }) +
    NAV_HTML('pricing') + `<main>
<section class="hero">
  <span class="pill">simple · transparent</span>
  <h1>Pricing for every agent — hobbyist to Fortune 500.</h1>
  <p class="lede">Pay for what you use. Cancel anytime. No retention emails, no contract minimums, no surprise overages — set a cap and we'll honor it.</p>
</section>

<section class="section">
  <div class="tier-grid">
${TIERS.map(t => `    <div class="tier ${t.highlight ? 'highlight' : ''}">
      <h2>${t.name}</h2>
      <div class="tagline">${t.tagline}</div>
      <div class="price-big">${t.price}<small>${t.period || ''}</small></div>
      <ul class="feat">${t.features.map(f => `<li>${f}</li>`).join('')}</ul>
      <button class="cta-btn" onclick="signup('${t.plan_id}')">${t.cta}</button>
    </div>`).join('\n')}
  </div>
</section>

<section class="section">
  <p class="eyebrow">Usage-based add-ons</p>
  <h2>Only pay when you use them.</h2>
  <p class="sub">Shown on every invoice with full breakdown. Each one is metered to the unit, billed monthly.</p>
  <div class="addon-grid">
${ADDONS.map(a => `    <div class="addon"><h3>${a.name}</h3><p>${a.detail}</p></div>`).join('\n')}
  </div>
</section>

<section class="section">
  <p class="eyebrow">Frequently asked</p>
  <h2>Questions.</h2>
  <div class="faq">
${FAQ.map(f => `    <details class="faq-item"><summary>${f.q}</summary><p>${f.a}</p></details>`).join('\n')}
  </div>
</section>
</main>
<script>
async function signup(plan){
  if (plan === 'enterprise'){
    window.location.href = 'mailto:sales@openheab.com?subject=Enterprise%20plan%20inquiry';
    return;
  }
  const email = prompt('Email address?');
  if (!email) return;
  try{
    const r = await fetch('/v1/signup', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ email, plan }) });
    const data = await r.json();
    if (data.checkout_url) window.location.href = data.checkout_url;
    else if (data.did){ alert('Account created! DID: ' + data.did); window.location.href = '/dashboard'; }
    else alert(JSON.stringify(data));
  } catch (e){ alert('Signup failed: ' + e.message); }
}
</script>` + FOOTER_HTML();
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
