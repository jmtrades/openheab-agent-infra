// ============================================================================
// customer_success.js — health scoring, churn prediction, NPS surveys, CAB
// program, weekly business reviews, expansion-opportunity flagging. The
// retention + expansion engine that compounds MRR.
// ============================================================================
const crypto = require('crypto');
const { z } = require('zod');
const { registerCron } = require('../cron_auth');

async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cs_health_scores (
      org_id            TEXT PRIMARY KEY,
      composite_score   INTEGER NOT NULL DEFAULT 50,
      band              TEXT NOT NULL DEFAULT 'medium',
      activity_score    INTEGER NOT NULL DEFAULT 0,
      engagement_score  INTEGER NOT NULL DEFAULT 0,
      financial_score   INTEGER NOT NULL DEFAULT 0,
      support_score     INTEGER NOT NULL DEFAULT 0,
      adoption_score    INTEGER NOT NULL DEFAULT 0,
      churn_risk        REAL NOT NULL DEFAULT 0,
      computed_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS cs_nps_surveys (
      survey_id         TEXT PRIMARY KEY,
      org_id            TEXT NOT NULL,
      respondent_email  TEXT,
      score             INTEGER,
      verbatim          TEXT,
      sent_at           TIMESTAMPTZ,
      responded_at      TIMESTAMPTZ,
      campaign          TEXT,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS cs_qbr_packs (
      pack_id           TEXT PRIMARY KEY,
      org_id            TEXT NOT NULL,
      quarter           TEXT NOT NULL,
      mrr_at_start_cents BIGINT,
      mrr_at_end_cents  BIGINT,
      key_wins          TEXT[],
      key_risks         TEXT[],
      expansion_opps    JSONB,
      action_items      JSONB,
      generated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS cs_expansion_opportunities (
      opp_id            TEXT PRIMARY KEY,
      org_id            TEXT NOT NULL,
      kind              TEXT NOT NULL,
      reason            TEXT,
      potential_cents   BIGINT,
      probability       REAL,
      flagged_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      status            TEXT NOT NULL DEFAULT 'open',
      closed_at         TIMESTAMPTZ
    );
    CREATE TABLE IF NOT EXISTS cs_cab_members (
      member_id         TEXT PRIMARY KEY,
      org_id            TEXT NOT NULL,
      contact_email     TEXT NOT NULL,
      role              TEXT NOT NULL DEFAULT 'member',
      term_starts       DATE,
      term_ends         DATE,
      perks             JSONB,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

function newId(p) { return p + '_' + crypto.randomBytes(10).toString('hex'); }
function isAdmin(req) {
  const t = req.headers['x-admin-token'];
  return require('../safe_compare').safeTokenCompare(t, process.env.OPERATOR_ADMIN_TOKEN);
}

async function computeHealth(pool, orgId) {
  // Activity: api calls + dashboard logins in last 30 days
  let activity = 0;
  try {
    const r = await pool.query(`SELECT COUNT(*)::int AS c FROM marketing_pageviews WHERE path LIKE '/v1/dashboard%' AND occurred_at > NOW() - INTERVAL '30 days'`)
      .catch(() => ({ rows: [{ c: 0 }] }));
    activity = Math.min(100, r.rows[0].c);
  } catch {}

  // Engagement: meter events
  let engagement = 0;
  try {
    const r = await pool.query(`SELECT COUNT(*)::int AS c FROM meter_events WHERE org_id=$1 AND occurred_at > NOW() - INTERVAL '30 days'`, [orgId])
      .catch(() => ({ rows: [{ c: 0 }] }));
    engagement = Math.min(100, Math.floor(r.rows[0].c / 10));
  } catch {}

  // Financial: paid + on-time payments
  let financial = 50;
  try {
    const r = await pool.query(`SELECT plan FROM orgs WHERE org_id=$1`, [orgId]).catch(() => ({ rows: [] }));
    const plan = r.rows[0]?.plan;
    if (plan === 'enterprise') financial = 95;
    else if (plan === 'scale') financial = 80;
    else if (plan === 'pro') financial = 65;
    else financial = 30;
  } catch {}

  // Support: tickets in last 30 days (more open tickets = lower score)
  let support = 80;
  try {
    const r = await pool.query(`SELECT COUNT(*)::int AS open FROM support_tickets WHERE owner_did IN (SELECT owner_did FROM orgs WHERE org_id=$1) AND status IN ('open','pending') AND created_at > NOW() - INTERVAL '30 days'`, [orgId])
      .catch(() => ({ rows: [{ open: 0 }] }));
    support = Math.max(0, 100 - r.rows[0].open * 15);
  } catch {}

  // Adoption: distinct primitives used
  let adoption = 0;
  try {
    const r = await pool.query(`SELECT COUNT(DISTINCT kind)::int AS c FROM meter_events WHERE org_id=$1 AND occurred_at > NOW() - INTERVAL '30 days'`, [orgId])
      .catch(() => ({ rows: [{ c: 0 }] }));
    adoption = Math.min(100, r.rows[0].c * 8);
  } catch {}

  const composite = Math.round(0.20 * activity + 0.25 * engagement + 0.25 * financial + 0.15 * support + 0.15 * adoption);
  const band = composite >= 75 ? 'green' : composite >= 50 ? 'yellow' : 'red';
  const churnRisk = Math.max(0, Math.min(1, (100 - composite) / 100));

  await pool.query(`
    INSERT INTO cs_health_scores (org_id, composite_score, band, activity_score, engagement_score,
      financial_score, support_score, adoption_score, churn_risk, computed_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
    ON CONFLICT (org_id) DO UPDATE SET composite_score=$2, band=$3, activity_score=$4,
      engagement_score=$5, financial_score=$6, support_score=$7, adoption_score=$8,
      churn_risk=$9, computed_at=NOW()
  `, [orgId, composite, band, activity, engagement, financial, support, adoption, churnRisk]).catch(() => {});

  return { org_id: orgId, composite_score: composite, band, churn_risk: churnRisk,
           breakdown: { activity, engagement, financial, support, adoption } };
}

const npsSchema = z.object({
  score: z.number().int().min(0).max(10),
  verbatim: z.string().max(2000).optional(),
  org_id: z.string().optional(),
  campaign: z.string().optional()
});

function registerCustomerSuccessRoutes(app, pool, verifyAgentAuth, auditChain) {
  const express = require('express');

  app.get('/v1/admin/cs/health', async (req, res) => {
    if (!isAdmin(req)) return res.status(401).json({ error: 'admin_auth_required' });
    const r = await pool.query(`SELECT org_id, composite_score, band, churn_risk, computed_at FROM cs_health_scores ORDER BY churn_risk DESC LIMIT 200`)
      .catch(() => ({ rows: [] }));
    const summary = {
      total: r.rows.length,
      green: r.rows.filter(x => x.band === 'green').length,
      yellow: r.rows.filter(x => x.band === 'yellow').length,
      red: r.rows.filter(x => x.band === 'red').length,
      avg_churn_risk: r.rows.length ? (r.rows.reduce((a, x) => a + Number(x.churn_risk), 0) / r.rows.length) : 0
    };
    res.json({ summary, accounts: r.rows });
  });

  app.get('/v1/orgs/:id/cs/health', async (req, res) => {
    const did = req.headers['x-agent-did'];
    if (!did) return res.status(401).json({ error: 'agent_did_required' });
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const fresh = await computeHealth(pool, req.params.id);
    res.json(fresh);
  });

  // NPS public endpoint (link from email)
  app.post('/v1/cs/nps', express.json(), async (req, res) => {
    const p = npsSchema.safeParse(req.body || {});
    if (!p.success) return res.status(400).json({ error: 'invalid_input', details: p.error.flatten() });
    const id = newId('nps');
    await pool.query(
      `INSERT INTO cs_nps_surveys (survey_id, org_id, score, verbatim, campaign, responded_at)
       VALUES ($1,$2,$3,$4,$5,NOW())`,
      [id, p.data.org_id || 'unknown', p.data.score, p.data.verbatim || null, p.data.campaign || null]
    );
    if (auditChain) await auditChain.append({ event_type: 'cs.nps_recorded', score: p.data.score, org_id: p.data.org_id }).catch(() => {});
    res.status(201).json({ survey_id: id });
  });

  app.get('/v1/admin/cs/nps', async (req, res) => {
    if (!isAdmin(req)) return res.status(401).json({ error: 'admin_auth_required' });
    const days = parseInt(req.query.days) || 90;
    const r = await pool.query(`
      SELECT score, COUNT(*)::int AS c FROM cs_nps_surveys
      WHERE responded_at > NOW() - ($1 || ' days')::interval AND score IS NOT NULL
      GROUP BY score ORDER BY score
    `, [days]).catch(() => ({ rows: [] }));
    let promoters = 0, passives = 0, detractors = 0, total = 0;
    for (const row of r.rows) {
      const c = Number(row.c);
      total += c;
      if (row.score >= 9) promoters += c;
      else if (row.score >= 7) passives += c;
      else detractors += c;
    }
    const nps = total ? Math.round(((promoters - detractors) / total) * 100) : null;
    res.json({ window_days: days, total, promoters, passives, detractors, nps_score: nps, distribution: r.rows });
  });

  app.post('/v1/admin/cs/qbr-packs', express.json(), async (req, res) => {
    if (!isAdmin(req)) return res.status(401).json({ error: 'admin_auth_required' });
    const id = newId('qbr');
    await pool.query(
      `INSERT INTO cs_qbr_packs (pack_id, org_id, quarter, mrr_at_start_cents, mrr_at_end_cents,
         key_wins, key_risks, expansion_opps, action_items)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [id, req.body?.org_id, req.body?.quarter || 'Q1-2026',
       req.body?.mrr_at_start_cents || 0, req.body?.mrr_at_end_cents || 0,
       req.body?.key_wins || [], req.body?.key_risks || [],
       JSON.stringify(req.body?.expansion_opps || []), JSON.stringify(req.body?.action_items || [])]
    );
    res.status(201).json({ pack_id: id });
  });

  app.post('/v1/admin/cs/expansion', express.json(), async (req, res) => {
    if (!isAdmin(req)) return res.status(401).json({ error: 'admin_auth_required' });
    const id = newId('opp');
    await pool.query(
      `INSERT INTO cs_expansion_opportunities (opp_id, org_id, kind, reason, potential_cents, probability)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [id, req.body?.org_id, req.body?.kind || 'upsell', req.body?.reason || null,
       req.body?.potential_cents || 0, req.body?.probability || 0.5]
    );
    res.status(201).json({ opp_id: id });
  });

  app.post('/v1/admin/cs/cab', express.json(), async (req, res) => {
    if (!isAdmin(req)) return res.status(401).json({ error: 'admin_auth_required' });
    const id = newId('cab');
    await pool.query(
      `INSERT INTO cs_cab_members (member_id, org_id, contact_email, role, term_starts, term_ends, perks)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [id, req.body?.org_id, req.body?.contact_email, req.body?.role || 'member',
       req.body?.term_starts || new Date().toISOString().slice(0, 10),
       req.body?.term_ends || new Date(Date.now() + 365 * 86400000).toISOString().slice(0, 10),
       JSON.stringify(req.body?.perks || ['quarterly product preview', 'direct line to founder'])]
    );
    res.status(201).json({ member_id: id });
  });

  registerCron(app, '/v1/_jobs/cs-health-recompute', async (req, res) => {
    const r = await pool.query(`SELECT org_id FROM orgs WHERE plan != 'free' LIMIT 1000`).catch(() => ({ rows: [] }));
    let computed = 0;
    for (const o of r.rows) { try { await computeHealth(pool, o.org_id); computed++; } catch {} }
    res.json({ computed });
  });
}

module.exports = { migrate, registerCustomerSuccessRoutes, computeHealth };
