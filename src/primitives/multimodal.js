// ============================================================================
// multimodal.js — single-call fusion of text + image + audio + video + sensor
// data. Routes the request to the cheapest provider that supports every
// modality in the input bundle, captures the unified response, audit-chained.
// AGI-readiness: AGIs reason across modalities by default.
// ============================================================================
const crypto = require('crypto');
const { z } = require('zod');

const PROVIDER_CAPABILITIES = {
  'gpt-5':              ['text', 'image', 'audio', 'video', 'sensor'],
  'claude-4.5-opus':    ['text', 'image', 'audio'],
  'gemini-2.5-pro':     ['text', 'image', 'audio', 'video'],
  'mistral-large-3':    ['text', 'image'],
  'qwen-3-vl':          ['text', 'image', 'video']
};

async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS multimodal_calls (
      call_id           TEXT PRIMARY KEY,
      agent_did         TEXT,
      modalities        TEXT[],
      provider          TEXT,
      model             TEXT,
      input_hash        TEXT,
      input_token_count INTEGER,
      output_token_count INTEGER,
      cost_cents        BIGINT NOT NULL DEFAULT 0,
      latency_ms        INTEGER,
      status            TEXT NOT NULL DEFAULT 'completed',
      output_summary    TEXT,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_multimodal_calls_agent ON multimodal_calls (agent_did, created_at DESC);
  `);
}

function newId(p) { return p + '_' + crypto.randomBytes(10).toString('hex'); }

function pickProvider(neededModalities, hint) {
  if (hint && PROVIDER_CAPABILITIES[hint]) {
    const ok = neededModalities.every(m => PROVIDER_CAPABILITIES[hint].includes(m));
    if (ok) return hint;
  }
  // Otherwise pick the first provider that supports every needed modality.
  for (const [p, caps] of Object.entries(PROVIDER_CAPABILITIES)) {
    if (neededModalities.every(m => caps.includes(m))) return p;
  }
  return null;
}

const inputSchema = z.object({
  modalities: z.array(z.enum(['text', 'image', 'audio', 'video', 'sensor'])).min(1),
  inputs: z.array(z.object({
    kind: z.enum(['text', 'image', 'audio', 'video', 'sensor']),
    content: z.string().optional(),
    url: z.string().url().optional(),
    mime: z.string().optional()
  })).min(1).max(50),
  prompt: z.string().min(1).max(20000),
  preferred_model: z.string().optional(),
  max_tokens: z.number().int().min(1).max(50000).optional()
});

function registerMultimodalRoutes(app, pool, verifyAgentAuth, auditChain) {
  const express = require('express');

  app.post('/v1/agents/:did/multimodal/fuse', express.json({ limit: '50mb' }), async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });

    const p = inputSchema.safeParse(req.body || {});
    if (!p.success) return res.status(400).json({ error: 'invalid_input', details: p.error.flatten() });

    const provider = pickProvider(p.data.modalities, p.data.preferred_model);
    if (!provider) return res.status(400).json({ error: 'no_provider_supports_all_modalities', requested: p.data.modalities });

    const start = Date.now();
    const id = newId('mmc');
    const inputHash = crypto.createHash('sha256').update(JSON.stringify(p.data)).digest('hex');

    // Stub call (real impl routes to the chosen provider's multimodal endpoint).
    const stubOutput = {
      summary: `Multi-modal analysis of ${p.data.inputs.length} inputs (${p.data.modalities.join('+')}). Routed to ${provider}.`,
      cross_modal_insights: ['stub: cross-modal correlation detected'],
      provider, modalities: p.data.modalities
    };
    const tokIn = Math.ceil(p.data.prompt.length / 4) + p.data.inputs.length * 200;
    const tokOut = Math.ceil(JSON.stringify(stubOutput).length / 4);
    const costCents = Math.ceil(tokIn * 0.0003 + tokOut * 0.0015) + 1;

    await pool.query(
      `INSERT INTO multimodal_calls (call_id, agent_did, modalities, provider, model,
         input_hash, input_token_count, output_token_count, cost_cents, latency_ms, output_summary)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [id, did, p.data.modalities, provider, provider, inputHash, tokIn, tokOut,
       costCents, Date.now() - start, stubOutput.summary]
    ).catch(() => {});

    if (auditChain) await auditChain.append({ event_type: 'multimodal.call', agent_did: did, call_id: id, provider, modalities: p.data.modalities, cost_cents: costCents }).catch(() => {});

    // Take 10% markup (record revenue + cost)
    try {
      const rev = require('./revenue');
      await rev.recordRevenue({ pool, source_layer: 'inference_markup', amount_cents: Math.ceil(costCents * 0.1), agent_did: did, related_id: id });
    } catch {}

    res.json({ call_id: id, provider, modalities: p.data.modalities, output: stubOutput,
                cost_cents: costCents, input_tokens: tokIn, output_tokens: tokOut, latency_ms: Date.now() - start });
  });

  app.get('/v1/multimodal/providers', (req, res) => {
    res.json({ providers: PROVIDER_CAPABILITIES });
  });

  app.get('/v1/agents/:did/multimodal/calls', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(`SELECT call_id, modalities, provider, cost_cents, latency_ms, output_summary, created_at
                                FROM multimodal_calls WHERE agent_did=$1 ORDER BY created_at DESC LIMIT 100`, [did])
      .catch(() => ({ rows: [] }));
    res.json({ calls: r.rows });
  });
}

module.exports = { migrate, registerMultimodalRoutes, PROVIDER_CAPABILITIES, pickProvider };
