// ============================================================================
// capital_markets.js — agent equity tokenization, bond issuance, cap tables,
// IPO-ready capital stack. The infrastructure for AGIs (and humans) to
// raise + manage capital programmatically.
// ============================================================================
const crypto = require('crypto');
const { z } = require('zod');

async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cap_tables (
      cap_id              TEXT PRIMARY KEY,
      issuer_did          TEXT,
      issuer_org_id       TEXT,
      total_authorized    BIGINT NOT NULL,
      total_issued        BIGINT NOT NULL DEFAULT 0,
      par_value_cents     INTEGER NOT NULL DEFAULT 1,
      currency            TEXT DEFAULT 'usd',
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS cap_table_entries (
      entry_id            TEXT PRIMARY KEY,
      cap_id              TEXT NOT NULL,
      holder_did          TEXT NOT NULL,
      holder_kind         TEXT NOT NULL DEFAULT 'individual',
      class               TEXT NOT NULL DEFAULT 'common',
      shares              BIGINT NOT NULL,
      price_paid_cents    BIGINT,
      vesting_schedule    JSONB,
      cliff_at            TIMESTAMPTZ,
      issued_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_cap_table_entries_holder ON cap_table_entries (holder_did);

    CREATE TABLE IF NOT EXISTS bonds (
      bond_id             TEXT PRIMARY KEY,
      issuer_did          TEXT,
      issuer_org_id       TEXT,
      slug                TEXT UNIQUE NOT NULL,
      face_value_cents    BIGINT NOT NULL,
      coupon_bps          INTEGER NOT NULL,
      maturity_at         TIMESTAMPTZ NOT NULL,
      total_outstanding_cents BIGINT NOT NULL DEFAULT 0,
      max_issue_cents     BIGINT,
      status              TEXT NOT NULL DEFAULT 'open',
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS bond_holdings (
      holding_id          TEXT PRIMARY KEY,
      bond_id             TEXT NOT NULL,
      holder_did          TEXT NOT NULL,
      face_value_cents    BIGINT NOT NULL,
      purchase_price_cents BIGINT NOT NULL,
      purchased_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      redeemed_at         TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS funding_rounds (
      round_id            TEXT PRIMARY KEY,
      issuer_org_id       TEXT NOT NULL,
      kind                TEXT NOT NULL,
      target_cents        BIGINT NOT NULL,
      raised_cents        BIGINT NOT NULL DEFAULT 0,
      pre_money_cents     BIGINT,
      post_money_cents    BIGINT,
      status              TEXT NOT NULL DEFAULT 'open',
      opened_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      closed_at           TIMESTAMPTZ,
      lead_investor_did   TEXT
    );
    CREATE TABLE IF NOT EXISTS funding_commitments (
      commitment_id       TEXT PRIMARY KEY,
      round_id            TEXT NOT NULL,
      investor_did        TEXT NOT NULL,
      amount_cents        BIGINT NOT NULL,
      shares_allocated    BIGINT,
      status              TEXT NOT NULL DEFAULT 'soft',
      committed_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      funded_at           TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS dividends (
      dividend_id         TEXT PRIMARY KEY,
      cap_id              TEXT NOT NULL,
      per_share_cents     BIGINT NOT NULL,
      record_date         DATE NOT NULL,
      pay_date            DATE NOT NULL,
      total_paid_cents    BIGINT,
      status              TEXT NOT NULL DEFAULT 'declared',
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

function newId(p) { return p + '_' + crypto.randomBytes(10).toString('hex'); }

const capTableSchema = z.object({
  total_authorized: z.number().int().min(1),
  par_value_cents: z.number().int().min(0).optional(),
  currency: z.string().optional()
});
const issueShareSchema = z.object({
  cap_id: z.string(),
  holder_did: z.string(),
  holder_kind: z.enum(['individual', 'agent', 'org', 'esop']).optional(),
  class: z.enum(['common', 'preferred_a', 'preferred_b', 'preferred_c', 'esop']).optional(),
  shares: z.number().int().min(1),
  price_paid_cents: z.number().int().min(0).optional(),
  vesting_schedule: z.record(z.any()).optional(),
  cliff_at: z.string().optional()
});
const bondSchema = z.object({
  slug: z.string().regex(/^[a-z0-9-]{3,40}$/),
  face_value_cents: z.number().int().min(100),
  coupon_bps: z.number().int().min(0).max(10000),
  maturity_at: z.string(),
  max_issue_cents: z.number().int().optional()
});
const roundSchema = z.object({
  kind: z.enum(['safe', 'pre_seed', 'seed', 'series_a', 'series_b', 'series_c', 'series_d', 'bridge', 'crowdfund']),
  target_cents: z.number().int().min(100),
  pre_money_cents: z.number().int().min(0).optional(),
  lead_investor_did: z.string().optional()
});

function registerCapitalMarketsRoutes(app, pool, verifyAgentAuth, auditChain) {
  const express = require('express');

  // ===== Cap tables =====
  app.post('/v1/orgs/:id/cap-table', express.json(), async (req, res) => {
    const did = req.headers['x-agent-did'];
    if (!did) return res.status(401).json({ error: 'agent_did_required' });
    const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const p = capTableSchema.safeParse(req.body || {});
    if (!p.success) return res.status(400).json({ error: 'invalid_input', details: p.error.flatten() });
    const id = newId('cap');
    await pool.query(
      `INSERT INTO cap_tables (cap_id, issuer_org_id, issuer_did, total_authorized, par_value_cents, currency)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [id, req.params.id, did, p.data.total_authorized, p.data.par_value_cents || 1, p.data.currency || 'usd']
    );
    if (auditChain) await auditChain.append({ event_type: 'cap_table.created', org_id: req.params.id, cap_id: id }).catch(() => {});
    res.status(201).json({ cap_id: id, total_authorized: p.data.total_authorized });
  });

  app.post('/v1/cap-tables/:cid/issue', express.json(), async (req, res) => {
    const did = req.headers['x-agent-did'];
    if (!did) return res.status(401).json({ error: 'agent_did_required' });
    const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const p = issueShareSchema.safeParse(req.body || {});
    if (!p.success) return res.status(400).json({ error: 'invalid_input', details: p.error.flatten() });

    const cap = await pool.query(`SELECT total_authorized, total_issued FROM cap_tables WHERE cap_id=$1`, [p.data.cap_id])
      .catch(() => ({ rows: [] }));
    if (!cap.rows[0]) return res.status(404).json({ error: 'cap_table_not_found' });
    if (BigInt(cap.rows[0].total_issued) + BigInt(p.data.shares) > BigInt(cap.rows[0].total_authorized)) {
      return res.status(400).json({ error: 'exceeds_authorized', remaining: (BigInt(cap.rows[0].total_authorized) - BigInt(cap.rows[0].total_issued)).toString() });
    }
    const id = newId('eq');
    await pool.query(
      `INSERT INTO cap_table_entries (entry_id, cap_id, holder_did, holder_kind, class,
         shares, price_paid_cents, vesting_schedule, cliff_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [id, p.data.cap_id, p.data.holder_did, p.data.holder_kind || 'individual',
       p.data.class || 'common', p.data.shares, p.data.price_paid_cents || null,
       p.data.vesting_schedule ? JSON.stringify(p.data.vesting_schedule) : null,
       p.data.cliff_at ? new Date(p.data.cliff_at).toISOString() : null]
    );
    await pool.query(`UPDATE cap_tables SET total_issued = total_issued + $1 WHERE cap_id=$2`, [p.data.shares, p.data.cap_id]).catch(() => {});
    if (auditChain) await auditChain.append({ event_type: 'cap_table.issued', cap_id: p.data.cap_id, entry_id: id, holder_did: p.data.holder_did, shares: p.data.shares }).catch(() => {});
    res.status(201).json({ entry_id: id });
  });

  app.get('/v1/cap-tables/:cid', async (req, res) => {
    const c = await pool.query(`SELECT * FROM cap_tables WHERE cap_id=$1`, [req.params.cid]).catch(() => ({ rows: [] }));
    if (!c.rows[0]) return res.status(404).json({ error: 'not_found' });
    const e = await pool.query(`SELECT * FROM cap_table_entries WHERE cap_id=$1 ORDER BY issued_at DESC LIMIT 1000`, [req.params.cid])
      .catch(() => ({ rows: [] }));
    res.json({ ...c.rows[0], entries: e.rows });
  });

  // ===== Bonds =====
  app.post('/v1/agents/:did/bonds', express.json(), async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const p = bondSchema.safeParse(req.body || {});
    if (!p.success) return res.status(400).json({ error: 'invalid_input', details: p.error.flatten() });
    const id = newId('bnd');
    try {
      await pool.query(
        `INSERT INTO bonds (bond_id, issuer_did, slug, face_value_cents, coupon_bps,
           maturity_at, max_issue_cents, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'open')`,
        [id, did, p.data.slug, p.data.face_value_cents, p.data.coupon_bps,
         new Date(p.data.maturity_at).toISOString(), p.data.max_issue_cents || null]
      );
      if (auditChain) await auditChain.append({ event_type: 'bond.issued', bond_id: id, slug: p.data.slug, coupon_bps: p.data.coupon_bps }).catch(() => {});
      res.status(201).json({ bond_id: id, slug: p.data.slug });
    } catch { res.status(409).json({ error: 'slug_taken' }); }
  });

  app.post('/v1/bonds/:bid/buy', express.json(), async (req, res) => {
    const did = req.headers['x-agent-did'];
    if (!did) return res.status(401).json({ error: 'agent_did_required' });
    const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const face = req.body?.face_value_cents;
    const price = req.body?.purchase_price_cents || face;
    if (!face) return res.status(400).json({ error: 'face_value_cents_required' });
    const id = newId('bh');
    await pool.query(
      `INSERT INTO bond_holdings (holding_id, bond_id, holder_did, face_value_cents, purchase_price_cents)
       VALUES ($1,$2,$3,$4,$5)`,
      [id, req.params.bid, did, face, price]
    );
    await pool.query(`UPDATE bonds SET total_outstanding_cents = total_outstanding_cents + $1 WHERE bond_id=$2`,
      [face, req.params.bid]).catch(() => {});
    if (auditChain) await auditChain.append({ event_type: 'bond.bought', bond_id: req.params.bid, holder_did: did, face_value_cents: face }).catch(() => {});
    res.status(201).json({ holding_id: id });
  });

  // ===== Funding rounds =====
  app.post('/v1/orgs/:id/funding-rounds', express.json(), async (req, res) => {
    const did = req.headers['x-agent-did'];
    if (!did) return res.status(401).json({ error: 'agent_did_required' });
    const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const p = roundSchema.safeParse(req.body || {});
    if (!p.success) return res.status(400).json({ error: 'invalid_input', details: p.error.flatten() });
    const id = newId('rnd');
    const post = p.data.pre_money_cents ? p.data.pre_money_cents + p.data.target_cents : null;
    await pool.query(
      `INSERT INTO funding_rounds (round_id, issuer_org_id, kind, target_cents, pre_money_cents,
         post_money_cents, lead_investor_did, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'open')`,
      [id, req.params.id, p.data.kind, p.data.target_cents, p.data.pre_money_cents || null,
       post, p.data.lead_investor_did || null]
    );
    if (auditChain) await auditChain.append({ event_type: 'funding_round.opened', org_id: req.params.id, round_id: id, kind: p.data.kind, target_cents: p.data.target_cents }).catch(() => {});
    res.status(201).json({ round_id: id, post_money_cents: post });
  });

  app.post('/v1/funding-rounds/:rid/commit', express.json(), async (req, res) => {
    const did = req.headers['x-agent-did'];
    if (!did) return res.status(401).json({ error: 'agent_did_required' });
    const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const amount = req.body?.amount_cents;
    if (!amount) return res.status(400).json({ error: 'amount_cents_required' });
    const id = newId('com');
    await pool.query(
      `INSERT INTO funding_commitments (commitment_id, round_id, investor_did, amount_cents, status)
       VALUES ($1,$2,$3,$4,'soft')`,
      [id, req.params.rid, did, amount]
    );
    if (auditChain) await auditChain.append({ event_type: 'funding.committed', round_id: req.params.rid, investor_did: did, amount_cents: amount }).catch(() => {});
    res.status(201).json({ commitment_id: id, status: 'soft' });
  });

  // ===== Dividends =====
  app.post('/v1/cap-tables/:cid/dividends', express.json(), async (req, res) => {
    const did = req.headers['x-agent-did'];
    if (!did) return res.status(401).json({ error: 'agent_did_required' });
    const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const id = newId('div');
    await pool.query(
      `INSERT INTO dividends (dividend_id, cap_id, per_share_cents, record_date, pay_date, status)
       VALUES ($1,$2,$3,$4,$5,'declared')`,
      [id, req.params.cid, req.body?.per_share_cents || 0,
       req.body?.record_date || new Date().toISOString().slice(0,10),
       req.body?.pay_date || new Date(Date.now() + 30*86400000).toISOString().slice(0,10)]
    );
    res.status(201).json({ dividend_id: id });
  });

  app.get('/v1/agents/:did/holdings', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const equity = await pool.query(`SELECT entry_id, cap_id, class, shares, price_paid_cents, issued_at
                                      FROM cap_table_entries WHERE holder_did=$1`, [did]).catch(() => ({ rows: [] }));
    const bonds = await pool.query(`SELECT holding_id, bond_id, face_value_cents, purchase_price_cents, purchased_at
                                     FROM bond_holdings WHERE holder_did=$1 AND redeemed_at IS NULL`, [did]).catch(() => ({ rows: [] }));
    res.json({ agent_did: did, equity: equity.rows, bonds: bonds.rows });
  });
}

module.exports = { migrate, registerCapitalMarketsRoutes };
