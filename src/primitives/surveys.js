// ============================================================================
// OpenHeab Surveys — CSAT/NPS/CES surveys
// ============================================================================
const express = require('express');
const cryptoLib = require('crypto');
const { z } = require('zod');

const SURVEY_KINDS = ['nps', 'csat', 'ces', 'custom'];
const TARGET_KINDS = ['purchase', 'ticket_close', 'onboarding', 'periodic'];

async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS surveys (
      survey_id              TEXT PRIMARY KEY,
      owner_did              TEXT NOT NULL,
      name                   TEXT NOT NULL,
      kind                   TEXT NOT NULL DEFAULT 'custom',
      target_kind            TEXT,
      target_event           TEXT,
      trigger_delay_minutes  INTEGER,
      questions              JSONB DEFAULT '[]'::jsonb,
      audience               JSONB DEFAULT '{}'::jsonb,
      active                 BOOLEAN NOT NULL DEFAULT TRUE,
      response_target        INTEGER,
      created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_surveys_owner ON surveys (owner_did);

    CREATE TABLE IF NOT EXISTS survey_invitations (
      invitation_id     TEXT PRIMARY KEY,
      survey_id         TEXT NOT NULL,
      recipient_did     TEXT,
      recipient_email   TEXT,
      sent_at           TIMESTAMPTZ,
      opened_at         TIMESTAMPTZ,
      responded_at      TIMESTAMPTZ,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_survey_invitations_survey ON survey_invitations (survey_id);

    CREATE TABLE IF NOT EXISTS survey_responses (
      response_id     TEXT PRIMARY KEY,
      survey_id       TEXT NOT NULL,
      invitation_id   TEXT,
      respondent_did  TEXT,
      answers         JSONB DEFAULT '{}'::jsonb,
      score           INTEGER,
      comment         TEXT,
      submitted_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_survey_responses_survey ON survey_responses (survey_id);

    CREATE TABLE IF NOT EXISTS survey_summaries (
      survey_id       TEXT PRIMARY KEY,
      total_invited   INTEGER NOT NULL DEFAULT 0,
      total_responded INTEGER NOT NULL DEFAULT 0,
      response_rate   REAL NOT NULL DEFAULT 0,
      nps_score       REAL,
      csat_score      REAL,
      ces_score       REAL,
      computed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `).catch(() => {});
}

function genId(prefix) {
  return `${prefix}_${cryptoLib.randomBytes(12).toString('hex')}`;
}

async function computeSurveySummary(pool, surveyId) {
  const inv = await pool.query(
    `SELECT COUNT(*)::int AS total, COUNT(responded_at)::int AS responded FROM survey_invitations WHERE survey_id=$1`,
    [surveyId]
  ).catch(() => ({ rows: [{ total: 0, responded: 0 }] }));
  const resp = await pool.query(
    `SELECT score FROM survey_responses WHERE survey_id=$1`, [surveyId]
  ).catch(() => ({ rows: [] }));
  const survey = await pool.query(`SELECT kind FROM surveys WHERE survey_id=$1`, [surveyId]).catch(() => ({ rows: [] }));
  const kind = survey.rows[0]?.kind;

  const totalInvited = inv.rows[0].total;
  const totalResponded = Math.max(inv.rows[0].responded, resp.rows.length);
  const responseRate = totalInvited > 0 ? totalResponded / totalInvited : 0;
  const scores = resp.rows.map(r => parseInt(r.score)).filter(n => !isNaN(n));

  let nps = null, csat = null, ces = null;
  if (kind === 'nps' && scores.length) {
    const promoters = scores.filter(s => s >= 9).length;
    const detractors = scores.filter(s => s <= 6).length;
    nps = ((promoters - detractors) / scores.length) * 100;
  }
  if (kind === 'csat' && scores.length) {
    // CSAT: % rated 4 or 5 on 1-5 scale (satisfied)
    const satisfied = scores.filter(s => s >= 4).length;
    csat = (satisfied / scores.length) * 100;
  }
  if (kind === 'ces' && scores.length) {
    // CES: average effort score (1-7)
    ces = scores.reduce((a, b) => a + b, 0) / scores.length;
  }

  await pool.query(
    `INSERT INTO survey_summaries (survey_id, total_invited, total_responded, response_rate,
       nps_score, csat_score, ces_score, computed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
     ON CONFLICT (survey_id) DO UPDATE SET
       total_invited=EXCLUDED.total_invited,
       total_responded=EXCLUDED.total_responded,
       response_rate=EXCLUDED.response_rate,
       nps_score=EXCLUDED.nps_score,
       csat_score=EXCLUDED.csat_score,
       ces_score=EXCLUDED.ces_score,
       computed_at=NOW()`,
    [surveyId, totalInvited, totalResponded, responseRate, nps, csat, ces]
  ).catch(() => {});

  return {
    survey_id: surveyId,
    total_invited: totalInvited,
    total_responded: totalResponded,
    response_rate: responseRate,
    nps_score: nps,
    csat_score: csat,
    ces_score: ces
  };
}

function registerSurveysRoutes(app, pool, verifyAgentAuth, auditChain) {
  // ---- Create survey ----
  const QuestionSchema = z.object({
    key: z.string().min(1).max(80),
    text: z.string().min(1).max(1000),
    type: z.enum(['scale', 'text', 'select', 'multi', 'boolean']).optional(),
    options: z.array(z.string()).optional(),
    scale_min: z.number().int().optional(),
    scale_max: z.number().int().optional()
  });
  const SurveySchema = z.object({
    name: z.string().min(1).max(300),
    kind: z.enum(SURVEY_KINDS).optional(),
    target_kind: z.enum(TARGET_KINDS).optional(),
    target_event: z.string().max(200).optional(),
    trigger_delay_minutes: z.number().int().min(0).optional(),
    questions: z.array(QuestionSchema).optional(),
    audience: z.record(z.any()).optional(),
    active: z.boolean().optional(),
    response_target: z.number().int().min(1).optional()
  });

  app.post('/v1/agents/:did/surveys', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const parse = SurveySchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;
      const surveyId = genId('srv');
      await pool.query(
        `INSERT INTO surveys (survey_id, owner_did, name, kind, target_kind, target_event,
           trigger_delay_minutes, questions, audience, active, response_target)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11)`,
        [surveyId, did, d.name, d.kind || 'custom', d.target_kind || null, d.target_event || null,
         d.trigger_delay_minutes || null, JSON.stringify(d.questions || []),
         JSON.stringify(d.audience || {}), d.active !== false, d.response_target || null]
      );
      await pool.query(`INSERT INTO survey_summaries (survey_id) VALUES ($1) ON CONFLICT DO NOTHING`, [surveyId]).catch(() => {});
      await auditChain.append({
        event_type: 'surveys.created', survey_id: surveyId, owner_did: did,
        kind: d.kind || 'custom', timestamp: new Date().toISOString()
      });
      return res.status(201).json({ survey_id: surveyId, owner_did: did, kind: d.kind || 'custom' });
    } catch (e) { return res.status(500).json({ error: 'create_failed', message: e.message }); }
  });

  app.get('/v1/agents/:did/surveys', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(
      `SELECT * FROM surveys WHERE owner_did=$1 ORDER BY created_at DESC`, [did]
    ).catch(() => ({ rows: [] }));
    return res.json({ surveys: r.rows, count: r.rows.length });
  });

  // ---- Send invitations ----
  app.post('/v1/agents/:did/surveys/:id/send', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const body = z.object({
        recipients: z.array(z.object({
          email: z.string().email().optional(),
          did: z.string().optional()
        })).min(1).max(10000)
      }).safeParse(req.body || {});
      if (!body.success) return res.status(400).json({ error: 'invalid_input', details: body.error.issues });
      const survey = await pool.query(
        `SELECT * FROM surveys WHERE survey_id=$1 AND owner_did=$2 AND active=TRUE`,
        [req.params.id, did]
      ).catch(() => ({ rows: [] }));
      if (!survey.rows[0]) return res.status(404).json({ error: 'survey_not_found_or_inactive' });
      const invitations = [];
      for (const r of body.data.recipients) {
        if (!r.email && !r.did) continue;
        const invId = genId('sinv');
        await pool.query(
          `INSERT INTO survey_invitations (invitation_id, survey_id, recipient_did, recipient_email, sent_at)
           VALUES ($1,$2,$3,$4,NOW())`,
          [invId, req.params.id, r.did || null, r.email || null]
        ).catch(() => {});
        invitations.push({ invitation_id: invId, recipient_email: r.email, recipient_did: r.did });
      }
      await auditChain.append({
        event_type: 'surveys.invitations_sent', survey_id: req.params.id, owner_did: did,
        count: invitations.length, timestamp: new Date().toISOString()
      });
      await computeSurveySummary(pool, req.params.id).catch(() => {});
      return res.status(201).json({ survey_id: req.params.id, sent: invitations.length, invitations });
    } catch (e) { return res.status(500).json({ error: 'send_failed', message: e.message }); }
  });

  // ---- Public respond ----
  app.post('/v1/surveys/:id/respond', express.json(), async (req, res) => {
    try {
      const body = z.object({
        invitation_id: z.string().optional(),
        respondent_did: z.string().optional(),
        respondent_email: z.string().email().optional(),
        answers: z.record(z.any()).optional(),
        score: z.number().int().optional(),
        comment: z.string().max(5000).optional()
      }).safeParse(req.body || {});
      if (!body.success) return res.status(400).json({ error: 'invalid_input', details: body.error.issues });
      const survey = await pool.query(
        `SELECT * FROM surveys WHERE survey_id=$1 AND active=TRUE`, [req.params.id]
      ).catch(() => ({ rows: [] }));
      if (!survey.rows[0]) return res.status(404).json({ error: 'survey_not_found_or_inactive' });

      // Validate invitation if provided
      if (body.data.invitation_id) {
        const inv = await pool.query(
          `SELECT * FROM survey_invitations WHERE invitation_id=$1 AND survey_id=$2`,
          [body.data.invitation_id, req.params.id]
        ).catch(() => ({ rows: [] }));
        if (!inv.rows[0]) return res.status(404).json({ error: 'invitation_not_found' });
      }

      const respId = genId('sresp');
      await pool.query(
        `INSERT INTO survey_responses (response_id, survey_id, invitation_id, respondent_did, answers, score, comment)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7)`,
        [respId, req.params.id, body.data.invitation_id || null,
         body.data.respondent_did || null, JSON.stringify(body.data.answers || {}),
         body.data.score === undefined ? null : body.data.score, body.data.comment || null]
      );
      if (body.data.invitation_id) {
        await pool.query(`UPDATE survey_invitations SET responded_at=NOW() WHERE invitation_id=$1`, [body.data.invitation_id]).catch(() => {});
      }
      await auditChain.append({
        event_type: 'surveys.responded', response_id: respId, survey_id: req.params.id,
        owner_did: survey.rows[0].owner_did, score: body.data.score, timestamp: new Date().toISOString()
      });
      await computeSurveySummary(pool, req.params.id).catch(() => {});
      return res.status(201).json({ response_id: respId, survey_id: req.params.id });
    } catch (e) { return res.status(500).json({ error: 'respond_failed', message: e.message }); }
  });

  // ---- Mark invitation opened ----
  app.post('/v1/surveys/invitations/:iid/open', async (req, res) => {
    const r = await pool.query(
      `UPDATE survey_invitations SET opened_at=COALESCE(opened_at, NOW()) WHERE invitation_id=$1 RETURNING invitation_id`,
      [req.params.iid]
    ).catch(() => ({ rows: [] }));
    if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
    return res.json({ invitation_id: r.rows[0].invitation_id, opened: true });
  });

  // ---- List responses ----
  app.get('/v1/agents/:did/surveys/:id/responses', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const s = await pool.query(
      `SELECT survey_id FROM surveys WHERE survey_id=$1 AND owner_did=$2`,
      [req.params.id, did]
    ).catch(() => ({ rows: [] }));
    if (!s.rows[0]) return res.status(404).json({ error: 'not_found' });
    const r = await pool.query(
      `SELECT * FROM survey_responses WHERE survey_id=$1 ORDER BY submitted_at DESC LIMIT 1000`,
      [req.params.id]
    ).catch(() => ({ rows: [] }));
    return res.json({ responses: r.rows, count: r.rows.length });
  });

  // ---- Summary ----
  app.get('/v1/agents/:did/surveys/:id/summary', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const s = await pool.query(
      `SELECT * FROM surveys WHERE survey_id=$1 AND owner_did=$2`,
      [req.params.id, did]
    ).catch(() => ({ rows: [] }));
    if (!s.rows[0]) return res.status(404).json({ error: 'not_found' });
    const summary = await computeSurveySummary(pool, req.params.id);
    return res.json({ survey: { survey_id: s.rows[0].survey_id, name: s.rows[0].name, kind: s.rows[0].kind }, summary });
  });
}

module.exports = {
  migrate,
  registerSurveysRoutes,
  SURVEY_KINDS,
  TARGET_KINDS,
  computeSurveySummary
};
