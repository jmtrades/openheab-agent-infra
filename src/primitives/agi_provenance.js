// ============================================================================
// agi_provenance.js — decision provenance for AGI outputs. Every output is
// traceable back to: input data → model + version → prompt + version →
// agent personality state → output. Required by EU AI Act + US AI Safety EO.
// ============================================================================
const crypto = require('crypto');
const { z } = require('zod');

async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS agi_provenance_records (
      record_id         TEXT PRIMARY KEY,
      agent_did         TEXT NOT NULL,
      output_hash       TEXT NOT NULL,
      input_hashes      TEXT[],
      model_provider    TEXT,
      model_id          TEXT,
      model_version     TEXT,
      prompt_version_id TEXT,
      personality_snapshot JSONB,
      tool_calls        JSONB,
      cited_sources     TEXT[],
      occurred_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_agi_provenance_records_agent ON agi_provenance_records (agent_did, occurred_at DESC);
    CREATE INDEX IF NOT EXISTS idx_agi_provenance_records_output ON agi_provenance_records (output_hash);
  `);
}

function newId(p) { return p + '_' + crypto.randomBytes(10).toString('hex'); }

const recordSchema = z.object({
  output_text: z.string().min(1).max(100000),
  inputs: z.array(z.string()).optional(),
  model_provider: z.string().optional(),
  model_id: z.string().optional(),
  model_version: z.string().optional(),
  prompt_version_id: z.string().optional(),
  tool_calls: z.array(z.record(z.any())).optional(),
  cited_sources: z.array(z.string()).optional()
});

function registerAgiProvenanceRoutes(app, pool, verifyAgentAuth, auditChain) {
  const express = require('express');

  app.post('/v1/agents/:did/agi-provenance', express.json({ limit: '10mb' }), async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const p = recordSchema.safeParse(req.body || {});
    if (!p.success) return res.status(400).json({ error: 'invalid_input', details: p.error.flatten() });

    const outputHash = crypto.createHash('sha256').update(p.data.output_text).digest('hex');
    const inputHashes = (p.data.inputs || []).map(i =>
      crypto.createHash('sha256').update(i).digest('hex')
    );

    // Snapshot agent personality state if available
    let personality = null;
    try {
      const r = await pool.query(`SELECT openness, conscientiousness, extraversion, agreeableness, neuroticism, tone FROM agent_personality WHERE agent_did=$1`, [did])
        .catch(() => ({ rows: [] }));
      personality = r.rows[0] || null;
    } catch {}

    const id = newId('agprov');
    await pool.query(
      `INSERT INTO agi_provenance_records (record_id, agent_did, output_hash, input_hashes,
         model_provider, model_id, model_version, prompt_version_id, personality_snapshot, tool_calls, cited_sources)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [id, did, outputHash, inputHashes, p.data.model_provider || null,
       p.data.model_id || null, p.data.model_version || null,
       p.data.prompt_version_id || null, personality ? JSON.stringify(personality) : null,
       p.data.tool_calls ? JSON.stringify(p.data.tool_calls) : null,
       p.data.cited_sources || null]
    );
    if (auditChain) await auditChain.append({
      event_type: 'agi_provenance.recorded', record_id: id, agent_did: did,
      output_hash: outputHash, model: p.data.model_id
    }).catch(() => {});

    res.status(201).json({ record_id: id, output_hash: outputHash, input_hashes: inputHashes });
  });

  // Lookup: who said this? When? With what model? With what inputs?
  app.get('/v1/agi-provenance/by-output/:hash', async (req, res) => {
    const r = await pool.query(`SELECT * FROM agi_provenance_records WHERE output_hash=$1 ORDER BY occurred_at DESC LIMIT 10`, [req.params.hash])
      .catch(() => ({ rows: [] }));
    if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
    res.json({ records: r.rows });
  });

  app.get('/v1/agents/:did/agi-provenance', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const limit = Math.min(parseInt(req.query.limit) || 50, 500);
    const r = await pool.query(`
      SELECT record_id, output_hash, model_provider, model_id, model_version, occurred_at
      FROM agi_provenance_records WHERE agent_did=$1 ORDER BY occurred_at DESC LIMIT $2
    `, [did, limit]).catch(() => ({ rows: [] }));
    res.json({ records: r.rows });
  });

  // Reverse lookup: given an input, what outputs has this agent produced from it?
  app.get('/v1/agents/:did/agi-provenance/by-input/:hash', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(
      `SELECT record_id, output_hash, model_id, occurred_at FROM agi_provenance_records
       WHERE agent_did=$1 AND $2 = ANY(input_hashes) ORDER BY occurred_at DESC LIMIT 200`,
      [did, req.params.hash]
    ).catch(() => ({ rows: [] }));
    res.json({ records: r.rows });
  });
}

module.exports = { migrate, registerAgiProvenanceRoutes };
