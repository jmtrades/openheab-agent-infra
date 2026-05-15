// ============================================================================
// workflow_builder.js — visual trigger→action workflow builder (Zapier/n8n-
// style for agents). Triggers: schedule, webhook, inbox-message, on-payment,
// on-kyc-decision, on-card-auth, on-onchain-event. Actions: inference call,
// transfer, send email, create task, http call, run extension. Workflows
// persist as a DAG that orchestration.js can execute.
// ============================================================================
const crypto = require('crypto');
const { z } = require('zod');
const { registerCron } = require('../cron_auth');

const TRIGGER_KINDS = ['schedule', 'webhook', 'inbox_message', 'payment_received',
                        'kyc_decided', 'card_auth', 'onchain_event', 'form_submission',
                        'manual', 'low_balance', 'high_risk_alert'];

const ACTION_KINDS = ['inference_chat', 'wallet_transfer', 'send_email', 'send_sms',
                       'create_task', 'http_request', 'run_extension', 'set_memory',
                       'invoke_workflow', 'mark_milestone', 'pay_invoice', 'open_negotiation',
                       'kyc_recheck', 'fact_check', 'translate', 'safety_classify'];

async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS workflow_definitions (
      workflow_id       TEXT PRIMARY KEY,
      owner_did         TEXT NOT NULL,
      org_id            TEXT,
      name              TEXT NOT NULL,
      description       TEXT,
      trigger_kind      TEXT NOT NULL,
      trigger_config    JSONB NOT NULL DEFAULT '{}'::jsonb,
      actions           JSONB NOT NULL DEFAULT '[]'::jsonb,
      enabled           BOOLEAN NOT NULL DEFAULT TRUE,
      run_count         BIGINT NOT NULL DEFAULT 0,
      last_run_at       TIMESTAMPTZ,
      last_status       TEXT,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_workflow_definitions_owner ON workflow_definitions (owner_did, enabled);
    CREATE INDEX IF NOT EXISTS idx_workflow_definitions_trigger ON workflow_definitions (trigger_kind, enabled);

    CREATE TABLE IF NOT EXISTS workflow_runs (
      run_id            TEXT PRIMARY KEY,
      workflow_id       TEXT NOT NULL,
      trigger_payload   JSONB,
      status            TEXT NOT NULL DEFAULT 'queued',
      started_at        TIMESTAMPTZ,
      finished_at       TIMESTAMPTZ,
      error             TEXT,
      action_results    JSONB,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_workflow_runs_workflow ON workflow_runs (workflow_id, created_at DESC);
  `);
}

function newId(p) { return p + '_' + crypto.randomBytes(10).toString('hex'); }

const actionSchema = z.object({
  kind: z.enum(ACTION_KINDS),
  config: z.record(z.any()).optional(),
  on_error: z.enum(['stop', 'continue', 'retry']).optional()
});

const workflowSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().optional(),
  org_id: z.string().optional(),
  trigger_kind: z.enum(TRIGGER_KINDS),
  trigger_config: z.record(z.any()).optional(),
  actions: z.array(actionSchema).min(1).max(50),
  enabled: z.boolean().optional()
});

// "Execute" a workflow against a trigger payload (stub — real impl dispatches
// to inference/wallet/email/etc primitives). Returns per-action result + status.
async function executeWorkflow(pool, workflow, triggerPayload, auditChain) {
  const runId = newId('wfr');
  await pool.query(
    `INSERT INTO workflow_runs (run_id, workflow_id, trigger_payload, status, started_at)
     VALUES ($1,$2,$3,'running',NOW())`,
    [runId, workflow.workflow_id, JSON.stringify(triggerPayload || {})]
  ).catch(() => {});

  const results = [];
  let status = 'succeeded';
  for (let i = 0; i < workflow.actions.length; i++) {
    const a = workflow.actions[i];
    try {
      // Stubbed dispatch — real impl: switch on a.kind and call the matching primitive.
      results.push({ step: i, kind: a.kind, ok: true, simulated: true });
    } catch (e) {
      results.push({ step: i, kind: a.kind, ok: false, error: e.message });
      if ((a.on_error || 'stop') === 'stop') { status = 'failed'; break; }
    }
  }

  await pool.query(
    `UPDATE workflow_runs SET status=$1, finished_at=NOW(), action_results=$2 WHERE run_id=$3`,
    [status, JSON.stringify(results), runId]
  ).catch(() => {});
  await pool.query(
    `UPDATE workflow_definitions SET run_count = run_count + 1, last_run_at = NOW(), last_status = $1
     WHERE workflow_id = $2`,
    [status, workflow.workflow_id]
  ).catch(() => {});

  if (auditChain) await auditChain.append({
    event_type: 'workflow.executed', workflow_id: workflow.workflow_id, run_id: runId,
    status, action_count: workflow.actions.length
  }).catch(() => {});

  return { run_id: runId, status, results };
}

// Public helper — other primitives call this when their event happens
async function fireTrigger(pool, kind, payload, auditChain) {
  const r = await pool.query(
    `SELECT workflow_id, owner_did, name, trigger_config, actions FROM workflow_definitions
     WHERE trigger_kind = $1 AND enabled = TRUE LIMIT 200`, [kind]
  ).catch(() => ({ rows: [] }));
  let triggered = 0;
  for (const w of r.rows) {
    w.actions = typeof w.actions === 'string' ? JSON.parse(w.actions) : w.actions;
    const cfg = typeof w.trigger_config === 'string' ? JSON.parse(w.trigger_config) : w.trigger_config;
    // Optional filter: only fire for matching agent / amount / etc.
    if (cfg?.agent_did && payload?.agent_did && cfg.agent_did !== payload.agent_did) continue;
    await executeWorkflow(pool, w, payload, auditChain);
    triggered++;
  }
  return { triggered };
}

function registerWorkflowBuilderRoutes(app, pool, verifyAgentAuth, auditChain) {
  const express = require('express');

  app.post('/v1/agents/:did/workflows', express.json(), async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const p = workflowSchema.safeParse(req.body || {});
    if (!p.success) return res.status(400).json({ error: 'invalid_input', details: p.error.flatten() });
    const id = newId('wf');
    await pool.query(
      `INSERT INTO workflow_definitions (workflow_id, owner_did, org_id, name, description,
         trigger_kind, trigger_config, actions, enabled)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [id, did, p.data.org_id || null, p.data.name, p.data.description || null,
       p.data.trigger_kind, JSON.stringify(p.data.trigger_config || {}),
       JSON.stringify(p.data.actions), p.data.enabled !== false]
    );
    if (auditChain) await auditChain.append({ event_type: 'workflow.defined', owner_did: did, workflow_id: id, trigger_kind: p.data.trigger_kind, action_count: p.data.actions.length }).catch(() => {});
    res.status(201).json({ workflow_id: id, status: 'enabled' });
  });

  app.get('/v1/agents/:did/workflows', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(`
      SELECT workflow_id, name, description, trigger_kind, enabled, run_count, last_run_at, last_status, created_at
      FROM workflow_definitions WHERE owner_did=$1 ORDER BY created_at DESC LIMIT 200
    `, [did]).catch(() => ({ rows: [] }));
    res.json({ workflows: r.rows });
  });

  app.post('/v1/agents/:did/workflows/:wid/run', express.json(), async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const w = await pool.query(`SELECT * FROM workflow_definitions WHERE workflow_id=$1 AND owner_did=$2`, [req.params.wid, did])
      .catch(() => ({ rows: [] }));
    if (!w.rows[0]) return res.status(404).json({ error: 'not_found' });
    w.rows[0].actions = typeof w.rows[0].actions === 'string' ? JSON.parse(w.rows[0].actions) : w.rows[0].actions;
    const out = await executeWorkflow(pool, w.rows[0], req.body || {}, auditChain);
    res.status(201).json(out);
  });

  app.post('/v1/agents/:did/workflows/:wid/toggle', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    await pool.query(`UPDATE workflow_definitions SET enabled = NOT enabled WHERE workflow_id=$1 AND owner_did=$2`,
      [req.params.wid, did]).catch(() => {});
    res.json({ workflow_id: req.params.wid });
  });

  app.delete('/v1/agents/:did/workflows/:wid', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    await pool.query(`DELETE FROM workflow_definitions WHERE workflow_id=$1 AND owner_did=$2`,
      [req.params.wid, did]).catch(() => {});
    res.json({ deleted: true });
  });

  app.get('/v1/agents/:did/workflows/:wid/runs', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(`SELECT run_id, status, started_at, finished_at, error FROM workflow_runs
                                WHERE workflow_id=$1 ORDER BY created_at DESC LIMIT 100`, [req.params.wid])
      .catch(() => ({ rows: [] }));
    res.json({ runs: r.rows });
  });

  app.get('/v1/workflows/triggers', (req, res) => res.json({ triggers: TRIGGER_KINDS }));
  app.get('/v1/workflows/actions', (req, res) => res.json({ actions: ACTION_KINDS }));

  // Schedule trigger: cron walks all enabled schedule workflows whose next-run is due
  registerCron(app, '/v1/_jobs/workflow-schedule-tick', async (req, res) => {
    const r = await pool.query(`
      SELECT * FROM workflow_definitions WHERE trigger_kind='schedule' AND enabled = TRUE
    `).catch(() => ({ rows: [] }));
    let fired = 0;
    for (const w of r.rows) {
      const cfg = typeof w.trigger_config === 'string' ? JSON.parse(w.trigger_config) : w.trigger_config;
      const intervalMin = Number(cfg?.interval_minutes || 0);
      if (!intervalMin) continue;
      const lastRun = w.last_run_at ? new Date(w.last_run_at).getTime() : 0;
      if (Date.now() - lastRun >= intervalMin * 60000) {
        w.actions = typeof w.actions === 'string' ? JSON.parse(w.actions) : w.actions;
        await executeWorkflow(pool, w, { kind: 'schedule_tick' }, auditChain);
        fired++;
      }
    }
    res.json({ fired });
  });

  // Webhook trigger
  app.post('/v1/_webhooks/workflow/:wid', express.json({ limit: '5mb' }), async (req, res) => {
    const w = await pool.query(`SELECT * FROM workflow_definitions WHERE workflow_id=$1 AND enabled = TRUE AND trigger_kind='webhook'`, [req.params.wid])
      .catch(() => ({ rows: [] }));
    if (!w.rows[0]) return res.status(404).json({ error: 'not_found_or_disabled' });
    w.rows[0].actions = typeof w.rows[0].actions === 'string' ? JSON.parse(w.rows[0].actions) : w.rows[0].actions;
    const out = await executeWorkflow(pool, w.rows[0], req.body || {}, auditChain);
    res.status(201).json(out);
  });
}

module.exports = { migrate, registerWorkflowBuilderRoutes, executeWorkflow, fireTrigger, TRIGGER_KINDS, ACTION_KINDS };
