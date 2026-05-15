// ============================================================================
// google_adapter.js — REAL Google Gemini API. Pricing per 1M tokens.
// ============================================================================
const crypto = require('crypto');
const { z } = require('zod');

const BASE = 'https://generativelanguage.googleapis.com/v1beta';
const PRICING = {
  'gemini-2.5-pro':       { in: 125,  out: 1000 },
  'gemini-2.5-flash':     { in: 30,   out: 250 },
  'gemini-2.5-flash-lite':{ in: 10,   out: 40 },
  'gemini-2.0-flash':     { in: 30,   out: 250 },
  'gemini-2.0-flash-lite':{ in: 8,    out: 30 }
};

async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS google_calls (
      call_id TEXT PRIMARY KEY, agent_did TEXT, model TEXT NOT NULL,
      input_tokens INTEGER, output_tokens INTEGER,
      cost_cents INTEGER, markup_cents INTEGER, latency_ms INTEGER,
      status TEXT NOT NULL DEFAULT 'ok', error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_google_calls_agent ON google_calls (agent_did, created_at DESC);
  `);
}

function newId(p) { return p + '_' + crypto.randomBytes(10).toString('hex'); }
function priceCall(model, tokIn, tokOut) {
  const m = PRICING[model] || PRICING['gemini-2.5-flash-lite'];
  return Math.ceil(tokIn * m.in / 1_000_000) + Math.ceil(tokOut * m.out / 1_000_000);
}

async function callGoogle(model, body) {
  if (!process.env.GOOGLE_AI_API_KEY) {
    const text = `[stub:${model}] Set GOOGLE_AI_API_KEY for real responses.`;
    return { candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }],
             usageMetadata: { promptTokenCount: 100, candidatesTokenCount: text.length / 4, totalTokenCount: 100 + text.length / 4 }, stub: true };
  }
  if (typeof fetch !== 'function') throw new Error('fetch_unavailable');
  const r = await fetch(`${BASE}/models/${encodeURIComponent(model)}:generateContent?key=${process.env.GOOGLE_AI_API_KEY}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
  });
  if (!r.ok) throw new Error(`google_${r.status}_${(await r.text()).slice(0, 200)}`);
  return await r.json();
}

const schema = z.object({
  model: z.string().default('gemini-2.5-flash'),
  contents: z.array(z.object({ role: z.enum(['user', 'model']).optional(), parts: z.array(z.any()) })).min(1),
  generationConfig: z.any().optional()
});

function registerGoogleAdapterRoutes(app, pool, verifyAgentAuth, auditChain) {
  const express = require('express');
  app.post('/v1/agents/:did/inference/google', express.json({ limit: '10mb' }), async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const p = schema.safeParse(req.body || {});
    if (!p.success) return res.status(400).json({ error: 'invalid_input', details: p.error.flatten() });
    const start = Date.now();
    let response;
    try { response = await callGoogle(p.data.model, p.data); }
    catch (e) { return res.status(502).json({ error: 'google_call_failed', message: e.message }); }
    const tokIn = response.usageMetadata?.promptTokenCount || 0;
    const tokOut = response.usageMetadata?.candidatesTokenCount || 0;
    const cost = priceCall(p.data.model, tokIn, tokOut);
    const markup = Math.ceil(cost * 0.10);
    const id = newId('ggl');
    await pool.query(`INSERT INTO google_calls (call_id, agent_did, model, input_tokens, output_tokens, cost_cents, markup_cents, latency_ms) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [id, did, p.data.model, tokIn, tokOut, cost, markup, Date.now() - start]).catch(() => {});
    try {
      const rev = require('./revenue');
      await rev.recordRevenue({ pool, source_layer: 'inference_markup', amount_cents: markup, agent_did: did, related_id: id });
    } catch {}
    if (auditChain) await auditChain.append({ event_type: 'inference.google', call_id: id, agent_did: did, model: p.data.model, cost_cents: cost }).catch(() => {});
    res.json({ ...response, openheab: { call_id: id, cost_cents: cost, markup_cents: markup } });
  });
  app.get('/v1/google/models', (req, res) => {
    res.json({ models: Object.entries(PRICING).map(([id, p]) => ({ id, ...p })),
                configured: !!process.env.GOOGLE_AI_API_KEY });
  });
}

module.exports = { migrate, registerGoogleAdapterRoutes, callGoogle, PRICING };
