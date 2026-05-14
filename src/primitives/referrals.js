// ============================================================================
// OpenHeab Referrals — Referral programs + tracking
// ============================================================================
const express = require('express');
const cryptoLib = require('crypto');
const { z } = require('zod');

const REWARD_KINDS = ['cash', 'credit', 'percentage', 'product'];
const PAYOUT_WHEN = ['signup', 'first_purchase', 'recurring'];
const REFERRAL_STATUSES = ['pending', 'qualified', 'rewarded', 'rejected'];

async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS referral_programs (
      program_id            TEXT PRIMARY KEY,
      owner_did             TEXT NOT NULL,
      name                  TEXT NOT NULL,
      reward_kind           TEXT NOT NULL DEFAULT 'cash',
      reward_amount_cents   INTEGER,
      reward_percentage_bps INTEGER,
      payout_when           TEXT NOT NULL DEFAULT 'first_purchase',
      cookie_days           INTEGER NOT NULL DEFAULT 30,
      active                BOOLEAN NOT NULL DEFAULT TRUE,
      created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_referral_programs_owner ON referral_programs (owner_did);

    CREATE TABLE IF NOT EXISTS referral_codes (
      code_id     TEXT PRIMARY KEY,
      program_id  TEXT NOT NULL,
      owner_did   TEXT NOT NULL,
      code        TEXT UNIQUE NOT NULL,
      custom_url  TEXT,
      max_uses    INTEGER,
      uses        INTEGER NOT NULL DEFAULT 0,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at  TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_referral_codes_program ON referral_codes (program_id);
    CREATE INDEX IF NOT EXISTS idx_referral_codes_owner ON referral_codes (owner_did);

    CREATE TABLE IF NOT EXISTS referrals (
      referral_id        TEXT PRIMARY KEY,
      code_id            TEXT NOT NULL,
      program_id         TEXT,
      referrer_did       TEXT,
      referred_did       TEXT,
      referred_email     TEXT,
      status             TEXT NOT NULL DEFAULT 'pending',
      conversion_event   TEXT,
      reward_amount_cents INTEGER,
      paid_at            TIMESTAMPTZ,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_referrals_code ON referrals (code_id);
    CREATE INDEX IF NOT EXISTS idx_referrals_referrer ON referrals (referrer_did);
    CREATE INDEX IF NOT EXISTS idx_referrals_status ON referrals (status);

    CREATE TABLE IF NOT EXISTS referral_payouts (
      payout_id      TEXT PRIMARY KEY,
      referrer_did   TEXT NOT NULL,
      total_cents    BIGINT NOT NULL DEFAULT 0,
      payment_method TEXT,
      paid_at        TIMESTAMPTZ,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_referral_payouts_referrer ON referral_payouts (referrer_did);
  `).catch(() => {});
}

function genId(prefix) {
  return `${prefix}_${cryptoLib.randomBytes(12).toString('hex')}`;
}

function genCode() {
  return cryptoLib.randomBytes(5).toString('hex').toUpperCase();
}

function registerReferralsRoutes(app, pool, verifyAgentAuth, auditChain) {
  // ---- Programs ----
  const ProgramSchema = z.object({
    name: z.string().min(1).max(300),
    reward_kind: z.enum(REWARD_KINDS).optional(),
    reward_amount_cents: z.number().int().min(0).optional(),
    reward_percentage_bps: z.number().int().min(0).max(10000).optional(),
    payout_when: z.enum(PAYOUT_WHEN).optional(),
    cookie_days: z.number().int().min(1).max(365).optional(),
    active: z.boolean().optional()
  });

  app.post('/v1/agents/:did/referrals/programs', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const parse = ProgramSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;
      const programId = genId('rprog');
      await pool.query(
        `INSERT INTO referral_programs (program_id, owner_did, name, reward_kind,
           reward_amount_cents, reward_percentage_bps, payout_when, cookie_days, active)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [programId, did, d.name, d.reward_kind || 'cash',
         d.reward_amount_cents || null, d.reward_percentage_bps || null,
         d.payout_when || 'first_purchase', d.cookie_days || 30, d.active !== false]
      );
      await auditChain.append({
        event_type: 'referrals.program_created', program_id: programId, owner_did: did, timestamp: new Date().toISOString()
      });
      return res.status(201).json({ program_id: programId, owner_did: did, name: d.name });
    } catch (e) {
      console.error('[referrals.program.create]', e);
      return res.status(500).json({ error: 'create_failed', message: e.message });
    }
  });

  app.get('/v1/agents/:did/referrals/programs', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(
      `SELECT * FROM referral_programs WHERE owner_did=$1 ORDER BY created_at DESC`, [did]
    ).catch(() => ({ rows: [] }));
    return res.json({ programs: r.rows, count: r.rows.length });
  });

  // ---- Codes ----
  const CodeSchema = z.object({
    program_id: z.string().min(1),
    code: z.string().max(60).optional(),
    custom_url: z.string().max(500).optional(),
    max_uses: z.number().int().min(1).optional(),
    expires_at: z.string().optional()
  });

  app.post('/v1/agents/:did/referrals/codes', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const parse = CodeSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;
      const prog = await pool.query(
        `SELECT * FROM referral_programs WHERE program_id=$1 AND owner_did=$2`,
        [d.program_id, did]
      ).catch(() => ({ rows: [] }));
      if (!prog.rows[0]) return res.status(404).json({ error: 'program_not_found' });
      const codeId = genId('rcode');
      let codeStr = d.code || genCode();
      // Ensure uniqueness
      for (let attempt = 0; attempt < 5; attempt++) {
        const exists = await pool.query(`SELECT 1 FROM referral_codes WHERE code=$1`, [codeStr]).catch(() => ({ rows: [] }));
        if (!exists.rows[0]) break;
        codeStr = genCode();
      }
      await pool.query(
        `INSERT INTO referral_codes (code_id, program_id, owner_did, code, custom_url, max_uses, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [codeId, d.program_id, did, codeStr, d.custom_url || null, d.max_uses || null, d.expires_at || null]
      );
      await auditChain.append({
        event_type: 'referrals.code_created', code_id: codeId, code: codeStr, owner_did: did, timestamp: new Date().toISOString()
      });
      return res.status(201).json({ code_id: codeId, code: codeStr, program_id: d.program_id });
    } catch (e) { return res.status(500).json({ error: 'create_failed', message: e.message }); }
  });

  // ---- Public: resolve code ----
  app.get('/v1/referrals/:code', async (req, res) => {
    const r = await pool.query(
      `SELECT rc.*, rp.name AS program_name, rp.reward_kind, rp.reward_amount_cents,
              rp.reward_percentage_bps, rp.payout_when, rp.cookie_days, rp.active AS program_active
       FROM referral_codes rc
       JOIN referral_programs rp ON rp.program_id = rc.program_id
       WHERE rc.code=$1`, [req.params.code]
    ).catch(() => ({ rows: [] }));
    if (!r.rows[0]) return res.status(404).json({ error: 'code_not_found' });
    const c = r.rows[0];
    if (c.expires_at && new Date(c.expires_at) < new Date()) return res.status(410).json({ error: 'code_expired' });
    if (c.max_uses && c.uses >= c.max_uses) return res.status(409).json({ error: 'code_exhausted' });
    if (!c.program_active) return res.status(409).json({ error: 'program_inactive' });
    const expiresAt = new Date(Date.now() + (c.cookie_days || 30) * 86400000).toISOString();
    return res.json({
      code: c.code,
      referrer_did: c.owner_did,
      program_id: c.program_id,
      program_name: c.program_name,
      reward_kind: c.reward_kind,
      cookie: { code: c.code, referrer_did: c.owner_did, expires_at: expiresAt }
    });
  });

  // ---- Public: track conversion ----
  const TrackSchema = z.object({
    code: z.string().min(1),
    event: z.enum(['signup', 'purchase', 'first_purchase']),
    referred_did: z.string().optional(),
    referred_email: z.string().email().optional(),
    amount_cents: z.number().int().min(0).optional()
  });

  app.post('/v1/referrals/track', express.json(), async (req, res) => {
    try {
      const parse = TrackSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;
      const code = await pool.query(
        `SELECT rc.*, rp.reward_kind, rp.reward_amount_cents, rp.reward_percentage_bps, rp.payout_when, rp.active AS program_active
         FROM referral_codes rc
         JOIN referral_programs rp ON rp.program_id = rc.program_id
         WHERE rc.code=$1`, [d.code]
      ).catch(() => ({ rows: [] }));
      if (!code.rows[0]) return res.status(404).json({ error: 'code_not_found' });
      const c = code.rows[0];
      if (c.expires_at && new Date(c.expires_at) < new Date()) return res.status(410).json({ error: 'code_expired' });
      if (!c.program_active) return res.status(409).json({ error: 'program_inactive' });
      if (c.max_uses && c.uses >= c.max_uses) return res.status(409).json({ error: 'code_exhausted' });

      // Compute reward eligibility based on payout_when
      let status = 'pending';
      let rewardCents = null;
      const event = d.event;
      const triggers =
        (c.payout_when === 'signup' && event === 'signup') ||
        (c.payout_when === 'first_purchase' && (event === 'purchase' || event === 'first_purchase')) ||
        (c.payout_when === 'recurring' && event === 'purchase');

      if (triggers) {
        status = 'qualified';
        if (c.reward_kind === 'cash' || c.reward_kind === 'credit') {
          rewardCents = c.reward_amount_cents || 0;
        } else if (c.reward_kind === 'percentage' && d.amount_cents) {
          rewardCents = Math.floor(d.amount_cents * (c.reward_percentage_bps || 0) / 10000);
        }
      }

      const referralId = genId('ref');
      await pool.query(
        `INSERT INTO referrals (referral_id, code_id, program_id, referrer_did, referred_did,
           referred_email, status, conversion_event, reward_amount_cents)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [referralId, c.code_id, c.program_id, c.owner_did, d.referred_did || null,
         d.referred_email || null, status, event, rewardCents]
      );
      await pool.query(`UPDATE referral_codes SET uses = uses + 1 WHERE code_id=$1`, [c.code_id]).catch(() => {});
      await auditChain.append({
        event_type: 'referrals.tracked', referral_id: referralId, code: d.code,
        referrer_did: c.owner_did, event, status, reward_cents: rewardCents,
        timestamp: new Date().toISOString()
      });
      return res.status(201).json({ referral_id: referralId, status, reward_amount_cents: rewardCents });
    } catch (e) {
      console.error('[referrals.track]', e);
      return res.status(500).json({ error: 'track_failed', message: e.message });
    }
  });

  // ---- Payouts: compute + pay rewards ----
  app.post('/v1/agents/:did/referrals/payouts/run', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const body = z.object({
        payment_method: z.string().max(60).optional(),
        dry_run: z.boolean().optional()
      }).safeParse(req.body || {});
      if (!body.success) return res.status(400).json({ error: 'invalid_input', details: body.error.issues });

      const pending = await pool.query(
        `SELECT referral_id, reward_amount_cents FROM referrals
         WHERE referrer_did=$1 AND status='qualified' AND reward_amount_cents IS NOT NULL AND reward_amount_cents > 0`,
        [did]
      ).catch(() => ({ rows: [] }));
      const total = pending.rows.reduce((s, r) => s + (parseInt(r.reward_amount_cents) || 0), 0);

      if (body.data.dry_run) {
        return res.json({ referrer_did: did, total_cents: total, qualified: pending.rows.length, dry_run: true });
      }

      const payoutId = genId('rpayout');
      if (total > 0) {
        await pool.query(
          `INSERT INTO referral_payouts (payout_id, referrer_did, total_cents, payment_method, paid_at)
           VALUES ($1,$2,$3,$4,NOW())`,
          [payoutId, did, total, body.data.payment_method || 'credit']
        );
        const ids = pending.rows.map(r => r.referral_id);
        if (ids.length) {
          await pool.query(
            `UPDATE referrals SET status='rewarded', paid_at=NOW() WHERE referral_id = ANY($1::text[])`,
            [ids]
          ).catch(() => {});
        }
        await auditChain.append({
          event_type: 'referrals.payout_run', payout_id: payoutId, referrer_did: did,
          total_cents: total, qualified_count: ids.length, timestamp: new Date().toISOString()
        });
      }
      return res.json({ payout_id: total > 0 ? payoutId : null, total_cents: total, paid_count: pending.rows.length });
    } catch (e) {
      console.error('[referrals.payout.run]', e);
      return res.status(500).json({ error: 'payout_failed', message: e.message });
    }
  });

  // ---- Stats ----
  app.get('/v1/agents/:did/referrals/stats', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const stats = await pool.query(
      `SELECT status, COUNT(*)::int AS n, COALESCE(SUM(reward_amount_cents),0)::bigint AS sum_cents
       FROM referrals WHERE referrer_did=$1 GROUP BY status`,
      [did]
    ).catch(() => ({ rows: [] }));
    const funnel = { pending: 0, qualified: 0, rewarded: 0, rejected: 0 };
    const valueByStatus = { pending: 0, qualified: 0, rewarded: 0, rejected: 0 };
    for (const r of stats.rows) {
      funnel[r.status] = r.n;
      valueByStatus[r.status] = parseInt(r.sum_cents) || 0;
    }
    const totalReferred = funnel.pending + funnel.qualified + funnel.rewarded + funnel.rejected;
    const totalConverted = funnel.qualified + funnel.rewarded;
    const conversionRate = totalReferred ? totalConverted / totalReferred : 0;
    const codes = await pool.query(
      `SELECT COUNT(*)::int AS n, COALESCE(SUM(uses),0)::int AS total_uses FROM referral_codes WHERE owner_did=$1`,
      [did]
    ).catch(() => ({ rows: [{ n: 0, total_uses: 0 }] }));
    return res.json({
      referrer_did: did,
      funnel,
      value_by_status_cents: valueByStatus,
      total_referred: totalReferred,
      total_converted: totalConverted,
      conversion_rate: conversionRate,
      code_count: codes.rows[0].n,
      total_clicks: codes.rows[0].total_uses
    });
  });

  app.get('/v1/agents/:did/referrals', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const status = req.query.status;
    const params = [did];
    let sql = `SELECT * FROM referrals WHERE referrer_did=$1`;
    if (status) { params.push(status); sql += ` AND status=$${params.length}`; }
    sql += ` ORDER BY created_at DESC LIMIT 500`;
    const r = await pool.query(sql, params).catch(() => ({ rows: [] }));
    return res.json({ referrals: r.rows, count: r.rows.length });
  });
}

module.exports = {
  migrate,
  registerReferralsRoutes,
  REWARD_KINDS,
  PAYOUT_WHEN,
  REFERRAL_STATUSES
};
