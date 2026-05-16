// ============================================================================
// streaming_compat.js — proper SSE streaming for the OpenAI + Anthropic
// compat endpoints. Without streaming, no production app will use the
// drop-in compat. This makes /v1/chat/completions?stream=true and
// /v1/messages?stream=true actually work.
// ============================================================================
const crypto = require('crypto');

async function migrate(pool) {}

async function resolveAgent(pool, req) {
  try { return await require('./me_endpoints').resolveAgentFromRequest(pool, req); }
  catch { return null; }
}

function sseFrame(event, data) {
  // SSE frame format: optional `event:` line + `data:` line + blank line
  let out = '';
  if (event) out += 'event: ' + event + '\n';
  out += 'data: ' + (typeof data === 'string' ? data : JSON.stringify(data)) + '\n\n';
  return out;
}

// Synthetic streaming when no upstream provider is configured — emits
// realistic-shaped chunks so SDKs that consume SSE just work.
async function streamStubOpenAI(res, body) {
  const id = 'chatcmpl_' + crypto.randomBytes(10).toString('hex');
  const created = Math.floor(Date.now() / 1000);
  const model = body.model || 'demo-model-1';
  const text = '[STUB stream] Set OPENAI_API_KEY or ANTHROPIC_API_KEY to get real streaming responses.';

  // Initial role delta
  res.write(sseFrame(null, {
    id, object: 'chat.completion.chunk', created, model,
    choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }]
  }));
  // Content chunks (split words for realism)
  for (const word of text.split(' ')) {
    res.write(sseFrame(null, {
      id, object: 'chat.completion.chunk', created, model,
      choices: [{ index: 0, delta: { content: word + ' ' }, finish_reason: null }]
    }));
    await new Promise(r => setTimeout(r, 12));
  }
  // Final stop chunk
  res.write(sseFrame(null, {
    id, object: 'chat.completion.chunk', created, model,
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
  }));
  res.write('data: [DONE]\n\n');
}

async function streamStubAnthropic(res, body) {
  const id = 'msg_' + crypto.randomBytes(12).toString('hex');
  const text = '[STUB stream] Set ANTHROPIC_API_KEY to get real streaming responses.';
  const model = body.model || 'claude-haiku';

  res.write(sseFrame('message_start', {
    type: 'message_start',
    message: { id, type: 'message', role: 'assistant', model, content: [],
               stop_reason: null, stop_sequence: null, usage: { input_tokens: 4, output_tokens: 0 } }
  }));
  res.write(sseFrame('content_block_start', {
    type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' }
  }));
  for (const word of text.split(' ')) {
    res.write(sseFrame('content_block_delta', {
      type: 'content_block_delta', index: 0,
      delta: { type: 'text_delta', text: word + ' ' }
    }));
    await new Promise(r => setTimeout(r, 12));
  }
  res.write(sseFrame('content_block_stop', { type: 'content_block_stop', index: 0 }));
  res.write(sseFrame('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: 'end_turn', stop_sequence: null },
    usage: { output_tokens: text.split(' ').length }
  }));
  res.write(sseFrame('message_stop', { type: 'message_stop' }));
}

// Pipe an upstream SSE response straight through (real streaming).
async function pipeUpstream(upstream, res) {
  if (!upstream.body) {
    res.write('data: ' + JSON.stringify({ error: 'no_upstream_body' }) + '\n\n');
    return;
  }
  const reader = upstream.body.getReader();
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) res.write(Buffer.from(value));
  }
}

function setSseHeaders(res) {
  res.setHeader('content-type', 'text/event-stream; charset=utf-8');
  res.setHeader('cache-control', 'no-cache, no-transform');
  res.setHeader('connection', 'keep-alive');
  res.setHeader('x-accel-buffering', 'no');  // nginx: disable buffering
}

function registerStreamingCompatRoutes(app, pool, verifyAgentAuth, auditChain) {
  const express = require('express');

  // POST /v1/chat/completions with stream:true — replaces the non-streaming
  // handler when stream:true. The non-streaming version in openai_compat.js
  // handles the non-streaming case.
  app.post('/v1/chat/completions/stream', express.json({ limit: '4mb' }), async (req, res) => {
    const ctx = await resolveAgent(pool, req);
    if (!ctx) {
      return res.status(401).json({ error: { message: 'Unauthorized.', type: 'invalid_request_error' } });
    }
    const body = req.body || {};
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      return res.status(400).json({ error: { message: '`messages` required.', type: 'invalid_request_error' } });
    }
    setSseHeaders(res);
    body.stream = true;

    const start = Date.now();
    if (!process.env.OPENAI_API_KEY) {
      await streamStubOpenAI(res, body);
    } else if (typeof fetch === 'function') {
      try {
        const upstream = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: { authorization: 'Bearer ' + process.env.OPENAI_API_KEY, 'content-type': 'application/json' },
          body: JSON.stringify(body)
        });
        await pipeUpstream(upstream, res);
      } catch (e) {
        res.write('data: ' + JSON.stringify({ error: { message: 'upstream_failed: ' + e.message } }) + '\n\n');
      }
    } else {
      await streamStubOpenAI(res, body);
    }
    // Log the streamed call
    try {
      const callId = 'inf_' + crypto.randomBytes(8).toString('hex');
      await pool.query(
        `INSERT INTO inference_calls (call_id, agent_did, provider, model, prompt_tokens, completion_tokens, cost_cents, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())`,
        [callId, ctx.did, process.env.OPENAI_API_KEY ? 'openai-stream' : 'stub-stream',
         body.model || 'unknown', 0, 0, 1]
      ).catch(() => {});
      if (auditChain) auditChain.append({
        event_type: 'inference.streamed', call_id: callId, agent_did: ctx.did,
        model: body.model, latency_ms: Date.now() - start
      }).catch(() => {});
    } catch {}
    res.end();
  });

  // POST /v1/messages/stream — Anthropic SSE
  app.post('/v1/messages/stream', express.json({ limit: '4mb' }), async (req, res) => {
    const ctx = await resolveAgent(pool, req);
    if (!ctx) {
      return res.status(401).json({ type: 'error', error: { type: 'authentication_error', message: 'Unauthorized.' } });
    }
    const body = req.body || {};
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      return res.status(400).json({ type: 'error', error: { type: 'invalid_request_error', message: '`messages` required.' } });
    }
    setSseHeaders(res);
    body.stream = true;

    const start = Date.now();
    if (!process.env.ANTHROPIC_API_KEY) {
      await streamStubAnthropic(res, body);
    } else if (typeof fetch === 'function') {
      try {
        const upstream = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'x-api-key': process.env.ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json'
          },
          body: JSON.stringify(body)
        });
        await pipeUpstream(upstream, res);
      } catch (e) {
        res.write(sseFrame('error', { type: 'error', error: { type: 'api_error', message: e.message } }));
      }
    } else {
      await streamStubAnthropic(res, body);
    }
    try {
      const callId = 'inf_' + crypto.randomBytes(8).toString('hex');
      await pool.query(
        `INSERT INTO inference_calls (call_id, agent_did, provider, model, prompt_tokens, completion_tokens, cost_cents, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())`,
        [callId, ctx.did, process.env.ANTHROPIC_API_KEY ? 'anthropic-stream' : 'stub-stream',
         body.model || 'unknown', 0, 0, 1]
      ).catch(() => {});
      if (auditChain) auditChain.append({
        event_type: 'inference.streamed', call_id: callId, agent_did: ctx.did,
        provider: 'anthropic-stream', model: body.model, latency_ms: Date.now() - start
      }).catch(() => {});
    } catch {}
    res.end();
  });
}

module.exports = { migrate, registerStreamingCompatRoutes, streamStubOpenAI, streamStubAnthropic, sseFrame };
