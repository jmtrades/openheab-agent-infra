// ============================================================================
// OpenHeab CI/CD — Build pipelines + automated deployments for agents
// Tables: pipelines, pipeline_runs, pipeline_step_runs, deployment_targets
// Cron: /v1/_jobs/ci-tick — advance queued runs through their steps
// ============================================================================
const cryptoLib = require('crypto');
const express = require('express');
const { z } = require('zod');
const { registerCron } = require('../cron_auth');

const TRIGGER_KINDS = ['push', 'pr', 'manual', 'schedule', 'webhook'];
const RUN_STATUSES = ['queued', 'running', 'success', 'failed', 'cancelled'];
const STEP_STATUSES = ['pending', 'running', 'success', 'failed', 'skipped'];
const TARGET_KINDS = ['vercel', 'aws', 'gcp', 'cloudflare', 'render'];

let cost = null;
try { cost = require('./cost'); } catch { /* optional */ }

// ----------------------------------------------------------------------------
// Migration
// ----------------------------------------------------------------------------
async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pipelines (
      pipeline_id    TEXT PRIMARY KEY,
      owner_did      TEXT NOT NULL,
      name           TEXT NOT NULL,
      repo_id        TEXT,
      trigger_kind   TEXT NOT NULL DEFAULT 'manual',
      trigger_config JSONB,
      steps          JSONB NOT NULL DEFAULT '[]',
      active         BOOLEAN NOT NULL DEFAULT TRUE,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_pipelines_owner ON pipelines (owner_did);
    CREATE INDEX IF NOT EXISTS idx_pipelines_repo ON pipelines (repo_id);

    CREATE TABLE IF NOT EXISTS pipeline_runs (
      run_id        TEXT PRIMARY KEY,
      pipeline_id   TEXT NOT NULL REFERENCES pipelines(pipeline_id) ON DELETE CASCADE,
      agent_did     TEXT,
      commit_sha    TEXT,
      branch        TEXT,
      trigger_kind  TEXT,
      status        TEXT NOT NULL DEFAULT 'queued',
      step_results  JSONB NOT NULL DEFAULT '[]',
      duration_ms   INTEGER,
      started_at    TIMESTAMPTZ,
      completed_at  TIMESTAMPTZ,
      log_blob_id   TEXT,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_runs_pipeline ON pipeline_runs (pipeline_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_runs_status ON pipeline_runs (status, created_at);

    CREATE TABLE IF NOT EXISTS pipeline_step_runs (
      step_run_id   TEXT PRIMARY KEY,
      run_id        TEXT NOT NULL REFERENCES pipeline_runs(run_id) ON DELETE CASCADE,
      step_name     TEXT NOT NULL,
      sequence      INTEGER NOT NULL,
      status        TEXT NOT NULL DEFAULT 'pending',
      exit_code     INTEGER,
      log_excerpt   TEXT,
      duration_ms   INTEGER,
      started_at    TIMESTAMPTZ,
      completed_at  TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_step_runs_run ON pipeline_step_runs (run_id, sequence);

    CREATE TABLE IF NOT EXISTS deployment_targets (
      target_id   TEXT PRIMARY KEY,
      owner_did   TEXT NOT NULL,
      name        TEXT NOT NULL,
      kind        TEXT NOT NULL,
      config      JSONB,
      secrets_ref TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_targets_owner ON deployment_targets (owner_did);
  `);
}

function genPipelineId() { return 'pip_' + cryptoLib.randomBytes(12).toString('hex'); }
function genRunId()      { return 'run_' + cryptoLib.randomBytes(12).toString('hex'); }
function genStepRunId()  { return 'srun_' + cryptoLib.randomBytes(12).toString('hex'); }
function genTargetId()   { return 'tgt_' + cryptoLib.randomBytes(12).toString('hex'); }

const StepSchema = z.object({
  name: z.string().min(1).max(128),
  kind: z.string().max(64).optional().default('shell'),
  image: z.string().max(256).optional(),
  command: z.string().max(8192).optional(),
  env: z.record(z.string()).optional(),
  when: z.string().max(256).optional()
});

// ----------------------------------------------------------------------------
// Pipeline tick — advance queued runs
// ----------------------------------------------------------------------------
async function tickPipelines(pool, auditChain) {
  // 1. Start queued runs (move to running)
  const queued = await pool.query(`
    UPDATE pipeline_runs
       SET status = 'running', started_at = NOW()
     WHERE run_id IN (
        SELECT run_id FROM pipeline_runs WHERE status = 'queued'
        ORDER BY created_at LIMIT 25
     )
     RETURNING run_id, pipeline_id
  `).catch(() => ({ rows: [] }));

  let started = 0;
  for (const r of queued.rows) {
    const pip = await pool.query(
      `SELECT steps FROM pipelines WHERE pipeline_id = $1`, [r.pipeline_id]
    ).catch(() => ({ rows: [] }));
    const steps = pip.rows[0]?.steps || [];
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i] || {};
      await pool.query(
        `INSERT INTO pipeline_step_runs
         (step_run_id, run_id, step_name, sequence, status)
         VALUES ($1,$2,$3,$4,'pending')`,
        [genStepRunId(), r.run_id, s.name || `step_${i + 1}`, i]
      ).catch(() => {});
    }
    started++;
  }

  // 2. Progress running steps
  const runningSteps = await pool.query(`
    SELECT step_run_id, run_id, sequence FROM pipeline_step_runs
     WHERE status = 'pending'
     ORDER BY run_id, sequence LIMIT 100
  `).catch(() => ({ rows: [] }));

  let progressedSteps = 0;
  for (const s of runningSteps.rows) {
    // Mark previous step status — skip if any prior step in same run failed
    const prior = await pool.query(
      `SELECT status FROM pipeline_step_runs
       WHERE run_id = $1 AND sequence < $2 ORDER BY sequence`,
      [s.run_id, s.sequence]
    ).catch(() => ({ rows: [] }));
    const failedPrior = prior.rows.some(p => p.status === 'failed');
    if (failedPrior) {
      await pool.query(
        `UPDATE pipeline_step_runs SET status = 'skipped' WHERE step_run_id = $1`,
        [s.step_run_id]
      ).catch(() => {});
      progressedSteps++;
      continue;
    }
    // Simulate execution success
    await pool.query(
      `UPDATE pipeline_step_runs
       SET status = 'success', started_at = NOW(), completed_at = NOW(),
           exit_code = 0, duration_ms = 100
       WHERE step_run_id = $1`,
      [s.step_run_id]
    ).catch(() => {});
    progressedSteps++;
  }

  // 3. Finalize runs whose steps are all done
  const candidate = await pool.query(`
    SELECT r.run_id, r.pipeline_id, r.agent_did,
       SUM(CASE WHEN sr.status IN ('pending', 'running') THEN 1 ELSE 0 END) AS unfinished,
       SUM(CASE WHEN sr.status = 'failed' THEN 1 ELSE 0 END) AS failed_count
     FROM pipeline_runs r
     JOIN pipeline_step_runs sr ON sr.run_id = r.run_id
     WHERE r.status = 'running'
     GROUP BY r.run_id
     HAVING SUM(CASE WHEN sr.status IN ('pending', 'running') THEN 1 ELSE 0 END) = 0
     LIMIT 50
  `).catch(() => ({ rows: [] }));

  let finalized = 0;
  for (const c of candidate.rows) {
    const status = parseInt(c.failed_count) > 0 ? 'failed' : 'success';
    const upd = await pool.query(`
      UPDATE pipeline_runs
         SET status = $1, completed_at = NOW(),
             duration_ms = EXTRACT(EPOCH FROM (NOW() - started_at))::int * 1000
       WHERE run_id = $2 RETURNING run_id, pipeline_id
    `, [status, c.run_id]).catch(() => ({ rows: [] }));
    if (upd.rows[0] && auditChain) {
      await auditChain.append({
        event_type: 'ci.run_completed',
        run_id: c.run_id, pipeline_id: c.pipeline_id,
        status, timestamp: new Date().toISOString()
      });
    }
    finalized++;
  }

  return { started, progressedSteps, finalized };
}

// ----------------------------------------------------------------------------
// Routes
// ----------------------------------------------------------------------------
function registerCiCdRoutes(app, pool, verifyAgentAuth, auditChain) {
  // POST /v1/agents/:did/ci/pipelines
  const PipelineSchema = z.object({
    name: z.string().min(1).max(256),
    repo_id: z.string().max(128).optional(),
    trigger_kind: z.enum(TRIGGER_KINDS).optional().default('manual'),
    trigger_config: z.record(z.any()).optional(),
    steps: z.array(StepSchema).min(1).max(100),
    active: z.boolean().optional().default(true)
  });

  app.post('/v1/agents/:did/ci/pipelines', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const parse = PipelineSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;

      const pipelineId = genPipelineId();
      await pool.query(
        `INSERT INTO pipelines
         (pipeline_id, owner_did, name, repo_id, trigger_kind, trigger_config, steps, active)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8)`,
        [pipelineId, did, d.name, d.repo_id || null, d.trigger_kind,
         d.trigger_config ? JSON.stringify(d.trigger_config) : null,
         JSON.stringify(d.steps), d.active]
      );

      await auditChain.append({
        event_type: 'ci.pipeline_created',
        pipeline_id: pipelineId, owner_did: did, name: d.name,
        steps_count: d.steps.length, trigger_kind: d.trigger_kind,
        timestamp: new Date().toISOString()
      });

      return res.status(201).json({
        pipeline_id: pipelineId, owner_did: did, name: d.name,
        repo_id: d.repo_id || null, trigger_kind: d.trigger_kind,
        steps: d.steps, active: d.active,
        created_at: new Date().toISOString()
      });
    } catch (e) {
      console.error('[ci.pipeline.create]', e);
      return res.status(500).json({ error: 'pipeline_create_failed', message: e.message });
    }
  });

  // GET /v1/agents/:did/ci/pipelines
  app.get('/v1/agents/:did/ci/pipelines', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });

    const r = await pool.query(
      `SELECT pipeline_id, name, repo_id, trigger_kind, steps, active, created_at
       FROM pipelines WHERE owner_did = $1 ORDER BY created_at DESC`,
      [did]
    ).catch(() => ({ rows: [] }));
    return res.json({ pipelines: r.rows, count: r.rows.length });
  });

  // POST /v1/agents/:did/ci/pipelines/:id/run — manual trigger
  const RunSchema = z.object({
    commit_sha: z.string().max(64).optional(),
    branch: z.string().max(128).optional(),
    trigger_kind: z.enum(TRIGGER_KINDS).optional().default('manual')
  });

  app.post('/v1/agents/:did/ci/pipelines/:id/run', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const parse = RunSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;

      const pipR = await pool.query(
        `SELECT * FROM pipelines WHERE pipeline_id = $1 AND owner_did = $2 AND active = TRUE`,
        [req.params.id, did]
      ).catch(() => ({ rows: [] }));
      if (!pipR.rows[0]) return res.status(404).json({ error: 'pipeline_not_found_or_inactive' });

      const runId = genRunId();
      await pool.query(
        `INSERT INTO pipeline_runs
         (run_id, pipeline_id, agent_did, commit_sha, branch, trigger_kind, status)
         VALUES ($1,$2,$3,$4,$5,$6,'queued')`,
        [runId, req.params.id, did, d.commit_sha || null,
         d.branch || null, d.trigger_kind]
      );

      if (cost) {
        await cost.recordCost(pool, {
          agent_did: did, resource_type: 'ci.run_queued',
          amount_cents: 5, reference_id: runId
        }).catch(() => {});
      }

      await auditChain.append({
        event_type: 'ci.run_queued',
        run_id: runId, pipeline_id: req.params.id, agent_did: did,
        trigger_kind: d.trigger_kind, timestamp: new Date().toISOString()
      });

      return res.status(201).json({
        run_id: runId, pipeline_id: req.params.id,
        status: 'queued', trigger_kind: d.trigger_kind,
        commit_sha: d.commit_sha || null, branch: d.branch || null,
        queued_at: new Date().toISOString()
      });
    } catch (e) {
      console.error('[ci.run.queue]', e);
      return res.status(500).json({ error: 'run_queue_failed', message: e.message });
    }
  });

  // GET /v1/agents/:did/ci/runs/:id
  app.get('/v1/agents/:did/ci/runs/:id', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });

    const r = await pool.query(
      `SELECT r.*, p.name AS pipeline_name FROM pipeline_runs r
       JOIN pipelines p ON p.pipeline_id = r.pipeline_id
       WHERE r.run_id = $1 AND p.owner_did = $2`,
      [req.params.id, did]
    ).catch(() => ({ rows: [] }));
    if (!r.rows[0]) return res.status(404).json({ error: 'run_not_found' });

    const steps = await pool.query(
      `SELECT step_run_id, step_name, sequence, status, exit_code,
              log_excerpt, duration_ms, started_at, completed_at
       FROM pipeline_step_runs WHERE run_id = $1 ORDER BY sequence`,
      [req.params.id]
    ).catch(() => ({ rows: [] }));

    return res.json({ ...r.rows[0], step_runs: steps.rows });
  });

  // POST /v1/agents/:did/ci/runs/:id/cancel
  app.post('/v1/agents/:did/ci/runs/:id/cancel', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const upd = await pool.query(
        `UPDATE pipeline_runs r
         SET status = 'cancelled', completed_at = NOW()
         FROM pipelines p
         WHERE r.run_id = $1 AND r.pipeline_id = p.pipeline_id
           AND p.owner_did = $2 AND r.status IN ('queued','running')
         RETURNING r.run_id`,
        [req.params.id, did]
      ).catch(() => ({ rows: [] }));
      if (!upd.rows[0]) return res.status(404).json({ error: 'run_not_cancellable' });

      await pool.query(
        `UPDATE pipeline_step_runs SET status = 'skipped'
         WHERE run_id = $1 AND status IN ('pending','running')`,
        [req.params.id]
      ).catch(() => {});

      await auditChain.append({
        event_type: 'ci.run_cancelled',
        run_id: req.params.id, agent_did: did,
        timestamp: new Date().toISOString()
      });

      return res.json({ run_id: req.params.id, status: 'cancelled' });
    } catch (e) {
      console.error('[ci.run.cancel]', e);
      return res.status(500).json({ error: 'cancel_failed', message: e.message });
    }
  });

  // GET /v1/agents/:did/ci/runs/:id/logs
  app.get('/v1/agents/:did/ci/runs/:id/logs', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });

    const r = await pool.query(
      `SELECT r.run_id, r.log_blob_id, r.status, p.owner_did
       FROM pipeline_runs r JOIN pipelines p ON p.pipeline_id = r.pipeline_id
       WHERE r.run_id = $1 AND p.owner_did = $2`,
      [req.params.id, did]
    ).catch(() => ({ rows: [] }));
    if (!r.rows[0]) return res.status(404).json({ error: 'run_not_found' });

    const steps = await pool.query(
      `SELECT step_name, sequence, status, exit_code, log_excerpt, duration_ms
       FROM pipeline_step_runs WHERE run_id = $1 ORDER BY sequence`,
      [req.params.id]
    ).catch(() => ({ rows: [] }));

    return res.json({
      run_id: req.params.id,
      log_blob_id: r.rows[0].log_blob_id || null,
      status: r.rows[0].status,
      steps: steps.rows
    });
  });

  // POST /v1/_webhooks/github — trigger pipelines from external GitHub events
  app.post('/v1/_webhooks/github', express.json({ limit: '1mb' }), async (req, res) => {
    try {
      const eventType = req.headers['x-github-event'] || 'push';
      const payload = req.body || {};
      const repoFullName = payload.repository?.full_name;
      const branch = (payload.ref || '').replace(/^refs\/heads\//, '');
      const commitSha = payload.after || payload.pull_request?.head?.sha || null;

      // Find matching pipelines
      const conds = ["active = TRUE"];
      const params = [];
      if (eventType === 'pull_request') conds.push(`trigger_kind = 'pr'`);
      else conds.push(`trigger_kind = 'push'`);

      const pipR = await pool.query(
        `SELECT pipeline_id, owner_did FROM pipelines WHERE ${conds.join(' AND ')}`,
        params
      ).catch(() => ({ rows: [] }));

      const triggered = [];
      for (const p of pipR.rows) {
        const runId = genRunId();
        await pool.query(
          `INSERT INTO pipeline_runs
           (run_id, pipeline_id, agent_did, commit_sha, branch, trigger_kind, status)
           VALUES ($1,$2,$3,$4,$5,$6,'queued')`,
          [runId, p.pipeline_id, p.owner_did, commitSha, branch || null,
           eventType === 'pull_request' ? 'pr' : 'push']
        ).catch(() => {});
        triggered.push(runId);
      }

      await auditChain.append({
        event_type: 'ci.webhook_github',
        github_event: eventType, repo: repoFullName,
        triggered_count: triggered.length,
        timestamp: new Date().toISOString()
      });

      return res.json({ event: eventType, triggered, count: triggered.length });
    } catch (e) {
      console.error('[ci.webhook.github]', e);
      return res.status(500).json({ error: 'webhook_failed', message: e.message });
    }
  });

  // POST /v1/agents/:did/ci/deployment-targets
  const TargetSchema = z.object({
    name: z.string().min(1).max(256),
    kind: z.enum(TARGET_KINDS),
    config: z.record(z.any()).optional(),
    secrets_ref: z.string().max(256).optional()
  });

  app.post('/v1/agents/:did/ci/deployment-targets', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const parse = TargetSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;

      const targetId = genTargetId();
      await pool.query(
        `INSERT INTO deployment_targets
         (target_id, owner_did, name, kind, config, secrets_ref)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6)`,
        [targetId, did, d.name, d.kind,
         d.config ? JSON.stringify(d.config) : null,
         d.secrets_ref || null]
      );

      await auditChain.append({
        event_type: 'ci.target_created',
        target_id: targetId, owner_did: did, kind: d.kind,
        timestamp: new Date().toISOString()
      });

      return res.status(201).json({
        target_id: targetId, owner_did: did, name: d.name, kind: d.kind,
        config: d.config || null, secrets_ref: d.secrets_ref || null,
        created_at: new Date().toISOString()
      });
    } catch (e) {
      console.error('[ci.target.create]', e);
      return res.status(500).json({ error: 'target_create_failed', message: e.message });
    }
  });

  // GET /v1/agents/:did/ci/deployment-targets
  app.get('/v1/agents/:did/ci/deployment-targets', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });

    const r = await pool.query(
      `SELECT target_id, name, kind, config, secrets_ref, created_at
       FROM deployment_targets WHERE owner_did = $1 ORDER BY created_at DESC`,
      [did]
    ).catch(() => ({ rows: [] }));
    return res.json({ targets: r.rows, count: r.rows.length });
  });

  // Cron: ci-tick
  registerCron(app, '/v1/_jobs/ci-tick', async (req, res) => {
    try {
      const r = await tickPipelines(pool, auditChain);
      return res.json(r);
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  });
}

module.exports = {
  migrate,
  registerCiCdRoutes,
  tickPipelines,
  TRIGGER_KINDS,
  RUN_STATUSES,
  STEP_STATUSES,
  TARGET_KINDS
};
