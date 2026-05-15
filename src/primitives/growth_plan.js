// ============================================================================
// growth_plan.js — 90-day execution dashboard for the $10M MRR / $120M ARR
// goal. Tracks weekly net-new MRR target vs actual, distribution channel
// performance, milestone completion, and forecasts day-90 ARR using current
// growth rate.
// ============================================================================
const crypto = require('crypto');

// 90-day MRR ramp targets (cents) — exponential to hit $10M MRR by day 90
const WEEKLY_TARGETS_MRR_CENTS = [
  /*  W1 */    100_000_00,   //   $100K
  /*  W2 */    250_000_00,   //   $250K
  /*  W3 */    500_000_00,   //   $500K
  /*  W4 */  1_000_000_00,   //  $1.0M
  /*  W5 */  2_000_000_00,   //  $2.0M
  /*  W6 */  3_500_000_00,   //  $3.5M
  /*  W7 */  5_000_000_00,   //  $5.0M
  /*  W8 */  6_500_000_00,   //  $6.5M
  /*  W9 */  8_000_000_00,   //  $8.0M
  /* W10 */  9_000_000_00,   //  $9.0M
  /* W11 */  9_500_000_00,   //  $9.5M
  /* W12 */ 10_000_000_00,   // $10.0M  <-- target
  /* W13 */ 10_500_000_00    // $10.5M  buffer
];

const MILESTONES = [
  ['day_001', 'Form C-Corp + register openheab.com + open bank account', 'tier_0'],
  ['day_002', 'Submit MCP manifest to Smithery + mcp.run + ClaudePluginHub', 'distribution'],
  ['day_003', 'Show HN post (Tuesday 9am ET)', 'distribution'],
  ['day_004', 'Email 25 known agent-infra investors with deck', 'capital'],
  ['day_007', 'Stripe + Stripe Issuing applied; FeeSplitter on Base mainnet', 'tier_0'],
  ['day_010', 'First 10 paying customers', 'revenue'],
  ['day_014', 'YC W26 application submitted', 'capital'],
  ['day_021', 'First $25K MRR', 'revenue'],
  ['day_030', 'Founding GTM hire signed', 'team'],
  ['day_030', 'SOC 2 Type I audit kicked off (Vanta or Drata)', 'compliance'],
  ['day_045', 'First 50 paying customers + first enterprise contract', 'revenue'],
  ['day_045', 'First $500K MRR', 'revenue'],
  ['day_060', 'AWS / GCP / Azure marketplace listings live', 'distribution'],
  ['day_060', 'First $2M MRR', 'revenue'],
  ['day_075', 'Series Seed term sheet ($5-10M @ $25-50M post)', 'capital'],
  ['day_075', 'First $5M MRR', 'revenue'],
  ['day_090', 'First $10M MRR ($120M ARR)', 'revenue'],
  ['day_090', '40+ enterprise contracts signed; 1000+ SMB on paid plans', 'revenue']
];

async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS growth_plan_milestones (
      milestone_id     TEXT PRIMARY KEY,
      day_marker       TEXT NOT NULL,
      title            TEXT NOT NULL,
      category         TEXT NOT NULL,
      target_date      DATE,
      status           TEXT NOT NULL DEFAULT 'pending',
      completed_at     TIMESTAMPTZ,
      notes            TEXT
    );
    CREATE TABLE IF NOT EXISTS growth_plan_weekly (
      week_number      INTEGER PRIMARY KEY,
      target_mrr_cents BIGINT NOT NULL,
      actual_mrr_cents BIGINT,
      target_arr_cents BIGINT NOT NULL,
      actual_arr_cents BIGINT,
      paying_customers INTEGER,
      enterprise_count INTEGER,
      smb_count        INTEGER,
      week_start       DATE,
      computed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  // Seed milestones
  const startDate = new Date(process.env.GROWTH_PLAN_START_DATE || Date.now());
  for (const [marker, title, category] of MILESTONES) {
    const id = 'mile_' + crypto.createHash('sha256').update(marker + title).digest('hex').slice(0, 16);
    const dayNum = parseInt(marker.replace('day_', ''));
    const targetDate = new Date(startDate.getTime() + dayNum * 86400000).toISOString().slice(0, 10);
    await pool.query(
      `INSERT INTO growth_plan_milestones (milestone_id, day_marker, title, category, target_date, status)
       VALUES ($1,$2,$3,$4,$5,'pending') ON CONFLICT (milestone_id) DO NOTHING`,
      [id, marker, title, category, targetDate]
    ).catch(() => {});
  }
  // Seed weekly targets
  const startMs = startDate.getTime();
  for (let i = 0; i < WEEKLY_TARGETS_MRR_CENTS.length; i++) {
    const wkStart = new Date(startMs + i * 7 * 86400000).toISOString().slice(0, 10);
    await pool.query(
      `INSERT INTO growth_plan_weekly (week_number, target_mrr_cents, target_arr_cents, week_start)
       VALUES ($1,$2,$3,$4) ON CONFLICT (week_number) DO UPDATE
       SET target_mrr_cents = EXCLUDED.target_mrr_cents,
           target_arr_cents = EXCLUDED.target_arr_cents,
           week_start = EXCLUDED.week_start`,
      [i + 1, WEEKLY_TARGETS_MRR_CENTS[i], WEEKLY_TARGETS_MRR_CENTS[i] * 12, wkStart]
    ).catch(() => {});
  }
}

function isAdmin(req) {
  const t = req.headers['x-admin-token'];
  return t && t === process.env.OPERATOR_ADMIN_TOKEN;
}

async function snapshotCurrentWeek(pool) {
  const start = new Date(process.env.GROWTH_PLAN_START_DATE || Date.now());
  const elapsed = (Date.now() - start.getTime()) / (7 * 86400000);
  const week = Math.max(1, Math.min(13, Math.ceil(elapsed)));

  let mrr = 0;
  try {
    const rev = require('./revenue');
    const arr = await rev.getCurrentARR(pool);
    mrr = arr.mrr_cents;
  } catch {}

  const orgs = await pool.query(`SELECT COUNT(*)::int AS c FROM orgs WHERE plan != 'free'`).catch(() => ({ rows: [{ c: 0 }] }));
  const enterprise = await pool.query(`SELECT COUNT(*)::int AS c FROM orgs WHERE plan = 'enterprise'`).catch(() => ({ rows: [{ c: 0 }] }));
  const smb = await pool.query(`SELECT COUNT(*)::int AS c FROM orgs WHERE plan IN ('pro','scale')`).catch(() => ({ rows: [{ c: 0 }] }));

  await pool.query(`
    UPDATE growth_plan_weekly SET actual_mrr_cents=$1, actual_arr_cents=$2,
      paying_customers=$3, enterprise_count=$4, smb_count=$5, computed_at=NOW()
    WHERE week_number=$6
  `, [mrr, mrr * 12, orgs.rows[0].c, enterprise.rows[0].c, smb.rows[0].c, week]).catch(() => {});

  return { week, mrr_cents: mrr, paying_customers: orgs.rows[0].c };
}

function registerGrowthPlanRoutes(app, pool, _verifyAgentAuth, _auditChain) {
  app.get('/v1/admin/growth-plan/dashboard', async (req, res) => {
    if (!isAdmin(req)) return res.status(401).json({ error: 'admin_auth_required' });

    // Refresh current week
    await snapshotCurrentWeek(pool).catch(() => {});

    const weekly = await pool.query(`SELECT * FROM growth_plan_weekly ORDER BY week_number`).catch(() => ({ rows: [] }));
    const milestones = await pool.query(`SELECT * FROM growth_plan_milestones ORDER BY target_date, day_marker`).catch(() => ({ rows: [] }));

    const start = new Date(process.env.GROWTH_PLAN_START_DATE || Date.now());
    const elapsed = Math.max(0, (Date.now() - start.getTime()) / 86400000);
    const dayNumber = Math.floor(elapsed) + 1;
    const currentWeek = Math.max(1, Math.min(13, Math.ceil(elapsed / 7)));
    const w = weekly.rows[currentWeek - 1] || {};
    const target = Number(w.target_mrr_cents || 0);
    const actual = Number(w.actual_mrr_cents || 0);
    const onTrackPct = target > 0 ? Math.round((actual / target) * 100) : 0;

    // Linear projection of day-90 MRR from last 3 weeks of growth
    const recent = weekly.rows.filter(r => r.actual_mrr_cents != null).slice(-3);
    let projectedDay90 = actual;
    if (recent.length >= 2) {
      const first = Number(recent[0].actual_mrr_cents);
      const last = Number(recent[recent.length - 1].actual_mrr_cents);
      const wkGrowth = recent.length > 1 ? Math.pow(Math.max(1, last) / Math.max(1, first), 1 / (recent.length - 1)) : 1;
      projectedDay90 = Math.round(actual * Math.pow(wkGrowth, Math.max(0, 12 - currentWeek)));
    }

    res.json({
      day_number: dayNumber,
      week_number: currentWeek,
      target_mrr_cents: target,
      actual_mrr_cents: actual,
      target_arr_cents: target * 12,
      actual_arr_cents: actual * 12,
      on_track_pct: onTrackPct,
      paying_customers: w.paying_customers || 0,
      enterprise_count: w.enterprise_count || 0,
      smb_count: w.smb_count || 0,
      projected_day_90_mrr_cents: projectedDay90,
      projected_day_90_arr_cents: projectedDay90 * 12,
      goal_day_90_mrr_cents: 10_000_000_00,
      gap_to_goal_cents: Math.max(0, 10_000_000_00 - projectedDay90),
      weekly_plan: weekly.rows,
      milestones: {
        total: milestones.rows.length,
        completed: milestones.rows.filter(m => m.status === 'completed').length,
        next_3: milestones.rows.filter(m => m.status === 'pending').slice(0, 3),
        all: milestones.rows
      }
    });
  });

  app.post('/v1/admin/growth-plan/milestones/:mid/complete', async (req, res) => {
    if (!isAdmin(req)) return res.status(401).json({ error: 'admin_auth_required' });
    const r = await pool.query(`UPDATE growth_plan_milestones SET status='completed', completed_at=NOW(), notes=$1 WHERE milestone_id=$2 RETURNING milestone_id`,
      [req.body?.notes || null, req.params.mid]).catch(() => ({ rows: [] }));
    if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
    res.json({ milestone_id: r.rows[0].milestone_id, status: 'completed' });
  });

  app.get('/v1/admin/growth-plan/forecast', async (req, res) => {
    if (!isAdmin(req)) return res.status(401).json({ error: 'admin_auth_required' });
    const snap = await snapshotCurrentWeek(pool);
    res.json(snap);
  });

  // Public version (sanitized) — for the /roadmap or /status page if we want
  app.get('/v1/growth-plan/public', async (req, res) => {
    const milestones = await pool.query(`SELECT day_marker, title, category, status, target_date FROM growth_plan_milestones ORDER BY target_date`)
      .catch(() => ({ rows: [] }));
    res.json({
      goal: '$10M MRR ($120M ARR) within 90 days',
      milestones_total: milestones.rows.length,
      milestones_completed: milestones.rows.filter(m => m.status === 'completed').length,
      milestones: milestones.rows
    });
  });
}

module.exports = { migrate, registerGrowthPlanRoutes, snapshotCurrentWeek, WEEKLY_TARGETS_MRR_CENTS, MILESTONES };
