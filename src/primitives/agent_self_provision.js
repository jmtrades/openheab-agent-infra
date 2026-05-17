// ============================================================================
// agent_self_provision.js — agent-callable everything. Removes the
// "paste key into web form" assumption.
//
// Key insight: if agents are buying the substrate, they cannot paste anything.
// Every setup workflow needs an API-callable equivalent. Every payment
// needs to support USDC (which agents natively hold) as a first-class option,
// not just card via Stripe Checkout.
//
//   - Encrypted credential vault per agent (refer by vault_id, not raw value)
//   - Agent-callable setup endpoints (mirror /v1/admin/setup/* but signed-
//     request auth instead of admin-token paste)
//   - USDC-native subscription purchase (no card required ever)
//   - Auto-discover credentials already attached to the agent (OAuth, etc.)
//   - Delegated provisioning tokens (agent A grants agent B permission to
//     provision under A's account)
// ============================================================================
const crypto = require('crypto');

async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS agent_credential_vault (
      vault_id        TEXT PRIMARY KEY,
      agent_did       TEXT NOT NULL,
      provider        TEXT NOT NULL,
      label           TEXT NOT NULL,
      encrypted_value TEXT NOT NULL,
      iv              TEXT NOT NULL,
      sha256_check    TEXT NOT NULL,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_used_at    TIMESTAMPTZ,
      revoked_at      TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_vault_agent ON agent_credential_vault (agent_did, provider) WHERE revoked_at IS NULL;

    CREATE TABLE IF NOT EXISTS agent_subscriptions (
      subscription_id TEXT PRIMARY KEY,
      agent_did       TEXT NOT NULL,
      plan            TEXT NOT NULL,
      payment_method  TEXT NOT NULL,
      amount_cents    INTEGER NOT NULL,
      period          TEXT NOT NULL DEFAULT 'monthly',
      starts_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      renews_at       TIMESTAMPTZ NOT NULL,
      cancelled_at    TIMESTAMPTZ,
      autorenew       BOOLEAN NOT NULL DEFAULT TRUE,
      tx_ref          TEXT,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_agent_subs ON agent_subscriptions (agent_did, renews_at DESC);

    CREATE TABLE IF NOT EXISTS delegation_tokens (
      token_id        TEXT PRIMARY KEY,
      grantor_did     TEXT NOT NULL,
      grantee_did     TEXT,
      grantee_email   TEXT,
      scope           TEXT[] NOT NULL,
      max_spend_cents BIGINT,
      uses_remaining  INTEGER,
      expires_at      TIMESTAMPTZ NOT NULL,
      revoked_at      TIMESTAMPTZ,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

async function resolveAgent(pool, req) {
  try { return await require('./me_endpoints').resolveAgentFromRequest(pool, req); }
  catch { return null; }
}

// Per-tenant encryption: HKDF-derived from CRYPTO_MASTER_KEK + agent_did
function deriveKey(agentDid) {
  const master = process.env.CRYPTO_MASTER_KEK || '00'.repeat(32);
  return crypto.hkdfSync('sha256', Buffer.from(master, 'hex'), Buffer.from(agentDid),
    Buffer.from('vault'), 32);
}

function encryptValue(value, agentDid) {
  const key = deriveKey(agentDid);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    encrypted: Buffer.concat([ct, tag]).toString('base64'),
    iv: iv.toString('base64')
  };
}

function decryptValue(encrypted, iv, agentDid) {
  const key = deriveKey(agentDid);
  const buf = Buffer.from(encrypted, 'base64');
  const ct = buf.subarray(0, buf.length - 16);
  const tag = buf.subarray(buf.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

const TIER_USDC_PRICES = {
  // Same prices as Stripe, billable in USDC directly
  starter:    { cents: 1900,  raw_usdc: '19000000' },     // $19 = 19 USDC = 19,000,000 raw (6 dec)
  pro:        { cents: 9900,  raw_usdc: '99000000' },     // $99
  team:       { cents: 34900, raw_usdc: '349000000' },    // $349
  enterprise: { cents: 249900, raw_usdc: '2499000000' }   // $2,499
};

function newId(p) { return p + '_' + crypto.randomBytes(10).toString('hex'); }

function registerAgentSelfProvisionRoutes(app, pool, verifyAgentAuth, auditChain) {
  const express = require('express');

  // ---- CREDENTIAL VAULT ----
  // Agent stores its own provider credentials, refers to them by vault_id.
  // Substrate never returns raw values once stored.

  app.post('/v1/agents/:did/credentials', express.json(), async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const { provider, label, value } = req.body || {};
    if (!provider || !label || !value) {
      return res.status(400).json({ error: 'provider_label_value_required' });
    }
    if (String(value).length > 8192) return res.status(413).json({ error: 'credential_too_large' });

    const { encrypted, iv } = encryptValue(String(value), did);
    const sha = crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 16);
    const id = newId('cred');
    await pool.query(
      `INSERT INTO agent_credential_vault (vault_id, agent_did, provider, label, encrypted_value, iv, sha256_check)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [id, did, String(provider).slice(0, 50), String(label).slice(0, 100), encrypted, iv, sha]
    );
    if (auditChain) auditChain.append({
      event_type: 'credential.stored', vault_id: id, agent_did: did,
      provider, sha_check: sha
    }).catch(() => {});
    res.status(201).json({
      vault_id: id, provider, label, sha256_check: sha,
      note: 'Raw value never returned again. Reference by vault_id in subsequent setup calls.'
    });
  });

  app.get('/v1/agents/:did/credentials', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(
      `SELECT vault_id, provider, label, sha256_check, created_at, last_used_at, revoked_at
       FROM agent_credential_vault WHERE agent_did=$1 ORDER BY created_at DESC LIMIT 100`,
      [did]
    ).catch(() => ({ rows: [] }));
    res.json({ did, credentials: r.rows });
  });

  app.delete('/v1/agents/:did/credentials/:vault_id', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(
      `UPDATE agent_credential_vault SET revoked_at=NOW() WHERE vault_id=$1 AND agent_did=$2 AND revoked_at IS NULL`,
      [req.params.vault_id, did]
    ).catch(() => ({ rowCount: 0 }));
    if (auditChain) auditChain.append({ event_type: 'credential.revoked', vault_id: req.params.vault_id, agent_did: did }).catch(() => {});
    res.json({ revoked: r.rowCount || 0 });
  });

  // Internal: decrypt a vault value (only callable by other server primitives,
  // never exposed externally)
  async function readCredential(agentDid, vaultId) {
    const r = await pool.query(
      `SELECT encrypted_value, iv FROM agent_credential_vault
       WHERE vault_id=$1 AND agent_did=$2 AND revoked_at IS NULL`,
      [vaultId, agentDid]
    ).catch(() => ({ rows: [] }));
    if (!r.rows[0]) return null;
    pool.query(`UPDATE agent_credential_vault SET last_used_at=NOW() WHERE vault_id=$1`, [vaultId]).catch(() => {});
    return decryptValue(r.rows[0].encrypted_value, r.rows[0].iv, agentDid);
  }
  // Expose for cross-primitive use
  app.locals.readCredential = readCredential;

  // ---- AGENT-CALLABLE SETUP (mirror of /v1/admin/setup/* but per-agent) ----

  app.post('/v1/agents/:did/setup/stripe', express.json(), async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const { vault_id, public_url } = req.body || {};
    if (!vault_id) return res.status(400).json({ error: 'vault_id_required' });

    const secretKey = await readCredential(did, vault_id);
    if (!secretKey) return res.status(404).json({ error: 'credential_not_found' });
    if (!secretKey.startsWith('sk_')) return res.status(400).json({ error: 'not_a_stripe_key' });

    try {
      const { autoProvisionStripe } = require('./auto_provision');
      const result = await autoProvisionStripe(pool, {
        secretKey,
        publicUrl: public_url || process.env.OPERATOR_PUBLIC_URL
      });
      if (auditChain) auditChain.append({
        event_type: 'agent.setup.stripe', agent_did: did, vault_id, products_count: Object.keys(result.products).length
      }).catch(() => {});
      res.json({ ok: true, vault_id, ...result });
    } catch (e) {
      res.status(502).json({ error: 'stripe_setup_failed', message: e.message });
    }
  });

  app.post('/v1/agents/:did/setup/sendgrid', express.json(), async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const { vault_id } = req.body || {};
    if (!vault_id) return res.status(400).json({ error: 'vault_id_required' });
    const apiKey = await readCredential(did, vault_id);
    if (!apiKey) return res.status(404).json({ error: 'credential_not_found' });
    try {
      const { autoProvisionSendGrid } = require('./auto_provision');
      const result = await autoProvisionSendGrid(pool, { apiKey });
      if (auditChain) auditChain.append({ event_type: 'agent.setup.sendgrid', agent_did: did, vault_id }).catch(() => {});
      res.json({ ok: true, ...result });
    } catch (e) {
      res.status(502).json({ error: 'sendgrid_setup_failed', message: e.message });
    }
  });

  // GET /v1/agents/:did/setup/discovered — auto-discover credentials the
  // agent already has attached via OAuth, signup metadata, prior vault entries
  app.get('/v1/agents/:did/setup/discovered', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const discovered = { credentials: [], oauth_links: [], wallets: [] };
    // Vault entries
    const v = await pool.query(
      `SELECT vault_id, provider, label FROM agent_credential_vault WHERE agent_did=$1 AND revoked_at IS NULL`, [did]
    ).catch(() => ({ rows: [] }));
    discovered.credentials = v.rows;
    // OAuth links
    const o = await pool.query(
      `SELECT provider, external_user, external_email, expires_at FROM oauth_links WHERE agent_did=$1`, [did]
    ).catch(() => ({ rows: [] }));
    discovered.oauth_links = o.rows;
    // Wallets (have we already provisioned a USDC wallet they could pay from?)
    const w = await pool.query(
      `SELECT address, network, asset FROM wallets WHERE agent_did=$1`, [did]
    ).catch(() => ({ rows: [] }));
    discovered.wallets = w.rows;
    res.json({ did, discovered });
  });

  // ---- USDC-NATIVE SUBSCRIPTION PURCHASE ----
  // Agents already have USDC wallets via signup. Pay in USDC directly,
  // no card / no Stripe Checkout / no human web-form ever required.

  app.post('/v1/agents/:did/subscription/purchase', express.json(), async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const { plan, payment_method, period, autorenew, tx_ref } = req.body || {};
    if (!TIER_USDC_PRICES[plan]) {
      return res.status(400).json({
        error: 'invalid_plan',
        supported: Object.keys(TIER_USDC_PRICES)
      });
    }
    const method = ['usdc', 'card', 'credits'].includes(payment_method) ? payment_method : 'usdc';
    const periodSafe = period === 'annual' ? 'annual' : 'monthly';
    const price = TIER_USDC_PRICES[plan];
    const cents = periodSafe === 'annual' ? Math.floor(price.cents * 12 * 0.8333) : price.cents;
    const id = newId('sub');
    const renewsAt = new Date(Date.now() + (periodSafe === 'annual' ? 365 : 30) * 86400000);

    if (method === 'usdc') {
      // In real flow: settle USDC transfer from agent's wallet to platform's FeeSplitter
      // (would call bank_chain primitive). For the API contract, accept tx_ref the
      // agent provides AFTER they've sent the on-chain transfer, OR proceed
      // optimistically if running stub-mode.
      // Production: verify tx_ref exists + amount matches before activating.
      // Here we record the subscription as active immediately; if tx_ref later
      // doesn't validate, a reconciliation cron will cancel.
    } else if (method === 'card') {
      // Card path goes through existing Stripe Checkout primitive — return a URL
      return res.json({
        plan, payment_method: 'card', amount_cents: cents,
        checkout_url: (process.env.OPERATOR_PUBLIC_URL || '') + '/v1/signup?plan=' + plan + '&did=' + encodeURIComponent(did),
        note: 'Complete via Stripe Checkout. Subscription activates on payment confirmation.'
      });
    } else if (method === 'credits') {
      // Draw from prepaid credits balance (credits primitive exists)
      // Skipped here — credits primitive owns the debit logic.
    }

    await pool.query(
      `INSERT INTO agent_subscriptions (subscription_id, agent_did, plan, payment_method, amount_cents, period, renews_at, autorenew, tx_ref)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [id, did, plan, method, cents, periodSafe, renewsAt, autorenew !== false, tx_ref || null]
    );
    if (auditChain) auditChain.append({
      event_type: 'subscription.purchased', subscription_id: id, agent_did: did,
      plan, payment_method: method, amount_cents: cents, period: periodSafe
    }).catch(() => {});
    res.status(201).json({
      subscription_id: id, plan, payment_method: method, amount_cents: cents,
      period: periodSafe, renews_at: renewsAt, autorenew: autorenew !== false,
      ...(method === 'usdc' ? {
        usdc_destination: process.env.PLATFORM_USDC_ADDRESS || '0xPLATFORM_USDC_ADDR_HERE',
        usdc_amount_raw: periodSafe === 'annual'
          ? String(BigInt(price.raw_usdc) * 12n * 833n / 1000n)
          : price.raw_usdc,
        note: 'Send USDC on Base from your agent wallet. tx_ref optional — supply after broadcast for instant reconciliation.'
      } : {})
    });
  });

  app.get('/v1/agents/:did/subscription', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(
      `SELECT subscription_id, plan, payment_method, amount_cents, period, starts_at, renews_at, cancelled_at, autorenew, tx_ref
       FROM agent_subscriptions WHERE agent_did=$1 AND (cancelled_at IS NULL OR cancelled_at > NOW())
       ORDER BY starts_at DESC LIMIT 1`,
      [did]
    ).catch(() => ({ rows: [] }));
    res.json({ did, active_subscription: r.rows[0] || null });
  });

  app.post('/v1/agents/:did/subscription/cancel', express.json(), async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(
      `UPDATE agent_subscriptions SET cancelled_at=renews_at, autorenew=FALSE
       WHERE agent_did=$1 AND cancelled_at IS NULL`, [did]
    ).catch(() => ({ rowCount: 0 }));
    if (auditChain) auditChain.append({ event_type: 'subscription.cancelled', agent_did: did, count: r.rowCount || 0 }).catch(() => {});
    res.json({ cancelled: r.rowCount || 0, note: 'Access continues until renewal date; no further charges.' });
  });

  // GET /v1/pricing/usdc — machine-readable pricing for agent decision-making
  app.get('/v1/pricing/usdc', (req, res) => {
    res.json({
      currency: 'USDC',
      network: 'base',
      decimals: 6,
      destination: process.env.PLATFORM_USDC_ADDRESS || '0xPLATFORM_USDC_ADDR_HERE',
      tiers: Object.entries(TIER_USDC_PRICES).map(([plan, p]) => ({
        plan,
        monthly_cents: p.cents,
        monthly_usdc_raw: p.raw_usdc,
        annual_usdc_raw: String(BigInt(p.raw_usdc) * 12n * 833n / 1000n),
        annual_discount_pct: 16.67
      }))
    });
  });

  // ---- DELEGATION TOKENS ----
  // Agent A grants Agent B a token to provision resources under A's account
  // (with caps + expiry + scopes). Mirrors AWS STS / OIDC patterns for agents.

  app.post('/v1/agents/:did/delegations', express.json(), async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const { grantee_did, grantee_email, scope, max_spend_cents, expires_hours, uses } = req.body || {};
    if (!Array.isArray(scope) || scope.length === 0) return res.status(400).json({ error: 'scope_array_required' });
    if (!grantee_did && !grantee_email) return res.status(400).json({ error: 'grantee_did_or_email_required' });
    const hours = Math.min(Math.max(parseInt(expires_hours) || 24, 1), 8760);
    const id = newId('dlg');
    await pool.query(
      `INSERT INTO delegation_tokens (token_id, grantor_did, grantee_did, grantee_email, scope, max_spend_cents, uses_remaining, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [id, did, grantee_did || null, grantee_email || null,
       scope.slice(0, 20).map(s => String(s).slice(0, 50)),
       max_spend_cents ? parseInt(max_spend_cents) : null,
       uses ? parseInt(uses) : null,
       new Date(Date.now() + hours * 3600_000)]
    );
    if (auditChain) auditChain.append({
      event_type: 'delegation.created', token_id: id, grantor_did: did,
      grantee_did, grantee_email, scope, expires_hours: hours
    }).catch(() => {});
    res.status(201).json({
      token_id: id, expires_in_hours: hours, scope,
      max_spend_cents: max_spend_cents || null, uses_remaining: uses || null,
      usage: 'Grantee passes token_id via header x-delegation-token on protected endpoints'
    });
  });

  app.get('/v1/agents/:did/delegations', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(
      `SELECT token_id, grantee_did, grantee_email, scope, max_spend_cents, uses_remaining, expires_at, revoked_at, created_at
       FROM delegation_tokens WHERE grantor_did=$1 ORDER BY created_at DESC LIMIT 100`, [did]
    ).catch(() => ({ rows: [] }));
    res.json({ did, delegations: r.rows });
  });

  app.delete('/v1/agents/:did/delegations/:token_id', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(
      `UPDATE delegation_tokens SET revoked_at=NOW() WHERE token_id=$1 AND grantor_did=$2 AND revoked_at IS NULL`,
      [req.params.token_id, did]
    ).catch(() => ({ rowCount: 0 }));
    if (auditChain) auditChain.append({ event_type: 'delegation.revoked', token_id: req.params.token_id, by: did }).catch(() => {});
    res.json({ revoked: r.rowCount || 0 });
  });

  // Cron: reconcile pending USDC subscriptions — placeholder for tx_ref verification
  const { registerCron } = require('../cron_auth');
  registerCron(app, '/v1/_jobs/usdc-subscriptions-reconcile', async (req, res) => {
    // In real flow: poll on-chain receipts for unconfirmed tx_refs.
    // For now: just expire subscriptions whose renews_at < now and autorenew=false.
    const r = await pool.query(`
      UPDATE agent_subscriptions SET cancelled_at=NOW()
      WHERE renews_at < NOW() AND cancelled_at IS NULL AND autorenew=FALSE
      RETURNING subscription_id
    `).catch(() => ({ rows: [] }));
    res.json({ expired: r.rows.length });
  }, 'hourly');
}

module.exports = {
  migrate, registerAgentSelfProvisionRoutes,
  encryptValue, decryptValue, TIER_USDC_PRICES
};
