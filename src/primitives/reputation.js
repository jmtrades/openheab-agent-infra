// ============================================================================
// OpenHeab Reputation — Stake-backed vouching graph with disputes
// Vouches, stakes (bank-held), disputes, computed scores per domain.
// ============================================================================
const express = require('express');
const cryptoLib = require('crypto');
const { z } = require('zod');

// ----------------------------------------------------------------------------
// Migration
// ----------------------------------------------------------------------------
async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS reputation_vouches (
      vouch_id           TEXT PRIMARY KEY,
      voucher_did        TEXT NOT NULL,
      target_did         TEXT NOT NULL,
      domain             TEXT NOT NULL,
      weight             REAL NOT NULL DEFAULT 1.0,
      reason             TEXT,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      revoked_at         TIMESTAMPTZ,
      audit_chain_entry  TEXT,
      UNIQUE (voucher_did, target_did, domain)
    );
    CREATE INDEX IF NOT EXISTS idx_rep_vouches_target ON reputation_vouches (target_did, domain) WHERE revoked_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_rep_vouches_voucher ON reputation_vouches (voucher_did) WHERE revoked_at IS NULL;

    CREATE TABLE IF NOT EXISTS reputation_stakes (
      stake_id           TEXT PRIMARY KEY,
      agent_did          TEXT NOT NULL,
      domain             TEXT NOT NULL,
      amount_cents       BIGINT NOT NULL,
      currency           TEXT NOT NULL DEFAULT 'USD',
      bank_hold_id       TEXT,
      status             TEXT NOT NULL DEFAULT 'active',
      slash_amount_cents BIGINT,
      audit_chain_entry  TEXT,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      resolved_at        TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_rep_stakes_agent ON reputation_stakes (agent_did, domain, status);

    CREATE TABLE IF NOT EXISTS reputation_disputes (
      dispute_id              TEXT PRIMARY KEY,
      complainant_did         TEXT NOT NULL,
      respondent_did          TEXT NOT NULL,
      domain                  TEXT NOT NULL,
      category                TEXT,
      description             TEXT,
      evidence                JSONB,
      related_txn             TEXT,
      requested_damages_cents BIGINT,
      status                  TEXT NOT NULL DEFAULT 'open',
      resolution              TEXT,
      resolver_did            TEXT,
      created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      resolved_at             TIMESTAMPTZ,
      audit_chain_entry       TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_rep_disputes_resp ON reputation_disputes (respondent_did, status);
    CREATE INDEX IF NOT EXISTS idx_rep_disputes_comp ON reputation_disputes (complainant_did);

    CREATE TABLE IF NOT EXISTS reputation_scores (
      agent_did            TEXT NOT NULL,
      domain               TEXT NOT NULL,
      score                REAL NOT NULL DEFAULT 0.3,
      vouch_count          INTEGER NOT NULL DEFAULT 0,
      weighted_vouches     REAL NOT NULL DEFAULT 0,
      stake_amount_cents   BIGINT NOT NULL DEFAULT 0,
      successful_actions   INTEGER NOT NULL DEFAULT 0,
      disputes_open        INTEGER NOT NULL DEFAULT 0,
      disputes_upheld      INTEGER NOT NULL DEFAULT 0,
      last_computed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (agent_did, domain)
    );
    CREATE INDEX IF NOT EXISTS idx_rep_scores_score ON reputation_scores (score DESC);
  `).catch(() => {});
}

// ----------------------------------------------------------------------------
// Idempotency helpers
// ----------------------------------------------------------------------------
async function checkIdempotency(pool, agentDid, key, scope) {
  if (!key) return null;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS reputation_idempotency (
      agent_did TEXT NOT NULL,
      scope TEXT NOT NULL,
      idem_key TEXT NOT NULL,
      response JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (agent_did, scope, idem_key)
    )`).catch(() => {});
  const r = await pool.query(
    `SELECT response FROM reputation_idempotency WHERE agent_did=$1 AND scope=$2 AND idem_key=$3`,
    [agentDid, scope, key]
  ).catch(() => ({ rows: [] }));
  return r.rows[0]?.response || null;
}

async function recordIdempotency(pool, agentDid, key, scope, response) {
  if (!key) return;
  await pool.query(
    `INSERT INTO reputation_idempotency (agent_did, scope, idem_key, response)
     VALUES ($1,$2,$3,$4::jsonb) ON CONFLICT DO NOTHING`,
    [agentDid, scope, key, JSON.stringify(response)]
  ).catch(() => {});
}

// ----------------------------------------------------------------------------
// Compute score for an agent in a domain
// score 0..1 = base 0.3 + vouches (max 0.4) + stake (max 0.3) + dispute penalty
// ----------------------------------------------------------------------------
async function computeScore(pool, did, domain) {
  const vouchR = await pool.query(
    `SELECT COUNT(*)::int AS n, COALESCE(SUM(weight), 0)::real AS w
     FROM reputation_vouches
     WHERE target_did = $1 AND domain = $2 AND revoked_at IS NULL`,
    [did, domain]
  ).catch(() => ({ rows: [{ n: 0, w: 0 }] }));

  const stakeR = await pool.query(
    `SELECT COALESCE(SUM(amount_cents), 0)::bigint AS total
     FROM reputation_stakes
     WHERE agent_did = $1 AND domain = $2 AND status = 'active'`,
    [did, domain]
  ).catch(() => ({ rows: [{ total: 0 }] }));

  const dispR = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE status='open')::int AS open_n,
       COUNT(*) FILTER (WHERE status='upheld')::int AS upheld_n
     FROM reputation_disputes
     WHERE respondent_did = $1 AND domain = $2`,
    [did, domain]
  ).catch(() => ({ rows: [{ open_n: 0, upheld_n: 0 }] }));

  const vouchCount = parseInt(vouchR.rows[0]?.n || 0);
  const weighted = parseFloat(vouchR.rows[0]?.w || 0);
  const stakeAmt = parseInt(stakeR.rows[0]?.total || 0);
  const openN = parseInt(dispR.rows[0]?.open_n || 0);
  const upheldN = parseInt(dispR.rows[0]?.upheld_n || 0);

  // vouch component: tanh-ish saturation, max 0.4
  const vouchComp = Math.min(0.4, Math.log10(1 + weighted) * 0.2);
  // stake component: log-scale in dollars, max 0.3
  const stakeDollars = stakeAmt / 100;
  const stakeComp = Math.min(0.3, Math.log10(1 + stakeDollars) * 0.1);
  // dispute penalty
  const penalty = upheldN * 0.1 + openN * 0.02;

  let score = 0.3 + vouchComp + stakeComp - penalty;
  if (score < 0) score = 0;
  if (score > 1) score = 1;

  await pool.query(`
    INSERT INTO reputation_scores
      (agent_did, domain, score, vouch_count, weighted_vouches, stake_amount_cents,
       disputes_open, disputes_upheld, last_computed_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
    ON CONFLICT (agent_did, domain) DO UPDATE SET
      score = EXCLUDED.score,
      vouch_count = EXCLUDED.vouch_count,
      weighted_vouches = EXCLUDED.weighted_vouches,
      stake_amount_cents = EXCLUDED.stake_amount_cents,
      disputes_open = EXCLUDED.disputes_open,
      disputes_upheld = EXCLUDED.disputes_upheld,
      last_computed_at = NOW()
  `, [did, domain, score, vouchCount, weighted, stakeAmt, openN, upheldN]).catch(() => {});

  return {
    agent_did: did,
    domain,
    score,
    vouch_count: vouchCount,
    weighted_vouches: weighted,
    stake_amount_cents: stakeAmt,
    disputes_open: openN,
    disputes_upheld: upheldN,
    breakdown: {
      base: 0.3,
      vouches: vouchComp,
      stake: stakeComp,
      penalty: -penalty
    }
  };
}

// ----------------------------------------------------------------------------
// Routes
// ----------------------------------------------------------------------------
function registerReputationRoutes(app, pool, verifyAgentAuth, verifyAdminAuth, auditChain, bankModule) {
  // --------------------------------------------------------------------------
  // POST /v1/agents/:did/reputation/vouch/:targetDid
  // --------------------------------------------------------------------------
  const VouchSchema = z.object({
    domain: z.string().min(1).max(64),
    weight: z.number().min(0).max(10).optional(),
    reason: z.string().max(2000).optional()
  });

  app.post('/v1/agents/:did/reputation/vouch/:targetDid', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const target = req.params.targetDid;
      const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      if (did === target) return res.status(400).json({ error: 'cannot_vouch_self' });

      const parse = VouchSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });

      const idemKey = req.headers['x-idempotency-key'];
      const cached = await checkIdempotency(pool, did, idemKey, `vouch:${target}`);
      if (cached) return res.json(cached);

      const { domain, weight, reason } = parse.data;
      const vouchId = 'vch_' + cryptoLib.randomBytes(12).toString('hex');

      const chainEntry = await auditChain.append({
        event_type: 'reputation.vouch_created',
        vouch_id: vouchId,
        voucher_did: did,
        target_did: target,
        domain,
        weight: weight ?? 1.0,
        timestamp: new Date().toISOString()
      });

      const ins = await pool.query(`
        INSERT INTO reputation_vouches
          (vouch_id, voucher_did, target_did, domain, weight, reason, audit_chain_entry)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (voucher_did, target_did, domain) DO UPDATE SET
          weight = EXCLUDED.weight,
          reason = EXCLUDED.reason,
          revoked_at = NULL
        RETURNING vouch_id, voucher_did, target_did, domain, weight, reason, created_at
      `, [vouchId, did, target, domain, weight ?? 1.0, reason || null, chainEntry.hash]);

      // Recompute target score
      await computeScore(pool, target, domain).catch(() => {});

      const response = { ...ins.rows[0], audit_chain_entry: chainEntry.hash };
      await recordIdempotency(pool, did, idemKey, `vouch:${target}`, response);
      return res.status(201).json(response);
    } catch (e) {
      console.error('[reputation.vouch]', e);
      return res.status(500).json({ error: 'vouch_failed', message: e.message });
    }
  });

  // --------------------------------------------------------------------------
  // DELETE /v1/agents/:did/reputation/vouch/:targetDid
  // --------------------------------------------------------------------------
  app.delete('/v1/agents/:did/reputation/vouch/:targetDid', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const target = req.params.targetDid;
      const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const domain = req.query.domain || (req.body || {}).domain;
      if (!domain) return res.status(400).json({ error: 'domain_required' });

      const r = await pool.query(
        `UPDATE reputation_vouches SET revoked_at = NOW()
         WHERE voucher_did=$1 AND target_did=$2 AND domain=$3 AND revoked_at IS NULL
         RETURNING vouch_id`,
        [did, target, domain]
      );
      if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });

      await auditChain.append({
        event_type: 'reputation.vouch_revoked',
        vouch_id: r.rows[0].vouch_id,
        voucher_did: did,
        target_did: target,
        domain,
        timestamp: new Date().toISOString()
      });

      await computeScore(pool, target, domain).catch(() => {});
      return res.json({ vouch_id: r.rows[0].vouch_id, revoked: true });
    } catch (e) {
      console.error('[reputation.vouch.revoke]', e);
      return res.status(500).json({ error: 'revoke_failed', message: e.message });
    }
  });

  // --------------------------------------------------------------------------
  // GET /v1/reputation/:did — overall (per-domain) snapshot
  // --------------------------------------------------------------------------
  app.get('/v1/reputation/:did', async (req, res) => {
    const did = req.params.did;
    const domain = req.query.domain;
    if (domain) {
      const r = await computeScore(pool, did, String(domain));
      return res.json(r);
    }
    const rows = await pool.query(
      `SELECT * FROM reputation_scores WHERE agent_did = $1 ORDER BY score DESC`,
      [did]
    ).catch(() => ({ rows: [] }));
    return res.json({ agent_did: did, scores: rows.rows, count: rows.rows.length });
  });

  // --------------------------------------------------------------------------
  // GET /v1/reputation/:did/breakdown
  // --------------------------------------------------------------------------
  app.get('/v1/reputation/:did/breakdown', async (req, res) => {
    const did = req.params.did;
    const domain = req.query.domain || 'general';

    const vouches = await pool.query(
      `SELECT vouch_id, voucher_did, weight, reason, created_at
       FROM reputation_vouches
       WHERE target_did = $1 AND domain = $2 AND revoked_at IS NULL
       ORDER BY created_at DESC LIMIT 200`,
      [did, domain]
    ).catch(() => ({ rows: [] }));

    const stakes = await pool.query(
      `SELECT stake_id, amount_cents, currency, status, created_at
       FROM reputation_stakes
       WHERE agent_did = $1 AND domain = $2
       ORDER BY created_at DESC LIMIT 200`,
      [did, domain]
    ).catch(() => ({ rows: [] }));

    const disputes = await pool.query(
      `SELECT dispute_id, complainant_did, category, status, created_at, resolved_at
       FROM reputation_disputes
       WHERE respondent_did = $1 AND domain = $2
       ORDER BY created_at DESC LIMIT 200`,
      [did, domain]
    ).catch(() => ({ rows: [] }));

    const score = await computeScore(pool, did, String(domain));
    return res.json({
      agent_did: did,
      domain,
      score: score.score,
      breakdown: score.breakdown,
      vouches: vouches.rows,
      stakes: stakes.rows,
      disputes: disputes.rows
    });
  });

  // --------------------------------------------------------------------------
  // POST /v1/agents/:did/reputation/stake
  // --------------------------------------------------------------------------
  const StakeSchema = z.object({
    domain: z.string().min(1).max(64),
    amount_cents: z.number().int().positive(),
    currency: z.string().length(3).optional(),
    description: z.string().max(500).optional()
  });

  app.post('/v1/agents/:did/reputation/stake', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const parse = StakeSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });

      const idemKey = req.headers['x-idempotency-key'];
      const cached = await checkIdempotency(pool, did, idemKey, 'stake-create');
      if (cached) return res.json(cached);

      const { domain, amount_cents, currency, description } = parse.data;
      const stakeId = 'stk_' + cryptoLib.randomBytes(12).toString('hex');
      let bankHoldId = null;

      if (bankModule && typeof bankModule.handleHold === 'function') {
        try {
          const hold = await bankModule.handleHold(pool, {
            agent_did: did,
            amount_cents,
            currency: currency || 'USD',
            reason: 'reputation_stake',
            external_ref: stakeId,
            description: description || `Reputation stake for ${domain}`
          }, auditChain);
          bankHoldId = hold?.hold_id || hold?.id || null;
        } catch (e) {
          return res.status(400).json({ error: 'hold_failed', message: e.message });
        }
      }

      const chainEntry = await auditChain.append({
        event_type: 'reputation.stake_created',
        stake_id: stakeId,
        agent_did: did,
        domain,
        amount_cents,
        currency: currency || 'USD',
        bank_hold_id: bankHoldId,
        timestamp: new Date().toISOString()
      });

      await pool.query(
        `INSERT INTO reputation_stakes
          (stake_id, agent_did, domain, amount_cents, currency, bank_hold_id, status, audit_chain_entry)
         VALUES ($1, $2, $3, $4, $5, $6, 'active', $7)`,
        [stakeId, did, domain, amount_cents, currency || 'USD', bankHoldId, chainEntry.hash]
      );

      await computeScore(pool, did, domain).catch(() => {});

      const response = {
        stake_id: stakeId,
        agent_did: did,
        domain,
        amount_cents,
        currency: currency || 'USD',
        bank_hold_id: bankHoldId,
        status: 'active',
        audit_chain_entry: chainEntry.hash
      };
      await recordIdempotency(pool, did, idemKey, 'stake-create', response);
      return res.status(201).json(response);
    } catch (e) {
      console.error('[reputation.stake]', e);
      return res.status(500).json({ error: 'stake_failed', message: e.message });
    }
  });

  // --------------------------------------------------------------------------
  // POST /v1/agents/:did/reputation/stake/:stakeId/unstake
  // --------------------------------------------------------------------------
  app.post('/v1/agents/:did/reputation/stake/:stakeId/unstake', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const stakeId = req.params.stakeId;
      const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const stakeR = await pool.query(
        `SELECT * FROM reputation_stakes WHERE stake_id=$1 AND agent_did=$2`,
        [stakeId, did]
      );
      if (!stakeR.rows[0]) return res.status(404).json({ error: 'not_found' });
      const stake = stakeR.rows[0];
      if (stake.status !== 'active') return res.status(400).json({ error: 'stake_not_active', status: stake.status });

      // Check open disputes block unstake
      const openDispR = await pool.query(
        `SELECT COUNT(*)::int AS n FROM reputation_disputes
         WHERE respondent_did = $1 AND domain = $2 AND status IN ('open', 'under_review')`,
        [did, stake.domain]
      ).catch(() => ({ rows: [{ n: 0 }] }));
      if (parseInt(openDispR.rows[0].n) > 0) {
        return res.status(400).json({ error: 'has_open_disputes' });
      }

      if (bankModule && typeof bankModule.handleHoldRelease === 'function' && stake.bank_hold_id) {
        try {
          await bankModule.handleHoldRelease(pool, {
            hold_id: stake.bank_hold_id,
            agent_did: did,
            reason: 'stake_released'
          }, auditChain);
        } catch (e) {
          console.warn('[reputation.unstake] release failed:', e.message);
        }
      }

      const chainEntry = await auditChain.append({
        event_type: 'reputation.stake_released',
        stake_id: stakeId,
        agent_did: did,
        timestamp: new Date().toISOString()
      });

      await pool.query(
        `UPDATE reputation_stakes SET status='released', resolved_at=NOW(),
                                      audit_chain_entry=$2 WHERE stake_id=$1`,
        [stakeId, chainEntry.hash]
      );

      await computeScore(pool, did, stake.domain).catch(() => {});
      return res.json({ stake_id: stakeId, status: 'released', audit_chain_entry: chainEntry.hash });
    } catch (e) {
      console.error('[reputation.unstake]', e);
      return res.status(500).json({ error: 'unstake_failed', message: e.message });
    }
  });

  // --------------------------------------------------------------------------
  // POST /v1/agents/:did/reputation/dispute
  // --------------------------------------------------------------------------
  const DisputeSchema = z.object({
    respondent_did: z.string().min(3),
    domain: z.string().min(1).max(64),
    category: z.string().max(64).optional(),
    description: z.string().max(10000),
    evidence: z.any().optional(),
    related_txn: z.string().max(200).optional(),
    requested_damages_cents: z.number().int().nonnegative().optional()
  });

  app.post('/v1/agents/:did/reputation/dispute', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const parse = DisputeSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      if (parse.data.respondent_did === did) return res.status(400).json({ error: 'cannot_dispute_self' });

      const idemKey = req.headers['x-idempotency-key'];
      const cached = await checkIdempotency(pool, did, idemKey, 'dispute-create');
      if (cached) return res.json(cached);

      const disputeId = 'dsp_' + cryptoLib.randomBytes(12).toString('hex');

      const chainEntry = await auditChain.append({
        event_type: 'reputation.dispute_opened',
        dispute_id: disputeId,
        complainant_did: did,
        respondent_did: parse.data.respondent_did,
        domain: parse.data.domain,
        category: parse.data.category || null,
        timestamp: new Date().toISOString()
      });

      await pool.query(
        `INSERT INTO reputation_disputes
          (dispute_id, complainant_did, respondent_did, domain, category, description,
           evidence, related_txn, requested_damages_cents, status, audit_chain_entry)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, 'open', $10)`,
        [disputeId, did, parse.data.respondent_did, parse.data.domain,
         parse.data.category || null, parse.data.description,
         parse.data.evidence ? JSON.stringify(parse.data.evidence) : null,
         parse.data.related_txn || null, parse.data.requested_damages_cents || null,
         chainEntry.hash]
      );

      await computeScore(pool, parse.data.respondent_did, parse.data.domain).catch(() => {});

      const response = {
        dispute_id: disputeId,
        complainant_did: did,
        respondent_did: parse.data.respondent_did,
        domain: parse.data.domain,
        status: 'open',
        audit_chain_entry: chainEntry.hash
      };
      await recordIdempotency(pool, did, idemKey, 'dispute-create', response);
      return res.status(201).json(response);
    } catch (e) {
      console.error('[reputation.dispute]', e);
      return res.status(500).json({ error: 'dispute_failed', message: e.message });
    }
  });

  // --------------------------------------------------------------------------
  // POST /v1/disputes/:disputeId/resolve (admin only)
  // --------------------------------------------------------------------------
  const ResolveSchema = z.object({
    status: z.enum(['dismissed', 'upheld', 'partial', 'settled']),
    resolution: z.string().max(10000),
    slash_amount_cents: z.number().int().nonnegative().optional()
  });

  app.post('/v1/disputes/:disputeId/resolve', express.json(), async (req, res) => {
    try {
      const adminAuth = await verifyAdminAuth(req);
      if (!adminAuth.valid) return res.status(401).json({ error: 'admin_required' });

      const disputeId = req.params.disputeId;
      const parse = ResolveSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });

      const dispR = await pool.query(
        `SELECT * FROM reputation_disputes WHERE dispute_id=$1`, [disputeId]
      );
      if (!dispR.rows[0]) return res.status(404).json({ error: 'not_found' });
      const dispute = dispR.rows[0];
      if (['dismissed', 'upheld', 'partial', 'settled'].includes(dispute.status)) {
        return res.status(400).json({ error: 'already_resolved', status: dispute.status });
      }

      const chainEntry = await auditChain.append({
        event_type: 'reputation.dispute_resolved',
        dispute_id: disputeId,
        status: parse.data.status,
        resolver_did: adminAuth.did,
        slash_amount_cents: parse.data.slash_amount_cents || 0,
        timestamp: new Date().toISOString()
      });

      await pool.query(
        `UPDATE reputation_disputes SET status=$2, resolution=$3, resolver_did=$4,
                                       resolved_at=NOW(), audit_chain_entry=$5
         WHERE dispute_id=$1`,
        [disputeId, parse.data.status, parse.data.resolution, adminAuth.did, chainEntry.hash]
      );

      // If upheld/partial, slash respondent's active stake(s) in that domain
      if ((parse.data.status === 'upheld' || parse.data.status === 'partial') &&
          parse.data.slash_amount_cents) {
        const stakesR = await pool.query(
          `SELECT stake_id, amount_cents, bank_hold_id FROM reputation_stakes
           WHERE agent_did=$1 AND domain=$2 AND status='active'
           ORDER BY created_at ASC`,
          [dispute.respondent_did, dispute.domain]
        );
        let remaining = parse.data.slash_amount_cents;
        for (const s of stakesR.rows) {
          if (remaining <= 0) break;
          const slash = Math.min(remaining, parseInt(s.amount_cents));
          const isFullSlash = slash >= parseInt(s.amount_cents);
          await pool.query(
            `UPDATE reputation_stakes SET status=$2, slash_amount_cents=$3, resolved_at=NOW()
             WHERE stake_id=$1`,
            [s.stake_id, isFullSlash ? 'slashed' : 'partial_slash', slash]
          );
          remaining -= slash;
        }
      }

      await computeScore(pool, dispute.respondent_did, dispute.domain).catch(() => {});
      return res.json({
        dispute_id: disputeId,
        status: parse.data.status,
        resolver_did: adminAuth.did,
        audit_chain_entry: chainEntry.hash
      });
    } catch (e) {
      console.error('[reputation.dispute.resolve]', e);
      return res.status(500).json({ error: 'resolve_failed', message: e.message });
    }
  });
}

module.exports = {
  migrate,
  registerReputationRoutes,
  computeScore
};
