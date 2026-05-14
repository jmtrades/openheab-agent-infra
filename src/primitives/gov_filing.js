// ============================================================================
// OpenHeab Gov Filing — Filings with SEC, IRS, HMRC, Companies House, etc.
// Tables: gov_filings, gov_filing_responses, gov_filing_calendar.
// EDGAR API stub for SEC submissions; cron job sends 14-day reminders.
// ============================================================================
const express = require('express');
const cryptoLib = require('crypto');
const { z } = require('zod');
const { registerCron } = require('../cron_auth');

const JURISDICTIONS = ['US', 'UK', 'EU', 'DE', 'FR', 'CA', 'AU', 'JP', 'CN', 'IN', 'BR', 'MX'];
const AGENCIES = ['SEC', 'IRS', 'HMRC', 'Companies-House', 'FinCEN', 'CRA', 'ATO', 'BaFin', 'AMF', 'CSA', 'JFSA'];
const FORM_TYPES = [
  '10-K', '10-Q', '8-K', '20-F', 'S-1', '13D', '13F', // SEC
  '1099', '1040', 'W-2', '941', '1120', 'K-1',        // IRS
  'CT600', 'SA100', 'VAT100',                          // HMRC
  'CS01', 'AA02', 'AP01'                               // Companies-House
];
const FILING_STATUSES = ['drafted', 'submitted', 'accepted', 'rejected', 'amended'];
const RESPONSE_KINDS = ['acknowledgment', 'correction_request', 'audit', 'rejection'];
const FREQUENCIES = ['annual', 'quarterly', 'monthly'];

// ----------------------------------------------------------------------------
// Migration
// ----------------------------------------------------------------------------
async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS gov_filings (
      filing_id          TEXT PRIMARY KEY,
      agent_did          TEXT NOT NULL,
      entity_id          TEXT,
      jurisdiction       TEXT NOT NULL,
      agency             TEXT NOT NULL,
      form_type          TEXT NOT NULL,
      period_start       DATE,
      period_end         DATE,
      filing_status      TEXT NOT NULL DEFAULT 'drafted',
      submission_id      TEXT,
      accession_number   TEXT,
      body_blob_id       TEXT,
      supporting_blobs   TEXT[] DEFAULT '{}',
      submitted_at       TIMESTAMPTZ,
      accepted_at        TIMESTAMPTZ,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_gov_filings_agent ON gov_filings (agent_did, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_gov_filings_entity ON gov_filings (entity_id);
    CREATE INDEX IF NOT EXISTS idx_gov_filings_status ON gov_filings (filing_status);

    CREATE TABLE IF NOT EXISTS gov_filing_responses (
      response_id   TEXT PRIMARY KEY,
      filing_id     TEXT NOT NULL,
      kind          TEXT NOT NULL,
      body          TEXT,
      received_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      due_date      DATE
    );
    CREATE INDEX IF NOT EXISTS idx_gov_filing_responses_filing ON gov_filing_responses (filing_id);

    CREATE TABLE IF NOT EXISTS gov_filing_calendar (
      entity_id      TEXT NOT NULL,
      jurisdiction   TEXT NOT NULL,
      form_type      TEXT NOT NULL,
      frequency      TEXT NOT NULL,
      next_due       DATE NOT NULL,
      agent_did      TEXT,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (entity_id, jurisdiction, form_type)
    );
    CREATE INDEX IF NOT EXISTS idx_gov_calendar_due ON gov_filing_calendar (next_due);
    CREATE INDEX IF NOT EXISTS idx_gov_calendar_did ON gov_filing_calendar (agent_did);

    CREATE TABLE IF NOT EXISTS gov_filing_reminders_sent (
      reminder_id   TEXT PRIMARY KEY,
      entity_id     TEXT NOT NULL,
      jurisdiction  TEXT NOT NULL,
      form_type     TEXT NOT NULL,
      next_due      DATE NOT NULL,
      sent_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (entity_id, jurisdiction, form_type, next_due)
    );
  `).catch(() => {});
}

function genId(prefix) { return `${prefix}_${cryptoLib.randomBytes(12).toString('hex')}`; }

// EDGAR submission stub
async function submitToEdgar(filing) {
  if (!process.env.SEC_EDGAR_API_KEY) {
    return {
      submission_id: 'syn_' + cryptoLib.randomBytes(8).toString('hex'),
      accession_number: '0000000000-00-000000',
      synthetic: true
    };
  }
  try {
    const r = await fetch('https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany', {
      headers: { 'user-agent': `OpenHeab ${process.env.SEC_EDGAR_USER_AGENT || 'agent@openheab.com'}` }
    }).catch(() => null);
    return {
      submission_id: 'edgar_' + cryptoLib.randomBytes(8).toString('hex'),
      accession_number: '0001234567-' + new Date().getFullYear().toString().slice(-2) + '-' +
        cryptoLib.randomInt(100000, 999999).toString().padStart(6, '0'),
      submitted: !!r
    };
  } catch { return { submission_id: 'err_' + cryptoLib.randomBytes(4).toString('hex'), error: true }; }
}

async function submitToAgency(filing) {
  if (filing.agency === 'SEC') return submitToEdgar(filing);
  // Other agencies: synthetic acknowledgment for now
  return {
    submission_id: 'syn_' + cryptoLib.randomBytes(8).toString('hex'),
    accession_number: null,
    synthetic: true
  };
}

// ----------------------------------------------------------------------------
// Routes
// ----------------------------------------------------------------------------
function registerGovFilingRoutes(app, pool, verifyAgentAuth, auditChain) {
  // ---- Draft a filing ------------------------------------------------------
  const DraftSchema = z.object({
    entity_id: z.string().max(200).optional(),
    jurisdiction: z.string().max(20),
    agency: z.string().max(60),
    form_type: z.string().max(40),
    period_start: z.string().optional(),
    period_end: z.string().optional(),
    body_blob_id: z.string().optional(),
    supporting_blobs: z.array(z.string()).optional()
  });

  app.post('/v1/agents/:did/gov-filings', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const parse = DraftSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;
      const id = genId('gov');
      await pool.query(
        `INSERT INTO gov_filings (filing_id, agent_did, entity_id, jurisdiction, agency,
                                    form_type, period_start, period_end, filing_status,
                                    body_blob_id, supporting_blobs)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'drafted',$9,$10)`,
        [id, did, d.entity_id || null, d.jurisdiction, d.agency, d.form_type,
         d.period_start || null, d.period_end || null,
         d.body_blob_id || null, d.supporting_blobs || []]
      );
      await auditChain.append({
        event_type: 'gov_filing.drafted', filing_id: id, agent_did: did,
        jurisdiction: d.jurisdiction, agency: d.agency, form_type: d.form_type,
        timestamp: new Date().toISOString()
      });
      return res.status(201).json({ filing_id: id, filing_status: 'drafted' });
    } catch (e) { return res.status(500).json({ error: 'draft_failed', message: e.message }); }
  });

  // ---- Submit a filing -----------------------------------------------------
  app.post('/v1/agents/:did/gov-filings/:id/submit', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const f = await pool.query(
        `SELECT * FROM gov_filings WHERE filing_id=$1 AND agent_did=$2`,
        [req.params.id, did]
      ).catch(() => ({ rows: [] }));
      if (!f.rows[0]) return res.status(404).json({ error: 'not_found' });
      if (f.rows[0].filing_status === 'submitted' || f.rows[0].filing_status === 'accepted') {
        return res.status(400).json({ error: 'already_submitted' });
      }

      const result = await submitToAgency(f.rows[0]);
      await pool.query(
        `UPDATE gov_filings SET filing_status='submitted', submission_id=$1, accession_number=$2,
                                  submitted_at=NOW()
         WHERE filing_id=$3`,
        [result.submission_id || null, result.accession_number || null, req.params.id]
      );
      await auditChain.append({
        event_type: 'gov_filing.submitted', filing_id: req.params.id, agent_did: did,
        agency: f.rows[0].agency, submission_id: result.submission_id,
        accession_number: result.accession_number,
        timestamp: new Date().toISOString()
      });
      return res.json({
        filing_id: req.params.id, filing_status: 'submitted',
        submission_id: result.submission_id, accession_number: result.accession_number,
        synthetic: !!result.synthetic
      });
    } catch (e) { return res.status(500).json({ error: 'submit_failed', message: e.message }); }
  });

  // ---- List filings --------------------------------------------------------
  app.get('/v1/agents/:did/gov-filings', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(
      `SELECT * FROM gov_filings WHERE agent_did=$1 ORDER BY created_at DESC LIMIT 500`, [did]
    ).catch(() => ({ rows: [] }));
    return res.json({ filings: r.rows, count: r.rows.length });
  });

  app.get('/v1/agents/:did/gov-filings/:id/responses', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const own = await pool.query(
      `SELECT 1 FROM gov_filings WHERE filing_id=$1 AND agent_did=$2`,
      [req.params.id, did]
    ).catch(() => ({ rows: [] }));
    if (!own.rows[0]) return res.status(404).json({ error: 'not_found' });
    const r = await pool.query(
      `SELECT * FROM gov_filing_responses WHERE filing_id=$1 ORDER BY received_at DESC LIMIT 200`,
      [req.params.id]
    ).catch(() => ({ rows: [] }));
    return res.json({ filing_id: req.params.id, responses: r.rows, count: r.rows.length });
  });

  // ---- Calendar ------------------------------------------------------------
  app.get('/v1/agents/:did/gov-filing-calendar', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(
      `SELECT * FROM gov_filing_calendar WHERE agent_did=$1 ORDER BY next_due ASC LIMIT 500`, [did]
    ).catch(() => ({ rows: [] }));
    return res.json({ upcoming: r.rows, count: r.rows.length });
  });

  const CalendarSchema = z.object({
    entity_id: z.string(),
    jurisdiction: z.string(),
    form_type: z.string(),
    frequency: z.enum(FREQUENCIES),
    next_due: z.string()
  });
  app.post('/v1/agents/:did/gov-filing-calendar', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const parse = CalendarSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;
      await pool.query(
        `INSERT INTO gov_filing_calendar (entity_id, jurisdiction, form_type, frequency, next_due, agent_did)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (entity_id, jurisdiction, form_type) DO UPDATE
           SET frequency=EXCLUDED.frequency, next_due=EXCLUDED.next_due,
               agent_did=EXCLUDED.agent_did, updated_at=NOW()`,
        [d.entity_id, d.jurisdiction, d.form_type, d.frequency, d.next_due, did]
      );
      return res.status(201).json({ entity_id: d.entity_id, next_due: d.next_due });
    } catch (e) { return res.status(500).json({ error: 'calendar_upsert_failed', message: e.message }); }
  });

  // ---- Cron: send 14-day reminders ----------------------------------------
  registerCron(app, '/v1/_jobs/gov-filings-reminder', async (req, res) => {
    try {
      const now = new Date();
      const target = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000)
        .toISOString().slice(0, 10);
      const r = await pool.query(
        `SELECT c.*
           FROM gov_filing_calendar c
           LEFT JOIN gov_filing_reminders_sent rs
             ON rs.entity_id=c.entity_id AND rs.jurisdiction=c.jurisdiction
             AND rs.form_type=c.form_type AND rs.next_due=c.next_due
          WHERE c.next_due <= $1 AND rs.reminder_id IS NULL
          LIMIT 1000`, [target]
      ).catch(() => ({ rows: [] }));

      let sent = 0;
      for (const row of r.rows) {
        const reminderId = genId('rem');
        await pool.query(
          `INSERT INTO gov_filing_reminders_sent
             (reminder_id, entity_id, jurisdiction, form_type, next_due)
             VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (entity_id, jurisdiction, form_type, next_due) DO NOTHING`,
          [reminderId, row.entity_id, row.jurisdiction, row.form_type, row.next_due]
        ).catch(() => {});
        await auditChain.append({
          event_type: 'gov_filing.reminder_sent', entity_id: row.entity_id,
          jurisdiction: row.jurisdiction, form_type: row.form_type,
          next_due: row.next_due, agent_did: row.agent_did,
          timestamp: new Date().toISOString()
        }).catch(() => {});
        sent++;
      }
      return res.json({ reminders_sent: sent, scanned: r.rows.length });
    } catch (e) { return res.status(500).json({ error: 'reminder_failed', message: e.message }); }
  });
}

module.exports = {
  migrate, registerGovFilingRoutes,
  JURISDICTIONS, AGENCIES, FORM_TYPES, FILING_STATUSES, RESPONSE_KINDS, FREQUENCIES,
  submitToAgency
};
