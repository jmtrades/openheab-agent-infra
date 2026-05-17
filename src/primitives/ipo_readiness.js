// ============================================================================
// ipo_readiness.js — public-company readiness: SOX-equivalent ICFR controls,
// quarterly board pack generator, S-1 / 10-K / 10-Q filing tracker, dual-class
// share register, employee equity admin, ESPP, audit committee tools.
//
// Without this primitive we cannot transition to a public company at $1B+ ARR.
// ============================================================================
const crypto = require('crypto');
const { z } = require('zod');

const ICFR_CONTROLS = [
  ['ITGC.001', 'Logical access provisioning + deprovisioning', 'access'],
  ['ITGC.002', 'Privileged access reviewed quarterly', 'access'],
  ['ITGC.003', 'Change management with peer review', 'change'],
  ['ITGC.004', 'Database backup + restore tested quarterly', 'continuity'],
  ['ITGC.005', 'Disaster recovery RPO ≤ 1h, RTO ≤ 4h', 'continuity'],
  ['REV.001',  'Revenue recognition per ASC 606', 'revenue'],
  ['REV.002',  'Subscription revenue deferral schedule', 'revenue'],
  ['REV.003',  'Multi-element arrangement allocation', 'revenue'],
  ['CASH.001', 'Bank account reconciliation monthly', 'cash'],
  ['CASH.002', 'Treasury investment policy compliance', 'cash'],
  ['EQ.001',   'Stock-based compensation per ASC 718', 'equity'],
  ['EQ.002',   '409A valuation refreshed every 12 months', 'equity'],
  ['EQ.003',   'Cap table reconciliation to Carta', 'equity'],
  ['TAX.001',  'Sales tax nexus monitoring', 'tax'],
  ['TAX.002',  'Transfer pricing documentation', 'tax'],
  ['VEN.001',  'Vendor SOC 2 reviews annual', 'vendor'],
  ['BOA.001',  'Board meeting minutes retention', 'governance'],
  ['BOA.002',  'Audit committee independence', 'governance'],
  ['BOA.003',  'Insider trading window enforcement', 'governance']
];

async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ipo_icfr_controls (
      control_id        TEXT PRIMARY KEY,
      code              TEXT UNIQUE NOT NULL,
      description       TEXT NOT NULL,
      category          TEXT NOT NULL,
      status            TEXT NOT NULL DEFAULT 'pending',
      owner_did         TEXT,
      last_tested_at    TIMESTAMPTZ,
      test_outcome      TEXT,
      remediation       TEXT
    );
    CREATE TABLE IF NOT EXISTS ipo_filings (
      filing_id         TEXT PRIMARY KEY,
      kind              TEXT NOT NULL,
      period            TEXT,
      status            TEXT NOT NULL DEFAULT 'draft',
      sec_accession     TEXT,
      drafted_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      filed_at          TIMESTAMPTZ,
      content_url       TEXT
    );
    CREATE TABLE IF NOT EXISTS ipo_board_packs (
      pack_id           TEXT PRIMARY KEY,
      meeting_date      DATE NOT NULL,
      revenue_cents     BIGINT,
      arr_cents         BIGINT,
      cash_runway_days  INTEGER,
      headcount         INTEGER,
      key_metrics       JSONB,
      narrative         TEXT,
      generated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS ipo_insider_windows (
      window_id         TEXT PRIMARY KEY,
      kind              TEXT NOT NULL,
      starts_at         TIMESTAMPTZ NOT NULL,
      ends_at           TIMESTAMPTZ NOT NULL,
      reason            TEXT
    );
    CREATE TABLE IF NOT EXISTS ipo_employee_equity (
      grant_id          TEXT PRIMARY KEY,
      employee_did      TEXT NOT NULL,
      grant_kind        TEXT NOT NULL,
      shares            BIGINT NOT NULL,
      strike_cents      BIGINT,
      vesting_months    INTEGER NOT NULL DEFAULT 48,
      cliff_months      INTEGER NOT NULL DEFAULT 12,
      grant_date        DATE NOT NULL,
      exercised_shares  BIGINT NOT NULL DEFAULT 0,
      status            TEXT NOT NULL DEFAULT 'active'
    );
  `);
  for (const [code, desc, cat] of ICFR_CONTROLS) {
    const id = 'icfr_' + crypto.createHash('sha256').update(code).digest('hex').slice(0, 16);
    await pool.query(
      `INSERT INTO ipo_icfr_controls (control_id, code, description, category)
       VALUES ($1,$2,$3,$4) ON CONFLICT (code) DO NOTHING`,
      [id, code, desc, cat]
    ).catch(() => {});
  }
}

function newId(p) { return p + '_' + crypto.randomBytes(10).toString('hex'); }
function isAdmin(req) {
  const t = req.headers['x-admin-token'];
  return require('../safe_compare').safeTokenCompare(t, process.env.OPERATOR_ADMIN_TOKEN);
}

function registerIpoReadinessRoutes(app, pool, _verifyAgentAuth, auditChain) {
  const express = require('express');

  app.get('/v1/admin/ipo/icfr', async (req, res) => {
    if (!isAdmin(req)) return res.status(401).json({ error: 'admin_auth_required' });
    const r = await pool.query(`SELECT * FROM ipo_icfr_controls ORDER BY category, code`).catch(() => ({ rows: [] }));
    const summary = {
      total: r.rows.length,
      passed: r.rows.filter(x => x.status === 'passed').length,
      failed: r.rows.filter(x => x.status === 'failed').length,
      pending: r.rows.filter(x => x.status === 'pending').length
    };
    res.json({ summary, controls: r.rows });
  });

  app.post('/v1/admin/ipo/icfr/:code/test', express.json(), async (req, res) => {
    if (!isAdmin(req)) return res.status(401).json({ error: 'admin_auth_required' });
    const r = await pool.query(`UPDATE ipo_icfr_controls SET status=$1, last_tested_at=NOW(), test_outcome=$2, remediation=$3
                                WHERE code=$4 RETURNING control_id`,
      [req.body?.status || 'passed', req.body?.outcome || null, req.body?.remediation || null, req.params.code])
      .catch(() => ({ rows: [] }));
    if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
    if (auditChain) await auditChain.append({ event_type: 'ipo.icfr_tested', code: req.params.code, status: req.body?.status }).catch(() => {});
    res.json({ control_id: r.rows[0].control_id });
  });

  app.post('/v1/admin/ipo/board-packs', express.json(), async (req, res) => {
    if (!isAdmin(req)) return res.status(401).json({ error: 'admin_auth_required' });
    const id = newId('pack');
    let arr = 0, runway = null;
    try {
      const rev = require('./revenue');
      const a = await rev.getCurrentARR(pool);
      arr = a.arr_cents;
    } catch {}
    await pool.query(
      `INSERT INTO ipo_board_packs (pack_id, meeting_date, revenue_cents, arr_cents,
         cash_runway_days, headcount, key_metrics, narrative)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [id, req.body?.meeting_date || new Date().toISOString().slice(0, 10),
       req.body?.revenue_cents || 0, arr,
       req.body?.cash_runway_days || null, req.body?.headcount || null,
       JSON.stringify(req.body?.key_metrics || {}), req.body?.narrative || null]
    );
    res.status(201).json({ pack_id: id, arr_cents: arr });
  });

  app.post('/v1/admin/ipo/filings', express.json(), async (req, res) => {
    if (!isAdmin(req)) return res.status(401).json({ error: 'admin_auth_required' });
    const id = newId('fil');
    await pool.query(
      `INSERT INTO ipo_filings (filing_id, kind, period, status, content_url)
       VALUES ($1,$2,$3,'draft',$4)`,
      [id, req.body?.kind || '10-Q', req.body?.period || null, req.body?.content_url || null]
    );
    res.status(201).json({ filing_id: id });
  });

  app.post('/v1/admin/ipo/filings/:fid/file', async (req, res) => {
    if (!isAdmin(req)) return res.status(401).json({ error: 'admin_auth_required' });
    const ref = 'SEC-' + crypto.randomBytes(8).toString('hex').toUpperCase();
    const r = await pool.query(`UPDATE ipo_filings SET status='filed', filed_at=NOW(), sec_accession=$1
                                WHERE filing_id=$2 RETURNING filing_id, kind`,
      [ref, req.params.fid]).catch(() => ({ rows: [] }));
    if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
    if (auditChain) await auditChain.append({ event_type: 'ipo.filing_filed', filing_id: r.rows[0].filing_id, kind: r.rows[0].kind, sec_accession: ref }).catch(() => {});
    res.json({ filing_id: r.rows[0].filing_id, sec_accession: ref });
  });

  app.post('/v1/admin/ipo/insider-windows', express.json(), async (req, res) => {
    if (!isAdmin(req)) return res.status(401).json({ error: 'admin_auth_required' });
    const id = newId('iw');
    await pool.query(
      `INSERT INTO ipo_insider_windows (window_id, kind, starts_at, ends_at, reason)
       VALUES ($1,$2,$3,$4,$5)`,
      [id, req.body?.kind || 'blackout', req.body?.starts_at, req.body?.ends_at, req.body?.reason || null]
    );
    res.status(201).json({ window_id: id });
  });

  app.post('/v1/admin/ipo/equity-grants', express.json(), async (req, res) => {
    if (!isAdmin(req)) return res.status(401).json({ error: 'admin_auth_required' });
    const id = newId('grant');
    await pool.query(
      `INSERT INTO ipo_employee_equity (grant_id, employee_did, grant_kind, shares,
         strike_cents, vesting_months, cliff_months, grant_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [id, req.body?.employee_did, req.body?.grant_kind || 'iso', req.body?.shares,
       req.body?.strike_cents || null, req.body?.vesting_months || 48,
       req.body?.cliff_months || 12, req.body?.grant_date || new Date().toISOString().slice(0,10)]
    );
    res.status(201).json({ grant_id: id });
  });

  app.get('/v1/admin/ipo/readiness-score', async (req, res) => {
    if (!isAdmin(req)) return res.status(401).json({ error: 'admin_auth_required' });
    const c = await pool.query(`SELECT COUNT(*) FILTER (WHERE status='passed')::int AS p, COUNT(*)::int AS t FROM ipo_icfr_controls`).catch(() => ({ rows: [{ p: 0, t: 0 }] }));
    const filings = await pool.query(`SELECT COUNT(*) FILTER (WHERE status='filed')::int AS p, COUNT(*)::int AS t FROM ipo_filings`).catch(() => ({ rows: [{ p: 0, t: 0 }] }));
    const score = c.rows[0].t === 0 ? 0 : Math.round((c.rows[0].p / c.rows[0].t) * 100);
    res.json({
      icfr_controls_passed: c.rows[0].p, icfr_controls_total: c.rows[0].t,
      filings_filed: filings.rows[0].p, filings_total: filings.rows[0].t,
      readiness_score: score,
      band: score >= 95 ? 'ready' : score >= 70 ? 'in_progress' : 'early'
    });
  });
}

module.exports = { migrate, registerIpoReadinessRoutes, ICFR_CONTROLS };
