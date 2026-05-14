// ============================================================================
// OpenHeab Deployment — Agent manifests + lifecycle (running/idle/hibernated)
// Tables: deployment_manifests, deployment_events
// Cron: /v1/_jobs/lifecycle-tick — running→idle after idle_minutes,
//                                  idle→hibernated after hibernate_minutes
// ============================================================================
const cryptoLib = require('crypto');
const express = require('express');
const { z } = require('zod');

const RUNTIMES = ['modal', 'e2b', 'fly', 'local'];
const LIFECYCLE_STATES = [
  'draft', 'deploying', 'running', 'idle', 'hibernating',
  'hibernated', 'crashed', 'retired'
];
const EVENT_KINDS = ['state_change', 'scale', 'crash', 'heartbeat'];

// ----------------------------------------------------------------------------
// Migration
// ----------------------------------------------------------------------------
async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS deployment_manifests (
      agent_did          TEXT PRIMARY KEY,
      runtime            TEXT NOT NULL DEFAULT 'modal',
      image              TEXT,
      entrypoint         TEXT,
      env                JSONB,
      cpu                TEXT,
      memory_mb          INTEGER,
      gpu                TEXT,
      min_replicas       INTEGER NOT NULL DEFAULT 0,
      max_replicas       INTEGER NOT NULL DEFAULT 1,
      idle_minutes       INTEGER NOT NULL DEFAULT 30,
      hibernate_minutes  INTEGER NOT NULL DEFAULT 720,
      lifecycle_state    TEXT NOT NULL DEFAULT 'draft',
      last_activity_at   TIMESTAMPTZ,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_deploy_state ON deployment_manifests (lifecycle_state);
    CREATE INDEX IF NOT EXISTS idx_deploy_activity ON deployment_manifests (last_activity_at);

    CREATE TABLE IF NOT EXISTS deployment_events (
      event_id    TEXT PRIMARY KEY,
      agent_did   TEXT NOT NULL,
      kind        TEXT NOT NULL,
      from_state  TEXT,
      to_state    TEXT,
      replicas    INTEGER,
      reason      TEXT,
      meta        JSONB,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_deploy_events_agent ON deployment_events (agent_did, created_at DESC);
  `);
}

function genEventId() {
  return 'devt_' + cryptoLib.randomBytes(12).toString('hex');
}

async function recordEvent(pool, did, kind, from_state, to_state, replicas, reason, meta) {
  await pool.query(
    `INSERT INTO deployment_events (event_id, agent_did, kind, from_state, to_state, replicas, reason, meta)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
    [genEventId(), did, kind, from_state || null, to_state || null,
     replicas ?? null, reason || null, meta ? JSON.stringify(meta) : null]
  ).catch(() => {});
}

// ----------------------------------------------------------------------------
// Lifecycle tick
// ----------------------------------------------------------------------------
async function tickLifecycle(pool) {
  const toIdleR = await pool.query(`
    UPDATE deployment_manifests
       SET lifecycle_state = 'idle', updated_at = NOW()
     WHERE lifecycle_state = 'running'
       AND last_activity_at IS NOT NULL
       AND last_activity_at < NOW() - (idle_minutes || ' minutes')::interval
     RETURNING agent_did, idle_minutes
  `).catch(() => ({ rows: [] }));

  for (const row of toIdleR.rows) {
    await recordEvent(pool, row.agent_did, 'state_change', 'running', 'idle', null,
      `idle_after_${row.idle_minutes}m`, { trigger: 'lifecycle_tick' });
  }

  const toHibR = await pool.query(`
    UPDATE deployment_manifests
       SET lifecycle_state = 'hibernated', updated_at = NOW()
     WHERE lifecycle_state = 'idle'
       AND last_activity_at IS NOT NULL
       AND last_activity_at < NOW() - (hibernate_minutes || ' minutes')::interval
     RETURNING agent_did, hibernate_minutes
  `).catch(() => ({ rows: [] }));

  for (const row of toHibR.rows) {
    await recordEvent(pool, row.agent_did, 'state_change', 'idle', 'hibernated', 0,
      `hibernate_after_${row.hibernate_minutes}m`, { trigger: 'lifecycle_tick' });
  }

  return {
    running_to_idle: toIdleR.rows.length,
    idle_to_hibernated: toHibR.rows.length,
    timestamp: new Date().toISOString()
  };
}

// ----------------------------------------------------------------------------
// Routes
// ----------------------------------------------------------------------------
function registerDeploymentRoutes(app, pool, verifyAgentAuth, auditChain) {
  // POST /v1/agents/:did/deployment
  const ManifestSchema = z.object({
    runtime: z.enum(RUNTIMES).optional(),
    image: z.string().max(512).optional(),
    entrypoint: z.string().max(512).optional(),
    env: z.record(z.any()).optional(),
    cpu: z.string().max(32).optional(),
    memory_mb: z.number().int().positive().max(1024 * 1024).optional(),
    gpu: z.string().max(64).optional(),
    min_replicas: z.number().int().nonnegative().optional(),
    max_replicas: z.number().int().positive().max(1000).optional(),
    idle_minutes: z.number().int().positive().max(60 * 24 * 30).optional(),
    hibernate_minutes: z.number().int().positive().max(60 * 24 * 365).optional()
  });

  app.post('/v1/agents/:did/deployment', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const parse = ManifestSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;

      await pool.query(
        `INSERT INTO deployment_manifests
         (agent_did, runtime, image, entrypoint, env, cpu, memory_mb, gpu,
          min_replicas, max_replicas, idle_minutes, hibernate_minutes,
          lifecycle_state, last_activity_at, updated_at)
         VALUES ($1,
                 COALESCE($2,'modal'),
                 $3,$4,$5::jsonb,$6,$7,$8,
                 COALESCE($9,0),
                 COALESCE($10,1),
                 COALESCE($11,30),
                 COALESCE($12,720),
                 'draft', NOW(), NOW())
         ON CONFLICT (agent_did) DO UPDATE SET
           runtime = COALESCE($2, deployment_manifests.runtime),
           image = COALESCE($3, deployment_manifests.image),
           entrypoint = COALESCE($4, deployment_manifests.entrypoint),
           env = COALESCE($5::jsonb, deployment_manifests.env),
           cpu = COALESCE($6, deployment_manifests.cpu),
           memory_mb = COALESCE($7, deployment_manifests.memory_mb),
           gpu = COALESCE($8, deployment_manifests.gpu),
           min_replicas = COALESCE($9, deployment_manifests.min_replicas),
           max_replicas = COALESCE($10, deployment_manifests.max_replicas),
           idle_minutes = COALESCE($11, deployment_manifests.idle_minutes),
           hibernate_minutes = COALESCE($12, deployment_manifests.hibernate_minutes),
           updated_at = NOW()`,
        [did, d.runtime ?? null, d.image ?? null, d.entrypoint ?? null,
         d.env ? JSON.stringify(d.env) : null,
         d.cpu ?? null, d.memory_mb ?? null, d.gpu ?? null,
         d.min_replicas ?? null, d.max_replicas ?? null,
         d.idle_minutes ?? null, d.hibernate_minutes ?? null]
      );

      await auditChain.append({
        event_type: 'deployment.manifest_set',
        agent_did: did, runtime: d.runtime || 'modal',
        timestamp: new Date().toISOString()
      });

      const r = await pool.query(
        `SELECT * FROM deployment_manifests WHERE agent_did = $1`, [did]
      );
      return res.json(r.rows[0]);
    } catch (e) {
      console.error('[deployment.set]', e);
      return res.status(500).json({ error: 'manifest_set_failed', message: e.message });
    }
  });

  // GET /v1/agents/:did/deployment
  app.get('/v1/agents/:did/deployment', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });

    const r = await pool.query(
      `SELECT * FROM deployment_manifests WHERE agent_did = $1`, [did]
    ).catch(() => ({ rows: [] }));
    if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
    return res.json(r.rows[0]);
  });

  // POST /v1/agents/:did/deployment/state — explicit state change
  const StateSchema = z.object({
    to_state: z.enum(LIFECYCLE_STATES),
    reason: z.string().optional(),
    meta: z.any().optional()
  });
  app.post('/v1/agents/:did/deployment/state', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const parse = StateSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;

      const cur = await pool.query(
        `SELECT lifecycle_state FROM deployment_manifests WHERE agent_did = $1`, [did]
      ).catch(() => ({ rows: [] }));
      if (!cur.rows[0]) return res.status(404).json({ error: 'manifest_not_found' });
      const from = cur.rows[0].lifecycle_state;

      await pool.query(
        `UPDATE deployment_manifests
         SET lifecycle_state = $1, last_activity_at = NOW(), updated_at = NOW()
         WHERE agent_did = $2`,
        [d.to_state, did]
      );

      await recordEvent(pool, did, 'state_change', from, d.to_state, null,
        d.reason || null, d.meta || null);

      await auditChain.append({
        event_type: 'deployment.state_changed',
        agent_did: did, from_state: from, to_state: d.to_state,
        reason: d.reason || null,
        timestamp: new Date().toISOString()
      });

      return res.json({ agent_did: did, from_state: from, to_state: d.to_state });
    } catch (e) {
      console.error('[deployment.state]', e);
      return res.status(500).json({ error: 'state_change_failed', message: e.message });
    }
  });

  // GET /v1/agents/:did/deployment/events
  app.get('/v1/agents/:did/deployment/events', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const limit = Math.min(parseInt(req.query.limit) || 50, 500);
    const r = await pool.query(
      `SELECT * FROM deployment_events WHERE agent_did = $1
       ORDER BY created_at DESC LIMIT $2`, [did, limit]
    ).catch(() => ({ rows: [] }));
    return res.json({ events: r.rows, count: r.rows.length });
  });

  // POST /v1/agents/:did/deployment/scale
  const ScaleSchema = z.object({
    replicas: z.number().int().nonnegative().max(1000),
    reason: z.string().optional()
  });
  app.post('/v1/agents/:did/deployment/scale', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const parse = ScaleSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;

      const cur = await pool.query(
        `SELECT lifecycle_state, max_replicas FROM deployment_manifests WHERE agent_did = $1`, [did]
      ).catch(() => ({ rows: [] }));
      if (!cur.rows[0]) return res.status(404).json({ error: 'manifest_not_found' });
      if (d.replicas > cur.rows[0].max_replicas) {
        return res.status(400).json({ error: 'replicas_exceed_max', max_replicas: cur.rows[0].max_replicas });
      }

      const fromState = cur.rows[0].lifecycle_state;
      const toState = d.replicas > 0 ? 'running' : 'idle';

      await pool.query(
        `UPDATE deployment_manifests
         SET lifecycle_state = $1, last_activity_at = NOW(), updated_at = NOW()
         WHERE agent_did = $2`,
        [toState, did]
      );

      await recordEvent(pool, did, 'scale', fromState, toState, d.replicas,
        d.reason || null, null);

      await auditChain.append({
        event_type: 'deployment.scaled',
        agent_did: did, replicas: d.replicas, to_state: toState,
        timestamp: new Date().toISOString()
      });

      return res.json({ agent_did: did, replicas: d.replicas, lifecycle_state: toState });
    } catch (e) {
      console.error('[deployment.scale]', e);
      return res.status(500).json({ error: 'scale_failed', message: e.message });
    }
  });

  // Cron
  const { registerCron } = require('../cron_auth');
  registerCron(app, '/v1/_jobs/lifecycle-tick', async (req, res) => {
    try {
      const out = await tickLifecycle(pool);
      return res.json(out);
    } catch (e) {
      return res.status(500).json({ error: 'tick_failed', message: e.message });
    }
  });
}

module.exports = {
  migrate,
  registerDeploymentRoutes,
  tickLifecycle,
  LIFECYCLE_STATES,
  RUNTIMES,
  EVENT_KINDS
};
