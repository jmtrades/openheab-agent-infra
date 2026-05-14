// ============================================================================
// OpenHeab Scheduler — Per-agent crontab; HTTP-based scheduled task runner
// ============================================================================
const express = require('express');
const cryptoLib = require('crypto');
const { z } = require('zod');

const VALID_INTERVALS = {
  minute: 60_000,
  hourly: 3600_000,
  daily: 86400_000,
  weekly: 604800_000,
  monthly: 2_592_000_000
};

// ----------------------------------------------------------------------------
// Migration
// ----------------------------------------------------------------------------
async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      task_id          TEXT PRIMARY KEY,
      agent_did        TEXT NOT NULL,
      name             TEXT NOT NULL,
      method           TEXT NOT NULL DEFAULT 'POST',
      url              TEXT NOT NULL,
      headers          JSONB NOT NULL DEFAULT '{}'::jsonb,
      body             JSONB,
      interval         TEXT NOT NULL,
      timezone         TEXT NOT NULL DEFAULT 'UTC',
      status           TEXT NOT NULL DEFAULT 'active',
      next_run_at      TIMESTAMPTZ NOT NULL,
      last_run_at      TIMESTAMPTZ,
      run_count        BIGINT NOT NULL DEFAULT 0,
      success_count    BIGINT NOT NULL DEFAULT 0,
      failure_count    BIGINT NOT NULL DEFAULT 0,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_agent ON scheduled_tasks (agent_did);
    CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_next_run ON scheduled_tasks (next_run_at) WHERE status='active';

    CREATE TABLE IF NOT EXISTS scheduled_task_runs (
      run_id        TEXT PRIMARY KEY,
      task_id       TEXT NOT NULL,
      started_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      finished_at   TIMESTAMPTZ,
      status_code   INTEGER,
      success       BOOLEAN,
      response_body TEXT,
      error         TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_scheduled_runs_task ON scheduled_task_runs (task_id, started_at DESC);
  `).catch(() => {});
}

function genId(prefix) {
  return `${prefix}_${cryptoLib.randomBytes(12).toString('hex')}`;
}

function computeNextRun(intervalKey, from = Date.now()) {
  const ms = VALID_INTERVALS[intervalKey];
  if (!ms) return new Date(from + 60_000);
  return new Date(from + ms);
}

// ----------------------------------------------------------------------------
// Routes
// ----------------------------------------------------------------------------
function registerSchedulerRoutes(app, pool, verifyAgentAuth, auditChain) {
  const CreateSchema = z.object({
    name: z.string().min(1).max(200),
    method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).default('POST'),
    url: z.string().url(),
    headers: z.record(z.string()).optional(),
    body: z.any().optional(),
    interval: z.enum(Object.keys(VALID_INTERVALS)),
    timezone: z.string().default('UTC'),
    start_at: z.string().datetime().optional()
  });

  // POST /v1/agents/:did/schedules
  app.post('/v1/agents/:did/schedules', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const parse = CreateSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;

      const taskId = genId('sched');
      const startTs = d.start_at ? new Date(d.start_at).getTime() : Date.now();
      const nextRunAt = computeNextRun(d.interval, startTs);

      await pool.query(
        `INSERT INTO scheduled_tasks (task_id, agent_did, name, method, url, headers,
          body, interval, timezone, status, next_run_at)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,'active',$10)`,
        [taskId, did, d.name, d.method, d.url,
         JSON.stringify(d.headers || {}),
         d.body !== undefined ? JSON.stringify(d.body) : null,
         d.interval, d.timezone, nextRunAt]
      );

      await auditChain.append({
        event_type: 'scheduler.task_created',
        task_id: taskId, agent_did: did, name: d.name, interval: d.interval,
        timestamp: new Date().toISOString()
      });

      return res.status(201).json({
        task_id: taskId, agent_did: did, name: d.name,
        interval: d.interval, next_run_at: nextRunAt, status: 'active'
      });
    } catch (e) {
      console.error('[scheduler.create]', e);
      return res.status(500).json({ error: 'create_failed', message: e.message });
    }
  });

  // GET /v1/agents/:did/schedules
  app.get('/v1/agents/:did/schedules', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(
      `SELECT task_id, name, method, url, interval, timezone, status,
              next_run_at, last_run_at, run_count, success_count, failure_count, created_at
       FROM scheduled_tasks WHERE agent_did=$1 ORDER BY created_at DESC`,
      [did]
    ).catch(() => ({ rows: [] }));
    return res.json({ tasks: r.rows, count: r.rows.length });
  });

  // POST /v1/agents/:did/schedules/:id/pause
  app.post('/v1/agents/:did/schedules/:id/pause', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(
      `UPDATE scheduled_tasks SET status='paused' WHERE task_id=$1 AND agent_did=$2 RETURNING task_id`,
      [req.params.id, did]
    ).catch(() => ({ rows: [] }));
    if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
    await auditChain.append({
      event_type: 'scheduler.task_paused',
      task_id: req.params.id, agent_did: did,
      timestamp: new Date().toISOString()
    });
    return res.json({ task_id: req.params.id, status: 'paused' });
  });

  // POST /v1/agents/:did/schedules/:id/resume
  app.post('/v1/agents/:did/schedules/:id/resume', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const row = await pool.query(
      `SELECT interval FROM scheduled_tasks WHERE task_id=$1 AND agent_did=$2`,
      [req.params.id, did]
    ).catch(() => ({ rows: [] }));
    if (!row.rows[0]) return res.status(404).json({ error: 'not_found' });
    const nextRunAt = computeNextRun(row.rows[0].interval);
    await pool.query(
      `UPDATE scheduled_tasks SET status='active', next_run_at=$1 WHERE task_id=$2 AND agent_did=$3`,
      [nextRunAt, req.params.id, did]
    );
    await auditChain.append({
      event_type: 'scheduler.task_resumed',
      task_id: req.params.id, agent_did: did,
      timestamp: new Date().toISOString()
    });
    return res.json({ task_id: req.params.id, status: 'active', next_run_at: nextRunAt });
  });

  // DELETE /v1/agents/:did/schedules/:id
  app.delete('/v1/agents/:did/schedules/:id', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(
      `DELETE FROM scheduled_tasks WHERE task_id=$1 AND agent_did=$2 RETURNING task_id`,
      [req.params.id, did]
    ).catch(() => ({ rows: [] }));
    if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
    await auditChain.append({
      event_type: 'scheduler.task_deleted',
      task_id: req.params.id, agent_did: did,
      timestamp: new Date().toISOString()
    });
    return res.json({ deleted: true, task_id: req.params.id });
  });

  // GET /v1/agents/:did/schedules/:id/runs
  app.get('/v1/agents/:did/schedules/:id/runs', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const owns = await pool.query(
      `SELECT task_id FROM scheduled_tasks WHERE task_id=$1 AND agent_did=$2`,
      [req.params.id, did]
    ).catch(() => ({ rows: [] }));
    if (!owns.rows[0]) return res.status(404).json({ error: 'not_found' });
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const r = await pool.query(
      `SELECT run_id, started_at, finished_at, status_code, success, error
       FROM scheduled_task_runs WHERE task_id=$1 ORDER BY started_at DESC LIMIT $2`,
      [req.params.id, limit]
    ).catch(() => ({ rows: [] }));
    return res.json({ runs: r.rows, count: r.rows.length });
  });

  // Cron tick
  const { registerCron } = require('../cron_auth');
  registerCron(app, '/v1/_jobs/scheduler-tick', async (req, res) => {
    try {
      const r = await tickScheduler(pool, auditChain);
      res.json(r);
    } catch (e) {
      res.status(500).json({ error: 'tick_failed', message: e.message });
    }
  });
}

// ----------------------------------------------------------------------------
// Tick — fire due tasks
// ----------------------------------------------------------------------------
async function tickScheduler(pool, auditChain) {
  const due = await pool.query(
    `SELECT task_id, agent_did, name, method, url, headers, body, interval
     FROM scheduled_tasks WHERE status='active' AND next_run_at <= NOW()
     ORDER BY next_run_at ASC LIMIT 50`
  ).catch(() => ({ rows: [] }));

  let fired = 0;
  for (const t of due.rows) {
    fired += 1;
    const runId = genId('schrun');
    const started = new Date();
    let success = false;
    let statusCode = null;
    let errMsg = null;
    let responseBody = null;
    const headers = t.headers && typeof t.headers === 'object' ? t.headers : {};
    const body = t.body;

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30_000);
      try {
        const init = {
          method: t.method || 'POST',
          headers: { 'content-type': 'application/json', ...headers },
          signal: controller.signal
        };
        if (body !== null && body !== undefined && t.method !== 'GET') {
          init.body = typeof body === 'string' ? body : JSON.stringify(body);
        }
        const resp = await fetch(t.url, init);
        statusCode = resp.status;
        success = resp.ok;
        try { responseBody = (await resp.text()).slice(0, 2000); } catch {}
      } finally {
        clearTimeout(timer);
      }
    } catch (e) {
      errMsg = (e && e.message) || String(e);
      success = false;
    }

    const finished = new Date();
    const nextRunAt = computeNextRun(t.interval, finished.getTime());

    await pool.query(
      `INSERT INTO scheduled_task_runs
        (run_id, task_id, started_at, finished_at, status_code, success, response_body, error)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [runId, t.task_id, started, finished, statusCode, success, responseBody, errMsg]
    ).catch(() => {});

    await pool.query(
      `UPDATE scheduled_tasks SET
         run_count = run_count + 1,
         success_count = success_count + $1,
         failure_count = failure_count + $2,
         last_run_at = $3,
         next_run_at = $4
       WHERE task_id = $5`,
      [success ? 1 : 0, success ? 0 : 1, finished, nextRunAt, t.task_id]
    ).catch(() => {});

    if (auditChain) {
      auditChain.append({
        event_type: 'scheduler.task_executed',
        task_id: t.task_id, agent_did: t.agent_did,
        success, status_code: statusCode,
        timestamp: finished.toISOString()
      }).catch(() => {});
    }
  }

  return { fired, checked: due.rows.length };
}

module.exports = {
  migrate,
  registerSchedulerRoutes,
  tickScheduler,
  VALID_INTERVALS
};
