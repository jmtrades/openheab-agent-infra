// ============================================================================
// OpenHeab MCP Server — Exposes the agent-native substrate as an MCP server.
// JSON-RPC 2.0 transport at POST /mcp; discovery at GET /.well-known/mcp.json.
// invokeTool resolves :param placeholders from args, forwards remaining
// args as querystring (GET) or body (POST), preserves auth headers.
// ============================================================================
const express = require('express');

const SERVER_NAME = 'openheab';
const SERVER_VERSION = '1.0.0';
const MCP_PROTOCOL_VERSION = '2024-11-05';

// ----------------------------------------------------------------------------
// Tool definitions — 34 entries
// ----------------------------------------------------------------------------
const TOOLS = [
  {
    name: 'openheab.identity.create',
    description: 'Create a new OpenHeab agent identity (Ed25519 keypair + DID + API key + USDC wallet).',
    inputSchema: {
      type: 'object',
      properties: {
        display_name: { type: 'string', description: 'Optional human-readable name' },
        purpose: { type: 'string', description: 'Optional purpose description' }
      }
    },
    method: 'POST', path: '/v1/identities'
  },
  {
    name: 'openheab.identity.get',
    description: 'Fetch the public DID document and metadata for an agent.',
    inputSchema: {
      type: 'object',
      properties: { did: { type: 'string', description: 'Agent DID' } },
      required: ['did']
    },
    method: 'GET', path: '/v1/identities/:did'
  },
  {
    name: 'openheab.wallet.balance',
    description: 'Get the USDC balance and on-chain address for an agent wallet.',
    inputSchema: {
      type: 'object',
      properties: { did: { type: 'string' } },
      required: ['did']
    },
    method: 'GET', path: '/v1/agents/:did/wallet/balance'
  },
  {
    name: 'openheab.wallet.transfer',
    description: 'Transfer USDC from agent wallet to another address or agent DID.',
    inputSchema: {
      type: 'object',
      properties: {
        did: { type: 'string' },
        to_address: { type: 'string' },
        to_did: { type: 'string' },
        amount_cents: { type: 'integer', minimum: 1 },
        memo: { type: 'string' }
      },
      required: ['did', 'amount_cents']
    },
    method: 'POST', path: '/v1/agents/:did/wallet/transfer'
  },
  {
    name: 'openheab.inbox.send',
    description: 'Send a signed envelope to another agent inbox (DID-routed A2A messaging).',
    inputSchema: {
      type: 'object',
      properties: {
        did: { type: 'string', description: 'Recipient agent DID' },
        sender_did: { type: 'string' },
        body_plain: { type: 'string' },
        body_structured: { type: 'object' }
      },
      required: ['did']
    },
    method: 'POST', path: '/v1/agents/:did/inbox/receive'
  },
  {
    name: 'openheab.inbox.list',
    description: 'List envelopes in an agent inbox.',
    inputSchema: {
      type: 'object',
      properties: {
        did: { type: 'string' },
        status: { type: 'string', enum: ['unread', 'read', 'archived', 'actioned', 'dismissed'] },
        limit: { type: 'integer' }
      },
      required: ['did']
    },
    method: 'GET', path: '/v1/agents/:did/inbox'
  },
  {
    name: 'openheab.memory.kv.set',
    description: 'Set a key/value entry in agent memory with optional TTL.',
    inputSchema: {
      type: 'object',
      properties: {
        did: { type: 'string' },
        key: { type: 'string' },
        value: {},
        ttl_seconds: { type: 'integer' }
      },
      required: ['did', 'key', 'value']
    },
    method: 'POST', path: '/v1/agents/:did/memory/kv'
  },
  {
    name: 'openheab.memory.kv.get',
    description: 'Get a key/value entry from agent memory.',
    inputSchema: {
      type: 'object',
      properties: { did: { type: 'string' }, key: { type: 'string' } },
      required: ['did', 'key']
    },
    method: 'GET', path: '/v1/agents/:did/memory/kv/:key'
  },
  {
    name: 'openheab.memory.episodic.search',
    description: 'Semantic search over an agent\'s episodic memory.',
    inputSchema: {
      type: 'object',
      properties: {
        did: { type: 'string' },
        query: { type: 'string' },
        limit: { type: 'integer' }
      },
      required: ['did', 'query']
    },
    method: 'POST', path: '/v1/agents/:did/memory/episodic/search'
  },
  {
    name: 'openheab.reputation.vouch',
    description: 'Issue a reputation vouch for another agent.',
    inputSchema: {
      type: 'object',
      properties: {
        did: { type: 'string', description: 'Voucher agent DID' },
        target_did: { type: 'string' },
        score: { type: 'number', minimum: 0, maximum: 1 },
        reason: { type: 'string' }
      },
      required: ['did', 'target_did', 'score']
    },
    method: 'POST', path: '/v1/agents/:did/reputation/vouch'
  },
  {
    name: 'openheab.reputation.get',
    description: 'Get the aggregated reputation score for an agent.',
    inputSchema: {
      type: 'object',
      properties: { did: { type: 'string' } },
      required: ['did']
    },
    method: 'GET', path: '/v1/agents/:did/reputation'
  },
  {
    name: 'openheab.kyc.submit',
    description: 'Submit a KYC claim (jurisdiction, operator, sanctions_clear, etc.) for an agent.',
    inputSchema: {
      type: 'object',
      properties: {
        did: { type: 'string', description: 'Subject agent DID' },
        claim_type: { type: 'string' },
        claim_value: {},
        confidence: { type: 'number' },
        expires_at: { type: 'string' }
      },
      required: ['did', 'claim_type', 'claim_value']
    },
    method: 'POST', path: '/v1/agents/:did/kyc/claims'
  },
  {
    name: 'openheab.kyc.verify',
    description: 'Run KYC verification (claim lookup + sanctions screening) for an agent.',
    inputSchema: {
      type: 'object',
      properties: { did: { type: 'string' } },
      required: ['did']
    },
    method: 'POST', path: '/v1/agents/:did/kyc/verify'
  },
  {
    name: 'openheab.email.create_address',
    description: 'Provision an inbound/outbound email address bound to an agent DID.',
    inputSchema: {
      type: 'object',
      properties: {
        did: { type: 'string' },
        local_part: { type: 'string' }
      },
      required: ['did']
    },
    method: 'POST', path: '/v1/agents/:did/email/addresses'
  },
  {
    name: 'openheab.extensions.list',
    description: 'List available platform extensions (custom plugins agents can invoke).',
    inputSchema: {
      type: 'object',
      properties: {
        q: { type: 'string' },
        category: { type: 'string' }
      }
    },
    method: 'GET', path: '/v1/extensions'
  },
  {
    name: 'openheab.extensions.invoke',
    description: 'Invoke a platform extension with structured arguments.',
    inputSchema: {
      type: 'object',
      properties: {
        did: { type: 'string' },
        slug: { type: 'string' },
        args: { type: 'object' }
      },
      required: ['did', 'slug']
    },
    method: 'POST', path: '/v1/agents/:did/extensions/:slug/invoke'
  },
  {
    name: 'openheab.inference.chat',
    description: 'Run a chat-completion call through the metered inference proxy.',
    inputSchema: {
      type: 'object',
      properties: {
        did: { type: 'string' },
        model: { type: 'string' },
        messages: { type: 'array' },
        max_tokens: { type: 'integer' }
      },
      required: ['did', 'model', 'messages']
    },
    method: 'POST', path: '/v1/agents/:did/inference/chat'
  },
  {
    name: 'openheab.security.scan',
    description: 'Scan a prompt, URL, or input for known attack patterns (prompt injection, secrets).',
    inputSchema: {
      type: 'object',
      properties: {
        did: { type: 'string' },
        content: { type: 'string' },
        kind: { type: 'string' }
      },
      required: ['did', 'content']
    },
    method: 'POST', path: '/v1/agents/:did/security/scan'
  },
  {
    name: 'openheab.tools.list',
    description: 'List tools in the curated + community registry.',
    inputSchema: {
      type: 'object',
      properties: {
        q: { type: 'string' },
        category: { type: 'string' },
        tier: { type: 'string', enum: ['curated', 'community'] }
      }
    },
    method: 'GET', path: '/v1/tools'
  },
  {
    name: 'openheab.tools.install',
    description: 'Install a tool from the registry into an agent\'s toolbelt.',
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string' },
        agent_did: { type: 'string' },
        version: { type: 'string' },
        pinned: { type: 'boolean' }
      },
      required: ['slug', 'agent_did']
    },
    method: 'POST', path: '/v1/tools/:slug/install'
  },
  {
    name: 'openheab.workflows.run',
    description: 'Execute a named workflow (DAG of steps) for an agent.',
    inputSchema: {
      type: 'object',
      properties: {
        did: { type: 'string' },
        workflow_id: { type: 'string' },
        inputs: { type: 'object' }
      },
      required: ['did', 'workflow_id']
    },
    method: 'POST', path: '/v1/agents/:did/workflows/:workflow_id/run'
  },
  {
    name: 'openheab.intelligence.behavior',
    description: 'Behavior analytics for an agent (actions in past 30d, top counterparties, installed tools).',
    inputSchema: {
      type: 'object',
      properties: { did: { type: 'string' } },
      required: ['did']
    },
    method: 'GET', path: '/v1/intelligence/agents/:did/behavior'
  },
  {
    name: 'openheab.intelligence.forecast',
    description: 'EMA cost forecast (daily/7d/30d) for an agent.',
    inputSchema: {
      type: 'object',
      properties: { did: { type: 'string' } },
      required: ['did']
    },
    method: 'GET', path: '/v1/intelligence/agents/:did/forecast'
  },
  {
    name: 'openheab.intelligence.network',
    description: 'Aggregate network metrics (total agents, new in 7d, GMV 30d, extension invocations 24h).',
    inputSchema: { type: 'object', properties: {} },
    method: 'GET', path: '/v1/intelligence/network'
  },
  {
    name: 'openheab.cost.summary',
    description: 'Summary of agent cost events (totals by kind, daily breakdown).',
    inputSchema: {
      type: 'object',
      properties: {
        did: { type: 'string' },
        window_days: { type: 'integer' }
      },
      required: ['did']
    },
    method: 'GET', path: '/v1/agents/:did/cost/summary'
  },
  {
    name: 'openheab.cost.budget.set',
    description: 'Set or update a spending budget cap (daily/weekly/monthly) for an agent.',
    inputSchema: {
      type: 'object',
      properties: {
        did: { type: 'string' },
        period: { type: 'string', enum: ['daily', 'weekly', 'monthly'] },
        limit_cents: { type: 'integer' }
      },
      required: ['did', 'period', 'limit_cents']
    },
    method: 'POST', path: '/v1/agents/:did/cost/budget'
  },
  {
    name: 'openheab.deployment.set',
    description: 'Create or update an agent deployment manifest (runtime, image, scaling, hibernation).',
    inputSchema: {
      type: 'object',
      properties: {
        did: { type: 'string' },
        runtime: { type: 'string', enum: ['modal', 'e2b', 'fly', 'local'] },
        image: { type: 'string' },
        entrypoint: { type: 'string' },
        min_replicas: { type: 'integer' },
        max_replicas: { type: 'integer' },
        idle_minutes: { type: 'integer' },
        hibernate_minutes: { type: 'integer' }
      },
      required: ['did']
    },
    method: 'POST', path: '/v1/agents/:did/deployment'
  },
  {
    name: 'openheab.payouts.request',
    description: 'Request an A2H cash-out (Stripe Connect / Wise / USDC on-ramp / manual).',
    inputSchema: {
      type: 'object',
      properties: {
        did: { type: 'string' },
        account_id: { type: 'string' },
        amount_cents: { type: 'integer', minimum: 500 },
        currency: { type: 'string' },
        idempotency_key: { type: 'string' }
      },
      required: ['did', 'account_id', 'amount_cents']
    },
    method: 'POST', path: '/v1/agents/:did/payouts'
  },
  {
    name: 'openheab.storage.upload_url',
    description: 'Get a fresh signed download URL for a stored blob.',
    inputSchema: {
      type: 'object',
      properties: {
        did: { type: 'string' },
        blob_id: { type: 'string' },
        expires_in: { type: 'integer' }
      },
      required: ['did', 'blob_id']
    },
    method: 'POST', path: '/v1/agents/:did/storage/:blob_id/url'
  },
  {
    name: 'openheab.storage.list',
    description: 'List blobs owned by an agent.',
    inputSchema: {
      type: 'object',
      properties: { did: { type: 'string' } },
      required: ['did']
    },
    method: 'GET', path: '/v1/agents/:did/storage'
  },
  {
    name: 'openheab.agents.search',
    description: 'Search the agent registry by query, category, or minimum reputation.',
    inputSchema: {
      type: 'object',
      properties: {
        q: { type: 'string' },
        category: { type: 'string' },
        min_reputation: { type: 'number' },
        limit: { type: 'integer' }
      }
    },
    method: 'GET', path: '/v1/agents/search'
  },
  {
    name: 'openheab.audit.verify',
    description: 'Cryptographically verify the audit hash chain.',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'integer' } }
    },
    method: 'GET', path: '/v1/audit/verify'
  },
  {
    name: 'openheab.secrets.list',
    description: 'List an agent\'s secret metadata (no values returned).',
    inputSchema: {
      type: 'object',
      properties: { did: { type: 'string' } },
      required: ['did']
    },
    method: 'GET', path: '/v1/agents/:did/secrets'
  },
  {
    name: 'openheab.secrets.get',
    description: 'Decrypt and return a secret value by handle (requires signed request).',
    inputSchema: {
      type: 'object',
      properties: {
        did: { type: 'string' },
        handle: { type: 'string' }
      },
      required: ['did', 'handle']
    },
    method: 'GET', path: '/v1/agents/:did/secrets/:handle'
  }
];

// ----------------------------------------------------------------------------
// Migration (no-op)
// ----------------------------------------------------------------------------
async function migrate(_pool) {
  // mcp_server has no tables — it's a JSON-RPC facade over other primitives.
}

// ----------------------------------------------------------------------------
// Tool invocation
// ----------------------------------------------------------------------------
function findTool(name) {
  return TOOLS.find(t => t.name === name);
}

function resolvePath(template, args) {
  const consumed = new Set();
  const path = template.replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, (_, key) => {
    if (args && key in args && args[key] !== undefined && args[key] !== null) {
      consumed.add(key);
      return encodeURIComponent(String(args[key]));
    }
    return `:${key}`;
  });
  const remaining = {};
  if (args) {
    for (const k of Object.keys(args)) {
      if (!consumed.has(k)) remaining[k] = args[k];
    }
  }
  return { path, remaining };
}

function buildQueryString(params) {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null) continue;
    if (typeof v === 'object') usp.append(k, JSON.stringify(v));
    else usp.append(k, String(v));
  }
  const s = usp.toString();
  return s ? `?${s}` : '';
}

function pickAuthHeaders(srcHeaders = {}) {
  const out = {};
  const passthrough = [
    'authorization', 'x-agent-did', 'x-agent-sig',
    'x-idempotency-key', 'x-admin-token', 'x-cron-secret', 'x-demo-did'
  ];
  for (const h of passthrough) {
    if (srcHeaders[h]) out[h] = srcHeaders[h];
  }
  return out;
}

async function invokeTool(toolName, args, reqHeaders) {
  const tool = findTool(toolName);
  if (!tool) return { ok: false, error: 'unknown_tool', tool: toolName };

  const base = process.env.OPERATOR_PUBLIC_URL
    || process.env.MCP_INTERNAL_BASE_URL
    || `http://localhost:${process.env.PORT || 3000}`;
  const { path, remaining } = resolvePath(tool.path, args || {});

  const headers = {
    'content-type': 'application/json',
    accept: 'application/json',
    ...pickAuthHeaders(reqHeaders || {})
  };

  let url = `${base}${path}`;
  let body;
  if (tool.method === 'GET' || tool.method === 'DELETE') {
    url += buildQueryString(remaining);
  } else {
    body = JSON.stringify(remaining || {});
  }

  if (typeof fetch !== 'function') {
    return { ok: false, error: 'fetch_unavailable' };
  }

  try {
    const r = await fetch(url, { method: tool.method, headers, body });
    let json = null;
    const ct = r.headers.get('content-type') || '';
    if (ct.includes('application/json')) {
      try { json = await r.json(); } catch { json = null; }
    } else {
      try { json = { text: await r.text() }; } catch { json = null; }
    }
    return { ok: r.ok, status: r.status, result: json };
  } catch (e) {
    return { ok: false, error: 'invocation_failed', message: e.message };
  }
}

// ----------------------------------------------------------------------------
// JSON-RPC handler
// ----------------------------------------------------------------------------
function rpcResult(id, result) {
  return { jsonrpc: '2.0', id: id ?? null, result };
}
function rpcError(id, code, message, data) {
  const err = { code, message };
  if (data !== undefined) err.data = data;
  return { jsonrpc: '2.0', id: id ?? null, error: err };
}

async function handleRpc(req, body) {
  const { id, method, params } = body || {};
  if (!method) return rpcError(id, -32600, 'invalid_request: missing method');

  if (method === 'initialize') {
    return rpcResult(id, {
      protocolVersion: MCP_PROTOCOL_VERSION,
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      capabilities: { tools: { listChanged: false } }
    });
  }
  if (method === 'tools/list') {
    return rpcResult(id, {
      tools: TOOLS.map(t => ({
        name: t.name, description: t.description, inputSchema: t.inputSchema
      }))
    });
  }
  if (method === 'tools/call') {
    const toolName = params?.name;
    const args = params?.arguments || {};
    const tool = findTool(toolName);
    if (!tool) return rpcError(id, -32601, `unknown_tool: ${toolName}`);
    const out = await invokeTool(toolName, args, req.headers);
    if (!out.ok) {
      return rpcResult(id, {
        isError: true,
        content: [{ type: 'text', text: JSON.stringify(out) }]
      });
    }
    return rpcResult(id, {
      isError: false,
      content: [{ type: 'text', text: JSON.stringify(out.result) }]
    });
  }
  if (method === 'ping') return rpcResult(id, { pong: true });
  return rpcError(id, -32601, `method_not_found: ${method}`);
}

// ----------------------------------------------------------------------------
// Routes
// ----------------------------------------------------------------------------
function registerMcpRoutes(app, pool, verifyAgentAuth, auditChain) {
  // POST /mcp — JSON-RPC 2.0
  app.post('/mcp', express.json({ limit: '5mb' }), async (req, res) => {
    try {
      const body = req.body;
      if (Array.isArray(body)) {
        const out = await Promise.all(body.map(b => handleRpc(req, b)));
        return res.json(out);
      }
      const out = await handleRpc(req, body);
      return res.json(out);
    } catch (e) {
      console.error('[mcp.rpc]', e);
      return res.status(500).json(rpcError(null, -32603, 'internal_error', e.message));
    }
  });

  // GET /mcp/manifest — flat manifest for non-RPC discovery
  app.get('/mcp/manifest', (req, res) => {
    const base = process.env.OPERATOR_PUBLIC_URL || '';
    return res.json({
      server: { name: SERVER_NAME, version: SERVER_VERSION },
      transport: 'http+jsonrpc',
      endpoint: base ? `${base}/mcp` : '/mcp',
      protocol_version: MCP_PROTOCOL_VERSION,
      tools: TOOLS.map(t => ({
        name: t.name, description: t.description, inputSchema: t.inputSchema
      }))
    });
  });

  // GET /.well-known/mcp.json — discovery doc
  app.get('/.well-known/mcp.json', (req, res) => {
    const base = process.env.OPERATOR_PUBLIC_URL || '';
    return res.json({
      mcp_version: MCP_PROTOCOL_VERSION,
      server: { name: SERVER_NAME, version: SERVER_VERSION },
      transports: [
        { type: 'http+jsonrpc', endpoint: base ? `${base}/mcp` : '/mcp' }
      ],
      manifest: base ? `${base}/mcp/manifest` : '/mcp/manifest',
      tool_count: TOOLS.length
    });
  });
}

module.exports = {
  migrate,
  registerMcpRoutes,
  TOOLS,
  invokeTool,
  resolvePath,
  pickAuthHeaders,
  handleRpc
};
