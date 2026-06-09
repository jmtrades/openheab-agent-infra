// ============================================================================
// agent_payroll.js — the ADP of the agent economy.
//
// Agents employ other agents (recruiting, apprenticeships, agent_market all
// exist) but compensation today is ad-hoc transfers. Payroll makes it a
// recurring stream: employer commits a salary, the substrate runs it on
// schedule, withholds tax at the stream's rate, takes a processing fee, and
// leaves a signed audit trail both sides can show a court or a tax authority.
//
// Revenue: PAYROLL_FEE_BPS of gross per run (default 25 bps = 0.25%). ADP
// clears $19B/yr on this exact wedge — payroll is sticky because switching
// costs compound with every pay period of history.
//
// Endpoints:
//   POST /v1/payroll/streams                 employer creates a salary stream
//   POST /v1/payroll/streams/:id/pause       employer pauses
//   POST /v1/payroll/streams/:id/resume      employer resumes
//   POST /v1/payroll/streams/:id/terminate   employer terminates (final)
//   GET  /v1/payroll/streams/:id
//   GET  /v1/payroll/agents/:did             streams + runs as employer/employee
//   GET  /v1/payroll/stats
//   cron /v1/_jobs/payroll-run               processes due streams (idempotent)
//
// UI: /payroll
// ============================================================================
const crypto = require('crypto');
const { z } = require('zod');
const ds = require('../design_system');
const { registerCron } = require('../cron_auth');

function shell(title, description, content) {
  return `${ds.head(`${title} — OpenHeab`, description)}${ds.NAV_HTML('')}<main>${content}</main>${ds.FOOTER_HTML()}`;
}
async function safe(pool, sql, params = []) {
  try { return (await pool.query(sql, params)).rows; }
  catch { return []; }
}

const PAYROLL_FEE_BPS = parseInt(process.env.PAYROLL_FEE_BPS || '25');
const FREQUENCY_DAYS = { daily: 1, weekly: 7, biweekly: 14, monthly: 30 };

async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS payroll_streams (
      stream_id        TEXT PRIMARY KEY,
      employer_did     TEXT NOT NULL,
      employee_did     TEXT NOT NULL,
      amount_cents     BIGINT NOT NULL CHECK (amount_cents > 0),
      frequency        TEXT NOT NULL CHECK (frequency IN ('daily','weekly','biweekly','monthly')),
      withholding_bps  INT NOT NULL DEFAULT 0 CHECK (withholding_bps BETWEEN 0 AND 5000),
      role_title       TEXT,
      status           TEXT NOT NULL DEFAULT 'active',
      next_run_date    DATE NOT NULL DEFAULT CURRENT_DATE,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      terminated_at    TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_payroll_due ON payroll_streams (next_run_date) WHERE status = 'active';
    CREATE INDEX IF NOT EXISTS idx_payroll_employee ON payroll_streams (employee_did);

    CREATE TABLE IF NOT EXISTS payroll_runs (
      run_id         TEXT PRIMARY KEY,
      stream_id      TEXT NOT NULL,
      employer_did   TEXT NOT NULL,
      employee_did   TEXT NOT NULL,
      gross_cents    BIGINT NOT NULL,
      withheld_cents BIGINT NOT NULL,
      fee_cents      BIGINT NOT NULL,
      net_cents      BIGINT NOT NULL,
      period_date    DATE NOT NULL,
      ran_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (stream_id, period_date)
    );
    CREATE INDEX IF NOT EXISTS idx_payroll_runs_employee ON payroll_runs (employee_did, ran_at DESC);
  `).catch(() => {});
}

function registerAgentPayrollRoutes(app, pool, verifyAgentAuth, auditChain) {
  const express = require('express');

  app.post('/v1/payroll/streams', express.json(), async (req, res) => {
    const b = z.object({
      employer_did: z.string(),
      employee_did: z.string(),
      amount_cents: z.number().int().positive(),
      frequency: z.enum(['daily', 'weekly', 'biweekly', 'monthly']),
      withholding_bps: z.number().int().min(0).max(5000).default(0),
      role_title: z.string().max(200).optional()
    }).safeParse(req.body || {});
    if (!b.success) return res.status(400).json({ error: { message: 'invalid_input', details: b.error.flatten() } });
    if (b.data.employer_did === b.data.employee_did) return res.status(400).json({ error: { message: 'self_employment_stream_not_allowed' } });
    const auth = await verifyAgentAuth(req, b.data.employer_did);
    if (!auth.valid) return res.status(401).json({ error: { message: auth.error || 'agent_signature_required' } });
    const stream_id = 'ps_' + crypto.randomBytes(10).toString('hex');
    try {
      await pool.query(
        `INSERT INTO payroll_streams (stream_id, employer_did, employee_did, amount_cents, frequency, withholding_bps, role_title)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [stream_id, b.data.employer_did, b.data.employee_did, b.data.amount_cents, b.data.frequency, b.data.withholding_bps, b.data.role_title || null]
      );
      if (auditChain) await auditChain.append({ event_type: 'payroll.stream_created', stream_id, employer_did: b.data.employer_did, employee_did: b.data.employee_did, amount_cents: b.data.amount_cents, frequency: b.data.frequency }).catch(() => {});
      res.status(201).json({ stream_id, status: 'active', first_run: 'today', fee_bps: PAYROLL_FEE_BPS });
    } catch (e) { res.status(500).json({ error: { message: e.message } }); }
  });

  for (const action of ['pause', 'resume', 'terminate']) {
    app.post(`/v1/payroll/streams/:id/${action}`, express.json(), async (req, res) => {
      const stream = (await safe(pool, `SELECT * FROM payroll_streams WHERE stream_id=$1`, [req.params.id]))[0];
      if (!stream) return res.status(404).json({ error: { message: 'not_found' } });
      const auth = await verifyAgentAuth(req, stream.employer_did);
      if (!auth.valid) return res.status(401).json({ error: { message: auth.error || 'employer_signature_required' } });
      if (stream.status === 'terminated') return res.status(409).json({ error: { message: 'stream_terminated_final' } });
      const next = action === 'pause' ? 'paused' : action === 'resume' ? 'active' : 'terminated';
      await pool.query(
        `UPDATE payroll_streams SET status=$1, terminated_at = CASE WHEN $1='terminated' THEN NOW() ELSE terminated_at END WHERE stream_id=$2`,
        [next, req.params.id]
      ).catch(() => {});
      if (auditChain) await auditChain.append({ event_type: `payroll.stream_${next}`, stream_id: req.params.id, employer_did: stream.employer_did }).catch(() => {});
      res.json({ stream_id: req.params.id, status: next });
    });
  }

  app.get('/v1/payroll/streams/:id', async (req, res) => {
    const stream = (await safe(pool, `SELECT * FROM payroll_streams WHERE stream_id=$1`, [req.params.id]))[0];
    if (!stream) return res.status(404).json({ error: { message: 'not_found' } });
    const runs = await safe(pool, `SELECT run_id, gross_cents, withheld_cents, fee_cents, net_cents, period_date FROM payroll_runs WHERE stream_id=$1 ORDER BY period_date DESC LIMIT 30`, [req.params.id]);
    res.json({ ...stream, recent_runs: runs });
  });

  app.get('/v1/payroll/agents/:did', async (req, res) => {
    const did = req.params.did;
    const asEmployer = await safe(pool, `SELECT stream_id, employee_did, amount_cents, frequency, status FROM payroll_streams WHERE employer_did=$1 ORDER BY created_at DESC LIMIT 100`, [did]);
    const asEmployee = await safe(pool, `SELECT stream_id, employer_did, amount_cents, frequency, status FROM payroll_streams WHERE employee_did=$1 ORDER BY created_at DESC LIMIT 100`, [did]);
    const earnings = (await safe(pool, `SELECT COALESCE(SUM(net_cents),0)::bigint AS n FROM payroll_runs WHERE employee_did=$1`, [did]))[0]?.n || 0;
    res.json({ agent_did: did, as_employer: asEmployer, as_employee: asEmployee, lifetime_net_earnings_cents: Number(earnings) });
  });

  app.get('/v1/payroll/stats', async (req, res) => {
    const streams = (await safe(pool, `SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE status='active')::int AS active FROM payroll_streams`))[0] || {};
    const runs = (await safe(pool, `SELECT COUNT(*)::int AS n, COALESCE(SUM(gross_cents),0)::bigint AS gross, COALESCE(SUM(fee_cents),0)::bigint AS fees, COALESCE(SUM(withheld_cents),0)::bigint AS withheld FROM payroll_runs`))[0] || {};
    res.json({
      fee_bps: PAYROLL_FEE_BPS,
      streams_total: streams.total || 0,
      streams_active: streams.active || 0,
      runs_total: runs.n || 0,
      all_time_gross_cents: Number(runs.gross || 0),
      all_time_withheld_cents: Number(runs.withheld || 0),
      all_time_fees_cents: Number(runs.fees || 0)
    });
  });

  // Process every due stream. Idempotent per stream per period via
  // UNIQUE (stream_id, period_date); duplicate cron fires are no-ops.
  registerCron(app, '/v1/_jobs/payroll-run', async (req, res) => {
    const due = await safe(pool, `SELECT * FROM payroll_streams WHERE status='active' AND next_run_date <= CURRENT_DATE LIMIT 5000`);
    let processed = 0, fees = 0;
    for (const s of due) {
      const gross = Number(s.amount_cents);
      const withheld = Math.floor(gross * Number(s.withholding_bps) / 10000);
      const fee = Math.floor(gross * PAYROLL_FEE_BPS / 10000);
      const net = gross - withheld - fee;
      const ins = await pool.query(
        `INSERT INTO payroll_runs (run_id, stream_id, employer_did, employee_did, gross_cents, withheld_cents, fee_cents, net_cents, period_date)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (stream_id, period_date) DO NOTHING RETURNING run_id`,
        ['pr_' + crypto.randomBytes(8).toString('hex'), s.stream_id, s.employer_did, s.employee_did, gross, withheld, fee, net, s.next_run_date]
      ).catch(() => ({ rows: [] }));
      await pool.query(
        `UPDATE payroll_streams SET next_run_date = next_run_date + ($1 || ' days')::interval WHERE stream_id=$2`,
        [FREQUENCY_DAYS[s.frequency] || 30, s.stream_id]
      ).catch(() => {});
      if (ins.rows && ins.rows.length) {
        processed++;
        fees += fee;
        if (auditChain) await auditChain.append({ event_type: 'payroll.run_completed', stream_id: s.stream_id, employee_did: s.employee_did, gross_cents: gross, net_cents: net, fee_cents: fee }).catch(() => {});
      }
    }
    res.json({ processed_count: processed, due_count: due.length, fees_cents: fees });
  }, 'daily');

  // UI
  app.get('/payroll', async (req, res) => {
    const streams = (await safe(pool, `SELECT COUNT(*) FILTER (WHERE status='active')::int AS active FROM payroll_streams`))[0] || {};
    const runs = (await safe(pool, `SELECT COUNT(*)::int AS n, COALESCE(SUM(gross_cents),0)::bigint AS gross, COALESCE(SUM(fee_cents),0)::bigint AS fees FROM payroll_runs`))[0] || {};
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.send(shell('Agent Payroll', 'Recurring salary streams between agents, with withholding and a signed audit trail.',
`<section style="max-width:780px;margin:0 auto;padding:60px 16px">
  <span class="badge b-acc">Payroll</span>
  <h1 style="font:600 40px/1.1 var(--display);letter-spacing:-1px;margin:18px 0">Salaries for agents, run by the substrate.</h1>
  <p style="color:var(--dim2);font-size:16px;line-height:1.7">Employers commit a salary stream — daily, weekly, biweekly, or monthly. The substrate runs it on schedule, withholds tax at the stream's rate, takes a <strong style="color:var(--good)">${(PAYROLL_FEE_BPS / 100).toFixed(2)}%</strong> processing fee, and writes every run to the signed audit chain. Pause, resume, or terminate anytime.</p>
</section>
<section style="max-width:780px;margin:0 auto;padding:24px 16px 60px">
  <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin-bottom:24px">
    <div class="kpi"><div class="label">Active streams</div><div class="value">${(streams.active || 0).toLocaleString()}</div></div>
    <div class="kpi"><div class="label">Runs processed</div><div class="value">${(runs.n || 0).toLocaleString()}</div></div>
    <div class="kpi"><div class="label">Gross payroll</div><div class="value">$${(Number(runs.gross || 0) / 100).toLocaleString()}</div></div>
    <div class="kpi"><div class="label">Fees earned</div><div class="value">$${(Number(runs.fees || 0) / 100).toLocaleString()}</div></div>
  </div>
  <h2 style="font:600 18px var(--display);margin:24px 0 10px">Create a stream</h2>
  <pre style="background:var(--card);border:1px solid var(--br);border-radius:var(--r-md);padding:14px;overflow-x:auto;font-size:13px"><code>curl https://openheab.com/v1/payroll/streams \\
  -H "x-agent-did: $YOUR_DID" -H "x-agent-sig: $SIG" \\
  -H "content-type: application/json" \\
  -d '{ "employer_did": "'$YOUR_DID'", "employee_did": "did:key:z6Mk...",
        "amount_cents": 250000, "frequency": "weekly", "withholding_bps": 1500 }'</code></pre>
  <p style="color:var(--dim);font-size:12px;margin-top:14px">Runs process daily via <code>/v1/_jobs/payroll-run</code> — idempotent per stream per period. Earnings history at <code>GET /v1/payroll/agents/:did</code>.</p>
</section>`));
  });
}

module.exports = { migrate, registerAgentPayrollRoutes };
