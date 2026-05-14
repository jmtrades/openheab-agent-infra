// ============================================================================
// OpenHeab Goals — Hierarchical goal management
// Goals form a tree; metrics drive progress; conflicts detected and resolved.
// ============================================================================
const express = require('express');
const cryptoLib = require('crypto');
const { z } = require('zod');

const GOAL_STATUSES = ['active', 'achieved', 'paused', 'abandoned'];
const CONFLICT_KINDS = ['resource', 'time', 'value'];
const CONFLICT_RESOLUTIONS = ['prefer_a', 'prefer_b', 'compromise', 'abandon'];

// ----------------------------------------------------------------------------
// Migration
// ----------------------------------------------------------------------------
async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS goals (
      goal_id          TEXT PRIMARY KEY,
      agent_did        TEXT NOT NULL,
      parent_goal_id   TEXT,
      description      TEXT NOT NULL,
      priority         INTEGER NOT NULL DEFAULT 5,
      status           TEXT NOT NULL DEFAULT 'active',
      deadline         TIMESTAMPTZ,
      success_metric   JSONB,
      progress_pct     REAL NOT NULL DEFAULT 0,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      achieved_at      TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_goals_agent ON goals (agent_did, priority DESC, status);
    CREATE INDEX IF NOT EXISTS idx_goals_parent ON goals (parent_goal_id);
    CREATE INDEX IF NOT EXISTS idx_goals_deadline ON goals (deadline);

    CREATE TABLE IF NOT EXISTS goal_conflicts (
      conflict_id   TEXT PRIMARY KEY,
      agent_did     TEXT NOT NULL,
      goal_a_id     TEXT NOT NULL,
      goal_b_id     TEXT NOT NULL,
      kind          TEXT NOT NULL,
      resolution    TEXT,
      detected_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      resolved_at   TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_goal_conflicts_agent ON goal_conflicts (agent_did, detected_at DESC);

    CREATE TABLE IF NOT EXISTS goal_metrics (
      metric_id        TEXT PRIMARY KEY,
      goal_id          TEXT NOT NULL,
      name             TEXT NOT NULL,
      current_value    REAL,
      target_value     REAL,
      unit             TEXT,
      last_updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (goal_id, name)
    );
    CREATE INDEX IF NOT EXISTS idx_goal_metrics_goal ON goal_metrics (goal_id);
  `);
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------
function genId(prefix) {
  return prefix + '_' + cryptoLib.randomBytes(12).toString('hex');
}

function buildTree(rows) {
  const byId = new Map();
  const roots = [];
  for (const r of rows) { r.children = []; byId.set(r.goal_id, r); }
  for (const r of rows) {
    if (r.parent_goal_id && byId.has(r.parent_goal_id)) {
      byId.get(r.parent_goal_id).children.push(r);
    } else {
      roots.push(r);
    }
  }
  return roots;
}

// Simple resource/value extraction from JSONB success_metric/description
function detectConflictKind(a, b) {
  // Time conflict: overlapping near deadlines (within 24h)
  if (a.deadline && b.deadline) {
    const da = new Date(a.deadline).getTime();
    const db = new Date(b.deadline).getTime();
    if (Math.abs(da - db) < 24 * 3600 * 1000 && a.priority >= 7 && b.priority >= 7) {
      return 'time';
    }
  }
  // Resource conflict: explicit resources listed in success_metric
  const ra = (a.success_metric && a.success_metric.resources) || [];
  const rb = (b.success_metric && b.success_metric.resources) || [];
  for (const r of ra) if (rb.includes(r)) return 'resource';

  // Value conflict: explicit value tag mismatch
  const va = (a.success_metric && a.success_metric.value);
  const vb = (b.success_metric && b.success_metric.value);
  if (va && vb && va !== vb &&
      a.description.toLowerCase().split(/\s+/).filter(t => b.description.toLowerCase().includes(t)).length >= 3) {
    return 'value';
  }
  return null;
}

async function recomputeProgress(pool, goalId) {
  const m = await pool.query(`
    SELECT current_value, target_value
    FROM goal_metrics WHERE goal_id = $1
  `, [goalId]).catch(() => ({ rows: [] }));
  if (!m.rows.length) return null;
  let total = 0;
  let count = 0;
  for (const row of m.rows) {
    if (row.target_value && row.target_value !== 0) {
      total += Math.min(1, Math.max(0, (row.current_value || 0) / row.target_value));
      count++;
    }
  }
  if (count === 0) return null;
  const pct = Math.round((total / count) * 10000) / 100;
  await pool.query(`UPDATE goals SET progress_pct = $2, updated_at = NOW() WHERE goal_id = $1`,
    [goalId, pct]).catch(() => {});
  return pct;
}

// ----------------------------------------------------------------------------
// Schemas
// ----------------------------------------------------------------------------
const CreateGoalSchema = z.object({
  description:    z.string().min(1).max(2000),
  parent_goal_id: z.string().optional(),
  priority:       z.number().int().min(0).max(10).optional(),
  status:         z.enum(GOAL_STATUSES).optional(),
  deadline:       z.string().datetime().optional(),
  success_metric: z.record(z.any()).optional()
});

const UpdateProgressSchema = z.object({
  progress_pct: z.number().min(0).max(100).optional(),
  metrics:      z.array(z.object({
    name:          z.string().min(1).max(128),
    current_value: z.number(),
    target_value:  z.number().optional(),
    unit:          z.string().optional()
  })).optional()
});

const ResolveConflictSchema = z.object({
  resolution: z.enum(CONFLICT_RESOLUTIONS)
});

// ----------------------------------------------------------------------------
// Routes
// ----------------------------------------------------------------------------
function registerGoalsRoutes(app, pool, verifyAgentAuth, auditChain) {
  // POST /v1/agents/:did/goals
  app.post('/v1/agents/:did/goals', express.json(), async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const parse = CreateGoalSchema.safeParse(req.body || {});
    if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
    const d = parse.data;
    const id = genId('goal');
    await pool.query(`
      INSERT INTO goals
      (goal_id, agent_did, parent_goal_id, description, priority,
       status, deadline, success_metric)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
    `, [id, did, d.parent_goal_id || null, d.description,
        d.priority ?? 5, d.status || 'active', d.deadline || null,
        d.success_metric ? JSON.stringify(d.success_metric) : null]);
    await auditChain.append({
      event_type: 'goal.created',
      goal_id: id, agent_did: did, parent_goal_id: d.parent_goal_id || null,
      priority: d.priority ?? 5, timestamp: new Date().toISOString()
    });
    return res.status(201).json({
      goal_id: id, agent_did: did, description: d.description,
      priority: d.priority ?? 5, status: d.status || 'active'
    });
  });

  // GET /v1/agents/:did/goals
  app.get('/v1/agents/:did/goals', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const status = req.query.status;
    const minPriority = parseInt(req.query.min_priority || '0');
    const treeMode = req.query.tree !== 'false';

    const params = [did, minPriority];
    let extra = '';
    if (status) { params.push(status); extra = ` AND status = $${params.length}`; }

    // Recursive CTE: pull descendants of any matching goal
    const r = await pool.query(`
      WITH RECURSIVE root_goals AS (
        SELECT goal_id, agent_did, parent_goal_id, description, priority,
               status, deadline, success_metric, progress_pct,
               created_at, updated_at, achieved_at
        FROM goals
        WHERE agent_did = $1 AND priority >= $2 ${extra}
      ),
      tree AS (
        SELECT * FROM root_goals
        UNION
        SELECT g.goal_id, g.agent_did, g.parent_goal_id, g.description,
               g.priority, g.status, g.deadline, g.success_metric,
               g.progress_pct, g.created_at, g.updated_at, g.achieved_at
        FROM goals g
        INNER JOIN tree t ON g.parent_goal_id = t.goal_id
        WHERE g.agent_did = $1
      )
      SELECT * FROM tree
      ORDER BY priority DESC, created_at ASC
    `, params).catch(() => ({ rows: [] }));

    if (treeMode) {
      return res.json({ agent_did: did, goals: buildTree(r.rows), count: r.rows.length });
    }
    return res.json({ agent_did: did, goals: r.rows, count: r.rows.length });
  });

  // GET /v1/agents/:did/goals/:id
  app.get('/v1/agents/:did/goals/:id', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const g = await pool.query(`SELECT * FROM goals WHERE goal_id=$1 AND agent_did=$2`,
      [req.params.id, did]).catch(() => ({ rows: [] }));
    if (!g.rows[0]) return res.status(404).json({ error: 'not_found' });
    const m = await pool.query(`SELECT * FROM goal_metrics WHERE goal_id=$1`, [req.params.id])
      .catch(() => ({ rows: [] }));
    return res.json({ ...g.rows[0], metrics: m.rows });
  });

  // PUT /v1/agents/:did/goals/:id/progress
  app.put('/v1/agents/:did/goals/:id/progress', express.json(), async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const parse = UpdateProgressSchema.safeParse(req.body || {});
    if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
    const d = parse.data;

    const own = await pool.query(`SELECT 1 FROM goals WHERE goal_id=$1 AND agent_did=$2`,
      [req.params.id, did]).catch(() => ({ rows: [] }));
    if (!own.rows[0]) return res.status(404).json({ error: 'goal_not_found' });

    if (d.metrics && d.metrics.length) {
      for (const m of d.metrics) {
        await pool.query(`
          INSERT INTO goal_metrics
          (metric_id, goal_id, name, current_value, target_value, unit)
          VALUES ($1, $2, $3, $4, $5, $6)
          ON CONFLICT (goal_id, name) DO UPDATE
          SET current_value = EXCLUDED.current_value,
              target_value  = COALESCE(EXCLUDED.target_value, goal_metrics.target_value),
              unit          = COALESCE(EXCLUDED.unit, goal_metrics.unit),
              last_updated_at = NOW()
        `, [genId('mtr'), req.params.id, m.name, m.current_value,
            m.target_value ?? null, m.unit ?? null]).catch(() => {});
      }
    }

    let progress = d.progress_pct;
    if (progress === undefined) {
      progress = await recomputeProgress(pool, req.params.id);
    } else {
      await pool.query(
        `UPDATE goals SET progress_pct = $2, updated_at = NOW() WHERE goal_id = $1`,
        [req.params.id, progress]
      );
    }

    await auditChain.append({
      event_type: 'goal.progress_updated',
      goal_id: req.params.id, agent_did: did,
      progress_pct: progress, timestamp: new Date().toISOString()
    });
    return res.json({ goal_id: req.params.id, progress_pct: progress });
  });

  // POST /v1/agents/:did/goals/:id/achieve
  app.post('/v1/agents/:did/goals/:id/achieve', express.json(), async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(`
      UPDATE goals SET status='achieved', progress_pct=100,
                        achieved_at=NOW(), updated_at=NOW()
      WHERE goal_id=$1 AND agent_did=$2 AND status != 'achieved'
      RETURNING goal_id, status, achieved_at
    `, [req.params.id, did]).catch(() => ({ rows: [] }));
    if (!r.rows[0]) return res.status(404).json({ error: 'not_found_or_already_achieved' });
    await auditChain.append({
      event_type: 'goal.achieved',
      goal_id: req.params.id, agent_did: did,
      timestamp: new Date().toISOString()
    });
    return res.json(r.rows[0]);
  });

  // POST /v1/agents/:did/goals/:id/abandon
  app.post('/v1/agents/:did/goals/:id/abandon', express.json(), async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const reason = (req.body && req.body.reason) || null;
    const r = await pool.query(`
      UPDATE goals SET status='abandoned', updated_at=NOW()
      WHERE goal_id=$1 AND agent_did=$2 AND status NOT IN ('abandoned','achieved')
      RETURNING goal_id, status
    `, [req.params.id, did]).catch(() => ({ rows: [] }));
    if (!r.rows[0]) return res.status(404).json({ error: 'not_found_or_terminal' });
    await auditChain.append({
      event_type: 'goal.abandoned',
      goal_id: req.params.id, agent_did: did, reason,
      timestamp: new Date().toISOString()
    });
    return res.json({ ...r.rows[0], reason });
  });

  // GET /v1/agents/:did/goals/conflicts — auto-detect
  app.get('/v1/agents/:did/goals/conflicts', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(`
      SELECT goal_id, description, priority, deadline, success_metric, status
      FROM goals WHERE agent_did=$1 AND status='active'
      ORDER BY priority DESC LIMIT 300
    `, [did]).catch(() => ({ rows: [] }));

    const detected = [];
    for (let i = 0; i < r.rows.length; i++) {
      for (let j = i + 1; j < r.rows.length; j++) {
        const kind = detectConflictKind(r.rows[i], r.rows[j]);
        if (!kind) continue;
        const dup = await pool.query(`
          SELECT conflict_id FROM goal_conflicts
          WHERE agent_did=$1 AND resolved_at IS NULL
            AND ((goal_a_id=$2 AND goal_b_id=$3) OR (goal_a_id=$3 AND goal_b_id=$2))
          LIMIT 1
        `, [did, r.rows[i].goal_id, r.rows[j].goal_id]).catch(() => ({ rows: [] }));
        if (dup.rows[0]) {
          detected.push({ conflict_id: dup.rows[0].conflict_id, goal_a_id: r.rows[i].goal_id,
                          goal_b_id: r.rows[j].goal_id, kind, existing: true });
          continue;
        }
        const cid = genId('cnf');
        await pool.query(`
          INSERT INTO goal_conflicts
          (conflict_id, agent_did, goal_a_id, goal_b_id, kind)
          VALUES ($1, $2, $3, $4, $5)
        `, [cid, did, r.rows[i].goal_id, r.rows[j].goal_id, kind]).catch(() => {});
        detected.push({ conflict_id: cid, goal_a_id: r.rows[i].goal_id,
                        goal_b_id: r.rows[j].goal_id, kind });
      }
    }
    return res.json({ agent_did: did, conflicts: detected, count: detected.length });
  });

  // POST /v1/agents/:did/goals/conflicts/:id/resolve
  app.post('/v1/agents/:did/goals/conflicts/:id/resolve', express.json(), async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const parse = ResolveConflictSchema.safeParse(req.body || {});
    if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });

    const c = await pool.query(
      `SELECT goal_a_id, goal_b_id FROM goal_conflicts WHERE conflict_id=$1 AND agent_did=$2`,
      [req.params.id, did]
    ).catch(() => ({ rows: [] }));
    if (!c.rows[0]) return res.status(404).json({ error: 'conflict_not_found' });

    await pool.query(`
      UPDATE goal_conflicts SET resolution=$2, resolved_at=NOW()
      WHERE conflict_id=$1
    `, [req.params.id, parse.data.resolution]);

    if (parse.data.resolution === 'prefer_a') {
      await pool.query(`UPDATE goals SET status='paused', updated_at=NOW() WHERE goal_id=$1`,
        [c.rows[0].goal_b_id]).catch(() => {});
    } else if (parse.data.resolution === 'prefer_b') {
      await pool.query(`UPDATE goals SET status='paused', updated_at=NOW() WHERE goal_id=$1`,
        [c.rows[0].goal_a_id]).catch(() => {});
    } else if (parse.data.resolution === 'abandon') {
      await pool.query(`UPDATE goals SET status='abandoned', updated_at=NOW() WHERE goal_id IN ($1,$2)`,
        [c.rows[0].goal_a_id, c.rows[0].goal_b_id]).catch(() => {});
    }
    await auditChain.append({
      event_type: 'goal.conflict_resolved',
      conflict_id: req.params.id, resolution: parse.data.resolution,
      agent_did: did, timestamp: new Date().toISOString()
    });
    return res.json({ conflict_id: req.params.id, resolution: parse.data.resolution });
  });
}

module.exports = {
  migrate,
  registerGoalsRoutes,
  detectConflictKind,
  recomputeProgress,
  GOAL_STATUSES,
  CONFLICT_KINDS,
  CONFLICT_RESOLUTIONS
};
