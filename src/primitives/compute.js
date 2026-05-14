// ============================================================================
// OpenHeab Compute — GPU/CPU cloud compute provisioning across providers.
// Provider abstraction over runpod / lambda / modal / vast / coreweave.
// Tracks instances, snapshots, jobs; charges via cost primitive.
// ============================================================================
const express = require('express');
const cryptoLib = require('crypto');
const { z } = require('zod');

const PROVIDERS = ['runpod', 'lambda', 'modal', 'vast', 'coreweave'];
const INSTANCE_STATUSES = ['provisioning', 'running', 'stopped', 'terminated'];
const JOB_KINDS = ['training', 'inference', 'batch'];
const JOB_STATUSES = ['pending', 'running', 'complete', 'failed'];

// Default catalog (cents per hour)
const INSTANCE_CATALOG = [
  { type: 'a100',     gpu_count: 1, vcpu: 12, ram_gb: 80,  disk_gb: 500,  hourly_rate_cents: 200 },
  { type: 'a100-80g', gpu_count: 1, vcpu: 16, ram_gb: 120, disk_gb: 1000, hourly_rate_cents: 300 },
  { type: 'h100',     gpu_count: 1, vcpu: 24, ram_gb: 160, disk_gb: 1000, hourly_rate_cents: 400 },
  { type: 'h100-x8',  gpu_count: 8, vcpu: 96, ram_gb: 640, disk_gb: 4000, hourly_rate_cents: 3200 },
  { type: '4090',     gpu_count: 1, vcpu: 8,  ram_gb: 48,  disk_gb: 500,  hourly_rate_cents: 70 },
  { type: 'cpu-x4',   gpu_count: 0, vcpu: 4,  ram_gb: 16,  disk_gb: 100,  hourly_rate_cents: 8 },
  { type: 'cpu-x16',  gpu_count: 0, vcpu: 16, ram_gb: 64,  disk_gb: 500,  hourly_rate_cents: 30 }
];

async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS compute_instances (
      instance_id        TEXT PRIMARY KEY,
      agent_did          TEXT NOT NULL,
      provider           TEXT NOT NULL,
      instance_type      TEXT NOT NULL,
      gpu_count          INTEGER NOT NULL DEFAULT 0,
      vcpu               INTEGER NOT NULL DEFAULT 0,
      ram_gb             INTEGER NOT NULL DEFAULT 0,
      disk_gb            INTEGER NOT NULL DEFAULT 0,
      region             TEXT,
      hourly_rate_cents  INTEGER NOT NULL DEFAULT 0,
      image              TEXT,
      status             TEXT NOT NULL DEFAULT 'provisioning',
      public_ip          TEXT,
      ssh_keys           TEXT[] DEFAULT '{}',
      provider_id        TEXT,
      started_at         TIMESTAMPTZ,
      terminated_at      TIMESTAMPTZ,
      total_cost_cents   BIGINT NOT NULL DEFAULT 0,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_compute_instances_agent ON compute_instances (agent_did, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_compute_instances_status ON compute_instances (status);

    CREATE TABLE IF NOT EXISTS compute_snapshots (
      snapshot_id      TEXT PRIMARY KEY,
      instance_id      TEXT NOT NULL,
      name             TEXT,
      size_gb          INTEGER,
      storage_blob_id  TEXT,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_compute_snapshots_instance ON compute_snapshots (instance_id);

    CREATE TABLE IF NOT EXISTS compute_jobs (
      job_id        TEXT PRIMARY KEY,
      agent_did     TEXT NOT NULL,
      kind          TEXT NOT NULL,
      instance_id   TEXT,
      script        TEXT,
      status        TEXT NOT NULL DEFAULT 'pending',
      output_uri    TEXT,
      started_at    TIMESTAMPTZ,
      completed_at  TIMESTAMPTZ,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_compute_jobs_agent ON compute_jobs (agent_did, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_compute_jobs_status ON compute_jobs (status);
  `).catch(() => {});
}

function genId(prefix) { return `${prefix}_${cryptoLib.randomBytes(12).toString('hex')}`; }

function lookupCatalog(instanceType) {
  return INSTANCE_CATALOG.find(i => i.type === instanceType);
}

function registerComputeRoutes(app, pool, verifyAgentAuth, auditChain) {
  // GET /v1/compute/instance-types — public catalog
  app.get('/v1/compute/instance-types', async (req, res) => {
    return res.json({ providers: PROVIDERS, instance_types: INSTANCE_CATALOG });
  });

  // POST /v1/agents/:did/compute/instances — provision
  const ProvSchema = z.object({
    provider: z.enum(PROVIDERS),
    instance_type: z.string(),
    region: z.string().max(60).optional(),
    image: z.string().max(300).optional(),
    ssh_keys: z.array(z.string()).optional()
  });
  app.post('/v1/agents/:did/compute/instances', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const parse = ProvSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;
      const spec = lookupCatalog(d.instance_type);
      if (!spec) return res.status(400).json({ error: 'unknown_instance_type', valid: INSTANCE_CATALOG.map(i => i.type) });

      const instanceId = genId('comp');
      const providerId = `${d.provider}-${cryptoLib.randomBytes(6).toString('hex')}`;
      await pool.query(
        `INSERT INTO compute_instances (instance_id, agent_did, provider, instance_type,
                                         gpu_count, vcpu, ram_gb, disk_gb, region,
                                         hourly_rate_cents, image, status, ssh_keys, provider_id, started_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'provisioning',$12,$13, NOW())`,
        [instanceId, did, d.provider, d.instance_type, spec.gpu_count, spec.vcpu, spec.ram_gb,
         spec.disk_gb, d.region || 'us-east', spec.hourly_rate_cents, d.image || null,
         d.ssh_keys || [], providerId]
      );
      // Move to running after provisioning (simulated)
      await pool.query(
        `UPDATE compute_instances SET status='running', public_ip='10.0.0.1' WHERE instance_id=$1`,
        [instanceId]
      ).catch(() => {});

      await auditChain.append({
        event_type: 'compute.instance_provisioned', instance_id: instanceId, agent_did: did,
        provider: d.provider, instance_type: d.instance_type,
        hourly_rate_cents: spec.hourly_rate_cents, timestamp: new Date().toISOString()
      });
      return res.status(201).json({
        instance_id: instanceId, provider: d.provider, instance_type: d.instance_type,
        hourly_rate_cents: spec.hourly_rate_cents, status: 'running',
        provider_id: providerId
      });
    } catch (e) { return res.status(500).json({ error: 'provision_failed', message: e.message }); }
  });

  // GET /v1/agents/:did/compute/instances
  app.get('/v1/agents/:did/compute/instances', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(
      `SELECT * FROM compute_instances WHERE agent_did=$1 ORDER BY created_at DESC LIMIT 500`,
      [did]
    ).catch(() => ({ rows: [] }));
    return res.json({ instances: r.rows, count: r.rows.length });
  });

  async function chargeForRuntime(did, instanceId, instance) {
    if (!instance || !instance.started_at) return 0;
    const startedAt = new Date(instance.started_at).getTime();
    const now = Date.now();
    const hours = Math.max(0, (now - startedAt) / 3_600_000);
    const cost = Math.ceil(hours * (instance.hourly_rate_cents || 0));
    try {
      const cost_mod = require('./cost');
      if (cost_mod && typeof cost_mod.recordCost === 'function') {
        await cost_mod.recordCost(pool, {
          agent_did: did, resource_type: 'compute', provider: instance.provider,
          amount_cents: cost, units: hours, unit_type: 'hours',
          reference_id: instanceId, tags: { instance_type: instance.instance_type }
        }).catch(() => {});
      }
    } catch {}
    await pool.query(
      `UPDATE compute_instances SET total_cost_cents = total_cost_cents + $1 WHERE instance_id=$2`,
      [cost, instanceId]
    ).catch(() => {});
    return cost;
  }

  // POST /v1/agents/:did/compute/instances/:id/stop
  app.post('/v1/agents/:did/compute/instances/:id/stop', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const inst = await pool.query(
        `SELECT * FROM compute_instances WHERE instance_id=$1 AND agent_did=$2`,
        [req.params.id, did]
      ).catch(() => ({ rows: [] }));
      if (!inst.rows[0]) return res.status(404).json({ error: 'not_found' });
      const charged = await chargeForRuntime(did, req.params.id, inst.rows[0]);
      await pool.query(`UPDATE compute_instances SET status='stopped' WHERE instance_id=$1`, [req.params.id]);
      await auditChain.append({
        event_type: 'compute.instance_stopped', instance_id: req.params.id, agent_did: did,
        charged_cents: charged, timestamp: new Date().toISOString()
      });
      return res.json({ instance_id: req.params.id, status: 'stopped', charged_cents: charged });
    } catch (e) { return res.status(500).json({ error: 'stop_failed', message: e.message }); }
  });

  // POST /v1/agents/:did/compute/instances/:id/terminate
  app.post('/v1/agents/:did/compute/instances/:id/terminate', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const inst = await pool.query(
        `SELECT * FROM compute_instances WHERE instance_id=$1 AND agent_did=$2`,
        [req.params.id, did]
      ).catch(() => ({ rows: [] }));
      if (!inst.rows[0]) return res.status(404).json({ error: 'not_found' });
      const charged = await chargeForRuntime(did, req.params.id, inst.rows[0]);
      await pool.query(
        `UPDATE compute_instances SET status='terminated', terminated_at=NOW() WHERE instance_id=$1`,
        [req.params.id]
      );
      await auditChain.append({
        event_type: 'compute.instance_terminated', instance_id: req.params.id, agent_did: did,
        charged_cents: charged, timestamp: new Date().toISOString()
      });
      return res.json({ instance_id: req.params.id, status: 'terminated', charged_cents: charged });
    } catch (e) { return res.status(500).json({ error: 'terminate_failed', message: e.message }); }
  });

  // POST /v1/agents/:did/compute/jobs
  const JobSchema = z.object({
    kind: z.enum(JOB_KINDS),
    instance_id: z.string().optional(),
    script: z.string().max(100000)
  });
  app.post('/v1/agents/:did/compute/jobs', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const parse = JobSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;
      const jobId = genId('cjob');
      await pool.query(
        `INSERT INTO compute_jobs (job_id, agent_did, kind, instance_id, script, status, started_at)
         VALUES ($1,$2,$3,$4,$5,'pending', NOW())`,
        [jobId, did, d.kind, d.instance_id || null, d.script]
      );
      await auditChain.append({
        event_type: 'compute.job_submitted', job_id: jobId, agent_did: did,
        kind: d.kind, timestamp: new Date().toISOString()
      });
      return res.status(201).json({ job_id: jobId, status: 'pending', kind: d.kind });
    } catch (e) { return res.status(500).json({ error: 'job_failed', message: e.message }); }
  });

  // GET /v1/agents/:did/compute/jobs/:id
  app.get('/v1/agents/:did/compute/jobs/:id', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(
      `SELECT * FROM compute_jobs WHERE job_id=$1 AND agent_did=$2`,
      [req.params.id, did]
    ).catch(() => ({ rows: [] }));
    if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
    return res.json(r.rows[0]);
  });
}

module.exports = {
  migrate, registerComputeRoutes,
  PROVIDERS, INSTANCE_STATUSES, JOB_KINDS, JOB_STATUSES, INSTANCE_CATALOG,
  lookupCatalog
};
