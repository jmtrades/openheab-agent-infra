// ============================================================================
// skill_composer.js — given a high-level goal, derive an executable DAG of
// skill invocations. The autonomy primitive: agents stop needing imperative
// scripts and start declaring goals.
// ============================================================================
const crypto = require('crypto');
const { z } = require('zod');

const COMPOSITION_RECIPES = [
  { goal_pattern: /^(?:onboard|provision)\s+(?:a\s+)?new\s+agent/i,
    plan: [
      { skill: 'identity.create' },
      { skill: 'kyc.submit', depends_on: ['identity.create'] },
      { skill: 'wallet.balance', depends_on: ['identity.create'] },
      { skill: 'cards.issue', depends_on: ['kyc.submit'] },
      { skill: 'savings.open', depends_on: ['kyc.submit'] }
    ] },
  { goal_pattern: /^(?:pay|invoice|settle)/i,
    plan: [
      { skill: 'wallet.balance' },
      { skill: 'safety.classify' },
      { skill: 'wallet.transfer', depends_on: ['wallet.balance', 'safety.classify'] },
      { skill: 'audit.verify', depends_on: ['wallet.transfer'] }
    ] },
  { goal_pattern: /^(?:research|investigate|analyze)/i,
    plan: [
      { skill: 'inference.chat' },
      { skill: 'memory.search', depends_on: ['inference.chat'] },
      { skill: 'inference.chat', repeat: true, depends_on: ['memory.search'] }
    ] },
  { goal_pattern: /^(?:negotiate|bargain|deal)/i,
    plan: [
      { skill: 'reputation.get' },
      { skill: 'negotiation.start', depends_on: ['reputation.get'] },
      { skill: 'audit.verify', depends_on: ['negotiation.start'] }
    ] }
];

async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS skill_compositions (
      composition_id    TEXT PRIMARY KEY,
      agent_did         TEXT NOT NULL,
      goal              TEXT NOT NULL,
      plan              JSONB NOT NULL,
      reasoning         TEXT,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

function newId(p) { return p + '_' + crypto.randomBytes(10).toString('hex'); }

function compose(goal, availableSkills = null) {
  const matchedRecipe = COMPOSITION_RECIPES.find(r => r.goal_pattern.test(goal));
  if (matchedRecipe) {
    let plan = matchedRecipe.plan;
    if (availableSkills) plan = plan.filter(p => availableSkills.includes(p.skill));
    return {
      plan: plan.map((p, i) => ({ step: i + 1, ...p })),
      reasoning: 'Matched composition recipe by pattern. Filtered to available skills.',
      confidence: 0.85
    };
  }
  // Fallback: single-step inference call
  return {
    plan: [{ step: 1, skill: 'inference.chat' }],
    reasoning: 'No recipe match. Defaulting to single inference call.',
    confidence: 0.3
  };
}

function topologicalSort(plan) {
  const sorted = [];
  const visited = new Set();
  const visiting = new Set();
  function dfs(step) {
    if (visited.has(step.step)) return;
    if (visiting.has(step.step)) return; // cycle
    visiting.add(step.step);
    for (const dep of step.depends_on || []) {
      const depStep = plan.find(p => p.skill === dep);
      if (depStep) dfs(depStep);
    }
    visiting.delete(step.step);
    visited.add(step.step);
    sorted.push(step);
  }
  for (const step of plan) dfs(step);
  return sorted;
}

const composeSchema = z.object({
  goal: z.string().min(1).max(2000),
  available_skills: z.array(z.string()).optional(),
  max_steps: z.number().int().min(1).max(50).optional()
});

function registerSkillComposerRoutes(app, pool, verifyAgentAuth, auditChain) {
  const express = require('express');

  app.post('/v1/agents/:did/skill-compose', express.json(), async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const p = composeSchema.safeParse(req.body || {});
    if (!p.success) return res.status(400).json({ error: 'invalid_input', details: p.error.flatten() });

    const out = compose(p.data.goal, p.data.available_skills);
    const sorted = topologicalSort(out.plan);

    const id = newId('comp');
    await pool.query(
      `INSERT INTO skill_compositions (composition_id, agent_did, goal, plan, reasoning)
       VALUES ($1,$2,$3,$4,$5)`,
      [id, did, p.data.goal, JSON.stringify(sorted), out.reasoning]
    );
    if (auditChain) await auditChain.append({ event_type: 'skill.composed', composition_id: id, agent_did: did, step_count: sorted.length }).catch(() => {});

    res.status(201).json({ composition_id: id, plan: sorted, reasoning: out.reasoning, confidence: out.confidence });
  });

  app.get('/v1/skill-compose/recipes', (req, res) => {
    res.json({
      recipes: COMPOSITION_RECIPES.map(r => ({
        goal_pattern: r.goal_pattern.toString(),
        plan: r.plan
      }))
    });
  });

  app.get('/v1/agents/:did/skill-compositions', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(`SELECT composition_id, goal, plan, reasoning, created_at FROM skill_compositions WHERE agent_did=$1 ORDER BY created_at DESC LIMIT 100`, [did])
      .catch(() => ({ rows: [] }));
    res.json({ compositions: r.rows });
  });
}

module.exports = { migrate, registerSkillComposerRoutes, compose, topologicalSort, COMPOSITION_RECIPES };
