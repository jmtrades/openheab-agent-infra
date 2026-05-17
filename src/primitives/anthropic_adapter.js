// ============================================================================
// anthropic_adapter.js — REAL Anthropic API integration. When
// ANTHROPIC_API_KEY is set, /v1/agents/:did/inference/anthropic forwards
// the request to api.anthropic.com with proper headers + audit-chain
// recording + cost tracking + 10% markup auto-recorded as revenue.
// ============================================================================
const crypto = require('crypto');
const { z } = require('zod');

const ANTHROPIC_BASE = 'https://api.anthropic.com/v1';
const ANTHROPIC_VERSION = '2023-06-01';

// Model price table (per 1M tokens, in cents)
const MODEL_PRICING = {
  'claude-opus-4-7':         { in: 1500, out: 7500 },
  'claude-opus-4-6':         { in: 1500, out: 7500 },
  'claude-sonnet-4-6':       { in: 300,  out: 1500 },
  'claude-sonnet-4-5':       { in: 300,  out: 1500 },
  'claude-haiku-4-5':        { in: 80,   out: 400 },
  'claude-3-7-sonnet-latest':{ in: 300,  out: 1500 },
  'claude-3-5-sonnet-latest':{ in: 300,  out: 1500 },
  'claude-3-5-haiku-latest': { in: 80,   out: 400 }
};

async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS anthropic_calls (
      call_id           TEXT PRIMARY KEY,
      agent_did         TEXT,
      model             TEXT NOT NULL,
      input_tokens      INTEGER,
      output_tokens     INTEGER,
      cost_cents        INTEGER,
      markup_cents      INTEGER,
      latency_ms        INTEGER,
      stop_reason       TEXT,
      status            TEXT NOT NULL DEFAULT 'ok',
      error             TEXT,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_anthropic_calls_agent ON anthropic_calls (agent_did, created_at DESC);
  `);
}

function newId(p) { return p + '_' + crypto.randomBytes(10).toString('hex'); }

function pricePerCall(model, tokIn, tokOut) {
  const m = MODEL_PRICING[model] || MODEL_PRICING['claude-haiku-4-5'];
  const inCost = Math.ceil(tokIn  * m.in  / 1_000_000);
  const outCost = Math.ceil(tokOut * m.out / 1_000_000);
  return inCost + outCost;
}

async function callAnthropic({ model, messages, max_tokens, temperature, system, tools, stream }) {
  if (!process.env.ANTHROPIC_API_KEY) {
    // Stub mode — return a deterministic shape matching Anthropic's response
    const lastUser = [...(messages || [])].reverse().find(m => m.role === 'user');
    const text = `[stub:${model}] ${(lastUser?.content || '').slice(0, 200)}\n\nSet ANTHROPIC_API_KEY to enable real Anthropic responses.`;
    const tokIn = Math.ceil(JSON.stringify(messages || []).length / 4);
    const tokOut = Math.ceil(text.length / 4);
    return {
      id: 'msg_stub_' + crypto.randomBytes(8).toString('hex'),
      type: 'message', role: 'assistant', model,
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn',
      usage: { input_tokens: tokIn, output_tokens: tokOut },
      stub: true
    };
  }
  const headers = {
    'content-type': 'application/json',
    'x-api-key': process.env.ANTHROPIC_API_KEY,
    'anthropic-version': ANTHROPIC_VERSION
  };
  const body = { model, messages, max_tokens: max_tokens || 1024 };
  if (system) body.system = system;
  if (temperature != null) body.temperature = temperature;
  if (tools) body.tools = tools;
  if (stream) body.stream = true;

  if (typeof fetch !== 'function') throw new Error('fetch_unavailable');
  const r = await fetch(`${ANTHROPIC_BASE}/messages`, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`anthropic_${r.status}_${text.slice(0, 200)}`);
  }
  return await r.json();
}

const chatSchema = z.object({
  model: z.string().default('claude-haiku-4-5'),
  messages: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.union([z.string(), z.array(z.any())]) })).min(1),
  max_tokens: z.number().int().min(1).max(200_000).optional(),
  temperature: z.number().min(0).max(2).optional(),
  system: z.string().optional(),
  tools: z.array(z.any()).optional()
});

function registerAnthropicAdapterRoutes(app, pool, verifyAgentAuth, auditChain) {
  const express = require('express');

  app.post('/v1/agents/:did/inference/anthropic', express.json({ limit: '5mb' }), async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const p = chatSchema.safeParse(req.body || {});
    if (!p.success) return res.status(400).json({ error: 'invalid_input', details: p.error.flatten() });

    const start = Date.now();
    let response;
    try { response = await callAnthropic(p.data); }
    catch (e) {
      await pool.query(`INSERT INTO anthropic_calls (call_id, agent_did, model, status, error)
                        VALUES ($1,$2,$3,'error',$4)`,
        [newId('anth'), did, p.data.model, e.message]).catch(() => {});
      return res.status(502).json({ error: 'anthropic_call_failed', message: e.message });
    }
    const latency = Date.now() - start;
    const tokIn = response.usage?.input_tokens || 0;
    const tokOut = response.usage?.output_tokens || 0;
    const cost = pricePerCall(p.data.model, tokIn, tokOut);
    const markup = Math.ceil(cost * 0.10);

    const id = newId('anth');
    await pool.query(
      `INSERT INTO anthropic_calls (call_id, agent_did, model, input_tokens, output_tokens, cost_cents, markup_cents, latency_ms, stop_reason)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [id, did, p.data.model, tokIn, tokOut, cost, markup, latency, response.stop_reason || null]
    ).catch(() => {});

    // Record 10% markup as inference revenue
    try {
      const rev = require('./revenue');
      await rev.recordRevenue({ pool, source_layer: 'inference_markup', amount_cents: markup, agent_did: did, related_id: id });
    } catch {}

    if (auditChain) await auditChain.append({
      event_type: 'inference.anthropic', call_id: id, agent_did: did,
      model: p.data.model, tokens_in: tokIn, tokens_out: tokOut, cost_cents: cost
    }).catch(() => {});

    res.json({ ...response, openheab: { call_id: id, cost_cents: cost, markup_cents: markup, latency_ms: latency } });
  });

  app.get('/v1/anthropic/models', (req, res) => {
    res.json({ models: Object.entries(MODEL_PRICING).map(([id, p]) => ({ id, pricing_per_1m_in_cents: p.in, pricing_per_1m_out_cents: p.out })),
                configured: !!process.env.ANTHROPIC_API_KEY,
                note: process.env.ANTHROPIC_API_KEY ? 'Live mode — real Anthropic API calls.' : 'Stub mode — set ANTHROPIC_API_KEY to enable real calls.' });
  });

  app.get('/v1/admin/anthropic/stats', async (req, res) => {
    const t = req.headers['x-admin-token'];
    const { safeTokenCompare: _stc } = require('../safe_compare'); if (!_stc(t, process.env.OPERATOR_ADMIN_TOKEN)) return res.status(401).json({ error: 'admin_auth_required' });
    const r = await pool.query(`
      SELECT model, COUNT(*)::int AS calls,
             SUM(input_tokens)::bigint AS tok_in, SUM(output_tokens)::bigint AS tok_out,
             SUM(cost_cents)::bigint AS cost, SUM(markup_cents)::bigint AS markup,
             AVG(latency_ms)::int AS avg_latency
      FROM anthropic_calls WHERE created_at > NOW() - INTERVAL '30 days' AND status='ok'
      GROUP BY model ORDER BY calls DESC
    `).catch(() => ({ rows: [] }));
    res.json({ by_model: r.rows });
  });
}

module.exports = { migrate, registerAnthropicAdapterRoutes, callAnthropic, pricePerCall, MODEL_PRICING };
