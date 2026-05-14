// ============================================================================
// OpenHeab Leads — Lead generation + scoring
// ============================================================================
const express = require('express');
const cryptoLib = require('crypto');
const { z } = require('zod');

const LEAD_SOURCES = ['web', 'cold', 'referral', 'event', 'marketplace'];
const LEAD_STATUSES = ['new', 'contacted', 'qualified', 'disqualified', 'converted'];
const ENRICH_PROVIDERS = ['clearbit', 'apollo', 'manual'];

async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS leads (
      lead_id          TEXT PRIMARY KEY,
      owner_did        TEXT NOT NULL,
      name             TEXT,
      email            TEXT,
      phone            TEXT,
      company          TEXT,
      source           TEXT NOT NULL DEFAULT 'web',
      score            INTEGER NOT NULL DEFAULT 0,
      status           TEXT NOT NULL DEFAULT 'new',
      qualification    JSONB DEFAULT '{}'::jsonb,
      contact_id       TEXT,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_touched_at  TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_leads_owner ON leads (owner_did);
    CREATE INDEX IF NOT EXISTS idx_leads_status ON leads (status);
    CREATE INDEX IF NOT EXISTS idx_leads_score ON leads (score DESC);

    CREATE TABLE IF NOT EXISTS lead_lists (
      list_id      TEXT PRIMARY KEY,
      owner_did    TEXT NOT NULL,
      name         TEXT NOT NULL,
      description  TEXT,
      lead_ids     TEXT[] DEFAULT '{}',
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_lead_lists_owner ON lead_lists (owner_did);

    CREATE TABLE IF NOT EXISTS lead_enrichments (
      enrichment_id  TEXT PRIMARY KEY,
      lead_id        TEXT NOT NULL,
      provider       TEXT NOT NULL,
      data           JSONB NOT NULL DEFAULT '{}'::jsonb,
      cost_cents     INTEGER DEFAULT 0,
      enriched_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_lead_enrichments_lead ON lead_enrichments (lead_id);
  `).catch(() => {});
}

function genId(prefix) {
  return `${prefix}_${cryptoLib.randomBytes(12).toString('hex')}`;
}

function scoreFromQualification(q) {
  if (!q || typeof q !== 'object') return 0;
  let score = 0;
  if (q.budget_usd) score += Math.min(40, Math.floor(parseInt(q.budget_usd) / 1000));
  if (q.authority) score += 20;
  if (q.need) score += 20;
  if (q.timeline_days && parseInt(q.timeline_days) <= 30) score += 20;
  if (q.intent === 'high') score += 30;
  if (q.intent === 'medium') score += 15;
  return Math.min(100, score);
}

function registerLeadsRoutes(app, pool, verifyAgentAuth, auditChain) {
  const LeadSchema = z.object({
    name: z.string().max(300).optional(),
    email: z.string().email().optional(),
    phone: z.string().max(60).optional(),
    company: z.string().max(300).optional(),
    source: z.enum(LEAD_SOURCES).optional(),
    score: z.number().int().min(0).max(100).optional(),
    status: z.enum(LEAD_STATUSES).optional(),
    qualification: z.record(z.any()).optional()
  });

  app.post('/v1/agents/:did/leads', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const parse = LeadSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;
      const leadId = genId('lead');
      await pool.query(
        `INSERT INTO leads (lead_id, owner_did, name, email, phone, company, source, score, status, qualification)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`,
        [leadId, did, d.name || null, d.email || null, d.phone || null, d.company || null,
         d.source || 'web', d.score || 0, d.status || 'new', JSON.stringify(d.qualification || {})]
      );
      await auditChain.append({ event_type: 'leads.created', lead_id: leadId, owner_did: did, source: d.source || 'web', timestamp: new Date().toISOString() });
      return res.status(201).json({ lead_id: leadId, owner_did: did, status: d.status || 'new' });
    } catch (e) { return res.status(500).json({ error: 'create_failed', message: e.message }); }
  });

  app.get('/v1/agents/:did/leads', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const params = [did];
    let sql = `SELECT * FROM leads WHERE owner_did=$1`;
    if (req.query.status) { params.push(req.query.status); sql += ` AND status=$${params.length}`; }
    if (req.query.min_score) { params.push(parseInt(req.query.min_score)); sql += ` AND score>=$${params.length}`; }
    sql += ` ORDER BY score DESC, created_at DESC LIMIT 500`;
    const r = await pool.query(sql, params).catch(() => ({ rows: [] }));
    return res.json({ leads: r.rows, count: r.rows.length });
  });

  app.post('/v1/agents/:did/leads/:id/score', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const lead = await pool.query(
        `SELECT lead_id, qualification FROM leads WHERE lead_id=$1 AND owner_did=$2`,
        [req.params.id, did]
      ).catch(() => ({ rows: [] }));
      if (!lead.rows[0]) return res.status(404).json({ error: 'not_found' });
      const override = req.body && req.body.qualification ? req.body.qualification : lead.rows[0].qualification;
      const score = scoreFromQualification(override);
      await pool.query(
        `UPDATE leads SET score=$1, qualification=$2::jsonb, last_touched_at=NOW() WHERE lead_id=$3`,
        [score, JSON.stringify(override || {}), req.params.id]
      );
      await auditChain.append({ event_type: 'leads.scored', lead_id: req.params.id, owner_did: did, score, timestamp: new Date().toISOString() });
      return res.json({ lead_id: req.params.id, score });
    } catch (e) { return res.status(500).json({ error: 'score_failed', message: e.message }); }
  });

  app.post('/v1/agents/:did/leads/:id/enrich', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const body = z.object({
        provider: z.enum(ENRICH_PROVIDERS).optional(),
        data: z.record(z.any()).optional()
      }).safeParse(req.body || {});
      if (!body.success) return res.status(400).json({ error: 'invalid_input' });
      const provider = body.data.provider || 'manual';
      const lead = await pool.query(`SELECT lead_id FROM leads WHERE lead_id=$1 AND owner_did=$2`, [req.params.id, did]).catch(() => ({ rows: [] }));
      if (!lead.rows[0]) return res.status(404).json({ error: 'not_found' });
      // Stub: in real use call provider here
      const data = body.data.data || { stub: true, provider, note: 'connect provider API for live data' };
      const costCents = provider === 'manual' ? 0 : 10;
      const enrId = genId('enr');
      await pool.query(
        `INSERT INTO lead_enrichments (enrichment_id, lead_id, provider, data, cost_cents)
         VALUES ($1,$2,$3,$4::jsonb,$5)`,
        [enrId, req.params.id, provider, JSON.stringify(data), costCents]
      );
      await pool.query(`UPDATE leads SET last_touched_at=NOW() WHERE lead_id=$1`, [req.params.id]).catch(() => {});
      await auditChain.append({ event_type: 'leads.enriched', enrichment_id: enrId, lead_id: req.params.id, owner_did: did, provider, timestamp: new Date().toISOString() });
      return res.status(201).json({ enrichment_id: enrId, lead_id: req.params.id, provider, cost_cents: costCents });
    } catch (e) { return res.status(500).json({ error: 'enrich_failed', message: e.message }); }
  });

  app.post('/v1/agents/:did/leads/:id/convert', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const lead = await pool.query(`SELECT * FROM leads WHERE lead_id=$1 AND owner_did=$2`, [req.params.id, did]).catch(() => ({ rows: [] }));
      if (!lead.rows[0]) return res.status(404).json({ error: 'not_found' });
      const l = lead.rows[0];
      const contactId = genId('cnt');
      await pool.query(
        `INSERT INTO crm_contacts (contact_id, owner_did, kind, name, email, phone, company, custom_fields)
         VALUES ($1,$2,'person',$3,$4,$5,$6,$7::jsonb)
         ON CONFLICT DO NOTHING`,
        [contactId, did, l.name || 'Unknown', l.email || null, l.phone || null, l.company || null,
         JSON.stringify({ converted_from_lead: l.lead_id })]
      ).catch(() => {});
      const dealId = genId('deal');
      const value = (req.body && req.body.value_cents) || 0;
      await pool.query(
        `INSERT INTO crm_deals (deal_id, owner_did, contact_id, name, value_cents, stage)
         VALUES ($1,$2,$3,$4,$5,'prospect')`,
        [dealId, did, contactId, `Deal — ${l.name || l.email || l.company || l.lead_id}`, value]
      ).catch(() => {});
      await pool.query(
        `UPDATE leads SET status='converted', contact_id=$1, last_touched_at=NOW() WHERE lead_id=$2`,
        [contactId, req.params.id]
      );
      await auditChain.append({ event_type: 'leads.converted', lead_id: req.params.id, contact_id: contactId, deal_id: dealId, owner_did: did, timestamp: new Date().toISOString() });
      return res.json({ lead_id: req.params.id, contact_id: contactId, deal_id: dealId, status: 'converted' });
    } catch (e) { return res.status(500).json({ error: 'convert_failed', message: e.message }); }
  });

  app.post('/v1/agents/:did/lead-lists', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const body = z.object({
        name: z.string().min(1).max(300),
        description: z.string().max(2000).optional(),
        lead_ids: z.array(z.string()).optional()
      }).safeParse(req.body || {});
      if (!body.success) return res.status(400).json({ error: 'invalid_input' });
      const listId = genId('llst');
      await pool.query(
        `INSERT INTO lead_lists (list_id, owner_did, name, description, lead_ids)
         VALUES ($1,$2,$3,$4,$5)`,
        [listId, did, body.data.name, body.data.description || null, body.data.lead_ids || []]
      );
      await auditChain.append({ event_type: 'leads.list_created', list_id: listId, owner_did: did, timestamp: new Date().toISOString() });
      return res.status(201).json({ list_id: listId, owner_did: did, name: body.data.name });
    } catch (e) { return res.status(500).json({ error: 'create_failed', message: e.message }); }
  });

  app.get('/v1/agents/:did/lead-lists', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(
      `SELECT * FROM lead_lists WHERE owner_did=$1 ORDER BY created_at DESC`, [did]
    ).catch(() => ({ rows: [] }));
    return res.json({ lists: r.rows, count: r.rows.length });
  });
}

module.exports = { migrate, registerLeadsRoutes, LEAD_SOURCES, LEAD_STATUSES, scoreFromQualification };
