// ============================================================================
// OpenHeab Court Records — PACER + CourtListener docket access.
// Tables: court_cases, case_filings, subscriptions.
// Cron job /v1/_jobs/court-sync refreshes subscribed cases.
// ============================================================================
const express = require('express');
const cryptoLib = require('crypto');
const { z } = require('zod');
const { registerCron } = require('../cron_auth');

const CASE_KINDS = ['civil', 'criminal', 'bankruptcy', 'appellate'];
const CASE_STATUSES = ['open', 'closed', 'sealed'];
const FILING_KINDS = ['motion', 'answer', 'order', 'judgment', 'transcript', 'exhibit'];

// ----------------------------------------------------------------------------
// Migration
// ----------------------------------------------------------------------------
async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS court_cases (
      case_id          TEXT PRIMARY KEY,
      jurisdiction     TEXT,
      court            TEXT,
      case_number      TEXT,
      case_name        TEXT,
      kind             TEXT,
      status           TEXT NOT NULL DEFAULT 'open',
      filed_at         DATE,
      judge            TEXT,
      parties          JSONB,
      last_synced_at   TIMESTAMPTZ,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_court_cases_jurisdiction ON court_cases (jurisdiction);
    CREATE INDEX IF NOT EXISTS idx_court_cases_court ON court_cases (court);
    CREATE INDEX IF NOT EXISTS idx_court_cases_kind ON court_cases (kind);
    CREATE INDEX IF NOT EXISTS idx_court_cases_status ON court_cases (status);
    CREATE INDEX IF NOT EXISTS idx_court_cases_number ON court_cases (case_number);

    CREATE TABLE IF NOT EXISTS court_case_filings (
      filing_id      TEXT PRIMARY KEY,
      case_id        TEXT NOT NULL,
      sequence       INTEGER NOT NULL DEFAULT 0,
      kind           TEXT,
      filed_at       TIMESTAMPTZ,
      filed_by       TEXT,
      document_url   TEXT,
      blob_id        TEXT,
      summary        TEXT,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_court_case_filings_case ON court_case_filings (case_id, sequence);

    CREATE TABLE IF NOT EXISTS court_subscriptions (
      subscription_id  TEXT PRIMARY KEY,
      agent_did        TEXT NOT NULL,
      case_id          TEXT NOT NULL,
      alert_kinds      TEXT[] DEFAULT '{}',
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (agent_did, case_id)
    );
    CREATE INDEX IF NOT EXISTS idx_court_subscriptions_agent ON court_subscriptions (agent_did);
    CREATE INDEX IF NOT EXISTS idx_court_subscriptions_case ON court_subscriptions (case_id);
  `).catch(() => {});
}

function genId(prefix) { return `${prefix}_${cryptoLib.randomBytes(12).toString('hex')}`; }

// Fetch case details from CourtListener
async function fetchFromCourtListener(caseId) {
  try {
    if (!caseId) return null;
    const headers = { 'accept': 'application/json' };
    if (process.env.COURTLISTENER_API_TOKEN) {
      headers['authorization'] = `Token ${process.env.COURTLISTENER_API_TOKEN}`;
    }
    const idPart = caseId.replace(/^cl_/, '');
    const r = await fetch(
      `https://www.courtlistener.com/api/rest/v3/dockets/${encodeURIComponent(idPart)}/`,
      { headers }
    );
    if (!r.ok) return null;
    return await r.json();
  } catch (e) { return null; }
}

// ----------------------------------------------------------------------------
// Routes
// ----------------------------------------------------------------------------
function registerCourtRecordsRoutes(app, pool, verifyAgentAuth, auditChain) {
  // ---- Search cases --------------------------------------------------------
  app.get('/v1/court/cases/search', async (req, res) => {
    try {
      const q = String(req.query.q || '');
      const jurisdiction = req.query.jurisdiction || null;
      const kind = req.query.kind || null;
      const limit = Math.min(parseInt(req.query.limit) || 50, 200);

      const params = [];
      const conds = [];
      if (q) {
        params.push(`%${q}%`);
        conds.push(`(case_name ILIKE $${params.length} OR case_number ILIKE $${params.length})`);
      }
      if (jurisdiction) { params.push(jurisdiction); conds.push(`jurisdiction=$${params.length}`); }
      if (kind) { params.push(kind); conds.push(`kind=$${params.length}`); }
      params.push(limit);
      const sql =
        `SELECT * FROM court_cases ${conds.length ? 'WHERE ' + conds.join(' AND ') : ''}
         ORDER BY filed_at DESC NULLS LAST LIMIT $${params.length}`;
      const r = await pool.query(sql, params).catch(() => ({ rows: [] }));
      return res.json({ cases: r.rows, count: r.rows.length });
    } catch (e) { return res.status(500).json({ error: 'search_failed', message: e.message }); }
  });

  // ---- Case detail (with sync from CL on cache miss) ----------------------
  app.get('/v1/court/cases/:id', async (req, res) => {
    try {
      let r = await pool.query(`SELECT * FROM court_cases WHERE case_id=$1`, [req.params.id])
        .catch(() => ({ rows: [] }));
      if (!r.rows[0]) {
        // Try CourtListener
        const ext = await fetchFromCourtListener(req.params.id);
        if (ext) {
          await pool.query(
            `INSERT INTO court_cases (case_id, jurisdiction, court, case_number, case_name, kind,
                                       status, filed_at, judge, parties, last_synced_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,NOW())
             ON CONFLICT (case_id) DO UPDATE SET last_synced_at=NOW()`,
            [req.params.id, ext.court || null, ext.court || null,
             ext.docket_number || null, ext.case_name || null,
             null, 'open', ext.date_filed || null,
             ext.assigned_to_str || null,
             JSON.stringify(ext.parties || [])]
          ).catch(() => {});
          r = await pool.query(`SELECT * FROM court_cases WHERE case_id=$1`, [req.params.id])
            .catch(() => ({ rows: [] }));
        }
      }
      if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
      return res.json(r.rows[0]);
    } catch (e) { return res.status(500).json({ error: 'fetch_failed', message: e.message }); }
  });

  // ---- Case filings list ---------------------------------------------------
  app.get('/v1/court/cases/:id/filings', async (req, res) => {
    const r = await pool.query(
      `SELECT * FROM court_case_filings WHERE case_id=$1 ORDER BY sequence ASC LIMIT 1000`,
      [req.params.id]
    ).catch(() => ({ rows: [] }));
    return res.json({ case_id: req.params.id, filings: r.rows, count: r.rows.length });
  });

  app.get('/v1/court/cases/:id/filings/:filing_id', async (req, res) => {
    const r = await pool.query(
      `SELECT * FROM court_case_filings WHERE case_id=$1 AND filing_id=$2`,
      [req.params.id, req.params.filing_id]
    ).catch(() => ({ rows: [] }));
    if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
    return res.json(r.rows[0]);
  });

  // ---- Subscriptions (watch a case) ---------------------------------------
  const SubSchema = z.object({
    case_id: z.string(),
    alert_kinds: z.array(z.enum(FILING_KINDS)).optional()
  });
  app.post('/v1/agents/:did/court/subscriptions', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const parse = SubSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;
      const id = genId('sub');
      await pool.query(
        `INSERT INTO court_subscriptions (subscription_id, agent_did, case_id, alert_kinds)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (agent_did, case_id) DO UPDATE SET alert_kinds=EXCLUDED.alert_kinds`,
        [id, did, d.case_id, d.alert_kinds || []]
      );
      await auditChain.append({
        event_type: 'court_records.subscribed', subscription_id: id,
        agent_did: did, case_id: d.case_id,
        timestamp: new Date().toISOString()
      });
      return res.status(201).json({ subscription_id: id, case_id: d.case_id });
    } catch (e) { return res.status(500).json({ error: 'subscribe_failed', message: e.message }); }
  });

  app.get('/v1/agents/:did/court/subscriptions', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(
      `SELECT s.*, c.case_name, c.case_number, c.court, c.jurisdiction
         FROM court_subscriptions s
         LEFT JOIN court_cases c ON c.case_id = s.case_id
        WHERE s.agent_did=$1
        ORDER BY s.created_at DESC LIMIT 500`, [did]
    ).catch(() => ({ rows: [] }));
    return res.json({ subscriptions: r.rows, count: r.rows.length });
  });

  // ---- Cron: court-sync ----------------------------------------------------
  registerCron(app, '/v1/_jobs/court-sync', async (req, res) => {
    try {
      const subs = await pool.query(
        `SELECT DISTINCT case_id FROM court_subscriptions LIMIT 1000`
      ).catch(() => ({ rows: [] }));
      let synced = 0, newFilings = 0;
      for (const row of subs.rows) {
        const ext = await fetchFromCourtListener(row.case_id);
        if (!ext) continue;
        await pool.query(
          `UPDATE court_cases SET last_synced_at=NOW(), parties=$1::jsonb, status=COALESCE(status,'open')
            WHERE case_id=$2`,
          [JSON.stringify(ext.parties || []), row.case_id]
        ).catch(() => {});
        synced++;

        // CourtListener returns entries via separate API; for now we treat
        // top-level "entries" if present and merge as filings.
        const entries = (ext.entries || []).slice(0, 50);
        for (let i = 0; i < entries.length; i++) {
          const e = entries[i];
          const filingId = 'cl_fil_' + (e.id || cryptoLib.randomBytes(6).toString('hex'));
          const ins = await pool.query(
            `INSERT INTO court_case_filings (filing_id, case_id, sequence, kind, filed_at, summary, document_url)
             VALUES ($1,$2,$3,$4,$5,$6,$7)
             ON CONFLICT (filing_id) DO NOTHING
             RETURNING filing_id`,
            [filingId, row.case_id, e.entry_number || i, 'order',
             e.date_filed || null, e.description || null,
             e.absolute_url || null]
          ).catch(() => ({ rows: [] }));
          if (ins.rows && ins.rows[0]) newFilings++;
        }
      }
      return res.json({ synced, new_filings: newFilings });
    } catch (e) { return res.status(500).json({ error: 'sync_failed', message: e.message }); }
  });
}

module.exports = {
  migrate, registerCourtRecordsRoutes,
  CASE_KINDS, CASE_STATUSES, FILING_KINDS, fetchFromCourtListener
};
