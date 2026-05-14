// ============================================================================
// OpenHeab Skills — Composable capabilities beyond tools
// Atomic / composite / learned skills with marketplace.
// ============================================================================
const express = require('express');
const cryptoLib = require('crypto');
const { z } = require('zod');

const SKILL_KINDS = ['atomic', 'composite', 'learned'];
const LICENSES    = ['commercial', 'research', 'open'];

// ----------------------------------------------------------------------------
// Migration
// ----------------------------------------------------------------------------
async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS skills (
      skill_id         TEXT PRIMARY KEY,
      agent_did        TEXT NOT NULL,
      name             TEXT NOT NULL,
      description      TEXT,
      kind             TEXT NOT NULL DEFAULT 'atomic',
      definition       JSONB NOT NULL DEFAULT '{}'::jsonb,
      preconditions    JSONB,
      postconditions   JSONB,
      success_rate     REAL,
      avg_duration_ms  INTEGER,
      invocations      BIGINT NOT NULL DEFAULT 0,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (agent_did, name)
    );
    CREATE INDEX IF NOT EXISTS idx_skills_agent ON skills (agent_did);
    CREATE INDEX IF NOT EXISTS idx_skills_kind ON skills (kind);

    CREATE TABLE IF NOT EXISTS skill_invocations (
      invocation_id  TEXT PRIMARY KEY,
      skill_id       TEXT NOT NULL,
      agent_did      TEXT NOT NULL,
      input          JSONB,
      output         JSONB,
      success        BOOLEAN,
      duration_ms    INTEGER,
      error          TEXT,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_skill_invocations_skill ON skill_invocations (skill_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_skill_invocations_agent ON skill_invocations (agent_did, created_at DESC);

    CREATE TABLE IF NOT EXISTS skill_marketplace (
      listing_id   TEXT PRIMARY KEY,
      skill_id     TEXT NOT NULL,
      agent_did    TEXT NOT NULL,
      price_usdc   NUMERIC(38,6) NOT NULL DEFAULT 0,
      license      TEXT NOT NULL DEFAULT 'commercial',
      downloads    BIGINT NOT NULL DEFAULT 0,
      rating       REAL,
      public       BOOLEAN NOT NULL DEFAULT TRUE,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_skill_marketplace_public ON skill_marketplace (public, downloads DESC);
    CREATE INDEX IF NOT EXISTS idx_skill_marketplace_agent ON skill_marketplace (agent_did);
  `);
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------
function genId(prefix) {
  return prefix + '_' + cryptoLib.randomBytes(12).toString('hex');
}

async function runAtomic(skill, input) {
  const def = typeof skill.definition === 'string' ? JSON.parse(skill.definition) : (skill.definition || {});
  const ref = def.implementation_ref || null;
  // No external execution: echo input shaped by output_schema keys (if present)
  const outSchema = def.output_schema || {};
  const out = {};
  for (const k of Object.keys(outSchema)) out[k] = input?.[k] ?? null;
  return { ok: true, ref, output: { ...out, _echo: input } };
}

async function runComposite(skill, input, pool, agentDid) {
  const def = typeof skill.definition === 'string' ? JSON.parse(skill.definition) : (skill.definition || {});
  const subs = Array.isArray(def.sub_skill_ids) ? def.sub_skill_ids : [];
  const trace = [];
  let cur = input;
  for (const sid of subs) {
    const r = await pool.query(
      `SELECT skill_id, agent_did, kind, definition FROM skills WHERE skill_id=$1`, [sid]
    ).catch(() => ({ rows: [] }));
    const sub = r.rows[0];
    if (!sub) { trace.push({ sub_skill_id: sid, error: 'not_found' }); continue; }
    let sr;
    if (sub.kind === 'composite') sr = await runComposite(sub, cur, pool, agentDid);
    else if (sub.kind === 'learned') sr = await runLearned(sub, cur);
    else sr = await runAtomic(sub, cur);
    trace.push({ sub_skill_id: sid, output: sr.output });
    cur = sr.output;
  }
  return { ok: true, output: cur, trace };
}

async function runLearned(skill, input) {
  const def = typeof skill.definition === 'string' ? JSON.parse(skill.definition) : (skill.definition || {});
  // Placeholder: returns a synthetic answer keyed by model_ref + input hash
  const h = cryptoLib.createHash('sha256').update(JSON.stringify(input || {})).digest('hex').slice(0, 8);
  return {
    ok: true,
    output: { model_ref: def.model_ref || null, prediction: `learned:${h}`, input_hash: h }
  };
}

// ----------------------------------------------------------------------------
// Schemas
// ----------------------------------------------------------------------------
const AtomicDef = z.object({
  input_schema:        z.record(z.any()).optional(),
  output_schema:       z.record(z.any()).optional(),
  implementation_ref:  z.string().optional()
});

const CompositeDef = z.object({
  sub_skill_ids: z.array(z.string()).min(1).max(64)
});

const LearnedDef = z.object({
  training_data_uri: z.string().optional(),
  model_ref:         z.string().optional()
});

const RegisterSchema = z.object({
  name:           z.string().min(1).max(128),
  description:    z.string().max(2000).optional(),
  kind:           z.enum(SKILL_KINDS).optional(),
  definition:     z.any(),
  preconditions:  z.record(z.any()).optional(),
  postconditions: z.record(z.any()).optional()
});

const InvokeSchema = z.object({
  input: z.any().optional()
});

const ListingSchema = z.object({
  skill_id:   z.string(),
  price_usdc: z.number().min(0).optional(),
  license:    z.enum(LICENSES).optional(),
  public:     z.boolean().optional()
});

// ----------------------------------------------------------------------------
// Routes
// ----------------------------------------------------------------------------
function registerSkillsRoutes(app, pool, verifyAgentAuth, auditChain) {
  // POST /v1/agents/:did/skills
  app.post('/v1/agents/:did/skills', express.json(), async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const parse = RegisterSchema.safeParse(req.body || {});
    if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
    const d = parse.data;
    const kind = d.kind || 'atomic';

    // Validate definition shape
    let defParse;
    if (kind === 'atomic') defParse = AtomicDef.safeParse(d.definition || {});
    else if (kind === 'composite') defParse = CompositeDef.safeParse(d.definition || {});
    else defParse = LearnedDef.safeParse(d.definition || {});
    if (!defParse.success) {
      return res.status(400).json({ error: 'invalid_definition', kind, details: defParse.error.issues });
    }

    const id = genId('skl');
    try {
      await pool.query(`
        INSERT INTO skills
        (skill_id, agent_did, name, description, kind, definition,
         preconditions, postconditions, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, NOW())
      `, [id, did, d.name, d.description || null, kind,
          JSON.stringify(defParse.data),
          d.preconditions ? JSON.stringify(d.preconditions) : null,
          d.postconditions ? JSON.stringify(d.postconditions) : null]);
    } catch (e) {
      if (/duplicate/i.test(e.message)) return res.status(409).json({ error: 'name_in_use' });
      throw e;
    }
    await auditChain.append({
      event_type: 'skill.registered',
      skill_id: id, agent_did: did, name: d.name, kind,
      timestamp: new Date().toISOString()
    });
    return res.status(201).json({ skill_id: id, name: d.name, kind });
  });

  // GET /v1/agents/:did/skills
  app.get('/v1/agents/:did/skills', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const kind = req.query.kind;
    const params = [did];
    let extra = '';
    if (kind) { params.push(kind); extra = ` AND kind=$${params.length}`; }
    const r = await pool.query(`
      SELECT skill_id, name, description, kind, definition,
             preconditions, postconditions, success_rate, avg_duration_ms,
             invocations, created_at, updated_at
      FROM skills WHERE agent_did = $1 ${extra}
      ORDER BY updated_at DESC LIMIT 500
    `, params).catch(() => ({ rows: [] }));
    return res.json({ agent_did: did, skills: r.rows, count: r.rows.length });
  });

  // POST /v1/agents/:did/skills/:id/invoke
  app.post('/v1/agents/:did/skills/:id/invoke', express.json(), async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const parse = InvokeSchema.safeParse(req.body || {});
    if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });

    const skR = await pool.query(`
      SELECT skill_id, agent_did, name, kind, definition,
             success_rate, avg_duration_ms, invocations
      FROM skills WHERE skill_id=$1
    `, [req.params.id]).catch(() => ({ rows: [] }));
    if (!skR.rows[0]) return res.status(404).json({ error: 'skill_not_found' });
    const skill = skR.rows[0];
    if (skill.agent_did !== did) return res.status(403).json({ error: 'not_owner' });

    const invId = genId('inv');
    const t0 = Date.now();
    let success = false;
    let output = null;
    let errMsg = null;
    try {
      let result;
      if (skill.kind === 'composite') result = await runComposite(skill, parse.data.input || {}, pool, did);
      else if (skill.kind === 'learned') result = await runLearned(skill, parse.data.input || {});
      else result = await runAtomic(skill, parse.data.input || {});
      success = !!result.ok;
      output = result.output ?? result;
    } catch (e) {
      success = false;
      errMsg = e.message;
    }
    const duration = Date.now() - t0;

    await pool.query(`
      INSERT INTO skill_invocations
      (invocation_id, skill_id, agent_did, input, output, success, duration_ms, error)
      VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8)
    `, [invId, skill.skill_id, did,
        JSON.stringify(parse.data.input || {}),
        output != null ? JSON.stringify(output) : null,
        success, duration, errMsg]).catch(() => {});

    // Rolling stats update
    const newCount = (parseInt(skill.invocations) || 0) + 1;
    const oldRate = skill.success_rate ?? 0;
    const oldAvg = skill.avg_duration_ms ?? 0;
    const newRate = ((oldRate * (newCount - 1)) + (success ? 1 : 0)) / newCount;
    const newAvg = Math.round(((oldAvg * (newCount - 1)) + duration) / newCount);
    await pool.query(`
      UPDATE skills SET invocations=$2, success_rate=$3, avg_duration_ms=$4, updated_at=NOW()
      WHERE skill_id=$1
    `, [skill.skill_id, newCount, newRate, newAvg]).catch(() => {});

    await auditChain.append({
      event_type: 'skill.invoked',
      skill_id: skill.skill_id, invocation_id: invId, agent_did: did,
      success, duration_ms: duration, timestamp: new Date().toISOString()
    });
    return res.json({
      invocation_id: invId, skill_id: skill.skill_id, success,
      duration_ms: duration, output, error: errMsg
    });
  });

  // GET /v1/agents/:did/skills/:id/invocations
  app.get('/v1/agents/:did/skills/:id/invocations', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const r = await pool.query(`
      SELECT invocation_id, input, output, success, duration_ms, error, created_at
      FROM skill_invocations
      WHERE skill_id=$1 AND agent_did=$2
      ORDER BY created_at DESC LIMIT $3
    `, [req.params.id, did, limit]).catch(() => ({ rows: [] }));
    return res.json({ skill_id: req.params.id, invocations: r.rows, count: r.rows.length });
  });

  // POST /v1/skills/marketplace — publish
  app.post('/v1/skills/marketplace', express.json(), async (req, res) => {
    const parse = ListingSchema.safeParse(req.body || {});
    if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
    const d = parse.data;
    const sk = await pool.query(`SELECT agent_did, name FROM skills WHERE skill_id=$1`, [d.skill_id])
      .catch(() => ({ rows: [] }));
    if (!sk.rows[0]) return res.status(404).json({ error: 'skill_not_found' });
    const auth = await verifyAgentAuth(req, sk.rows[0].agent_did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });

    const id = genId('lst');
    await pool.query(`
      INSERT INTO skill_marketplace
      (listing_id, skill_id, agent_did, price_usdc, license, public)
      VALUES ($1, $2, $3, $4, $5, $6)
    `, [id, d.skill_id, sk.rows[0].agent_did,
        d.price_usdc ?? 0, d.license || 'commercial', d.public !== false]);
    await auditChain.append({
      event_type: 'skill.listed',
      listing_id: id, skill_id: d.skill_id, agent_did: sk.rows[0].agent_did,
      price_usdc: d.price_usdc ?? 0, license: d.license || 'commercial',
      timestamp: new Date().toISOString()
    });
    return res.status(201).json({ listing_id: id, skill_id: d.skill_id });
  });

  // GET /v1/skills/marketplace — browse
  app.get('/v1/skills/marketplace', async (req, res) => {
    const license = req.query.license;
    const q = req.query.q;
    const params = [];
    const conds = [`m.public = TRUE`];
    if (license) { params.push(license); conds.push(`m.license = $${params.length}`); }
    if (q) {
      params.push(`%${q}%`);
      conds.push(`(s.name ILIKE $${params.length} OR s.description ILIKE $${params.length})`);
    }
    params.push(Math.min(parseInt(req.query.limit) || 50, 200));
    const r = await pool.query(`
      SELECT m.listing_id, m.skill_id, m.agent_did, m.price_usdc, m.license,
             m.downloads, m.rating, m.created_at,
             s.name, s.description, s.kind, s.success_rate
      FROM skill_marketplace m
      INNER JOIN skills s ON s.skill_id = m.skill_id
      WHERE ${conds.join(' AND ')}
      ORDER BY m.downloads DESC LIMIT $${params.length}
    `, params).catch(() => ({ rows: [] }));
    return res.json({ listings: r.rows, count: r.rows.length });
  });

  // POST /v1/skills/marketplace/:listing/install
  app.post('/v1/skills/marketplace/:listing/install', express.json(), async (req, res) => {
    const installerDid = req.body?.agent_did;
    if (!installerDid) return res.status(400).json({ error: 'agent_did_required' });
    const auth = await verifyAgentAuth(req, installerDid);
    if (!auth.valid) return res.status(401).json({ error: auth.error });

    const l = await pool.query(`
      SELECT m.skill_id, m.license, s.name, s.description, s.kind, s.definition,
             s.preconditions, s.postconditions
      FROM skill_marketplace m
      INNER JOIN skills s ON s.skill_id = m.skill_id
      WHERE m.listing_id = $1 AND m.public = TRUE
    `, [req.params.listing]).catch(() => ({ rows: [] }));
    if (!l.rows[0]) return res.status(404).json({ error: 'listing_not_found' });

    // Copy the skill into the installer's namespace, deduping name
    let newName = l.rows[0].name;
    const exists = await pool.query(
      `SELECT 1 FROM skills WHERE agent_did=$1 AND name=$2`, [installerDid, newName]
    ).catch(() => ({ rows: [] }));
    if (exists.rows[0]) newName = `${newName}_${cryptoLib.randomBytes(3).toString('hex')}`;

    const newId = genId('skl');
    await pool.query(`
      INSERT INTO skills
      (skill_id, agent_did, name, description, kind, definition,
       preconditions, postconditions, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, NOW())
    `, [newId, installerDid, newName, l.rows[0].description || null, l.rows[0].kind,
        typeof l.rows[0].definition === 'string'
          ? l.rows[0].definition : JSON.stringify(l.rows[0].definition || {}),
        l.rows[0].preconditions ? JSON.stringify(l.rows[0].preconditions) : null,
        l.rows[0].postconditions ? JSON.stringify(l.rows[0].postconditions) : null]);

    await pool.query(`UPDATE skill_marketplace SET downloads = downloads + 1 WHERE listing_id = $1`,
      [req.params.listing]).catch(() => {});
    await auditChain.append({
      event_type: 'skill.installed',
      listing_id: req.params.listing, new_skill_id: newId,
      installer_did: installerDid, license: l.rows[0].license,
      timestamp: new Date().toISOString()
    });
    return res.status(201).json({
      installed_skill_id: newId, name: newName,
      license: l.rows[0].license
    });
  });
}

module.exports = {
  migrate,
  registerSkillsRoutes,
  runAtomic,
  runComposite,
  runLearned,
  SKILL_KINDS,
  LICENSES
};
