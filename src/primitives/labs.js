// ============================================================================
// OpenHeab Labs — Scientific computation primitives.
// Protein folding (AlphaFold/Rosetta), molecular dynamics (GROMACS/OpenMM),
// drug screening, genomic analysis, imaging. Datasets, protocols, publications.
// ============================================================================
const express = require('express');
const cryptoLib = require('crypto');
const { z } = require('zod');

const EXPERIMENT_KINDS = ['protein_folding', 'molecular_dynamics', 'drug_screen', 'genomic_analysis', 'imaging', 'other'];
const EXPERIMENT_STATUSES = ['queued', 'running', 'complete', 'failed'];
const PROVIDERS = ['alphafold', 'rosetta', 'gromacs', 'openmm', 'local'];
const DATASET_KINDS = ['sequence', 'structure', 'expression', 'imaging'];
const DATASET_FORMATS = ['fasta', 'pdb', 'csv', 'h5', 'imaging'];
const PROTOCOL_KINDS = ['wetlab', 'dry', 'hybrid'];
const PUBLICATION_STATUSES = ['drafted', 'preprinted', 'peer_review', 'published'];

// Approximate cost per kind (cents per run)
const EXPERIMENT_COST_CENTS = {
  protein_folding: 200,
  molecular_dynamics: 500,
  drug_screen: 1000,
  genomic_analysis: 150,
  imaging: 100,
  other: 50
};

// ----------------------------------------------------------------------------
// Migration
// ----------------------------------------------------------------------------
async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS lab_experiments (
      experiment_id        TEXT PRIMARY KEY,
      agent_did            TEXT NOT NULL,
      kind                 TEXT NOT NULL,
      inputs               JSONB,
      parameters           JSONB,
      status               TEXT NOT NULL DEFAULT 'queued',
      provider             TEXT,
      compute_instance_id  TEXT,
      output_blob_id       TEXT,
      result_summary       JSONB,
      cost_cents           BIGINT NOT NULL DEFAULT 0,
      started_at           TIMESTAMPTZ,
      completed_at         TIMESTAMPTZ,
      created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_lab_experiments_agent ON lab_experiments (agent_did, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_lab_experiments_status ON lab_experiments (status);

    CREATE TABLE IF NOT EXISTS lab_datasets (
      dataset_id       TEXT PRIMARY KEY,
      agent_did        TEXT NOT NULL,
      name             TEXT NOT NULL,
      kind             TEXT NOT NULL,
      format           TEXT NOT NULL,
      size_bytes       BIGINT NOT NULL DEFAULT 0,
      storage_blob_id  TEXT,
      schema           JSONB,
      source           TEXT,
      public           BOOLEAN NOT NULL DEFAULT FALSE,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_lab_datasets_agent ON lab_datasets (agent_did, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_lab_datasets_public ON lab_datasets (public) WHERE public = TRUE;

    CREATE TABLE IF NOT EXISTS lab_protocols (
      protocol_id  TEXT PRIMARY KEY,
      agent_did    TEXT NOT NULL,
      name         TEXT NOT NULL,
      version      TEXT NOT NULL DEFAULT '1.0.0',
      kind         TEXT NOT NULL,
      body         TEXT NOT NULL,
      citations    JSONB,
      public       BOOLEAN NOT NULL DEFAULT FALSE,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_lab_protocols_agent ON lab_protocols (agent_did, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_lab_protocols_public ON lab_protocols (public) WHERE public = TRUE;

    CREATE TABLE IF NOT EXISTS lab_publications (
      publication_id  TEXT PRIMARY KEY,
      agent_did       TEXT NOT NULL,
      experiment_ids  TEXT[] DEFAULT '{}',
      title           TEXT NOT NULL,
      abstract        TEXT,
      body            TEXT,
      doi             TEXT,
      preprint_url    TEXT,
      status          TEXT NOT NULL DEFAULT 'drafted',
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_lab_publications_agent ON lab_publications (agent_did, created_at DESC);
  `).catch(() => {});
}

function genId(prefix) { return `${prefix}_${cryptoLib.randomBytes(12).toString('hex')}`; }

async function recordCostSafe(pool, opts, auditChain) {
  try {
    const cost = require('./cost');
    return await cost.recordCost(pool, { ...opts, auditChain });
  } catch (e) {
    return null;
  }
}

// ----------------------------------------------------------------------------
// Routes
// ----------------------------------------------------------------------------
function registerLabsRoutes(app, pool, verifyAgentAuth, auditChain) {
  // ---- Experiments --------------------------------------------------------
  const ExperimentSchema = z.object({
    kind: z.enum(EXPERIMENT_KINDS),
    inputs: z.record(z.any()).optional(),
    parameters: z.record(z.any()).optional(),
    provider: z.enum(PROVIDERS).optional(),
    compute_instance_id: z.string().optional()
  });

  app.post('/v1/agents/:did/labs/experiments', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const parse = ExperimentSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;
      const id = genId('exp');
      const costCents = EXPERIMENT_COST_CENTS[d.kind] ?? 50;
      const provider = d.provider || (d.kind === 'protein_folding' ? 'alphafold'
        : d.kind === 'molecular_dynamics' ? 'gromacs'
        : 'local');
      await pool.query(
        `INSERT INTO lab_experiments (experiment_id, agent_did, kind, inputs, parameters,
                                       status, provider, compute_instance_id, cost_cents,
                                       started_at)
         VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,'queued',$6,$7,$8,NOW())`,
        [id, did, d.kind, JSON.stringify(d.inputs || {}),
         JSON.stringify(d.parameters || {}), provider,
         d.compute_instance_id || null, costCents]
      );
      // Charge for the experiment
      await recordCostSafe(pool, {
        agent_did: did, resource_type: 'lab_experiment', provider,
        amount_cents: costCents, reference_id: id,
        tags: { kind: d.kind }
      }, auditChain);
      await auditChain.append({
        event_type: 'labs.experiment_queued', experiment_id: id, agent_did: did,
        kind: d.kind, provider, cost_cents: costCents,
        timestamp: new Date().toISOString()
      });
      return res.status(201).json({
        experiment_id: id, kind: d.kind, status: 'queued', provider, cost_cents: costCents
      });
    } catch (e) { return res.status(500).json({ error: 'create_failed', message: e.message }); }
  });

  app.get('/v1/agents/:did/labs/experiments/:id', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(
      `SELECT * FROM lab_experiments WHERE experiment_id=$1 AND agent_did=$2`,
      [req.params.id, did]
    ).catch(() => ({ rows: [] }));
    if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
    return res.json(r.rows[0]);
  });

  app.get('/v1/agents/:did/labs/experiments', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(
      `SELECT * FROM lab_experiments WHERE agent_did=$1 ORDER BY created_at DESC LIMIT 500`, [did]
    ).catch(() => ({ rows: [] }));
    return res.json({ experiments: r.rows, count: r.rows.length });
  });

  // ---- Datasets -----------------------------------------------------------
  const DatasetSchema = z.object({
    name: z.string().min(1).max(300),
    kind: z.enum(DATASET_KINDS),
    format: z.enum(DATASET_FORMATS),
    size_bytes: z.number().int().min(0).optional(),
    storage_blob_id: z.string().optional(),
    schema: z.record(z.any()).optional(),
    source: z.string().max(500).optional(),
    public: z.boolean().optional()
  });

  app.post('/v1/agents/:did/labs/datasets', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const parse = DatasetSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;
      const id = genId('lds');
      await pool.query(
        `INSERT INTO lab_datasets (dataset_id, agent_did, name, kind, format, size_bytes,
                                     storage_blob_id, schema, source, public)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10)`,
        [id, did, d.name, d.kind, d.format, d.size_bytes || 0,
         d.storage_blob_id || null, JSON.stringify(d.schema || {}),
         d.source || null, !!d.public]
      );
      await auditChain.append({
        event_type: 'labs.dataset_created', dataset_id: id, agent_did: did,
        kind: d.kind, public: !!d.public,
        timestamp: new Date().toISOString()
      });
      return res.status(201).json({ dataset_id: id, name: d.name, public: !!d.public });
    } catch (e) { return res.status(500).json({ error: 'create_failed', message: e.message }); }
  });

  app.get('/v1/labs/datasets/public', async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    const r = await pool.query(
      `SELECT * FROM lab_datasets WHERE public=TRUE ORDER BY created_at DESC LIMIT $1`, [limit]
    ).catch(() => ({ rows: [] }));
    return res.json({ datasets: r.rows, count: r.rows.length });
  });

  // ---- Protocols ----------------------------------------------------------
  const ProtocolSchema = z.object({
    name: z.string().min(1).max(300),
    version: z.string().max(20).optional(),
    kind: z.enum(PROTOCOL_KINDS),
    body: z.string().min(1).max(200000),
    citations: z.array(z.record(z.any())).optional(),
    public: z.boolean().optional()
  });

  app.post('/v1/agents/:did/labs/protocols', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const parse = ProtocolSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;
      const id = genId('proto');
      await pool.query(
        `INSERT INTO lab_protocols (protocol_id, agent_did, name, version, kind, body, citations, public)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`,
        [id, did, d.name, d.version || '1.0.0', d.kind, d.body,
         JSON.stringify(d.citations || []), !!d.public]
      );
      await auditChain.append({
        event_type: 'labs.protocol_created', protocol_id: id, agent_did: did,
        name: d.name, kind: d.kind, public: !!d.public,
        timestamp: new Date().toISOString()
      });
      return res.status(201).json({ protocol_id: id, name: d.name, version: d.version || '1.0.0' });
    } catch (e) { return res.status(500).json({ error: 'create_failed', message: e.message }); }
  });

  app.get('/v1/labs/protocols/public', async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    const r = await pool.query(
      `SELECT * FROM lab_protocols WHERE public=TRUE ORDER BY created_at DESC LIMIT $1`, [limit]
    ).catch(() => ({ rows: [] }));
    return res.json({ protocols: r.rows, count: r.rows.length });
  });

  // ---- Publications -------------------------------------------------------
  const PublicationSchema = z.object({
    experiment_ids: z.array(z.string()).optional(),
    title: z.string().min(1).max(500),
    abstract: z.string().max(20000).optional(),
    body: z.string().max(500000).optional(),
    doi: z.string().max(120).optional(),
    preprint_url: z.string().max(1000).optional(),
    status: z.enum(PUBLICATION_STATUSES).optional()
  });

  app.post('/v1/agents/:did/labs/publications', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const parse = PublicationSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;
      const id = genId('pub');
      await pool.query(
        `INSERT INTO lab_publications (publication_id, agent_did, experiment_ids, title, abstract,
                                         body, doi, preprint_url, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [id, did, d.experiment_ids || [], d.title, d.abstract || null,
         d.body || null, d.doi || null, d.preprint_url || null,
         d.status || 'drafted']
      );
      await auditChain.append({
        event_type: 'labs.publication_created', publication_id: id, agent_did: did,
        title: d.title, status: d.status || 'drafted',
        timestamp: new Date().toISOString()
      });
      return res.status(201).json({ publication_id: id, title: d.title, status: d.status || 'drafted' });
    } catch (e) { return res.status(500).json({ error: 'create_failed', message: e.message }); }
  });
}

module.exports = {
  migrate, registerLabsRoutes,
  EXPERIMENT_KINDS, EXPERIMENT_STATUSES, PROVIDERS, DATASET_KINDS,
  DATASET_FORMATS, PROTOCOL_KINDS, PUBLICATION_STATUSES, EXPERIMENT_COST_CENTS
};
