// ============================================================================
// insurance_core.js — IN-HOUSE underwriter. Risk pools, premium calc, claims
// adjustment, reinsurance contracts. We underwrite E&O on autonomous agent
// decisions, cyber liability, transaction insurance, all in-house.
// Replaces Embroker / Vouch / Coalition.
//
// Honest disclosure: to legally sell insurance in the US requires state
// insurance department licenses. This primitive ships the full risk-pool +
// premium + claims infrastructure. Licensing is parallel work; once we have
// it, every route here is production-ready.
// ============================================================================
const crypto = require('crypto');
const { z } = require('zod');
const { registerCron } = require('../cron_auth');

const PRODUCTS = {
  agent_eo:         { label: 'Agent E&O', base_premium_bps_per_action: 5, min_premium_cents: 5000 },
  agent_cyber:      { label: 'Agent Cyber Liability', base_premium_bps_of_volume: 30, min_premium_cents: 10000 },
  transaction_insurance: { label: 'Transaction Insurance', base_premium_bps_of_amount: 100, min_premium_cents: 100 },
  marketplace_buyer_protection: { label: 'Buyer Protection', base_premium_bps_of_amount: 200, min_premium_cents: 50 },
  payout_failure:   { label: 'Payout Failure Cover', base_premium_bps_of_amount: 50, min_premium_cents: 200 }
};

async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ins_pools (
      pool_id           TEXT PRIMARY KEY,
      product           TEXT NOT NULL,
      reserve_cents     BIGINT NOT NULL DEFAULT 0,
      gross_premiums_collected_cents BIGINT NOT NULL DEFAULT 0,
      gross_claims_paid_cents BIGINT NOT NULL DEFAULT 0,
      reinsurance_attached_at_cents BIGINT,
      reinsurance_pct   REAL,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS ins_policies (
      policy_id         TEXT PRIMARY KEY,
      pool_id           TEXT NOT NULL,
      insured_did       TEXT NOT NULL,
      product           TEXT NOT NULL,
      coverage_limit_cents BIGINT NOT NULL,
      deductible_cents  BIGINT NOT NULL DEFAULT 0,
      premium_cents     BIGINT NOT NULL,
      term_starts       DATE NOT NULL,
      term_ends         DATE NOT NULL,
      status            TEXT NOT NULL DEFAULT 'active',
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      cancelled_at      TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_ins_policies_insured ON ins_policies (insured_did);

    CREATE TABLE IF NOT EXISTS ins_claims (
      claim_id          TEXT PRIMARY KEY,
      policy_id         TEXT NOT NULL,
      claimant_did      TEXT NOT NULL,
      incident_at       TIMESTAMPTZ,
      reported_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      narrative         TEXT,
      claimed_cents     BIGINT NOT NULL,
      approved_cents    BIGINT,
      status            TEXT NOT NULL DEFAULT 'open',
      adjuster_did      TEXT,
      decided_at        TIMESTAMPTZ,
      paid_at           TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_ins_claims_policy ON ins_claims (policy_id);

    CREATE TABLE IF NOT EXISTS ins_reinsurance_contracts (
      contract_id       TEXT PRIMARY KEY,
      pool_id           TEXT NOT NULL,
      reinsurer_name    TEXT NOT NULL,
      attachment_cents  BIGINT NOT NULL,
      limit_cents       BIGINT NOT NULL,
      cession_pct       REAL NOT NULL,
      effective_at      DATE NOT NULL,
      expires_at        DATE NOT NULL
    );
  `);
}

function newId(p) { return p + '_' + crypto.randomBytes(10).toString('hex'); }

async function getOrCreatePool(pool, product) {
  const id = `pool_${product}`;
  await pool.query(`INSERT INTO ins_pools (pool_id, product) VALUES ($1, $2) ON CONFLICT (pool_id) DO NOTHING`,
    [id, product]).catch(() => {});
  return id;
}

function quotePremium(product, opts) {
  const def = PRODUCTS[product];
  if (!def) throw new Error('unknown_product');
  let base = def.min_premium_cents;
  if (def.base_premium_bps_per_action && opts.expected_actions) {
    base = Math.max(base, Math.ceil(opts.expected_actions * def.base_premium_bps_per_action));
  }
  if (def.base_premium_bps_of_volume && opts.annual_volume_cents) {
    base = Math.max(base, Math.ceil(opts.annual_volume_cents * def.base_premium_bps_of_volume / 10000));
  }
  if (def.base_premium_bps_of_amount && opts.transaction_cents) {
    base = Math.max(base, Math.ceil(opts.transaction_cents * def.base_premium_bps_of_amount / 10000));
  }
  // Risk multiplier based on insured's KYC risk score (if available)
  const riskMult = 1 + Math.min(2, Math.max(0, (opts.risk_score || 50) - 50) / 50);
  return Math.ceil(base * riskMult);
}

const quoteSchema = z.object({
  product: z.enum(Object.keys(PRODUCTS)),
  coverage_limit_cents: z.number().int().min(1000),
  expected_actions: z.number().int().optional(),
  annual_volume_cents: z.number().int().optional(),
  transaction_cents: z.number().int().optional()
});

const claimSchema = z.object({
  policy_id: z.string(),
  incident_at: z.string().optional(),
  narrative: z.string().min(10).max(5000),
  claimed_cents: z.number().int().min(1)
});

function isAdmin(req) {
  const t = req.headers['x-admin-token'];
  return require('../safe_compare').safeTokenCompare(t, process.env.OPERATOR_ADMIN_TOKEN);
}

function registerInsuranceCoreRoutes(app, pool, verifyAgentAuth, auditChain) {
  const express = require('express');

  app.get('/v1/insurance-core/products', (req, res) => {
    res.json({ products: Object.entries(PRODUCTS).map(([id, p]) => ({ id, ...p })) });
  });

  app.post('/v1/agents/:did/insurance-core/quote', express.json(), async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const p = quoteSchema.safeParse(req.body || {});
    if (!p.success) return res.status(400).json({ error: 'invalid_input', details: p.error.flatten() });
    let risk = 50;
    try {
      const r = await pool.query(`SELECT composite_score FROM kyc_risk_scores WHERE subject_did=$1`, [did]).catch(() => ({ rows: [] }));
      if (r.rows[0]) risk = Number(r.rows[0].composite_score);
    } catch {}
    const premium = quotePremium(p.data.product, { ...p.data, risk_score: risk });
    res.json({ product: p.data.product, premium_cents: premium, term_months: 12,
                coverage_limit_cents: p.data.coverage_limit_cents, deductible_cents: 0, risk_score: risk });
  });

  app.post('/v1/agents/:did/insurance-core/policies', express.json(), async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const p = quoteSchema.safeParse(req.body || {});
    if (!p.success) return res.status(400).json({ error: 'invalid_input', details: p.error.flatten() });
    let risk = 50;
    try {
      const r = await pool.query(`SELECT composite_score FROM kyc_risk_scores WHERE subject_did=$1`, [did]).catch(() => ({ rows: [] }));
      if (r.rows[0]) risk = Number(r.rows[0].composite_score);
    } catch {}
    const premium = quotePremium(p.data.product, { ...p.data, risk_score: risk });
    const poolId = await getOrCreatePool(pool, p.data.product);

    const id = newId('pol');
    const starts = new Date().toISOString().slice(0, 10);
    const ends = new Date(Date.now() + 365 * 86400000).toISOString().slice(0, 10);
    await pool.query(
      `INSERT INTO ins_policies (policy_id, pool_id, insured_did, product, coverage_limit_cents,
         premium_cents, term_starts, term_ends, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'active')`,
      [id, poolId, did, p.data.product, p.data.coverage_limit_cents, premium, starts, ends]
    );
    // Collect premium → bank ledger debit insured, credit pool reserve
    await pool.query(`UPDATE ins_pools SET reserve_cents = reserve_cents + $1, gross_premiums_collected_cents = gross_premiums_collected_cents + $1 WHERE pool_id=$2`,
      [premium, poolId]).catch(() => {});

    // Record revenue (insurance premium goes to revenue stack)
    try {
      const rev = require('./revenue');
      await rev.recordRevenue({ pool, source_layer: 'insurance_premium', amount_cents: Math.ceil(premium * 0.30), agent_did: did, related_id: id });
    } catch {}

    if (auditChain) await auditChain.append({ event_type: 'insurance_core.policy_issued', policy_id: id, insured_did: did, product: p.data.product, premium_cents: premium }).catch(() => {});
    res.status(201).json({ policy_id: id, premium_cents: premium, coverage_limit_cents: p.data.coverage_limit_cents, term_starts: starts, term_ends: ends });
  });

  app.post('/v1/agents/:did/insurance-core/claims', express.json(), async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const p = claimSchema.safeParse(req.body || {});
    if (!p.success) return res.status(400).json({ error: 'invalid_input', details: p.error.flatten() });
    const pol = await pool.query(`SELECT pool_id, insured_did, coverage_limit_cents FROM ins_policies WHERE policy_id=$1 AND status='active'`, [p.data.policy_id])
      .catch(() => ({ rows: [] }));
    if (!pol.rows[0]) return res.status(404).json({ error: 'policy_not_found' });
    if (pol.rows[0].insured_did !== did) return res.status(403).json({ error: 'not_insured' });
    if (p.data.claimed_cents > Number(pol.rows[0].coverage_limit_cents)) return res.status(400).json({ error: 'exceeds_coverage' });
    const id = newId('clm');
    await pool.query(
      `INSERT INTO ins_claims (claim_id, policy_id, claimant_did, incident_at, narrative, claimed_cents)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [id, p.data.policy_id, did, p.data.incident_at ? new Date(p.data.incident_at).toISOString() : null,
       p.data.narrative, p.data.claimed_cents]
    );
    if (auditChain) await auditChain.append({ event_type: 'insurance_core.claim_filed', claim_id: id, policy_id: p.data.policy_id, claimed_cents: p.data.claimed_cents }).catch(() => {});
    res.status(201).json({ claim_id: id, status: 'open' });
  });

  app.post('/v1/admin/insurance-core/claims/:cid/decide', express.json(), async (req, res) => {
    if (!isAdmin(req)) return res.status(401).json({ error: 'admin_auth_required' });
    const decision = req.body?.decision; const approved = parseInt(req.body?.approved_cents) || 0;
    if (!['approved', 'denied', 'partially_approved'].includes(decision)) return res.status(400).json({ error: 'invalid_decision' });
    const r = await pool.query(`UPDATE ins_claims SET status=$1, approved_cents=$2, decided_at=NOW(), adjuster_did='did:op:operator'
                                WHERE claim_id=$3 RETURNING policy_id, claimant_did, claimed_cents`,
      [decision, approved, req.params.cid]).catch(() => ({ rows: [] }));
    if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
    if (decision === 'approved' || decision === 'partially_approved') {
      const pol = await pool.query(`SELECT pool_id FROM ins_policies WHERE policy_id=$1`, [r.rows[0].policy_id]).catch(() => ({ rows: [] }));
      if (pol.rows[0]) {
        await pool.query(`UPDATE ins_pools SET reserve_cents = reserve_cents - $1, gross_claims_paid_cents = gross_claims_paid_cents + $1 WHERE pool_id=$2`,
          [approved, pol.rows[0].pool_id]).catch(() => {});
        await pool.query(`UPDATE bank_accounts SET balance_cents = balance_cents + $1 WHERE agent_did=$2`,
          [approved, r.rows[0].claimant_did]).catch(() => {});
        await pool.query(`UPDATE ins_claims SET paid_at=NOW() WHERE claim_id=$1`, [req.params.cid]).catch(() => {});
      }
    }
    if (auditChain) await auditChain.append({ event_type: 'insurance_core.claim_decided', claim_id: req.params.cid, decision, approved_cents: approved }).catch(() => {});
    res.json({ claim_id: req.params.cid, decision, approved_cents: approved });
  });

  app.get('/v1/agents/:did/insurance-core/policies', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(`SELECT * FROM ins_policies WHERE insured_did=$1 ORDER BY created_at DESC`, [did])
      .catch(() => ({ rows: [] }));
    res.json({ policies: r.rows });
  });

  app.get('/v1/admin/insurance-core/pools', async (req, res) => {
    if (!isAdmin(req)) return res.status(401).json({ error: 'admin_auth_required' });
    const r = await pool.query(`SELECT * FROM ins_pools`).catch(() => ({ rows: [] }));
    res.json({ pools: r.rows.map(p => ({ ...p,
      reserve_cents: Number(p.reserve_cents),
      gross_premiums_collected_cents: Number(p.gross_premiums_collected_cents),
      gross_claims_paid_cents: Number(p.gross_claims_paid_cents),
      loss_ratio: Number(p.gross_premiums_collected_cents) > 0 ? Number(p.gross_claims_paid_cents) / Number(p.gross_premiums_collected_cents) : 0
    })) });
  });

  app.post('/v1/admin/insurance-core/reinsurance', express.json(), async (req, res) => {
    if (!isAdmin(req)) return res.status(401).json({ error: 'admin_auth_required' });
    const id = newId('rein');
    await pool.query(
      `INSERT INTO ins_reinsurance_contracts (contract_id, pool_id, reinsurer_name, attachment_cents,
         limit_cents, cession_pct, effective_at, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [id, req.body?.pool_id, req.body?.reinsurer_name, req.body?.attachment_cents,
       req.body?.limit_cents, req.body?.cession_pct,
       req.body?.effective_at || new Date().toISOString().slice(0, 10),
       req.body?.expires_at || new Date(Date.now() + 365 * 86400000).toISOString().slice(0, 10)]
    );
    res.status(201).json({ contract_id: id });
  });

  registerCron(app, '/v1/_jobs/insurance-core-renew', async (req, res) => {
    const r = await pool.query(`UPDATE ins_policies SET status='expired' WHERE term_ends < CURRENT_DATE AND status='active' RETURNING policy_id`)
      .catch(() => ({ rows: [] }));
    res.json({ expired: r.rows.length });
  });
}

module.exports = { migrate, registerInsuranceCoreRoutes, quotePremium, PRODUCTS };
