// ============================================================================
// OpenHeab Loyalty — Points programs for human customers of agents
// ============================================================================
const express = require('express');
const cryptoLib = require('crypto');
const { z } = require('zod');

const TX_KINDS = ['earn', 'redeem', 'expire', 'adjust'];
const SOURCE_KINDS = ['purchase', 'manual', 'birthday', 'anniversary', 'referral'];
const REWARD_KINDS = ['discount', 'product', 'upgrade', 'cash'];

async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS loyalty_programs (
      program_id        TEXT PRIMARY KEY,
      owner_did         TEXT NOT NULL,
      name              TEXT NOT NULL,
      point_currency    TEXT NOT NULL DEFAULT 'points',
      points_per_dollar REAL NOT NULL DEFAULT 1.0,
      tiers             JSONB DEFAULT '[]'::jsonb,
      active            BOOLEAN NOT NULL DEFAULT TRUE,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_loyalty_programs_owner ON loyalty_programs (owner_did);

    CREATE TABLE IF NOT EXISTS loyalty_members (
      membership_id    TEXT PRIMARY KEY,
      program_id       TEXT NOT NULL,
      member_did       TEXT,
      member_email     TEXT,
      name             TEXT,
      tier             TEXT,
      points_balance   BIGINT NOT NULL DEFAULT 0,
      lifetime_points  BIGINT NOT NULL DEFAULT 0,
      joined_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_activity_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_loyalty_members_program ON loyalty_members (program_id);
    CREATE INDEX IF NOT EXISTS idx_loyalty_members_email ON loyalty_members (member_email);
    CREATE INDEX IF NOT EXISTS idx_loyalty_members_did ON loyalty_members (member_did);

    CREATE TABLE IF NOT EXISTS loyalty_transactions (
      tx_id          TEXT PRIMARY KEY,
      membership_id  TEXT NOT NULL,
      kind           TEXT NOT NULL,
      points         BIGINT NOT NULL,
      source_kind    TEXT,
      source_ref     TEXT,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_loyalty_tx_membership ON loyalty_transactions (membership_id);

    CREATE TABLE IF NOT EXISTS loyalty_rewards (
      reward_id        TEXT PRIMARY KEY,
      program_id       TEXT NOT NULL,
      name             TEXT NOT NULL,
      kind             TEXT NOT NULL DEFAULT 'discount',
      value            JSONB DEFAULT '{}'::jsonb,
      points_cost      BIGINT NOT NULL DEFAULT 0,
      max_redemptions  INTEGER,
      redemptions      INTEGER NOT NULL DEFAULT 0,
      active           BOOLEAN NOT NULL DEFAULT TRUE,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_loyalty_rewards_program ON loyalty_rewards (program_id);
  `).catch(() => {});
}

function genId(prefix) {
  return `${prefix}_${cryptoLib.randomBytes(12).toString('hex')}`;
}

function computeTier(tiers, lifetimePoints) {
  if (!Array.isArray(tiers) || !tiers.length) return null;
  let best = null;
  for (const t of tiers) {
    const threshold = parseInt(t.threshold_points) || 0;
    if (lifetimePoints >= threshold) {
      if (!best || (parseInt(best.threshold_points) || 0) < threshold) best = t;
    }
  }
  return best ? best.name : null;
}

async function applyTxAndRecomputeTier(pool, membershipId, kind, points, sourceKind, sourceRef) {
  const txId = genId('ltx');
  await pool.query(
    `INSERT INTO loyalty_transactions (tx_id, membership_id, kind, points, source_kind, source_ref)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [txId, membershipId, kind, points, sourceKind || null, sourceRef || null]
  );

  // Adjust balance based on kind
  let delta = 0;
  if (kind === 'earn' || kind === 'adjust') delta = points;
  else if (kind === 'redeem' || kind === 'expire') delta = -Math.abs(points);

  await pool.query(
    `UPDATE loyalty_members SET
       points_balance = points_balance + $1,
       lifetime_points = lifetime_points + GREATEST($1, 0),
       last_activity_at = NOW()
     WHERE membership_id = $2`,
    [delta, membershipId]
  );

  // Recompute tier
  const m = await pool.query(
    `SELECT lm.*, lp.tiers FROM loyalty_members lm
     JOIN loyalty_programs lp ON lp.program_id = lm.program_id
     WHERE lm.membership_id = $1`, [membershipId]
  ).catch(() => ({ rows: [] }));
  if (m.rows[0]) {
    const tiers = Array.isArray(m.rows[0].tiers) ? m.rows[0].tiers : [];
    const newTier = computeTier(tiers, parseInt(m.rows[0].lifetime_points) || 0);
    if (newTier !== m.rows[0].tier) {
      await pool.query(`UPDATE loyalty_members SET tier=$1 WHERE membership_id=$2`, [newTier, membershipId]).catch(() => {});
    }
  }
  return { tx_id: txId, balance: m.rows[0]?.points_balance, tier: m.rows[0]?.tier };
}

function registerLoyaltyRoutes(app, pool, verifyAgentAuth, auditChain) {
  // ---- Programs ----
  const TierSchema = z.object({
    name: z.string(),
    threshold_points: z.number().int().min(0),
    perks: z.record(z.any()).optional()
  });
  const ProgramSchema = z.object({
    name: z.string().min(1).max(300),
    point_currency: z.string().max(60).optional(),
    points_per_dollar: z.number().min(0).optional(),
    tiers: z.array(TierSchema).optional(),
    active: z.boolean().optional()
  });

  app.post('/v1/agents/:did/loyalty/programs', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const parse = ProgramSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;
      const programId = genId('lprog');
      await pool.query(
        `INSERT INTO loyalty_programs (program_id, owner_did, name, point_currency, points_per_dollar, tiers, active)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)`,
        [programId, did, d.name, d.point_currency || 'points', d.points_per_dollar || 1.0,
         JSON.stringify(d.tiers || []), d.active !== false]
      );
      await auditChain.append({
        event_type: 'loyalty.program_created', program_id: programId, owner_did: did, timestamp: new Date().toISOString()
      });
      return res.status(201).json({ program_id: programId, owner_did: did, name: d.name });
    } catch (e) { return res.status(500).json({ error: 'create_failed', message: e.message }); }
  });

  app.get('/v1/agents/:did/loyalty/programs', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(
      `SELECT * FROM loyalty_programs WHERE owner_did=$1 ORDER BY created_at DESC`, [did]
    ).catch(() => ({ rows: [] }));
    return res.json({ programs: r.rows, count: r.rows.length });
  });

  // ---- Enroll member (public) ----
  app.post('/v1/loyalty/programs/:id/enroll', express.json(), async (req, res) => {
    try {
      const body = z.object({
        member_did: z.string().optional(),
        member_email: z.string().email().optional(),
        name: z.string().max(300).optional()
      }).safeParse(req.body || {});
      if (!body.success) return res.status(400).json({ error: 'invalid_input', details: body.error.issues });
      if (!body.data.member_did && !body.data.member_email) {
        return res.status(400).json({ error: 'member_did_or_email_required' });
      }
      const prog = await pool.query(
        `SELECT * FROM loyalty_programs WHERE program_id=$1 AND active=TRUE`, [req.params.id]
      ).catch(() => ({ rows: [] }));
      if (!prog.rows[0]) return res.status(404).json({ error: 'program_not_found_or_inactive' });

      // De-dup: check existing
      const existing = await pool.query(
        `SELECT * FROM loyalty_members WHERE program_id=$1 AND (
           ($2::text IS NOT NULL AND member_did=$2) OR
           ($3::text IS NOT NULL AND member_email=$3)
         ) LIMIT 1`,
        [req.params.id, body.data.member_did || null, body.data.member_email || null]
      ).catch(() => ({ rows: [] }));
      if (existing.rows[0]) {
        return res.json({ membership_id: existing.rows[0].membership_id, already_enrolled: true });
      }

      const membershipId = genId('lmem');
      // Default tier (the lowest threshold)
      const tiers = Array.isArray(prog.rows[0].tiers) ? prog.rows[0].tiers : [];
      const startingTier = computeTier(tiers, 0);
      await pool.query(
        `INSERT INTO loyalty_members (membership_id, program_id, member_did, member_email, name, tier)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [membershipId, req.params.id, body.data.member_did || null,
         body.data.member_email || null, body.data.name || null, startingTier]
      );
      await auditChain.append({
        event_type: 'loyalty.member_enrolled', membership_id: membershipId,
        program_id: req.params.id, owner_did: prog.rows[0].owner_did, timestamp: new Date().toISOString()
      });
      return res.status(201).json({ membership_id: membershipId, program_id: req.params.id, tier: startingTier });
    } catch (e) { return res.status(500).json({ error: 'enroll_failed', message: e.message }); }
  });

  // ---- Earn points ----
  const EarnSchema = z.object({
    points: z.number().int().min(1).optional(),
    amount_dollars: z.number().min(0).optional(),
    source_kind: z.enum(SOURCE_KINDS).optional(),
    source_ref: z.string().max(200).optional()
  });

  app.post('/v1/loyalty/members/:id/earn', express.json(), async (req, res) => {
    try {
      const parse = EarnSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;
      const mem = await pool.query(
        `SELECT lm.*, lp.points_per_dollar, lp.owner_did
         FROM loyalty_members lm
         JOIN loyalty_programs lp ON lp.program_id = lm.program_id
         WHERE lm.membership_id=$1`, [req.params.id]
      ).catch(() => ({ rows: [] }));
      if (!mem.rows[0]) return res.status(404).json({ error: 'member_not_found' });

      let pointsToEarn = d.points || 0;
      if (!pointsToEarn && d.amount_dollars) {
        pointsToEarn = Math.floor((d.amount_dollars || 0) * (parseFloat(mem.rows[0].points_per_dollar) || 1.0));
      }
      if (pointsToEarn <= 0) return res.status(400).json({ error: 'no_points_to_earn' });

      const result = await applyTxAndRecomputeTier(pool, req.params.id, 'earn', pointsToEarn, d.source_kind, d.source_ref);
      await auditChain.append({
        event_type: 'loyalty.points_earned', membership_id: req.params.id,
        owner_did: mem.rows[0].owner_did, points: pointsToEarn,
        source_kind: d.source_kind || null, timestamp: new Date().toISOString()
      });
      return res.json({ membership_id: req.params.id, earned: pointsToEarn,
        balance: parseInt(result.balance) + 0, tier: result.tier, tx_id: result.tx_id });
    } catch (e) {
      console.error('[loyalty.earn]', e);
      return res.status(500).json({ error: 'earn_failed', message: e.message });
    }
  });

  // ---- Redeem reward ----
  app.post('/v1/loyalty/members/:id/redeem', express.json(), async (req, res) => {
    try {
      const body = z.object({ reward_id: z.string().min(1) }).safeParse(req.body || {});
      if (!body.success) return res.status(400).json({ error: 'invalid_input', details: body.error.issues });
      const mem = await pool.query(
        `SELECT lm.*, lp.owner_did FROM loyalty_members lm
         JOIN loyalty_programs lp ON lp.program_id = lm.program_id
         WHERE lm.membership_id=$1`, [req.params.id]
      ).catch(() => ({ rows: [] }));
      if (!mem.rows[0]) return res.status(404).json({ error: 'member_not_found' });
      const reward = await pool.query(
        `SELECT * FROM loyalty_rewards WHERE reward_id=$1 AND program_id=$2 AND active=TRUE`,
        [body.data.reward_id, mem.rows[0].program_id]
      ).catch(() => ({ rows: [] }));
      if (!reward.rows[0]) return res.status(404).json({ error: 'reward_not_found' });
      const r = reward.rows[0];
      if (r.max_redemptions && r.redemptions >= r.max_redemptions) {
        return res.status(409).json({ error: 'reward_exhausted' });
      }
      const cost = parseInt(r.points_cost) || 0;
      if ((parseInt(mem.rows[0].points_balance) || 0) < cost) {
        return res.status(402).json({ error: 'insufficient_points', balance: mem.rows[0].points_balance, cost });
      }
      const result = await applyTxAndRecomputeTier(pool, req.params.id, 'redeem', cost, 'manual', `reward:${r.reward_id}`);
      await pool.query(`UPDATE loyalty_rewards SET redemptions = redemptions + 1 WHERE reward_id=$1`, [r.reward_id]).catch(() => {});
      await auditChain.append({
        event_type: 'loyalty.reward_redeemed', membership_id: req.params.id, reward_id: r.reward_id,
        owner_did: mem.rows[0].owner_did, points_cost: cost, timestamp: new Date().toISOString()
      });
      return res.json({
        membership_id: req.params.id,
        reward_id: r.reward_id,
        points_spent: cost,
        balance: parseInt(result.balance) + 0,
        tier: result.tier,
        reward_value: r.value
      });
    } catch (e) { return res.status(500).json({ error: 'redeem_failed', message: e.message }); }
  });

  // ---- Get member detail ----
  app.get('/v1/loyalty/members/:id', async (req, res) => {
    const m = await pool.query(
      `SELECT lm.*, lp.point_currency, lp.tiers, lp.owner_did
       FROM loyalty_members lm
       JOIN loyalty_programs lp ON lp.program_id = lm.program_id
       WHERE lm.membership_id=$1`, [req.params.id]
    ).catch(() => ({ rows: [] }));
    if (!m.rows[0]) return res.status(404).json({ error: 'not_found' });
    const tx = await pool.query(
      `SELECT * FROM loyalty_transactions WHERE membership_id=$1 ORDER BY created_at DESC LIMIT 100`,
      [req.params.id]
    ).catch(() => ({ rows: [] }));
    return res.json({ member: m.rows[0], transactions: tx.rows });
  });

  // ---- Create reward ----
  const RewardSchema = z.object({
    program_id: z.string().min(1),
    name: z.string().min(1).max(300),
    kind: z.enum(REWARD_KINDS).optional(),
    value: z.record(z.any()).optional(),
    points_cost: z.number().int().min(0),
    max_redemptions: z.number().int().min(1).optional(),
    active: z.boolean().optional()
  });

  app.post('/v1/agents/:did/loyalty/rewards', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const parse = RewardSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;
      const prog = await pool.query(
        `SELECT program_id FROM loyalty_programs WHERE program_id=$1 AND owner_did=$2`,
        [d.program_id, did]
      ).catch(() => ({ rows: [] }));
      if (!prog.rows[0]) return res.status(404).json({ error: 'program_not_found' });
      const rewardId = genId('lrwd');
      await pool.query(
        `INSERT INTO loyalty_rewards (reward_id, program_id, name, kind, value, points_cost, max_redemptions, active)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8)`,
        [rewardId, d.program_id, d.name, d.kind || 'discount',
         JSON.stringify(d.value || {}), d.points_cost, d.max_redemptions || null, d.active !== false]
      );
      await auditChain.append({
        event_type: 'loyalty.reward_created', reward_id: rewardId, program_id: d.program_id,
        owner_did: did, points_cost: d.points_cost, timestamp: new Date().toISOString()
      });
      return res.status(201).json({ reward_id: rewardId, program_id: d.program_id, name: d.name });
    } catch (e) { return res.status(500).json({ error: 'create_failed', message: e.message }); }
  });

  app.get('/v1/loyalty/programs/:id/rewards', async (req, res) => {
    const r = await pool.query(
      `SELECT * FROM loyalty_rewards WHERE program_id=$1 AND active=TRUE ORDER BY points_cost ASC`,
      [req.params.id]
    ).catch(() => ({ rows: [] }));
    return res.json({ rewards: r.rows, count: r.rows.length });
  });
}

module.exports = {
  migrate,
  registerLoyaltyRoutes,
  TX_KINDS,
  SOURCE_KINDS,
  REWARD_KINDS,
  computeTier
};
