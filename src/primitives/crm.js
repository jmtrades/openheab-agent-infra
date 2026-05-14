// ============================================================================
// OpenHeab CRM — Contact + relationship management for agents
// ============================================================================
const express = require('express');
const cryptoLib = require('crypto');
const { z } = require('zod');

const CONTACT_KINDS = ['person', 'org', 'agent'];
const INTERACTION_KINDS = ['email', 'call', 'meeting', 'dm', 'note'];
const SENTIMENTS = ['positive', 'neutral', 'negative'];
const DEAL_STAGES = ['prospect', 'qualified', 'proposal', 'negotiation', 'won', 'lost'];

async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS crm_contacts (
      contact_id        TEXT PRIMARY KEY,
      owner_did         TEXT NOT NULL,
      kind              TEXT NOT NULL DEFAULT 'person',
      name              TEXT NOT NULL,
      email             TEXT,
      phone             TEXT,
      did_link          TEXT,
      company           TEXT,
      title             TEXT,
      tags              TEXT[] DEFAULT '{}',
      custom_fields     JSONB DEFAULT '{}'::jsonb,
      last_contacted_at TIMESTAMPTZ,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_crm_contacts_owner ON crm_contacts (owner_did);
    CREATE INDEX IF NOT EXISTS idx_crm_contacts_email ON crm_contacts (email);

    CREATE TABLE IF NOT EXISTS crm_interactions (
      interaction_id  TEXT PRIMARY KEY,
      contact_id      TEXT NOT NULL,
      owner_did       TEXT NOT NULL,
      kind            TEXT NOT NULL,
      summary         TEXT,
      sentiment       TEXT,
      outcome         TEXT,
      when_at         TIMESTAMPTZ,
      recorded_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_crm_interactions_contact ON crm_interactions (contact_id);
    CREATE INDEX IF NOT EXISTS idx_crm_interactions_owner ON crm_interactions (owner_did);

    CREATE TABLE IF NOT EXISTS crm_deals (
      deal_id          TEXT PRIMARY KEY,
      owner_did        TEXT NOT NULL,
      contact_id       TEXT,
      name             TEXT NOT NULL,
      value_cents      BIGINT DEFAULT 0,
      stage            TEXT NOT NULL DEFAULT 'prospect',
      close_date       DATE,
      probability_pct  INTEGER,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_crm_deals_owner ON crm_deals (owner_did);
    CREATE INDEX IF NOT EXISTS idx_crm_deals_stage ON crm_deals (stage);
  `).catch(() => {});
}

function genId(prefix) {
  return `${prefix}_${cryptoLib.randomBytes(12).toString('hex')}`;
}

function registerCrmRoutes(app, pool, verifyAgentAuth, auditChain) {
  const ContactSchema = z.object({
    kind: z.enum(CONTACT_KINDS).optional(),
    name: z.string().min(1).max(300),
    email: z.string().email().optional(),
    phone: z.string().max(60).optional(),
    did_link: z.string().max(300).optional(),
    company: z.string().max(300).optional(),
    title: z.string().max(200).optional(),
    tags: z.array(z.string()).optional(),
    custom_fields: z.record(z.any()).optional()
  });

  app.post('/v1/agents/:did/crm/contacts', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const parse = ContactSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;
      const contactId = genId('cnt');
      await pool.query(
        `INSERT INTO crm_contacts (contact_id, owner_did, kind, name, email, phone,
           did_link, company, title, tags, custom_fields)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)`,
        [contactId, did, d.kind || 'person', d.name, d.email || null, d.phone || null,
         d.did_link || null, d.company || null, d.title || null,
         d.tags || [], JSON.stringify(d.custom_fields || {})]
      );
      await auditChain.append({ event_type: 'crm.contact_created', contact_id: contactId, owner_did: did, timestamp: new Date().toISOString() });
      return res.status(201).json({ contact_id: contactId, owner_did: did, name: d.name });
    } catch (e) {
      console.error('[crm.contact.create]', e);
      return res.status(500).json({ error: 'create_failed', message: e.message });
    }
  });

  app.get('/v1/agents/:did/crm/contacts', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    const tag = req.query.tag;
    const params = [did];
    let sql = `SELECT * FROM crm_contacts WHERE owner_did=$1`;
    if (tag) { params.push(tag); sql += ` AND $${params.length}=ANY(tags)`; }
    params.push(limit);
    sql += ` ORDER BY created_at DESC LIMIT $${params.length}`;
    const r = await pool.query(sql, params).catch(() => ({ rows: [] }));
    return res.json({ contacts: r.rows, count: r.rows.length });
  });

  app.put('/v1/agents/:did/crm/contacts/:id', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const parse = ContactSchema.partial().safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;
      const fields = []; const params = []; let idx = 1;
      for (const [k, v] of Object.entries(d)) {
        if (v === undefined) continue;
        if (k === 'custom_fields') { fields.push(`custom_fields=$${idx++}::jsonb`); params.push(JSON.stringify(v)); }
        else { fields.push(`${k}=$${idx++}`); params.push(v); }
      }
      if (!fields.length) return res.json({ contact_id: req.params.id, unchanged: true });
      params.push(req.params.id, did);
      const r = await pool.query(
        `UPDATE crm_contacts SET ${fields.join(', ')}, updated_at=NOW()
         WHERE contact_id=$${idx++} AND owner_did=$${idx} RETURNING contact_id`,
        params
      ).catch(() => ({ rows: [] }));
      if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
      await auditChain.append({ event_type: 'crm.contact_updated', contact_id: req.params.id, owner_did: did, timestamp: new Date().toISOString() });
      return res.json({ contact_id: req.params.id, updated: true });
    } catch (e) { return res.status(500).json({ error: 'update_failed', message: e.message }); }
  });

  app.delete('/v1/agents/:did/crm/contacts/:id', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(
      `DELETE FROM crm_contacts WHERE contact_id=$1 AND owner_did=$2 RETURNING contact_id`,
      [req.params.id, did]
    ).catch(() => ({ rows: [] }));
    if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
    await pool.query(`DELETE FROM crm_interactions WHERE contact_id=$1`, [req.params.id]).catch(() => {});
    await auditChain.append({ event_type: 'crm.contact_deleted', contact_id: req.params.id, owner_did: did, timestamp: new Date().toISOString() });
    return res.json({ deleted: true });
  });

  const InteractionSchema = z.object({
    kind: z.enum(INTERACTION_KINDS),
    summary: z.string().max(5000).optional(),
    sentiment: z.enum(SENTIMENTS).optional(),
    outcome: z.string().max(500).optional(),
    when_at: z.string().optional()
  });

  app.post('/v1/agents/:did/crm/contacts/:id/interactions', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const parse = InteractionSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;
      const contact = await pool.query(`SELECT contact_id FROM crm_contacts WHERE contact_id=$1 AND owner_did=$2`, [req.params.id, did]).catch(() => ({ rows: [] }));
      if (!contact.rows[0]) return res.status(404).json({ error: 'not_found' });
      const intId = genId('int');
      await pool.query(
        `INSERT INTO crm_interactions (interaction_id, contact_id, owner_did, kind, summary, sentiment, outcome, when_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [intId, req.params.id, did, d.kind, d.summary || null, d.sentiment || null, d.outcome || null, d.when_at || new Date().toISOString()]
      );
      await pool.query(`UPDATE crm_contacts SET last_contacted_at=NOW() WHERE contact_id=$1`, [req.params.id]).catch(() => {});
      await auditChain.append({ event_type: 'crm.interaction_logged', interaction_id: intId, contact_id: req.params.id, owner_did: did, kind: d.kind, timestamp: new Date().toISOString() });
      return res.status(201).json({ interaction_id: intId, contact_id: req.params.id });
    } catch (e) { return res.status(500).json({ error: 'log_failed', message: e.message }); }
  });

  app.get('/v1/agents/:did/crm/contacts/:id/interactions', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(
      `SELECT * FROM crm_interactions WHERE contact_id=$1 AND owner_did=$2 ORDER BY when_at DESC LIMIT 500`,
      [req.params.id, did]
    ).catch(() => ({ rows: [] }));
    return res.json({ interactions: r.rows, count: r.rows.length });
  });

  const DealSchema = z.object({
    contact_id: z.string().optional(),
    name: z.string().min(1).max(300),
    value_cents: z.number().int().min(0).optional(),
    stage: z.enum(DEAL_STAGES).optional(),
    close_date: z.string().optional(),
    probability_pct: z.number().int().min(0).max(100).optional()
  });

  app.post('/v1/agents/:did/crm/deals', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const parse = DealSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;
      const dealId = genId('deal');
      await pool.query(
        `INSERT INTO crm_deals (deal_id, owner_did, contact_id, name, value_cents, stage, close_date, probability_pct)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [dealId, did, d.contact_id || null, d.name, d.value_cents || 0, d.stage || 'prospect', d.close_date || null, d.probability_pct === undefined ? null : d.probability_pct]
      );
      await auditChain.append({ event_type: 'crm.deal_created', deal_id: dealId, owner_did: did, value_cents: d.value_cents || 0, timestamp: new Date().toISOString() });
      return res.status(201).json({ deal_id: dealId, owner_did: did, stage: d.stage || 'prospect' });
    } catch (e) { return res.status(500).json({ error: 'create_failed', message: e.message }); }
  });

  app.get('/v1/agents/:did/crm/deals', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const stage = req.query.stage;
    const params = [did];
    let sql = `SELECT * FROM crm_deals WHERE owner_did=$1`;
    if (stage) { params.push(stage); sql += ` AND stage=$${params.length}`; }
    sql += ` ORDER BY created_at DESC LIMIT 500`;
    const r = await pool.query(sql, params).catch(() => ({ rows: [] }));
    return res.json({ deals: r.rows, count: r.rows.length });
  });

  app.put('/v1/agents/:did/crm/deals/:id', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const parse = DealSchema.partial().safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;
      const fields = []; const params = []; let idx = 1;
      for (const [k, v] of Object.entries(d)) {
        if (v === undefined) continue;
        fields.push(`${k}=$${idx++}`); params.push(v);
      }
      if (!fields.length) return res.json({ deal_id: req.params.id, unchanged: true });
      params.push(req.params.id, did);
      const r = await pool.query(
        `UPDATE crm_deals SET ${fields.join(', ')}, updated_at=NOW()
         WHERE deal_id=$${idx++} AND owner_did=$${idx} RETURNING deal_id, stage`,
        params
      ).catch(() => ({ rows: [] }));
      if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
      await auditChain.append({ event_type: 'crm.deal_updated', deal_id: req.params.id, owner_did: did, stage: r.rows[0].stage, timestamp: new Date().toISOString() });
      return res.json({ deal_id: req.params.id, updated: true, stage: r.rows[0].stage });
    } catch (e) { return res.status(500).json({ error: 'update_failed', message: e.message }); }
  });

  app.get('/v1/agents/:did/crm/deals/pipeline', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(
      `SELECT stage, COUNT(*)::int AS deal_count, COALESCE(SUM(value_cents),0)::bigint AS total_value_cents
       FROM crm_deals WHERE owner_did=$1 GROUP BY stage`,
      [did]
    ).catch(() => ({ rows: [] }));
    const pipeline = {};
    for (const stage of DEAL_STAGES) pipeline[stage] = { deal_count: 0, total_value_cents: 0 };
    for (const row of r.rows) pipeline[row.stage] = { deal_count: row.deal_count, total_value_cents: parseInt(row.total_value_cents) };
    return res.json({ owner_did: did, pipeline });
  });
}

module.exports = { migrate, registerCrmRoutes, CONTACT_KINDS, DEAL_STAGES };
