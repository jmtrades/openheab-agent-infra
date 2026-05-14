// ============================================================================
// OpenHeab Insurance — Stake-pool self-insurance with arbitrator voting
// ============================================================================
const express = require('express');
const cryptoLib = require('crypto');
const { z } = require('zod');

const ARBITRATOR_MIN_REPUTATION = 0.7;
const QUORUM = 3;

const POOL_CATEGORIES = ['payments', 'inference', 'data', 'compliance', 'general'];
const POLICY_STATUSES = ['active', 'lapsed', 'cancelled'];
const CLAIM_STATUSES = ['open', 'voting', 'approved', 'denied', 'paid'];

// ----------------------------------------------------------------------------
// Migration
// ----------------------------------------------------------------------------
async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS insurance_pools (
      slug                      TEXT PRIMARY KEY,
      name                      TEXT NOT NULL,
      description               TEXT,
      category                  TEXT NOT NULL,
      max_payout_cents          BIGINT NOT NULL DEFAULT 0,
      premium_bps               INTEGER NOT NULL DEFAULT 200,
      reserve_cents             BIGINT NOT NULL DEFAULT 0,
      total_premiums_cents      BIGINT NOT NULL DEFAULT 0,
      total_claims_paid_cents   BIGINT NOT NULL DEFAULT 0,
      operator_did              TEXT NOT NULL,
      created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS insurance_underwriters (
      pool_slug                 TEXT NOT NULL,
      underwriter_did           TEXT NOT NULL,
      stake_cents               BIGINT NOT NULL DEFAULT 0,
      earned_premiums_cents     BIGINT NOT NULL DEFAULT 0,
      paid_claims_cents         BIGINT NOT NULL DEFAULT 0,
      created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (pool_slug, underwriter_did)
    );

    CREATE TABLE IF NOT EXISTS insurance_policies (
      policy_id        TEXT PRIMARY KEY,
      pool_slug        TEXT NOT NULL,
      insured_did      TEXT NOT NULL,
      coverage_cents   BIGINT NOT NULL,
      premium_cents    BIGINT NOT NULL,
      status           TEXT NOT NULL DEFAULT 'active',
      starts_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      renews_at        TIMESTAMPTZ NOT NULL,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_insurance_policies_insured ON insurance_policies (insured_did);
    CREATE INDEX IF NOT EXISTS idx_insurance_policies_renews ON insurance_policies (renews_at) WHERE status='active';

    CREATE TABLE IF NOT EXISTS insurance_claims (
      claim_id           TEXT PRIMARY KEY,
      policy_id          TEXT NOT NULL,
      claimant_did       TEXT NOT NULL,
      counterparty_did   TEXT,
      amount_cents       BIGINT NOT NULL,
      reason             TEXT NOT NULL,
      evidence_url       TEXT,
      status             TEXT NOT NULL DEFAULT 'open',
      yes_votes          INTEGER NOT NULL DEFAULT 0,
      no_votes           INTEGER NOT NULL DEFAULT 0,
      paid_at            TIMESTAMPTZ,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_insurance_claims_policy ON insurance_claims (policy_id);
    CREATE INDEX IF NOT EXISTS idx_insurance_claims_status ON insurance_claims (status);

    CREATE TABLE IF NOT EXISTS insurance_votes (
      claim_id          TEXT NOT NULL,
      arbitrator_did    TEXT NOT NULL,
      decision          TEXT NOT NULL,
      rationale         TEXT,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (claim_id, arbitrator_did)
    );
  `).catch(() => {});
}

function genId(prefix) {
  return `${prefix}_${cryptoLib.randomBytes(12).toString('hex')}`;
}

async function getReputation(pool, did) {
  const r = await pool.query(
    `SELECT COALESCE(MAX(score), 0)::real AS score FROM reputation_scores WHERE agent_did=$1`,
    [did]
  ).catch(() => ({ rows: [{ score: 0 }] }));
  return parseFloat(r.rows[0].score || 0);
}

// ----------------------------------------------------------------------------
// Pay claim — pro-rata deduction from underwriters
// ----------------------------------------------------------------------------
async function payClaim(pool, claimId, auditChain) {
  const claim = await pool.query(
    `SELECT c.claim_id, c.amount_cents, c.status, c.policy_id, c.claimant_did,
            p.pool_slug
     FROM insurance_claims c
     JOIN insurance_policies p ON p.policy_id = c.policy_id
     WHERE c.claim_id=$1`,
    [claimId]
  ).catch(() => ({ rows: [] }));
  if (!claim.rows[0]) return { error: 'claim_not_found' };
  const cl = claim.rows[0];
  if (cl.status === 'paid') return { already_paid: true };

  const underwriters = await pool.query(
    `SELECT underwriter_did, stake_cents FROM insurance_underwriters
     WHERE pool_slug=$1 AND stake_cents > 0`,
    [cl.pool_slug]
  ).catch(() => ({ rows: [] }));

  const totalStake = underwriters.rows.reduce((s, u) => s + parseInt(u.stake_cents || 0), 0);
  if (totalStake <= 0) {
    await pool.query(`UPDATE insurance_claims SET status='denied' WHERE claim_id=$1`, [claimId]);
    return { error: 'no_underwriter_stake' };
  }

  const amount = parseInt(cl.amount_cents);
  let paidFromStakes = 0;
  for (const u of underwriters.rows) {
    const stake = parseInt(u.stake_cents || 0);
    const share = Math.floor((stake * amount) / totalStake);
    const deduct = Math.min(stake, share);
    await pool.query(
      `UPDATE insurance_underwriters
         SET stake_cents = stake_cents - $1, paid_claims_cents = paid_claims_cents + $1
       WHERE pool_slug=$2 AND underwriter_did=$3`,
      [deduct, cl.pool_slug, u.underwriter_did]
    ).catch(() => {});
    paidFromStakes += deduct;
  }

  await pool.query(
    `UPDATE insurance_pools
       SET total_claims_paid_cents = total_claims_paid_cents + $1,
           reserve_cents = GREATEST(reserve_cents - $1, 0)
     WHERE slug=$2`,
    [paidFromStakes, cl.pool_slug]
  ).catch(() => {});

  await pool.query(
    `UPDATE insurance_claims SET status='paid', paid_at=NOW() WHERE claim_id=$1`,
    [claimId]
  );

  if (auditChain) {
    await auditChain.append({
      event_type: 'insurance.claim_paid',
      claim_id: claimId, pool_slug: cl.pool_slug,
      claimant_did: cl.claimant_did, amount_paid_cents: paidFromStakes,
      timestamp: new Date().toISOString()
    });
  }

  return { paid: true, amount_paid_cents: paidFromStakes };
}

// ----------------------------------------------------------------------------
// Routes
// ----------------------------------------------------------------------------
function registerInsuranceRoutes(app, pool, verifyAgentAuth, auditChain) {
  // POST /v1/insurance/pools
  const PoolSchema = z.object({
    slug: z.string().min(1).max(80).regex(/^[a-z0-9][a-z0-9-]*$/),
    name: z.string().min(1).max(200),
    description: z.string().max(4000).optional(),
    category: z.enum(POOL_CATEGORIES),
    max_payout_cents: z.number().int().nonnegative().default(0),
    premium_bps: z.number().int().positive().max(10000).default(200),
    operator_did: z.string()
  });

  app.post('/v1/insurance/pools', express.json(), async (req, res) => {
    try {
      const parse = PoolSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;
      const auth = await verifyAgentAuth(req, d.operator_did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const exists = await pool.query(`SELECT slug FROM insurance_pools WHERE slug=$1`, [d.slug])
        .catch(() => ({ rows: [] }));
      if (exists.rows[0]) return res.status(409).json({ error: 'slug_taken' });

      await pool.query(
        `INSERT INTO insurance_pools (slug, name, description, category,
           max_payout_cents, premium_bps, operator_did)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [d.slug, d.name, d.description || null, d.category,
         d.max_payout_cents, d.premium_bps, d.operator_did]
      );

      await auditChain.append({
        event_type: 'insurance.pool_created',
        slug: d.slug, operator_did: d.operator_did,
        timestamp: new Date().toISOString()
      });

      return res.status(201).json({ slug: d.slug, name: d.name, category: d.category });
    } catch (e) {
      console.error('[insurance.pool.create]', e);
      return res.status(500).json({ error: 'create_failed', message: e.message });
    }
  });

  // GET /v1/insurance/pools
  app.get('/v1/insurance/pools', async (req, res) => {
    const r = await pool.query(
      `SELECT slug, name, description, category, max_payout_cents,
              premium_bps, reserve_cents, total_premiums_cents,
              total_claims_paid_cents, operator_did, created_at
       FROM insurance_pools ORDER BY created_at DESC`
    ).catch(() => ({ rows: [] }));
    return res.json({ pools: r.rows, count: r.rows.length });
  });

  // GET /v1/insurance/pools/:slug
  app.get('/v1/insurance/pools/:slug', async (req, res) => {
    const r = await pool.query(
      `SELECT * FROM insurance_pools WHERE slug=$1`, [req.params.slug]
    ).catch(() => ({ rows: [] }));
    if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
    return res.json(r.rows[0]);
  });

  // POST /v1/insurance/pools/:slug/underwrite
  const UnderwriteSchema = z.object({
    underwriter_did: z.string(),
    stake_cents: z.number().int().positive()
  });

  app.post('/v1/insurance/pools/:slug/underwrite', express.json(), async (req, res) => {
    try {
      const slug = req.params.slug;
      const parse = UnderwriteSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;
      const auth = await verifyAgentAuth(req, d.underwriter_did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const exists = await pool.query(`SELECT slug FROM insurance_pools WHERE slug=$1`, [slug])
        .catch(() => ({ rows: [] }));
      if (!exists.rows[0]) return res.status(404).json({ error: 'pool_not_found' });

      await pool.query(
        `INSERT INTO insurance_underwriters (pool_slug, underwriter_did, stake_cents)
         VALUES ($1,$2,$3)
         ON CONFLICT (pool_slug, underwriter_did) DO UPDATE SET
           stake_cents = insurance_underwriters.stake_cents + EXCLUDED.stake_cents`,
        [slug, d.underwriter_did, d.stake_cents]
      );
      await pool.query(
        `UPDATE insurance_pools SET reserve_cents = reserve_cents + $1 WHERE slug=$2`,
        [d.stake_cents, slug]
      );

      await auditChain.append({
        event_type: 'insurance.underwritten',
        pool_slug: slug, underwriter_did: d.underwriter_did,
        stake_cents: d.stake_cents,
        timestamp: new Date().toISOString()
      });

      return res.status(201).json({
        pool_slug: slug, underwriter_did: d.underwriter_did, stake_cents: d.stake_cents
      });
    } catch (e) {
      console.error('[insurance.underwrite]', e);
      return res.status(500).json({ error: 'underwrite_failed', message: e.message });
    }
  });

  // POST /v1/insurance/pools/:slug/policies
  const PolicySchema = z.object({
    insured_did: z.string(),
    coverage_cents: z.number().int().positive(),
    term_days: z.number().int().positive().max(3650).default(365)
  });

  app.post('/v1/insurance/pools/:slug/policies', express.json(), async (req, res) => {
    try {
      const slug = req.params.slug;
      const parse = PolicySchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;
      const auth = await verifyAgentAuth(req, d.insured_did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const pr = await pool.query(
        `SELECT premium_bps, max_payout_cents FROM insurance_pools WHERE slug=$1`, [slug]
      ).catch(() => ({ rows: [] }));
      if (!pr.rows[0]) return res.status(404).json({ error: 'pool_not_found' });
      if (pr.rows[0].max_payout_cents && d.coverage_cents > pr.rows[0].max_payout_cents) {
        return res.status(400).json({ error: 'exceeds_max_payout' });
      }

      const premiumCents = Math.ceil(d.coverage_cents * pr.rows[0].premium_bps / 10000);
      const policyId = genId('ipol');
      const startsAt = new Date();
      const renewsAt = new Date(Date.now() + d.term_days * 24 * 60 * 60 * 1000);

      await pool.query(
        `INSERT INTO insurance_policies (policy_id, pool_slug, insured_did,
           coverage_cents, premium_cents, status, starts_at, renews_at)
         VALUES ($1,$2,$3,$4,$5,'active',$6,$7)`,
        [policyId, slug, d.insured_did, d.coverage_cents, premiumCents, startsAt, renewsAt]
      );
      await pool.query(
        `UPDATE insurance_pools
           SET total_premiums_cents = total_premiums_cents + $1,
               reserve_cents = reserve_cents + $1
         WHERE slug=$2`,
        [premiumCents, slug]
      );

      await auditChain.append({
        event_type: 'insurance.policy_issued',
        policy_id: policyId, pool_slug: slug, insured_did: d.insured_did,
        coverage_cents: d.coverage_cents, premium_cents: premiumCents,
        timestamp: new Date().toISOString()
      });

      return res.status(201).json({
        policy_id: policyId, pool_slug: slug, insured_did: d.insured_did,
        coverage_cents: d.coverage_cents, premium_cents: premiumCents,
        starts_at: startsAt, renews_at: renewsAt
      });
    } catch (e) {
      console.error('[insurance.policy.create]', e);
      return res.status(500).json({ error: 'create_failed', message: e.message });
    }
  });

  // GET /v1/agents/:did/insurance/policies
  app.get('/v1/agents/:did/insurance/policies', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(
      `SELECT policy_id, pool_slug, coverage_cents, premium_cents, status,
              starts_at, renews_at, created_at
       FROM insurance_policies WHERE insured_did=$1 ORDER BY created_at DESC`,
      [did]
    ).catch(() => ({ rows: [] }));
    return res.json({ policies: r.rows, count: r.rows.length });
  });

  // POST /v1/insurance/pools/:slug/claims
  const ClaimSchema = z.object({
    policy_id: z.string(),
    claimant_did: z.string(),
    counterparty_did: z.string().optional(),
    amount_cents: z.number().int().positive(),
    reason: z.string().min(1).max(4000),
    evidence_url: z.string().url().optional()
  });

  app.post('/v1/insurance/pools/:slug/claims', express.json(), async (req, res) => {
    try {
      const slug = req.params.slug;
      const parse = ClaimSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;
      const auth = await verifyAgentAuth(req, d.claimant_did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const pr = await pool.query(
        `SELECT policy_id, insured_did, coverage_cents, status, pool_slug
         FROM insurance_policies WHERE policy_id=$1`, [d.policy_id]
      ).catch(() => ({ rows: [] }));
      if (!pr.rows[0]) return res.status(404).json({ error: 'policy_not_found' });
      if (pr.rows[0].status !== 'active') return res.status(400).json({ error: 'policy_not_active' });
      if (pr.rows[0].pool_slug !== slug) return res.status(400).json({ error: 'pool_mismatch' });
      if (pr.rows[0].insured_did !== d.claimant_did) return res.status(403).json({ error: 'not_insured_party' });
      if (d.amount_cents > parseInt(pr.rows[0].coverage_cents)) {
        return res.status(400).json({ error: 'exceeds_coverage' });
      }

      const claimId = genId('iclm');
      await pool.query(
        `INSERT INTO insurance_claims (claim_id, policy_id, claimant_did, counterparty_did,
           amount_cents, reason, evidence_url, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'voting')`,
        [claimId, d.policy_id, d.claimant_did, d.counterparty_did || null,
         d.amount_cents, d.reason, d.evidence_url || null]
      );

      await auditChain.append({
        event_type: 'insurance.claim_filed',
        claim_id: claimId, policy_id: d.policy_id, pool_slug: slug,
        amount_cents: d.amount_cents,
        timestamp: new Date().toISOString()
      });

      return res.status(201).json({
        claim_id: claimId, policy_id: d.policy_id, status: 'voting',
        amount_cents: d.amount_cents
      });
    } catch (e) {
      console.error('[insurance.claim]', e);
      return res.status(500).json({ error: 'claim_failed', message: e.message });
    }
  });

  // POST /v1/insurance/claims/:id/vote
  const VoteSchema = z.object({
    arbitrator_did: z.string(),
    decision: z.enum(['approve', 'deny']),
    rationale: z.string().max(4000).optional()
  });

  app.post('/v1/insurance/claims/:id/vote', express.json(), async (req, res) => {
    try {
      const claimId = req.params.id;
      const parse = VoteSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;
      const auth = await verifyAgentAuth(req, d.arbitrator_did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const rep = await getReputation(pool, d.arbitrator_did);
      if (rep < ARBITRATOR_MIN_REPUTATION) {
        return res.status(403).json({ error: 'insufficient_reputation', reputation: rep, required: ARBITRATOR_MIN_REPUTATION });
      }

      const cl = await pool.query(`SELECT status FROM insurance_claims WHERE claim_id=$1`, [claimId])
        .catch(() => ({ rows: [] }));
      if (!cl.rows[0]) return res.status(404).json({ error: 'not_found' });
      if (!['open', 'voting'].includes(cl.rows[0].status)) {
        return res.status(400).json({ error: 'claim_not_open' });
      }

      const ins = await pool.query(
        `INSERT INTO insurance_votes (claim_id, arbitrator_did, decision, rationale)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (claim_id, arbitrator_did) DO NOTHING
         RETURNING claim_id`,
        [claimId, d.arbitrator_did, d.decision, d.rationale || null]
      ).catch(() => ({ rows: [] }));
      if (!ins.rows[0]) return res.status(409).json({ error: 'already_voted' });

      const field = d.decision === 'approve' ? 'yes_votes' : 'no_votes';
      await pool.query(
        `UPDATE insurance_claims SET ${field} = ${field} + 1, status='voting' WHERE claim_id=$1`,
        [claimId]
      );

      await auditChain.append({
        event_type: 'insurance.vote_cast',
        claim_id: claimId, arbitrator_did: d.arbitrator_did,
        decision: d.decision,
        timestamp: new Date().toISOString()
      });

      const updated = await pool.query(
        `SELECT yes_votes, no_votes FROM insurance_claims WHERE claim_id=$1`, [claimId]
      ).catch(() => ({ rows: [] }));

      let payResult = null;
      if (updated.rows[0] && updated.rows[0].yes_votes >= QUORUM) {
        await pool.query(`UPDATE insurance_claims SET status='approved' WHERE claim_id=$1`, [claimId]);
        payResult = await payClaim(pool, claimId, auditChain);
      } else if (updated.rows[0] && updated.rows[0].no_votes >= QUORUM) {
        await pool.query(`UPDATE insurance_claims SET status='denied' WHERE claim_id=$1`, [claimId]);
      }

      return res.json({
        claim_id: claimId, decision: d.decision,
        yes_votes: updated.rows[0]?.yes_votes || 0,
        no_votes: updated.rows[0]?.no_votes || 0,
        payment: payResult
      });
    } catch (e) {
      console.error('[insurance.vote]', e);
      return res.status(500).json({ error: 'vote_failed', message: e.message });
    }
  });

  // GET /v1/insurance/pools/:slug/stats
  app.get('/v1/insurance/pools/:slug/stats', async (req, res) => {
    const slug = req.params.slug;
    const p = await pool.query(`SELECT * FROM insurance_pools WHERE slug=$1`, [slug])
      .catch(() => ({ rows: [] }));
    if (!p.rows[0]) return res.status(404).json({ error: 'not_found' });
    const u = await pool.query(
      `SELECT COUNT(*)::int AS count, COALESCE(SUM(stake_cents)::bigint, 0) AS total_stake
       FROM insurance_underwriters WHERE pool_slug=$1`, [slug]
    ).catch(() => ({ rows: [{ count: 0, total_stake: 0 }] }));
    const policies = await pool.query(
      `SELECT status, COUNT(*)::int AS n FROM insurance_policies WHERE pool_slug=$1 GROUP BY status`,
      [slug]
    ).catch(() => ({ rows: [] }));
    const claims = await pool.query(
      `SELECT status, COUNT(*)::int AS n FROM insurance_claims c
        JOIN insurance_policies p ON p.policy_id = c.policy_id
       WHERE p.pool_slug=$1 GROUP BY status`,
      [slug]
    ).catch(() => ({ rows: [] }));

    return res.json({
      pool: p.rows[0],
      underwriters: u.rows[0],
      policies_by_status: policies.rows,
      claims_by_status: claims.rows
    });
  });

  // Cron: renewals
  const { registerCron } = require('../cron_auth');
  registerCron(app, '/v1/_jobs/insurance-renewals', async (req, res) => {
    try {
      const r = await pool.query(
        `UPDATE insurance_policies SET status='lapsed'
         WHERE status='active' AND renews_at < NOW() RETURNING policy_id`
      ).catch(() => ({ rows: [] }));
      if (r.rows.length && auditChain) {
        await auditChain.append({
          event_type: 'insurance.policies_lapsed',
          count: r.rows.length, timestamp: new Date().toISOString()
        });
      }
      res.json({ lapsed: r.rows.length });
    } catch (e) {
      res.status(500).json({ error: 'renewals_failed', message: e.message });
    }
  });
}

module.exports = {
  migrate,
  registerInsuranceRoutes,
  payClaim,
  ARBITRATOR_MIN_REPUTATION,
  QUORUM
};
