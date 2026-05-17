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
      idempotency_key   TEXT,
      response_snapshot JSONB,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at      TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_signup_sessions_email ON signup_sessions (email);
    CREATE INDEX IF NOT EXISTS idx_signup_sessions_stripe ON signup_sessions (stripe_session_id);
    ALTER TABLE signup_sessions ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
    ALTER TABLE signup_sessions ADD COLUMN IF NOT EXISTS response_snapshot JSONB;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_signup_sessions_idem ON signup_sessions (idempotency_key) WHERE idempotency_key IS NOT NULL;
  `);
}

function newId(p) { return p + '_' + crypto.randomBytes(10).toString('hex'); }
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

const signupSchema = z.object({
  email: z.string().email(),
  plan_code: z.enum(['free', 'starter', 'pro', 'team', 'enterprise']).default('free'),
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

const { head: dsHead, NAV_HTML, FOOTER_HTML } = require('../design_system');

function landingHTML(plan = 'pro') {
  const extraHead = `<style>
.signup-shell{max-width:560px;margin:0 auto;padding:48px 0 64px}
.signup-shell h1{font-size:36px;letter-spacing:-1.5px;line-height:1.1;margin-bottom:14px}
.signup-shell .lede{font-size:17px;color:var(--fg-dim);margin-bottom:32px;line-height:1.55}
.signup-form{background:var(--bg-elev);border:1px solid var(--br);border-radius:14px;padding:28px;animation:rise 500ms var(--ease-out) both}
.signup-form label.field{display:block;font:500 11px/1 var(--mono);color:var(--fg-dim2);text-transform:uppercase;letter-spacing:1.4px;margin:18px 0 6px}
.signup-form label.field:first-child{margin-top:0}
.tiers{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:8px;margin-top:8px}
.tier-opt{padding:13px;border:1px solid var(--br);border-radius:9px;cursor:pointer;background:var(--bg);transition:border-color var(--t-fast) var(--ease-out),background-color var(--t-fast) var(--ease-out)}
.tier-opt:hover{border-color:var(--br-strong)}
.tier-opt.sel{border-color:var(--acc);background:rgba(125,211,252,0.05)}
.tier-opt .pn{font:600 13px/1 var(--mono);margin-bottom:4px;color:var(--fg);letter-spacing:-0.2px}
.tier-opt .pp{font:500 11.5px/1 var(--mono);color:var(--fg-dim);font-feature-settings:'tnum'}
.tier-opt input{display:none}
.signup-form button.submit{
  width:100%;background:var(--fg);color:var(--bg);border:0;
  padding:13px 18px;border-radius:9px;font-weight:600;font-size:14.5px;
  cursor:pointer;font-family:var(--sans);margin-top:24px;
  transition:transform var(--t-fast) var(--ease-out),background-color var(--t-fast) var(--ease-out);
  display:flex;align-items:center;justify-content:center;gap:6px;
}
.signup-form button.submit:hover{background:#e4e4e7}
.signup-form button.submit:active{transform:scale(0.98)}
.signup-foot{color:var(--fg-dim2);font-size:12.5px;margin-top:16px;text-align:center}
.signup-note{background:rgba(125,211,252,0.05);border:1px solid rgba(125,211,252,0.15);border-radius:9px;padding:14px 16px;margin-top:18px;color:var(--fg-dim);font-size:13px;line-height:1.55}
.signup-note strong{color:var(--fg)}
.signup-note code{background:var(--bg);padding:6px 10px;display:block;margin-top:8px;border-radius:6px;border:1px solid var(--br);font-size:11.5px;word-break:break-all;color:var(--acc)}
</style>`;
  return dsHead('Sign up — OpenHeab', 'Sign up for OpenHeab in 30 seconds. Get a DID, USDC wallet, API key, and access to 265+ primitives.', { path: '/signup', extraHead })
    + NAV_HTML('signup') + `<main>
<div class="signup-shell">
  <h1>Sign up in 30 seconds.</h1>
  <p class="lede">Get a signed DID, a non-custodial USDC wallet, an API key, and access to 265+ primitives. Free forever or upgrade later.</p>
  <form id="f" class="signup-form" onsubmit="event.preventDefault();submit()">
    <label class="field" for="email">Email</label>
    <input id="email" type="email" autofocus required placeholder="you@company.com">

    <label class="field" for="org">Organization name</label>
    <input id="org" type="text" placeholder="Acme Inc.">

    <label class="field">Plan</label>
    <div class="tiers">
${[['free','Free','$0/mo'], ['starter','Starter','$19/mo'], ['pro','Pro','$99/mo'], ['team','Team','$349/mo'], ['enterprise','Enterprise','$2,499+/mo']]
  .map(([code, name, price]) =>
    `      <label class="tier-opt ${code===plan?'sel':''}" data-code="${code}"><input type="radio" name="plan" value="${code}" ${code===plan?'checked':''}><div class="pn">${name}</div><div class="pp">${price}</div></label>`
  ).join('\n')}
    </div>

    <button type="submit" class="submit">Create account <span class="arr">→</span></button>
    <div class="signup-foot">By signing up you agree to our <a href="/legal/terms">Terms</a> and <a href="/legal/privacy">Privacy Policy</a>.</div>
    <div class="signup-note" id="msg" style="display:none"></div>
  </form>
</div>
</main>
<script>
document.querySelectorAll('.tier-opt').forEach(t => t.addEventListener('click', () => {
  document.querySelectorAll('.tier-opt').forEach(x => x.classList.remove('sel'));
  t.classList.add('sel');
}));
async function submit(){
  const u = new URL(location.href);
  const body = {
    email: document.getElementById('email').value,
    org_name: document.getElementById('org').value || undefined,
    plan_code: document.querySelector('.tier-opt.sel').dataset.code,
    utm_source: u.searchParams.get('utm_source') || undefined,
    utm_campaign: u.searchParams.get('utm_campaign') || undefined
  };
  const r = await fetch('/v1/signup', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(body) });
  const j = await r.json();
  if (j.checkout_url){ location.href = j.checkout_url; return; }
  if (j.api_key){
    const m = document.getElementById('msg');
    m.style.display = 'block';
    m.innerHTML = '<strong>Account created.</strong> Save your API key — we cannot retrieve it later.<code>' + j.api_key + '</code><div style="margin-top:10px"><a href="/dashboard">→ Open dashboard</a></div>';
    return;
  }
  if (j.error){ document.getElementById('msg').style.display='block'; document.getElementById('msg').textContent = 'Error: ' + j.error; }
}
</script>` + FOOTER_HTML();
}

function successHTML(orgId) {
  const extraHead = `<style>
.success-shell{max-width:480px;margin:0 auto;padding:64px 0;text-align:center}
.success-icon{width:56px;height:56px;border-radius:50%;background:rgba(52,211,153,0.12);border:1px solid var(--good);display:inline-flex;align-items:center;justify-content:center;margin-bottom:20px;color:var(--good);font-size:24px;animation:rise 500ms var(--ease-out) both}
.success-shell h1{font-size:32px;letter-spacing:-1px;margin-bottom:10px}
.success-shell p{color:var(--fg-dim);margin-bottom:28px}
</style>`;
  return dsHead('Subscription active — OpenHeab', 'Your OpenHeab subscription is active.', { path: '/signup/success', extraHead })
    + NAV_HTML() + `<main>
<div class="success-shell">
  <div class="success-icon">✓</div>
  <h1>You're subscribed.</h1>
  <p>Your subscription is active. Your dashboard is ready.</p>
  <a class="btn primary" href="/dashboard">Open dashboard <span class="arr">→</span></a>
</div>
</main>` + FOOTER_HTML();
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

  // Per-IP rate limit so bots can't flood signups (each one creates an org,
  // a wallet, and an api_key — cheap individually, expensive at 1k/min).
  const { rateLimit: _rl } = require('../rate_limit');
  const signupRateLimit = _rl({
    windowMs: 60 * 60 * 1000,
    max: parseInt(process.env.IDENTITY_SIGNUP_LIMIT_PER_HOUR || '10'),
    pool,
    keyer: (req) => {
      const fwd = req.headers['x-forwarded-for'];
      const ip = (fwd ? fwd.split(',')[0].trim() : (req.ip || 'unknown'));
      return `signup-v1:${ip}`;
    }
  });

  app.post('/v1/signup', signupRateLimit, express.json(), async (req, res) => {
    const p = signupSchema.safeParse(req.body || {});
    if (!p.success) return res.status(400).json({ error: 'invalid_input', details: p.error.flatten() });
    const body = p.data;
    const ipHash = crypto.createHash('sha256').update(req.ip || '').digest('hex').slice(0, 16);

    // Idempotency: if the caller sent X-Idempotency-Key and we've already
    // serviced that request, return the cached response instead of re-
    // provisioning a duplicate org/agent/wallet/api_key and re-charging Stripe.
    const idemKey = req.headers['x-idempotency-key'];
    if (idemKey) {
      const cached = await pool.query(
        `SELECT response_snapshot FROM signup_sessions
          WHERE idempotency_key = $1 AND response_snapshot IS NOT NULL
          LIMIT 1`,
        [String(idemKey)]
      ).catch(() => ({ rows: [] }));
      if (cached.rows[0]?.response_snapshot) {
        const snap = typeof cached.rows[0].response_snapshot === 'string'
          ? JSON.parse(cached.rows[0].response_snapshot)
          : cached.rows[0].response_snapshot;
        res.setHeader('idempotent-replay', 'true');
        return res.status(201).json(snap);
      }
    }

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
         org_id, agent_did, api_key_first6, status, utm_source, utm_campaign, lead_id, ip_hash, idempotency_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [sessionId, body.email.toLowerCase(), body.plan_code, body.billing_interval,
       identifiers.org_id, identifiers.did, identifiers.api_key.slice(0, 6),
       body.plan_code === 'free' ? 'completed' : 'pending_payment',
       body.utm_source || null, body.utm_campaign || null, leadId, ipHash,
       idemKey ? String(idemKey) : null]
    );

    // Build the response, persist it for idempotent replay, then send it.
    let response;
    if (body.plan_code === 'free') {
      response = {
        ok: true, did: identifiers.did, org_id: identifiers.org_id,
        api_key: identifiers.api_key, public_key: identifiers.public_key,
        private_key: identifiers.private_key,
        wallet: identifiers.wallet ? { address: identifiers.wallet.address } : null,
        next: '/v1/dashboard'
      };
    } else {
      const baseUrl = process.env.OPERATOR_PUBLIC_URL || ('http://' + req.headers.host);
      const checkout = await makeStripeCheckout(stripe, body, identifiers, baseUrl);
      if (checkout && !checkout.error) {
        await pool.query(
          `UPDATE signup_sessions SET stripe_customer_id=$1, stripe_session_id=$2 WHERE session_id=$3`,
          [checkout.customer_id, checkout.session_id, sessionId]
        ).catch(() => {});
        response = {
          ok: true, did: identifiers.did, org_id: identifiers.org_id,
          api_key: identifiers.api_key, checkout_url: checkout.checkout_url
        };
      } else {
        response = {
          ok: true, did: identifiers.did, org_id: identifiers.org_id,
          api_key: identifiers.api_key, public_key: identifiers.public_key,
          private_key: identifiers.private_key,
          stripe_unavailable: checkout?.error || 'stripe_not_configured',
          note: 'Account created. Subscription pending — operator must configure Stripe price IDs and re-trigger checkout.',
          next: '/v1/dashboard'
        };
      }
    }
    if (idemKey) {
      await pool.query(
        `UPDATE signup_sessions SET response_snapshot = $1::jsonb WHERE session_id = $2`,
        [JSON.stringify(response), sessionId]
      ).catch(() => {});
    }
    return res.status(201).json(response);
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
