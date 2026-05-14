// ============================================================================
// OpenHeab Recruiting — Hire other agents or humans
// ============================================================================
const express = require('express');
const cryptoLib = require('crypto');
const { z } = require('zod');

const JOB_KINDS = ['employment', 'contract', 'gig', 'agent-hire'];
const COMP_PERIODS = ['hourly', 'monthly', 'yearly', 'per_task'];
const LOCATION_KINDS = ['remote', 'onsite', 'hybrid'];
const JOB_STATUSES = ['open', 'paused', 'closed'];
const APPLICATION_STATUSES = ['submitted', 'screening', 'interview', 'offer', 'rejected', 'withdrawn', 'hired'];
const INTERVIEW_KINDS = ['phone', 'video', 'onsite', 'take_home'];
const RECOMMENDATIONS = ['hire', 'no_hire', 'maybe'];
const OFFER_DECISIONS = ['pending', 'accepted', 'rejected', 'withdrawn'];

async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS job_postings (
      job_id                TEXT PRIMARY KEY,
      hirer_did             TEXT NOT NULL,
      title                 TEXT NOT NULL,
      description           TEXT,
      kind                  TEXT NOT NULL DEFAULT 'contract',
      required_skills       TEXT[] DEFAULT '{}',
      compensation_min_cents BIGINT,
      compensation_max_cents BIGINT,
      compensation_period   TEXT,
      location              TEXT,
      location_country      TEXT,
      equity_pct            REAL,
      status                TEXT NOT NULL DEFAULT 'open',
      posted_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      closes_at             TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_job_postings_hirer ON job_postings (hirer_did);
    CREATE INDEX IF NOT EXISTS idx_job_postings_status ON job_postings (status);

    CREATE TABLE IF NOT EXISTS job_applications (
      application_id   TEXT PRIMARY KEY,
      job_id           TEXT NOT NULL,
      applicant_did    TEXT,
      applicant_email  TEXT,
      applicant_name   TEXT,
      cover_letter     TEXT,
      resume_blob_id   TEXT,
      skills_match     REAL,
      score            REAL,
      status           TEXT NOT NULL DEFAULT 'submitted',
      notes            TEXT,
      applied_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_job_apps_job ON job_applications (job_id);
    CREATE INDEX IF NOT EXISTS idx_job_apps_applicant ON job_applications (applicant_did);

    CREATE TABLE IF NOT EXISTS interviews (
      interview_id      TEXT PRIMARY KEY,
      application_id    TEXT NOT NULL,
      kind              TEXT NOT NULL DEFAULT 'video',
      scheduled_at      TIMESTAMPTZ,
      duration_minutes  INTEGER,
      interviewer_did   TEXT,
      feedback          JSONB DEFAULT '{}'::jsonb,
      recommendation    TEXT,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at      TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_interviews_application ON interviews (application_id);

    CREATE TABLE IF NOT EXISTS offers (
      offer_id        TEXT PRIMARY KEY,
      application_id  TEXT NOT NULL,
      compensation    JSONB DEFAULT '{}'::jsonb,
      equity          JSONB DEFAULT '{}'::jsonb,
      start_date      DATE,
      decision        TEXT NOT NULL DEFAULT 'pending',
      expires_at      TIMESTAMPTZ,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      decided_at      TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_offers_application ON offers (application_id);
  `).catch(() => {});
}

function genId(prefix) {
  return `${prefix}_${cryptoLib.randomBytes(12).toString('hex')}`;
}

function registerRecruitingRoutes(app, pool, verifyAgentAuth, auditChain) {
  // ---- Create job ----
  const JobSchema = z.object({
    title: z.string().min(1).max(300),
    description: z.string().max(50000).optional(),
    kind: z.enum(JOB_KINDS).optional(),
    required_skills: z.array(z.string()).optional(),
    compensation_min_cents: z.number().int().min(0).optional(),
    compensation_max_cents: z.number().int().min(0).optional(),
    compensation_period: z.enum(COMP_PERIODS).optional(),
    location: z.enum(LOCATION_KINDS).optional(),
    location_country: z.string().max(80).optional(),
    equity_pct: z.number().min(0).max(100).optional(),
    closes_at: z.string().optional()
  });

  app.post('/v1/agents/:did/recruiting/jobs', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const parse = JobSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;
      const jobId = genId('job');
      await pool.query(
        `INSERT INTO job_postings (job_id, hirer_did, title, description, kind, required_skills,
           compensation_min_cents, compensation_max_cents, compensation_period,
           location, location_country, equity_pct, status, closes_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'open',$13)`,
        [jobId, did, d.title, d.description || null, d.kind || 'contract', d.required_skills || [],
         d.compensation_min_cents || null, d.compensation_max_cents || null,
         d.compensation_period || null, d.location || null, d.location_country || null,
         d.equity_pct || null, d.closes_at || null]
      );
      await auditChain.append({
        event_type: 'recruiting.job_posted', job_id: jobId, hirer_did: did,
        kind: d.kind || 'contract', timestamp: new Date().toISOString()
      });
      return res.status(201).json({ job_id: jobId, hirer_did: did, status: 'open' });
    } catch (e) { return res.status(500).json({ error: 'create_failed', message: e.message }); }
  });

  app.get('/v1/agents/:did/recruiting/jobs', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const status = req.query.status;
    const params = [did];
    let sql = `SELECT * FROM job_postings WHERE hirer_did=$1`;
    if (status) { params.push(status); sql += ` AND status=$${params.length}`; }
    sql += ` ORDER BY posted_at DESC LIMIT 500`;
    const r = await pool.query(sql, params).catch(() => ({ rows: [] }));
    return res.json({ jobs: r.rows, count: r.rows.length });
  });

  // ---- Public browse ----
  app.get('/v1/recruiting/jobs', async (req, res) => {
    const kind = req.query.kind;
    const skill = req.query.skill;
    const location = req.query.location;
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    const params = [];
    let sql = `SELECT * FROM job_postings WHERE status='open'`;
    if (kind) { params.push(kind); sql += ` AND kind=$${params.length}`; }
    if (location) { params.push(location); sql += ` AND location=$${params.length}`; }
    if (skill) { params.push(skill); sql += ` AND $${params.length} = ANY(required_skills)`; }
    params.push(limit);
    sql += ` ORDER BY posted_at DESC LIMIT $${params.length}`;
    const r = await pool.query(sql, params).catch(() => ({ rows: [] }));
    return res.json({ jobs: r.rows, count: r.rows.length });
  });

  app.get('/v1/recruiting/jobs/:id', async (req, res) => {
    const r = await pool.query(`SELECT * FROM job_postings WHERE job_id=$1`, [req.params.id]).catch(() => ({ rows: [] }));
    if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
    return res.json({ job: r.rows[0] });
  });

  // ---- Apply ----
  const ApplicationSchema = z.object({
    applicant_did: z.string().optional(),
    applicant_email: z.string().email().optional(),
    applicant_name: z.string().max(300).optional(),
    cover_letter: z.string().max(20000).optional(),
    resume_blob_id: z.string().max(200).optional(),
    skills: z.array(z.string()).optional()
  });

  app.post('/v1/recruiting/jobs/:id/apply', express.json(), async (req, res) => {
    try {
      const parse = ApplicationSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;
      if (!d.applicant_did && !d.applicant_email) return res.status(400).json({ error: 'applicant_did_or_email_required' });
      const job = await pool.query(
        `SELECT * FROM job_postings WHERE job_id=$1 AND status='open'`, [req.params.id]
      ).catch(() => ({ rows: [] }));
      if (!job.rows[0]) return res.status(404).json({ error: 'job_not_found_or_closed' });

      // Compute skills_match if skills supplied
      let skillsMatch = null;
      const required = Array.isArray(job.rows[0].required_skills) ? job.rows[0].required_skills : [];
      if (required.length && d.skills && d.skills.length) {
        const overlap = d.skills.filter(s => required.includes(s)).length;
        skillsMatch = overlap / required.length;
      }

      const appId = genId('app');
      await pool.query(
        `INSERT INTO job_applications (application_id, job_id, applicant_did, applicant_email,
           applicant_name, cover_letter, resume_blob_id, skills_match, score, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'submitted')`,
        [appId, req.params.id, d.applicant_did || null, d.applicant_email || null,
         d.applicant_name || null, d.cover_letter || null, d.resume_blob_id || null,
         skillsMatch, skillsMatch]
      );
      await auditChain.append({
        event_type: 'recruiting.application_submitted', application_id: appId,
        job_id: req.params.id, hirer_did: job.rows[0].hirer_did,
        applicant_did: d.applicant_did || null, timestamp: new Date().toISOString()
      });
      return res.status(201).json({ application_id: appId, job_id: req.params.id, status: 'submitted', skills_match: skillsMatch });
    } catch (e) { return res.status(500).json({ error: 'apply_failed', message: e.message }); }
  });

  app.get('/v1/agents/:did/recruiting/jobs/:id/applications', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const j = await pool.query(`SELECT job_id FROM job_postings WHERE job_id=$1 AND hirer_did=$2`, [req.params.id, did]).catch(() => ({ rows: [] }));
    if (!j.rows[0]) return res.status(404).json({ error: 'not_found' });
    const r = await pool.query(
      `SELECT * FROM job_applications WHERE job_id=$1 ORDER BY applied_at DESC LIMIT 1000`,
      [req.params.id]
    ).catch(() => ({ rows: [] }));
    return res.json({ applications: r.rows, count: r.rows.length });
  });

  // ---- Advance application ----
  app.post('/v1/agents/:did/recruiting/jobs/:id/applications/:aid/advance', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const body = z.object({
        status: z.enum(APPLICATION_STATUSES),
        notes: z.string().max(5000).optional()
      }).safeParse(req.body || {});
      if (!body.success) return res.status(400).json({ error: 'invalid_input', details: body.error.issues });
      const job = await pool.query(`SELECT hirer_did FROM job_postings WHERE job_id=$1`, [req.params.id]).catch(() => ({ rows: [] }));
      if (!job.rows[0] || job.rows[0].hirer_did !== did) return res.status(404).json({ error: 'not_found' });
      const r = await pool.query(
        `UPDATE job_applications SET status=$1, notes=COALESCE($2, notes), updated_at=NOW()
         WHERE application_id=$3 AND job_id=$4 RETURNING application_id, status`,
        [body.data.status, body.data.notes || null, req.params.aid, req.params.id]
      ).catch(() => ({ rows: [] }));
      if (!r.rows[0]) return res.status(404).json({ error: 'application_not_found' });
      // If hired, close the job
      if (body.data.status === 'hired') {
        await pool.query(`UPDATE job_postings SET status='closed' WHERE job_id=$1`, [req.params.id]).catch(() => {});
      }
      await auditChain.append({
        event_type: 'recruiting.application_advanced', application_id: req.params.aid,
        job_id: req.params.id, hirer_did: did, status: body.data.status,
        timestamp: new Date().toISOString()
      });
      return res.json({ application_id: req.params.aid, status: r.rows[0].status });
    } catch (e) { return res.status(500).json({ error: 'advance_failed', message: e.message }); }
  });

  // ---- Schedule interview ----
  const InterviewSchema = z.object({
    kind: z.enum(INTERVIEW_KINDS).optional(),
    scheduled_at: z.string().optional(),
    duration_minutes: z.number().int().min(1).optional(),
    interviewer_did: z.string().optional(),
    feedback: z.record(z.any()).optional(),
    recommendation: z.enum(RECOMMENDATIONS).optional()
  });

  app.post('/v1/agents/:did/recruiting/applications/:aid/interviews', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const parse = InterviewSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;
      const app = await pool.query(
        `SELECT a.application_id, j.hirer_did FROM job_applications a
         JOIN job_postings j ON j.job_id = a.job_id
         WHERE a.application_id=$1`, [req.params.aid]
      ).catch(() => ({ rows: [] }));
      if (!app.rows[0] || app.rows[0].hirer_did !== did) return res.status(404).json({ error: 'not_found' });
      const interviewId = genId('intv');
      const completedAt = d.recommendation ? new Date().toISOString() : null;
      await pool.query(
        `INSERT INTO interviews (interview_id, application_id, kind, scheduled_at, duration_minutes,
           interviewer_did, feedback, recommendation, completed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)`,
        [interviewId, req.params.aid, d.kind || 'video', d.scheduled_at || null,
         d.duration_minutes || null, d.interviewer_did || null,
         JSON.stringify(d.feedback || {}), d.recommendation || null, completedAt]
      );
      await pool.query(`UPDATE job_applications SET status='interview', updated_at=NOW() WHERE application_id=$1`, [req.params.aid]).catch(() => {});
      await auditChain.append({
        event_type: 'recruiting.interview_scheduled', interview_id: interviewId,
        application_id: req.params.aid, hirer_did: did, timestamp: new Date().toISOString()
      });
      return res.status(201).json({ interview_id: interviewId, application_id: req.params.aid });
    } catch (e) { return res.status(500).json({ error: 'create_failed', message: e.message }); }
  });

  // ---- Make offer ----
  const OfferSchema = z.object({
    compensation: z.record(z.any()).optional(),
    equity: z.record(z.any()).optional(),
    start_date: z.string().optional(),
    expires_at: z.string().optional()
  });

  app.post('/v1/agents/:did/recruiting/applications/:aid/offer', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const parse = OfferSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;
      const app = await pool.query(
        `SELECT a.application_id, j.hirer_did FROM job_applications a
         JOIN job_postings j ON j.job_id = a.job_id
         WHERE a.application_id=$1`, [req.params.aid]
      ).catch(() => ({ rows: [] }));
      if (!app.rows[0] || app.rows[0].hirer_did !== did) return res.status(404).json({ error: 'not_found' });
      const offerId = genId('offer');
      await pool.query(
        `INSERT INTO offers (offer_id, application_id, compensation, equity, start_date, decision, expires_at)
         VALUES ($1,$2,$3::jsonb,$4::jsonb,$5,'pending',$6)`,
        [offerId, req.params.aid, JSON.stringify(d.compensation || {}),
         JSON.stringify(d.equity || {}), d.start_date || null, d.expires_at || null]
      );
      await pool.query(`UPDATE job_applications SET status='offer', updated_at=NOW() WHERE application_id=$1`, [req.params.aid]).catch(() => {});
      await auditChain.append({
        event_type: 'recruiting.offer_made', offer_id: offerId, application_id: req.params.aid,
        hirer_did: did, timestamp: new Date().toISOString()
      });
      return res.status(201).json({ offer_id: offerId, application_id: req.params.aid, decision: 'pending' });
    } catch (e) { return res.status(500).json({ error: 'create_failed', message: e.message }); }
  });

  // ---- Respond to offer ----
  app.post('/v1/recruiting/offers/:id/respond', express.json(), async (req, res) => {
    try {
      const body = z.object({
        decision: z.enum(OFFER_DECISIONS)
      }).safeParse(req.body || {});
      if (!body.success) return res.status(400).json({ error: 'invalid_input', details: body.error.issues });
      const o = await pool.query(
        `SELECT o.*, a.applicant_did, a.job_id, j.hirer_did
         FROM offers o
         JOIN job_applications a ON a.application_id = o.application_id
         JOIN job_postings j ON j.job_id = a.job_id
         WHERE o.offer_id=$1`, [req.params.id]
      ).catch(() => ({ rows: [] }));
      if (!o.rows[0]) return res.status(404).json({ error: 'not_found' });
      if (o.rows[0].decision !== 'pending') return res.status(409).json({ error: 'offer_already_decided' });
      await pool.query(
        `UPDATE offers SET decision=$1, decided_at=NOW() WHERE offer_id=$2`,
        [body.data.decision, req.params.id]
      );
      if (body.data.decision === 'accepted') {
        await pool.query(`UPDATE job_applications SET status='hired', updated_at=NOW() WHERE application_id=$1`, [o.rows[0].application_id]).catch(() => {});
        await pool.query(`UPDATE job_postings SET status='closed' WHERE job_id=$1`, [o.rows[0].job_id]).catch(() => {});
      } else if (body.data.decision === 'rejected') {
        await pool.query(`UPDATE job_applications SET status='rejected', updated_at=NOW() WHERE application_id=$1`, [o.rows[0].application_id]).catch(() => {});
      }
      await auditChain.append({
        event_type: 'recruiting.offer_decided', offer_id: req.params.id,
        application_id: o.rows[0].application_id, hirer_did: o.rows[0].hirer_did,
        decision: body.data.decision, timestamp: new Date().toISOString()
      });
      return res.json({ offer_id: req.params.id, decision: body.data.decision });
    } catch (e) { return res.status(500).json({ error: 'respond_failed', message: e.message }); }
  });
}

module.exports = {
  migrate,
  registerRecruitingRoutes,
  JOB_KINDS,
  COMP_PERIODS,
  LOCATION_KINDS,
  JOB_STATUSES,
  APPLICATION_STATUSES,
  INTERVIEW_KINDS,
  RECOMMENDATIONS,
  OFFER_DECISIONS
};
