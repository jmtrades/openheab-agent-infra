// ============================================================================
// orchestration.js — multi-agent DAG orchestration. The "Airflow for agents".
// Define a graph of agent tasks (nodes), dependencies (edges), inputs/outputs.
// Engine schedules each node when its dependencies satisfy. Audit-chained.
// ============================================================================
const crypto = require('crypto');
const { z } = require('zod');
const { registerCron } = require('../cron_auth');

async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS orchestrations (
      orchestration_id  TEXT PRIMARY KEY,
      owner_did         TEXT NOT NULL,
      org_id            TEXT,
      name              TEXT NOT NULL,
      description       TEXT,
      status            TEXT NOT NULL DEFAULT 'draft',
      max_concurrency   INTEGER NOT NULL DEFAULT 5,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS orchestration_nodes (
      node_id           TEXT PRIMARY KEY,
      orchestration_id  TEXT NOT NULL,
      key               TEXT NOT NULL,
      kind              TEXT NOT NULL,
      agent_did         TEXT,
      action            TEXT NOT NULL,
      params            JSONB,
      depends_on        TEXT[],
      retry_max         INTEGER NOT NULL DEFAULT 1,
      timeout_seconds   INTEGER NOT NULL DEFAULT 300,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (orchestration_id, key)
    );
    CREATE TABLE IF NOT EXISTS orchestration_runs (
      run_id            TEXT PRIMARY KEY,
      orchestration_id  TEXT NOT NULL,
      status            TEXT NOT NULL DEFAULT 'queued',
      started_at        TIMESTAMPTZ,
      finished_at       TIMESTAMPTZ,
      input             JSONB,
      output            JSONB,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS orchestration_node_runs (
      node_run_id       TEXT PRIMARY KEY,
      run_id            TEXT NOT NULL,
      node_id           TEXT NOT NULL,
      node_key          TEXT NOT NULL,
      status            TEXT NOT NULL DEFAULT 'pending',
      attempt           INTEGER NOT NULL DEFAULT 0,
      input             JSONB,
      output            JSONB,
      error             TEXT,
      started_at        TIMESTAMPTZ,
      finished_at       TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_node_runs_run ON orchestration_node_runs (run_id);
    CREATE INDEX IF NOT EXISTS idx_node_runs_pending ON orchestration_node_runs (status) WHERE status IN ('pending','running');
  `);
}

function newId(p) { return p + '_' + crypto.randomBytes(10).toString('hex'); }

const nodeSchema = z.object({
  key: z.string().regex(/^[a-z0-9_-]{1,60}$/),
  kind: z.enum(['inference', 'tool', 'http', 'extension', 'wait', 'branch', 'human_review']),
  agent_did: z.string().optional(),
  action: z.string().min(1),
  params: z.record(z.any()).optional(),
  depends_on: z.array(z.string()).optional(),
  retry_max: z.number().int().min(0).max(10).optional(),
  timeout_seconds: z.number().int().min(1).max(3600).optional()
});

const orchestrationSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().optional(),
  org_id: z.string().optional(),
  max_concurrency: z.number().int().min(1).max(50).optional(),
  nodes: z.array(nodeSchema).min(1).max(200)
});

function registerOrchestrationRoutes(app, pool, verifyAgentAuth, auditChain) {
  const express = require('express');

  app.post('/v1/agents/:did/orchestrations', express.json(), async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const p = orchestrationSchema.safeParse(req.body || {});
    if (!p.success) return res.status(400).json({ error: 'invalid_input', details: p.error.flatten() });

    const orchId = newId('orch');
    await pool.query(
      `INSERT INTO orchestrations (orchestration_id, owner_did, org_id, name, description, max_concurrency, status)
       VALUES ($1,$2,$3,$4,$5,$6,'active')`,
      [orchId, did, p.data.org_id || null, p.data.name, p.data.description || null, p.data.max_concurrency || 5]
    );
    for (const n of p.data.nodes) {
      await pool.query(
        `INSERT INTO orchestration_nodes (node_id, orchestration_id, key, kind, agent_did,
            action, params, depends_on, retry_max, timeout_seconds)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [newId('node'), orchId, n.key, n.kind, n.agent_did || did, n.action,
         n.params ? JSON.stringify(n.params) : null, n.depends_on || null,
         n.retry_max ?? 1, n.timeout_seconds ?? 300]
      );
    }
    if (auditChain) await auditChain.append({ event_type: 'orchestration.created', orchestration_id: orchId, owner_did: did, name: p.data.name }).catch(() => {});
    res.status(201).json({ orchestration_id: orchId, status: 'active' });
  });

  app.post('/v1/agents/:did/orchestrations/:oid/run', express.json(), async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
    if (!auth.valid) return res.status(401).json({ error: auth.error });

    const o = await pool.query(`SELECT * FROM orchestrations WHERE orchestration_id = $1 AND owner_did = $2`,
      [req.params.oid, did]).catch(() => ({ rows: [] }));
    if (!o.rows[0]) return res.status(404).json({ error: 'not_found' });

    const runId = newId('run');
    await pool.query(
      `INSERT INTO orchestration_runs (run_id, orchestration_id, status, input)
       VALUES ($1,$2,'queued',$3)`,
      [runId, req.params.oid, req.body?.input ? JSON.stringify(req.body.input) : null]
    );
    // Create pending node_runs for every node
    const nodes = await pool.query(`SELECT node_id, key FROM orchestration_nodes WHERE orchestration_id = $1`,
      [req.params.oid]).catch(() => ({ rows: [] }));
    for (const n of nodes.rows) {
      await pool.query(
        `INSERT INTO orchestration_node_runs (node_run_id, run_id, node_id, node_key, status)
         VALUES ($1,$2,$3,$4,'pending')`,
        [newId('nrun'), runId, n.node_id, n.key]
      ).catch(() => {});
    }
    if (auditChain) await auditChain.append({ event_type: 'orchestration.run_started', run_id: runId, orchestration_id: req.params.oid }).catch(() => {});
    res.status(201).json({ run_id: runId, status: 'queued', total_nodes: nodes.rows.length });
  });

  app.get('/v1/orchestrations/:oid/runs/:rid', async (req, res) => {
    const r = await pool.query(`SELECT * FROM orchestration_runs WHERE run_id=$1 AND orchestration_id=$2`,
      [req.params.rid, req.params.oid]).catch(() => ({ rows: [] }));
    if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
    const nodes = await pool.query(`
      SELECT node_run_id, node_key, status, attempt, started_at, finished_at, error
      FROM orchestration_node_runs WHERE run_id = $1 ORDER BY node_key
    `, [req.params.rid]).catch(() => ({ rows: [] }));
    res.json({ ...r.rows[0], nodes: nodes.rows });
  });

  // The tick: walk pending node_runs whose dependencies are all satisfied; mark them running and "execute" (stub).
  registerCron(app, '/v1/_jobs/orchestration-tick', async (req, res) => {
    const queued = await pool.query(`SELECT run_id FROM orchestration_runs WHERE status IN ('queued','running') LIMIT 50`)
      .catch(() => ({ rows: [] }));
    let advanced = 0;
    for (const q of queued.rows) {
      const nrs = await pool.query(`
        SELECT nr.node_run_id, nr.node_id, nr.node_key, nr.status, n.depends_on, n.action, n.kind, n.params
        FROM orchestration_node_runs nr JOIN orchestration_nodes n ON n.node_id = nr.node_id
        WHERE nr.run_id = $1
      `, [q.run_id]).catch(() => ({ rows: [] }));

      const statusByKey = Object.fromEntries(nrs.rows.map(x => [x.node_key, x.status]));
      let pendingCount = 0, doneCount = 0, failedCount = 0;
      for (const nr of nrs.rows) {
        if (nr.status === 'succeeded') { doneCount++; continue; }
        if (nr.status === 'failed') { failedCount++; continue; }
        if (nr.status !== 'pending') { pendingCount++; continue; }
        const deps = nr.depends_on || [];
        const ready = deps.every(d => statusByKey[d] === 'succeeded');
        if (!ready) { pendingCount++; continue; }
        // "Execute" — stub. Real impl dispatches to inference / tool / http primitive.
        await pool.query(`UPDATE orchestration_node_runs SET status='succeeded', started_at = NOW(), finished_at=NOW(), output=$1
                          WHERE node_run_id=$2`,
          [JSON.stringify({ kind: nr.kind, action: nr.action, simulated: true }), nr.node_run_id]).catch(() => {});
        statusByKey[nr.node_key] = 'succeeded';
        doneCount++; advanced++;
      }
      if (pendingCount === 0) {
        const final = failedCount > 0 ? 'failed' : 'succeeded';
        await pool.query(`UPDATE orchestration_runs SET status=$1, finished_at=NOW() WHERE run_id=$2`, [final, q.run_id]).catch(() => {});
      } else {
        await pool.query(`UPDATE orchestration_runs SET status='running', started_at=COALESCE(started_at, NOW()) WHERE run_id=$1`, [q.run_id]).catch(() => {});
      }
    }
    res.json({ advanced });
  });
}

module.exports = { migrate, registerOrchestrationRoutes };
