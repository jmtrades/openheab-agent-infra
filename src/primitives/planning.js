// ============================================================================
// OpenHeab Planning — Goal-driven plan generation + execution tracking
// Higher-level than workflows: goals → multi-step plans, with revisions.
// ============================================================================
const express = require('express');
const cryptoLib = require('crypto');
const { z } = require('zod');

const PLAN_STATUSES = ['draft', 'active', 'completed', 'abandoned', 'blocked'];
const STEP_STATUSES = ['pending', 'in_progress', 'completed', 'skipped', 'failed'];
const STEP_KINDS    = ['action', 'decision', 'observation', 'wait', 'subplan'];

// ----------------------------------------------------------------------------
// Migration
// ----------------------------------------------------------------------------
async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS plans (
      plan_id           TEXT PRIMARY KEY,
      agent_did         TEXT NOT NULL,
      goal              TEXT NOT NULL,
      parent_plan_id    TEXT,
      status            TEXT NOT NULL DEFAULT 'draft',
      root_step_id      TEXT,
      success_criteria  JSONB,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at      TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_plans_agent ON plans (agent_did, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_plans_parent ON plans (parent_plan_id);
    CREATE INDEX IF NOT EXISTS idx_plans_status ON plans (status);

    CREATE TABLE IF NOT EXISTS plan_steps (
      step_id           TEXT PRIMARY KEY,
      plan_id           TEXT NOT NULL,
      parent_step_id    TEXT,
      sequence          INTEGER NOT NULL DEFAULT 0,
      kind              TEXT NOT NULL DEFAULT 'action',
      description       TEXT NOT NULL,
      expected_outcome  TEXT,
      actual_outcome    TEXT,
      status            TEXT NOT NULL DEFAULT 'pending',
      dependencies      TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
      started_at        TIMESTAMPTZ,
      completed_at      TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_plan_steps_plan ON plan_steps (plan_id, sequence);
    CREATE INDEX IF NOT EXISTS idx_plan_steps_parent ON plan_steps (parent_step_id);
    CREATE INDEX IF NOT EXISTS idx_plan_steps_status ON plan_steps (status);

    CREATE TABLE IF NOT EXISTS plan_revisions (
      revision_id   TEXT PRIMARY KEY,
      plan_id       TEXT NOT NULL,
      agent_did     TEXT NOT NULL,
      reason        TEXT,
      diff          JSONB NOT NULL,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_plan_revisions_plan ON plan_revisions (plan_id, created_at DESC);
  `);
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------
function genId(prefix) {
  return prefix + '_' + cryptoLib.randomBytes(12).toString('hex');
}

// Lightweight LLM-style step generator. Tries openai if present; falls back to
// heuristic decomposition based on the goal text.
async function generateStepsForGoal(goal, opts = {}) {
  const max = Math.min(opts.max || 6, 12);
  if (process.env.OPENAI_API_KEY) {
    try {
      const resp = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model: process.env.OPENAI_PLANNING_MODEL || 'gpt-4o-mini',
          messages: [
            { role: 'system', content: 'You decompose a goal into 3-6 concrete, ordered, atomic steps. Reply ONLY with JSON: {"steps":[{"description":"...","expected_outcome":"...","kind":"action|decision|observation|wait|subplan"}]}' },
            { role: 'user', content: `Goal: ${goal}` }
          ],
          temperature: 0.2,
          response_format: { type: 'json_object' }
        })
      });
      if (resp.ok) {
        const j = await resp.json();
        const parsed = JSON.parse(j.choices?.[0]?.message?.content || '{}');
        if (Array.isArray(parsed.steps) && parsed.steps.length) {
          return parsed.steps.slice(0, max).map((s, i) => ({
            description: String(s.description || `Step ${i + 1}`).slice(0, 500),
            expected_outcome: s.expected_outcome ? String(s.expected_outcome).slice(0, 500) : null,
            kind: STEP_KINDS.includes(s.kind) ? s.kind : 'action'
          }));
        }
      }
    } catch (e) { /* fall through */ }
  }
  // Heuristic fallback: 4-step plan
  return [
    { description: `Clarify scope: ${goal.slice(0, 200)}`,                kind: 'observation', expected_outcome: 'Scope captured' },
    { description: `Identify resources needed for goal`,                  kind: 'decision',    expected_outcome: 'Resource list' },
    { description: `Execute primary action toward goal`,                  kind: 'action',      expected_outcome: 'Forward progress' },
    { description: `Verify outcome satisfies success criteria`,           kind: 'observation', expected_outcome: 'Goal achieved or revised' }
  ];
}

async function loadStepTree(pool, planId) {
  const r = await pool.query(`
    SELECT step_id, plan_id, parent_step_id, sequence, kind, description,
           expected_outcome, actual_outcome, status, dependencies,
           started_at, completed_at
    FROM plan_steps WHERE plan_id = $1 ORDER BY sequence ASC, step_id ASC
  `, [planId]).catch(() => ({ rows: [] }));

  const byId = new Map();
  const roots = [];
  for (const s of r.rows) { s.children = []; byId.set(s.step_id, s); }
  for (const s of r.rows) {
    if (s.parent_step_id && byId.has(s.parent_step_id)) {
      byId.get(s.parent_step_id).children.push(s);
    } else {
      roots.push(s);
    }
  }
  return roots;
}

// ----------------------------------------------------------------------------
// Schemas
// ----------------------------------------------------------------------------
const CreatePlanSchema = z.object({
  goal:             z.string().min(1).max(2000),
  parent_plan_id:   z.string().optional(),
  success_criteria: z.record(z.any()).optional(),
  generate_steps:   z.boolean().optional(),
  steps:            z.array(z.object({
    description:      z.string().min(1).max(500),
    expected_outcome: z.string().max(500).optional(),
    kind:             z.enum(STEP_KINDS).optional(),
    dependencies:     z.array(z.string()).optional()
  })).optional(),
  status:           z.enum(PLAN_STATUSES).optional()
});

const AppendStepSchema = z.object({
  parent_step_id:   z.string().optional(),
  sequence:         z.number().int().optional(),
  kind:             z.enum(STEP_KINDS).optional(),
  description:      z.string().min(1).max(500),
  expected_outcome: z.string().max(500).optional(),
  dependencies:     z.array(z.string()).optional()
});

const UpdateStepSchema = z.object({
  status:         z.enum(STEP_STATUSES).optional(),
  actual_outcome: z.string().max(2000).optional()
});

const ReviseSchema = z.object({
  reason:           z.string().min(1).max(2000),
  goal:             z.string().min(1).max(2000).optional(),
  success_criteria: z.record(z.any()).optional(),
  regenerate:       z.boolean().optional()
});

// ----------------------------------------------------------------------------
// Routes
// ----------------------------------------------------------------------------
function registerPlanningRoutes(app, pool, verifyAgentAuth, auditChain) {
  // POST /v1/agents/:did/plans
  app.post('/v1/agents/:did/plans', express.json(), async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const parse = CreatePlanSchema.safeParse(req.body || {});
    if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
    const d = parse.data;

    const planId = genId('plan');
    await pool.query(`
      INSERT INTO plans (plan_id, agent_did, goal, parent_plan_id, status, success_criteria, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6::jsonb, NOW())
    `, [planId, did, d.goal, d.parent_plan_id || null,
        d.status || 'draft',
        d.success_criteria ? JSON.stringify(d.success_criteria) : null]).catch(e => {
      throw e;
    });

    let steps = d.steps || [];
    if ((!steps || steps.length === 0) && d.generate_steps !== false) {
      steps = await generateStepsForGoal(d.goal).catch(() => []);
    }

    let rootStepId = null;
    let seq = 0;
    for (const s of steps) {
      const sid = genId('step');
      if (!rootStepId) rootStepId = sid;
      await pool.query(`
        INSERT INTO plan_steps
        (step_id, plan_id, sequence, kind, description, expected_outcome, dependencies)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
      `, [sid, planId, seq++, s.kind || 'action', s.description,
          s.expected_outcome || null, s.dependencies || []]).catch(() => {});
    }
    if (rootStepId) {
      await pool.query(`UPDATE plans SET root_step_id = $2 WHERE plan_id = $1`,
        [planId, rootStepId]).catch(() => {});
    }

    await auditChain.append({
      event_type: 'planning.plan_created',
      plan_id: planId, agent_did: did, goal: d.goal,
      step_count: steps.length, timestamp: new Date().toISOString()
    });

    return res.status(201).json({
      plan_id: planId, agent_did: did, goal: d.goal,
      status: d.status || 'draft', root_step_id: rootStepId,
      step_count: steps.length
    });
  });

  // GET /v1/agents/:did/plans
  app.get('/v1/agents/:did/plans', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const status = req.query.status;
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);

    const params = [did, limit];
    let extra = '';
    if (status) { params.push(status); extra = ` AND status = $${params.length}`; }
    const r = await pool.query(`
      SELECT plan_id, goal, parent_plan_id, status, root_step_id,
             success_criteria, created_at, updated_at, completed_at
      FROM plans WHERE agent_did = $1 ${extra}
      ORDER BY created_at DESC LIMIT $2
    `, params).catch(() => ({ rows: [] }));
    return res.json({ agent_did: did, plans: r.rows, count: r.rows.length });
  });

  // GET /v1/agents/:did/plans/:id
  app.get('/v1/agents/:did/plans/:id', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(`
      SELECT * FROM plans WHERE plan_id = $1 AND agent_did = $2
    `, [req.params.id, did]).catch(() => ({ rows: [] }));
    if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
    const tree = await loadStepTree(pool, req.params.id);
    return res.json({ ...r.rows[0], steps: tree });
  });

  // POST /v1/agents/:did/plans/:id/steps
  app.post('/v1/agents/:did/plans/:id/steps', express.json(), async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const own = await pool.query(`SELECT 1 FROM plans WHERE plan_id=$1 AND agent_did=$2`,
      [req.params.id, did]).catch(() => ({ rows: [] }));
    if (!own.rows[0]) return res.status(404).json({ error: 'plan_not_found' });

    const parse = AppendStepSchema.safeParse(req.body || {});
    if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
    const s = parse.data;

    let sequence = s.sequence;
    if (sequence === undefined) {
      const m = await pool.query(`SELECT COALESCE(MAX(sequence), -1) AS m FROM plan_steps WHERE plan_id=$1`,
        [req.params.id]).catch(() => ({ rows: [{ m: -1 }] }));
      sequence = (parseInt(m.rows[0].m) || -1) + 1;
    }
    const stepId = genId('step');
    await pool.query(`
      INSERT INTO plan_steps
      (step_id, plan_id, parent_step_id, sequence, kind, description, expected_outcome, dependencies)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `, [stepId, req.params.id, s.parent_step_id || null, sequence,
        s.kind || 'action', s.description, s.expected_outcome || null,
        s.dependencies || []]);

    await pool.query(`UPDATE plans SET updated_at = NOW() WHERE plan_id = $1`, [req.params.id]);
    await auditChain.append({
      event_type: 'planning.step_added',
      plan_id: req.params.id, step_id: stepId, agent_did: did,
      timestamp: new Date().toISOString()
    });
    return res.status(201).json({ step_id: stepId, plan_id: req.params.id, sequence });
  });

  // PUT /v1/agents/:did/plans/:id/steps/:sid
  app.put('/v1/agents/:did/plans/:id/steps/:sid', express.json(), async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const parse = UpdateStepSchema.safeParse(req.body || {});
    if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
    const d = parse.data;

    const own = await pool.query(`
      SELECT 1 FROM plan_steps s JOIN plans p ON p.plan_id = s.plan_id
      WHERE s.step_id = $1 AND s.plan_id = $2 AND p.agent_did = $3
    `, [req.params.sid, req.params.id, did]).catch(() => ({ rows: [] }));
    if (!own.rows[0]) return res.status(404).json({ error: 'step_not_found' });

    const fields = [];
    const vals = [];
    let i = 1;
    if (d.status) {
      vals.push(d.status); fields.push(`status = $${i++}`);
      if (d.status === 'in_progress') fields.push(`started_at = COALESCE(started_at, NOW())`);
      if (['completed', 'skipped', 'failed'].includes(d.status)) fields.push(`completed_at = NOW()`);
    }
    if (d.actual_outcome !== undefined) {
      vals.push(d.actual_outcome); fields.push(`actual_outcome = $${i++}`);
    }
    if (!fields.length) return res.status(400).json({ error: 'nothing_to_update' });

    vals.push(req.params.sid);
    await pool.query(
      `UPDATE plan_steps SET ${fields.join(', ')} WHERE step_id = $${i}`,
      vals
    );
    await pool.query(`UPDATE plans SET updated_at = NOW() WHERE plan_id = $1`, [req.params.id]);

    // Auto-complete plan if all steps are completed/skipped
    if (d.status === 'completed' || d.status === 'skipped') {
      const remaining = await pool.query(`
        SELECT COUNT(*) AS n FROM plan_steps WHERE plan_id=$1
        AND status NOT IN ('completed','skipped','failed')
      `, [req.params.id]).catch(() => ({ rows: [{ n: 0 }] }));
      if (parseInt(remaining.rows[0].n) === 0) {
        await pool.query(`
          UPDATE plans SET status='completed', completed_at=NOW(), updated_at=NOW()
          WHERE plan_id=$1 AND status != 'completed'
        `, [req.params.id]).catch(() => {});
      }
    }

    await auditChain.append({
      event_type: 'planning.step_updated',
      plan_id: req.params.id, step_id: req.params.sid, agent_did: did,
      status: d.status || null, timestamp: new Date().toISOString()
    });
    return res.json({ step_id: req.params.sid, updated: true });
  });

  // POST /v1/agents/:did/plans/:id/revise
  app.post('/v1/agents/:did/plans/:id/revise', express.json(), async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const parse = ReviseSchema.safeParse(req.body || {});
    if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
    const d = parse.data;

    const p = await pool.query(`SELECT goal, success_criteria FROM plans WHERE plan_id=$1 AND agent_did=$2`,
      [req.params.id, did]).catch(() => ({ rows: [] }));
    if (!p.rows[0]) return res.status(404).json({ error: 'plan_not_found' });

    const oldGoal = p.rows[0].goal;
    const newGoal = d.goal || oldGoal;
    const oldCriteria = p.rows[0].success_criteria;
    const newCriteria = d.success_criteria || oldCriteria;
    const diff = {
      goal: oldGoal !== newGoal ? { from: oldGoal, to: newGoal } : null,
      success_criteria: JSON.stringify(oldCriteria) !== JSON.stringify(newCriteria)
        ? { from: oldCriteria, to: newCriteria } : null
    };

    await pool.query(`
      UPDATE plans SET goal = $2,
                       success_criteria = $3::jsonb,
                       updated_at = NOW()
      WHERE plan_id = $1
    `, [req.params.id, newGoal, newCriteria ? JSON.stringify(newCriteria) : null]);

    let newStepIds = [];
    if (d.regenerate) {
      // Mark pending steps as skipped, generate fresh
      await pool.query(`
        UPDATE plan_steps SET status='skipped', completed_at=NOW()
        WHERE plan_id=$1 AND status='pending'
      `, [req.params.id]).catch(() => {});

      const fresh = await generateStepsForGoal(newGoal).catch(() => []);
      const baseM = await pool.query(`SELECT COALESCE(MAX(sequence), -1) AS m FROM plan_steps WHERE plan_id=$1`,
        [req.params.id]).catch(() => ({ rows: [{ m: -1 }] }));
      let seq = (parseInt(baseM.rows[0].m) || -1) + 1;
      for (const s of fresh) {
        const sid = genId('step');
        newStepIds.push(sid);
        await pool.query(`
          INSERT INTO plan_steps (step_id, plan_id, sequence, kind, description, expected_outcome)
          VALUES ($1, $2, $3, $4, $5, $6)
        `, [sid, req.params.id, seq++, s.kind || 'action', s.description, s.expected_outcome || null])
          .catch(() => {});
      }
      diff.regenerated_steps = newStepIds;
    }

    const revId = genId('rev');
    await pool.query(`
      INSERT INTO plan_revisions (revision_id, plan_id, agent_did, reason, diff)
      VALUES ($1, $2, $3, $4, $5::jsonb)
    `, [revId, req.params.id, did, d.reason, JSON.stringify(diff)]);

    await auditChain.append({
      event_type: 'planning.plan_revised',
      plan_id: req.params.id, revision_id: revId, agent_did: did,
      reason: d.reason, timestamp: new Date().toISOString()
    });
    return res.status(201).json({
      revision_id: revId, plan_id: req.params.id,
      diff, new_step_ids: newStepIds
    });
  });
}

module.exports = {
  migrate,
  registerPlanningRoutes,
  generateStepsForGoal,
  PLAN_STATUSES,
  STEP_STATUSES,
  STEP_KINDS
};
