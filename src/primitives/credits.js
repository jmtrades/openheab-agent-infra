// ============================================================================
// credits.js — pre-purchased credit packs.
// Drives upfront cash collection: an enterprise pays $70K → gets 6.5M credits.
// FIFO consumption ordered by expiration date.
// ============================================================================
const crypto = require('crypto');
const { z } = require('zod');
const { registerCron } = require('../cron_auth');

const DEFAULT_PACKS = [
  { code: 'starter_5k',     name: 'Starter',     credits: 5_000,     price_cents: 9900,    expiration_days: 365 },
  { code: 'growth_50k',     name: 'Growth',      credits: 55_000,    price_cents: 89900,   expiration_days: 365 },
  { code: 'pro_500k',       name: 'Pro',         credits: 600_000,   price_cents: 799900,  expiration_days: null },
  { code: 'enterprise_5m',  name: 'Enterprise',  credits: 6_500_000, price_cents: 6999900, expiration_days: null }
];

async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS credit_packs (
      pack_id              TEXT PRIMARY KEY,
      code                 TEXT UNIQUE NOT NULL,
      name                 TEXT NOT NULL,
      credits              BIGINT NOT NULL,
      price_cents          BIGINT NOT NULL,
      expiration_days      INTEGER,
      includes_kinds       TEXT[],
      status               TEXT NOT NULL DEFAULT 'active',
      created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS credit_balances (
      balance_id           TEXT PRIMARY KEY,
      org_id               TEXT NOT NULL,
      pack_id              TEXT NOT NULL,
      purchased_credits    BIGINT NOT NULL,
      used_credits         BIGINT NOT NULL DEFAULT 0,
      expires_at           TIMESTAMPTZ,
      purchased_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      stripe_payment_intent_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_credit_balances_org_exp
      ON credit_balances (org_id, expires_at NULLS LAST);

    CREATE TABLE IF NOT EXISTS credit_transactions (
      txn_id               TEXT PRIMARY KEY,
      org_id               TEXT NOT NULL,
      agent_did            TEXT,
      amount               BIGINT NOT NULL,
      kind                 TEXT NOT NULL,
      reason               TEXT,
      related_id           TEXT,
      occurred_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      idempotency_key      TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_credit_txns_org ON credit_transactions (org_id, occurred_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_credit_txns_idem
      ON credit_transactions (org_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

    CREATE TABLE IF NOT EXISTS credit_grants (
      grant_id             TEXT PRIMARY KEY,
      org_id               TEXT NOT NULL,
      granted_credits      BIGINT NOT NULL,
      reason               TEXT,
      granted_by           TEXT,
      granted_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at           TIMESTAMPTZ
    );
  `);
  for (const p of DEFAULT_PACKS) {
    const id = 'pack_' + crypto.createHash('sha256').update(p.code).digest('hex').slice(0, 16);
    await pool.query(
      `INSERT INTO credit_packs (pack_id, code, name, credits, price_cents, expiration_days)
       VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (code) DO NOTHING`,
      [id, p.code, p.name, p.credits, p.price_cents, p.expiration_days]
    ).catch(() => {});
  }
}

function newId(p) { return p + '_' + crypto.randomBytes(10).toString('hex'); }

function isAdmin(req) {
  const t = req.headers['x-admin-token'];
  return t && t === process.env.OPERATOR_ADMIN_TOKEN;
}

async function getBalance(pool, orgId) {
  const r = await pool.query(`
    SELECT b.balance_id, b.pack_id, b.purchased_credits, b.used_credits,
           b.expires_at, b.purchased_at, p.name AS pack_name, p.code AS pack_code
    FROM credit_balances b LEFT JOIN credit_packs p ON p.pack_id = b.pack_id
    WHERE b.org_id = $1 AND b.purchased_credits > b.used_credits
      AND (b.expires_at IS NULL OR b.expires_at > NOW())
    ORDER BY b.expires_at NULLS LAST, b.purchased_at
  `, [orgId]).catch(() => ({ rows: [] }));
  let total = 0n, available = 0n;
  for (const x of r.rows) {
    total += BigInt(x.purchased_credits);
    available += BigInt(x.purchased_credits) - BigInt(x.used_credits);
  }
  return {
    org_id: orgId,
    total_purchased: total.toString(),
    available_credits: available.toString(),
    breakdown: r.rows.map(x => ({
      balance_id: x.balance_id, pack_code: x.pack_code, pack_name: x.pack_name,
      purchased: String(x.purchased_credits), used: String(x.used_credits),
      remaining: (BigInt(x.purchased_credits) - BigInt(x.used_credits)).toString(),
      expires_at: x.expires_at, purchased_at: x.purchased_at
    }))
  };
}

async function consumeCredits({ pool, orgId, agent_did = null, amount, kind = 'consumption',
                                 idempotency_key = null, related_id = null, reason = null }) {
  const want = BigInt(amount);
  if (want <= 0n) throw new Error('amount_must_be_positive');

  if (idempotency_key) {
    const dup = await pool.query(
      `SELECT txn_id FROM credit_transactions WHERE org_id = $1 AND idempotency_key = $2`,
      [orgId, idempotency_key]
    ).catch(() => ({ rows: [] }));
    if (dup.rows[0]) return { txn_id: dup.rows[0].txn_id, idempotent: true };
  }

  const balances = await pool.query(`
    SELECT balance_id, purchased_credits, used_credits FROM credit_balances
    WHERE org_id = $1 AND purchased_credits > used_credits
      AND (expires_at IS NULL OR expires_at > NOW())
    ORDER BY expires_at NULLS LAST, purchased_at FOR UPDATE
  `, [orgId]).catch(() => ({ rows: [] }));

  let remaining = want;
  for (const b of balances.rows) {
    if (remaining <= 0n) break;
    const avail = BigInt(b.purchased_credits) - BigInt(b.used_credits);
    const take = avail < remaining ? avail : remaining;
    await pool.query(
      `UPDATE credit_balances SET used_credits = used_credits + $1 WHERE balance_id = $2`,
      [take.toString(), b.balance_id]
    ).catch(() => {});
    remaining -= take;
  }
  if (remaining > 0n) {
    return { ok: false, error: 'insufficient_credits', shortfall: remaining.toString() };
  }
  const id = newId('ctx');
  await pool.query(
    `INSERT INTO credit_transactions (txn_id, org_id, agent_did, amount, kind,
       reason, related_id, idempotency_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [id, orgId, agent_did, -Number(want), kind, reason, related_id, idempotency_key]
  ).catch(() => {});
  return { ok: true, txn_id: id, consumed: want.toString() };
}

async function purchaseCredits({ pool, orgId, packCode, paymentIntentId = null, auditChain = null }) {
  const pack = await pool.query(`SELECT * FROM credit_packs WHERE code = $1 AND status = 'active'`, [packCode])
    .catch(() => ({ rows: [] }));
  if (!pack.rows[0]) return { ok: false, error: 'pack_not_found' };
  const p = pack.rows[0];
  const expiresAt = p.expiration_days
    ? new Date(Date.now() + p.expiration_days * 86400000).toISOString() : null;
  const id = newId('cbal');
  await pool.query(
    `INSERT INTO credit_balances (balance_id, org_id, pack_id, purchased_credits, expires_at, stripe_payment_intent_id)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [id, orgId, p.pack_id, p.credits, expiresAt, paymentIntentId]
  );
  await pool.query(
    `INSERT INTO credit_transactions (txn_id, org_id, amount, kind, reason, related_id)
     VALUES ($1,$2,$3,'purchase',$4,$5)`,
    [newId('ctx'), orgId, p.credits, 'pack:' + p.code, id]
  ).catch(() => {});
  if (auditChain) {
    await auditChain.append({
      event_type: 'credits.purchased', org_id: orgId, pack_code: p.code,
      credits: String(p.credits), price_cents: Number(p.price_cents)
    }).catch(() => {});
  }
  // Record revenue
  try {
    const rev = require('./revenue');
    await rev.recordRevenue({ pool, source_layer: 'credit_purchase',
      amount_cents: Number(p.price_cents), org_id: orgId, related_id: id });
  } catch {}
  return { ok: true, balance_id: id, credits: String(p.credits), expires_at: expiresAt };
}

async function grantCredits({ pool, orgId, credits, reason, expires_at = null, granted_by = null }) {
  const id = newId('grant');
  await pool.query(
    `INSERT INTO credit_grants (grant_id, org_id, granted_credits, reason, granted_by, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [id, orgId, credits, reason, granted_by, expires_at]
  );
  await pool.query(
    `INSERT INTO credit_balances (balance_id, org_id, pack_id, purchased_credits, expires_at)
     VALUES ($1,$2,'pack_grant',$3,$4)`,
    [newId('cbal'), orgId, credits, expires_at]
  ).catch(() => {});
  await pool.query(
    `INSERT INTO credit_transactions (txn_id, org_id, amount, kind, reason)
     VALUES ($1,$2,$3,'grant',$4)`,
    [newId('ctx'), orgId, credits, reason]
  ).catch(() => {});
  return { grant_id: id, credits };
}

const purchaseSchema = z.object({
  pack_code: z.string(),
  payment_method_id: z.string().optional()
});
const consumeSchema = z.object({
  amount: z.number().int().positive(),
  kind: z.string().optional(),
  agent_did: z.string().optional(),
  idempotency_key: z.string().optional()
});

function registerCreditsRoutes(app, pool, verifyAgentAuth, auditChain) {
  const express = require('express');

  app.get('/v1/credits/packs', async (req, res) => {
    const r = await pool.query(`SELECT code, name, credits, price_cents, expiration_days
                                FROM credit_packs WHERE status='active' ORDER BY price_cents`)
      .catch(() => ({ rows: [] }));
    res.json({ packs: r.rows.map(x => ({ ...x, credits: String(x.credits), price_cents: Number(x.price_cents) })) });
  });

  app.post('/v1/orgs/:id/credits/purchase', express.json(), async (req, res) => {
    const did = req.headers['x-agent-did'];
    if (!did) return res.status(401).json({ error: 'agent_did_required' });
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const p = purchaseSchema.safeParse(req.body || {});
    if (!p.success) return res.status(400).json({ error: 'invalid_input', details: p.error.flatten() });
    const out = await purchaseCredits({ pool, orgId: req.params.id, packCode: p.data.pack_code,
                                         paymentIntentId: p.data.payment_method_id, auditChain });
    if (!out.ok) return res.status(400).json(out);
    return res.status(201).json(out);
  });

  app.get('/v1/orgs/:id/credits/balance', async (req, res) => {
    const did = req.headers['x-agent-did'];
    if (!did) return res.status(401).json({ error: 'agent_did_required' });
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    return res.json(await getBalance(pool, req.params.id));
  });

  app.post('/v1/orgs/:id/credits/consume', express.json(), async (req, res) => {
    const did = req.headers['x-agent-did'];
    if (!did) return res.status(401).json({ error: 'agent_did_required' });
    const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const p = consumeSchema.safeParse(req.body || {});
    if (!p.success) return res.status(400).json({ error: 'invalid_input', details: p.error.flatten() });
    const out = await consumeCredits({ pool, orgId: req.params.id, ...p.data });
    if (auditChain) await auditChain.append({ event_type: 'credits.consumed', org_id: req.params.id, ...p.data }).catch(() => {});
    return res.json(out);
  });

  app.post('/v1/orgs/:id/credits/grant', express.json(), async (req, res) => {
    if (!isAdmin(req)) return res.status(401).json({ error: 'admin_auth_required' });
    const out = await grantCredits({ pool, orgId: req.params.id, ...(req.body || {}) });
    if (auditChain) await auditChain.append({ event_type: 'credits.granted', org_id: req.params.id, ...out }).catch(() => {});
    return res.status(201).json(out);
  });

  app.get('/v1/orgs/:id/credits/transactions', async (req, res) => {
    const did = req.headers['x-agent-did'];
    if (!did) return res.status(401).json({ error: 'agent_did_required' });
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    const r = await pool.query(`
      SELECT txn_id, agent_did, amount, kind, reason, occurred_at
      FROM credit_transactions WHERE org_id = $1 ORDER BY occurred_at DESC LIMIT $2
    `, [req.params.id, limit]).catch(() => ({ rows: [] }));
    return res.json({ org_id: req.params.id, transactions: r.rows });
  });

  registerCron(app, '/v1/_jobs/credits-expire', async (req, res) => {
    const r = await pool.query(`
      UPDATE credit_balances SET used_credits = purchased_credits
      WHERE expires_at IS NOT NULL AND expires_at < NOW() AND purchased_credits > used_credits
      RETURNING balance_id, org_id
    `).catch(() => ({ rows: [] }));
    res.json({ expired: r.rows.length });
  });
}

module.exports = {
  migrate, registerCreditsRoutes, purchaseCredits, consumeCredits, getBalance, grantCredits, DEFAULT_PACKS
};
