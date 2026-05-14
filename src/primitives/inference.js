// ============================================================================
// OpenHeab Inference — Multi-provider OpenAI-compatible router
// ============================================================================
const express = require('express');
const cryptoLib = require('crypto');
const { z } = require('zod');

// ----------------------------------------------------------------------------
// Provider registry
// ----------------------------------------------------------------------------
const PROVIDERS = {
  anthropic: {
    name: 'anthropic',
    base_url: 'https://api.anthropic.com/v1/messages',
    env: 'ANTHROPIC_API_KEY',
    kind: 'anthropic'
  },
  openai: {
    name: 'openai',
    base_url: 'https://api.openai.com/v1/chat/completions',
    env: 'OPENAI_API_KEY',
    kind: 'openai'
  },
  google: {
    name: 'google',
    base_url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    env: 'GOOGLE_API_KEY',
    kind: 'google'
  },
  mistral: {
    name: 'mistral',
    base_url: 'https://api.mistral.ai/v1/chat/completions',
    env: 'MISTRAL_API_KEY',
    kind: 'openai'
  },
  together: {
    name: 'together',
    base_url: 'https://api.together.xyz/v1/chat/completions',
    env: 'TOGETHER_API_KEY',
    kind: 'openai'
  },
  fireworks: {
    name: 'fireworks',
    base_url: 'https://api.fireworks.ai/inference/v1/chat/completions',
    env: 'FIREWORKS_API_KEY',
    kind: 'openai'
  },
  groq: {
    name: 'groq',
    base_url: 'https://api.groq.com/openai/v1/chat/completions',
    env: 'GROQ_API_KEY',
    kind: 'openai'
  }
};

const MARKUP_BPS = parseInt(process.env.INFERENCE_MARKUP_BPS || '1000');

// Rough per-million-token prices in cents (input/output)
const MODEL_PRICES = {
  // OpenAI
  'gpt-4o':                { in: 250,  out: 1000 },
  'gpt-4o-mini':           { in: 15,   out: 60 },
  'gpt-4-turbo':           { in: 1000, out: 3000 },
  'gpt-3.5-turbo':         { in: 50,   out: 150 },
  // Anthropic
  'claude-3-5-sonnet':     { in: 300,  out: 1500 },
  'claude-3-opus':         { in: 1500, out: 7500 },
  'claude-3-haiku':        { in: 25,   out: 125 },
  // Default fallback
  'default':               { in: 100,  out: 300 }
};

function priceForModel(model) {
  if (!model) return MODEL_PRICES.default;
  const key = Object.keys(MODEL_PRICES).find(k => model.toLowerCase().includes(k));
  return MODEL_PRICES[key] || MODEL_PRICES.default;
}

function estimateCostCents(model, inputTokens, outputTokens) {
  const p = priceForModel(model);
  const baseCents =
    ((inputTokens || 0) * p.in + (outputTokens || 0) * p.out) / 1_000_000;
  const marked = baseCents * (10000 + MARKUP_BPS) / 10000;
  return Math.max(0, Math.ceil(marked));
}

function providerForModel(model) {
  if (!model) return 'openai';
  const m = model.toLowerCase();
  if (m.startsWith('claude') || m.includes('anthropic')) return 'anthropic';
  if (m.startsWith('gemini') || m.includes('google'))    return 'google';
  if (m.startsWith('mistral'))                            return 'mistral';
  if (m.includes('together'))                             return 'together';
  if (m.includes('fireworks'))                            return 'fireworks';
  if (m.includes('groq') || m.includes('llama-3'))        return 'groq';
  return 'openai';
}

function pickProvider(policy, model) {
  const blocked = new Set(policy?.blocked_providers || []);
  const preferred = (policy?.preferred_providers || []).filter(p => !blocked.has(p));
  if (preferred.length > 0) return preferred[0];
  const inferred = providerForModel(model);
  if (blocked.has(inferred)) {
    return Object.keys(PROVIDERS).find(p => !blocked.has(p)) || inferred;
  }
  return inferred;
}

function providerConfigured(name) {
  const p = PROVIDERS[name];
  if (!p) return false;
  return !!process.env[p.env];
}

// ----------------------------------------------------------------------------
// Migration
// ----------------------------------------------------------------------------
async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS inference_policies (
      agent_did            TEXT PRIMARY KEY,
      strategy             TEXT NOT NULL DEFAULT 'cheapest',
      max_cost_cents       INTEGER,
      preferred_providers  TEXT[],
      blocked_providers    TEXT[],
      byok                 BOOLEAN NOT NULL DEFAULT FALSE,
      created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS inference_cache (
      cache_key   TEXT PRIMARY KEY,
      response    JSONB NOT NULL,
      provider    TEXT,
      model       TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      hit_count   INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_inference_cache_created ON inference_cache (created_at DESC);

    CREATE TABLE IF NOT EXISTS inference_logs (
      log_id         TEXT PRIMARY KEY,
      agent_did      TEXT,
      provider       TEXT,
      model          TEXT,
      input_tokens   INTEGER NOT NULL DEFAULT 0,
      output_tokens  INTEGER NOT NULL DEFAULT 0,
      cost_cents     INTEGER NOT NULL DEFAULT 0,
      latency_ms     INTEGER,
      cache_hit      BOOLEAN NOT NULL DEFAULT FALSE,
      status         INTEGER,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_inference_logs_agent   ON inference_logs (agent_did, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_inference_logs_created ON inference_logs (created_at DESC);
  `);
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------
function genLogId() {
  return 'inf_' + cryptoLib.randomBytes(12).toString('hex');
}

function cacheKey(model, messages) {
  return 'inf_' + cryptoLib.createHash('sha256')
    .update((model || '') + JSON.stringify(messages || []))
    .digest('hex');
}

async function getPolicy(pool, agentDid) {
  if (!agentDid) return null;
  const r = await pool.query(`
    SELECT agent_did, strategy, max_cost_cents,
           preferred_providers, blocked_providers, byok
    FROM inference_policies WHERE agent_did = $1
  `, [agentDid]).catch(() => ({ rows: [] }));
  return r.rows[0] || null;
}

function messagesToAnthropic(messages) {
  const system = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n') || undefined;
  const rest = messages.filter(m => m.role !== 'system').map(m => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
  }));
  return { system, messages: rest };
}

function anthropicToOpenAI(res, model) {
  const text = Array.isArray(res?.content)
    ? res.content.filter(b => b.type === 'text').map(b => b.text).join('')
    : (typeof res?.content === 'string' ? res.content : '');
  const usage = res?.usage || {};
  return {
    id: res?.id || ('chatcmpl_' + cryptoLib.randomBytes(8).toString('hex')),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: res?.model || model,
    choices: [{
      index: 0,
      message: { role: 'assistant', content: text },
      finish_reason: res?.stop_reason || 'stop'
    }],
    usage: {
      prompt_tokens: usage.input_tokens || 0,
      completion_tokens: usage.output_tokens || 0,
      total_tokens: (usage.input_tokens || 0) + (usage.output_tokens || 0)
    }
  };
}

async function callUpstream(providerName, model, messages, params, byokKey) {
  const provider = PROVIDERS[providerName];
  if (!provider) throw new Error(`unknown_provider:${providerName}`);
  const apiKey = byokKey || process.env[provider.env];
  if (!apiKey) throw new Error(`provider_not_configured:${providerName}`);

  if (provider.kind === 'anthropic') {
    const { system, messages: msgs } = messagesToAnthropic(messages);
    const body = {
      model: model || 'claude-3-5-sonnet-20241022',
      messages: msgs,
      max_tokens: params.max_tokens || 1024,
      ...(typeof params.temperature === 'number' ? { temperature: params.temperature } : {}),
      ...(system ? { system } : {})
    };
    const r = await fetch(provider.base_url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(body)
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      const e = new Error(j?.error?.message || 'upstream_error');
      e.statusCode = r.status; e.upstream = j;
      throw e;
    }
    return anthropicToOpenAI(j, model);
  }

  // OpenAI / OpenAI-compatible / Google (OpenAI-compatible endpoint)
  const body = {
    model: model || 'gpt-4o-mini',
    messages,
    ...(typeof params.temperature === 'number' ? { temperature: params.temperature } : {}),
    ...(params.max_tokens ? { max_tokens: params.max_tokens } : {})
  };
  const r = await fetch(provider.base_url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify(body)
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(j?.error?.message || 'upstream_error');
    e.statusCode = r.status; e.upstream = j;
    throw e;
  }
  return j;
}

function tryRequire(name) {
  try { return require(name); } catch { return null; }
}

// ----------------------------------------------------------------------------
// Routes
// ----------------------------------------------------------------------------
const ChatSchema = z.object({
  model:       z.string().min(1).max(256),
  messages:    z.array(z.object({
    role: z.string(),
    content: z.union([z.string(), z.array(z.any()), z.record(z.any())])
  })).min(1),
  temperature: z.number().optional(),
  max_tokens:  z.number().int().positive().optional(),
  agent_did:   z.string().optional()
}).passthrough();

const PolicySchema = z.object({
  strategy:            z.enum(['cheapest', 'quality', 'latency', 'cost_capped']).optional(),
  max_cost_cents:      z.number().int().min(0).optional(),
  preferred_providers: z.array(z.string()).optional(),
  blocked_providers:   z.array(z.string()).optional(),
  byok:                z.boolean().optional()
});

function registerInferenceRoutes(app, pool, verifyAgentAuth, auditChain) {
  const security = tryRequire('./security');
  const cost = tryRequire('./cost');

  // POST /v1/inference/chat/completions
  app.post('/v1/inference/chat/completions', express.json({ limit: '2mb' }), async (req, res) => {
    const start = Date.now();
    try {
      const parse = ChatSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;

      if (d.agent_did) {
        const auth = await verifyAgentAuth(req, d.agent_did);
        if (!auth.valid) return res.status(401).json({ error: auth.error });
      }

      const policy = d.agent_did ? await getPolicy(pool, d.agent_did) : null;
      const provider = pickProvider(policy, d.model);

      // Security scan
      const securityMode = (req.headers['x-security-mode'] || 'block').toString();
      if (securityMode !== 'off' && security && typeof security.scanInjection === 'function') {
        try {
          const scan = await security.scanInjection({
            messages: d.messages, agent_did: d.agent_did, model: d.model
          });
          if (scan && scan.flagged) {
            if (securityMode === 'block') {
              return res.status(400).json({
                error: 'security_violation',
                reason: scan.reason || 'prompt_injection_detected',
                scan
              });
            }
            res.setHeader('x-security-warning', scan.reason || 'flagged');
          }
        } catch (e) {
          console.warn('[inference.security]', e.message);
        }
      }

      // Pre-flight cost check
      const estInputTokens = JSON.stringify(d.messages).length / 4;
      const estOutputTokens = d.max_tokens || 512;
      const estCostCents = estimateCostCents(d.model, estInputTokens, estOutputTokens);
      if (policy?.max_cost_cents && estCostCents > policy.max_cost_cents) {
        return res.status(402).json({
          error: 'policy_max_cost_exceeded',
          estimated_cents: estCostCents, max_cost_cents: policy.max_cost_cents
        });
      }
      if (cost && typeof cost.canSpend === 'function' && d.agent_did) {
        try {
          const ok = await cost.canSpend(pool, d.agent_did, estCostCents);
          if (ok && ok.allowed === false) {
            return res.status(402).json({ error: 'spend_blocked', reason: ok.reason || 'cap_exceeded' });
          }
        } catch (e) { console.warn('[inference.cost.canSpend]', e.message); }
      }

      // Cache lookup
      const cKey = cacheKey(d.model, d.messages);
      const cacheR = await pool.query(
        `SELECT response, provider, model FROM inference_cache WHERE cache_key = $1`,
        [cKey]
      ).catch(() => ({ rows: [] }));

      if (cacheR.rows[0]) {
        const latency = Date.now() - start;
        const cached = cacheR.rows[0];
        await pool.query(
          `UPDATE inference_cache SET hit_count = hit_count + 1 WHERE cache_key = $1`,
          [cKey]
        ).catch(() => {});
        await pool.query(`
          INSERT INTO inference_logs
          (log_id, agent_did, provider, model, input_tokens, output_tokens,
           cost_cents, latency_ms, cache_hit, status, created_at)
          VALUES ($1,$2,$3,$4,0,0,0,$5,TRUE,200, NOW())
        `, [genLogId(), d.agent_did || null, cached.provider, cached.model, latency])
          .catch(() => {});
        const resp = typeof cached.response === 'string' ? JSON.parse(cached.response) : cached.response;
        res.setHeader('x-inference-cache', 'hit');
        res.setHeader('x-inference-provider', cached.provider || 'unknown');
        return res.json(resp);
      }

      // Upstream call
      const byokKey = policy?.byok ? (req.headers['x-byok-api-key'] || null) : null;
      let response;
      try {
        response = await callUpstream(provider, d.model, d.messages, {
          temperature: d.temperature, max_tokens: d.max_tokens
        }, byokKey);
      } catch (e) {
        const latency = Date.now() - start;
        await pool.query(`
          INSERT INTO inference_logs
          (log_id, agent_did, provider, model, cost_cents, latency_ms,
           cache_hit, status, created_at)
          VALUES ($1,$2,$3,$4,0,$5,FALSE,$6, NOW())
        `, [genLogId(), d.agent_did || null, provider, d.model, latency,
            e.statusCode || 500]).catch(() => {});
        return res.status(e.statusCode || 502).json({
          error: 'upstream_error', provider, message: e.message, details: e.upstream || null
        });
      }

      const usage = response.usage || {};
      const inTok = usage.prompt_tokens || 0;
      const outTok = usage.completion_tokens || 0;
      const cost_cents = estimateCostCents(d.model, inTok, outTok);
      const latency = Date.now() - start;

      // Log + record cost
      await pool.query(`
        INSERT INTO inference_logs
        (log_id, agent_did, provider, model, input_tokens, output_tokens,
         cost_cents, latency_ms, cache_hit, status, created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,FALSE,200, NOW())
      `, [genLogId(), d.agent_did || null, provider, d.model,
          inTok, outTok, cost_cents, latency]).catch(() => {});

      if (cost && typeof cost.recordCost === 'function' && d.agent_did) {
        try {
          await cost.recordCost(pool, {
            agent_did: d.agent_did, primitive: 'inference',
            provider, model: d.model, cost_cents,
            metadata: { input_tokens: inTok, output_tokens: outTok }
          });
        } catch (e) { console.warn('[inference.cost.record]', e.message); }
      }

      // Cache success
      await pool.query(`
        INSERT INTO inference_cache (cache_key, response, provider, model)
        VALUES ($1, $2::jsonb, $3, $4)
        ON CONFLICT (cache_key) DO NOTHING
      `, [cKey, JSON.stringify(response), provider, d.model]).catch(() => {});

      res.setHeader('x-inference-cache', 'miss');
      res.setHeader('x-inference-provider', provider);
      res.setHeader('x-inference-cost-cents', String(cost_cents));
      return res.json(response);
    } catch (e) {
      console.error('[inference.chat]', e);
      return res.status(500).json({ error: 'inference_failed', message: e.message });
    }
  });

  // POST /v1/agents/:did/inference/policy
  app.post('/v1/agents/:did/inference/policy', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const parse = PolicySchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;

      await pool.query(`
        INSERT INTO inference_policies
        (agent_did, strategy, max_cost_cents, preferred_providers,
         blocked_providers, byok, updated_at)
        VALUES ($1, COALESCE($2,'cheapest'), $3, $4, $5, COALESCE($6,FALSE), NOW())
        ON CONFLICT (agent_did) DO UPDATE SET
          strategy            = COALESCE(EXCLUDED.strategy, inference_policies.strategy),
          max_cost_cents      = EXCLUDED.max_cost_cents,
          preferred_providers = EXCLUDED.preferred_providers,
          blocked_providers   = EXCLUDED.blocked_providers,
          byok                = EXCLUDED.byok,
          updated_at          = NOW()
      `, [did, d.strategy || null, d.max_cost_cents ?? null,
          d.preferred_providers || null, d.blocked_providers || null,
          d.byok ?? null]);

      await auditChain.append({
        event_type: 'inference.policy_updated',
        agent_did: did,
        strategy: d.strategy || null,
        max_cost_cents: d.max_cost_cents ?? null,
        byok: !!d.byok,
        timestamp: new Date().toISOString()
      });

      const r = await pool.query(`
        SELECT agent_did, strategy, max_cost_cents, preferred_providers,
               blocked_providers, byok, created_at, updated_at
        FROM inference_policies WHERE agent_did = $1
      `, [did]);
      return res.json(r.rows[0]);
    } catch (e) {
      console.error('[inference.policy.set]', e);
      return res.status(500).json({ error: 'policy_update_failed', message: e.message });
    }
  });

  app.get('/v1/agents/:did/inference/policy', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(`
      SELECT agent_did, strategy, max_cost_cents, preferred_providers,
             blocked_providers, byok, created_at, updated_at
      FROM inference_policies WHERE agent_did = $1
    `, [did]).catch(() => ({ rows: [] }));
    if (!r.rows[0]) {
      return res.json({
        agent_did: did, strategy: 'cheapest', max_cost_cents: null,
        preferred_providers: [], blocked_providers: [], byok: false
      });
    }
    return res.json(r.rows[0]);
  });

  // GET /v1/inference/providers
  app.get('/v1/inference/providers', async (req, res) => {
    const providers = Object.entries(PROVIDERS).map(([name, cfg]) => ({
      name,
      kind: cfg.kind,
      base_url: cfg.base_url,
      env: cfg.env,
      configured: providerConfigured(name)
    }));
    return res.json({
      providers,
      markup_bps: MARKUP_BPS,
      count: providers.length,
      configured_count: providers.filter(p => p.configured).length
    });
  });
}

module.exports = {
  migrate,
  registerInferenceRoutes,
  PROVIDERS,
  MARKUP_BPS,
  pickProvider,
  providerForModel,
  estimateCostCents,
  cacheKey,
  callUpstream,
  providerConfigured
};
