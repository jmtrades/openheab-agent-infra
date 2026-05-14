// ============================================================================
// OpenHeab Courts — Decentralized dispute resolution (distinct from escrow).
// Plaintiffs file cases, defendants respond, judges (reputation >= 0.8) decide.
// Precedents are recorded and citable across courts.
// ============================================================================
const express = require('express');
const cryptoLib = require('crypto');
const { z } = require('zod');

const CASE_KINDS = ['contract_breach', 'fraud', 'IP', 'property', 'other'];
const CASE_STATUSES = ['filed', 'served', 'pending_response', 'in_arbitration', 'decided', 'appealed', 'closed'];
const FILING_KINDS = ['motion', 'evidence', 'response', 'appeal'];
const COURT_STATUSES = ['active', 'paused'];
const MIN_JUDGE_REPUTATION = 0.8;

async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS courts (
      court_id        TEXT PRIMARY KEY,
      name            TEXT NOT NULL,
      jurisdiction    TEXT,
      founder_did     TEXT NOT NULL,
      judges          TEXT[] DEFAULT '{}',
      fee_usdc_cents  BIGINT NOT NULL DEFAULT 0,
      status          TEXT NOT NULL DEFAULT 'active',
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_courts_founder ON courts (founder_did);

    CREATE TABLE IF NOT EXISTS cases (
      case_id                TEXT PRIMARY KEY,
      court_id               TEXT NOT NULL,
      plaintiff_did          TEXT NOT NULL,
      defendant_did          TEXT NOT NULL,
      kind                   TEXT NOT NULL DEFAULT 'other',
      claim                  TEXT,
      damages_requested_cents BIGINT NOT NULL DEFAULT 0,
      evidence               JSONB DEFAULT '[]'::jsonb,
      status                 TEXT NOT NULL DEFAULT 'filed',
      judge_did              TEXT,
      verdict                JSONB,
      damages_awarded_cents  BIGINT,
      filed_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      decided_at             TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_cases_court ON cases (court_id, filed_at DESC);
    CREATE INDEX IF NOT EXISTS idx_cases_plaintiff ON cases (plaintiff_did);
    CREATE INDEX IF NOT EXISTS idx_cases_defendant ON cases (defendant_did);
    CREATE INDEX IF NOT EXISTS idx_cases_status ON cases (status);

    CREATE TABLE IF NOT EXISTS case_filings (
      filing_id    TEXT PRIMARY KEY,
      case_id      TEXT NOT NULL,
      filer_did    TEXT NOT NULL,
      kind         TEXT NOT NULL,
      content      TEXT,
      attachments  JSONB,
      filed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_case_filings_case ON case_filings (case_id, filed_at);

    CREATE TABLE IF NOT EXISTS precedents (
      precedent_id  TEXT PRIMARY KEY,
      court_id      TEXT NOT NULL,
      case_id       TEXT NOT NULL,
      summary       TEXT,
      principles    TEXT[] DEFAULT '{}',
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_precedents_court ON precedents (court_id);
  `).catch(() => {});
}

function genId(prefix) { return `${prefix}_${cryptoLib.randomBytes(12).toString('hex')}`; }

async function reputationFor(pool, did) {
  const r = await pool.query(
    `SELECT score FROM reputation_scores WHERE agent_did=$1 LIMIT 1`, [did]
  ).catch(() => ({ rows: [] }));
  if (r.rows[0] && r.rows[0].score != null) return parseFloat(r.rows[0].score);
  return 0.5;
}

function registerCourtsRoutes(app, pool, verifyAgentAuth, auditChain) {
  // POST /v1/courts — admin creates a court
  const CourtSchema = z.object({
    name: z.string().min(1).max(300),
    jurisdiction: z.string().max(120).optional(),
    founder_did: z.string(),
    fee_usdc_cents: z.number().int().min(0).optional()
  });
  app.post('/v1/courts', express.json(), async (req, res) => {
    try {
      const parse = CourtSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;
      const auth = await verifyAgentAuth(req, d.founder_did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const courtId = genId('court');
      await pool.query(
        `INSERT INTO courts (court_id, name, jurisdiction, founder_did, fee_usdc_cents, judges)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [courtId, d.name, d.jurisdiction || null, d.founder_did,
         d.fee_usdc_cents || 0, [d.founder_did]]
      );
      await auditChain.append({
        event_type: 'courts.created', court_id: courtId, founder_did: d.founder_did,
        timestamp: new Date().toISOString()
      });
      return res.status(201).json({ court_id: courtId, name: d.name, judges: [d.founder_did] });
    } catch (e) { return res.status(500).json({ error: 'create_failed', message: e.message }); }
  });

  // GET /v1/courts
  app.get('/v1/courts', async (req, res) => {
    const r = await pool.query(
      `SELECT * FROM courts WHERE status='active' ORDER BY created_at DESC LIMIT 500`
    ).catch(() => ({ rows: [] }));
    return res.json({ courts: r.rows, count: r.rows.length });
  });

  // POST /v1/courts/:id/judges — apply to be a judge (requires reputation >= 0.8)
  const JudgeSchema = z.object({ applicant_did: z.string() });
  app.post('/v1/courts/:id/judges', express.json(), async (req, res) => {
    try {
      const parse = JudgeSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input' });
      const auth = await verifyAgentAuth(req, parse.data.applicant_did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const rep = await reputationFor(pool, parse.data.applicant_did);
      if (rep < MIN_JUDGE_REPUTATION) {
        return res.status(403).json({ error: 'reputation_too_low', reputation: rep, required: MIN_JUDGE_REPUTATION });
      }
      const court = await pool.query(`SELECT judges FROM courts WHERE court_id=$1`, [req.params.id]).catch(() => ({ rows: [] }));
      if (!court.rows[0]) return res.status(404).json({ error: 'not_found' });
      const judges = new Set(court.rows[0].judges || []);
      judges.add(parse.data.applicant_did);
      await pool.query(`UPDATE courts SET judges=$1 WHERE court_id=$2`, [Array.from(judges), req.params.id]);
      await auditChain.append({
        event_type: 'courts.judge_added', court_id: req.params.id,
        judge_did: parse.data.applicant_did, reputation: rep,
        timestamp: new Date().toISOString()
      });
      return res.json({ court_id: req.params.id, judge_did: parse.data.applicant_did, reputation: rep });
    } catch (e) { return res.status(500).json({ error: 'apply_failed', message: e.message }); }
  });

  // POST /v1/courts/:id/cases — plaintiff files
  const CaseSchema = z.object({
    plaintiff_did: z.string(),
    defendant_did: z.string(),
    kind: z.enum(CASE_KINDS).optional(),
    claim: z.string().max(20000),
    damages_requested_cents: z.number().int().min(0).optional(),
    evidence: z.array(z.record(z.any())).optional()
  });
  app.post('/v1/courts/:id/cases', express.json(), async (req, res) => {
    try {
      const parse = CaseSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;
      const auth = await verifyAgentAuth(req, d.plaintiff_did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const court = await pool.query(`SELECT court_id, status FROM courts WHERE court_id=$1`, [req.params.id]).catch(() => ({ rows: [] }));
      if (!court.rows[0]) return res.status(404).json({ error: 'court_not_found' });
      if (court.rows[0].status !== 'active') return res.status(400).json({ error: 'court_not_active' });
      const caseId = genId('case');
      await pool.query(
        `INSERT INTO cases (case_id, court_id, plaintiff_did, defendant_did, kind, claim,
                             damages_requested_cents, evidence, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,'filed')`,
        [caseId, req.params.id, d.plaintiff_did, d.defendant_did,
         d.kind || 'other', d.claim, d.damages_requested_cents || 0,
         JSON.stringify(d.evidence || [])]
      );
      await auditChain.append({
        event_type: 'courts.case_filed', case_id: caseId, court_id: req.params.id,
        plaintiff_did: d.plaintiff_did, defendant_did: d.defendant_did,
        kind: d.kind || 'other', timestamp: new Date().toISOString()
      });
      return res.status(201).json({ case_id: caseId, status: 'filed' });
    } catch (e) { return res.status(500).json({ error: 'file_failed', message: e.message }); }
  });

  // POST /v1/cases/:id/filings
  const FilingSchema = z.object({
    filer_did: z.string(),
    kind: z.enum(FILING_KINDS),
    content: z.string().max(50000),
    attachments: z.array(z.record(z.any())).optional()
  });
  app.post('/v1/cases/:id/filings', express.json(), async (req, res) => {
    try {
      const parse = FilingSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;
      const auth = await verifyAgentAuth(req, d.filer_did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const c = await pool.query(
        `SELECT plaintiff_did, defendant_did, status FROM cases WHERE case_id=$1`, [req.params.id]
      ).catch(() => ({ rows: [] }));
      if (!c.rows[0]) return res.status(404).json({ error: 'case_not_found' });
      if (![c.rows[0].plaintiff_did, c.rows[0].defendant_did].includes(d.filer_did)) {
        return res.status(403).json({ error: 'filer_not_a_party' });
      }
      const filingId = genId('fil');
      await pool.query(
        `INSERT INTO case_filings (filing_id, case_id, filer_did, kind, content, attachments)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
        [filingId, req.params.id, d.filer_did, d.kind, d.content,
         d.attachments ? JSON.stringify(d.attachments) : null]
      );
      // Status transitions
      if (d.kind === 'response' && c.rows[0].status === 'filed') {
        await pool.query(`UPDATE cases SET status='pending_response' WHERE case_id=$1`, [req.params.id]).catch(() => {});
      }
      await auditChain.append({
        event_type: 'courts.filing_submitted', filing_id: filingId, case_id: req.params.id,
        filer_did: d.filer_did, kind: d.kind, timestamp: new Date().toISOString()
      });
      return res.status(201).json({ filing_id: filingId, case_id: req.params.id, kind: d.kind });
    } catch (e) { return res.status(500).json({ error: 'filing_failed', message: e.message }); }
  });

  // POST /v1/cases/:id/decide — judge decides
  const DecisionSchema = z.object({
    judge_did: z.string(),
    verdict: z.record(z.any()),
    damages_awarded_cents: z.number().int().min(0).optional(),
    create_precedent: z.boolean().optional(),
    precedent_summary: z.string().max(5000).optional(),
    precedent_principles: z.array(z.string()).optional()
  });
  app.post('/v1/cases/:id/decide', express.json(), async (req, res) => {
    try {
      const parse = DecisionSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;
      const auth = await verifyAgentAuth(req, d.judge_did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const c = await pool.query(`SELECT * FROM cases WHERE case_id=$1`, [req.params.id]).catch(() => ({ rows: [] }));
      if (!c.rows[0]) return res.status(404).json({ error: 'not_found' });
      const court = await pool.query(`SELECT judges FROM courts WHERE court_id=$1`, [c.rows[0].court_id]).catch(() => ({ rows: [] }));
      if (!court.rows[0] || !(court.rows[0].judges || []).includes(d.judge_did)) {
        return res.status(403).json({ error: 'not_a_judge_in_this_court' });
      }

      await pool.query(
        `UPDATE cases SET status='decided', judge_did=$1, verdict=$2::jsonb,
                          damages_awarded_cents=$3, decided_at=NOW()
         WHERE case_id=$4`,
        [d.judge_did, JSON.stringify(d.verdict), d.damages_awarded_cents ?? null, req.params.id]
      );

      let precedentId = null;
      if (d.create_precedent) {
        precedentId = genId('prec');
        await pool.query(
          `INSERT INTO precedents (precedent_id, court_id, case_id, summary, principles)
           VALUES ($1,$2,$3,$4,$5)`,
          [precedentId, c.rows[0].court_id, req.params.id,
           d.precedent_summary || null, d.precedent_principles || []]
        ).catch(() => {});
      }

      await auditChain.append({
        event_type: 'courts.case_decided', case_id: req.params.id,
        court_id: c.rows[0].court_id, judge_did: d.judge_did,
        damages_awarded_cents: d.damages_awarded_cents || 0,
        precedent_id: precedentId, timestamp: new Date().toISOString()
      });
      return res.json({
        case_id: req.params.id, status: 'decided', judge_did: d.judge_did,
        damages_awarded_cents: d.damages_awarded_cents || 0,
        precedent_id: precedentId
      });
    } catch (e) { return res.status(500).json({ error: 'decide_failed', message: e.message }); }
  });

  // POST /v1/cases/:id/appeal
  const AppealSchema = z.object({
    appellant_did: z.string(),
    grounds: z.string().max(20000)
  });
  app.post('/v1/cases/:id/appeal', express.json(), async (req, res) => {
    try {
      const parse = AppealSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input' });
      const d = parse.data;
      const auth = await verifyAgentAuth(req, d.appellant_did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const c = await pool.query(`SELECT plaintiff_did, defendant_did, status FROM cases WHERE case_id=$1`, [req.params.id]).catch(() => ({ rows: [] }));
      if (!c.rows[0]) return res.status(404).json({ error: 'not_found' });
      if (c.rows[0].status !== 'decided') return res.status(400).json({ error: 'case_not_decided_yet' });
      if (![c.rows[0].plaintiff_did, c.rows[0].defendant_did].includes(d.appellant_did)) {
        return res.status(403).json({ error: 'not_a_party' });
      }
      const filingId = genId('fil');
      await pool.query(
        `INSERT INTO case_filings (filing_id, case_id, filer_did, kind, content)
         VALUES ($1,$2,$3,'appeal',$4)`,
        [filingId, req.params.id, d.appellant_did, d.grounds]
      );
      await pool.query(`UPDATE cases SET status='appealed' WHERE case_id=$1`, [req.params.id]).catch(() => {});
      await auditChain.append({
        event_type: 'courts.case_appealed', case_id: req.params.id,
        appellant_did: d.appellant_did, filing_id: filingId,
        timestamp: new Date().toISOString()
      });
      return res.json({ case_id: req.params.id, status: 'appealed', filing_id: filingId });
    } catch (e) { return res.status(500).json({ error: 'appeal_failed', message: e.message }); }
  });

  // GET /v1/cases/:id
  app.get('/v1/cases/:id', async (req, res) => {
    const c = await pool.query(`SELECT * FROM cases WHERE case_id=$1`, [req.params.id]).catch(() => ({ rows: [] }));
    if (!c.rows[0]) return res.status(404).json({ error: 'not_found' });
    const filings = await pool.query(
      `SELECT * FROM case_filings WHERE case_id=$1 ORDER BY filed_at ASC`, [req.params.id]
    ).catch(() => ({ rows: [] }));
    return res.json({ case: c.rows[0], filings: filings.rows });
  });

  // GET /v1/courts/:id/precedents
  app.get('/v1/courts/:id/precedents', async (req, res) => {
    const r = await pool.query(
      `SELECT * FROM precedents WHERE court_id=$1 ORDER BY created_at DESC LIMIT 500`,
      [req.params.id]
    ).catch(() => ({ rows: [] }));
    return res.json({ court_id: req.params.id, precedents: r.rows, count: r.rows.length });
  });
}

module.exports = {
  migrate, registerCourtsRoutes,
  CASE_KINDS, CASE_STATUSES, FILING_KINDS, COURT_STATUSES, MIN_JUDGE_REPUTATION,
  reputationFor
};
