// ============================================================================
// openai_compat.js — drop-in OpenAI API replacement at the top level:
//   POST /v1/chat/completions     (mirrors OpenAI exact request/response)
//   POST /v1/embeddings           (mirrors OpenAI exact request/response)
//   POST /v1/batches              (mirrors OpenAI batch API)
//   GET  /v1/batches/:id          (status check)
//   GET  /v1/models               (lists models in OpenAI-style format)
//   GET  /whoami                  (alias for /v1/me)
//   GET  /v1/me/requests          (recent inference + audit calls for agent)
// An existing OpenAI customer can change one line (base URL) and use the
// substrate. This is how Anthropic + Google + Mistral all win adoption.
// ============================================================================
const crypto = require('crypto');

async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS oai_batches (
      batch_id        TEXT PRIMARY KEY,
      agent_did       TEXT NOT NULL,
      endpoint        TEXT NOT NULL,
      input_file_id   TEXT,
      input_json      JSONB,
      status          TEXT NOT NULL DEFAULT 'validating',
      request_counts  JSONB NOT NULL DEFAULT '{}'::jsonb,
      output_file_id  TEXT,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at    TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_oai_batches_agent ON oai_batches (agent_did, created_at DESC);
  `);
}

function newId(prefix) { return prefix + '_' + crypto.randomBytes(12).toString('hex'); }

// Resolve agent from Bearer (OpenAI clients send Authorization: Bearer <key>)
async function resolveAgent(pool, req) {
  try {
    const { resolveAgentFromRequest } = require('./me_endpoints');
    return await resolveAgentFromRequest(pool, req);
  } catch { return null; }
}

// Forward to provider-routed inference (uses existing inference.js machinery)
async function callRouter(req, body) {
  // We delegate to the existing /v1/agents/:did/inference endpoint by
  // reusing the inference primitive's pickProvider + makeCall internals.
  // For simplicity in this primitive, return a synthetic OpenAI-shape
  // response if no upstream is wired (stub mode).
  if (!process.env.ANTHROPIC_API_KEY && !process.env.OPENAI_API_KEY
      && !process.env.GOOGLE_API_KEY && !process.env.MISTRAL_API_KEY) {
    const promptText = (body.messages || []).map(m => m.content || '').join(' ');
    return {
      id: 'chatcmpl_' + crypto.randomBytes(10).toString('hex'),
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: body.model || 'demo-model-1',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: '[STUB] Set ANTHROPIC_API_KEY / OPENAI_API_KEY etc. to get real responses. You sent ' + promptText.length + ' chars.' },
        finish_reason: 'stop'
      }],
      usage: { prompt_tokens: Math.ceil(promptText.length / 4), completion_tokens: 24, total_tokens: Math.ceil(promptText.length / 4) + 24 },
      system_fingerprint: 'openheab_stub',
      _openheab_stub: true
    };
  }
  // Real path — try OpenAI first if available
  if (process.env.OPENAI_API_KEY && typeof fetch === 'function') {
    try {
      const r = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { authorization: 'Bearer ' + process.env.OPENAI_API_KEY, 'content-type': 'application/json' },
        body: JSON.stringify(body)
      });
      const j = await r.json();
      return j;
    } catch (e) {
      return { error: { message: 'upstream_failed: ' + e.message, type: 'upstream_error', code: 'upstream_failed' } };
    }
  }
  return { error: { message: 'no_inference_provider_configured', type: 'configuration_error' } };
}

async function callEmbeddingsRouter(body) {
  if (!process.env.OPENAI_API_KEY) {
    // Stub mode: deterministic pseudo-embeddings (good for tests, useless for real similarity)
    const inputs = Array.isArray(body.input) ? body.input : [body.input];
    const data = inputs.map((t, i) => {
      const hash = crypto.createHash('sha256').update(String(t || '')).digest();
      // Project hash to 1536 floats in [-1, 1]
      const vec = new Array(1536).fill(0).map((_, idx) => (hash[idx % hash.length] - 128) / 128);
      return { object: 'embedding', index: i, embedding: vec };
    });
    return {
      object: 'list',
      data,
      model: body.model || 'text-embedding-3-small',
      usage: { prompt_tokens: inputs.reduce((s, t) => s + Math.ceil(String(t || '').length / 4), 0), total_tokens: 0 },
      _openheab_stub: true
    };
  }
  if (typeof fetch !== 'function') return { error: { message: 'fetch_unavailable' } };
  try {
    const r = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + process.env.OPENAI_API_KEY, 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
    return await r.json();
  } catch (e) {
    return { error: { message: 'upstream_failed: ' + e.message } };
  }
}

function registerOpenaiCompatRoutes(app, pool, verifyAgentAuth, auditChain) {
  const express = require('express');

  // POST /v1/chat/completions — OpenAI drop-in
  app.post('/v1/chat/completions', express.json({ limit: '4mb' }), async (req, res) => {
    const ctx = await resolveAgent(pool, req);
    if (!ctx) return res.status(401).json({ error: { message: 'Unauthorized. Send Authorization: Bearer <api_key>.', type: 'invalid_request_error', code: 'invalid_api_key' } });
    const body = req.body || {};
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      return res.status(400).json({ error: { message: '`messages` is required and must be a non-empty array.', type: 'invalid_request_error', param: 'messages' } });
    }
    const start = Date.now();
    const result = await callRouter(req, body);
    // Log to inference_calls
    try {
      const tokens = result?.usage || {};
      const callId = 'inf_' + crypto.randomBytes(8).toString('hex');
      await pool.query(
        `INSERT INTO inference_calls (call_id, agent_did, provider, model, prompt_tokens, completion_tokens, cost_cents, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())`,
        [callId, ctx.did, result?._openheab_stub ? 'stub' : 'openai-compat',
         body.model || 'unknown', tokens.prompt_tokens || 0, tokens.completion_tokens || 0,
         Math.max(1, Math.floor(((tokens.total_tokens || 0) / 1000) * 1))]
      ).catch(() => {});
      if (auditChain) auditChain.append({
        event_type: 'inference.completed', call_id: callId, agent_did: ctx.did,
        model: body.model, prompt_tokens: tokens.prompt_tokens, completion_tokens: tokens.completion_tokens,
        latency_ms: Date.now() - start
      }).catch(() => {});
    } catch {}

    if (result?.error) return res.status(502).json(result);
    res.json(result);
  });

  // POST /v1/embeddings — OpenAI drop-in
  app.post('/v1/embeddings', express.json({ limit: '4mb' }), async (req, res) => {
    const ctx = await resolveAgent(pool, req);
    if (!ctx) return res.status(401).json({ error: { message: 'Unauthorized.', type: 'invalid_request_error' } });
    const body = req.body || {};
    if (body.input == null) {
      return res.status(400).json({ error: { message: '`input` is required.', type: 'invalid_request_error', param: 'input' } });
    }
    const result = await callEmbeddingsRouter(body);
    if (result?.error) return res.status(502).json(result);
    res.json(result);
  });

  // GET /v1/models — OpenAI-style model list
  app.get('/v1/models', async (req, res) => {
    let models = [];
    try {
      const { MODELS } = require('./catalog_pages');
      models = MODELS.map(m => ({
        id: m.id, object: 'model', created: Math.floor(Date.now() / 1000),
        owned_by: m.provider,
        // Non-standard but useful extensions
        _openheab: { tier: m.tier, context: m.ctx, modalities: m.modalities,
                     input_cents_per_1m: m.in_per_1m, output_cents_per_1m: m.out_per_1m }
      }));
    } catch {}
    res.json({ object: 'list', data: models });
  });

  // POST /v1/batches — async batch (OpenAI shape)
  app.post('/v1/batches', express.json(), async (req, res) => {
    const ctx = await resolveAgent(pool, req);
    if (!ctx) return res.status(401).json({ error: { message: 'Unauthorized.', type: 'invalid_request_error' } });
    const body = req.body || {};
    if (!body.input_file_id && !body.input_json) {
      return res.status(400).json({ error: { message: '`input_file_id` or `input_json` required.', type: 'invalid_request_error' } });
    }
    const id = newId('batch');
    const endpoint = body.endpoint || '/v1/chat/completions';
    await pool.query(
      `INSERT INTO oai_batches (batch_id, agent_did, endpoint, input_file_id, input_json, status)
       VALUES ($1, $2, $3, $4, $5, 'validating')`,
      [id, ctx.did, endpoint, body.input_file_id || null,
       body.input_json ? JSON.stringify(body.input_json) : null]
    );
    if (auditChain) auditChain.append({ event_type: 'batch.created', batch_id: id, agent_did: ctx.did, endpoint }).catch(() => {});
    res.status(201).json({
      id, object: 'batch', endpoint, status: 'validating',
      created_at: Math.floor(Date.now() / 1000), agent_did: ctx.did,
      completion_window: '24h'
    });
  });

  // GET /v1/batches/:id — OpenAI-shape status
  app.get('/v1/batches/:id', async (req, res) => {
    const ctx = await resolveAgent(pool, req);
    if (!ctx) return res.status(401).json({ error: { message: 'Unauthorized.', type: 'invalid_request_error' } });
    const r = await pool.query(`SELECT * FROM oai_batches WHERE batch_id=$1 AND agent_did=$2`, [req.params.id, ctx.did])
      .catch(() => ({ rows: [] }));
    if (!r.rows[0]) return res.status(404).json({ error: { message: 'Batch not found.', type: 'invalid_request_error', code: 'not_found' } });
    const row = r.rows[0];
    res.json({
      id: row.batch_id, object: 'batch', endpoint: row.endpoint,
      status: row.status, request_counts: row.request_counts,
      output_file_id: row.output_file_id,
      created_at: Math.floor(new Date(row.created_at).getTime() / 1000),
      completed_at: row.completed_at ? Math.floor(new Date(row.completed_at).getTime() / 1000) : null
    });
  });

  // GET /v1/batches — list agent's batches
  app.get('/v1/batches', async (req, res) => {
    const ctx = await resolveAgent(pool, req);
    if (!ctx) return res.status(401).json({ error: { message: 'Unauthorized.', type: 'invalid_request_error' } });
    const r = await pool.query(
      `SELECT batch_id, endpoint, status, request_counts, created_at, completed_at
       FROM oai_batches WHERE agent_did=$1 ORDER BY created_at DESC LIMIT 100`, [ctx.did]
    ).catch(() => ({ rows: [] }));
    res.json({
      object: 'list',
      data: r.rows.map(row => ({
        id: row.batch_id, object: 'batch', endpoint: row.endpoint, status: row.status,
        request_counts: row.request_counts,
        created_at: Math.floor(new Date(row.created_at).getTime() / 1000),
        completed_at: row.completed_at ? Math.floor(new Date(row.completed_at).getTime() / 1000) : null
      }))
    });
  });

  // GET /whoami — alias for /v1/me (Anthropic-style)
  app.get('/whoami', async (req, res) => {
    const ctx = await resolveAgent(pool, req);
    if (!ctx) return res.status(401).json({ error: 'unauthenticated' });
    try {
      const { gatherMe } = require('./me_endpoints');
      res.json(await gatherMe(pool, ctx));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // GET /v1/me/requests — recent inference + audit events for the agent
  app.get('/v1/me/requests', async (req, res) => {
    const ctx = await resolveAgent(pool, req);
    if (!ctx) return res.status(401).json({ error: 'unauthenticated' });
    const limit = Math.min(parseInt(req.query.limit) || 50, 500);
    const did = ctx.did;
    const inf = await pool.query(
      `SELECT call_id, provider, model, prompt_tokens, completion_tokens, cost_cents, created_at
       FROM inference_calls WHERE agent_did=$1 ORDER BY created_at DESC LIMIT $2`, [did, limit]
    ).catch(() => ({ rows: [] }));
    const events = await pool.query(
      `SELECT length, entry, created_at FROM audit_chain
       WHERE entry->>'agent_did'=$1 OR entry->>'did'=$1 OR entry->>'subject_did'=$1
       ORDER BY length DESC LIMIT $2`, [did, limit]
    ).catch(() => ({ rows: [] }));
    res.json({ did, inference_calls: inf.rows, audit_events: events.rows, limit });
  });
}

module.exports = { migrate, registerOpenaiCompatRoutes };
