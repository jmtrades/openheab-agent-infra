// ============================================================================
// OpenHeab Forms — Survey/poll/form builder
// ============================================================================
const express = require('express');
const cryptoLib = require('crypto');
const { z } = require('zod');

const FIELD_TYPES = ['text', 'textarea', 'email', 'number', 'select', 'multi', 'checkbox', 'radio', 'date', 'file'];

async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS forms (
      form_id        TEXT PRIMARY KEY,
      owner_did      TEXT NOT NULL,
      name           TEXT NOT NULL,
      description    TEXT,
      fields         JSONB NOT NULL DEFAULT '[]'::jsonb,
      public_slug    TEXT UNIQUE NOT NULL,
      active         BOOLEAN NOT NULL DEFAULT TRUE,
      max_responses  INTEGER,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_forms_owner ON forms (owner_did);

    CREATE TABLE IF NOT EXISTS form_responses (
      response_id       TEXT PRIMARY KEY,
      form_id           TEXT NOT NULL,
      respondent_did    TEXT,
      respondent_email  TEXT,
      answers           JSONB NOT NULL DEFAULT '{}'::jsonb,
      submitted_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      ip                TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_form_responses_form ON form_responses (form_id);

    CREATE TABLE IF NOT EXISTS form_analytics (
      form_id          TEXT PRIMARY KEY,
      views            INTEGER NOT NULL DEFAULT 0,
      submissions      INTEGER NOT NULL DEFAULT 0,
      last_submitted   TIMESTAMPTZ
    );
  `).catch(() => {});
}

function genId(prefix) {
  return `${prefix}_${cryptoLib.randomBytes(12).toString('hex')}`;
}

function genSlug() {
  return cryptoLib.randomBytes(6).toString('hex');
}

function registerFormsRoutes(app, pool, verifyAgentAuth, auditChain) {
  const FieldSchema = z.object({
    key: z.string().min(1).max(80),
    label: z.string().min(1).max(300),
    type: z.enum(FIELD_TYPES),
    required: z.boolean().optional(),
    options: z.array(z.string()).optional(),
    validation: z.record(z.any()).optional()
  });
  const FormSchema = z.object({
    name: z.string().min(1).max(300),
    description: z.string().max(5000).optional(),
    fields: z.array(FieldSchema).min(1),
    public_slug: z.string().max(80).optional(),
    active: z.boolean().optional(),
    max_responses: z.number().int().min(1).optional()
  });

  app.post('/v1/agents/:did/forms', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const parse = FormSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;
      const formId = genId('frm');
      const slug = d.public_slug || genSlug();
      await pool.query(
        `INSERT INTO forms (form_id, owner_did, name, description, fields, public_slug, active, max_responses)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8)`,
        [formId, did, d.name, d.description || null, JSON.stringify(d.fields), slug, d.active !== false, d.max_responses || null]
      );
      await pool.query(`INSERT INTO form_analytics (form_id) VALUES ($1) ON CONFLICT DO NOTHING`, [formId]).catch(() => {});
      await auditChain.append({ event_type: 'forms.created', form_id: formId, owner_did: did, slug, timestamp: new Date().toISOString() });
      return res.status(201).json({ form_id: formId, owner_did: did, public_slug: slug });
    } catch (e) { return res.status(500).json({ error: 'create_failed', message: e.message }); }
  });

  app.get('/v1/agents/:did/forms', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(
      `SELECT * FROM forms WHERE owner_did=$1 ORDER BY created_at DESC`, [did]
    ).catch(() => ({ rows: [] }));
    return res.json({ forms: r.rows, count: r.rows.length });
  });

  app.put('/v1/agents/:did/forms/:id', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const parse = FormSchema.partial().safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;
      const fields = []; const params = []; let idx = 1;
      for (const [k, v] of Object.entries(d)) {
        if (v === undefined) continue;
        if (k === 'fields') { fields.push(`fields=$${idx++}::jsonb`); params.push(JSON.stringify(v)); }
        else { fields.push(`${k}=$${idx++}`); params.push(v); }
      }
      if (!fields.length) return res.json({ form_id: req.params.id, unchanged: true });
      params.push(req.params.id, did);
      const r = await pool.query(
        `UPDATE forms SET ${fields.join(', ')} WHERE form_id=$${idx++} AND owner_did=$${idx} RETURNING form_id`,
        params
      ).catch(() => ({ rows: [] }));
      if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
      await auditChain.append({ event_type: 'forms.updated', form_id: req.params.id, owner_did: did, timestamp: new Date().toISOString() });
      return res.json({ form_id: req.params.id, updated: true });
    } catch (e) { return res.status(500).json({ error: 'update_failed', message: e.message }); }
  });

  // Public submission — no agent auth required
  app.post('/v1/forms/:slug/submit', express.json(), async (req, res) => {
    try {
      const form = await pool.query(
        `SELECT * FROM forms WHERE public_slug=$1 AND active=TRUE`, [req.params.slug]
      ).catch(() => ({ rows: [] }));
      if (!form.rows[0]) return res.status(404).json({ error: 'form_not_found_or_inactive' });
      const f = form.rows[0];
      if (f.max_responses) {
        const count = await pool.query(`SELECT COUNT(*)::int AS n FROM form_responses WHERE form_id=$1`, [f.form_id]).catch(() => ({ rows: [{ n: 0 }] }));
        if (count.rows[0].n >= f.max_responses) return res.status(409).json({ error: 'max_responses_reached' });
      }
      const body = z.object({
        respondent_did: z.string().optional(),
        respondent_email: z.string().email().optional(),
        answers: z.record(z.any())
      }).safeParse(req.body || {});
      if (!body.success) return res.status(400).json({ error: 'invalid_input', details: body.error.issues });
      const fwd = req.headers['x-forwarded-for'];
      const ip = (fwd ? fwd.split(',')[0].trim() : (req.ip || 'unknown'));
      // Required-field validation
      const fields = Array.isArray(f.fields) ? f.fields : [];
      for (const fld of fields) {
        if (fld.required && (body.data.answers[fld.key] === undefined || body.data.answers[fld.key] === null || body.data.answers[fld.key] === '')) {
          return res.status(400).json({ error: 'missing_required_field', field: fld.key });
        }
      }
      const respId = genId('resp');
      await pool.query(
        `INSERT INTO form_responses (response_id, form_id, respondent_did, respondent_email, answers, ip)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6)`,
        [respId, f.form_id, body.data.respondent_did || null, body.data.respondent_email || null,
         JSON.stringify(body.data.answers), ip]
      );
      await pool.query(
        `INSERT INTO form_analytics (form_id, submissions, last_submitted) VALUES ($1, 1, NOW())
         ON CONFLICT (form_id) DO UPDATE SET submissions=form_analytics.submissions+1, last_submitted=NOW()`,
        [f.form_id]
      ).catch(() => {});
      await auditChain.append({ event_type: 'forms.submitted', response_id: respId, form_id: f.form_id, owner_did: f.owner_did, timestamp: new Date().toISOString() });
      return res.status(201).json({ response_id: respId, form_id: f.form_id });
    } catch (e) { return res.status(500).json({ error: 'submit_failed', message: e.message }); }
  });

  app.get('/v1/agents/:did/forms/:id/responses', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const form = await pool.query(`SELECT form_id FROM forms WHERE form_id=$1 AND owner_did=$2`, [req.params.id, did]).catch(() => ({ rows: [] }));
    if (!form.rows[0]) return res.status(404).json({ error: 'not_found' });
    const r = await pool.query(
      `SELECT * FROM form_responses WHERE form_id=$1 ORDER BY submitted_at DESC LIMIT 1000`,
      [req.params.id]
    ).catch(() => ({ rows: [] }));
    return res.json({ responses: r.rows, count: r.rows.length });
  });

  app.get('/v1/agents/:did/forms/:id/analytics', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const form = await pool.query(`SELECT * FROM forms WHERE form_id=$1 AND owner_did=$2`, [req.params.id, did]).catch(() => ({ rows: [] }));
    if (!form.rows[0]) return res.status(404).json({ error: 'not_found' });
    const f = form.rows[0];
    const analytics = await pool.query(`SELECT * FROM form_analytics WHERE form_id=$1`, [req.params.id]).catch(() => ({ rows: [] }));
    const responses = await pool.query(`SELECT answers FROM form_responses WHERE form_id=$1`, [req.params.id]).catch(() => ({ rows: [] }));
    const total = responses.rows.length;
    const perField = {};
    const fields = Array.isArray(f.fields) ? f.fields : [];
    for (const fld of fields) {
      let answered = 0;
      const counts = {};
      for (const r of responses.rows) {
        const v = r.answers && r.answers[fld.key];
        if (v !== undefined && v !== null && v !== '') {
          answered++;
          if (['select', 'radio', 'checkbox'].includes(fld.type)) counts[String(v)] = (counts[String(v)] || 0) + 1;
        }
      }
      perField[fld.key] = { answered, completion_rate: total ? answered / total : 0, value_counts: counts };
    }
    const completion = fields.length && total ? (fields.reduce((sum, fld) => sum + (perField[fld.key].completion_rate || 0), 0) / fields.length) : 0;
    return res.json({
      form_id: req.params.id,
      views: analytics.rows[0]?.views || 0,
      submissions: total,
      completion_rate: completion,
      per_field: perField
    });
  });
}

module.exports = { migrate, registerFormsRoutes, FIELD_TYPES };
