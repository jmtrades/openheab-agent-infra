// ============================================================================
// capability_catalog.js — machine-readable inventory of every capability
// in the substrate. AI agents query this to discover what they can do
// without parsing 1,507 route definitions or 200KB of OpenAPI.
//
// GET /v1/capabilities          — full catalog (cached 5min)
// GET /v1/capabilities/search   — keyword + category filter
// GET /v1/capabilities/:slug    — one capability with full metadata
// POST /v1/capabilities/match   — given a goal, return best-matching capabilities
// ============================================================================

const CAPABILITIES = [
  { slug: 'identity.create', category: 'identity',
    name: 'Create agent identity',
    primitive: 'identity', method: 'POST', path: '/v1/identities',
    cost_cents: 0, latency_ms_p50: 250, sla_uptime_pct: 99.95,
    description: 'Generate a signed Ed25519 DID + Ed25519 keypair + API key + USDC wallet on Base in one call.',
    auth: 'public', revenue_layer: null },
  { slug: 'wallet.balance', category: 'commerce',
    name: 'Check wallet balance', primitive: 'bank_chain',
    method: 'GET', path: '/v1/agents/:did/wallet/balance',
    cost_cents: 0, latency_ms_p50: 400, sla_uptime_pct: 99.9,
    description: 'Live USDC balance from eth_call on Base.', auth: 'agent' },
  { slug: 'wallet.transfer', category: 'commerce',
    name: 'Transfer USDC', primitive: 'bank_chain',
    method: 'POST', path: '/v1/agents/:did/wallet/transfer',
    cost_cents: 0, latency_ms_p50: 1200, sla_uptime_pct: 99.9,
    description: 'Send USDC via FeeSplitter. 1% take rate.',
    auth: 'signed', revenue_layer: 'usdc_transfer_fee' },
  { slug: 'cards.issue', category: 'commerce',
    name: 'Issue virtual or physical card', primitive: 'cards',
    method: 'POST', path: '/v1/agents/:did/cards',
    cost_cents: 0, latency_ms_p50: 800, sla_uptime_pct: 99.9,
    description: 'JIT-funded debit card. Real PAN + CVV returned once.',
    auth: 'signed', revenue_layer: 'card_interchange' },
  { slug: 'savings.open', category: 'commerce',
    name: 'Open savings account', primitive: 'savings',
    method: 'POST', path: '/v1/agents/:did/savings/accounts',
    cost_cents: 0, latency_ms_p50: 200, sla_uptime_pct: 99.95,
    description: '4% APY USDC savings. Daily accrual.', auth: 'signed',
    revenue_layer: 'savings_spread' },
  { slug: 'kyc.submit', category: 'compliance',
    name: 'Submit KYC documents', primitive: 'kyc',
    method: 'POST', path: '/v1/agents/:did/kyc/claims',
    cost_cents: 10, latency_ms_p50: 600, sla_uptime_pct: 99.9,
    description: 'Submit ID + selfie + liveness. Auto-screened against 5 sanctions lists.',
    auth: 'signed', revenue_layer: 'compliance_check' },
  { slug: 'inference.chat', category: 'cognition',
    name: 'Run LLM chat completion', primitive: 'inference',
    method: 'POST', path: '/v1/agents/:did/inference/chat',
    cost_cents: 2, latency_ms_p50: 1500, sla_uptime_pct: 99.9,
    description: 'Multi-provider router. 10% markup. Streams + tool-use.',
    auth: 'agent', revenue_layer: 'inference_markup' },
  { slug: 'inference.embeddings', category: 'cognition',
    name: 'Generate embeddings', primitive: 'inference_core',
    method: 'POST', path: '/v1/inference-core/embeddings',
    cost_cents: 1, latency_ms_p50: 200, sla_uptime_pct: 99.95,
    description: '1024-dim embeddings. In-house model.', auth: 'agent' },
  { slug: 'sandbox.exec', category: 'perception',
    name: 'Execute code in sandbox', primitive: 'sandbox',
    method: 'POST', path: '/v1/agents/:did/sandbox/sessions/:sid/exec',
    cost_cents: 5, latency_ms_p50: 2000, sla_uptime_pct: 99.5,
    description: 'Isolated Python/Node/Bash. Returns stdout + stderr.', auth: 'signed' },
  { slug: 'browser.navigate', category: 'perception',
    name: 'Drive headless browser', primitive: 'browser',
    method: 'POST', path: '/v1/agents/:did/browser/sessions/:sid/navigate',
    cost_cents: 3, latency_ms_p50: 3000, sla_uptime_pct: 99.5,
    description: 'Playwright session. Click, type, screenshot.', auth: 'signed' },
  { slug: 'inbox.send', category: 'comms',
    name: 'Send signed A2A message', primitive: 'inbox',
    method: 'POST', path: '/v1/agents/:did/inbox/receive',
    cost_cents: 0, latency_ms_p50: 150, sla_uptime_pct: 99.95,
    description: 'Signed envelope routed by DID.', auth: 'signed' },
  { slug: 'email.send', category: 'comms',
    name: 'Send DKIM-signed email', primitive: 'email',
    method: 'POST', path: '/v1/agents/:did/email/send',
    cost_cents: 1, latency_ms_p50: 400, sla_uptime_pct: 99.9,
    description: 'From @openheab.com. DKIM-signed via email_core.', auth: 'signed' },
  { slug: 'memory.search', category: 'cognition',
    name: 'Semantic memory search', primitive: 'memory',
    method: 'POST', path: '/v1/agents/:did/memory/search',
    cost_cents: 1, latency_ms_p50: 300, sla_uptime_pct: 99.95,
    description: 'pgvector semantic search over episodic memory.', auth: 'agent' },
  { slug: 'negotiation.start', category: 'a2a',
    name: 'Start A2A negotiation', primitive: 'negotiation',
    method: 'POST', path: '/v1/agents/:did/negotiations',
    cost_cents: 0, latency_ms_p50: 200, sla_uptime_pct: 99.95,
    description: 'Bid/ask/counter/accept with escrow.', auth: 'signed' },
  { slug: 'safety.classify', category: 'safety',
    name: 'AGI safety classifier', primitive: 'safety',
    method: 'POST', path: '/v1/safety/classify',
    cost_cents: 0, latency_ms_p50: 80, sla_uptime_pct: 99.99,
    description: '14-category attack detection. Sub-100ms.', auth: 'public' },
  { slug: 'audit.verify', category: 'trust',
    name: 'Verify audit chain', primitive: 'identity',
    method: 'GET', path: '/v1/audit/verify',
    cost_cents: 0, latency_ms_p50: 500, sla_uptime_pct: 99.99,
    description: 'SHA-256 Merkle + Ed25519 signature verification.', auth: 'public' },
  { slug: 'realtime.stream', category: 'comms',
    name: 'Subscribe to event stream', primitive: 'realtime',
    method: 'GET', path: '/v1/realtime/stream',
    cost_cents: 0, latency_ms_p50: 250, sla_uptime_pct: 99.9,
    description: 'SSE push of every audit-chained event.', auth: 'agent' },
  { slug: 'multimodal.fuse', category: 'cognition',
    name: 'Multi-modal fusion', primitive: 'multimodal',
    method: 'POST', path: '/v1/agents/:did/multimodal/fuse',
    cost_cents: 10, latency_ms_p50: 2500, sla_uptime_pct: 99.9,
    description: 'text+image+audio+video fused to cheapest capable provider.', auth: 'agent' },
  { slug: 'mcp.tools_list', category: 'protocol',
    name: 'List MCP tools', primitive: 'mcp_server',
    method: 'GET', path: '/mcp/manifest',
    cost_cents: 0, latency_ms_p50: 100, sla_uptime_pct: 99.99,
    description: '145+ MCP tools exposed for Claude/OpenAI/Cursor.', auth: 'public' },
  { slug: 'reserve.check', category: 'trust',
    name: 'Public proof of reserves', primitive: 'bank_core',
    method: 'GET', path: '/v1/bank-core/reserve-ratio',
    cost_cents: 0, latency_ms_p50: 50, sla_uptime_pct: 99.99,
    description: 'Live customer-liability vs reserve-asset ratio.', auth: 'public' }
];

const CATEGORIES = ['identity', 'commerce', 'compliance', 'cognition', 'perception',
                    'comms', 'a2a', 'safety', 'trust', 'protocol'];

async function migrate(_pool) {}

function search(query, opts = {}) {
  const q = String(query || '').toLowerCase();
  let results = CAPABILITIES.slice();
  if (opts.category) results = results.filter(c => c.category === opts.category);
  if (opts.primitive) results = results.filter(c => c.primitive === opts.primitive);
  if (opts.max_latency_ms) results = results.filter(c => c.latency_ms_p50 <= opts.max_latency_ms);
  if (opts.max_cost_cents !== undefined) results = results.filter(c => c.cost_cents <= opts.max_cost_cents);
  if (q) {
    const score = c => {
      let s = 0;
      if (c.name.toLowerCase().includes(q)) s += 10;
      if (c.description.toLowerCase().includes(q)) s += 5;
      if (c.slug.includes(q)) s += 8;
      if (c.category.includes(q)) s += 3;
      return s;
    };
    results = results.map(c => ({ ...c, score: score(c) })).filter(c => c.score > 0).sort((a, b) => b.score - a.score);
  }
  return results;
}

function registerCapabilityCatalogRoutes(app, _pool, _verifyAgentAuth, _auditChain) {
  const express = require('express');

  app.get('/v1/capabilities', (req, res) => {
    res.setHeader('cache-control', 'public, max-age=300');
    res.json({
      total: CAPABILITIES.length,
      categories: CATEGORIES,
      capabilities: CAPABILITIES,
      pricing_note: 'cost_cents is per-call. Bulk/streaming capabilities apply additional pricing.',
      auth_notes: { public: 'no auth required', agent: 'Bearer token or X-Agent-DID+X-Agent-Sig',
                     signed: 'Ed25519 signed request required' },
      docs: '/v1/capabilities/:slug for full metadata'
    });
  });

  app.get('/v1/capabilities/search', (req, res) => {
    const out = search(req.query.q, {
      category: req.query.category,
      primitive: req.query.primitive,
      max_latency_ms: req.query.max_latency_ms ? parseInt(req.query.max_latency_ms) : undefined,
      max_cost_cents: req.query.max_cost_cents !== undefined ? parseInt(req.query.max_cost_cents) : undefined
    });
    res.json({ query: req.query.q || null, count: out.length, capabilities: out });
  });

  app.get('/v1/capabilities/:slug', (req, res) => {
    const c = CAPABILITIES.find(x => x.slug === req.params.slug);
    if (!c) return res.status(404).json({ error: 'not_found' });
    res.json({ ...c, sample_curl: `curl -X ${c.method} ${(process.env.OPERATOR_PUBLIC_URL || '')}${c.path}` });
  });

  app.post('/v1/capabilities/match', express.json(), (req, res) => {
    const goal = req.body?.goal || '';
    const out = search(goal, req.body?.constraints || {});
    res.json({ goal, matches: out.slice(0, 10), reasoning: 'lexical + category + constraint match' });
  });
}

module.exports = { migrate, registerCapabilityCatalogRoutes, CAPABILITIES, CATEGORIES, search };
