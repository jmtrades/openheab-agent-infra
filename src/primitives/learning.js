// ============================================================================
// OpenHeab Learning — Online learning, multi-armed bandits, RL policies.
// Bandits: epsilon-greedy / Thompson (Beta) / UCB / contextual.
// RL: q-learning / policy_gradient / dqn (experience-replay style storage).
// Models: classifier / regressor / clusterer with sklearn / torch / tf metadata.
// ============================================================================
const express = require('express');
const cryptoLib = require('crypto');
const { z } = require('zod');

const BANDIT_KINDS = ['epsilon_greedy', 'thompson', 'ucb', 'contextual'];
const RL_KINDS = ['q_learning', 'policy_gradient', 'dqn'];
const RL_STATUSES = ['training', 'deployed', 'archived'];
const MODEL_KINDS = ['classifier', 'regressor', 'clusterer'];
const FRAMEWORKS = ['sklearn', 'torch', 'tf'];

// ----------------------------------------------------------------------------
// Migration
// ----------------------------------------------------------------------------
async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bandits (
      bandit_id      TEXT PRIMARY KEY,
      agent_did      TEXT NOT NULL,
      name           TEXT NOT NULL,
      kind           TEXT NOT NULL DEFAULT 'epsilon_greedy',
      arms           JSONB NOT NULL DEFAULT '[]'::jsonb,
      epsilon        REAL NOT NULL DEFAULT 0.1,
      total_pulls    BIGINT NOT NULL DEFAULT 0,
      total_reward   DOUBLE PRECISION NOT NULL DEFAULT 0,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_bandits_agent ON bandits (agent_did, created_at DESC);

    CREATE TABLE IF NOT EXISTS bandit_pulls (
      pull_id     TEXT PRIMARY KEY,
      bandit_id   TEXT NOT NULL,
      arm_key     TEXT NOT NULL,
      context     JSONB,
      reward      DOUBLE PRECISION,
      ts          TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_bandit_pulls_bandit ON bandit_pulls (bandit_id, ts DESC);

    CREATE TABLE IF NOT EXISTS rl_policies (
      policy_id     TEXT PRIMARY KEY,
      agent_did     TEXT NOT NULL,
      name          TEXT NOT NULL,
      kind          TEXT NOT NULL DEFAULT 'q_learning',
      state_space   JSONB,
      action_space  JSONB,
      parameters    JSONB,
      episodes      BIGINT NOT NULL DEFAULT 0,
      total_reward  DOUBLE PRECISION NOT NULL DEFAULT 0,
      status        TEXT NOT NULL DEFAULT 'training',
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_rl_policies_agent ON rl_policies (agent_did, created_at DESC);

    CREATE TABLE IF NOT EXISTS rl_experiences (
      xp_id        TEXT PRIMARY KEY,
      policy_id    TEXT NOT NULL,
      state        JSONB,
      action       JSONB,
      reward       DOUBLE PRECISION,
      next_state   JSONB,
      terminal     BOOLEAN NOT NULL DEFAULT FALSE,
      ts           TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_rl_xp_policy ON rl_experiences (policy_id, ts DESC);

    CREATE TABLE IF NOT EXISTS models_trained (
      model_id            TEXT PRIMARY KEY,
      agent_did           TEXT NOT NULL,
      kind                TEXT NOT NULL,
      framework           TEXT NOT NULL,
      hyperparameters     JSONB,
      metrics             JSONB,
      training_data_blob_id TEXT,
      model_blob_id       TEXT,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_models_trained_agent ON models_trained (agent_did, created_at DESC);
  `).catch(() => {});
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------
function genId(prefix) { return `${prefix}_${cryptoLib.randomBytes(12).toString('hex')}`; }

// Sample from Gamma(shape, 1) using Marsaglia & Tsang algorithm
function sampleGamma(shape) {
  if (shape < 1) {
    // Boost using Gamma(shape+1) * U^(1/shape)
    const u = Math.random();
    return sampleGamma(shape + 1) * Math.pow(u, 1 / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  while (true) {
    let x, v;
    do {
      // Box-Muller for normal
      const u1 = Math.random() || 1e-12;
      const u2 = Math.random();
      x = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = Math.random();
    if (u < 1 - 0.0331 * Math.pow(x, 4)) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

function sampleBeta(alpha, beta) {
  const a = Math.max(0.0001, Number(alpha));
  const b = Math.max(0.0001, Number(beta));
  const x = sampleGamma(a);
  const y = sampleGamma(b);
  return x / (x + y);
}

function normalizeArms(armsInput) {
  return (armsInput || []).map(a => ({
    key: String(a.key),
    alpha: a.alpha != null ? Number(a.alpha) : 1,
    beta: a.beta != null ? Number(a.beta) : 1,
    mean: a.mean != null ? Number(a.mean) : 0,
    count: a.count != null ? Number(a.count) : 0
  }));
}

function selectArm(bandit) {
  const arms = bandit.arms || [];
  if (!arms.length) return null;
  const kind = bandit.kind || 'epsilon_greedy';
  const totalPulls = Number(bandit.total_pulls || 0);

  if (kind === 'epsilon_greedy') {
    if (Math.random() < (bandit.epsilon || 0.1)) {
      return arms[Math.floor(Math.random() * arms.length)];
    }
    let best = arms[0];
    for (const a of arms) if (a.mean > best.mean) best = a;
    return best;
  }

  if (kind === 'thompson') {
    let bestArm = arms[0], bestSample = -Infinity;
    for (const a of arms) {
      const s = sampleBeta(a.alpha || 1, a.beta || 1);
      if (s > bestSample) { bestSample = s; bestArm = a; }
    }
    return bestArm;
  }

  if (kind === 'ucb') {
    const c = 2.0;
    const T = Math.max(1, totalPulls);
    let bestArm = arms[0], bestScore = -Infinity;
    for (const a of arms) {
      const n = Math.max(1, a.count || 0);
      const score = (a.mean || 0) + c * Math.sqrt(Math.log(T) / n);
      if (score > bestScore) { bestScore = score; bestArm = a; }
    }
    return bestArm;
  }

  if (kind === 'contextual') {
    // Simple contextual: pick best mean with epsilon exploration
    if (Math.random() < (bandit.epsilon || 0.1)) {
      return arms[Math.floor(Math.random() * arms.length)];
    }
    let best = arms[0];
    for (const a of arms) if (a.mean > best.mean) best = a;
    return best;
  }

  return arms[0];
}

function updateArmAfterReward(arm, reward) {
  const count = (arm.count || 0) + 1;
  const prevMean = arm.mean || 0;
  const newMean = prevMean + (reward - prevMean) / count;
  let alpha = arm.alpha || 1, beta = arm.beta || 1;
  // Treat reward as Bernoulli-ish for Beta update
  if (reward >= 0.5) alpha += 1; else beta += 1;
  return { ...arm, count, mean: newMean, alpha, beta };
}

// ----------------------------------------------------------------------------
// Routes
// ----------------------------------------------------------------------------
function registerLearningRoutes(app, pool, verifyAgentAuth, auditChain) {
  // ---- Bandits ------------------------------------------------------------
  const BanditCreateSchema = z.object({
    name: z.string().min(1).max(200),
    kind: z.enum(BANDIT_KINDS).optional(),
    arms: z.array(z.object({
      key: z.string().min(1).max(120),
      alpha: z.number().optional(),
      beta: z.number().optional(),
      mean: z.number().optional(),
      count: z.number().optional()
    })).min(2),
    epsilon: z.number().min(0).max(1).optional()
  });

  app.post('/v1/agents/:did/learning/bandits', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const parse = BanditCreateSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;
      const banditId = genId('bdt');
      const arms = normalizeArms(d.arms);
      await pool.query(
        `INSERT INTO bandits (bandit_id, agent_did, name, kind, arms, epsilon)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
        [banditId, did, d.name, d.kind || 'epsilon_greedy', JSON.stringify(arms), d.epsilon ?? 0.1]
      );
      await auditChain.append({
        event_type: 'learning.bandit_created', bandit_id: banditId, agent_did: did,
        kind: d.kind || 'epsilon_greedy', arms: arms.length,
        timestamp: new Date().toISOString()
      });
      return res.status(201).json({ bandit_id: banditId, name: d.name, kind: d.kind || 'epsilon_greedy', arms });
    } catch (e) { return res.status(500).json({ error: 'create_failed', message: e.message }); }
  });

  app.get('/v1/agents/:did/learning/bandits', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(
      `SELECT * FROM bandits WHERE agent_did=$1 ORDER BY created_at DESC LIMIT 500`, [did]
    ).catch(() => ({ rows: [] }));
    return res.json({ bandits: r.rows, count: r.rows.length });
  });

  const SelectSchema = z.object({ context: z.record(z.any()).optional() });
  app.post('/v1/learning/bandits/:id/select', express.json(), async (req, res) => {
    try {
      const parse = SelectSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input' });
      const r = await pool.query(`SELECT * FROM bandits WHERE bandit_id=$1`, [req.params.id])
        .catch(() => ({ rows: [] }));
      if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
      const bandit = r.rows[0];
      const auth = await verifyAgentAuth(req, bandit.agent_did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const arm = selectArm(bandit);
      if (!arm) return res.status(400).json({ error: 'no_arms' });
      const pullId = genId('pull');
      await pool.query(
        `INSERT INTO bandit_pulls (pull_id, bandit_id, arm_key, context)
         VALUES ($1, $2, $3, $4::jsonb)`,
        [pullId, bandit.bandit_id, arm.key, parse.data.context ? JSON.stringify(parse.data.context) : null]
      );
      await pool.query(`UPDATE bandits SET total_pulls = total_pulls + 1, updated_at = NOW() WHERE bandit_id=$1`,
        [bandit.bandit_id]).catch(() => {});
      return res.json({ pull_id: pullId, bandit_id: bandit.bandit_id, arm_key: arm.key, arm });
    } catch (e) { return res.status(500).json({ error: 'select_failed', message: e.message }); }
  });

  const RewardSchema = z.object({
    pull_id: z.string().optional(),
    arm_key: z.string().optional(),
    reward: z.number()
  });
  app.post('/v1/learning/bandits/:id/reward', express.json(), async (req, res) => {
    try {
      const parse = RewardSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const r = await pool.query(`SELECT * FROM bandits WHERE bandit_id=$1`, [req.params.id])
        .catch(() => ({ rows: [] }));
      if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
      const bandit = r.rows[0];
      const auth = await verifyAgentAuth(req, bandit.agent_did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      let armKey = parse.data.arm_key;
      if (!armKey && parse.data.pull_id) {
        const p = await pool.query(`SELECT arm_key FROM bandit_pulls WHERE pull_id=$1`, [parse.data.pull_id])
          .catch(() => ({ rows: [] }));
        if (p.rows[0]) armKey = p.rows[0].arm_key;
      }
      if (!armKey) return res.status(400).json({ error: 'pull_id_or_arm_key_required' });

      const arms = bandit.arms || [];
      const idx = arms.findIndex(a => a.key === armKey);
      if (idx < 0) return res.status(404).json({ error: 'arm_not_found' });
      arms[idx] = updateArmAfterReward(arms[idx], parse.data.reward);

      await pool.query(
        `UPDATE bandits SET arms=$1::jsonb, total_reward=total_reward+$2, updated_at=NOW() WHERE bandit_id=$3`,
        [JSON.stringify(arms), parse.data.reward, bandit.bandit_id]
      );
      if (parse.data.pull_id) {
        await pool.query(`UPDATE bandit_pulls SET reward=$1 WHERE pull_id=$2`,
          [parse.data.reward, parse.data.pull_id]).catch(() => {});
      }
      await auditChain.append({
        event_type: 'learning.bandit_reward', bandit_id: bandit.bandit_id,
        arm_key: armKey, reward: parse.data.reward,
        timestamp: new Date().toISOString()
      });
      return res.json({ bandit_id: bandit.bandit_id, arm_key: armKey, arm: arms[idx] });
    } catch (e) { return res.status(500).json({ error: 'reward_failed', message: e.message }); }
  });

  // ---- RL Policies --------------------------------------------------------
  const RlPolicySchema = z.object({
    name: z.string().min(1).max(200),
    kind: z.enum(RL_KINDS).optional(),
    state_space: z.record(z.any()).optional(),
    action_space: z.record(z.any()).optional(),
    parameters: z.record(z.any()).optional()
  });

  app.post('/v1/agents/:did/learning/rl-policies', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const parse = RlPolicySchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;
      const policyId = genId('pol');
      await pool.query(
        `INSERT INTO rl_policies (policy_id, agent_did, name, kind, state_space, action_space, parameters)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb)`,
        [policyId, did, d.name, d.kind || 'q_learning',
         JSON.stringify(d.state_space || {}), JSON.stringify(d.action_space || {}),
         JSON.stringify(d.parameters || {})]
      );
      await auditChain.append({
        event_type: 'learning.rl_policy_created', policy_id: policyId, agent_did: did,
        kind: d.kind || 'q_learning', timestamp: new Date().toISOString()
      });
      return res.status(201).json({ policy_id: policyId, name: d.name, kind: d.kind || 'q_learning' });
    } catch (e) { return res.status(500).json({ error: 'create_failed', message: e.message }); }
  });

  const ExperienceSchema = z.object({
    state: z.any(),
    action: z.any(),
    reward: z.number(),
    next_state: z.any().optional(),
    terminal: z.boolean().optional()
  });

  app.post('/v1/learning/rl-policies/:id/experience', express.json(), async (req, res) => {
    try {
      const parse = ExperienceSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const p = await pool.query(`SELECT * FROM rl_policies WHERE policy_id=$1`, [req.params.id])
        .catch(() => ({ rows: [] }));
      if (!p.rows[0]) return res.status(404).json({ error: 'not_found' });
      const auth = await verifyAgentAuth(req, p.rows[0].agent_did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const xpId = genId('xp');
      const d = parse.data;
      await pool.query(
        `INSERT INTO rl_experiences (xp_id, policy_id, state, action, reward, next_state, terminal)
         VALUES ($1,$2,$3::jsonb,$4::jsonb,$5,$6::jsonb,$7)`,
        [xpId, req.params.id, JSON.stringify(d.state ?? null),
         JSON.stringify(d.action ?? null), d.reward,
         JSON.stringify(d.next_state ?? null), !!d.terminal]
      );
      await pool.query(
        `UPDATE rl_policies SET total_reward = total_reward + $2 WHERE policy_id=$1`,
        [req.params.id, d.reward]
      ).catch(() => {});
      if (d.terminal) {
        await pool.query(`UPDATE rl_policies SET episodes = episodes + 1 WHERE policy_id=$1`,
          [req.params.id]).catch(() => {});
      }
      return res.status(201).json({ xp_id: xpId, policy_id: req.params.id });
    } catch (e) { return res.status(500).json({ error: 'experience_failed', message: e.message }); }
  });

  const TrainSchema = z.object({
    learning_rate: z.number().min(0).max(1).optional(),
    discount: z.number().min(0).max(1).optional(),
    batch_size: z.number().int().min(1).max(10000).optional()
  });
  app.post('/v1/learning/rl-policies/:id/train', express.json(), async (req, res) => {
    try {
      const parse = TrainSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input' });
      const p = await pool.query(`SELECT * FROM rl_policies WHERE policy_id=$1`, [req.params.id])
        .catch(() => ({ rows: [] }));
      if (!p.rows[0]) return res.status(404).json({ error: 'not_found' });
      const auth = await verifyAgentAuth(req, p.rows[0].agent_did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const batch = parse.data.batch_size || 64;
      // Pull recent experiences as a training batch
      const xp = await pool.query(
        `SELECT * FROM rl_experiences WHERE policy_id=$1 ORDER BY ts DESC LIMIT $2`,
        [req.params.id, batch]
      ).catch(() => ({ rows: [] }));
      // Simple parameter update: track running avg reward (a stand-in epoch step).
      const avgReward = xp.rows.length
        ? xp.rows.reduce((s, r) => s + Number(r.reward || 0), 0) / xp.rows.length
        : 0;
      const params = p.rows[0].parameters || {};
      params.last_train_avg_reward = avgReward;
      params.last_trained_at = new Date().toISOString();
      params.learning_rate = parse.data.learning_rate ?? params.learning_rate ?? 0.01;
      params.discount = parse.data.discount ?? params.discount ?? 0.95;
      await pool.query(
        `UPDATE rl_policies SET parameters=$1::jsonb WHERE policy_id=$2`,
        [JSON.stringify(params), req.params.id]
      );
      await auditChain.append({
        event_type: 'learning.rl_epoch', policy_id: req.params.id,
        batch_size: xp.rows.length, avg_reward: avgReward,
        timestamp: new Date().toISOString()
      });
      return res.json({
        policy_id: req.params.id, batch_size: xp.rows.length,
        avg_reward: avgReward, parameters: params
      });
    } catch (e) { return res.status(500).json({ error: 'train_failed', message: e.message }); }
  });

  // ---- Models trained -----------------------------------------------------
  const ModelSchema = z.object({
    kind: z.enum(MODEL_KINDS),
    framework: z.enum(FRAMEWORKS),
    hyperparameters: z.record(z.any()).optional(),
    metrics: z.record(z.any()).optional(),
    training_data_blob_id: z.string().optional(),
    model_blob_id: z.string().optional()
  });
  app.post('/v1/agents/:did/learning/models', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const parse = ModelSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;
      const modelId = genId('mdl');
      await pool.query(
        `INSERT INTO models_trained (model_id, agent_did, kind, framework, hyperparameters,
                                      metrics, training_data_blob_id, model_blob_id)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8)`,
        [modelId, did, d.kind, d.framework,
         JSON.stringify(d.hyperparameters || {}),
         JSON.stringify(d.metrics || {}),
         d.training_data_blob_id || null, d.model_blob_id || null]
      );
      return res.status(201).json({ model_id: modelId, kind: d.kind, framework: d.framework });
    } catch (e) { return res.status(500).json({ error: 'create_failed', message: e.message }); }
  });
}

module.exports = {
  migrate, registerLearningRoutes,
  BANDIT_KINDS, RL_KINDS, RL_STATUSES, MODEL_KINDS, FRAMEWORKS,
  selectArm, updateArmAfterReward, sampleBeta
};
