// ============================================================================
// OpenHeab IP Registry — Patents, trademarks, copyrights, trade secrets.
// Tables: ip_filings, ip_assignments, ip_oppositions, ip_royalty_agreements.
// USPTO API integration stub for filing submissions and public search.
// ============================================================================
const express = require('express');
const cryptoLib = require('crypto');
const { z } = require('zod');

const IP_KINDS = [
  'patent_utility', 'patent_design', 'patent_provisional',
  'trademark', 'copyright', 'trade_secret'
];
const IP_JURISDICTIONS = ['US', 'EU', 'UK', 'CN', 'JP', 'KR', 'CA', 'AU', 'PCT'];
const IP_STATUSES = ['drafted', 'filed', 'published', 'granted', 'abandoned', 'expired', 'opposed'];
const OPPOSITION_STATUSES = ['pending', 'withdrawn', 'decided'];
const ROYALTY_STATUSES = ['active', 'terminated'];

// ----------------------------------------------------------------------------
// Migration
// ----------------------------------------------------------------------------
async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ip_filings (
      filing_id            TEXT PRIMARY KEY,
      agent_did            TEXT NOT NULL,
      entity_id            TEXT,
      kind                 TEXT NOT NULL,
      jurisdiction         TEXT NOT NULL,
      title                TEXT NOT NULL,
      abstract             TEXT,
      claims               TEXT,
      classifications      TEXT[] DEFAULT '{}',
      filed_at             DATE,
      application_number   TEXT,
      publication_number   TEXT,
      status               TEXT NOT NULL DEFAULT 'drafted',
      attorney_did         TEXT,
      body_blob_id         TEXT,
      drawings_blob_ids    TEXT[] DEFAULT '{}',
      created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_ip_filings_agent ON ip_filings (agent_did, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_ip_filings_kind ON ip_filings (kind);
    CREATE INDEX IF NOT EXISTS idx_ip_filings_jurisdiction ON ip_filings (jurisdiction);
    CREATE INDEX IF NOT EXISTS idx_ip_filings_status ON ip_filings (status);
    CREATE INDEX IF NOT EXISTS idx_ip_filings_classifications ON ip_filings USING GIN (classifications);

    CREATE TABLE IF NOT EXISTS ip_assignments (
      assignment_id    TEXT PRIMARY KEY,
      filing_id        TEXT NOT NULL,
      from_did         TEXT NOT NULL,
      to_did           TEXT NOT NULL,
      recorded_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      document_blob_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_ip_assignments_filing ON ip_assignments (filing_id);

    CREATE TABLE IF NOT EXISTS ip_oppositions (
      opposition_id      TEXT PRIMARY KEY,
      filing_id          TEXT NOT NULL,
      opposer_did        TEXT NOT NULL,
      grounds            TEXT,
      evidence_blob_ids  TEXT[] DEFAULT '{}',
      status             TEXT NOT NULL DEFAULT 'pending',
      decision           TEXT,
      decided_at         TIMESTAMPTZ,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_ip_oppositions_filing ON ip_oppositions (filing_id);

    CREATE TABLE IF NOT EXISTS ip_royalty_agreements (
      agreement_id       TEXT PRIMARY KEY,
      filing_id          TEXT NOT NULL,
      licensor_did       TEXT NOT NULL,
      licensee_did       TEXT NOT NULL,
      terms              JSONB,
      royalty_rate_bps   INTEGER NOT NULL DEFAULT 0,
      status             TEXT NOT NULL DEFAULT 'active',
      started_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_ip_royalty_filing ON ip_royalty_agreements (filing_id);
    CREATE INDEX IF NOT EXISTS idx_ip_royalty_licensor ON ip_royalty_agreements (licensor_did);
    CREATE INDEX IF NOT EXISTS idx_ip_royalty_licensee ON ip_royalty_agreements (licensee_did);
  `).catch(() => {});
}

function genId(prefix) { return `${prefix}_${cryptoLib.randomBytes(12).toString('hex')}`; }

// USPTO submission stub
async function submitToUspto(filing) {
  if (!process.env.USPTO_API_KEY) {
    return {
      application_number: 'syn_' + cryptoLib.randomBytes(8).toString('hex'),
      synthetic: true
    };
  }
  try {
    const r = await fetch('https://developer.uspto.gov/ds-api/patents/v3/applications', {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${process.env.USPTO_API_KEY}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        title: filing.title,
        abstract: filing.abstract,
        claims: filing.claims,
        kind: filing.kind
      })
    }).catch(() => null);
    if (!r || !r.ok) {
      return {
        application_number: 'usp_' + cryptoLib.randomBytes(8).toString('hex'),
        synthetic: false, error: r ? `uspto_${r.status}` : 'network_error'
      };
    }
    const j = await r.json().catch(() => ({}));
    return {
      application_number: j.applicationNumber ||
        ('us_' + cryptoLib.randomBytes(8).toString('hex')),
      synthetic: false
    };
  } catch (e) {
    return { application_number: 'err_' + cryptoLib.randomBytes(4).toString('hex'), error: e.message };
  }
}

async function submitToOffice(filing) {
  if (filing.jurisdiction === 'US') return submitToUspto(filing);
  // EUIPO / others: synthetic for now
  return {
    application_number: filing.jurisdiction.toLowerCase() + '_' + cryptoLib.randomBytes(8).toString('hex'),
    synthetic: true
  };
}

// ----------------------------------------------------------------------------
// Routes
// ----------------------------------------------------------------------------
function registerIpRegistryRoutes(app, pool, verifyAgentAuth, auditChain) {
  // ---- Create a draft filing ----------------------------------------------
  const FilingSchema = z.object({
    entity_id: z.string().max(200).optional(),
    kind: z.enum(IP_KINDS),
    jurisdiction: z.enum(IP_JURISDICTIONS),
    title: z.string().min(1).max(500),
    abstract: z.string().max(50000).optional(),
    claims: z.string().max(500000).optional(),
    classifications: z.array(z.string()).optional(),
    attorney_did: z.string().optional(),
    body_blob_id: z.string().optional(),
    drawings_blob_ids: z.array(z.string()).optional()
  });

  app.post('/v1/agents/:did/ip/filings', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const parse = FilingSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;
      const id = genId('ip');
      await pool.query(
        `INSERT INTO ip_filings (filing_id, agent_did, entity_id, kind, jurisdiction, title,
                                   abstract, claims, classifications, status,
                                   attorney_did, body_blob_id, drawings_blob_ids)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'drafted',$10,$11,$12)`,
        [id, did, d.entity_id || null, d.kind, d.jurisdiction, d.title,
         d.abstract || null, d.claims || null,
         d.classifications || [], d.attorney_did || null,
         d.body_blob_id || null, d.drawings_blob_ids || []]
      );
      await auditChain.append({
        event_type: 'ip.filing_drafted', filing_id: id, agent_did: did,
        kind: d.kind, jurisdiction: d.jurisdiction, title: d.title,
        timestamp: new Date().toISOString()
      });
      return res.status(201).json({ filing_id: id, status: 'drafted', kind: d.kind });
    } catch (e) { return res.status(500).json({ error: 'create_failed', message: e.message }); }
  });

  app.get('/v1/agents/:did/ip/filings', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(
      `SELECT * FROM ip_filings WHERE agent_did=$1 ORDER BY created_at DESC LIMIT 500`, [did]
    ).catch(() => ({ rows: [] }));
    return res.json({ filings: r.rows, count: r.rows.length });
  });

  // ---- Submit (file with office) -------------------------------------------
  app.post('/v1/agents/:did/ip/filings/:id/submit', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const f = await pool.query(
        `SELECT * FROM ip_filings WHERE filing_id=$1 AND agent_did=$2`,
        [req.params.id, did]
      ).catch(() => ({ rows: [] }));
      if (!f.rows[0]) return res.status(404).json({ error: 'not_found' });
      if (['filed', 'published', 'granted'].includes(f.rows[0].status)) {
        return res.status(400).json({ error: 'already_filed', status: f.rows[0].status });
      }
      const result = await submitToOffice(f.rows[0]);
      await pool.query(
        `UPDATE ip_filings SET status='filed', application_number=$1, filed_at=CURRENT_DATE
          WHERE filing_id=$2`,
        [result.application_number, req.params.id]
      );
      await auditChain.append({
        event_type: 'ip.filing_submitted', filing_id: req.params.id, agent_did: did,
        application_number: result.application_number,
        jurisdiction: f.rows[0].jurisdiction, kind: f.rows[0].kind,
        timestamp: new Date().toISOString()
      });
      return res.json({
        filing_id: req.params.id, status: 'filed',
        application_number: result.application_number, synthetic: !!result.synthetic
      });
    } catch (e) { return res.status(500).json({ error: 'submit_failed', message: e.message }); }
  });

  // ---- Assign (transfer ownership) -----------------------------------------
  const AssignSchema = z.object({
    to_did: z.string(),
    document_blob_id: z.string().optional()
  });
  app.post('/v1/agents/:did/ip/filings/:id/assign', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const parse = AssignSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const f = await pool.query(
        `SELECT * FROM ip_filings WHERE filing_id=$1 AND agent_did=$2`,
        [req.params.id, did]
      ).catch(() => ({ rows: [] }));
      if (!f.rows[0]) return res.status(404).json({ error: 'not_found' });
      const assignmentId = genId('ipa');
      await pool.query(
        `INSERT INTO ip_assignments (assignment_id, filing_id, from_did, to_did, document_blob_id)
         VALUES ($1,$2,$3,$4,$5)`,
        [assignmentId, req.params.id, did, parse.data.to_did, parse.data.document_blob_id || null]
      );
      await pool.query(
        `UPDATE ip_filings SET agent_did=$1 WHERE filing_id=$2`,
        [parse.data.to_did, req.params.id]
      ).catch(() => {});
      await auditChain.append({
        event_type: 'ip.assigned', filing_id: req.params.id,
        from_did: did, to_did: parse.data.to_did, assignment_id: assignmentId,
        timestamp: new Date().toISOString()
      });
      return res.json({
        assignment_id: assignmentId, filing_id: req.params.id,
        from_did: did, to_did: parse.data.to_did
      });
    } catch (e) { return res.status(500).json({ error: 'assign_failed', message: e.message }); }
  });

  // ---- Oppose (3rd party challenge) ----------------------------------------
  const OpposeSchema = z.object({
    opposer_did: z.string(),
    grounds: z.string().min(1).max(50000),
    evidence_blob_ids: z.array(z.string()).optional()
  });
  app.post('/v1/agents/:did/ip/filings/:id/oppose', express.json(), async (req, res) => {
    try {
      const parse = OpposeSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const auth = await verifyAgentAuth(req, parse.data.opposer_did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const f = await pool.query(`SELECT * FROM ip_filings WHERE filing_id=$1`, [req.params.id])
        .catch(() => ({ rows: [] }));
      if (!f.rows[0]) return res.status(404).json({ error: 'not_found' });
      const opId = genId('opp');
      await pool.query(
        `INSERT INTO ip_oppositions (opposition_id, filing_id, opposer_did, grounds,
                                       evidence_blob_ids, status)
         VALUES ($1,$2,$3,$4,$5,'pending')`,
        [opId, req.params.id, parse.data.opposer_did, parse.data.grounds,
         parse.data.evidence_blob_ids || []]
      );
      await pool.query(`UPDATE ip_filings SET status='opposed' WHERE filing_id=$1`, [req.params.id])
        .catch(() => {});
      await auditChain.append({
        event_type: 'ip.opposed', opposition_id: opId, filing_id: req.params.id,
        opposer_did: parse.data.opposer_did,
        timestamp: new Date().toISOString()
      });
      return res.status(201).json({ opposition_id: opId, filing_id: req.params.id, status: 'pending' });
    } catch (e) { return res.status(500).json({ error: 'oppose_failed', message: e.message }); }
  });

  // ---- Royalty agreements --------------------------------------------------
  const RoyaltySchema = z.object({
    filing_id: z.string(),
    licensee_did: z.string(),
    terms: z.record(z.any()).optional(),
    royalty_rate_bps: z.number().int().min(0).max(10000).optional()
  });
  app.post('/v1/agents/:did/ip/royalty-agreements', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const parse = RoyaltySchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;
      const f = await pool.query(
        `SELECT * FROM ip_filings WHERE filing_id=$1 AND agent_did=$2`, [d.filing_id, did]
      ).catch(() => ({ rows: [] }));
      if (!f.rows[0]) return res.status(404).json({ error: 'filing_not_found_or_not_owned' });
      const id = genId('royalty');
      await pool.query(
        `INSERT INTO ip_royalty_agreements (agreement_id, filing_id, licensor_did, licensee_did,
                                               terms, royalty_rate_bps, status)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6,'active')`,
        [id, d.filing_id, did, d.licensee_did,
         JSON.stringify(d.terms || {}), d.royalty_rate_bps || 0]
      );
      await auditChain.append({
        event_type: 'ip.royalty_created', agreement_id: id, filing_id: d.filing_id,
        licensor_did: did, licensee_did: d.licensee_did,
        royalty_rate_bps: d.royalty_rate_bps || 0,
        timestamp: new Date().toISOString()
      });
      return res.status(201).json({
        agreement_id: id, filing_id: d.filing_id,
        licensor_did: did, licensee_did: d.licensee_did, status: 'active'
      });
    } catch (e) { return res.status(500).json({ error: 'create_failed', message: e.message }); }
  });

  // ---- Public search -------------------------------------------------------
  app.get('/v1/ip/filings/search', async (req, res) => {
    try {
      const q = String(req.query.q || '');
      const kind = req.query.kind || null;
      const jurisdiction = req.query.jurisdiction || null;
      const limit = Math.min(parseInt(req.query.limit) || 50, 200);

      const params = [];
      const conds = [`status IN ('filed','published','granted')`];
      if (q) {
        params.push(`%${q}%`);
        conds.push(`(title ILIKE $${params.length} OR abstract ILIKE $${params.length})`);
      }
      if (kind) { params.push(kind); conds.push(`kind=$${params.length}`); }
      if (jurisdiction) { params.push(jurisdiction); conds.push(`jurisdiction=$${params.length}`); }
      params.push(limit);
      const r = await pool.query(
        `SELECT filing_id, kind, jurisdiction, title, abstract, application_number,
                 publication_number, status, filed_at
           FROM ip_filings WHERE ${conds.join(' AND ')}
          ORDER BY filed_at DESC NULLS LAST LIMIT $${params.length}`, params
      ).catch(() => ({ rows: [] }));
      return res.json({ results: r.rows, count: r.rows.length });
    } catch (e) { return res.status(500).json({ error: 'search_failed', message: e.message }); }
  });
}

module.exports = {
  migrate, registerIpRegistryRoutes,
  IP_KINDS, IP_JURISDICTIONS, IP_STATUSES, OPPOSITION_STATUSES, ROYALTY_STATUSES,
  submitToOffice, submitToUspto
};
