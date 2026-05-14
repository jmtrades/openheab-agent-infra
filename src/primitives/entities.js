// ============================================================================
// OpenHeab Entities — Legal entity records (LLC, C-Corp, GmbH, DAO, etc)
// ============================================================================
const express = require('express');
const cryptoLib = require('crypto');
const { z } = require('zod');

const ENTITY_TYPES = [
  'llc', 'c-corp', 'c-corp-de', 'plc', 'gmbh', 'sarl', 'ltd', 'foundation',
  'cayman-foundation', 'dao', 'sole-prop', 'partnership', 'cooperative',
  'series-llc', 'trust'
];

const STATUSES = ['draft', 'pending_formation', 'active', 'dissolved', 'lapsed'];

const OFFICER_ROLES = ['founder', 'officer', 'director', 'member', 'beneficial-owner'];

const FORMATION_PARTNERS = ['stripe_atlas', 'doola', 'firstbase', 'manual'];

// ----------------------------------------------------------------------------
// Migration
// ----------------------------------------------------------------------------
async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS legal_entities (
      entity_id          TEXT PRIMARY KEY,
      controlling_did    TEXT NOT NULL,
      name               TEXT NOT NULL,
      entity_type        TEXT NOT NULL,
      jurisdiction       TEXT,
      formation_state    TEXT,
      ein                TEXT,
      vat_number         TEXT,
      registered_agent   TEXT,
      registered_address TEXT,
      formation_date     DATE,
      status             TEXT NOT NULL DEFAULT 'draft',
      formation_partner  TEXT,
      partner_ref        TEXT,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_legal_entities_controller ON legal_entities (controlling_did);
    CREATE INDEX IF NOT EXISTS idx_legal_entities_status ON legal_entities (status);

    CREATE TABLE IF NOT EXISTS entity_officers (
      officer_id      TEXT PRIMARY KEY,
      entity_id       TEXT NOT NULL,
      role            TEXT NOT NULL,
      name            TEXT NOT NULL,
      did             TEXT,
      ownership_pct   NUMERIC(5,2),
      title           TEXT,
      added_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_entity_officers_entity ON entity_officers (entity_id);

    CREATE TABLE IF NOT EXISTS entity_documents (
      document_id     TEXT PRIMARY KEY,
      entity_id       TEXT NOT NULL,
      kind            TEXT NOT NULL,
      title           TEXT,
      url             TEXT,
      checksum        TEXT,
      uploaded_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_entity_documents_entity ON entity_documents (entity_id);
  `).catch(() => {});
}

function genId(prefix) {
  return `${prefix}_${cryptoLib.randomBytes(12).toString('hex')}`;
}

// ----------------------------------------------------------------------------
// Routes
// ----------------------------------------------------------------------------
function registerEntitiesRoutes(app, pool, verifyAgentAuth, auditChain) {
  // POST /v1/agents/:did/entities
  const CreateSchema = z.object({
    name: z.string().min(1).max(200),
    entity_type: z.enum(ENTITY_TYPES),
    jurisdiction: z.string().max(100).optional(),
    formation_state: z.string().max(100).optional(),
    ein: z.string().max(40).optional(),
    vat_number: z.string().max(40).optional(),
    registered_agent: z.string().max(200).optional(),
    registered_address: z.string().max(500).optional(),
    formation_date: z.string().optional(),
    status: z.enum(STATUSES).optional(),
    formation_partner: z.enum(FORMATION_PARTNERS).optional(),
    partner_ref: z.string().max(200).optional()
  });

  app.post('/v1/agents/:did/entities', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const parse = CreateSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;

      const entityId = genId('ent');
      await pool.query(
        `INSERT INTO legal_entities (entity_id, controlling_did, name, entity_type,
           jurisdiction, formation_state, ein, vat_number, registered_agent,
           registered_address, formation_date, status, formation_partner, partner_ref)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [entityId, did, d.name, d.entity_type, d.jurisdiction || null,
         d.formation_state || null, d.ein || null, d.vat_number || null,
         d.registered_agent || null, d.registered_address || null,
         d.formation_date || null, d.status || 'draft',
         d.formation_partner || null, d.partner_ref || null]
      );

      await auditChain.append({
        event_type: 'entities.created',
        entity_id: entityId, controlling_did: did, entity_type: d.entity_type,
        timestamp: new Date().toISOString()
      });

      return res.status(201).json({
        entity_id: entityId, controlling_did: did,
        name: d.name, entity_type: d.entity_type, status: d.status || 'draft'
      });
    } catch (e) {
      console.error('[entities.create]', e);
      return res.status(500).json({ error: 'create_failed', message: e.message });
    }
  });

  // GET /v1/agents/:did/entities
  app.get('/v1/agents/:did/entities', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(
      `SELECT entity_id, name, entity_type, jurisdiction, formation_state,
              ein, status, formation_partner, created_at
       FROM legal_entities WHERE controlling_did=$1 ORDER BY created_at DESC`,
      [did]
    ).catch(() => ({ rows: [] }));
    return res.json({ entities: r.rows, count: r.rows.length });
  });

  // PATCH /v1/agents/:did/entities/:id
  const PatchSchema = z.object({
    name: z.string().max(200).optional(),
    jurisdiction: z.string().max(100).optional(),
    formation_state: z.string().max(100).optional(),
    ein: z.string().max(40).optional(),
    vat_number: z.string().max(40).optional(),
    registered_agent: z.string().max(200).optional(),
    registered_address: z.string().max(500).optional(),
    formation_date: z.string().optional(),
    status: z.enum(STATUSES).optional(),
    formation_partner: z.enum(FORMATION_PARTNERS).optional(),
    partner_ref: z.string().max(200).optional()
  });

  app.patch('/v1/agents/:did/entities/:id', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const exists = await pool.query(
        `SELECT entity_id FROM legal_entities WHERE entity_id=$1 AND controlling_did=$2`,
        [req.params.id, did]
      ).catch(() => ({ rows: [] }));
      if (!exists.rows[0]) return res.status(404).json({ error: 'not_found' });

      const parse = PatchSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;

      const fields = [];
      const params = [];
      let idx = 1;
      for (const [k, v] of Object.entries(d)) {
        if (v === undefined) continue;
        fields.push(`${k} = $${idx++}`);
        params.push(v);
      }
      if (!fields.length) return res.json({ entity_id: req.params.id, unchanged: true });
      params.push(req.params.id, did);
      await pool.query(
        `UPDATE legal_entities SET ${fields.join(', ')}, updated_at=NOW()
         WHERE entity_id=$${idx++} AND controlling_did=$${idx}`,
        params
      );

      await auditChain.append({
        event_type: 'entities.updated',
        entity_id: req.params.id, controlling_did: did,
        fields: Object.keys(d), timestamp: new Date().toISOString()
      });

      return res.json({ entity_id: req.params.id, updated: true });
    } catch (e) {
      console.error('[entities.update]', e);
      return res.status(500).json({ error: 'update_failed', message: e.message });
    }
  });

  // DELETE /v1/agents/:did/entities/:id
  app.delete('/v1/agents/:did/entities/:id', async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const r = await pool.query(
        `DELETE FROM legal_entities WHERE entity_id=$1 AND controlling_did=$2 RETURNING entity_id`,
        [req.params.id, did]
      ).catch(() => ({ rows: [] }));
      if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
      await pool.query(`DELETE FROM entity_officers WHERE entity_id=$1`, [req.params.id]).catch(() => {});
      await pool.query(`DELETE FROM entity_documents WHERE entity_id=$1`, [req.params.id]).catch(() => {});
      await auditChain.append({
        event_type: 'entities.deleted',
        entity_id: req.params.id, controlling_did: did,
        timestamp: new Date().toISOString()
      });
      return res.json({ deleted: true, entity_id: req.params.id });
    } catch (e) {
      console.error('[entities.delete]', e);
      return res.status(500).json({ error: 'delete_failed', message: e.message });
    }
  });

  // POST /v1/entities/:id/officers
  const OfficerSchema = z.object({
    actor_did: z.string(),
    role: z.enum(OFFICER_ROLES),
    name: z.string().min(1).max(200),
    did: z.string().optional(),
    ownership_pct: z.number().min(0).max(100).optional(),
    title: z.string().max(200).optional()
  });

  app.post('/v1/entities/:id/officers', express.json(), async (req, res) => {
    try {
      const parse = OfficerSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;

      const ent = await pool.query(
        `SELECT controlling_did FROM legal_entities WHERE entity_id=$1`, [req.params.id]
      ).catch(() => ({ rows: [] }));
      if (!ent.rows[0]) return res.status(404).json({ error: 'not_found' });

      const auth = await verifyAgentAuth(req, ent.rows[0].controlling_did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const officerId = genId('off');
      await pool.query(
        `INSERT INTO entity_officers (officer_id, entity_id, role, name, did,
           ownership_pct, title)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [officerId, req.params.id, d.role, d.name, d.did || null,
         d.ownership_pct === undefined ? null : d.ownership_pct, d.title || null]
      );

      await auditChain.append({
        event_type: 'entities.officer_added',
        entity_id: req.params.id, officer_id: officerId, role: d.role,
        timestamp: new Date().toISOString()
      });

      return res.status(201).json({
        officer_id: officerId, entity_id: req.params.id,
        role: d.role, name: d.name
      });
    } catch (e) {
      console.error('[entities.officer.add]', e);
      return res.status(500).json({ error: 'add_failed', message: e.message });
    }
  });

  // GET /v1/entities/:id/officers
  app.get('/v1/entities/:id/officers', async (req, res) => {
    const r = await pool.query(
      `SELECT officer_id, role, name, did, ownership_pct, title, added_at
       FROM entity_officers WHERE entity_id=$1 ORDER BY added_at ASC`,
      [req.params.id]
    ).catch(() => ({ rows: [] }));
    return res.json({ officers: r.rows, count: r.rows.length });
  });

  // POST /v1/entities/:id/documents
  const DocSchema = z.object({
    kind: z.string().min(1).max(80),
    title: z.string().max(200).optional(),
    url: z.string().url().optional(),
    checksum: z.string().optional()
  });

  app.post('/v1/entities/:id/documents', express.json(), async (req, res) => {
    try {
      const parse = DocSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;

      const ent = await pool.query(
        `SELECT controlling_did FROM legal_entities WHERE entity_id=$1`, [req.params.id]
      ).catch(() => ({ rows: [] }));
      if (!ent.rows[0]) return res.status(404).json({ error: 'not_found' });

      const auth = await verifyAgentAuth(req, ent.rows[0].controlling_did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const docId = genId('edoc');
      await pool.query(
        `INSERT INTO entity_documents (document_id, entity_id, kind, title, url, checksum)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [docId, req.params.id, d.kind, d.title || null, d.url || null, d.checksum || null]
      );

      await auditChain.append({
        event_type: 'entities.document_added',
        entity_id: req.params.id, document_id: docId, kind: d.kind,
        timestamp: new Date().toISOString()
      });

      return res.status(201).json({
        document_id: docId, entity_id: req.params.id, kind: d.kind
      });
    } catch (e) {
      console.error('[entities.document.add]', e);
      return res.status(500).json({ error: 'add_failed', message: e.message });
    }
  });
}

module.exports = {
  migrate,
  registerEntitiesRoutes,
  ENTITY_TYPES,
  STATUSES
};
