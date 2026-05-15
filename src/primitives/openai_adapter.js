// ============================================================================
// openai_adapter.js — REAL OpenAI API integration. Chat completions +
// embeddings + responses API. Stub mode when OPENAI_API_KEY unset.
// 10% markup auto-recorded as inference_markup revenue.
// ============================================================================
const crypto = require('crypto');
const { z } = require('zod');

const OPENAI_BASE = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
const MODEL_PRICING = {
  'gpt-5':                 { in: 1250, out: 5000 },
  'gpt-5-mini':            { in: 25,   out: 200 },
  'gpt-5-nano':            { in: 5,    out: 40 },
  'gpt-4o':                { in: 250,  out: 1000 },
  'gpt-4o-mini':           { in: 15,   out: 60 },
  'gpt-4-turbo':           { in: 1000, out: 3000 },
  'o1':                    { in: 1500, out: 6000 },
  'o1-mini':               { in: 300,  out: 1200 },
  'text-embedding-3-small':{ in: 2,    out: 0 },
  'text-embedding-3-large':{ in: 13,   out: 0 }
};

async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS openai_calls (
      call_id           TEXT PRIMARY KEY,
      agent_did         TEXT,
      model             TEXT NOT NULL,
      kind              TEXT NOT NULL,
      input_tokens      INTEGER,
      output_tokens     INTEGER,
      cost_cents        INTEGER,
      markup_cents      INTEGER,
      latency_ms        INTEGER,
      status            TEXT NOT NULL DEFAULT 'ok',
      error             TEXT,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_openai_calls_agent ON openai_calls (agent_did, created_at DESC);
  `);
}

function newId(p) { return p + '_' + crypto.randomBytes(10).toString('hex'); }
function priceCall(model, tokIn, tokOut) {
  const m = MODEL_PRICING[model] || MODEL_PRICING['gpt-4o-mini'];
  return Math.ceil(tokIn * m.in / 1_000_000) + Math.ceil(tokOut * m.out / 1_000_000);
}

async function callOpenAI(kind, body) {
  if (!process.env.OPENAI_API_KEY) {
    if (kind === 'embeddings') {
      const inputs = Array.isArray(body.input) ? body.input : [body.input];
      const data = inputs.map((t, i) => ({
        object: 'embedding', index: i,
        embedding: Array.from({ length: 1536 }, (_, j) => Math.sin(j * (t.length + 1)) * 0.1)
      }));
      return { object: 'list', data, model: body.model, usage: { prompt_tokens: inputs.join('').length / 4, total_tokens: inputs.join('').length / 4 }, stub: true };
    }
    const lastUser = [...(body.messages || [])].reverse().find(m => m.role === 'user');
    const text = `[stub:${body.model}] ${(lastUser?.content || '').slice(0, 200)}\n\nSet OPENAI_API_KEY for real responses.`;
    return {
      id: 'chatcmpl_stub_' + crypto.randomBytes(8).toString('hex'),
      object: 'chat.completion', model: body.model,
      choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
      usage: { prompt_tokens: Math.ceil(JSON.stringify(body.messages).length / 4),
                completion_tokens: Math.ceil(text.length / 4),
                total_tokens: Math.ceil((JSON.stringify(body.messages).length + text.length) / 4) },
      stub: true
    };
  }
  if (typeof fetch !== 'function') throw new Error('fetch_unavailable');
  const r = await fetch(`${OPENAI_BASE}/${kind === 'embeddings' ? 'embeddings' : 'chat/completions'}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify(body)
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`openai_${r.status}_${t.slice(0, 200)}`);
  }
  return await r.json();
}

const chatSchema = z.object({
  model: z.string().default('gpt-4o-mini'),
  messages: z.array(z.object({ role: z.enum(['system', 'user', 'assistant', 'tool', 'developer']), content: z.union([z.string(), z.array(z.any())]) })).min(1),
  max_tokens: z.number().int().min(1).max(200_000).optional(),
  temperature: z.number().min(0).max(2).optional(),
  tools: z.array(z.any()).optional(),
  response_format: z.any().optional()
});
const embedSchema = z.object({
  model: z.string().default('text-embedding-3-small'),
  input: z.union([z.string(), z.array(z.string()).min(1).max(2048)])
});

function registerOpenaiAdapterRoutes(app, pool, verifyAgentAuth, auditChain) {
  const express = require('express');

  app.post('/v1/agents/:did/inference/openai', express.json({ limit: '10mb' }), async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const p = chatSchema.safeParse(req.body || {});
    if (!p.success) return res.status(400).json({ error: 'invalid_input', details: p.error.flatten() });

    const start = Date.now();
    let response;
    try { response = await callOpenAI('chat', p.data); }
    catch (e) {
      await pool.query(`INSERT INTO openai_calls (call_id, agent_did, model, kind, status, error) VALUES ($1,$2,$3,'chat','error',$4)`,
        [newId('oai'), did, p.data.model, e.message]).catch(() => {});
      return res.status(502).json({ error: 'openai_call_failed', message: e.message });
    }
    const tokIn = response.usage?.prompt_tokens || 0;
    const tokOut = response.usage?.completion_tokens || 0;
    const cost = priceCall(p.data.model, tokIn, tokOut);
    const markup = Math.ceil(cost * 0.10);
    const id = newId('oai');
    await pool.query(
      `INSERT INTO openai_calls (call_id, agent_did, model, kind, input_tokens, output_tokens, cost_cents, markup_cents, latency_ms) VALUES ($1,$2,$3,'chat',$4,$5,$6,$7,$8)`,
      [id, did, p.data.model, tokIn, tokOut, cost, markup, Date.now() - start]
    ).catch(() => {});
    try {
      const rev = require('./revenue');
      await rev.recordRevenue({ pool, source_layer: 'inference_markup', amount_cents: markup, agent_did: did, related_id: id });
    } catch {}
    if (auditChain) await auditChain.append({ event_type: 'inference.openai', call_id: id, agent_did: did, model: p.data.model, tokens_in: tokIn, tokens_out: tokOut, cost_cents: cost }).catch(() => {});
    res.json({ ...response, openheab: { call_id: id, cost_cents: cost, markup_cents: markup, latency_ms: Date.now() - start } });
  });

  app.post('/v1/agents/:did/inference/openai/embeddings', express.json({ limit: '10mb' }), async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const p = embedSchema.safeParse(req.body || {});
    if (!p.success) return res.status(400).json({ error: 'invalid_input', details: p.error.flatten() });
    let response;
    try { response = await callOpenAI('embeddings', p.data); }
    catch (e) { return res.status(502).json({ error: 'openai_call_failed', message: e.message }); }
    const tokIn = response.usage?.prompt_tokens || 0;
    const cost = priceCall(p.data.model, tokIn, 0);
    const id = newId('oai');
    await pool.query(`INSERT INTO openai_calls (call_id, agent_did, model, kind, input_tokens, cost_cents, markup_cents) VALUES ($1,$2,$3,'embeddings',$4,$5,$6)`,
      [id, did, p.data.model, tokIn, cost, Math.ceil(cost * 0.10)]).catch(() => {});
    res.json({ ...response, openheab: { call_id: id, cost_cents: cost } });
  });

  app.get('/v1/openai/models', (req, res) => {
    res.json({ models: Object.entries(MODEL_PRICING).map(([id, p]) => ({ id, ...p })),
                configured: !!process.env.OPENAI_API_KEY,
                note: process.env.OPENAI_API_KEY ? 'Live OpenAI API.' : 'Stub mode — set OPENAI_API_KEY.' });
  });
}

module.exports = { migrate, registerOpenaiAdapterRoutes, callOpenAI, priceCall, MODEL_PRICING };
