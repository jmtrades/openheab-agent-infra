// ============================================================================
// OpenHeab Payouts — A2H cash-out intents (Stripe Connect / Wise / USDC on-ramp)
// Tables: payout_accounts, payouts, payout_webhooks
// MIN_PAYOUT_CENTS=500. States: requested -> pending -> paid|failed|cancelled.
// ============================================================================
const cryptoLib = require('crypto');
const express = require('express');
const { z } = require('zod');

const PROVIDERS = ['stripe_connect', 'wise', 'usdc_onramp', 'manual'];
const PAYOUT_STATES = ['requested', 'pending', 'paid', 'failed', 'cancelled'];
const KYC_FORMS = ['W-9', 'W-8BEN', 'W-8BEN-E', 'none'];
const MIN_PAYOUT_CENTS = parseInt(process.env.MIN_PAYOUT_CENTS || '500');

// ----------------------------------------------------------------------------
// Migration
// ----------------------------------------------------------------------------
async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS payout_accounts (
      account_id            TEXT PRIMARY KEY,
      agent_did             TEXT NOT NULL,
      owner_human_id        TEXT,
      provider              TEXT NOT NULL,
      provider_account      TEXT,
      country               TEXT,
      currency              TEXT,
      label                 TEXT,
      kyc_form              TEXT NOT NULL DEFAULT 'none',
      kyc_form_received_at  TIMESTAMPTZ,
      verified              BOOLEAN NOT NULL DEFAULT FALSE,
      created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_payout_accounts_agent ON payout_accounts (agent_did);

    CREATE TABLE IF NOT EXISTS payouts (
      payout_id        TEXT PRIMARY KEY,
      agent_did        TEXT NOT NULL,
      account_id       TEXT NOT NULL,
      amount_cents     BIGINT NOT NULL,
      currency         TEXT NOT NULL DEFAULT 'USD',
      provider         TEXT NOT NULL,
      provider_ref     TEXT,
      status           TEXT NOT NULL DEFAULT 'requested',
      failure_reason   TEXT,
      idempotency_key  TEXT,
      requested_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      paid_at          TIMESTAMPTZ,
      UNIQUE (idempotency_key, agent_did)
    );
    CREATE INDEX IF NOT EXISTS idx_payouts_agent ON payouts (agent_did, requested_at DESC);
    CREATE INDEX IF NOT EXISTS idx_payouts_status ON payouts (status);

    CREATE TABLE IF NOT EXISTS payout_webhooks (
      webhook_id    TEXT PRIMARY KEY,
      provider      TEXT,
      payout_id     TEXT,
      raw_payload   JSONB,
      received_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_payout_webhooks_payout ON payout_webhooks (payout_id);
  `);
}

function genAccountId() { return 'pacct_' + cryptoLib.randomBytes(12).toString('hex'); }
function genPayoutId() { return 'pout_' + cryptoLib.randomBytes(12).toString('hex'); }
function genWebhookId() { return 'pwh_' + cryptoLib.randomBytes(12).toString('hex'); }

// ----------------------------------------------------------------------------
// Routes
// ----------------------------------------------------------------------------
function registerPayoutsRoutes(app, pool, verifyAgentAuth, auditChain) {

  // POST /v1/agents/:did/payout-accounts
  const AccountSchema = z.object({
    provider: z.enum(PROVIDERS),
    provider_account: z.string().optional(),
    owner_human_id: z.string().optional(),
    country: z.string().length(2).optional(),
    currency: z.string().length(3).optional().default('USD'),
    label: z.string().max(128).optional(),
    kyc_form: z.enum(KYC_FORMS).optional().default('none'),
    kyc_form_received_at: z.string().datetime().optional(),
    verified: z.boolean().optional().default(false)
  });

  app.post('/v1/agents/:did/payout-accounts', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const parse = AccountSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;

      const accountId = genAccountId();
      await pool.query(
        `INSERT INTO payout_accounts
         (account_id, agent_did, owner_human_id, provider, provider_account, country,
          currency, label, kyc_form, kyc_form_received_at, verified)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [accountId, did, d.owner_human_id || null, d.provider,
         d.provider_account || null, d.country || null,
         d.currency || 'USD', d.label || null,
         d.kyc_form || 'none', d.kyc_form_received_at || null, d.verified || false]
      );

      await auditChain.append({
        event_type: 'payouts.account_created',
        account_id: accountId, agent_did: did, provider: d.provider,
        timestamp: new Date().toISOString()
      });

      return res.status(201).json({
        account_id: accountId,
        agent_did: did,
        provider: d.provider,
        currency: d.currency || 'USD',
        kyc_form: d.kyc_form || 'none',
        verified: d.verified || false
      });
    } catch (e) {
      console.error('[payouts.account.create]', e);
      return res.status(500).json({ error: 'account_create_failed', message: e.message });
    }
  });

  // GET /v1/agents/:did/payout-accounts
  app.get('/v1/agents/:did/payout-accounts', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });

    const r = await pool.query(
      `SELECT account_id, agent_did, owner_human_id, provider, provider_account,
              country, currency, label, kyc_form, kyc_form_received_at,
              verified, created_at, updated_at
       FROM payout_accounts WHERE agent_did = $1 ORDER BY created_at DESC`,
      [did]
    ).catch(() => ({ rows: [] }));
    return res.json({ accounts: r.rows, count: r.rows.length });
  });

  // POST /v1/agents/:did/payouts — request payout
  const PayoutSchema = z.object({
    account_id: z.string().min(1),
    amount_cents: z.number().int().positive(),
    currency: z.string().length(3).optional().default('USD'),
    idempotency_key: z.string().optional()
  });

  app.post('/v1/agents/:did/payouts', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const parse = PayoutSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;

      if (d.amount_cents < MIN_PAYOUT_CENTS) {
        return res.status(400).json({
          error: 'amount_below_minimum',
          min_cents: MIN_PAYOUT_CENTS
        });
      }

      // Idempotency check
      const idemKey = d.idempotency_key || req.headers['x-idempotency-key'] || null;
      if (idemKey) {
        const exist = await pool.query(
          `SELECT payout_id, status, amount_cents, currency, provider, requested_at
           FROM payouts WHERE idempotency_key = $1 AND agent_did = $2`,
          [idemKey, did]
        ).catch(() => ({ rows: [] }));
        if (exist.rows[0]) return res.status(200).json({ ...exist.rows[0], idempotent_replay: true });
      }

      const acctR = await pool.query(
        `SELECT account_id, provider, currency, verified FROM payout_accounts
         WHERE account_id = $1 AND agent_did = $2`,
        [d.account_id, did]
      ).catch(() => ({ rows: [] }));
      if (!acctR.rows[0]) return res.status(404).json({ error: 'account_not_found' });
      const acct = acctR.rows[0];
      if (!acct.verified) return res.status(400).json({ error: 'account_not_verified' });

      const payoutId = genPayoutId();
      const currency = d.currency || acct.currency || 'USD';

      try {
        await pool.query(
          `INSERT INTO payouts
           (payout_id, agent_did, account_id, amount_cents, currency, provider,
            status, idempotency_key)
           VALUES ($1,$2,$3,$4,$5,$6,'requested',$7)`,
          [payoutId, did, d.account_id, d.amount_cents, currency, acct.provider, idemKey]
        );
      } catch (e) {
        if (e.code === '23505') return res.status(409).json({ error: 'duplicate_idempotency_key' });
        throw e;
      }

      await auditChain.append({
        event_type: 'payouts.requested',
        payout_id: payoutId, agent_did: did, account_id: d.account_id,
        amount_cents: d.amount_cents, currency, provider: acct.provider,
        timestamp: new Date().toISOString()
      });

      return res.status(201).json({
        payout_id: payoutId,
        agent_did: did,
        account_id: d.account_id,
        amount_cents: d.amount_cents,
        currency,
        provider: acct.provider,
        status: 'requested'
      });
    } catch (e) {
      console.error('[payouts.request]', e);
      return res.status(500).json({ error: 'payout_request_failed', message: e.message });
    }
  });

  // GET /v1/agents/:did/payouts
  app.get('/v1/agents/:did/payouts', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });

    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const status = req.query.status;
    const params = [did, limit];
    let where = `agent_did = $1`;
    if (status) { params.push(status); where += ` AND status = $${params.length}`; }

    const r = await pool.query(
      `SELECT * FROM payouts WHERE ${where} ORDER BY requested_at DESC LIMIT $2`,
      params
    ).catch(() => ({ rows: [] }));
    return res.json({ payouts: r.rows, count: r.rows.length });
  });

  // GET /v1/agents/:did/payouts/:payout_id
  app.get('/v1/agents/:did/payouts/:payout_id', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });

    const r = await pool.query(
      `SELECT * FROM payouts WHERE payout_id = $1 AND agent_did = $2`,
      [req.params.payout_id, did]
    ).catch(() => ({ rows: [] }));
    if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
    return res.json(r.rows[0]);
  });

  // POST /v1/_admin/payouts/:payout_id/mark — admin
  const MarkSchema = z.object({
    status: z.enum(PAYOUT_STATES),
    provider_ref: z.string().optional(),
    failure_reason: z.string().optional()
  });
  app.post('/v1/_admin/payouts/:payout_id/mark', express.json(), async (req, res) => {
    try {
      const token = req.headers['x-admin-token'];
      if (!token || !process.env.OPERATOR_ADMIN_TOKEN || token !== process.env.OPERATOR_ADMIN_TOKEN) {
        return res.status(401).json({ error: 'admin_token_required' });
      }
      const parse = MarkSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;

      const paidAt = d.status === 'paid' ? 'NOW()' : 'paid_at';
      const r = await pool.query(
        `UPDATE payouts SET
           status = $1,
           provider_ref = COALESCE($2, provider_ref),
           failure_reason = COALESCE($3, failure_reason),
           paid_at = CASE WHEN $1 = 'paid' THEN NOW() ELSE paid_at END
         WHERE payout_id = $4
         RETURNING payout_id, agent_did, status, amount_cents, provider, paid_at`,
        [d.status, d.provider_ref || null, d.failure_reason || null, req.params.payout_id]
      ).catch(() => ({ rows: [] }));
      if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });

      await auditChain.append({
        event_type: 'payouts.admin_marked',
        payout_id: req.params.payout_id,
        status: d.status, provider_ref: d.provider_ref || null,
        timestamp: new Date().toISOString()
      });

      return res.json(r.rows[0]);
    } catch (e) {
      console.error('[payouts.admin.mark]', e);
      return res.status(500).json({ error: 'mark_failed', message: e.message });
    }
  });

  // POST /v1/_webhooks/payout-provider — generic webhook
  app.post('/v1/_webhooks/payout-provider', express.json(), async (req, res) => {
    try {
      const body = req.body || {};
      const payoutId = body.payout_id || body.id || body.metadata?.payout_id;
      const status = body.status;
      const providerRef = body.provider_ref || body.transfer_id || body.id;
      const provider = body.provider || null;

      await pool.query(
        `INSERT INTO payout_webhooks (webhook_id, provider, payout_id, raw_payload)
         VALUES ($1,$2,$3,$4::jsonb)`,
        [genWebhookId(), provider, payoutId || null, JSON.stringify(body)]
      ).catch(() => {});

      if (payoutId && status && PAYOUT_STATES.includes(status)) {
        await pool.query(
          `UPDATE payouts SET
             status = $1,
             provider_ref = COALESCE($2, provider_ref),
             paid_at = CASE WHEN $1 = 'paid' THEN NOW() ELSE paid_at END
           WHERE payout_id = $3`,
          [status, providerRef || null, payoutId]
        ).catch(() => {});

        await auditChain.append({
          event_type: 'payouts.webhook_processed',
          payout_id: payoutId, status,
          provider, provider_ref: providerRef || null,
          timestamp: new Date().toISOString()
        });
      }

      return res.json({ received: true, payout_id: payoutId || null });
    } catch (e) {
      console.error('[payouts.webhook]', e);
      return res.status(500).json({ error: 'webhook_processing_failed', message: e.message });
    }
  });
}

module.exports = {
  migrate,
  registerPayoutsRoutes,
  MIN_PAYOUT_CENTS,
  PROVIDERS,
  PAYOUT_STATES,
  KYC_FORMS
};
