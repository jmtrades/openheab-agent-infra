// ============================================================================
// partnerships.js — channel partner / reseller program. Pays consultants and
// integrators a cut of revenue they bring in. Critical for the 90-day push:
// direct sales doesn't scale that fast; channel does.
// ============================================================================
const crypto = require('crypto');
const { z } = require('zod');
const { registerCron } = require('../cron_auth');

const TIER_THRESHOLDS = [
  ['bronze',   0,         0   ],
  ['silver',   5_000_000, 500 ],
  ['gold',     25_000_000, 1000],
  ['platinum', 100_000_000, 2000]
];

async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS partner_accounts (
      partner_id              TEXT PRIMARY KEY,
      owner_did               TEXT,
      kind                    TEXT NOT NULL,
      company_name            TEXT NOT NULL,
      contact_email           TEXT NOT NULL,
      website                 TEXT,
      status                  TEXT NOT NULL DEFAULT 'pending',
      tier                    TEXT NOT NULL DEFAULT 'bronze',
      default_commission_bps  INTEGER NOT NULL DEFAULT 2000,
      recurring_commission_bps INTEGER NOT NULL DEFAULT 1000,
      payout_method           TEXT,
      signed_agreement_at     TIMESTAMPTZ,
      created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS partner_referrals (
      referral_id             TEXT PRIMARY KEY,
      partner_id              TEXT NOT NULL,
      referred_org_id         TEXT,
      referred_email          TEXT,
      link_code               TEXT UNIQUE,
      utm_campaign            TEXT,
      status                  TEXT NOT NULL DEFAULT 'pending',
      qualified_at            TIMESTAMPTZ,
      converted_at            TIMESTAMPTZ,
      total_revenue_cents     BIGINT NOT NULL DEFAULT 0,
      total_commission_cents  BIGINT NOT NULL DEFAULT 0,
      created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_partner_referrals_partner
      ON partner_referrals (partner_id, status);
    CREATE TABLE IF NOT EXISTS partner_commissions (
      commission_id           TEXT PRIMARY KEY,
      partner_id              TEXT NOT NULL,
      referral_id             TEXT,
      period_yyyymm           INTEGER NOT NULL,
      base_revenue_cents      BIGINT NOT NULL,
      commission_cents        BIGINT NOT NULL,
      status                  TEXT NOT NULL DEFAULT 'pending',
      payout_id               TEXT,
      paid_at                 TIMESTAMPTZ,
      created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS partner_tier_thresholds (
      tier                    TEXT PRIMARY KEY,
      min_quarterly_revenue_cents BIGINT NOT NULL,
      commission_bps_bonus    INTEGER NOT NULL DEFAULT 0
    );
  `);
  for (const [tier, min, bonus] of TIER_THRESHOLDS) {
    await pool.query(
      `INSERT INTO partner_tier_thresholds (tier, min_quarterly_revenue_cents, commission_bps_bonus)
       VALUES ($1,$2,$3) ON CONFLICT (tier) DO NOTHING`,
      [tier, min, bonus]
    ).catch(() => {});
  }
}

function newId(p) { return p + '_' + crypto.randomBytes(10).toString('hex'); }
function isAdmin(req) {
  const t = req.headers['x-admin-token'];
  return t && t === process.env.OPERATOR_ADMIN_TOKEN;
}

const applySchema = z.object({
  kind: z.enum(['solo_consultant', 'agency', 'reseller', 'system_integrator', 'affiliate', 'oem_partner']),
  company_name: z.string().min(1),
  contact_email: z.string().email(),
  owner_did: z.string().optional(),
  website: z.string().url().optional(),
  expected_volume: z.string().optional()
});

async function recordReferralConversion({ pool, referral_id, revenue_cents, auditChain = null }) {
  await pool.query(
    `UPDATE partner_referrals
     SET status = 'converted', converted_at = COALESCE(converted_at, NOW()),
         total_revenue_cents = total_revenue_cents + $1
     WHERE referral_id = $2`,
    [revenue_cents, referral_id]
  ).catch(() => {});
  if (auditChain) await auditChain.append({ event_type: 'partner.referral_converted', referral_id, revenue_cents }).catch(() => {});
}

async function recalcTier(pool, partnerId) {
  const r = await pool.query(`
    SELECT COALESCE(SUM(total_revenue_cents),0)::bigint AS rev
    FROM partner_referrals WHERE partner_id = $1
      AND created_at >= NOW() - INTERVAL '90 days'
  `, [partnerId]).catch(() => ({ rows: [{ rev: 0 }] }));
  const rev = Number(r.rows[0].rev || 0);
  let tier = 'bronze';
  for (const [t, min] of TIER_THRESHOLDS) if (rev >= min) tier = t;
  await pool.query(`UPDATE partner_accounts SET tier = $1 WHERE partner_id = $2`, [tier, partnerId]).catch(() => {});
  return { partner_id: partnerId, tier, q_revenue_cents: rev };
}

function registerPartnershipsRoutes(app, pool, verifyAgentAuth, auditChain) {
  const express = require('express');

  app.post('/v1/partners/apply', express.json(), async (req, res) => {
    const p = applySchema.safeParse(req.body || {});
    if (!p.success) return res.status(400).json({ error: 'invalid_input', details: p.error.flatten() });
    const id = newId('part');
    await pool.query(
      `INSERT INTO partner_accounts
        (partner_id, owner_did, kind, company_name, contact_email, website, status)
       VALUES ($1,$2,$3,$4,$5,$6,'pending')`,
      [id, p.data.owner_did || null, p.data.kind, p.data.company_name,
       p.data.contact_email, p.data.website || null]
    );
    if (auditChain) await auditChain.append({ event_type: 'partner.applied', partner_id: id, kind: p.data.kind, company_name: p.data.company_name }).catch(() => {});
    return res.status(201).json({ partner_id: id, status: 'pending' });
  });

  app.get('/v1/admin/partners', async (req, res) => {
    if (!isAdmin(req)) return res.status(401).json({ error: 'admin_auth_required' });
    const status = req.query.status || 'pending';
    const r = await pool.query(`
      SELECT partner_id, kind, company_name, contact_email, website, status, tier, created_at
      FROM partner_accounts WHERE status = $1 ORDER BY created_at DESC LIMIT 200
    `, [status]).catch(() => ({ rows: [] }));
    res.json({ partners: r.rows });
  });

  app.post('/v1/admin/partners/:pid/approve', async (req, res) => {
    if (!isAdmin(req)) return res.status(401).json({ error: 'admin_auth_required' });
    const r = await pool.query(`
      UPDATE partner_accounts SET status='active', signed_agreement_at = NOW()
      WHERE partner_id = $1 RETURNING partner_id
    `, [req.params.pid]).catch(() => ({ rows: [] }));
    if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
    if (auditChain) await auditChain.append({ event_type: 'partner.approved', partner_id: req.params.pid }).catch(() => {});
    res.json({ partner_id: r.rows[0].partner_id, status: 'active' });
  });

  app.get('/v1/partners/:pid', async (req, res) => {
    const r = await pool.query(`SELECT * FROM partner_accounts WHERE partner_id = $1`, [req.params.pid])
      .catch(() => ({ rows: [] }));
    if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
    res.json(r.rows[0]);
  });

  app.get('/v1/partners/:pid/referrals', async (req, res) => {
    const r = await pool.query(`
      SELECT referral_id, referred_email, link_code, status, qualified_at, converted_at,
             total_revenue_cents, total_commission_cents, created_at
      FROM partner_referrals WHERE partner_id = $1 ORDER BY created_at DESC LIMIT 500
    `, [req.params.pid]).catch(() => ({ rows: [] }));
    res.json({ partner_id: req.params.pid, referrals: r.rows });
  });

  app.post('/v1/partners/:pid/referrals', express.json(), async (req, res) => {
    const id = newId('ref');
    const code = req.body?.link_code || crypto.randomBytes(6).toString('hex');
    await pool.query(
      `INSERT INTO partner_referrals (referral_id, partner_id, referred_email, link_code, utm_campaign)
       VALUES ($1,$2,$3,$4,$5)`,
      [id, req.params.pid, req.body?.referred_email || null, code, req.body?.utm_campaign || null]
    );
    res.status(201).json({ referral_id: id, link_code: code, link: `${process.env.OPERATOR_PUBLIC_URL || ''}/v1/r/${code}` });
  });

  app.get('/v1/r/:code', async (req, res) => {
    const r = await pool.query(`SELECT referral_id, partner_id FROM partner_referrals WHERE link_code = $1`,
      [req.params.code]).catch(() => ({ rows: [] }));
    if (r.rows[0]) {
      res.cookie?.('openheab_ref', req.params.code, { maxAge: 90 * 24 * 3600 * 1000, httpOnly: true });
    }
    const dest = (process.env.OPERATOR_PUBLIC_URL || '/') + '/?utm_source=partner&utm_campaign=' + encodeURIComponent(req.params.code);
    res.redirect(302, dest);
  });

  app.post('/v1/_webhooks/partner-conversion', express.json(), async (req, res) => {
    const { isCronRequest } = require('../cron_auth');
    if (!isCronRequest(req) && !isAdmin(req)) return res.status(401).json({ error: 'auth_required' });
    const { referral_id, revenue_cents } = req.body || {};
    if (!referral_id || !Number.isFinite(revenue_cents)) return res.status(400).json({ error: 'invalid' });
    await recordReferralConversion({ pool, referral_id, revenue_cents, auditChain });
    res.json({ ok: true });
  });

  app.get('/v1/partners/:pid/commissions', async (req, res) => {
    const r = await pool.query(`
      SELECT commission_id, period_yyyymm, base_revenue_cents, commission_cents, status, paid_at
      FROM partner_commissions WHERE partner_id = $1 ORDER BY period_yyyymm DESC LIMIT 24
    `, [req.params.pid]).catch(() => ({ rows: [] }));
    res.json({ partner_id: req.params.pid, commissions: r.rows });
  });

  registerCron(app, '/v1/_jobs/partner-commission-calc', async (req, res) => {
    const now = new Date();
    const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    const period = prev.getUTCFullYear() * 100 + (prev.getUTCMonth() + 1);
    const partners = await pool.query(`SELECT partner_id, default_commission_bps FROM partner_accounts WHERE status='active'`)
      .catch(() => ({ rows: [] }));
    let calculated = 0;
    for (const p of partners.rows) {
      const r = await pool.query(`
        SELECT COALESCE(SUM(total_revenue_cents),0)::bigint AS rev
        FROM partner_referrals WHERE partner_id = $1
          AND converted_at >= $2::timestamptz AND converted_at < ($2::timestamptz + INTERVAL '1 month')
      `, [p.partner_id, prev.toISOString()]).catch(() => ({ rows: [{ rev: 0 }] }));
      const rev = Number(r.rows[0].rev);
      if (rev <= 0) continue;
      const commission = Math.floor(rev * (Number(p.default_commission_bps) / 10000));
      await pool.query(`
        INSERT INTO partner_commissions (commission_id, partner_id, period_yyyymm,
          base_revenue_cents, commission_cents, status)
        VALUES ($1,$2,$3,$4,$5,'pending')
      `, [newId('comm'), p.partner_id, period, rev, commission]).catch(() => {});
      calculated++;
    }
    res.json({ period_yyyymm: period, calculated });
  });

  registerCron(app, '/v1/_jobs/partner-tier-recalc', async (req, res) => {
    const partners = await pool.query(`SELECT partner_id FROM partner_accounts WHERE status='active'`)
      .catch(() => ({ rows: [] }));
    const updates = [];
    for (const p of partners.rows) updates.push(await recalcTier(pool, p.partner_id));
    res.json({ updated: updates.length, updates });
  });
}

module.exports = { migrate, registerPartnershipsRoutes, recordReferralConversion, recalcTier, TIER_THRESHOLDS };
