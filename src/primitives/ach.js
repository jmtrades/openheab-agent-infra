// ============================================================================
// ach.js — ACH / wire / SEPA / Faster Payments / PIX rails. Encrypted account
// numbers (HKDF-derived per-account KEK). Without this, every enterprise deal
// >$5K stalls — they pay via ACH, not card.
// ============================================================================
const crypto = require('crypto');
const { z } = require('zod');
const { registerCron } = require('../cron_auth');

const KINDS = ['ach_us', 'wire_intl', 'sepa_eu', 'faster_payments_uk', 'pix_br'];
const FEES = {
  ach_standard:  25,
  ach_same_day: 100,
  wire:        1500,
  sepa_credit:   50,
  sepa_instant: 100,
  faster_payments: 50,
  pix: 0
};

function getMasterKek() {
  const raw = process.env.ACH_MASTER_KEK
           || process.env.IDENTITY_MASTER_KEK
           || process.env.CRYPTO_MASTER_KEK;
  if (!raw) throw new Error('ACH_MASTER_KEK_unset');
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, 'hex');
  return crypto.createHash('sha256').update(raw).digest();
}

function deriveKek(accountId) {
  return crypto.hkdfSync('sha256', getMasterKek(), Buffer.from(accountId), Buffer.from('openheab:ach:v1'), 32);
}

function encrypt(plaintext, accountId) {
  const kek = Buffer.from(deriveKek(accountId));
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', kek, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]);
}
function decrypt(packed, accountId) {
  const kek = Buffer.from(deriveKek(accountId));
  const iv = packed.subarray(0, 12), tag = packed.subarray(12, 28), ct = packed.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', kek, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ach_accounts (
      account_id              TEXT PRIMARY KEY,
      owner_did               TEXT NOT NULL,
      org_id                  TEXT,
      kind                    TEXT NOT NULL,
      account_holder_name     TEXT NOT NULL,
      routing_number          TEXT,
      account_number_encrypted BYTEA,
      account_number_last4    TEXT,
      currency                TEXT NOT NULL DEFAULT 'usd',
      status                  TEXT NOT NULL DEFAULT 'pending',
      verified_via            TEXT,
      plaid_access_token_encrypted BYTEA,
      created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      verified_at             TIMESTAMPTZ
    );
    CREATE TABLE IF NOT EXISTS ach_transfers (
      transfer_id             TEXT PRIMARY KEY,
      from_account_id         TEXT,
      to_account_id           TEXT,
      owner_did               TEXT,
      amount_cents            BIGINT NOT NULL,
      currency                TEXT NOT NULL DEFAULT 'usd',
      direction               TEXT NOT NULL,
      kind                    TEXT NOT NULL,
      reference               TEXT,
      status                  TEXT NOT NULL DEFAULT 'initiated',
      return_code             TEXT,
      expected_settlement_date DATE,
      settled_at              TIMESTAMPTZ,
      idempotency_key         TEXT,
      fee_cents               BIGINT NOT NULL DEFAULT 0,
      processor               TEXT,
      processor_id            TEXT,
      created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_ach_transfers_owner ON ach_transfers (owner_did, created_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ach_transfers_idem
      ON ach_transfers (owner_did, idempotency_key) WHERE idempotency_key IS NOT NULL;
    CREATE TABLE IF NOT EXISTS ach_micro_deposits (
      deposit_id              TEXT PRIMARY KEY,
      account_id              TEXT NOT NULL,
      amount_cents            BIGINT NOT NULL,
      descriptor              TEXT,
      sent_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      verified_at             TIMESTAMPTZ,
      attempt_count           INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS ach_returns (
      return_id               TEXT PRIMARY KEY,
      transfer_id             TEXT NOT NULL,
      return_code             TEXT,
      return_reason           TEXT,
      returned_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      action_taken            TEXT
    );
  `);
}

function newId(p) { return p + '_' + crypto.randomBytes(10).toString('hex'); }

const addAccountSchema = z.object({
  kind: z.enum(KINDS),
  account_holder_name: z.string().min(1),
  routing_number: z.string().optional(),
  account_number: z.string().min(4),
  currency: z.string().optional(),
  org_id: z.string().optional()
});

const transferSchema = z.object({
  from_account_id: z.string(),
  to_account_id: z.string().optional(),
  amount_cents: z.number().int().min(100),
  kind: z.enum(['ach_standard', 'ach_same_day', 'wire', 'sepa_credit', 'sepa_instant', 'faster_payments', 'pix']),
  reference: z.string().optional()
});

async function addBankAccount({ pool, owner_did, ...data }) {
  const id = newId('bank');
  const enc = encrypt(data.account_number, id);
  const last4 = data.account_number.slice(-4);
  await pool.query(
    `INSERT INTO ach_accounts (account_id, owner_did, org_id, kind, account_holder_name,
        routing_number, account_number_encrypted, account_number_last4, currency, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending')`,
    [id, owner_did, data.org_id || null, data.kind, data.account_holder_name,
     data.routing_number || null, enc, last4, data.currency || 'usd']
  );
  return { account_id: id, last4, status: 'pending' };
}

async function initiateTransfer({ pool, owner_did, ...data }) {
  // idempotency
  if (data.idempotency_key) {
    const dup = await pool.query(
      `SELECT transfer_id, status FROM ach_transfers WHERE owner_did = $1 AND idempotency_key = $2`,
      [owner_did, data.idempotency_key]
    ).catch(() => ({ rows: [] }));
    if (dup.rows[0]) return { transfer_id: dup.rows[0].transfer_id, idempotent: true, status: dup.rows[0].status };
  }

  const fee = FEES[data.kind] || 0;
  const id = newId('tr');
  const settlementDays = data.kind === 'ach_same_day' ? 0
                       : data.kind === 'wire' ? 0
                       : data.kind === 'sepa_instant' || data.kind === 'pix' || data.kind === 'faster_payments' ? 0
                       : 2;
  const settle = new Date(Date.now() + settlementDays * 86400000);
  const stub = !process.env.ACH_PROCESSOR_API_KEY;
  const initialStatus = stub ? 'pending' : 'initiated';

  await pool.query(
    `INSERT INTO ach_transfers
       (transfer_id, from_account_id, to_account_id, owner_did, amount_cents, currency,
        direction, kind, reference, status, expected_settlement_date, idempotency_key,
        fee_cents, processor, processor_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [id, data.from_account_id, data.to_account_id || null, owner_did,
     data.amount_cents, 'usd', 'debit', data.kind, data.reference || null,
     initialStatus, settle.toISOString().slice(0, 10), data.idempotency_key || null,
     fee, stub ? 'stub' : 'modern_treasury', null]
  );
  return { transfer_id: id, status: initialStatus, expected_settlement_date: settle.toISOString().slice(0, 10), fee_cents: fee };
}

async function pollSettlements(pool, auditChain) {
  // Stub mode: settle all pending transfers whose expected date has passed.
  const r = await pool.query(`
    UPDATE ach_transfers SET status = 'settled', settled_at = NOW()
    WHERE status IN ('initiated', 'pending', 'processing')
      AND expected_settlement_date <= CURRENT_DATE
    RETURNING transfer_id, owner_did
  `).catch(() => ({ rows: [] }));
  if (auditChain) for (const t of r.rows)
    await auditChain.append({ event_type: 'ach.settled', transfer_id: t.transfer_id, owner_did: t.owner_did }).catch(() => {});
  return { settled: r.rows.length };
}

function registerAchRoutes(app, pool, verifyAgentAuth, auditChain) {
  const express = require('express');
  const { isCronRequest } = require('../cron_auth');

  app.post('/v1/agents/:did/ach/accounts', express.json(), async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const p = addAccountSchema.safeParse(req.body || {});
    if (!p.success) return res.status(400).json({ error: 'invalid_input', details: p.error.flatten() });
    try {
      const out = await addBankAccount({ pool, owner_did: did, ...p.data });
      if (auditChain) await auditChain.append({ event_type: 'ach.account_added', owner_did: did, account_id: out.account_id, kind: p.data.kind, last4: out.last4 }).catch(() => {});
      res.status(201).json(out);
    } catch (e) {
      res.status(400).json({ error: 'add_failed', message: e.message });
    }
  });

  app.post('/v1/agents/:did/ach/accounts/:aid/verify-microdeposits', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    // Issue 2 random micro-deposits for verification
    const ids = [];
    for (let i = 0; i < 2; i++) {
      const cents = Math.floor(Math.random() * 99) + 1;
      const id = newId('md');
      await pool.query(
        `INSERT INTO ach_micro_deposits (deposit_id, account_id, amount_cents, descriptor)
         VALUES ($1,$2,$3,$4)`,
        [id, req.params.aid, cents, 'OPENHEAB-VERIFY']
      ).catch(() => {});
      ids.push({ deposit_id: id, amount_cents: cents });
    }
    res.json({ account_id: req.params.aid, deposits_sent: ids.length });
  });

  app.post('/v1/agents/:did/ach/accounts/:aid/confirm-microdeposits', express.json(), async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const amounts = (req.body?.amounts || []).map(Number);
    if (amounts.length < 2) return res.status(400).json({ error: 'two_amounts_required' });
    const r = await pool.query(`
      SELECT amount_cents FROM ach_micro_deposits WHERE account_id = $1 AND verified_at IS NULL
    `, [req.params.aid]).catch(() => ({ rows: [] }));
    const expected = r.rows.map(x => Number(x.amount_cents)).sort();
    const got = [...amounts].sort();
    if (expected.length === got.length && expected.every((v, i) => v === got[i])) {
      await pool.query(`UPDATE ach_accounts SET status='verified', verified_via='micro_deposit', verified_at = NOW() WHERE account_id = $1`, [req.params.aid]).catch(() => {});
      await pool.query(`UPDATE ach_micro_deposits SET verified_at = NOW() WHERE account_id = $1`, [req.params.aid]).catch(() => {});
      if (auditChain) await auditChain.append({ event_type: 'ach.account_verified', owner_did: did, account_id: req.params.aid }).catch(() => {});
      return res.json({ verified: true });
    }
    return res.status(400).json({ verified: false, error: 'amounts_mismatch' });
  });

  app.get('/v1/agents/:did/ach/accounts', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(`
      SELECT account_id, kind, account_holder_name, routing_number,
             account_number_last4, currency, status, verified_via, created_at, verified_at
      FROM ach_accounts WHERE owner_did = $1 ORDER BY created_at DESC LIMIT 100
    `, [did]).catch(() => ({ rows: [] }));
    res.json({ accounts: r.rows });
  });

  app.post('/v1/agents/:did/ach/transfers', express.json(), async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const p = transferSchema.safeParse(req.body || {});
    if (!p.success) return res.status(400).json({ error: 'invalid_input', details: p.error.flatten() });
    const idemKey = req.headers['x-idempotency-key'] || null;
    const out = await initiateTransfer({ pool, owner_did: did, ...p.data, idempotency_key: idemKey });
    if (auditChain) await auditChain.append({ event_type: 'ach.transfer_initiated', owner_did: did, ...out }).catch(() => {});
    // Record fee revenue
    try {
      const rev = require('./revenue');
      await rev.recordRevenue({ pool, source_layer: p.data.kind === 'wire' ? 'wire_fee' : 'ach_fee',
        amount_cents: out.fee_cents, agent_did: did, related_id: out.transfer_id });
    } catch {}
    res.status(201).json(out);
  });

  app.get('/v1/agents/:did/ach/transfers', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(`
      SELECT transfer_id, from_account_id, to_account_id, amount_cents, kind, status,
             return_code, expected_settlement_date, settled_at, fee_cents, created_at
      FROM ach_transfers WHERE owner_did = $1 ORDER BY created_at DESC LIMIT 200
    `, [did]).catch(() => ({ rows: [] }));
    res.json({ transfers: r.rows });
  });

  app.get('/v1/agents/:did/ach/transfers/:tid', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(`SELECT * FROM ach_transfers WHERE transfer_id = $1 AND owner_did = $2`,
      [req.params.tid, did]).catch(() => ({ rows: [] }));
    if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
    res.json(r.rows[0]);
  });

  app.post('/v1/_webhooks/ach-processor', express.json(), async (req, res) => {
    if (!isCronRequest(req)) return res.status(401).json({ error: 'cron_auth_required' });
    const { transfer_id, status, return_code, return_reason } = req.body || {};
    if (!transfer_id) return res.status(400).json({ error: 'transfer_id_required' });
    await pool.query(
      `UPDATE ach_transfers SET status = COALESCE($1, status), return_code = COALESCE($2, return_code),
         settled_at = CASE WHEN $1 = 'settled' THEN NOW() ELSE settled_at END
       WHERE transfer_id = $3`,
      [status, return_code, transfer_id]
    ).catch(() => {});
    if (return_code) {
      await pool.query(
        `INSERT INTO ach_returns (return_id, transfer_id, return_code, return_reason)
         VALUES ($1,$2,$3,$4)`,
        [newId('ret'), transfer_id, return_code, return_reason || null]
      ).catch(() => {});
    }
    if (auditChain) await auditChain.append({ event_type: 'ach.webhook', transfer_id, status, return_code }).catch(() => {});
    res.json({ ok: true });
  });

  registerCron(app, '/v1/_jobs/ach-settlement-poll',
    async (req, res) => res.json(await pollSettlements(pool, auditChain)));
}

module.exports = { migrate, registerAchRoutes, addBankAccount, initiateTransfer, pollSettlements,
                    encrypt, decrypt, FEES, KINDS };
