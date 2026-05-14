// ============================================================================
// bank.js — Legacy Stripe-backed fiat wallet (optional fallback)
//
// Tables: bank_accounts, bank_transactions, bank_holds, bank_policies, bank_kyc
// All amounts in integer cents. A2A transfers charge a 1% platform fee.
// Topups via Stripe Checkout. Payouts via Stripe.
// ============================================================================

const express = require('express');
const cryptoLib = require('crypto');
const { z } = require('zod');

const PLATFORM_DID = process.env.PLATFORM_DID || 'did:op:platform';
const A2A_FEE_BPS = parseInt(process.env.BANK_A2A_FEE_BPS || '100'); // 1%
const DEFAULT_CURRENCY = (process.env.BANK_DEFAULT_CURRENCY || 'usd').toLowerCase();

async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bank_accounts (
      agent_did          TEXT PRIMARY KEY,
      currency           TEXT NOT NULL DEFAULT 'usd',
      balance_cents      BIGINT NOT NULL DEFAULT 0,
      held_cents         BIGINT NOT NULL DEFAULT 0,
      lifetime_in_cents  BIGINT NOT NULL DEFAULT 0,
      lifetime_out_cents BIGINT NOT NULL DEFAULT 0,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS bank_transactions (
      txn_id             TEXT PRIMARY KEY,
      agent_did          TEXT NOT NULL,
      type               TEXT NOT NULL,
      amount_cents       BIGINT NOT NULL,
      currency           TEXT NOT NULL DEFAULT 'usd',
      counterparty_did   TEXT,
      counterparty_ext   TEXT,
      memo               TEXT,
      external_ref       TEXT,
      hold_id            TEXT,
      idempotency_key    TEXT,
      audit_chain_entry  TEXT,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_bank_txn_agent ON bank_transactions (agent_did, created_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_bank_txn_idem
      ON bank_transactions (agent_did, idempotency_key)
      WHERE idempotency_key IS NOT NULL;

    CREATE TABLE IF NOT EXISTS bank_holds (
      hold_id            TEXT PRIMARY KEY,
      agent_did          TEXT NOT NULL,
      amount_cents       BIGINT NOT NULL,
      currency           TEXT NOT NULL DEFAULT 'usd',
      counterparty_did   TEXT,
      memo               TEXT,
      status             TEXT NOT NULL DEFAULT 'active',
      expires_at         TIMESTAMPTZ,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      released_at        TIMESTAMPTZ,
      captured_at        TIMESTAMPTZ,
      capture_txn_id     TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_bank_holds_agent ON bank_holds (agent_did, status);

    CREATE TABLE IF NOT EXISTS bank_policies (
      agent_did               TEXT PRIMARY KEY,
      daily_topup_limit_cents BIGINT,
      daily_spend_limit_cents BIGINT,
      per_tx_limit_cents      BIGINT,
      allow_payout            BOOLEAN NOT NULL DEFAULT TRUE,
      whitelisted_dids        TEXT[],
      blacklisted_dids        TEXT[],
      paused                  BOOLEAN NOT NULL DEFAULT FALSE,
      updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS bank_kyc (
      agent_did       TEXT PRIMARY KEY,
      level           TEXT NOT NULL DEFAULT 'none',
      provider        TEXT,
      verified_at     TIMESTAMPTZ,
      expires_at      TIMESTAMPTZ,
      metadata        JSONB
    );
  `);
}

// ----- Internal helpers ------------------------------------------------------
async function ensureAccount(pool, did, currency = DEFAULT_CURRENCY) {
  await pool.query(
    `INSERT INTO bank_accounts (agent_did, currency)
     VALUES ($1, $2) ON CONFLICT (agent_did) DO NOTHING`,
    [did, currency]
  );
}

function newTxnId() {
  return 'btxn_' + cryptoLib.randomBytes(12).toString('hex');
}

function newHoldId() {
  return 'bhld_' + cryptoLib.randomBytes(10).toString('hex');
}

// ----- Webhook handler: top-up completed -------------------------------------
async function handleTopupCompleted(session, pool, auditChain) {
  const did = session?.metadata?.agent_did || session?.client_reference_id;
  const amountCents = session?.amount_total || 0;
  if (!did || !amountCents) return { ok: false, reason: 'missing_did_or_amount' };
  const currency = (session?.currency || DEFAULT_CURRENCY).toLowerCase();
  const externalRef = session?.id || null;

  // Idempotent: bail if already recorded
  const existing = await pool.query(
    `SELECT txn_id FROM bank_transactions WHERE external_ref = $1 AND type = 'topup'`,
    [externalRef]
  ).catch(() => ({ rows: [] }));
  if (existing.rows[0]) return { ok: true, idempotent: true, txn_id: existing.rows[0].txn_id };

  await ensureAccount(pool, did, currency);

  const audit = await auditChain.append({
    event_type: 'bank.topup.completed',
    agent_did: did, amount_cents: amountCents, currency, external_ref: externalRef,
    timestamp: new Date().toISOString()
  });

  const txnId = newTxnId();
  await pool.query(`
    INSERT INTO bank_transactions
      (txn_id, agent_did, type, amount_cents, currency, external_ref, audit_chain_entry, created_at)
    VALUES ($1,$2,'topup',$3,$4,$5,$6,NOW())
    ON CONFLICT (txn_id) DO NOTHING
  `, [txnId, did, amountCents, currency, externalRef, audit.hash]);

  await pool.query(`
    UPDATE bank_accounts
    SET balance_cents = balance_cents + $1,
        lifetime_in_cents = lifetime_in_cents + $1,
        updated_at = NOW()
    WHERE agent_did = $2
  `, [amountCents, did]);

  return { ok: true, txn_id: txnId, amount_cents: amountCents, currency };
}

// ----- Handlers (callable from other primitives) -----------------------------
async function handleBalance(pool, did) {
  await ensureAccount(pool, did);
  const r = await pool.query(
    `SELECT agent_did, currency, balance_cents, held_cents,
            lifetime_in_cents, lifetime_out_cents
       FROM bank_accounts WHERE agent_did = $1`,
    [did]
  );
  const row = r.rows[0];
  return {
    agent_did: row.agent_did,
    currency: row.currency,
    balance_cents: Number(row.balance_cents),
    available_cents: Number(row.balance_cents) - Number(row.held_cents),
    held_cents: Number(row.held_cents),
    lifetime_in_cents: Number(row.lifetime_in_cents),
    lifetime_out_cents: Number(row.lifetime_out_cents)
  };
}

async function handleTransfer(pool, auditChain, params) {
  const { from_did, to_did, amount_cents, memo, idempotency_key } = params;
  if (!from_did || !to_did || !amount_cents) throw new Error('missing_params');
  if (amount_cents <= 0) throw new Error('non_positive_amount');
  if (from_did === to_did) throw new Error('self_transfer_disallowed');

  if (idempotency_key) {
    const existing = await pool.query(
      `SELECT txn_id, amount_cents, counterparty_did
       FROM bank_transactions
       WHERE agent_did = $1 AND idempotency_key = $2`,
      [from_did, idempotency_key]
    ).catch(() => ({ rows: [] }));
    if (existing.rows[0]) {
      return {
        txn_id: existing.rows[0].txn_id,
        idempotent: true,
        amount_cents: Number(existing.rows[0].amount_cents)
      };
    }
  }

  await ensureAccount(pool, from_did);
  await ensureAccount(pool, to_did);
  await ensureAccount(pool, PLATFORM_DID);

  const feeCents = Math.floor(amount_cents * A2A_FEE_BPS / 10000);
  const netCents = amount_cents - feeCents;

  // Policy + balance check
  const policy = await pool.query(`SELECT * FROM bank_policies WHERE agent_did = $1`, [from_did]).catch(() => ({ rows: [] }));
  if (policy.rows[0]?.paused) throw new Error('account_paused');
  if (policy.rows[0]?.per_tx_limit_cents && amount_cents > Number(policy.rows[0].per_tx_limit_cents)) {
    throw new Error('per_tx_limit_exceeded');
  }
  if (policy.rows[0]?.blacklisted_dids?.includes(to_did)) {
    throw new Error('recipient_blacklisted');
  }

  const fromAcc = await pool.query(
    `SELECT balance_cents, held_cents FROM bank_accounts WHERE agent_did = $1 FOR UPDATE`,
    [from_did]
  ).catch(() => ({ rows: [] }));
  const available = Number(fromAcc.rows[0]?.balance_cents || 0) - Number(fromAcc.rows[0]?.held_cents || 0);
  if (available < amount_cents) throw new Error('insufficient_funds');

  const audit = await auditChain.append({
    event_type: 'bank.transfer',
    from_did, to_did,
    amount_cents, fee_cents: feeCents, net_cents: netCents,
    memo: memo || null,
    timestamp: new Date().toISOString()
  });

  const debitTxn = newTxnId();
  const creditTxn = newTxnId();
  const feeTxn = feeCents > 0 ? newTxnId() : null;

  await pool.query(`
    INSERT INTO bank_transactions
      (txn_id, agent_did, type, amount_cents, counterparty_did, memo,
       idempotency_key, audit_chain_entry, created_at)
    VALUES ($1,$2,'transfer_out',$3,$4,$5,$6,$7,NOW())
  `, [debitTxn, from_did, -amount_cents, to_did, memo || null, idempotency_key || null, audit.hash]);

  await pool.query(`
    INSERT INTO bank_transactions
      (txn_id, agent_did, type, amount_cents, counterparty_did, memo,
       audit_chain_entry, created_at)
    VALUES ($1,$2,'transfer_in',$3,$4,$5,$6,NOW())
  `, [creditTxn, to_did, netCents, from_did, memo || null, audit.hash]);

  if (feeTxn) {
    await pool.query(`
      INSERT INTO bank_transactions
        (txn_id, agent_did, type, amount_cents, counterparty_did, memo,
         audit_chain_entry, created_at)
      VALUES ($1,$2,'a2a_fee',$3,$4,$5,$6,NOW())
    `, [feeTxn, PLATFORM_DID, feeCents, from_did, 'a2a_fee', audit.hash]);
    await pool.query(`
      UPDATE bank_accounts SET
        balance_cents = balance_cents + $1,
        lifetime_in_cents = lifetime_in_cents + $1,
        updated_at = NOW()
      WHERE agent_did = $2`, [feeCents, PLATFORM_DID]);
  }

  await pool.query(`
    UPDATE bank_accounts SET
      balance_cents = balance_cents - $1,
      lifetime_out_cents = lifetime_out_cents + $1,
      updated_at = NOW()
    WHERE agent_did = $2`, [amount_cents, from_did]);

  await pool.query(`
    UPDATE bank_accounts SET
      balance_cents = balance_cents + $1,
      lifetime_in_cents = lifetime_in_cents + $1,
      updated_at = NOW()
    WHERE agent_did = $2`, [netCents, to_did]);

  return {
    txn_id: debitTxn,
    amount_cents, fee_cents: feeCents, net_cents: netCents,
    to_did, from_did, audit_hash: audit.hash
  };
}

async function handleHold(pool, auditChain, params) {
  const { agent_did, amount_cents, counterparty_did, memo, expires_in_seconds } = params;
  if (!agent_did || !amount_cents || amount_cents <= 0) throw new Error('invalid_hold_params');

  await ensureAccount(pool, agent_did);
  const acc = await pool.query(
    `SELECT balance_cents, held_cents FROM bank_accounts WHERE agent_did = $1 FOR UPDATE`,
    [agent_did]
  );
  const available = Number(acc.rows[0]?.balance_cents || 0) - Number(acc.rows[0]?.held_cents || 0);
  if (available < amount_cents) throw new Error('insufficient_available_funds');

  const holdId = newHoldId();
  const expiresAt = expires_in_seconds
    ? new Date(Date.now() + expires_in_seconds * 1000).toISOString()
    : null;

  await pool.query(`
    INSERT INTO bank_holds
      (hold_id, agent_did, amount_cents, counterparty_did, memo, expires_at)
    VALUES ($1,$2,$3,$4,$5,$6)
  `, [holdId, agent_did, amount_cents, counterparty_did || null, memo || null, expiresAt]);

  await pool.query(`
    UPDATE bank_accounts SET held_cents = held_cents + $1, updated_at = NOW()
    WHERE agent_did = $2`, [amount_cents, agent_did]);

  await auditChain.append({
    event_type: 'bank.hold.created',
    agent_did, hold_id: holdId, amount_cents,
    counterparty_did: counterparty_did || null,
    timestamp: new Date().toISOString()
  });

  return { hold_id: holdId, agent_did, amount_cents, expires_at: expiresAt };
}

async function handleHoldRelease(pool, auditChain, params) {
  const { hold_id, capture, agent_did } = params;
  const r = await pool.query(`SELECT * FROM bank_holds WHERE hold_id = $1`, [hold_id]);
  if (!r.rows[0]) throw new Error('hold_not_found');
  const hold = r.rows[0];
  if (agent_did && hold.agent_did !== agent_did) throw new Error('hold_did_mismatch');
  if (hold.status !== 'active') throw new Error('hold_not_active');

  if (capture) {
    if (!hold.counterparty_did) throw new Error('hold_has_no_counterparty');
    const tx = await handleTransfer(pool, auditChain, {
      from_did: hold.agent_did,
      to_did: hold.counterparty_did,
      amount_cents: Number(hold.amount_cents),
      memo: hold.memo
    });
    await pool.query(`
      UPDATE bank_accounts SET held_cents = held_cents - $1, updated_at = NOW()
      WHERE agent_did = $2`, [Number(hold.amount_cents), hold.agent_did]);
    await pool.query(`
      UPDATE bank_holds SET status = 'captured', captured_at = NOW(), capture_txn_id = $1
      WHERE hold_id = $2`, [tx.txn_id, hold_id]);
    await auditChain.append({
      event_type: 'bank.hold.captured', hold_id, txn_id: tx.txn_id,
      timestamp: new Date().toISOString()
    });
    return { captured: true, hold_id, txn_id: tx.txn_id };
  } else {
    await pool.query(`
      UPDATE bank_accounts SET held_cents = held_cents - $1, updated_at = NOW()
      WHERE agent_did = $2`, [Number(hold.amount_cents), hold.agent_did]);
    await pool.query(`
      UPDATE bank_holds SET status = 'released', released_at = NOW()
      WHERE hold_id = $1`, [hold_id]);
    await auditChain.append({
      event_type: 'bank.hold.released', hold_id, timestamp: new Date().toISOString()
    });
    return { released: true, hold_id };
  }
}

async function handlePayout(pool, auditChain, stripe, params) {
  const { agent_did, amount_cents, destination } = params;
  if (!agent_did || !amount_cents || amount_cents <= 0) throw new Error('invalid_payout_params');
  await ensureAccount(pool, agent_did);

  const acc = await pool.query(
    `SELECT balance_cents, held_cents, currency FROM bank_accounts WHERE agent_did = $1 FOR UPDATE`,
    [agent_did]
  );
  const available = Number(acc.rows[0]?.balance_cents || 0) - Number(acc.rows[0]?.held_cents || 0);
  if (available < amount_cents) throw new Error('insufficient_funds');

  let payoutRef = null;
  if (stripe && destination) {
    try {
      const transfer = await stripe.transfers.create({
        amount: amount_cents,
        currency: acc.rows[0].currency || DEFAULT_CURRENCY,
        destination
      });
      payoutRef = transfer.id;
    } catch (e) {
      throw new Error('stripe_payout_failed_' + e.message);
    }
  } else {
    payoutRef = 'stub_payout_' + cryptoLib.randomBytes(8).toString('hex');
  }

  const audit = await auditChain.append({
    event_type: 'bank.payout',
    agent_did, amount_cents, external_ref: payoutRef,
    timestamp: new Date().toISOString()
  });

  const txnId = newTxnId();
  await pool.query(`
    INSERT INTO bank_transactions
      (txn_id, agent_did, type, amount_cents, external_ref, audit_chain_entry, created_at)
    VALUES ($1,$2,'payout',$3,$4,$5,NOW())
  `, [txnId, agent_did, -amount_cents, payoutRef, audit.hash]);

  await pool.query(`
    UPDATE bank_accounts SET
      balance_cents = balance_cents - $1,
      lifetime_out_cents = lifetime_out_cents + $1,
      updated_at = NOW()
    WHERE agent_did = $2`, [amount_cents, agent_did]);

  return { txn_id: txnId, amount_cents, external_ref: payoutRef };
}

// ----- Routes ----------------------------------------------------------------
function registerBankRoutes(app, pool, verifyAgentAuth, auditChain, stripe) {
  const topupSchema = z.object({
    amount_cents: z.number().int().positive().max(1_000_00 * 1000),
    currency: z.string().length(3).optional(),
    success_url: z.string().url().optional(),
    cancel_url: z.string().url().optional()
  });
  const transferSchema = z.object({
    to_did: z.string().min(3),
    amount_cents: z.number().int().positive(),
    memo: z.string().max(500).optional()
  });
  const payoutSchema = z.object({
    amount_cents: z.number().int().positive(),
    destination: z.string().min(3).optional()
  });
  const holdSchema = z.object({
    amount_cents: z.number().int().positive(),
    counterparty_did: z.string().optional(),
    memo: z.string().max(500).optional(),
    expires_in_seconds: z.number().int().positive().max(60 * 60 * 24 * 30).optional()
  });
  const policySchema = z.object({
    daily_topup_limit_cents: z.number().int().nonnegative().optional(),
    daily_spend_limit_cents: z.number().int().nonnegative().optional(),
    per_tx_limit_cents: z.number().int().nonnegative().optional(),
    allow_payout: z.boolean().optional(),
    whitelisted_dids: z.array(z.string()).optional(),
    blacklisted_dids: z.array(z.string()).optional(),
    paused: z.boolean().optional()
  });

  app.get('/v1/agents/:did/bank/balance', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    try { return res.json(await handleBalance(pool, did)); }
    catch (e) { return res.status(500).json({ error: e.message }); }
  });

  app.post('/v1/agents/:did/bank/topup', express.json(), async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const parsed = topupSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: 'invalid_input', details: parsed.error.flatten() });

    await ensureAccount(pool, did, parsed.data.currency || DEFAULT_CURRENCY);
    if (!stripe) return res.status(503).json({ error: 'stripe_not_configured' });
    const opPublicUrl = process.env.OPERATOR_PUBLIC_URL || '';
    try {
      const session = await stripe.checkout.sessions.create({
        mode: 'payment',
        payment_method_types: ['card'],
        line_items: [{
          price_data: {
            currency: parsed.data.currency || DEFAULT_CURRENCY,
            product_data: { name: `Wallet top-up for ${did}` },
            unit_amount: parsed.data.amount_cents
          },
          quantity: 1
        }],
        client_reference_id: did,
        metadata: { agent_did: did, type: 'topup' },
        success_url: parsed.data.success_url || `${opPublicUrl}/bank/topup/success`,
        cancel_url: parsed.data.cancel_url || `${opPublicUrl}/bank/topup/cancel`
      });
      return res.status(201).json({
        checkout_url: session.url,
        session_id: session.id,
        amount_cents: parsed.data.amount_cents
      });
    } catch (e) {
      return res.status(500).json({ error: 'topup_failed', message: e.message });
    }
  });

  app.post('/v1/agents/:did/bank/transfer', express.json(), async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const parsed = transferSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: 'invalid_input', details: parsed.error.flatten() });
    const idemKey = req.headers['x-idempotency-key'] || null;
    try {
      const r = await handleTransfer(pool, auditChain, {
        from_did: did,
        to_did: parsed.data.to_did,
        amount_cents: parsed.data.amount_cents,
        memo: parsed.data.memo,
        idempotency_key: idemKey
      });
      return res.status(201).json(r);
    } catch (e) {
      const status = /insufficient|paused|blacklist|limit/.test(e.message) ? 400 : 500;
      return res.status(status).json({ error: e.message });
    }
  });

  app.post('/v1/agents/:did/bank/payout', express.json(), async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const parsed = payoutSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: 'invalid_input', details: parsed.error.flatten() });
    try {
      const r = await handlePayout(pool, auditChain, stripe, {
        agent_did: did,
        amount_cents: parsed.data.amount_cents,
        destination: parsed.data.destination
      });
      return res.status(201).json(r);
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  });

  app.get('/v1/agents/:did/bank/transactions', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const limit = Math.min(parseInt(req.query.limit) || 50, 500);
    const offset = Math.max(parseInt(req.query.offset) || 0, 0);
    const r = await pool.query(`
      SELECT txn_id, agent_did, type, amount_cents, currency,
             counterparty_did, counterparty_ext, memo, external_ref,
             hold_id, created_at
        FROM bank_transactions WHERE agent_did = $1
        ORDER BY created_at DESC LIMIT $2 OFFSET $3
    `, [did, limit, offset]).catch(() => ({ rows: [] }));
    const txs = r.rows.map(x => ({ ...x, amount_cents: Number(x.amount_cents) }));
    return res.json({ did, count: txs.length, transactions: txs });
  });

  app.get('/v1/agents/:did/bank/policy', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(`SELECT * FROM bank_policies WHERE agent_did = $1`, [did]).catch(() => ({ rows: [] }));
    return res.json(r.rows[0] || { agent_did: did, paused: false });
  });

  app.put('/v1/agents/:did/bank/policy', express.json(), async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const parsed = policySchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: 'invalid_input', details: parsed.error.flatten() });
    const d = parsed.data;
    await pool.query(`
      INSERT INTO bank_policies
        (agent_did, daily_topup_limit_cents, daily_spend_limit_cents,
         per_tx_limit_cents, allow_payout, whitelisted_dids, blacklisted_dids,
         paused, updated_at)
      VALUES ($1,$2,$3,$4,COALESCE($5,TRUE),$6,$7,COALESCE($8,FALSE),NOW())
      ON CONFLICT (agent_did) DO UPDATE SET
        daily_topup_limit_cents = COALESCE(EXCLUDED.daily_topup_limit_cents, bank_policies.daily_topup_limit_cents),
        daily_spend_limit_cents = COALESCE(EXCLUDED.daily_spend_limit_cents, bank_policies.daily_spend_limit_cents),
        per_tx_limit_cents = COALESCE(EXCLUDED.per_tx_limit_cents, bank_policies.per_tx_limit_cents),
        allow_payout = COALESCE(EXCLUDED.allow_payout, bank_policies.allow_payout),
        whitelisted_dids = COALESCE(EXCLUDED.whitelisted_dids, bank_policies.whitelisted_dids),
        blacklisted_dids = COALESCE(EXCLUDED.blacklisted_dids, bank_policies.blacklisted_dids),
        paused = COALESCE(EXCLUDED.paused, bank_policies.paused),
        updated_at = NOW()
    `, [
      did,
      d.daily_topup_limit_cents ?? null,
      d.daily_spend_limit_cents ?? null,
      d.per_tx_limit_cents ?? null,
      d.allow_payout ?? null,
      d.whitelisted_dids ?? null,
      d.blacklisted_dids ?? null,
      d.paused ?? null
    ]);
    await auditChain.append({
      event_type: 'bank.policy.updated', agent_did: did,
      timestamp: new Date().toISOString()
    });
    return res.json({ ok: true, agent_did: did });
  });

  app.post('/v1/agents/:did/bank/hold', express.json(), async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const parsed = holdSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: 'invalid_input', details: parsed.error.flatten() });
    try {
      const r = await handleHold(pool, auditChain, { agent_did: did, ...parsed.data });
      return res.status(201).json(r);
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
  });

  app.post('/v1/agents/:did/bank/hold/:holdId/release', express.json(), async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const capture = !!(req.body && req.body.capture);
    try {
      const r = await handleHoldRelease(pool, auditChain, {
        hold_id: req.params.holdId,
        agent_did: did,
        capture
      });
      return res.json(r);
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
  });
}

module.exports = {
  migrate,
  registerBankRoutes,
  handleTopupCompleted,
  handleBalance,
  handleTransfer,
  handleHold,
  handleHoldRelease,
  handlePayout,
  ensureAccount
};
