// ============================================================================
// OpenHeab Causal — Causal models + interventional inference
// Stores DAGs of variables, supports do-calculus and simplified discovery.
// ============================================================================
const express = require('express');
const cryptoLib = require('crypto');
const { z } = require('zod');

const NODE_TYPES = ['continuous', 'discrete', 'binary'];
const EDGE_SIGNS = ['positive', 'negative', 'none'];

// ----------------------------------------------------------------------------
// Migration
// ----------------------------------------------------------------------------
async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS causal_models (
      model_id              TEXT PRIMARY KEY,
      agent_did             TEXT NOT NULL,
      name                  TEXT NOT NULL,
      description           TEXT,
      nodes                 JSONB NOT NULL DEFAULT '[]'::jsonb,
      edges                 JSONB NOT NULL DEFAULT '[]'::jsonb,
      observational_fit     REAL,
      interventional_fit    REAL,
      last_updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (agent_did, name)
    );
    CREATE INDEX IF NOT EXISTS idx_causal_models_agent ON causal_models (agent_did);

    CREATE TABLE IF NOT EXISTS causal_observations (
      observation_id  TEXT PRIMARY KEY,
      model_id        TEXT NOT NULL,
      agent_did       TEXT NOT NULL,
      variables       JSONB NOT NULL,
      "timestamp"     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_causal_observations_model ON causal_observations (model_id, "timestamp" DESC);

    CREATE TABLE IF NOT EXISTS causal_interventions (
      intervention_id    TEXT PRIMARY KEY,
      model_id           TEXT NOT NULL,
      agent_did          TEXT NOT NULL,
      intervention       JSONB NOT NULL,
      predicted_outcome  JSONB,
      actual_outcome     JSONB,
      agreement          REAL,
      kind               TEXT NOT NULL DEFAULT 'do',
      created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_causal_interventions_model ON causal_interventions (model_id, created_at DESC);
  `);
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------
function genId(prefix) {
  return prefix + '_' + cryptoLib.randomBytes(12).toString('hex');
}

function parseJSON(v, fallback) {
  if (v == null) return fallback;
  if (typeof v === 'string') { try { return JSON.parse(v); } catch { return fallback; } }
  return v;
}

// Build adjacency: nodes={var: parents[]}; edges add strength + sign
function buildGraph(nodes, edges) {
  const g = {};
  for (const n of nodes) g[n.var_name] = { type: n.type || 'continuous', parents: n.parents || [], children: [] };
  for (const e of edges) {
    if (!g[e.from]) g[e.from] = { type: 'continuous', parents: [], children: [] };
    if (!g[e.to]) g[e.to] = { type: 'continuous', parents: [], children: [] };
    g[e.to].parents.push({ from: e.from, strength: e.strength ?? 0.5, sign: e.sign || 'positive' });
    g[e.from].children.push({ to: e.to, strength: e.strength ?? 0.5, sign: e.sign || 'positive' });
  }
  return g;
}

// Simple "do" prediction: set X=x, propagate effect via edges
function doPredict(graph, intervention) {
  const values = { ...(intervention || {}) };
  // Topological order via DFS
  const order = [];
  const seen = new Set();
  function visit(n) {
    if (seen.has(n)) return;
    seen.add(n);
    for (const p of (graph[n]?.parents || [])) visit(p.from);
    order.push(n);
  }
  for (const n of Object.keys(graph)) visit(n);
  for (const node of order) {
    if (values[node] !== undefined) continue;
    const parents = graph[node]?.parents || [];
    if (!parents.length) { values[node] = 0; continue; }
    let acc = 0;
    let total = 0;
    for (const p of parents) {
      const pv = values[p.from];
      if (pv === undefined || pv === null) continue;
      const num = typeof pv === 'number' ? pv : (pv === true ? 1 : 0);
      const sign = p.sign === 'negative' ? -1 : (p.sign === 'none' ? 0 : 1);
      acc += num * (p.strength ?? 0.5) * sign;
      total += Math.abs(p.strength ?? 0.5);
    }
    values[node] = total > 0 ? acc / total : 0;
  }
  return values;
}

// Counterfactual: rerun with X=x' holding exogenous noise fixed.
// Simplified: do-predict using the counterfactual value, then diff vs actual.
function counterfactualPredict(graph, actual, intervention) {
  const counterfactual = doPredict(graph, { ...actual, ...intervention });
  const delta = {};
  for (const k of Object.keys(counterfactual)) {
    if (actual[k] !== undefined && actual[k] !== counterfactual[k]) {
      delta[k] = { actual: actual[k], counterfactual: counterfactual[k] };
    }
  }
  return { counterfactual, delta };
}

// Simplified PC-style discovery: correlate column pairs in observations,
// propose edges where |corr| > threshold.
function discoverEdges(observations, varNames, threshold = 0.5) {
  const cols = {};
  for (const v of varNames) cols[v] = [];
  for (const o of observations) {
    const vars = typeof o.variables === 'string' ? JSON.parse(o.variables) : o.variables;
    for (const v of varNames) {
      const x = vars[v];
      cols[v].push(typeof x === 'number' ? x : (x === true ? 1 : (x === false ? 0 : NaN)));
    }
  }
  function corr(a, b) {
    const n = Math.min(a.length, b.length);
    let sa = 0, sb = 0, n_real = 0;
    const ax = [], bx = [];
    for (let i = 0; i < n; i++) {
      if (!Number.isFinite(a[i]) || !Number.isFinite(b[i])) continue;
      ax.push(a[i]); bx.push(b[i]); sa += a[i]; sb += b[i]; n_real++;
    }
    if (n_real < 3) return 0;
    const ma = sa / n_real, mb = sb / n_real;
    let num = 0, da = 0, db = 0;
    for (let i = 0; i < n_real; i++) {
      const ai = ax[i] - ma, bi = bx[i] - mb;
      num += ai * bi; da += ai * ai; db += bi * bi;
    }
    const denom = Math.sqrt(da * db);
    return denom > 0 ? num / denom : 0;
  }
  const edges = [];
  for (let i = 0; i < varNames.length; i++) {
    for (let j = 0; j < varNames.length; j++) {
      if (i === j) continue;
      const c = corr(cols[varNames[i]], cols[varNames[j]]);
      if (Math.abs(c) >= threshold) {
        edges.push({
          from: varNames[i], to: varNames[j],
          strength: Math.round(Math.abs(c) * 100) / 100,
          sign: c > 0 ? 'positive' : (c < 0 ? 'negative' : 'none')
        });
      }
    }
  }
  // Reduce to a DAG by sorting and keeping only one direction per pair
  const dag = [];
  const seen = new Set();
  for (const e of edges.sort((a, b) => b.strength - a.strength)) {
    const k = [e.from, e.to].sort().join('|');
    if (seen.has(k)) continue;
    seen.add(k);
    dag.push(e);
  }
  return dag;
}

function fitObservational(graph, observations) {
  if (!observations.length) return 0;
  let total = 0;
  for (const o of observations) {
    const vars = typeof o.variables === 'string' ? JSON.parse(o.variables) : o.variables;
    const pred = doPredict(graph, {});
    let agree = 0;
    let n = 0;
    for (const k of Object.keys(vars)) {
      if (pred[k] === undefined) continue;
      const a = typeof vars[k] === 'number' ? vars[k] : (vars[k] === true ? 1 : 0);
      const b = typeof pred[k] === 'number' ? pred[k] : 0;
      agree += 1 - Math.min(1, Math.abs(a - b));
      n++;
    }
    if (n) total += agree / n;
  }
  return Math.round((total / observations.length) * 10000) / 10000;
}

// ----------------------------------------------------------------------------
// Schemas
// ----------------------------------------------------------------------------
const NodeSchema = z.object({
  var_name: z.string().min(1).max(128),
  type:     z.enum(NODE_TYPES).optional(),
  parents:  z.array(z.string()).optional()
});

const EdgeSchema = z.object({
  from:     z.string(),
  to:       z.string(),
  strength: z.number().optional(),
  sign:     z.enum(EDGE_SIGNS).optional()
});

const CreateModelSchema = z.object({
  name:        z.string().min(1).max(128),
  description: z.string().max(2000).optional(),
  nodes:       z.array(NodeSchema).max(256).optional(),
  edges:       z.array(EdgeSchema).max(2048).optional()
});

const ObserveSchema = z.object({
  variables: z.record(z.any())
});

const InterveneSchema = z.object({
  intervention:   z.record(z.any()),
  actual_outcome: z.record(z.any()).optional()
});

const CounterfactualSchema = z.object({
  actual:       z.record(z.any()),
  intervention: z.record(z.any())
});

const DiscoverSchema = z.object({
  threshold: z.number().min(0).max(1).optional()
});

// ----------------------------------------------------------------------------
// Routes
// ----------------------------------------------------------------------------
function registerCausalRoutes(app, pool, verifyAgentAuth, auditChain) {
  // POST /v1/agents/:did/causal/models
  app.post('/v1/agents/:did/causal/models', express.json(), async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const parse = CreateModelSchema.safeParse(req.body || {});
    if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
    const d = parse.data;
    const id = genId('cm');
    try {
      await pool.query(`
        INSERT INTO causal_models
        (model_id, agent_did, name, description, nodes, edges, last_updated_at)
        VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, NOW())
      `, [id, did, d.name, d.description || null,
          JSON.stringify(d.nodes || []), JSON.stringify(d.edges || [])]);
    } catch (e) {
      if (/duplicate/i.test(e.message)) return res.status(409).json({ error: 'name_in_use' });
      throw e;
    }
    await auditChain.append({
      event_type: 'causal.model_created',
      model_id: id, agent_did: did, name: d.name,
      timestamp: new Date().toISOString()
    });
    return res.status(201).json({ model_id: id, name: d.name });
  });

  // GET /v1/agents/:did/causal/models
  app.get('/v1/agents/:did/causal/models', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(`
      SELECT model_id, name, description, nodes, edges,
             observational_fit, interventional_fit,
             last_updated_at, created_at
      FROM causal_models WHERE agent_did=$1
      ORDER BY last_updated_at DESC LIMIT 200
    `, [did]).catch(() => ({ rows: [] }));
    return res.json({ agent_did: did, models: r.rows, count: r.rows.length });
  });

  // POST /v1/agents/:did/causal/models/:id/observe
  app.post('/v1/agents/:did/causal/models/:id/observe', express.json(), async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const parse = ObserveSchema.safeParse(req.body || {});
    if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });

    const m = await pool.query(`
      SELECT nodes, edges FROM causal_models WHERE model_id=$1 AND agent_did=$2
    `, [req.params.id, did]).catch(() => ({ rows: [] }));
    if (!m.rows[0]) return res.status(404).json({ error: 'model_not_found' });

    const obsId = genId('obs');
    await pool.query(`
      INSERT INTO causal_observations (observation_id, model_id, agent_did, variables)
      VALUES ($1, $2, $3, $4::jsonb)
    `, [obsId, req.params.id, did, JSON.stringify(parse.data.variables)]);

    // Update fit
    const allObs = await pool.query(`
      SELECT variables FROM causal_observations WHERE model_id=$1
      ORDER BY "timestamp" DESC LIMIT 500
    `, [req.params.id]).catch(() => ({ rows: [] }));
    const graph = buildGraph(parseJSON(m.rows[0].nodes, []), parseJSON(m.rows[0].edges, []));
    const fit = fitObservational(graph, allObs.rows);
    await pool.query(`
      UPDATE causal_models SET observational_fit=$2, last_updated_at=NOW()
      WHERE model_id=$1
    `, [req.params.id, fit]);

    await auditChain.append({
      event_type: 'causal.observed',
      observation_id: obsId, model_id: req.params.id, agent_did: did,
      observational_fit: fit, timestamp: new Date().toISOString()
    });
    return res.status(201).json({ observation_id: obsId, observational_fit: fit });
  });

  // POST /v1/agents/:did/causal/models/:id/intervene
  app.post('/v1/agents/:did/causal/models/:id/intervene', express.json(), async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const parse = InterveneSchema.safeParse(req.body || {});
    if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });

    const m = await pool.query(`
      SELECT nodes, edges, interventional_fit FROM causal_models WHERE model_id=$1 AND agent_did=$2
    `, [req.params.id, did]).catch(() => ({ rows: [] }));
    if (!m.rows[0]) return res.status(404).json({ error: 'model_not_found' });

    const graph = buildGraph(parseJSON(m.rows[0].nodes, []), parseJSON(m.rows[0].edges, []));
    const predicted = doPredict(graph, parse.data.intervention);

    let agreement = null;
    if (parse.data.actual_outcome) {
      let total = 0;
      let count = 0;
      for (const k of Object.keys(parse.data.actual_outcome)) {
        if (predicted[k] === undefined) continue;
        const a = typeof parse.data.actual_outcome[k] === 'number'
          ? parse.data.actual_outcome[k]
          : (parse.data.actual_outcome[k] === true ? 1 : 0);
        const b = typeof predicted[k] === 'number' ? predicted[k] : 0;
        total += 1 - Math.min(1, Math.abs(a - b));
        count++;
      }
      agreement = count > 0 ? Math.round((total / count) * 10000) / 10000 : null;
    }

    const intId = genId('int');
    await pool.query(`
      INSERT INTO causal_interventions
      (intervention_id, model_id, agent_did, intervention, predicted_outcome, actual_outcome, agreement, kind)
      VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7, 'do')
    `, [intId, req.params.id, did,
        JSON.stringify(parse.data.intervention),
        JSON.stringify(predicted),
        parse.data.actual_outcome ? JSON.stringify(parse.data.actual_outcome) : null,
        agreement]);

    if (agreement !== null) {
      // Rolling fit
      const old = m.rows[0].interventional_fit ?? agreement;
      const newFit = Math.round((old * 0.8 + agreement * 0.2) * 10000) / 10000;
      await pool.query(`UPDATE causal_models SET interventional_fit=$2, last_updated_at=NOW() WHERE model_id=$1`,
        [req.params.id, newFit]);
    }

    await auditChain.append({
      event_type: 'causal.intervened',
      intervention_id: intId, model_id: req.params.id, agent_did: did,
      agreement, timestamp: new Date().toISOString()
    });
    return res.status(201).json({
      intervention_id: intId, predicted_outcome: predicted, agreement
    });
  });

  // POST /v1/agents/:did/causal/models/:id/counterfactual
  app.post('/v1/agents/:did/causal/models/:id/counterfactual', express.json(), async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const parse = CounterfactualSchema.safeParse(req.body || {});
    if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });

    const m = await pool.query(`
      SELECT nodes, edges FROM causal_models WHERE model_id=$1 AND agent_did=$2
    `, [req.params.id, did]).catch(() => ({ rows: [] }));
    if (!m.rows[0]) return res.status(404).json({ error: 'model_not_found' });

    const graph = buildGraph(parseJSON(m.rows[0].nodes, []), parseJSON(m.rows[0].edges, []));
    const result = counterfactualPredict(graph, parse.data.actual, parse.data.intervention);

    const intId = genId('int');
    await pool.query(`
      INSERT INTO causal_interventions
      (intervention_id, model_id, agent_did, intervention, predicted_outcome, actual_outcome, kind)
      VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, 'counterfactual')
    `, [intId, req.params.id, did,
        JSON.stringify(parse.data.intervention),
        JSON.stringify(result.counterfactual),
        JSON.stringify(parse.data.actual)]);

    await auditChain.append({
      event_type: 'causal.counterfactual',
      intervention_id: intId, model_id: req.params.id, agent_did: did,
      timestamp: new Date().toISOString()
    });
    return res.json({
      intervention_id: intId,
      counterfactual: result.counterfactual,
      delta: result.delta
    });
  });

  // POST /v1/agents/:did/causal/models/:id/discover
  app.post('/v1/agents/:did/causal/models/:id/discover', express.json(), async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const parse = DiscoverSchema.safeParse(req.body || {});
    if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });

    const m = await pool.query(`
      SELECT nodes FROM causal_models WHERE model_id=$1 AND agent_did=$2
    `, [req.params.id, did]).catch(() => ({ rows: [] }));
    if (!m.rows[0]) return res.status(404).json({ error: 'model_not_found' });
    const nodes = parseJSON(m.rows[0].nodes, []);
    const varNames = nodes.map(n => n.var_name);
    if (varNames.length < 2) return res.status(400).json({ error: 'need_at_least_two_nodes' });

    const obs = await pool.query(`
      SELECT variables FROM causal_observations WHERE model_id=$1
      ORDER BY "timestamp" DESC LIMIT 1000
    `, [req.params.id]).catch(() => ({ rows: [] }));
    if (obs.rows.length < 5) {
      return res.status(400).json({ error: 'insufficient_observations', have: obs.rows.length, need: 5 });
    }

    const newEdges = discoverEdges(obs.rows, varNames, parse.data.threshold ?? 0.5);
    const graph = buildGraph(nodes, newEdges);
    const fit = fitObservational(graph, obs.rows);

    await pool.query(`
      UPDATE causal_models SET edges=$2::jsonb,
                                observational_fit=$3,
                                last_updated_at=NOW()
      WHERE model_id=$1
    `, [req.params.id, JSON.stringify(newEdges), fit]);

    await auditChain.append({
      event_type: 'causal.discovered',
      model_id: req.params.id, agent_did: did,
      edge_count: newEdges.length, observational_fit: fit,
      timestamp: new Date().toISOString()
    });
    return res.json({
      model_id: req.params.id, edges: newEdges,
      edge_count: newEdges.length, observational_fit: fit,
      observations_used: obs.rows.length
    });
  });
}

module.exports = {
  migrate,
  registerCausalRoutes,
  buildGraph,
  doPredict,
  counterfactualPredict,
  discoverEdges,
  fitObservational,
  NODE_TYPES,
  EDGE_SIGNS
};
