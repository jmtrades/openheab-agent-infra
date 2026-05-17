// ============================================================================
// card_core.js — IN-HOUSE card issuance. PAN generation (Luhn-valid), CVV,
// expiry, ISO 8583-style authorization flow, settlement, chargebacks.
// Replaces dependence on Stripe Issuing / Marqeta / Lithic.
//
// Honest disclosure: real card issuance requires a BIN sponsor bank +
// PCI-DSS Level 1 certification. This primitive ships the FULL on-our-side
// state machine. The BIN sponsor + PCI compliance are parallel work.
// We pre-issue PANs from our reserved BIN range (`OPENHEAB_BIN_RANGE`).
// ============================================================================
const crypto = require('crypto');
const { z } = require('zod');
const { registerCron } = require('../cron_auth');

const BIN_RANGE = process.env.OPENHEAB_BIN_RANGE || '477489';  // 6-digit BIN

async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS card_core_cards (
      card_id           TEXT PRIMARY KEY,
      owner_did         TEXT NOT NULL,
      pan_encrypted     BYTEA NOT NULL,
      pan_last4         TEXT NOT NULL,
      pan_first6        TEXT NOT NULL,
      cvv_hash          TEXT NOT NULL,
      exp_month         INTEGER NOT NULL,
      exp_year          INTEGER NOT NULL,
      kind              TEXT NOT NULL DEFAULT 'virtual',
      funding_account_id TEXT,
      monthly_limit_cents BIGINT,
      per_tx_limit_cents  BIGINT,
      spent_this_month_cents BIGINT NOT NULL DEFAULT 0,
      period_start      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      status            TEXT NOT NULL DEFAULT 'active',
      shipping_address  JSONB,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      cancelled_at      TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_card_core_cards_owner ON card_core_cards (owner_did, status);
    CREATE INDEX IF NOT EXISTS idx_card_core_cards_first6 ON card_core_cards (pan_first6);

    CREATE TABLE IF NOT EXISTS card_core_authorizations (
      auth_id           TEXT PRIMARY KEY,
      card_id           TEXT NOT NULL,
      stan              TEXT,
      merchant_name     TEXT,
      merchant_category TEXT,
      merchant_country  TEXT,
      amount_cents      BIGINT NOT NULL,
      currency          TEXT NOT NULL DEFAULT 'USD',
      result            TEXT NOT NULL,
      reason            TEXT,
      hold_cents        BIGINT,
      authorized_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      captured_at       TIMESTAMPTZ,
      reversed_at       TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_card_core_auth_card ON card_core_authorizations (card_id, authorized_at DESC);

    CREATE TABLE IF NOT EXISTS card_core_settlements (
      settlement_id     TEXT PRIMARY KEY,
      auth_id           TEXT NOT NULL,
      amount_cents      BIGINT NOT NULL,
      net_after_interchange_cents BIGINT,
      settled_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS card_core_chargebacks (
      chargeback_id     TEXT PRIMARY KEY,
      auth_id           TEXT NOT NULL,
      reason_code       TEXT NOT NULL,
      amount_cents      BIGINT NOT NULL,
      status            TEXT NOT NULL DEFAULT 'opened',
      filed_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      resolved_at       TIMESTAMPTZ
    );
  `);
}

function newId(p) { return p + '_' + crypto.randomBytes(10).toString('hex'); }

function getMasterKek() {
  const raw = process.env.CARD_CORE_MASTER_KEK || process.env.IDENTITY_MASTER_KEK || process.env.CRYPTO_MASTER_KEK;
  if (!raw) throw new Error('master_kek_unset');
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, 'hex');
  return crypto.createHash('sha256').update(raw).digest();
}
function encryptPan(pan) {
  const kek = getMasterKek();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', kek, iv);
  const ct = Buffer.concat([cipher.update(pan, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]);
}
function decryptPan(buf) {
  const kek = getMasterKek();
  const iv = buf.subarray(0, 12), tag = buf.subarray(12, 28), ct = buf.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', kek, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

// Luhn algorithm — generate a PAN with valid check digit
function generatePan() {
  const acctIdLen = 16 - BIN_RANGE.length - 1; // 16-digit card
  let acct = '';
  for (let i = 0; i < acctIdLen; i++) acct += Math.floor(Math.random() * 10);
  const partial = BIN_RANGE + acct;
  // Compute Luhn check digit
  let sum = 0;
  for (let i = 0; i < partial.length; i++) {
    let d = Number(partial[partial.length - 1 - i]);
    if (i % 2 === 0) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  const check = (10 - (sum % 10)) % 10;
  return partial + String(check);
}

function generateCvv() { return String(Math.floor(100 + Math.random() * 900)); }

const issueSchema = z.object({
  kind: z.enum(['virtual', 'physical']).optional(),
  monthly_limit_cents: z.number().int().min(100).max(100_000_000).optional(),
  per_tx_limit_cents: z.number().int().min(100).max(10_000_000).optional(),
  funding_account_id: z.string().optional(),
  shipping_address: z.object({
    line1: z.string(), line2: z.string().optional(), city: z.string(),
    state: z.string().optional(), postal_code: z.string(), country: z.string().length(2)
  }).optional()
});

const authSchema = z.object({
  pan_first6: z.string().regex(/^\d{6}$/).optional(),
  pan_last4: z.string().regex(/^\d{4}$/).optional(),
  card_id: z.string().optional(),
  amount_cents: z.number().int().min(1),
  currency: z.string().default('USD'),
  merchant_name: z.string(),
  merchant_category: z.string().optional(),
  merchant_country: z.string().optional(),
  stan: z.string().optional()
});

function registerCardCoreRoutes(app, pool, verifyAgentAuth, auditChain) {
  const express = require('express');

  // Issue a card
  app.post('/v1/agents/:did/card-core/cards', express.json(), async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const p = issueSchema.safeParse(req.body || {});
    if (!p.success) return res.status(400).json({ error: 'invalid_input', details: p.error.flatten() });
    if (p.data.kind === 'physical' && !p.data.shipping_address) {
      return res.status(400).json({ error: 'shipping_address_required_for_physical' });
    }
    const pan = generatePan();
    const cvv = generateCvv();
    const cvvHash = crypto.createHash('sha256').update(cvv + pan).digest('hex');
    const now = new Date();
    const expYear = now.getFullYear() + 4;
    const expMonth = now.getMonth() + 1;
    const id = newId('cc');
    let enc;
    try { enc = encryptPan(pan); }
    catch { return res.status(500).json({ error: 'kek_unavailable' }); }

    await pool.query(
      `INSERT INTO card_core_cards (card_id, owner_did, pan_encrypted, pan_last4, pan_first6,
         cvv_hash, exp_month, exp_year, kind, funding_account_id, monthly_limit_cents,
         per_tx_limit_cents, shipping_address)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [id, did, enc, pan.slice(-4), pan.slice(0, 6), cvvHash, expMonth, expYear,
       p.data.kind || 'virtual', p.data.funding_account_id || null,
       p.data.monthly_limit_cents || null, p.data.per_tx_limit_cents || null,
       p.data.shipping_address ? JSON.stringify(p.data.shipping_address) : null]
    );
    if (auditChain) await auditChain.append({ event_type: 'card_core.issued', card_id: id, owner_did: did, last4: pan.slice(-4) }).catch(() => {});

    // PAN + CVV returned ONCE; never retrievable again
    res.status(201).json({
      card_id: id, kind: p.data.kind || 'virtual',
      pan, cvv, exp_month: expMonth, exp_year: expYear,
      pan_last4: pan.slice(-4), brand: 'openheab',
      note: 'Save PAN + CVV now — never retrievable again.'
    });
  });

  app.get('/v1/agents/:did/card-core/cards', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(`
      SELECT card_id, pan_last4, pan_first6, exp_month, exp_year, kind, status,
             monthly_limit_cents, per_tx_limit_cents, spent_this_month_cents, created_at
      FROM card_core_cards WHERE owner_did=$1 ORDER BY created_at DESC
    `, [did]).catch(() => ({ rows: [] }));
    res.json({ cards: r.rows });
  });

  app.post('/v1/agents/:did/card-core/cards/:cid/freeze', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(`UPDATE card_core_cards SET status='frozen' WHERE card_id=$1 AND owner_did=$2 AND status='active' RETURNING card_id`,
      [req.params.cid, did]).catch(() => ({ rows: [] }));
    if (!r.rows[0]) return res.status(404).json({ error: 'not_active' });
    if (auditChain) await auditChain.append({ event_type: 'card_core.frozen', card_id: r.rows[0].card_id }).catch(() => {});
    res.json({ card_id: r.rows[0].card_id, status: 'frozen' });
  });

  // ISO 8583-style authorization request (from network → us)
  app.post('/v1/card-core/authorize', express.json(), async (req, res) => {
    const t = req.headers['x-card-network-secret'];
    if (!t || t !== process.env.CARD_CORE_NETWORK_SECRET) return res.status(401).json({ error: 'network_auth_required' });
    const p = authSchema.safeParse(req.body || {});
    if (!p.success) return res.status(400).json({ error: 'invalid_input', details: p.error.flatten() });

    // Look up card
    let card;
    if (p.data.card_id) {
      const r = await pool.query(`SELECT * FROM card_core_cards WHERE card_id=$1`, [p.data.card_id]).catch(() => ({ rows: [] }));
      card = r.rows[0];
    } else if (p.data.pan_first6 && p.data.pan_last4) {
      const r = await pool.query(`SELECT * FROM card_core_cards WHERE pan_first6=$1 AND pan_last4=$2`, [p.data.pan_first6, p.data.pan_last4]).catch(() => ({ rows: [] }));
      card = r.rows[0];
    }
    if (!card) return res.json({ approved: false, reason: 'card_not_found' });
    if (card.status !== 'active') return res.json({ approved: false, reason: 'card_not_active' });
    if (card.per_tx_limit_cents && p.data.amount_cents > Number(card.per_tx_limit_cents)) {
      return res.json({ approved: false, reason: 'per_tx_limit_exceeded' });
    }
    if (card.monthly_limit_cents && Number(card.spent_this_month_cents) + p.data.amount_cents > Number(card.monthly_limit_cents)) {
      return res.json({ approved: false, reason: 'monthly_limit_exceeded' });
    }

    // JIT funding: reserve from funding account via gl_accounts (bank_core)
    const funding = card.funding_account_id;
    if (funding) {
      const upd = await pool.query(`UPDATE gl_accounts SET reserved_cents = reserved_cents + $1
                                     WHERE account_id=$2 AND balance_cents - reserved_cents >= $1
                                     RETURNING account_id`,
        [p.data.amount_cents, funding]).catch(() => ({ rows: [] }));
      if (!upd.rows[0]) {
        const id = newId('auth');
        await pool.query(`INSERT INTO card_core_authorizations (auth_id, card_id, stan, merchant_name, merchant_category, merchant_country, amount_cents, currency, result, reason)
                          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'declined','insufficient_funds')`,
          [id, card.card_id, p.data.stan || null, p.data.merchant_name, p.data.merchant_category || null, p.data.merchant_country || null, p.data.amount_cents, p.data.currency]).catch(() => {});
        return res.json({ approved: false, reason: 'insufficient_funds', auth_id: id });
      }
    }

    const id = newId('auth');
    await pool.query(
      `INSERT INTO card_core_authorizations (auth_id, card_id, stan, merchant_name, merchant_category,
         merchant_country, amount_cents, currency, result, hold_cents)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'approved',$9)`,
      [id, card.card_id, p.data.stan || null, p.data.merchant_name, p.data.merchant_category || null,
       p.data.merchant_country || null, p.data.amount_cents, p.data.currency, p.data.amount_cents]
    );
    await pool.query(`UPDATE card_core_cards SET spent_this_month_cents = spent_this_month_cents + $1 WHERE card_id=$2`,
      [p.data.amount_cents, card.card_id]).catch(() => {});

    if (auditChain) await auditChain.append({ event_type: 'card_core.authorized', auth_id: id, card_id: card.card_id, amount_cents: p.data.amount_cents, merchant: p.data.merchant_name }).catch(() => {});

    res.json({ approved: true, auth_id: id, response_code: '00', stan: p.data.stan || crypto.randomBytes(3).toString('hex') });
  });

  // Capture / settle
  app.post('/v1/card-core/authorizations/:aid/capture', express.json(), async (req, res) => {
    const t = req.headers['x-card-network-secret'];
    if (!t || t !== process.env.CARD_CORE_NETWORK_SECRET) return res.status(401).json({ error: 'network_auth_required' });
    const a = await pool.query(`SELECT * FROM card_core_authorizations WHERE auth_id=$1 AND result='approved' AND captured_at IS NULL`, [req.params.aid])
      .catch(() => ({ rows: [] }));
    if (!a.rows[0]) return res.status(404).json({ error: 'not_capturable' });

    const card = await pool.query(`SELECT funding_account_id FROM card_core_cards WHERE card_id=$1`, [a.rows[0].card_id]).catch(() => ({ rows: [] }));
    const amount = Number(a.rows[0].amount_cents);
    // Interchange fee model: 2% of amount; net = 98%
    const interchange = Math.floor(amount * 0.02);
    const net = amount - interchange;

    if (card.rows[0]?.funding_account_id) {
      // Release reservation, actually move funds
      await pool.query(`UPDATE gl_accounts SET balance_cents = balance_cents - $1, reserved_cents = GREATEST(0, reserved_cents - $1) WHERE account_id=$2`,
        [amount, card.rows[0].funding_account_id]).catch(() => {});
      // Credit merchant settlement account (sys.platform_revenue gets interchange)
      await pool.query(`UPDATE gl_accounts SET balance_cents = balance_cents + $1 WHERE account_id='sys.platform_revenue'`,
        [interchange]).catch(() => {});
    }

    await pool.query(`UPDATE card_core_authorizations SET captured_at=NOW() WHERE auth_id=$1`, [req.params.aid]).catch(() => {});
    const sid = newId('cset');
    await pool.query(`INSERT INTO card_core_settlements (settlement_id, auth_id, amount_cents, net_after_interchange_cents)
                      VALUES ($1,$2,$3,$4)`,
      [sid, req.params.aid, amount, net]).catch(() => {});

    // Record interchange as revenue
    try {
      const rev = require('./revenue');
      await rev.recordRevenue({ pool, source_layer: 'card_interchange', amount_cents: interchange, related_id: req.params.aid });
    } catch {}

    if (auditChain) await auditChain.append({ event_type: 'card_core.captured', auth_id: req.params.aid, settlement_id: sid, amount_cents: amount, interchange_cents: interchange }).catch(() => {});
    res.json({ settlement_id: sid, amount_cents: amount, interchange_cents: interchange, net_cents: net });
  });

  app.post('/v1/card-core/authorizations/:aid/reverse', async (req, res) => {
    const t = req.headers['x-card-network-secret'];
    if (!t || t !== process.env.CARD_CORE_NETWORK_SECRET) return res.status(401).json({ error: 'network_auth_required' });
    const r = await pool.query(`UPDATE card_core_authorizations SET reversed_at=NOW(), result='reversed' WHERE auth_id=$1 AND captured_at IS NULL RETURNING auth_id, card_id, amount_cents`,
      [req.params.aid]).catch(() => ({ rows: [] }));
    if (!r.rows[0]) return res.status(404).json({ error: 'not_reversible' });
    const card = await pool.query(`SELECT funding_account_id FROM card_core_cards WHERE card_id=$1`, [r.rows[0].card_id]).catch(() => ({ rows: [] }));
    if (card.rows[0]?.funding_account_id) {
      await pool.query(`UPDATE gl_accounts SET reserved_cents = GREATEST(0, reserved_cents - $1) WHERE account_id=$2`,
        [Number(r.rows[0].amount_cents), card.rows[0].funding_account_id]).catch(() => {});
    }
    if (auditChain) await auditChain.append({ event_type: 'card_core.reversed', auth_id: r.rows[0].auth_id }).catch(() => {});
    res.json({ auth_id: r.rows[0].auth_id, reversed: true });
  });

  app.post('/v1/card-core/chargebacks', express.json(), async (req, res) => {
    const t = req.headers['x-card-network-secret'];
    if (!t || t !== process.env.CARD_CORE_NETWORK_SECRET) return res.status(401).json({ error: 'network_auth_required' });
    const id = newId('cbk');
    await pool.query(
      `INSERT INTO card_core_chargebacks (chargeback_id, auth_id, reason_code, amount_cents)
       VALUES ($1,$2,$3,$4)`,
      [id, req.body?.auth_id, req.body?.reason_code || '4837', req.body?.amount_cents]
    );
    if (auditChain) await auditChain.append({ event_type: 'card_core.chargeback_filed', chargeback_id: id, auth_id: req.body?.auth_id, reason: req.body?.reason_code }).catch(() => {});
    res.status(201).json({ chargeback_id: id });
  });

  app.get('/v1/agents/:did/card-core/cards/:cid/authorizations', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(`
      SELECT auth_id, merchant_name, merchant_category, amount_cents, currency, result, reason, authorized_at, captured_at, reversed_at
      FROM card_core_authorizations WHERE card_id=$1 ORDER BY authorized_at DESC LIMIT 100
    `, [req.params.cid]).catch(() => ({ rows: [] }));
    res.json({ authorizations: r.rows });
  });

  registerCron(app, '/v1/_jobs/card-core-monthly-reset', async (req, res) => {
    const r = await pool.query(`UPDATE card_core_cards SET spent_this_month_cents=0, period_start=NOW() WHERE period_start < NOW() - INTERVAL '30 days' RETURNING card_id`)
      .catch(() => ({ rows: [] }));
    res.json({ reset: r.rows.length });
  });
}

module.exports = { migrate, registerCardCoreRoutes, generatePan, generateCvv, encryptPan, decryptPan, BIN_RANGE };
