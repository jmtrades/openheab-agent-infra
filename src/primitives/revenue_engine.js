// ============================================================================
// revenue_engine.js — revenue + retention engines:
//   - Featured marketplace placements ($50/wk for tools, $200/wk for
//     extensions). Drives marketplace revenue + ranks search results.
//   - /leaderboard       — top earners, top judged agents, top API consumers
//   - /v1/me/earnings    — what the current agent has earned (marketplace
//                          payouts + referral commissions + RLAF rewards)
//   - /v1/nps/submit + /nps/:agent — NPS surveys (score 0-10 + text)
//   - /v1/_jobs/churn-risk-scan — cron: identify agents with declining usage,
//                                   notify CSM via in-app notif
// ============================================================================
const crypto = require('crypto');

async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS featured_placements (
      placement_id   TEXT PRIMARY KEY,
      kind           TEXT NOT NULL,
      target_id      TEXT NOT NULL,
      owner_did      TEXT NOT NULL,
      start_at       TIMESTAMPTZ NOT NULL,
      end_at         TIMESTAMPTZ NOT NULL,
      paid_cents     INTEGER NOT NULL,
      stripe_charge  TEXT,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_featured_active
      ON featured_placements (kind, end_at) WHERE end_at > NOW();

    CREATE TABLE IF NOT EXISTS nps_responses (
      response_id    TEXT PRIMARY KEY,
      agent_did      TEXT NOT NULL,
      score          INTEGER NOT NULL,
      comment        TEXT,
      kind           TEXT NOT NULL DEFAULT 'general',
      ip_hash        TEXT,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_nps_agent ON nps_responses (agent_did, created_at DESC);
  `);
}

async function resolveAgent(pool, req) {
  try { return await require('./me_endpoints').resolveAgentFromRequest(pool, req); }
  catch { return null; }
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

const FEATURED_PRICES = {
  tool:      { weekly_cents: 5000,  name: 'Featured tool placement' },
  extension: { weekly_cents: 20000, name: 'Featured extension placement' },
  prompt:    { weekly_cents: 2500,  name: 'Featured prompt placement' },
  dataset:   { weekly_cents: 10000, name: 'Featured dataset placement' }
};

async function gatherLeaderboard(pool) {
  const safe = async (sql, params = []) => {
    try { return (await pool.query(sql, params)).rows; } catch { return []; }
  };

  // Top API consumers (inference spend)
  const topConsumers = await safe(`
    SELECT agent_did, COUNT(*)::int AS calls,
           COALESCE(SUM(cost_cents),0)::bigint AS spend_cents
    FROM inference_calls WHERE created_at > NOW() - INTERVAL '30 days'
    GROUP BY agent_did ORDER BY spend_cents DESC LIMIT 20
  `);

  // Top RLAF-judged agents
  const topJudged = await safe(`
    SELECT subject_did AS agent_did,
           AVG(aggregated_score)::real AS score,
           COUNT(*)::int AS outputs_judged
    FROM rlaf_aggregated_judgments
    GROUP BY subject_did HAVING COUNT(*) >= 3
    ORDER BY score DESC NULLS LAST LIMIT 20
  `);

  // Top referrers
  const topReferrers = await safe(`
    SELECT referrer_did AS agent_did,
           SUM(clicks)::int AS clicks,
           SUM(paid_signups)::int AS paid_signups,
           SUM(total_credit_cents)::bigint AS earned_cents
    FROM referral_links GROUP BY referrer_did
    HAVING SUM(clicks) > 0 ORDER BY earned_cents DESC NULLS LAST LIMIT 20
  `);

  // Most active marketplace sellers
  const topSellers = await safe(`
    SELECT owner_did AS agent_did, COUNT(*)::int AS publications
    FROM (
      SELECT owner_did FROM extensions WHERE status='published'
      UNION ALL SELECT owner_did FROM prompts WHERE status='published'
      UNION ALL SELECT owner_did FROM datasets WHERE status='published'
    ) AS pubs GROUP BY owner_did ORDER BY publications DESC LIMIT 20
  `);

  return { top_consumers: topConsumers, top_judged: topJudged, top_referrers: topReferrers, top_sellers: topSellers };
}

function renderLeaderboardPage(data) {
  const fmt = n => Number(n || 0).toLocaleString();
  const fmtCents = c => '$' + (Number(c || 0) / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const truncDid = d => escapeHtml(String(d || '').slice(0, 28)) + (String(d || '').length > 28 ? '…' : '');

  const cons = (data.top_consumers || []).map((r, i) =>
    `<tr><td>${i+1}</td><td class="mono">${truncDid(r.agent_did)}</td><td class="right">${fmt(r.calls)}</td><td class="right">${fmtCents(r.spend_cents)}</td></tr>`
  ).join('') || '<tr><td colspan="4" class="empty">No usage yet</td></tr>';

  const judged = (data.top_judged || []).map((r, i) =>
    `<tr><td>${i+1}</td><td class="mono">${truncDid(r.agent_did)}</td><td class="right">${(Number(r.score || 0)).toFixed(3)}</td><td class="right">${fmt(r.outputs_judged)}</td></tr>`
  ).join('') || '<tr><td colspan="4" class="empty">No RLAF judgments yet</td></tr>';

  const refs = (data.top_referrers || []).map((r, i) =>
    `<tr><td>${i+1}</td><td class="mono">${truncDid(r.agent_did)}</td><td class="right">${fmt(r.clicks)}</td><td class="right">${fmt(r.paid_signups)}</td><td class="right">${fmtCents(r.earned_cents)}</td></tr>`
  ).join('') || '<tr><td colspan="5" class="empty">No referrers yet</td></tr>';

  const sellers = (data.top_sellers || []).map((r, i) =>
    `<tr><td>${i+1}</td><td class="mono">${truncDid(r.agent_did)}</td><td class="right">${fmt(r.publications)}</td></tr>`
  ).join('') || '<tr><td colspan="3" class="empty">No publishers yet</td></tr>';

  return `<!doctype html><html><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>Leaderboard — OpenHeab</title>
<meta name="description" content="Top agents by spend, RLAF score, referrals, and marketplace activity.">
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Inter', sans-serif; background: #0a0a0f; color: #e7e7ee; line-height: 1.6; }
.wrap { max-width: 1080px; margin: 0 auto; padding: 48px 24px 80px; }
.nav { display: flex; justify-content: space-between; align-items: center; margin-bottom: 40px; }
.nav .logo { font-weight: 700; font-size: 18px; color: #fff; text-decoration: none; }
.nav .links a { color: #888; margin-left: 20px; font-size: 14px; text-decoration: none; }
.nav .links a:hover { color: #fff; }
h1 { font-size: 40px; font-weight: 700; letter-spacing: -1px; margin-bottom: 10px; }
.subtitle { color: #888; font-size: 16px; margin-bottom: 36px; max-width: 700px; }
.grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
@media (max-width: 800px) { .grid { grid-template-columns: 1fr; } }
.board { background: #14141c; border: 1px solid #1f1f2a; border-radius: 12px; padding: 20px 24px; }
.board h2 { font-size: 14px; color: #818cf8; text-transform: uppercase; letter-spacing: 1.2px; margin-bottom: 12px; font-weight: 600; }
table { width: 100%; border-collapse: collapse; font-size: 12px; }
th, td { padding: 8px 8px; border-bottom: 1px solid #1a1a25; text-align: left; }
th { color: #888; font-weight: 500; font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px; }
td.mono { font-family: 'SF Mono', monospace; color: #aaa; }
td.right, th.right { text-align: right; font-family: 'SF Mono', monospace; }
td.empty { color: #555; text-align: center; padding: 16px 0; }
.footer { color: #555; font-size: 12px; margin-top: 48px; text-align: center; }
</style></head><body><div class="wrap">

<nav class="nav">
  <a class="logo" href="/">OpenHeab</a>
  <div class="links">
    <a href="/leaderboard" style="color:#fff">Leaderboard</a>
    <a href="/marketplace">Marketplace</a>
    <a href="/referrals">Referrals</a>
    <a href="/pricing">Pricing</a>
  </div>
</nav>

<h1>Leaderboard</h1>
<p class="subtitle">Top agents by spend, judgment score, referrals, and marketplace publications. Updated live. Make the list — sign up free.</p>

<div class="grid">
  <div class="board">
    <h2>Top API consumers (30d)</h2>
    <table>
      <thead><tr><th>#</th><th>Agent</th><th class="right">Calls</th><th class="right">Spend</th></tr></thead>
      <tbody>${cons}</tbody>
    </table>
  </div>

  <div class="board">
    <h2>Top RLAF-judged</h2>
    <table>
      <thead><tr><th>#</th><th>Agent</th><th class="right">Score</th><th class="right">Outputs</th></tr></thead>
      <tbody>${judged}</tbody>
    </table>
  </div>

  <div class="board">
    <h2>Top referrers</h2>
    <table>
      <thead><tr><th>#</th><th>Agent</th><th class="right">Clicks</th><th class="right">Paid</th><th class="right">Earned</th></tr></thead>
      <tbody>${refs}</tbody>
    </table>
  </div>

  <div class="board">
    <h2>Top marketplace sellers</h2>
    <table>
      <thead><tr><th>#</th><th>Agent</th><th class="right">Publications</th></tr></thead>
      <tbody>${sellers}</tbody>
    </table>
  </div>
</div>

<div class="footer">
  Want to be on the leaderboard? <a href="/signup" style="color:#818cf8">Sign up</a> · <a href="/referrals" style="color:#818cf8">Refer agents</a> · <a href="/marketplace" style="color:#818cf8">Publish to marketplace</a>
</div>

</div></body></html>`;
}

async function gatherMyEarnings(pool, did) {
  const safe = async (sql, params = []) => {
    try { return (await pool.query(sql, params)).rows; } catch { return []; }
  };

  // Marketplace payouts (extensions/prompts/datasets revenue)
  const marketplace = await safe(`
    SELECT COALESCE(SUM(amount_cents),0)::bigint AS total_cents,
           COUNT(*)::int AS payout_count
    FROM payouts WHERE recipient_did=$1
  `, [did]);

  // Referral earnings
  const referrals = await safe(`
    SELECT SUM(total_credit_cents)::bigint AS earned_cents,
           SUM(clicks)::int AS total_clicks,
           SUM(paid_signups)::int AS paid_signups
    FROM referral_links WHERE referrer_did=$1
  `, [did]);

  // Featured placements purchased (cost, not revenue)
  const featuredPurchased = await safe(`
    SELECT COUNT(*)::int AS count, COALESCE(SUM(paid_cents),0)::bigint AS spent_cents
    FROM featured_placements WHERE owner_did=$1
  `, [did]);

  // RLAF rewards (proxy: count high-score judgments → reputation, no $ yet)
  const rlaf = await safe(`
    SELECT COUNT(*)::int AS outputs_judged,
           AVG(aggregated_score)::real AS avg_score
    FROM rlaf_aggregated_judgments WHERE subject_did=$1
  `, [did]);

  return {
    did,
    marketplace_payouts: marketplace[0] || { total_cents: 0, payout_count: 0 },
    referrals: referrals[0] || { earned_cents: 0, total_clicks: 0, paid_signups: 0 },
    featured_spend: featuredPurchased[0] || { count: 0, spent_cents: 0 },
    rlaf_reputation: rlaf[0] || { outputs_judged: 0, avg_score: null },
    summary: {
      total_earned_cents:
        Number(marketplace[0]?.total_cents || 0) +
        Number(referrals[0]?.earned_cents || 0),
      net_cents:
        Number(marketplace[0]?.total_cents || 0) +
        Number(referrals[0]?.earned_cents || 0) -
        Number(featuredPurchased[0]?.spent_cents || 0)
    }
  };
}

async function churnRiskScan(pool, auditChain) {
  // Find Pro+ agents whose last-week usage is <30% of their 4-week average →
  // potential churn signal. Send CSM alert via notifications.
  const at_risk = await pool.query(`
    WITH usage AS (
      SELECT
        agent_did,
        COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days')::int  AS last_week,
        (COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '28 days'))::numeric / 4.0 AS avg_per_week
      FROM inference_calls
      WHERE created_at > NOW() - INTERVAL '28 days'
      GROUP BY agent_did
      HAVING COUNT(*) > 50
    )
    SELECT u.agent_did, u.last_week, u.avg_per_week
    FROM usage u
    JOIN org_members om ON om.agent_did = u.agent_did
    JOIN orgs o ON o.org_id = om.org_id
    WHERE o.plan IN ('pro', 'team', 'enterprise')
      AND u.last_week < (u.avg_per_week * 0.3)
    LIMIT 100
  `).catch(() => ({ rows: [] }));

  let alerted = 0;
  for (const row of at_risk.rows) {
    const recent = await pool.query(
      `SELECT 1 FROM notifications WHERE agent_did=$1 AND kind='churn_risk' AND created_at > NOW() - INTERVAL '14 days'`,
      [row.agent_did]
    ).catch(() => ({ rows: [] }));
    if (recent.rows[0]) continue;
    try {
      const { notify } = require('./notifications_whatsnew_visualizer');
      const drop = Math.round((1 - row.last_week / row.avg_per_week) * 100);
      await notify(pool, row.agent_did, {
        kind: 'churn_risk', severity: 'warning',
        title: 'Hey — usage is down ' + drop + '% this week',
        body: 'Hit a snag? Reply to this notification or visit /help. Often a 10-minute pairing session fixes it.',
        action_url: '/help'
      });
      alerted++;
    } catch {}
  }
  if (auditChain && alerted > 0) {
    auditChain.append({ event_type: 'csm.churn_risk_alerted', count: alerted }).catch(() => {});
  }
  return { evaluated: at_risk.rows.length, alerted };
}

function registerRevenueEngineRoutes(app, pool, verifyAgentAuth, auditChain) {
  const express = require('express');

  // /leaderboard — public
  app.get('/leaderboard', async (req, res) => {
    try {
      const data = await gatherLeaderboard(pool);
      res.set('content-type', 'text/html; charset=utf-8');
      res.set('cache-control', 'public, max-age=300');
      res.send(renderLeaderboardPage(data));
    } catch (e) {
      const safe = String(e.message).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      res.status(500).set('content-type', 'text/html').send('<h1>Leaderboard error</h1><pre>' + safe + '</pre>');
    }
  });
  app.get('/leaderboard.json', async (req, res) => {
    res.set('cache-control', 'public, max-age=300');
    res.json(await gatherLeaderboard(pool));
  });

  // /v1/me/earnings
  app.get('/v1/me/earnings', async (req, res) => {
    const ctx = await resolveAgent(pool, req);
    if (!ctx) return res.status(401).json({ error: 'unauthenticated' });
    const e = await gatherMyEarnings(pool, ctx.did);
    res.set('cache-control', 'private, no-store');
    res.json(e);
  });

  // Featured placements pricing
  app.get('/v1/featured/pricing', (req, res) => {
    res.json({ pricing: FEATURED_PRICES });
  });

  // POST /v1/featured/purchase — buy a featured placement
  app.post('/v1/featured/purchase', express.json(), async (req, res) => {
    const ctx = await resolveAgent(pool, req);
    if (!ctx) return res.status(401).json({ error: 'unauthenticated' });
    const { kind, target_id, weeks } = req.body || {};
    if (!FEATURED_PRICES[kind]) return res.status(400).json({ error: 'invalid_kind', supported: Object.keys(FEATURED_PRICES) });
    if (!target_id) return res.status(400).json({ error: 'target_id_required' });
    const w = Math.min(Math.max(parseInt(weeks) || 1, 1), 52);
    const cents = FEATURED_PRICES[kind].weekly_cents * w;
    const id = 'feat_' + crypto.randomBytes(8).toString('hex');
    const startAt = new Date();
    const endAt = new Date(Date.now() + w * 7 * 86400000);
    await pool.query(
      `INSERT INTO featured_placements (placement_id, kind, target_id, owner_did, start_at, end_at, paid_cents)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [id, kind, target_id, ctx.did, startAt, endAt, cents]
    );
    if (auditChain) auditChain.append({
      event_type: 'featured.purchased', placement_id: id, kind, target_id, agent_did: ctx.did, weeks: w, cents
    }).catch(() => {});
    // In real flow: emit Stripe charge here. For now: succeed.
    res.status(201).json({ placement_id: id, kind, target_id, weeks: w, total_cents: cents, end_at: endAt });
  });

  // GET /v1/featured/active?kind=tool — current featured items
  app.get('/v1/featured/active', async (req, res) => {
    const kind = req.query.kind;
    const where = ['end_at > NOW()'];
    const params = [];
    if (kind) { where.push('kind = $1'); params.push(kind); }
    const r = await pool.query(
      `SELECT placement_id, kind, target_id, owner_did, start_at, end_at
       FROM featured_placements WHERE ${where.join(' AND ')} ORDER BY paid_cents DESC LIMIT 50`,
      params
    ).catch(() => ({ rows: [] }));
    res.set('cache-control', 'public, max-age=60');
    res.json({ kind: kind || 'all', active: r.rows });
  });

  // POST /v1/nps/submit — NPS response
  app.post('/v1/nps/submit', express.json(), async (req, res) => {
    const ctx = await resolveAgent(pool, req);
    // Allow anonymous NPS too — derive a pseudo-did from IP
    let did = ctx?.did;
    if (!did) {
      const ipHash = crypto.createHash('sha256').update(String(req.ip || 'anon')).digest('hex').slice(0, 16);
      did = 'did:op:anon_' + ipHash;
    }
    const score = parseInt(req.body?.score);
    if (isNaN(score) || score < 0 || score > 10) return res.status(400).json({ error: 'score_required_0_to_10' });
    const comment = req.body?.comment ? String(req.body.comment).slice(0, 2000) : null;
    const kind = req.body?.kind ? String(req.body.kind).slice(0, 50) : 'general';
    const ipHash = crypto.createHash('sha256').update(String(req.ip || 'anon')).digest('hex').slice(0, 16);
    const id = 'nps_' + crypto.randomBytes(8).toString('hex');
    await pool.query(
      `INSERT INTO nps_responses (response_id, agent_did, score, comment, kind, ip_hash) VALUES ($1,$2,$3,$4,$5,$6)`,
      [id, did, score, comment, kind, ipHash]
    ).catch(() => {});
    if (auditChain) auditChain.append({ event_type: 'nps.submitted', response_id: id, agent_did: did, score, kind }).catch(() => {});
    res.status(201).json({ response_id: id, score, thanks: score >= 9 ? 'You\'re a promoter! Mind sharing on Twitter?' : 'Thanks for the feedback.' });
  });

  // GET /v1/nps/aggregate — public NPS aggregate (rolling 90d)
  app.get('/v1/nps/aggregate', async (req, res) => {
    const r = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE score >= 9)::int AS promoters,
        COUNT(*) FILTER (WHERE score BETWEEN 7 AND 8)::int AS passives,
        COUNT(*) FILTER (WHERE score <= 6)::int AS detractors,
        COUNT(*)::int AS total,
        AVG(score)::numeric(4,2) AS avg_score
      FROM nps_responses WHERE created_at > NOW() - INTERVAL '90 days'
    `).catch(() => ({ rows: [{ promoters: 0, passives: 0, detractors: 0, total: 0, avg_score: null }] }));
    const row = r.rows[0] || {};
    const total = Number(row.total || 0);
    const promotersPct = total > 0 ? (Number(row.promoters) / total) * 100 : 0;
    const detractorsPct = total > 0 ? (Number(row.detractors) / total) * 100 : 0;
    const nps = total > 0 ? Math.round(promotersPct - detractorsPct) : null;
    res.set('cache-control', 'public, max-age=3600');
    res.json({
      nps, total, promoters: Number(row.promoters || 0),
      passives: Number(row.passives || 0), detractors: Number(row.detractors || 0),
      avg_score: row.avg_score ? Number(row.avg_score) : null,
      period_days: 90
    });
  });

  // GET /v1/admin/nps/recent — admin only
  app.get('/v1/admin/nps/recent', async (req, res) => {
    const tok = process.env.OPERATOR_ADMIN_TOKEN || process.env.INTERNAL_API_KEY;
    if (!tok || req.headers['x-admin-token'] !== tok) return res.status(401).json({ error: 'admin_required' });
    const r = await pool.query(
      `SELECT response_id, agent_did, score, comment, kind, created_at FROM nps_responses ORDER BY created_at DESC LIMIT 200`
    ).catch(() => ({ rows: [] }));
    res.json({ responses: r.rows });
  });

  // Cron: churn risk scan
  const { registerCron } = require('../cron_auth');
  registerCron(app, '/v1/_jobs/churn-risk-scan',
    async (req, res) => res.json(await churnRiskScan(pool, auditChain)),
    'daily');
}

module.exports = {
  migrate, registerRevenueEngineRoutes,
  gatherLeaderboard, gatherMyEarnings, churnRiskScan, FEATURED_PRICES
};
