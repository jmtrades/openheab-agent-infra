// ============================================================================
// OpenHeab Workflows — Durable DAG executor
// ============================================================================
const express = require('express');
const cryptoLib = require('crypto');
const { z } = require('zod');
const { registerCron } = require('../cron_auth');

const RUN_STATUSES  = ['pending', 'running', 'completed', 'failed', 'cancelled', 'awaiting_hitl'];
const STEP_STATUSES = ['pending', 'running', 'completed', 'failed', 'skipped'];
const STEP_TYPES = [
  'agent_task', 'llm_call', 'http_request', 'branch', 'parallel',
  'wait', 'sub_workflow', 'hitl_approval', 'tool_call', 'db_query', 'extension_invoke'
];

// ----------------------------------------------------------------------------
// Migration
// ----------------------------------------------------------------------------
async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS workflows (
      workflow_id   TEXT PRIMARY KEY,
      owner_did     TEXT NOT NULL,
      name          TEXT NOT NULL,
      description   TEXT,
      definition    JSONB NOT NULL,
      version       INTEGER NOT NULL DEFAULT 1,
      active        BOOLEAN NOT NULL DEFAULT TRUE,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (owner_did, name)
    );
    CREATE INDEX IF NOT EXISTS idx_workflows_owner ON workflows (owner_did);

    CREATE TABLE IF NOT EXISTS workflow_runs (
      run_id        TEXT PRIMARY KEY,
      workflow_id   TEXT NOT NULL,
      owner_did     TEXT NOT NULL,
      status        TEXT NOT NULL DEFAULT 'pending',
      trigger       JSONB,
      input         JSONB,
      output        JSONB,
      current_step  TEXT,
      error         TEXT,
      audit_hash    TEXT,
      started_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at  TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_workflow_runs_owner ON workflow_runs (owner_did, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_workflow_runs_status ON workflow_runs (status, started_at);
    CREATE INDEX IF NOT EXISTS idx_workflow_runs_wfid ON workflow_runs (workflow_id, started_at DESC);

    CREATE TABLE IF NOT EXISTS workflow_steps (
      step_id       TEXT PRIMARY KEY,
      run_id        TEXT NOT NULL,
      step_name     TEXT NOT NULL,
      step_type     TEXT NOT NULL,
      status        TEXT NOT NULL DEFAULT 'pending',
      input         JSONB,
      output        JSONB,
      error         TEXT,
      attempt       INTEGER NOT NULL DEFAULT 0,
      started_at    TIMESTAMPTZ,
      completed_at  TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_workflow_steps_run ON workflow_steps (run_id, step_name);
    CREATE INDEX IF NOT EXISTS idx_workflow_steps_status ON workflow_steps (status);
  `);
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------
function genId(prefix) {
  return prefix + '_' + cryptoLib.randomBytes(12).toString('hex');
}

function getSteps(definition) {
  if (!definition || typeof definition !== 'object') return [];
  if (Array.isArray(definition.steps)) return definition.steps;
  return [];
}

function findStep(definition, name) {
  return getSteps(definition).find(s => s.name === name || s.id === name);
}

function nextStepName(definition, currentName) {
  const steps = getSteps(definition);
  const idx = steps.findIndex(s => s.name === currentName || s.id === currentName);
  if (idx < 0) return steps[0] ? (steps[0].name || steps[0].id) : null;
  const next = steps[idx + 1];
  return next ? (next.name || next.id) : null;
}

async function tickWorkflows(pool, auditChain, opts = {}) {
  const limit = opts.limit || 100;
  const r = await pool.query(`
    SELECT run_id, workflow_id, owner_did, status, current_step, input
    FROM workflow_runs
    WHERE status IN ('pending', 'running')
    ORDER BY started_at ASC
    LIMIT $1
  `, [limit]).catch(() => ({ rows: [] }));

  const out = { advanced: 0, completed: 0, awaiting_hitl: 0, failed: 0 };

  for (const run of r.rows) {
    try {
      const wfR = await pool.query(
        `SELECT definition FROM workflows WHERE workflow_id = $1`,
        [run.workflow_id]
      );
      if (!wfR.rows[0]) {
        await pool.query(`
          UPDATE workflow_runs SET status = 'failed', error = 'workflow_not_found',
                                   completed_at = NOW() WHERE run_id = $1
        `, [run.run_id]);
        out.failed++;
        continue;
      }
      const definition = typeof wfR.rows[0].definition === 'string'
        ? JSON.parse(wfR.rows[0].definition) : wfR.rows[0].definition;
      const steps = getSteps(definition);
      if (steps.length === 0) {
        await pool.query(`
          UPDATE workflow_runs SET status='completed', output='{}'::jsonb,
                                   completed_at=NOW() WHERE run_id=$1
        `, [run.run_id]);
        out.completed++;
        continue;
      }

      const currentName = run.current_step || (steps[0].name || steps[0].id);
      const stepDef = findStep(definition, currentName);
      if (!stepDef) {
        await pool.query(`
          UPDATE workflow_runs SET status='completed', completed_at=NOW() WHERE run_id=$1
        `, [run.run_id]);
        out.completed++;
        continue;
      }

      // HITL → awaiting_hitl
      if (stepDef.type === 'hitl_approval') {
        const stepId = genId('step');
        await pool.query(`
          INSERT INTO workflow_steps
          (step_id, run_id, step_name, step_type, status, input, started_at)
          VALUES ($1,$2,$3,$4,'pending',$5::jsonb, NOW())
          ON CONFLICT DO NOTHING
        `, [stepId, run.run_id, currentName, stepDef.type,
            JSON.stringify(stepDef.input || {})]).catch(() => {});
        await pool.query(`
          UPDATE workflow_runs SET status='awaiting_hitl', current_step=$2
          WHERE run_id=$1
        `, [run.run_id, currentName]);
        await auditChain.append({
          event_type: 'workflow.awaiting_hitl',
          run_id: run.run_id, workflow_id: run.workflow_id,
          step_name: currentName,
          timestamp: new Date().toISOString()
        });
        out.awaiting_hitl++;
        continue;
      }

      // Mark step completed (no real executor in this primitive — durable scaffolding)
      const stepId = genId('step');
      await pool.query(`
        INSERT INTO workflow_steps
        (step_id, run_id, step_name, step_type, status, input, output,
         attempt, started_at, completed_at)
        VALUES ($1,$2,$3,$4,'completed',$5::jsonb,$6::jsonb,1, NOW(), NOW())
        ON CONFLICT DO NOTHING
      `, [stepId, run.run_id, currentName, stepDef.type || 'agent_task',
          JSON.stringify(stepDef.input || {}),
          JSON.stringify({ ok: true, step: currentName })]).catch(() => {});

      const nextName = nextStepName(definition, currentName);
      if (!nextName) {
        const entry = await auditChain.append({
          event_type: 'workflow.completed',
          run_id: run.run_id, workflow_id: run.workflow_id,
          timestamp: new Date().toISOString()
        });
        await pool.query(`
          UPDATE workflow_runs
          SET status='completed', output='{}'::jsonb,
              audit_hash=$2, completed_at=NOW(), current_step=NULL
          WHERE run_id=$1
        `, [run.run_id, entry.hash]);
        out.completed++;
      } else {
        await pool.query(`
          UPDATE workflow_runs SET status='running', current_step=$2 WHERE run_id=$1
        `, [run.run_id, nextName]);
        out.advanced++;
      }
    } catch (e) {
      console.warn('[workflows.tick]', run.run_id, e.message);
      try {
        await pool.query(`
          UPDATE workflow_runs SET status='failed', error=$2, completed_at=NOW()
          WHERE run_id=$1
        `, [run.run_id, e.message]);
      } catch {}
      out.failed++;
    }
  }
  return out;
}

// ----------------------------------------------------------------------------
// Routes
// ----------------------------------------------------------------------------
const StepSchema = z.object({
  name:    z.string().min(1).max(128),
  type:    z.enum(STEP_TYPES),
  input:   z.any().optional(),
  config:  z.any().optional()
}).passthrough();

const DefinitionSchema = z.object({
  steps: z.array(StepSchema).min(1).max(256)
}).passthrough();

const CreateWorkflowSchema = z.object({
  owner_did:   z.string().min(1),
  name:        z.string().min(1).max(128),
  description: z.string().max(2000).optional(),
  definition:  DefinitionSchema,
  active:      z.boolean().optional()
});

function registerWorkflowRoutes(app, pool, verifyAgentAuth, auditChain) {
  // POST /v1/workflows
  app.post('/v1/workflows', express.json(), async (req, res) => {
    try {
      const parse = CreateWorkflowSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;
      const auth = await verifyAgentAuth(req, d.owner_did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const workflowId = genId('wf');
      await pool.query(`
        INSERT INTO workflows
        (workflow_id, owner_did, name, description, definition, version, active, updated_at)
        VALUES ($1,$2,$3,$4,$5::jsonb,1,$6, NOW())
        ON CONFLICT (owner_did, name) DO UPDATE SET
          description = EXCLUDED.description,
          definition  = EXCLUDED.definition,
          version     = workflows.version + 1,
          active      = EXCLUDED.active,
          updated_at  = NOW()
        RETURNING workflow_id, owner_did, name, description, version, active, created_at, updated_at
      `, [workflowId, d.owner_did, d.name, d.description || null,
          JSON.stringify(d.definition), d.active !== false]);

      const r = await pool.query(`
        SELECT workflow_id, owner_did, name, description, definition,
               version, active, created_at, updated_at
        FROM workflows WHERE owner_did=$1 AND name=$2
      `, [d.owner_did, d.name]);

      await auditChain.append({
        event_type: 'workflow.created',
        workflow_id: r.rows[0].workflow_id,
        owner_did: d.owner_did, name: d.name, version: r.rows[0].version,
        timestamp: new Date().toISOString()
      });

      return res.status(201).json(r.rows[0]);
    } catch (e) {
      console.error('[workflow.create]', e);
      return res.status(500).json({ error: 'create_failed', message: e.message });
    }
  });

  // GET /v1/workflows
  app.get('/v1/workflows', async (req, res) => {
    const ownerDid = req.query.owner_did;
    if (!ownerDid) return res.status(400).json({ error: 'owner_did_required' });
    const auth = await verifyAgentAuth(req, ownerDid);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(`
      SELECT workflow_id, name, description, version, active, created_at, updated_at
      FROM workflows WHERE owner_did = $1 ORDER BY updated_at DESC LIMIT 200
    `, [ownerDid]).catch(() => ({ rows: [] }));
    return res.json({ owner_did: ownerDid, workflows: r.rows, count: r.rows.length });
  });

  // GET /v1/workflows/:id
  app.get('/v1/workflows/:id', async (req, res) => {
    const r = await pool.query(`
      SELECT workflow_id, owner_did, name, description, definition,
             version, active, created_at, updated_at
      FROM workflows WHERE workflow_id = $1
    `, [req.params.id]).catch(() => ({ rows: [] }));
    if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
    const auth = await verifyAgentAuth(req, r.rows[0].owner_did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    return res.json(r.rows[0]);
  });

  // POST /v1/workflows/:id/run
  const RunSchema = z.object({
    input:   z.any().optional(),
    trigger: z.record(z.any()).optional()
  });
  app.post('/v1/workflows/:id/run', express.json(), async (req, res) => {
    try {
      const wfR = await pool.query(
        `SELECT workflow_id, owner_did, definition, active FROM workflows WHERE workflow_id = $1`,
        [req.params.id]
      );
      if (!wfR.rows[0]) return res.status(404).json({ error: 'workflow_not_found' });
      if (!wfR.rows[0].active) return res.status(400).json({ error: 'workflow_inactive' });

      const auth = await verifyAgentAuth(req, wfR.rows[0].owner_did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const parse = RunSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;

      const def = typeof wfR.rows[0].definition === 'string'
        ? JSON.parse(wfR.rows[0].definition) : wfR.rows[0].definition;
      const steps = getSteps(def);
      const firstStep = steps[0] ? (steps[0].name || steps[0].id) : null;

      const runId = genId('run');
      const entry = await auditChain.append({
        event_type: 'workflow.run_started',
        run_id: runId, workflow_id: wfR.rows[0].workflow_id,
        owner_did: wfR.rows[0].owner_did,
        timestamp: new Date().toISOString()
      });

      await pool.query(`
        INSERT INTO workflow_runs
        (run_id, workflow_id, owner_did, status, trigger, input,
         current_step, audit_hash, started_at)
        VALUES ($1,$2,$3,'pending',$4::jsonb,$5::jsonb,$6,$7, NOW())
      `, [runId, wfR.rows[0].workflow_id, wfR.rows[0].owner_did,
          d.trigger ? JSON.stringify(d.trigger) : null,
          d.input !== undefined ? JSON.stringify(d.input) : null,
          firstStep, entry.hash]);

      return res.status(201).json({
        run_id: runId, workflow_id: wfR.rows[0].workflow_id,
        status: 'pending', current_step: firstStep,
        audit_hash: entry.hash
      });
    } catch (e) {
      console.error('[workflow.run]', e);
      return res.status(500).json({ error: 'run_failed', message: e.message });
    }
  });

  // GET /v1/workflow-runs/:runId
  app.get('/v1/workflow-runs/:runId', async (req, res) => {
    const r = await pool.query(`
      SELECT run_id, workflow_id, owner_did, status, trigger, input, output,
             current_step, error, audit_hash, started_at, completed_at
      FROM workflow_runs WHERE run_id = $1
    `, [req.params.runId]).catch(() => ({ rows: [] }));
    if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
    const auth = await verifyAgentAuth(req, r.rows[0].owner_did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });

    const stepsR = await pool.query(`
      SELECT step_id, step_name, step_type, status, input, output, error,
             attempt, started_at, completed_at
      FROM workflow_steps WHERE run_id = $1
      ORDER BY started_at ASC NULLS LAST
    `, [req.params.runId]).catch(() => ({ rows: [] }));

    return res.json({ ...r.rows[0], steps: stepsR.rows });
  });

  // POST /v1/workflow-runs/:runId/cancel
  app.post('/v1/workflow-runs/:runId/cancel', express.json(), async (req, res) => {
    const r = await pool.query(
      `SELECT owner_did, status FROM workflow_runs WHERE run_id = $1`,
      [req.params.runId]
    ).catch(() => ({ rows: [] }));
    if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
    const auth = await verifyAgentAuth(req, r.rows[0].owner_did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    if (['completed', 'cancelled', 'failed'].includes(r.rows[0].status)) {
      return res.status(400).json({ error: 'run_already_terminal', status: r.rows[0].status });
    }
    const entry = await auditChain.append({
      event_type: 'workflow.run_cancelled',
      run_id: req.params.runId,
      timestamp: new Date().toISOString()
    });
    await pool.query(`
      UPDATE workflow_runs SET status='cancelled', audit_hash=$2,
                                completed_at=NOW() WHERE run_id=$1
    `, [req.params.runId, entry.hash]);
    return res.json({ run_id: req.params.runId, status: 'cancelled', audit_hash: entry.hash });
  });

  // POST /v1/workflow-runs/:runId/resume (after HITL)
  const ResumeSchema = z.object({
    approval:        z.boolean().optional(),
    hitl_decision:   z.record(z.any()).optional()
  });
  app.post('/v1/workflow-runs/:runId/resume', express.json(), async (req, res) => {
    const r = await pool.query(
      `SELECT owner_did, status, workflow_id, current_step FROM workflow_runs WHERE run_id = $1`,
      [req.params.runId]
    ).catch(() => ({ rows: [] }));
    if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
    const auth = await verifyAgentAuth(req, r.rows[0].owner_did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    if (r.rows[0].status !== 'awaiting_hitl') {
      return res.status(400).json({ error: 'not_awaiting_hitl', status: r.rows[0].status });
    }

    const parse = ResumeSchema.safeParse(req.body || {});
    if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
    const approved = parse.data.approval !== false;

    const entry = await auditChain.append({
      event_type: 'workflow.run_resumed',
      run_id: req.params.runId,
      approval: approved,
      hitl_decision: parse.data.hitl_decision || null,
      timestamp: new Date().toISOString()
    });

    if (!approved) {
      await pool.query(`
        UPDATE workflow_runs SET status='cancelled', audit_hash=$2,
                                  completed_at=NOW() WHERE run_id=$1
      `, [req.params.runId, entry.hash]);
      return res.json({ run_id: req.params.runId, status: 'cancelled', audit_hash: entry.hash });
    }

    // Mark current HITL step completed and advance
    await pool.query(`
      UPDATE workflow_steps SET status='completed',
                                output=$3::jsonb, completed_at=NOW()
      WHERE run_id=$1 AND step_name=$2 AND step_type='hitl_approval' AND status != 'completed'
    `, [req.params.runId, r.rows[0].current_step,
        JSON.stringify({ approved: true, decision: parse.data.hitl_decision || null })]).catch(() => {});

    const wfR = await pool.query(`SELECT definition FROM workflows WHERE workflow_id = $1`,
                                  [r.rows[0].workflow_id]);
    const def = wfR.rows[0]
      ? (typeof wfR.rows[0].definition === 'string'
         ? JSON.parse(wfR.rows[0].definition) : wfR.rows[0].definition)
      : { steps: [] };
    const nextName = nextStepName(def, r.rows[0].current_step);

    if (!nextName) {
      await pool.query(`
        UPDATE workflow_runs SET status='completed', audit_hash=$2,
                                  completed_at=NOW(), current_step=NULL WHERE run_id=$1
      `, [req.params.runId, entry.hash]);
      return res.json({ run_id: req.params.runId, status: 'completed', audit_hash: entry.hash });
    }
    await pool.query(`
      UPDATE workflow_runs SET status='running', current_step=$2, audit_hash=$3
      WHERE run_id=$1
    `, [req.params.runId, nextName, entry.hash]);
    return res.json({
      run_id: req.params.runId, status: 'running',
      current_step: nextName, audit_hash: entry.hash
    });
  });

  // Cron: tick workflows
  registerCron(app, '/v1/_jobs/workflow-tick', async (req, res) => {
    try {
      const result = await tickWorkflows(pool, auditChain, {});
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
}

module.exports = {
  migrate,
  registerWorkflowRoutes,
  tickWorkflows,
  RUN_STATUSES,
  STEP_STATUSES,
  STEP_TYPES
};
