// ============================================================================
// signup.js — the real revenue-conversion path.
//
// /signup HTML page → POST /v1/signup creates identity + org + Stripe
// Customer + Stripe Checkout session for the chosen plan. Webhook handler
// activates the subscription on checkout.session.completed.
//
// Without this primitive, we cannot accept a single dollar from a stranger.
// THIS IS THE #1 GATE TO $10M MRR IN 90 DAYS.
// ============================================================================
const crypto = require('crypto');
const { z } = require('zod');

const PLAN_PRICE_ENV = {
  pro:        process.env.STRIPE_PRICE_PRO_MONTHLY,
  pro_annual: process.env.STRIPE_PRICE_PRO_ANNUAL,
  scale:      process.env.STRIPE_PRICE_SCALE_MONTHLY,
  scale_annual: process.env.STRIPE_PRICE_SCALE_ANNUAL,
  enterprise: process.env.STRIPE_PRICE_ENTERPRISE_MONTHLY,
  enterprise_annual: process.env.STRIPE_PRICE_ENTERPRISE_ANNUAL
};

async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS signup_sessions (
      session_id        TEXT PRIMARY KEY,
      email             TEXT NOT NULL,
      plan_code         TEXT NOT NULL DEFAULT 'free',
      billing_interval  TEXT NOT NULL DEFAULT 'monthly',
      org_id            TEXT,
      agent_did         TEXT,
      api_key_first6    TEXT,
      stripe_customer_id TEXT,
      stripe_session_id TEXT,
      status            TEXT NOT NULL DEFAULT 'started',
      utm_source        TEXT,
      utm_campaign      TEXT,
      lead_id           TEXT,
      ip_hash           TEXT,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at      TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_signup_sessions_email ON signup_sessions (email);
    CREATE INDEX IF NOT EXISTS idx_signup_sessions_stripe ON signup_sessions (stripe_session_id);
  `);
}

function newId(p) { return p + '_' + crypto.randomBytes(10).toString('hex'); }
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

const signupSchema = z.object({
  email: z.string().email(),
  plan_code: z.enum(['free', 'starter', 'pro', 'scale', 'team', 'enterprise']).default('free'),
  billing_interval: z.enum(['monthly', 'annual']).default('monthly'),
  org_name: z.string().min(1).optional(),
  agent_display_name: z.string().optional(),
  utm_source: z.string().optional(),
  utm_campaign: z.string().optional()
});

async function provisionEverything(pool, auditChain, body) {
  // 1. Create identity (Ed25519 + USDC wallet)
  const cryptoLib = require('crypto');
  const { publicKey, privateKey } = cryptoLib.generateKeyPairSync('ed25519');
  const pubPem = publicKey.export({ type: 'spki', format: 'pem' });
  const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const fingerprint = cryptoLib.createHash('sha256').update(pubPem).digest('hex').slice(0, 32);
  const did = `did:op:${fingerprint}`;

  await pool.query(
    `INSERT INTO identities (did, public_key, metadata) VALUES ($1, $2, $3::jsonb)
     ON CONFLICT (did) DO NOTHING`,
    [did, pubPem, JSON.stringify({ display_name: body.agent_display_name || body.email, signup_email: body.email })]
  );

  const apiKey = 'opk_' + cryptoLib.randomBytes(24).toString('hex');
  const tokenHash = cryptoLib.createHash('sha256').update(apiKey).digest('hex');
  await pool.query(`INSERT INTO api_keys (token_hash, agent_did) VALUES ($1, $2)`, [tokenHash, did]);

  // 2. Provision USDC wallet (idempotent, per bank_chain). Best-effort —
  // partial signups still return a usable DID + API key. Failures are
  // surfaced in the response under `warnings` so the caller can retry.
  let wallet = null;
  const warnings = [];
  try {
    const bc = require('./bank_chain');
    wallet = await bc.provisionWallet(pool, auditChain, did);
  } catch (e) {
    warnings.push({ component: 'wallet', error: e.message });
  }

  // 3. Create org
  const orgId = newId('org');
  const slug = (body.org_name || body.email.split('@')[0]).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60);
  await pool.query(
    `INSERT INTO orgs (org_id, name, slug, kind, billing_email, plan, owner_did, status)
     VALUES ($1, $2, $3, 'company', $4, $5, $6, 'active')
     ON CONFLICT (slug) DO NOTHING`,
    [orgId, body.org_name || body.email, slug + '-' + cryptoLib.randomBytes(3).toString('hex'),
     body.email, body.plan_code, did]
  ).catch(() => {});
  await pool.query(
    `INSERT INTO org_members (org_id, agent_did, role, joined_at)
     VALUES ($1, $2, 'owner', NOW())
     ON CONFLICT (org_id, agent_did) DO NOTHING`,
    [orgId, did]
  ).catch(() => {});

  // 4. Onboarding journey
  try {
    const ob = require('./onboarding');
    if (ob.markStepComplete) {
      await ob.markStepComplete({ pool, agent_did: did, step_code: 'create_identity', evidence_payload: { wallet_provisioned: !!wallet } });
    }
  } catch {}

  // 5. Audit
  if (auditChain) {
    await auditChain.append({
      event_type: 'signup.completed', email: body.email, did, org_id: orgId,
      plan_code: body.plan_code, utm_source: body.utm_source || null
    }).catch(() => {});
  }

  return { did, public_key: pubPem, private_key: privPem, api_key: apiKey, org_id: orgId, wallet, warnings };
}

async function makeStripeCheckout(stripe, body, identifiers, baseUrl) {
  if (!stripe || body.plan_code === 'free') return null;
  const priceKey = body.billing_interval === 'annual' ? `${body.plan_code}_annual` : body.plan_code;
  const priceId = PLAN_PRICE_ENV[priceKey];
  if (!priceId) return { error: `stripe_price_not_configured_for_${priceKey}` };

  const successUrl = `${baseUrl}/signup/success?session_id={CHECKOUT_SESSION_ID}`;
  const cancelUrl = `${baseUrl}/signup?cancelled=1`;

  try {
    const customer = await stripe.customers.create({
      email: body.email,
      metadata: { agent_did: identifiers.did, org_id: identifiers.org_id }
    });
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      customer: customer.id,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: successUrl,
      cancel_url: cancelUrl,
      client_reference_id: identifiers.org_id,
      subscription_data: {
        metadata: { agent_did: identifiers.did, org_id: identifiers.org_id, plan_code: body.plan_code }
      },
      allow_promotion_codes: true,
      billing_address_collection: 'auto'
    });
    return { customer_id: customer.id, session_id: session.id, checkout_url: session.url };
  } catch (e) {
    return { error: 'stripe_checkout_failed', message: e.message };
  }
}

function landingHTML(plan = 'pro') {
  const css = `
:root{--bg:#0a0a0a;--fg:#f0f0f0;--dim:#7a7a7a;--dim2:#bdbdbd;--acc:#7df9ff;--card:#0f0f0f;--br:#1a1a1a;--mono:ui-monospace,'SF Mono','JetBrains Mono',Menlo,Consolas,monospace;--sans:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,system-ui,sans-serif}
*{box-sizing:border-box;margin:0;padding:0}
body{font:15px/1.6 var(--sans);background:var(--bg);color:var(--fg)}
.wrap{max-width:560px;margin:0 auto;padding:64px 24px}
.brand{font:600 16px/1 var(--mono);letter-spacing:-0.5px;margin-bottom:48px;display:block;color:var(--fg);text-decoration:none}
.brand .dot{color:var(--acc);font-weight:900}
h1{font-size:36px;letter-spacing:-1.5px;margin-bottom:14px;line-height:1.1}
.lede{color:var(--dim2);font-size:17px;margin-bottom:36px;line-height:1.55}
form{background:var(--card);border:1px solid var(--br);border-radius:12px;padding:28px}
label{display:block;font:500 12px/1 var(--mono);color:var(--dim);text-transform:uppercase;letter-spacing:1.2px;margin-bottom:6px;margin-top:18px}
label:first-child{margin-top:0}
input,select{width:100%;background:#070707;color:var(--fg);border:1px solid var(--br);border-radius:7px;padding:12px 14px;font:500 14px/1 var(--mono);outline:none}
input:focus,select:focus{border-color:var(--acc)}
.tiers{display:grid;grid-template-columns:repeat(2,1fr);gap:8px;margin-top:12px}
.tier{padding:14px;border:1px solid var(--br);border-radius:8px;cursor:pointer;background:#070707}
.tier:hover{border-color:var(--dim)}
.tier.sel{border-color:var(--acc);background:rgba(125,249,255,0.04)}
.tier .pn{font:600 14px/1 var(--mono);margin-bottom:4px}
.tier .pp{font:400 12px/1 var(--mono);color:var(--dim)}
.tier input{display:none}
button{width:100%;background:var(--acc);color:#001a1f;border:0;padding:14px 18px;border-radius:8px;font-weight:700;font-size:15px;cursor:pointer;font-family:var(--sans);margin-top:24px;transition:all .15s}
button:hover{background:#a4fcff;transform:translateY(-1px)}
.foot{color:var(--dim);font-size:13px;margin-top:18px;text-align:center}
.foot a{color:var(--dim2)}
.note{background:rgba(125,249,255,0.06);border:1px solid rgba(125,249,255,0.2);border-radius:7px;padding:12px 14px;margin-top:18px;color:var(--dim2);font-size:13px;line-height:1.5}
`;
  return `<!doctype html><html lang=en><head><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1">
<title>Get started — OpenHeab</title>
<meta name=description content="Sign up for OpenHeab in 30 seconds. Get a DID, USDC wallet, API key, and access to 230+ primitives.">
<link rel=canonical href="${(process.env.OPERATOR_PUBLIC_URL || '')}/signup">
<link rel=icon href="/favicon.svg">
<style>${css}</style></head><body><div class=wrap>
<a href="/" class=brand>openheab<span class=dot>.</span></a>
<h1>Sign up in 30 seconds.</h1>
<p class=lede>Get a signed DID, a non-custodial USDC wallet, an API key, and access to 230+ primitives. Free forever or upgrade later.</p>
<form id=f onsubmit="event.preventDefault();submit()">
  <label>Email</label>
  <input id=email type=email autofocus required placeholder="you@company.com">

  <label>Organization name</label>
  <input id=org type=text placeholder="Acme Inc.">

  <label>Plan</label>
  <div class=tiers>
${[['free','Free','$0/mo'], ['starter','Starter','$19/mo'], ['pro','Pro','$99/mo'], ['team','Team','$349/mo'], ['enterprise','Enterprise','$2,499+/mo']]
  .map(([code, name, price]) =>
    `    <label class="tier ${code===plan?'sel':''}" data-code="${code}"><input type=radio name=plan value="${code}" ${code===plan?'checked':''}><div class=pn>${name}</div><div class=pp>${price}</div></label>`
  ).join('\n')}
  </div>

  <button type=submit>Create account →</button>
  <div class=foot>By signing up you agree to our <a href="/legal/terms">Terms</a> and <a href="/legal/privacy">Privacy Policy</a>.</div>
  <div class=note id=msg style="display:none"></div>
</form>
</div>
<script>
document.querySelectorAll('.tier').forEach(t => t.addEventListener('click', () => {
  document.querySelectorAll('.tier').forEach(x => x.classList.remove('sel'));
  t.classList.add('sel');
}));
async function submit() {
  const u = new URL(location.href);
  const body = {
    email: document.getElementById('email').value,
    org_name: document.getElementById('org').value || undefined,
    plan_code: document.querySelector('.tier.sel').dataset.code,
    utm_source: u.searchParams.get('utm_source') || undefined,
    utm_campaign: u.searchParams.get('utm_campaign') || undefined
  };
  const r = await fetch('/v1/signup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json();
  if (j.checkout_url) { location.href = j.checkout_url; return; }
  if (j.api_key) {
    const m = document.getElementById('msg');
    m.style.display = 'block';
    m.innerHTML = '<strong>Account created.</strong> Save your API key now (we cannot retrieve it later):<br><code style="display:block;margin-top:8px;font-size:11px;word-break:break-all">' + j.api_key + '</code><br><a href="/v1/dashboard?api_key=' + encodeURIComponent(j.api_key) + '">→ Open dashboard</a>';
    return;
  }
  if (j.error) { document.getElementById('msg').style.display='block'; document.getElementById('msg').textContent = 'Error: ' + j.error; }
}
</script></body></html>`;
}

function successHTML(orgId) {
  return `<!doctype html><html><head><meta charset=utf-8><title>Subscription active — OpenHeab</title>
<style>body{font-family:-apple-system,system-ui;background:#0a0a0a;color:#f0f0f0;padding:64px 24px;text-align:center}h1{color:#7df9ff;font-size:32px}a{color:#7df9ff}</style>
</head><body><h1>You&apos;re subscribed.</h1><p>Your subscription is active. <a href="/v1/dashboard">→ Open dashboard</a></p></body></html>`;
}

function registerSignupRoutes(app, pool, _verifyAgentAuth, auditChain, stripe) {
  const express = require('express');

  app.get('/signup', (req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.send(landingHTML(req.query.plan || 'pro'));
  });

  app.get('/signup/success', async (req, res) => {
    const sessionId = req.query.session_id;
    if (sessionId) {
      await pool.query(`UPDATE signup_sessions SET status='completed', completed_at=NOW() WHERE stripe_session_id=$1`, [sessionId]).catch(() => {});
    }
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.send(successHTML());
  });

  app.post('/v1/signup', express.json(), async (req, res) => {
    const p = signupSchema.safeParse(req.body || {});
    if (!p.success) return res.status(400).json({ error: 'invalid_input', details: p.error.flatten() });
    const body = p.data;
    const ipHash = crypto.createHash('sha256').update(req.ip || '').digest('hex').slice(0, 16);

    // Create lead in marketing
    let leadId = null;
    try {
      const m = await pool.query(`SELECT lead_id FROM marketing_leads WHERE email = $1 LIMIT 1`, [body.email.toLowerCase()]).catch(() => ({ rows: [] }));
      if (m.rows[0]) leadId = m.rows[0].lead_id;
      else {
        leadId = newId('lead');
        await pool.query(
          `INSERT INTO marketing_leads (lead_id, email, utm_source, utm_campaign, ip_hash, score, status)
           VALUES ($1, $2, $3, $4, $5, 50, 'new')`,
          [leadId, body.email.toLowerCase(), body.utm_source || null, body.utm_campaign || null, ipHash]
        ).catch(() => {});
      }
    } catch {}

    let identifiers, error;
    try { identifiers = await provisionEverything(pool, auditChain, body); }
    catch (e) { error = e.message; }
    if (error) return res.status(500).json({ error: 'provision_failed', message: error });

    const sessionId = newId('sgn');
    await pool.query(
      `INSERT INTO signup_sessions (session_id, email, plan_code, billing_interval,
         org_id, agent_did, api_key_first6, status, utm_source, utm_campaign, lead_id, ip_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [sessionId, body.email.toLowerCase(), body.plan_code, body.billing_interval,
       identifiers.org_id, identifiers.did, identifiers.api_key.slice(0, 6),
       body.plan_code === 'free' ? 'completed' : 'pending_payment',
       body.utm_source || null, body.utm_campaign || null, leadId, ipHash]
    );

    // Free plan? We're done.
    if (body.plan_code === 'free') {
      return res.status(201).json({
        ok: true, did: identifiers.did, org_id: identifiers.org_id,
        api_key: identifiers.api_key, public_key: identifiers.public_key,
        private_key: identifiers.private_key,
        wallet: identifiers.wallet ? { address: identifiers.wallet.address } : null,
        next: '/v1/dashboard'
      });
    }

    // Paid plan: Stripe Checkout
    const baseUrl = process.env.OPERATOR_PUBLIC_URL || ('http://' + req.headers.host);
    const checkout = await makeStripeCheckout(stripe, body, identifiers, baseUrl);
    if (checkout && !checkout.error) {
      await pool.query(
        `UPDATE signup_sessions SET stripe_customer_id=$1, stripe_session_id=$2 WHERE session_id=$3`,
        [checkout.customer_id, checkout.session_id, sessionId]
      ).catch(() => {});
      return res.status(201).json({
        ok: true, did: identifiers.did, org_id: identifiers.org_id,
        api_key: identifiers.api_key, checkout_url: checkout.checkout_url
      });
    }

    // Stripe not configured: still return the API key but warn
    return res.status(201).json({
      ok: true, did: identifiers.did, org_id: identifiers.org_id,
      api_key: identifiers.api_key, public_key: identifiers.public_key,
      private_key: identifiers.private_key,
      stripe_unavailable: checkout?.error || 'stripe_not_configured',
      note: 'Account created. Subscription pending — operator must configure Stripe price IDs and re-trigger checkout.',
      next: '/v1/dashboard'
    });
  });

  // Stripe webhook — activates subscription on checkout.session.completed
  app.post('/v1/_webhooks/stripe-checkout', express.raw({ type: 'application/json' }), async (req, res) => {
    if (!stripe) return res.status(200).json({ received: true, no_stripe: true });
    const sig = req.headers['stripe-signature'];
    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (e) {
      return res.status(400).json({ error: `webhook_signature_invalid: ${e.message}` });
    }

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const orgId = session.client_reference_id;
      const planCode = session.metadata?.plan_code || 'pro';

      // Activate subscription
      await pool.query(`UPDATE orgs SET plan = $1 WHERE org_id = $2`, [planCode, orgId]).catch(() => {});
      const subId = newId('sub');
      await pool.query(`
        INSERT INTO subscriptions (sub_id, org_id, plan_code, status, current_period_end,
            stripe_subscription_id, created_at)
        VALUES ($1, $2, $3, 'active', NOW() + INTERVAL '30 days', $4, NOW())
        ON CONFLICT DO NOTHING
      `, [subId, orgId, planCode, session.subscription || null]).catch(() => {});

      await pool.query(`UPDATE signup_sessions SET status='completed', completed_at=NOW() WHERE stripe_session_id=$1`,
        [session.id]).catch(() => {});

      // Track conversion + revenue
      try {
        const m = await pool.query(`SELECT lead_id FROM signup_sessions WHERE stripe_session_id=$1`, [session.id]).catch(() => ({ rows: [] }));
        if (m.rows[0]?.lead_id) {
          await pool.query(`UPDATE marketing_leads SET status='converted', converted_at=NOW(), converted_org_id=$1 WHERE lead_id=$2`,
            [orgId, m.rows[0].lead_id]).catch(() => {});
        }
        const rev = require('./revenue');
        await rev.recordRevenue({ pool, source_layer: 'subscriptions', amount_cents: session.amount_total || 0, org_id: orgId, related_id: subId });
      } catch {}

      if (auditChain) await auditChain.append({ event_type: 'subscription.activated', org_id: orgId, plan_code: planCode, stripe_session_id: session.id }).catch(() => {});
    }

    if (event.type === 'customer.subscription.deleted') {
      await pool.query(`UPDATE subscriptions SET status='cancelled' WHERE stripe_subscription_id=$1`,
        [event.data.object.id]).catch(() => {});
    }

    res.json({ received: true });
  });
}

module.exports = { migrate, registerSignupRoutes, provisionEverything, landingHTML };
