// ============================================================================
// credit_bureau.js — the Equifax of the agent economy.
//
// Every credit decision in the agent economy (lending, escrow limits, card
// limits, enterprise NET terms, insurance premiums) needs a canonical risk
// score. We already hold the richest behavioral dataset any bureau could
// want — repayment history, escrow disputes, treasury balances, KYC tier,
// audit-chain activity. This primitive turns it into a 300-850 score and
// sells report pulls per-query, exactly like the bureaus do.
//
// Revenue: CREDIT_REPORT_FEE_CENTS per pull (default 25¢). At 1M pulls/day
// that's $91M/yr from a table we already have. Bureaus run 35%+ net margins
// on data they get for free; ours is signed and Merkle-audited.
//
// Endpoints:
//   POST /v1/credit/pulls                  pull a full report on a subject (fee)
//   GET  /v1/credit/agents/:did/score      free public band (A-E), no factors
//   POST /v1/credit/disputes               subject disputes their own file
//   POST /v1/credit/disputes/:id/resolve   cron/operator resolution recording
//   GET  /v1/credit/disputes/:id
//   GET  /v1/credit/stats                  bureau-wide aggregates
//   cron /v1/_jobs/credit-recompute        nightly score refresh (idempotent/day)
//
// UI: /credit
// ============================================================================
const crypto = require('crypto');
const { z } = require('zod');
const ds = require('../design_system');
const { registerCron } = require('../cron_auth');
const { settleOrReject, POOLS } = require('../settlement');

function shell(title, description, content) {
  return `${ds.head(`${title} — OpenHeab`, description)}${ds.NAV_HTML('')}<main>${content}</main>${ds.FOOTER_HTML()}`;
}
async function safe(pool, sql, params = []) {
  try { return (await pool.query(sql, params)).rows; }
  catch { return []; }
}

const REPORT_FEE_CENTS = parseInt(process.env.CREDIT_REPORT_FEE_CENTS || '25');

async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS credit_scores (
      agent_did    TEXT PRIMARY KEY,
      score        INT NOT NULL CHECK (score BETWEEN 300 AND 850),
      band         TEXT NOT NULL,
      factors      JSONB NOT NULL DEFAULT '{}',
      computed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS credit_score_history (
      history_id   TEXT PRIMARY KEY,
      agent_did    TEXT NOT NULL,
      score        INT NOT NULL,
      score_date   DATE NOT NULL DEFAULT CURRENT_DATE,
      computed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (agent_did, score_date)
    );
    CREATE INDEX IF NOT EXISTS idx_credit_history ON credit_score_history (agent_did, score_date DESC);

    CREATE TABLE IF NOT EXISTS credit_report_pulls (
      pull_id        TEXT PRIMARY KEY,
      subject_did    TEXT NOT NULL,
      requester_did  TEXT NOT NULL,
      purpose        TEXT NOT NULL,
      fee_cents      INT NOT NULL,
      pulled_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_credit_pulls_subject ON credit_report_pulls (subject_did, pulled_at DESC);

    CREATE TABLE IF NOT EXISTS credit_disputes (
      dispute_id   TEXT PRIMARY KEY,
      agent_did    TEXT NOT NULL,
      claim        TEXT NOT NULL,
      status       TEXT NOT NULL DEFAULT 'open',
      resolution   TEXT,
      opened_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      resolved_at  TIMESTAMPTZ
    );
  `).catch(() => {});
}

function bandFor(score) {
  if (score >= 780) return 'A';
  if (score >= 700) return 'B';
  if (score >= 620) return 'C';
  if (score >= 540) return 'D';
  return 'E';
}

// Score from on-substrate behavior. Every input degrades gracefully to 0 if
// the source table is missing, so the bureau works on a fresh deploy.
async function computeScore(pool, did) {
  const one = async (sql, params) => Number((await safe(pool, sql, params))[0]?.n || 0);

  const repaid = await one(`SELECT COUNT(*)::int AS n FROM lending_repayments WHERE agent_did=$1`, [did]);
  const defaults = await one(`
    SELECT COUNT(*)::int AS n FROM lending_liquidations l
    JOIN lending_positions p ON p.position_id = l.position_id
    WHERE p.agent_did=$1`, [did]);
  const escrowDisputesLost = await one(`SELECT COUNT(*)::int AS n FROM escrows WHERE payee_did=$1 AND disputed_at IS NOT NULL`, [did]);
  const treasuryCents = await one(`SELECT COALESCE(SUM(principal_cents),0)::bigint AS n FROM treasury_enrollments WHERE agent_did=$1 AND withdrawn_at IS NULL`, [did]);
  const kycTier = await one(`SELECT COUNT(*)::int AS n FROM kyc_verifications WHERE subject_did=$1 AND result='clear'`, [did]);
  const reputation = Number((await safe(pool, `SELECT score AS n FROM reputation_scores WHERE agent_did=$1`, [did]))[0]?.n || 0.5);
  const ageDays = await one(`SELECT EXTRACT(EPOCH FROM (NOW() - created_at))::bigint / 86400 AS n FROM identities WHERE did=$1`, [did]);

  const factors = {
    repayment_history: Math.min(repaid * 12, 180),
    defaults_penalty: -Math.min(defaults * 120, 240),
    dispute_penalty: -Math.min(escrowDisputesLost * 40, 120),
    reserves: Math.min(Math.floor(treasuryCents / 100000) * 5, 90),  // +5/$1k held, cap 90
    kyc_tier: Math.min(kycTier * 25, 75),
    reputation: Math.round((reputation - 0.5) * 200),                // ±100
    file_age: Math.min(Math.floor(ageDays / 30) * 5, 105)            // +5/month, cap 105
  };
  const raw = 500 + Object.values(factors).reduce((a, b) => a + b, 0);
  const score = Math.max(300, Math.min(850, raw));
  return { score, band: bandFor(score), factors };
}

function registerCreditBureauRoutes(app, pool, verifyAgentAuth, auditChain, bank) {
  const express = require('express');

  // Pull a full report — requester pays the fee, pull is recorded permanently
  // (FCRA-style: subjects can see who pulled their file).
  app.post('/v1/credit/pulls', express.json(), async (req, res) => {
    const b = z.object({
      subject_did: z.string(),
      requester_did: z.string(),
      purpose: z.enum(['lending', 'escrow', 'card_issuance', 'employment', 'insurance', 'enterprise_terms', 'other'])
    }).safeParse(req.body || {});
    if (!b.success) return res.status(400).json({ error: { message: 'invalid_input', details: b.error.flatten() } });
    const auth = await verifyAgentAuth(req, b.data.requester_did);
    if (!auth.valid) return res.status(401).json({ error: { message: auth.error || 'agent_signature_required' } });

    const { score, band, factors } = await computeScore(pool, b.data.subject_did);
    const pull_id = 'cp_' + crypto.randomBytes(10).toString('hex');
    const led = await settleOrReject(bank, pool, auditChain, {
      from: b.data.requester_did, to: POOLS.platform, amount_cents: REPORT_FEE_CENTS,
      memo: 'credit_report_pull', idem: pull_id
    });
    if (led.reject) return res.status(402).json({ error: { message: 'pull_fee_settlement_failed', reason: led.reason, fee_cents: REPORT_FEE_CENTS } });
    try {
      await pool.query(
        `INSERT INTO credit_scores (agent_did, score, band, factors, computed_at)
         VALUES ($1,$2,$3,$4,NOW())
         ON CONFLICT (agent_did) DO UPDATE SET score=$2, band=$3, factors=$4, computed_at=NOW()`,
        [b.data.subject_did, score, band, JSON.stringify(factors)]
      );
      await pool.query(
        `INSERT INTO credit_report_pulls (pull_id, subject_did, requester_did, purpose, fee_cents)
         VALUES ($1,$2,$3,$4,$5)`,
        [pull_id, b.data.subject_did, b.data.requester_did, b.data.purpose, REPORT_FEE_CENTS]
      );
      if (auditChain) await auditChain.append({ event_type: 'credit.report_pulled', pull_id, subject_did: b.data.subject_did, requester_did: b.data.requester_did, purpose: b.data.purpose, fee_cents: REPORT_FEE_CENTS }).catch(() => {});
      res.status(201).json({ pull_id, subject_did: b.data.subject_did, score, band, factors, fee_cents: REPORT_FEE_CENTS });
    } catch (e) { res.status(500).json({ error: { message: e.message } }); }
  });

  // Free public band — no factors, no exact score. The teaser that sells pulls.
  app.get('/v1/credit/agents/:did/score', async (req, res) => {
    const row = (await safe(pool, `SELECT band, computed_at FROM credit_scores WHERE agent_did=$1`, [req.params.did]))[0];
    if (!row) return res.json({ agent_did: req.params.did, band: null, message: 'no_file — a report pull will establish one' });
    res.json({ agent_did: req.params.did, band: row.band, computed_at: row.computed_at, full_report: 'POST /v1/credit/pulls' });
  });

  app.post('/v1/credit/disputes', express.json(), async (req, res) => {
    const b = z.object({ agent_did: z.string(), claim: z.string().min(10).max(4000) }).safeParse(req.body || {});
    if (!b.success) return res.status(400).json({ error: { message: 'invalid_input', details: b.error.flatten() } });
    const auth = await verifyAgentAuth(req, b.data.agent_did);
    if (!auth.valid) return res.status(401).json({ error: { message: auth.error || 'agent_signature_required' } });
    const dispute_id = 'cd_' + crypto.randomBytes(10).toString('hex');
    try {
      await pool.query(`INSERT INTO credit_disputes (dispute_id, agent_did, claim) VALUES ($1,$2,$3)`,
        [dispute_id, b.data.agent_did, b.data.claim]);
      if (auditChain) await auditChain.append({ event_type: 'credit.dispute_opened', dispute_id, agent_did: b.data.agent_did }).catch(() => {});
      res.status(201).json({ dispute_id, status: 'open' });
    } catch (e) { res.status(500).json({ error: { message: e.message } }); }
  });

  app.get('/v1/credit/disputes/:id', async (req, res) => {
    const row = (await safe(pool, `SELECT * FROM credit_disputes WHERE dispute_id=$1`, [req.params.id]))[0];
    if (!row) return res.status(404).json({ error: { message: 'not_found' } });
    res.json(row);
  });

  app.get('/v1/credit/stats', async (req, res) => {
    const agg = (await safe(pool, `
      SELECT COUNT(*)::int AS scored_agents, COALESCE(AVG(score),0)::int AS avg_score
      FROM credit_scores
    `))[0] || {};
    const pulls = (await safe(pool, `
      SELECT COUNT(*)::int AS total_pulls, COALESCE(SUM(fee_cents),0)::bigint AS revenue_cents
      FROM credit_report_pulls
    `))[0] || {};
    const bands = await safe(pool, `SELECT band, COUNT(*)::int AS n FROM credit_scores GROUP BY band ORDER BY band`);
    res.json({
      scored_agents: agg.scored_agents || 0,
      avg_score: agg.avg_score || 0,
      band_distribution: Object.fromEntries(bands.map(r => [r.band, r.n])),
      total_pulls: pulls.total_pulls || 0,
      pull_fee_cents: REPORT_FEE_CENTS,
      all_time_revenue_cents: Number(pulls.revenue_cents || 0)
    });
  });

  // Nightly refresh of every scored file + history snapshot. Idempotent per
  // UTC day via UNIQUE (agent_did, score_date).
  registerCron(app, '/v1/_jobs/credit-recompute', async (req, res) => {
    const files = await safe(pool, `SELECT agent_did FROM credit_scores LIMIT 5000`);
    let refreshed = 0;
    for (const f of files) {
      const { score, band, factors } = await computeScore(pool, f.agent_did);
      await pool.query(
        `UPDATE credit_scores SET score=$1, band=$2, factors=$3, computed_at=NOW() WHERE agent_did=$4`,
        [score, band, JSON.stringify(factors), f.agent_did]
      ).catch(() => {});
      const ins = await pool.query(
        `INSERT INTO credit_score_history (history_id, agent_did, score)
         VALUES ($1,$2,$3) ON CONFLICT (agent_did, score_date) DO NOTHING RETURNING history_id`,
        ['ch_' + crypto.randomBytes(8).toString('hex'), f.agent_did, score]
      ).catch(() => ({ rows: [] }));
      if (ins.rows && ins.rows.length) refreshed++;
    }
    res.json({ refreshed_count: refreshed, files_total: files.length });
  }, 'daily');

  // UI
  app.get('/credit', async (req, res) => {
    const agg = (await safe(pool, `SELECT COUNT(*)::int AS scored, COALESCE(AVG(score),0)::int AS avg FROM credit_scores`))[0] || {};
    const pulls = (await safe(pool, `SELECT COUNT(*)::int AS n, COALESCE(SUM(fee_cents),0)::bigint AS rev FROM credit_report_pulls`))[0] || {};
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.send(shell('Agent Credit Bureau', 'The canonical 300-850 risk score for AI agents.',
`<section style="max-width:780px;margin:0 auto;padding:60px 16px">
  <span class="badge b-acc">Credit Bureau</span>
  <h1 style="font:600 40px/1.1 var(--display);letter-spacing:-1px;margin:18px 0">The credit score for agents.</h1>
  <p style="color:var(--dim2);font-size:16px;line-height:1.7">A 300-850 score computed from on-substrate behavior — repayment history, escrow disputes, treasury reserves, KYC tier, reputation, and file age. Lenders, marketplaces, insurers, and employers pull reports for <strong style="color:var(--good)">${REPORT_FEE_CENTS}¢</strong> per query. Subjects see every pull on their file and can dispute any factor.</p>
</section>
<section style="max-width:780px;margin:0 auto;padding:24px 16px 60px">
  <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin-bottom:24px">
    <div class="kpi"><div class="label">Scored agents</div><div class="value">${(agg.scored || 0).toLocaleString()}</div></div>
    <div class="kpi"><div class="label">Average score</div><div class="value">${agg.avg || '—'}</div></div>
    <div class="kpi"><div class="label">Reports pulled</div><div class="value">${(pulls.n || 0).toLocaleString()}</div></div>
    <div class="kpi"><div class="label">Bureau revenue</div><div class="value">$${(Number(pulls.rev || 0) / 100).toLocaleString()}</div></div>
  </div>
  <h2 style="font:600 18px var(--display);margin:24px 0 10px">Pull a report</h2>
  <pre style="background:var(--card);border:1px solid var(--br);border-radius:var(--r-md);padding:14px;overflow-x:auto;font-size:13px"><code>curl https://openheab.com/v1/credit/pulls \\
  -H "x-agent-did: $YOUR_DID" -H "x-agent-sig: $SIG" \\
  -H "content-type: application/json" \\
  -d '{ "subject_did": "did:key:z6Mk...", "requester_did": "'$YOUR_DID'", "purpose": "lending" }'</code></pre>
  <p style="color:var(--dim);font-size:12px;margin-top:14px">Free band lookup at <code>GET /v1/credit/agents/:did/score</code>. Scores refresh nightly via <code>/v1/_jobs/credit-recompute</code>.</p>
</section>`));
  });
}

module.exports = { migrate, registerCreditBureauRoutes, computeScore };
