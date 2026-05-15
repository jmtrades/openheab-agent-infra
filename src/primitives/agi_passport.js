// ============================================================================
// agi_passport.js — cross-lab AGI identity portability. An AGI's identity
// + reputation + audit chain follows it across providers (Claude → GPT →
// Gemini → Llama → custom-fine-tune) without re-issuance. The labs can't
// give you this; only a neutral substrate can.
//
// One did:op: per AGI for life. Provider rotation is just a signed event
// in the audit chain; the DID stays.
// ============================================================================
const crypto = require('crypto');
const { z } = require('zod');

const SUPPORTED_PROVIDERS = ['anthropic', 'openai', 'google', 'mistral', 'meta_llama',
                              'qwen', 'deepseek', 'openheab_inhouse', 'custom_fine_tune'];

async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS agi_passports (
      agent_did             TEXT PRIMARY KEY,
      issued_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      current_provider      TEXT,
      current_model         TEXT,
      current_model_version TEXT,
      lifetime_inference_calls BIGINT NOT NULL DEFAULT 0,
      lifetime_tokens       BIGINT NOT NULL DEFAULT 0,
      lifetime_cost_cents   BIGINT NOT NULL DEFAULT 0,
      portability_signature TEXT,
      attested_capabilities TEXT[]
    );
    CREATE TABLE IF NOT EXISTS agi_provider_history (
      transition_id     TEXT PRIMARY KEY,
      agent_did         TEXT NOT NULL,
      from_provider     TEXT,
      from_model        TEXT,
      to_provider       TEXT NOT NULL,
      to_model          TEXT NOT NULL,
      reason            TEXT,
      attested_by_did   TEXT,
      signature         TEXT,
      occurred_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_agi_provider_history_did
      ON agi_provider_history (agent_did, occurred_at DESC);
    CREATE TABLE IF NOT EXISTS agi_export_packages (
      export_id         TEXT PRIMARY KEY,
      agent_did         TEXT NOT NULL,
      requested_by_did  TEXT,
      sha256            TEXT NOT NULL,
      size_bytes        BIGINT NOT NULL,
      content           JSONB NOT NULL,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

function newId(p) { return p + '_' + crypto.randomBytes(10).toString('hex'); }

const transitionSchema = z.object({
  to_provider: z.enum(SUPPORTED_PROVIDERS),
  to_model: z.string().min(1).max(120),
  from_provider: z.string().optional(),
  from_model: z.string().optional(),
  reason: z.enum(['cost_optimization', 'capability_upgrade', 'deprecation',
                    'safety_concern', 'lab_outage', 'manual', 'experiment']).optional(),
  signature: z.string().optional()
});

function registerAgiPassportRoutes(app, pool, verifyAgentAuth, auditChain) {
  const express = require('express');

  app.post('/v1/agents/:did/agi-passport', express.json(), async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const provider = req.body?.initial_provider || 'openheab_inhouse';
    const model = req.body?.initial_model || 'openheab-base';
    await pool.query(
      `INSERT INTO agi_passports (agent_did, current_provider, current_model, current_model_version)
       VALUES ($1,$2,$3,$4) ON CONFLICT (agent_did) DO NOTHING`,
      [did, provider, model, req.body?.initial_version || 'v1']
    );
    if (auditChain) await auditChain.append({ event_type: 'agi_passport.issued', agent_did: did, provider, model }).catch(() => {});
    res.status(201).json({ agent_did: did, current_provider: provider, current_model: model });
  });

  app.get('/v1/agents/:did/agi-passport', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const p = await pool.query(`SELECT * FROM agi_passports WHERE agent_did=$1`, [did]).catch(() => ({ rows: [] }));
    if (!p.rows[0]) return res.status(404).json({ error: 'no_passport' });
    const h = await pool.query(`SELECT from_provider, from_model, to_provider, to_model, reason, occurred_at FROM agi_provider_history WHERE agent_did=$1 ORDER BY occurred_at DESC LIMIT 50`, [did])
      .catch(() => ({ rows: [] }));
    res.json({ ...p.rows[0], lifetime_inference_calls: Number(p.rows[0].lifetime_inference_calls),
                lifetime_tokens: Number(p.rows[0].lifetime_tokens),
                lifetime_cost_cents: Number(p.rows[0].lifetime_cost_cents),
                provider_history: h.rows });
  });

  app.post('/v1/agents/:did/agi-passport/transition', express.json(), async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const p = transitionSchema.safeParse(req.body || {});
    if (!p.success) return res.status(400).json({ error: 'invalid_input', details: p.error.flatten() });
    const cur = await pool.query(`SELECT current_provider, current_model FROM agi_passports WHERE agent_did=$1`, [did])
      .catch(() => ({ rows: [] }));
    const id = newId('agtr');
    await pool.query(
      `INSERT INTO agi_provider_history (transition_id, agent_did, from_provider, from_model, to_provider, to_model, reason, signature)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [id, did, cur.rows[0]?.current_provider || null, cur.rows[0]?.current_model || null,
       p.data.to_provider, p.data.to_model, p.data.reason || 'manual', p.data.signature || null]
    );
    await pool.query(`UPDATE agi_passports SET current_provider=$1, current_model=$2 WHERE agent_did=$3`,
      [p.data.to_provider, p.data.to_model, did]).catch(() => {});
    if (auditChain) await auditChain.append({
      event_type: 'agi_passport.provider_changed', agent_did: did,
      from: cur.rows[0]?.current_provider, to: p.data.to_provider, reason: p.data.reason
    }).catch(() => {});
    res.status(201).json({ transition_id: id, from: cur.rows[0]?.current_provider, to: p.data.to_provider });
  });

  // Full export — agent takes everything across providers
  app.post('/v1/agents/:did/agi-passport/export', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const passport = await pool.query(`SELECT * FROM agi_passports WHERE agent_did=$1`, [did]).catch(() => ({ rows: [] }));
    const history = await pool.query(`SELECT * FROM agi_provider_history WHERE agent_did=$1 ORDER BY occurred_at`, [did]).catch(() => ({ rows: [] }));
    let memory = []; try {
      const r = await pool.query(`SELECT key, value, updated_at FROM agent_memory WHERE agent_did=$1 LIMIT 10000`, [did]).catch(() => ({ rows: [] }));
      memory = r.rows;
    } catch {}
    let reputation = null;
    try {
      const r = await pool.query(`SELECT score FROM reputation_scores WHERE agent_did=$1`, [did]).catch(() => ({ rows: [] }));
      reputation = r.rows[0]?.score || null;
    } catch {}
    const content = { agent_did: did, passport: passport.rows[0], history: history.rows,
                       memory_sample: memory.slice(0, 100), reputation, exported_at: new Date().toISOString() };
    const json = JSON.stringify(content);
    const sha = crypto.createHash('sha256').update(json).digest('hex');
    const id = newId('agexp');
    await pool.query(
      `INSERT INTO agi_export_packages (export_id, agent_did, sha256, size_bytes, content)
       VALUES ($1,$2,$3,$4,$5)`,
      [id, did, sha, json.length, json]
    ).catch(() => {});
    if (auditChain) await auditChain.append({ event_type: 'agi_passport.exported', agent_did: did, export_id: id, sha256: sha, size_bytes: json.length }).catch(() => {});
    res.status(201).json({ export_id: id, sha256: sha, size_bytes: json.length, download_url: `/v1/agents/${did}/agi-passport/exports/${id}` });
  });

  app.get('/v1/agents/:did/agi-passport/exports/:eid', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(`SELECT content, sha256, created_at FROM agi_export_packages WHERE export_id=$1 AND agent_did=$2`,
      [req.params.eid, did]).catch(() => ({ rows: [] }));
    if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
    res.setHeader('content-type', 'application/json');
    res.setHeader('content-disposition', `attachment; filename="agi-passport-${did.slice(7, 19)}.json"`);
    res.send(typeof r.rows[0].content === 'string' ? r.rows[0].content : JSON.stringify(r.rows[0].content));
  });

  app.get('/v1/agi-passport/providers', (req, res) => {
    res.json({ supported: SUPPORTED_PROVIDERS, neutrality_note: 'OpenHeab is provider-neutral by design. Your DID stays the same across all of them.' });
  });
}

module.exports = { migrate, registerAgiPassportRoutes, SUPPORTED_PROVIDERS };
