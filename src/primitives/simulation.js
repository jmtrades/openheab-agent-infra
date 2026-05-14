// ============================================================================
// OpenHeab Simulation — Run plans in simulation before real execution
// Predictive what-if for agent plans using LLM role-play.
// ============================================================================
const express = require('express');
const cryptoLib = require('crypto');
const { z } = require('zod');

const SIM_STATUSES = ['running', 'completed', 'failed'];
const MODEL_KINDS  = ['world_model', 'causal', 'agent_behavior'];

// ----------------------------------------------------------------------------
// Migration
// ----------------------------------------------------------------------------
async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS simulations (
      simulation_id   TEXT PRIMARY KEY,
      agent_did       TEXT NOT NULL,
      plan_id         TEXT,
      scenario        JSONB NOT NULL DEFAULT '{}'::jsonb,
      status          TEXT NOT NULL DEFAULT 'running',
      outcome_score   REAL,
      outcomes        JSONB NOT NULL DEFAULT '[]'::jsonb,
      model_id        TEXT,
      summary         TEXT,
      started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at    TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_simulations_agent ON simulations (agent_did, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_simulations_plan  ON simulations (plan_id);
    CREATE INDEX IF NOT EXISTS idx_simulations_status ON simulations (status);

    CREATE TABLE IF NOT EXISTS simulation_models (
      model_id            TEXT PRIMARY KEY,
      agent_did           TEXT NOT NULL,
      name                TEXT NOT NULL,
      kind                TEXT NOT NULL DEFAULT 'world_model',
      parameters          JSONB,
      training_data_uri   TEXT,
      accuracy            REAL,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (agent_did, name)
    );
    CREATE INDEX IF NOT EXISTS idx_simulation_models_agent ON simulation_models (agent_did);
  `);
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------
function genId(prefix) {
  return prefix + '_' + cryptoLib.randomBytes(12).toString('hex');
}

// Deterministic-ish hash → numeric in [0,1)
function seedRand(...inputs) {
  const h = cryptoLib.createHash('sha256').update(inputs.map(String).join('|')).digest();
  return ((h.readUInt32BE(0) >>> 0) % 1_000_000) / 1_000_000;
}

async function loadSteps(pool, planId) {
  if (!planId) return [];
  const r = await pool.query(`
    SELECT step_id, sequence, kind, description, expected_outcome
    FROM plan_steps WHERE plan_id = $1 ORDER BY sequence ASC
  `, [planId]).catch(() => ({ rows: [] }));
  return r.rows;
}

async function simulateWithLLM(plan, scenario, opts = {}) {
  if (!process.env.OPENAI_API_KEY) return null;
  try {
    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: process.env.OPENAI_SIM_MODEL || 'gpt-4o-mini',
        messages: [
          { role: 'system', content: 'You are a simulation engine. Given a plan and scenario, role-play each step and predict the outcome. Reply ONLY with JSON: {"summary":"...","outcome_score":0..1,"outcomes":[{"step_id":"...","simulated_outcome":"...","probability":0..1,"side_effects":["..."]}]}' },
          { role: 'user', content: `Scenario: ${JSON.stringify(scenario)}\n\nPlan steps:\n${JSON.stringify(plan, null, 2)}` }
        ],
        temperature: 0.4,
        response_format: { type: 'json_object' }
      })
    });
    if (!resp.ok) return null;
    const j = await resp.json();
    const parsed = JSON.parse(j.choices?.[0]?.message?.content || '{}');
    return parsed;
  } catch (e) { return null; }
}

function heuristicSimulate(steps, scenario) {
  const outcomes = steps.map((s, i) => {
    const p = seedRand(s.step_id || i, JSON.stringify(scenario));
    const success = p > 0.25;
    return {
      step_id: s.step_id || `step_${i}`,
      simulated_outcome: success
        ? (s.expected_outcome || `Step ${i + 1} succeeded`)
        : `Step ${i + 1} failed in this scenario`,
      probability: Math.round(p * 100) / 100,
      side_effects: success ? [] : [`risk:${s.kind || 'action'}`]
    };
  });
  const avgP = outcomes.length
    ? outcomes.reduce((a, o) => a + o.probability, 0) / outcomes.length
    : 0;
  return {
    outcomes,
    outcome_score: Math.round(avgP * 100) / 100,
    summary: `Heuristic sim: ${outcomes.filter(o => o.probability > 0.5).length}/${outcomes.length} likely succeed.`
  };
}

// ----------------------------------------------------------------------------
// Schemas
// ----------------------------------------------------------------------------
const CreateSimSchema = z.object({
  plan_id:  z.string().optional(),
  steps:    z.array(z.object({
    step_id: z.string().optional(),
    description: z.string(),
    expected_outcome: z.string().optional(),
    kind: z.string().optional()
  })).optional(),
  scenario: z.record(z.any()).optional(),
  model_id: z.string().optional()
});

const ReplaySchema = z.object({
  scenario: z.record(z.any()).optional(),
  parameter_overrides: z.record(z.any()).optional()
});

const RegisterModelSchema = z.object({
  name:              z.string().min(1).max(128),
  kind:              z.enum(MODEL_KINDS).optional(),
  parameters:        z.record(z.any()).optional(),
  training_data_uri: z.string().optional(),
  accuracy:          z.number().min(0).max(1).optional()
});

// ----------------------------------------------------------------------------
// Routes
// ----------------------------------------------------------------------------
function registerSimulationRoutes(app, pool, verifyAgentAuth, auditChain) {
  // POST /v1/agents/:did/simulations
  app.post('/v1/agents/:did/simulations', express.json(), async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const parse = CreateSimSchema.safeParse(req.body || {});
    if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
    const d = parse.data;

    let steps = d.steps || [];
    if (!steps.length && d.plan_id) steps = await loadSteps(pool, d.plan_id);
    if (!steps.length) return res.status(400).json({ error: 'no_steps_to_simulate' });

    const simId = genId('sim');
    await pool.query(`
      INSERT INTO simulations
      (simulation_id, agent_did, plan_id, scenario, status, model_id)
      VALUES ($1, $2, $3, $4::jsonb, 'running', $5)
    `, [simId, did, d.plan_id || null,
        JSON.stringify(d.scenario || {}), d.model_id || null]);

    let result = await simulateWithLLM(steps, d.scenario || {});
    if (!result) result = heuristicSimulate(steps, d.scenario || {});

    await pool.query(`
      UPDATE simulations SET status='completed',
                              outcome_score=$2,
                              outcomes=$3::jsonb,
                              summary=$4,
                              completed_at=NOW()
      WHERE simulation_id=$1
    `, [simId, result.outcome_score ?? null,
        JSON.stringify(result.outcomes || []), result.summary || null]);

    await auditChain.append({
      event_type: 'simulation.completed',
      simulation_id: simId, agent_did: did, plan_id: d.plan_id || null,
      outcome_score: result.outcome_score ?? null,
      timestamp: new Date().toISOString()
    });

    return res.status(201).json({
      simulation_id: simId, status: 'completed',
      outcome_score: result.outcome_score ?? null,
      summary: result.summary, outcomes: result.outcomes
    });
  });

  // GET /v1/agents/:did/simulations
  app.get('/v1/agents/:did/simulations', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const planId = req.query.plan_id;

    const params = [did, limit];
    let extra = '';
    if (planId) { params.push(planId); extra = ` AND plan_id = $${params.length}`; }
    const r = await pool.query(`
      SELECT simulation_id, plan_id, status, outcome_score, summary,
             scenario, model_id, started_at, completed_at
      FROM simulations WHERE agent_did = $1 ${extra}
      ORDER BY started_at DESC LIMIT $2
    `, params).catch(() => ({ rows: [] }));
    return res.json({ agent_did: did, simulations: r.rows, count: r.rows.length });
  });

  // GET /v1/agents/:did/simulations/:id
  app.get('/v1/agents/:did/simulations/:id', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(`
      SELECT * FROM simulations WHERE simulation_id=$1 AND agent_did=$2
    `, [req.params.id, did]).catch(() => ({ rows: [] }));
    if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
    return res.json(r.rows[0]);
  });

  // POST /v1/agents/:did/simulation-models
  app.post('/v1/agents/:did/simulation-models', express.json(), async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const parse = RegisterModelSchema.safeParse(req.body || {});
    if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
    const d = parse.data;
    const modelId = genId('mdl');
    try {
      await pool.query(`
        INSERT INTO simulation_models
        (model_id, agent_did, name, kind, parameters, training_data_uri, accuracy)
        VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
      `, [modelId, did, d.name, d.kind || 'world_model',
          d.parameters ? JSON.stringify(d.parameters) : null,
          d.training_data_uri || null, d.accuracy ?? null]);
    } catch (e) {
      if (/duplicate/i.test(e.message)) return res.status(409).json({ error: 'name_in_use' });
      throw e;
    }
    await auditChain.append({
      event_type: 'simulation.model_registered',
      model_id: modelId, agent_did: did, name: d.name, kind: d.kind || 'world_model',
      timestamp: new Date().toISOString()
    });
    return res.status(201).json({ model_id: modelId, name: d.name, kind: d.kind || 'world_model' });
  });

  // POST /v1/agents/:did/simulations/:id/replay
  app.post('/v1/agents/:did/simulations/:id/replay', express.json(), async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const parse = ReplaySchema.safeParse(req.body || {});
    if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
    const d = parse.data;

    const orig = await pool.query(`
      SELECT plan_id, scenario, model_id FROM simulations WHERE simulation_id=$1 AND agent_did=$2
    `, [req.params.id, did]).catch(() => ({ rows: [] }));
    if (!orig.rows[0]) return res.status(404).json({ error: 'not_found' });

    const baseScenario = orig.rows[0].scenario || {};
    const merged = {
      ...(typeof baseScenario === 'string' ? JSON.parse(baseScenario) : baseScenario),
      ...(d.scenario || {}),
      _parameter_overrides: d.parameter_overrides || {}
    };

    const steps = await loadSteps(pool, orig.rows[0].plan_id);
    if (!steps.length) return res.status(400).json({ error: 'no_steps_to_simulate' });

    const newId = genId('sim');
    await pool.query(`
      INSERT INTO simulations
      (simulation_id, agent_did, plan_id, scenario, status, model_id)
      VALUES ($1, $2, $3, $4::jsonb, 'running', $5)
    `, [newId, did, orig.rows[0].plan_id, JSON.stringify(merged), orig.rows[0].model_id || null]);

    let result = await simulateWithLLM(steps, merged);
    if (!result) result = heuristicSimulate(steps, merged);

    await pool.query(`
      UPDATE simulations SET status='completed', outcome_score=$2,
                              outcomes=$3::jsonb, summary=$4, completed_at=NOW()
      WHERE simulation_id=$1
    `, [newId, result.outcome_score ?? null,
        JSON.stringify(result.outcomes || []), result.summary || null]);

    await auditChain.append({
      event_type: 'simulation.replayed',
      simulation_id: newId, original_id: req.params.id, agent_did: did,
      timestamp: new Date().toISOString()
    });

    return res.status(201).json({
      simulation_id: newId, replayed_from: req.params.id, status: 'completed',
      outcome_score: result.outcome_score ?? null, summary: result.summary,
      outcomes: result.outcomes
    });
  });

  // GET /v1/agents/:did/simulations/:id/outcome
  app.get('/v1/agents/:did/simulations/:id/outcome', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(`
      SELECT outcomes, outcome_score, summary, status
      FROM simulations WHERE simulation_id=$1 AND agent_did=$2
    `, [req.params.id, did]).catch(() => ({ rows: [] }));
    if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });

    const outcomes = (typeof r.rows[0].outcomes === 'string'
      ? JSON.parse(r.rows[0].outcomes) : r.rows[0].outcomes) || [];
    const score = r.rows[0].outcome_score ?? 0;
    const lowProb = outcomes.filter(o => (o.probability ?? 1) < 0.5).length;
    const sideEffects = outcomes.flatMap(o => o.side_effects || []);
    let risk = 'low';
    if (score < 0.4 || lowProb / Math.max(outcomes.length, 1) > 0.4) risk = 'high';
    else if (score < 0.7 || lowProb > 0) risk = 'medium';

    return res.json({
      simulation_id: req.params.id, status: r.rows[0].status,
      outcome_score: score, summary: r.rows[0].summary,
      risk_level: risk,
      steps_assessed: outcomes.length,
      steps_low_confidence: lowProb,
      side_effects: sideEffects
    });
  });
}

module.exports = {
  migrate,
  registerSimulationRoutes,
  simulateWithLLM,
  heuristicSimulate,
  SIM_STATUSES,
  MODEL_KINDS
};
