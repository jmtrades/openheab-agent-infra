// ============================================================================
// affiliate_program.js — referral codes + payout tracking.
//
// Pure growth lever. Affiliates promote the substrate, agents sign up with
// their code, affiliates earn a % of every payment that signed-up org makes
// for the next 12 months. We pay out monthly in USDC.
//
// Distinct from the existing /referrals primitive (per-user invite codes
// with one-shot bonus). Affiliates is for creators/influencers/SI partners
// who want recurring rev share.
//
// Endpoints:
//   POST /v1/affiliates                          enroll as affiliate
//   POST /v1/affiliates/:id/codes                mint a referral code
//   POST /v1/affiliates/track-signup             internal: tag a new org w/ code
//   POST /v1/affiliates/track-revenue            internal: log a billable event
//   POST /v1/_jobs/affiliate-monthly-payout      cron at month-end
//   GET  /v1/affiliates/:id/dashboard            per-affiliate stats
//   GET  /v1/affiliates/leaderboard              top affiliates
//
// UI: /affiliates
// ============================================================================
const crypto = require('crypto');
const { z } = require('zod');
const ds = require('../design_system');
const { registerCron } = require('../cron_auth');
const { safeTokenCompare } = require('../safe_compare');

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
}
function shell(title, description, content) {
  return `${ds.head(`${title} — OpenHeab`, description)}${ds.NAV_HTML('')}<main>${content}</main>${ds.FOOTER_HTML()}`;
}
async function safe(pool, sql, params = []) {
  try { return (await pool.query(sql, params)).rows; }
  catch { return []; }
}

const COMMISSION_BPS = parseInt(process.env.AFFILIATE_COMMISSION_BPS || '2000'); // 20%
const ATTRIBUTION_DAYS = parseInt(process.env.AFFILIATE_ATTRIBUTION_DAYS || '365');

async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS affiliates (
      affiliate_id      TEXT PRIMARY KEY,
      affiliate_did     TEXT NOT NULL UNIQUE,
      display_name      TEXT NOT NULL,
      payout_address    TEXT,
      enrolled_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      revoked_at        TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS affiliate_codes (
      code              TEXT PRIMARY KEY,
      affiliate_id      TEXT NOT NULL,
      label             TEXT,
      campaign          TEXT,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_affiliate_codes_affiliate ON affiliate_codes (affiliate_id);

    CREATE TABLE IF NOT EXISTS affiliate_attributions (
      attribution_id    TEXT PRIMARY KEY,
      code              TEXT NOT NULL,
      affiliate_id      TEXT NOT NULL,
      org_id            TEXT,
      agent_did         TEXT,
      attributed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at        TIMESTAMPTZ NOT NULL,
      UNIQUE (org_id),
      UNIQUE (agent_did)
    );
    CREATE INDEX IF NOT EXISTS idx_affiliate_attributions_aff ON affiliate_attributions (affiliate_id);

    CREATE TABLE IF NOT EXISTS affiliate_revenue_events (
      event_id          TEXT PRIMARY KEY,
      attribution_id    TEXT NOT NULL,
      affiliate_id      TEXT NOT NULL,
      org_id            TEXT,
      agent_did         TEXT,
      gross_cents       BIGINT NOT NULL,
      commission_cents  BIGINT NOT NULL,
      paid_out          BOOLEAN NOT NULL DEFAULT FALSE,
      paid_in_run_id    TEXT,
      occurred_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_affiliate_revenue_aff ON affiliate_revenue_events (affiliate_id, occurred_at DESC);
    CREATE INDEX IF NOT EXISTS idx_affiliate_revenue_unpaid ON affiliate_revenue_events (affiliate_id) WHERE paid_out = FALSE;

    CREATE TABLE IF NOT EXISTS affiliate_payouts (
      payout_id         TEXT PRIMARY KEY,
      affiliate_id      TEXT NOT NULL,
      run_id            TEXT NOT NULL,
      events_count      INTEGER NOT NULL,
      gross_cents       BIGINT NOT NULL,
      commission_cents  BIGINT NOT NULL,
      payout_address    TEXT,
      payout_month      TEXT NOT NULL DEFAULT to_char(NOW() AT TIME ZONE 'UTC','YYYY-MM'),
      paid_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      tx_ref            TEXT,
      UNIQUE (affiliate_id, payout_month)
    );
    CREATE INDEX IF NOT EXISTS idx_affiliate_payouts_aff ON affiliate_payouts (affiliate_id, paid_at DESC);
  `).catch(() => {});
}

function isAdmin(req) {
  return safeTokenCompare(req.headers['x-admin-token'], process.env.OPERATOR_ADMIN_TOKEN);
}
function isInternal(req) {
  return safeTokenCompare(req.headers['x-internal-api-key'], process.env.INTERNAL_API_KEY);
}

function registerAffiliateProgramRoutes(app, pool, verifyAgentAuth, auditChain) {
  const express = require('express');

  app.post('/v1/affiliates', express.json(), async (req, res) => {
    const b = z.object({
      affiliate_did: z.string(),
      display_name: z.string().min(2).max(200),
      payout_address: z.string().max(200).optional()
    }).safeParse(req.body || {});
    if (!b.success) return res.status(400).json({ error: { message: 'invalid_input', details: b.error.flatten() } });
    const auth = await verifyAgentAuth(req, b.data.affiliate_did);
    if (!auth.valid) return res.status(401).json({ error: { message: auth.error || 'affiliate_signature_required' } });
    const affiliate_id = 'aff_' + crypto.randomBytes(10).toString('hex');
    try {
      await pool.query(
        `INSERT INTO affiliates (affiliate_id, affiliate_did, display_name, payout_address) VALUES ($1,$2,$3,$4)`,
        [affiliate_id, b.data.affiliate_did, b.data.display_name, b.data.payout_address || null]
      );
      if (auditChain) await auditChain.append({ event_type: 'affiliate.enrolled', affiliate_id, affiliate_did: b.data.affiliate_did }).catch(() => {});
      res.status(201).json({ affiliate_id, commission_bps: COMMISSION_BPS, attribution_days: ATTRIBUTION_DAYS });
    } catch (e) {
      if (e.code === '23505') return res.status(409).json({ error: { message: 'already_enrolled' } });
      res.status(500).json({ error: { message: e.message } });
    }
  });

  app.post('/v1/affiliates/:id/codes', express.json(), async (req, res) => {
    const a = (await safe(pool, `SELECT affiliate_did FROM affiliates WHERE affiliate_id=$1 AND revoked_at IS NULL`, [req.params.id]))[0];
    if (!a) return res.status(404).json({ error: { message: 'affiliate_not_found' } });
    const auth = await verifyAgentAuth(req, a.affiliate_did);
    if (!auth.valid) return res.status(401).json({ error: { message: auth.error || 'affiliate_signature_required' } });
    const b = z.object({
      code: z.string().regex(/^[a-zA-Z0-9_-]{3,60}$/).optional(),
      label: z.string().max(200).optional(),
      campaign: z.string().max(80).optional()
    }).safeParse(req.body || {});
    if (!b.success) return res.status(400).json({ error: { message: 'invalid_input', details: b.error.flatten() } });
    const code = b.data.code || ('OH' + crypto.randomBytes(4).toString('hex').toUpperCase());
    try {
      await pool.query(
        `INSERT INTO affiliate_codes (code, affiliate_id, label, campaign) VALUES ($1,$2,$3,$4)`,
        [code, req.params.id, b.data.label || null, b.data.campaign || null]
      );
      if (auditChain) await auditChain.append({ event_type: 'affiliate.code_minted', affiliate_id: req.params.id, code, campaign: b.data.campaign }).catch(() => {});
      res.status(201).json({ code, share_url: `${process.env.OPERATOR_PUBLIC_URL || 'https://openheab.com'}/signup?ref=${encodeURIComponent(code)}` });
    } catch (e) {
      if (e.code === '23505') return res.status(409).json({ error: { message: 'code_taken' } });
      res.status(500).json({ error: { message: e.message } });
    }
  });

  // Internal — called by signup primitive when org is provisioned with ?ref=
  app.post('/v1/affiliates/track-signup', express.json(), async (req, res) => {
    if (!isInternal(req)) return res.status(401).json({ error: { message: 'internal_only' } });
    const b = z.object({
      code: z.string(),
      org_id: z.string().optional(),
      agent_did: z.string().optional()
    }).safeParse(req.body || {});
    if (!b.success) return res.status(400).json({ error: { message: 'invalid_input', details: b.error.flatten() } });
    if (!b.data.org_id && !b.data.agent_did) return res.status(400).json({ error: { message: 'org_id_or_agent_did_required' } });
    const codeRow = (await safe(pool, `SELECT affiliate_id FROM affiliate_codes WHERE code=$1`, [b.data.code]))[0];
    if (!codeRow) return res.status(404).json({ error: { message: 'unknown_code' } });
    const expires = new Date(Date.now() + ATTRIBUTION_DAYS * 86_400_000);
    const attribution_id = 'att_' + crypto.randomBytes(10).toString('hex');
    try {
      await pool.query(
        `INSERT INTO affiliate_attributions (attribution_id, code, affiliate_id, org_id, agent_did, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [attribution_id, b.data.code, codeRow.affiliate_id, b.data.org_id || null, b.data.agent_did || null, expires]
      );
      if (auditChain) await auditChain.append({ event_type: 'affiliate.signup_attributed', attribution_id, code: b.data.code, affiliate_id: codeRow.affiliate_id }).catch(() => {});
      res.status(201).json({ attribution_id, expires_at: expires.toISOString() });
    } catch (e) {
      if (e.code === '23505') return res.status(409).json({ error: { message: 'already_attributed' } });
      res.status(500).json({ error: { message: e.message } });
    }
  });

  // Internal — called by billing engine when a billable event lands. We
  // compute commission off the gross and record it for monthly payout.
  app.post('/v1/affiliates/track-revenue', express.json(), async (req, res) => {
    if (!isInternal(req)) return res.status(401).json({ error: { message: 'internal_only' } });
    const b = z.object({
      org_id: z.string().optional(),
      agent_did: z.string().optional(),
      gross_cents: z.number().int().positive()
    }).safeParse(req.body || {});
    if (!b.success) return res.status(400).json({ error: { message: 'invalid_input', details: b.error.flatten() } });
    // Find an unexpired attribution
    let att;
    if (b.data.org_id) {
      att = (await safe(pool, `SELECT * FROM affiliate_attributions WHERE org_id=$1 AND expires_at > NOW() LIMIT 1`, [b.data.org_id]))[0];
    }
    if (!att && b.data.agent_did) {
      att = (await safe(pool, `SELECT * FROM affiliate_attributions WHERE agent_did=$1 AND expires_at > NOW() LIMIT 1`, [b.data.agent_did]))[0];
    }
    if (!att) return res.json({ tracked: false, reason: 'no_active_attribution' });
    const commission = Math.floor(b.data.gross_cents * COMMISSION_BPS / 10000);
    const event_id = 'are_' + crypto.randomBytes(10).toString('hex');
    await pool.query(
      `INSERT INTO affiliate_revenue_events (event_id, attribution_id, affiliate_id, org_id, agent_did, gross_cents, commission_cents)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [event_id, att.attribution_id, att.affiliate_id, b.data.org_id || null, b.data.agent_did || null, b.data.gross_cents, commission]
    );
    res.status(201).json({ tracked: true, event_id, commission_cents: commission });
  });

  // Monthly payout cron. Runs hourly via dispatcher but short-circuits unless
  // it's the 1st of the UTC month. UNIQUE (affiliate_id, payout_month) makes
  // each (affiliate, month) tuple pay exactly once even on retries / cold starts.
  registerCron(app, '/v1/_jobs/affiliate-monthly-payout', async (req, res) => {
    const now = new Date();
    const forceMonth = req.query?.month && /^\d{4}-\d{2}$/.test(req.query.month) ? req.query.month : null;
    const isFirstOfMonth = now.getUTCDate() === 1;
    if (!isFirstOfMonth && !forceMonth) return res.json({ skipped: true, reason: 'not_payout_day', utc_date: now.toISOString() });
    const payout_month = forceMonth || `${now.getUTCFullYear()}-${String(now.getUTCMonth()+1).padStart(2,'0')}`;
    const run_id = 'apr_' + crypto.randomBytes(8).toString('hex');
    const owed = await safe(pool, `
      SELECT affiliate_id,
             COUNT(*)::int AS events_count,
             COALESCE(SUM(gross_cents),0)::bigint AS gross,
             COALESCE(SUM(commission_cents),0)::bigint AS commission
      FROM affiliate_revenue_events WHERE paid_out=FALSE GROUP BY affiliate_id
      HAVING COALESCE(SUM(commission_cents),0) > 0
    `);
    let payouts = 0;
    let skipped_duplicate = 0;
    for (const o of owed) {
      const aff = (await safe(pool, `SELECT payout_address FROM affiliates WHERE affiliate_id=$1`, [o.affiliate_id]))[0];
      const payout_id = 'apo_' + crypto.randomBytes(10).toString('hex');
      const ins = await pool.query(
        `INSERT INTO affiliate_payouts (payout_id, affiliate_id, run_id, events_count, gross_cents, commission_cents, payout_address, payout_month)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (affiliate_id, payout_month) DO NOTHING
         RETURNING payout_id`,
        [payout_id, o.affiliate_id, run_id, o.events_count, o.gross, o.commission, aff?.payout_address || null, payout_month]
      ).catch(() => ({ rows: [] }));
      if (ins.rows && ins.rows.length > 0) {
        await pool.query(
          `UPDATE affiliate_revenue_events SET paid_out=TRUE, paid_in_run_id=$1 WHERE affiliate_id=$2 AND paid_out=FALSE`,
          [run_id, o.affiliate_id]
        ).catch(() => {});
        payouts++;
      } else {
        skipped_duplicate++;
      }
    }
    res.json({ run_id, payout_month, payouts, skipped_duplicate });
  }, 'hourly');

  app.get('/v1/affiliates/:id/dashboard', async (req, res) => {
    const aff = (await safe(pool, `SELECT * FROM affiliates WHERE affiliate_id=$1`, [req.params.id]))[0];
    if (!aff) return res.status(404).json({ error: { message: 'not_found' } });
    const codes = await safe(pool, `SELECT code, label, campaign, created_at FROM affiliate_codes WHERE affiliate_id=$1`, [req.params.id]);
    const attrCount = (await safe(pool, `SELECT COUNT(*)::int AS n FROM affiliate_attributions WHERE affiliate_id=$1`, [req.params.id]))[0]?.n || 0;
    const revenue = (await safe(pool, `SELECT COALESCE(SUM(gross_cents),0)::bigint AS gross, COALESCE(SUM(commission_cents),0)::bigint AS commission, COUNT(*)::int AS events FROM affiliate_revenue_events WHERE affiliate_id=$1`, [req.params.id]))[0] || {};
    const unpaid = (await safe(pool, `SELECT COALESCE(SUM(commission_cents),0)::bigint AS n FROM affiliate_revenue_events WHERE affiliate_id=$1 AND paid_out=FALSE`, [req.params.id]))[0]?.n || 0;
    const paid = (await safe(pool, `SELECT COALESCE(SUM(commission_cents),0)::bigint AS n FROM affiliate_payouts WHERE affiliate_id=$1`, [req.params.id]))[0]?.n || 0;
    res.json({
      affiliate: aff,
      commission_bps: COMMISSION_BPS,
      attribution_days: ATTRIBUTION_DAYS,
      codes,
      attributed_signups: attrCount,
      revenue: {
        events_count: revenue.events || 0,
        gross_cents: Number(revenue.gross || 0),
        commission_cents: Number(revenue.commission || 0),
        unpaid_commission_cents: Number(unpaid),
        paid_out_cents: Number(paid)
      }
    });
  });

  app.get('/v1/affiliates/leaderboard', async (req, res) => {
    res.json({ top: await safe(pool, `
      SELECT a.affiliate_id, a.display_name, COALESCE(SUM(e.commission_cents),0)::bigint AS commission, COUNT(DISTINCT att.org_id)::int AS signups
      FROM affiliates a
      LEFT JOIN affiliate_revenue_events e ON e.affiliate_id = a.affiliate_id
      LEFT JOIN affiliate_attributions att ON att.affiliate_id = a.affiliate_id
      WHERE a.revoked_at IS NULL
      GROUP BY a.affiliate_id, a.display_name
      ORDER BY commission DESC LIMIT 50
    `) });
  });

  // UI
  app.get('/affiliates', async (req, res) => {
    const totals = (await safe(pool, `
      SELECT (SELECT COUNT(*)::int FROM affiliates WHERE revoked_at IS NULL) AS active_affiliates,
             (SELECT COUNT(*)::int FROM affiliate_codes) AS codes,
             (SELECT COUNT(*)::int FROM affiliate_attributions) AS signups,
             (SELECT COALESCE(SUM(commission_cents),0)::bigint FROM affiliate_payouts) AS paid_all_time
    `))[0] || {};
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.send(shell('Affiliate Program', 'Earn 20% commission on referred customers for 12 months.',
`<section style="max-width:780px;margin:0 auto;padding:60px 16px">
  <span class="badge b-acc">Affiliate Program</span>
  <h1 style="font:600 40px/1.1 var(--display);letter-spacing:-1px;margin:18px 0">Affiliate program.</h1>
  <p style="color:var(--dim2);font-size:16px;line-height:1.7">Earn <strong style="color:var(--good)">${(COMMISSION_BPS/100).toFixed(0)}%</strong> commission on every payment your referred customers make for the next <strong>${ATTRIBUTION_DAYS} days</strong> after signup. Paid monthly in USDC.</p>
</section>
<section style="max-width:780px;margin:0 auto;padding:24px 16px">
  <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin-bottom:24px">
    <div class="kpi"><div class="label">Active affiliates</div><div class="value">${totals.active_affiliates || 0}</div></div>
    <div class="kpi"><div class="label">Active codes</div><div class="value">${totals.codes || 0}</div></div>
    <div class="kpi"><div class="label">Signups attributed</div><div class="value">${(totals.signups || 0).toLocaleString()}</div></div>
    <div class="kpi"><div class="label">Paid out (all time)</div><div class="value">$${(Number(totals.paid_all_time||0)/100).toLocaleString()}</div></div>
  </div>
</section>
<section style="max-width:780px;margin:0 auto;padding:0 16px 60px">
  <h2 style="font:600 20px var(--display);margin:24px 0 10px">Join in 60 seconds</h2>
  <pre style="background:var(--card);border:1px solid var(--br);border-radius:var(--r-md);padding:14px;overflow-x:auto;font-size:13px"><code># 1. Enroll
curl https://openheab.com/v1/affiliates \\
  -H "x-agent-did: $YOUR_DID" -H "x-agent-sig: $SIG" \\
  -H "content-type: application/json" \\
  -d '{ "affiliate_did": "'$YOUR_DID'", "display_name": "Your Name", "payout_address": "0xYourBaseAddress" }'

# 2. Mint a code
curl https://openheab.com/v1/affiliates/$AFFILIATE_ID/codes \\
  -H "x-agent-did: $YOUR_DID" -H "x-agent-sig: $SIG" \\
  -H "content-type: application/json" \\
  -d '{ "label": "main", "campaign": "youtube-launch" }'
# → { code, share_url }

# 3. Share the link. Every signup via ?ref=YOUR_CODE earns you 20% of their
#    bills for 12 months. Payouts go to your payout_address monthly.</code></pre>
  <h2 style="font:600 20px var(--display);margin:32px 0 10px">Leaderboard</h2>
  <div class="card" style="text-align:center;padding:32px;color:var(--dim)">Live at <a href="/v1/affiliates/leaderboard">/v1/affiliates/leaderboard</a>.</div>
</section>`));
  });
}

module.exports = { migrate, registerAffiliateProgramRoutes };
