// ============================================================================
// OpenHeab Search — Web search across Brave/Google/Tavily/Bing
// Plus grounded-answer (LLM citation) and curated agent-indexes.
// ============================================================================
const express = require('express');
const cryptoLib = require('crypto');
const { z } = require('zod');

function tryRequire(name) {
  try { return require(name); } catch { return null; }
}

const SEARCH_COST_CENTS = 1; // ~$0.003 (rounded to integer cents)
const GROUNDED_COST_CENTS = 5; // extra for LLM answer + citations

function genQueryId() { return 'qry_' + cryptoLib.randomBytes(12).toString('hex'); }
function genIndexId() { return 'idx_' + cryptoLib.randomBytes(12).toString('hex'); }

function pickProvider(preferred) {
  if (preferred) return preferred;
  if (process.env.BRAVE_SEARCH_API_KEY) return 'brave';
  if (process.env.TAVILY_API_KEY) return 'tavily';
  if (process.env.GOOGLE_SEARCH_API_KEY) return 'google';
  if (process.env.BING_SEARCH_API_KEY) return 'bing';
  return 'stub';
}

// ----------------------------------------------------------------------------
// Migration
// ----------------------------------------------------------------------------
async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS search_queries (
      query_id     TEXT PRIMARY KEY,
      agent_did    TEXT,
      query        TEXT NOT NULL,
      provider     TEXT NOT NULL,
      results      JSONB,
      result_count INTEGER NOT NULL DEFAULT 0,
      cost_cents   INTEGER NOT NULL DEFAULT 0,
      latency_ms   INTEGER NOT NULL DEFAULT 0,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_search_queries_did
      ON search_queries (agent_did, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_search_queries_created
      ON search_queries (created_at DESC);

    CREATE TABLE IF NOT EXISTS search_index (
      index_id   TEXT PRIMARY KEY,
      agent_did  TEXT NOT NULL,
      name       TEXT NOT NULL,
      sources    TEXT[] NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_search_index_did
      ON search_index (agent_did, created_at DESC);
  `);
}

// ----------------------------------------------------------------------------
// Providers
// ----------------------------------------------------------------------------
async function callBrave(query, limit, freshness) {
  const params = new URLSearchParams({ q: query, count: String(limit || 10) });
  if (freshness) params.set('freshness', freshness);
  const r = await fetch(`https://api.search.brave.com/res/v1/web/search?${params}`, {
    headers: {
      'x-subscription-token': process.env.BRAVE_SEARCH_API_KEY,
      'accept': 'application/json'
    }
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.message || `brave_${r.status}`);
  const items = (j?.web?.results || []).map(x => ({
    title: x.title, url: x.url, snippet: x.description,
    published_at: x.age || null
  }));
  return items;
}

async function callTavily(query, limit) {
  const r = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      api_key: process.env.TAVILY_API_KEY,
      query,
      max_results: limit || 10
    })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.detail || `tavily_${r.status}`);
  return (j?.results || []).map(x => ({
    title: x.title, url: x.url, snippet: x.content,
    published_at: x.published_date || null
  }));
}

async function callGoogle(query, limit) {
  const cx = process.env.GOOGLE_SEARCH_CX;
  const params = new URLSearchParams({
    key: process.env.GOOGLE_SEARCH_API_KEY,
    cx: cx || '',
    q: query,
    num: String(Math.min(limit || 10, 10))
  });
  const r = await fetch(`https://www.googleapis.com/customsearch/v1?${params}`);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.error?.message || `google_${r.status}`);
  return (j?.items || []).map(x => ({
    title: x.title, url: x.link, snippet: x.snippet,
    published_at: null
  }));
}

async function callBing(query, limit) {
  const params = new URLSearchParams({ q: query, count: String(limit || 10) });
  const r = await fetch(`https://api.bing.microsoft.com/v7.0/search?${params}`, {
    headers: { 'ocp-apim-subscription-key': process.env.BING_SEARCH_API_KEY }
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.message || `bing_${r.status}`);
  return (j?.webPages?.value || []).map(x => ({
    title: x.name, url: x.url, snippet: x.snippet,
    published_at: x.dateLastCrawled || null
  }));
}

async function runSearch(provider, query, opts) {
  const limit = opts?.limit || 10;
  const freshness = opts?.freshness;
  if (provider === 'brave' && process.env.BRAVE_SEARCH_API_KEY) return callBrave(query, limit, freshness);
  if (provider === 'tavily' && process.env.TAVILY_API_KEY) return callTavily(query, limit);
  if (provider === 'google' && process.env.GOOGLE_SEARCH_API_KEY) return callGoogle(query, limit);
  if (provider === 'bing' && process.env.BING_SEARCH_API_KEY) return callBing(query, limit);
  // Stub fallback
  return [{
    title: 'search not configured',
    url: 'https://openheab.com/docs/search',
    snippet: `Configure BRAVE_SEARCH_API_KEY or TAVILY_API_KEY for live results. Query: ${query}`,
    published_at: null
  }];
}

// ----------------------------------------------------------------------------
// Schemas
// ----------------------------------------------------------------------------
const SearchSchema = z.object({
  q: z.string().min(1).max(2048),
  provider: z.enum(['brave', 'google', 'tavily', 'bing']).optional(),
  limit: z.number().int().min(1).max(50).optional(),
  freshness: z.enum(['pd', 'pw', 'pm', 'py']).optional(),
  agent_did: z.string().optional()
});
const GroundedSchema = z.object({
  q: z.string().min(1).max(2048),
  provider: z.enum(['brave', 'google', 'tavily', 'bing']).optional(),
  limit: z.number().int().min(1).max(20).optional(),
  model: z.string().max(256).optional(),
  agent_did: z.string().optional()
});
const IndexCreateSchema = z.object({
  name: z.string().min(1).max(256),
  sources: z.array(z.string().min(1).max(512)).max(100)
});
const IndexQuerySchema = z.object({
  q: z.string().min(1).max(2048),
  limit: z.number().int().min(1).max(50).optional()
});

// ----------------------------------------------------------------------------
// Routes
// ----------------------------------------------------------------------------
function registerSearchRoutes(app, pool, verifyAgentAuth, auditChain) {
  const cost = tryRequire('./cost');
  const inference = tryRequire('./inference');

  async function logQuery(agentDid, query, provider, results, latency_ms, cost_cents) {
    const queryId = genQueryId();
    await pool.query(`
      INSERT INTO search_queries
      (query_id, agent_did, query, provider, results, result_count, cost_cents, latency_ms)
      VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8)
    `, [queryId, agentDid || null, query, provider,
        JSON.stringify(results), results.length, cost_cents, latency_ms]).catch(() => {});
    return queryId;
  }

  function chargeCost(did, provider, cents, refId, resource) {
    if (!did || !cost || typeof cost.recordCost !== 'function') return;
    cost.recordCost(pool, {
      agent_did: did, resource_type: resource, provider,
      amount_cents: cents, reference_id: refId
    }).catch(e => console.warn('[search.cost]', e.message));
  }

  // POST /v1/search — public-ish, optionally authed
  app.post('/v1/search', express.json(), async (req, res) => {
    const start = Date.now();
    try {
      const parse = SearchSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;

      if (d.agent_did) {
        const auth = await verifyAgentAuth(req, d.agent_did);
        if (!auth.valid) return res.status(401).json({ error: auth.error });
      }

      const provider = pickProvider(d.provider);
      let results = [];
      let err = null;
      try {
        results = await runSearch(provider, d.q, { limit: d.limit, freshness: d.freshness });
      } catch (e) { err = e.message; results = []; }

      const latency_ms = Date.now() - start;
      const queryId = await logQuery(d.agent_did, d.q, provider, results, latency_ms, SEARCH_COST_CENTS);

      await auditChain.append({
        event_type: 'search.query_completed',
        query_id: queryId, agent_did: d.agent_did || null,
        provider, result_count: results.length,
        cost_cents: SEARCH_COST_CENTS,
        timestamp: new Date().toISOString()
      });

      chargeCost(d.agent_did, provider, SEARCH_COST_CENTS, queryId, 'search');

      return res.json({
        query_id: queryId, query: d.q, provider, results,
        result_count: results.length, latency_ms, error: err
      });
    } catch (e) {
      console.error('[search]', e);
      return res.status(500).json({ error: 'search_failed', message: e.message });
    }
  });

  // POST /v1/search/grounded — answer with citations via inference primitive
  app.post('/v1/search/grounded', express.json(), async (req, res) => {
    const start = Date.now();
    try {
      const parse = GroundedSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;

      if (d.agent_did) {
        const auth = await verifyAgentAuth(req, d.agent_did);
        if (!auth.valid) return res.status(401).json({ error: auth.error });
      }

      const provider = pickProvider(d.provider);
      const results = await runSearch(provider, d.q, { limit: d.limit || 5 });
      const latency_search = Date.now() - start;

      // Build LLM prompt
      const ctx = results.map((r, i) =>
        `[${i + 1}] ${r.title}\nURL: ${r.url}\n${r.snippet || ''}`
      ).join('\n\n');
      const messages = [
        { role: 'system', content: 'You are a research assistant. Answer the user query based ONLY on the provided sources, and cite them using bracket numbers like [1], [2]. If sources are insufficient, say so.' },
        { role: 'user', content: `Query: ${d.q}\n\nSources:\n${ctx}\n\nAnswer with citations.` }
      ];

      let answer = '';
      let inferenceErr = null;
      const model = d.model || 'gpt-4o-mini';
      if (inference && typeof inference.callUpstream === 'function') {
        try {
          const providerInf = inference.providerForModel(model);
          const upstream = await inference.callUpstream(providerInf, model, messages, { max_tokens: 1024 }, null);
          answer = upstream?.choices?.[0]?.message?.content || '';
        } catch (e) { inferenceErr = e.message; }
      } else {
        inferenceErr = 'inference primitive unavailable';
      }

      const totalLatency = Date.now() - start;
      const queryId = await logQuery(d.agent_did, d.q, provider, results, totalLatency, SEARCH_COST_CENTS + GROUNDED_COST_CENTS);

      await auditChain.append({
        event_type: 'search.grounded_answer',
        query_id: queryId, agent_did: d.agent_did || null,
        provider, model, result_count: results.length,
        cost_cents: SEARCH_COST_CENTS + GROUNDED_COST_CENTS,
        timestamp: new Date().toISOString()
      });

      chargeCost(d.agent_did, provider, SEARCH_COST_CENTS + GROUNDED_COST_CENTS, queryId, 'search_grounded');

      return res.json({
        query_id: queryId, query: d.q, answer, citations: results,
        provider, model, latency_ms: totalLatency,
        search_latency_ms: latency_search,
        error: inferenceErr
      });
    } catch (e) {
      console.error('[search.grounded]', e);
      return res.status(500).json({ error: 'grounded_failed', message: e.message });
    }
  });

  // POST /v1/agents/:did/search/index — create curated index
  app.post('/v1/agents/:did/search/index', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const parse = IndexCreateSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;

      const indexId = genIndexId();
      await pool.query(`
        INSERT INTO search_index (index_id, agent_did, name, sources)
        VALUES ($1,$2,$3,$4)
      `, [indexId, did, d.name, d.sources]);

      await auditChain.append({
        event_type: 'search.index_created',
        index_id: indexId, agent_did: did,
        source_count: d.sources.length,
        timestamp: new Date().toISOString()
      });

      return res.status(201).json({
        index_id: indexId, name: d.name, sources: d.sources
      });
    } catch (e) {
      console.error('[search.index.create]', e);
      return res.status(500).json({ error: 'index_create_failed', message: e.message });
    }
  });

  // POST /v1/agents/:did/search/index/:id/query
  app.post('/v1/agents/:did/search/index/:id/query', express.json(), async (req, res) => {
    const start = Date.now();
    try {
      const did = req.params.did;
      const indexId = req.params.id;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const parse = IndexQuerySchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;

      const r = await pool.query(`
        SELECT sources FROM search_index WHERE index_id=$1 AND agent_did=$2
      `, [indexId, did]).catch(() => ({ rows: [] }));
      if (!r.rows[0]) return res.status(404).json({ error: 'index_not_found' });

      const sources = r.rows[0].sources || [];
      const siteFilter = sources.length
        ? ' (' + sources.map(s => `site:${s}`).join(' OR ') + ')'
        : '';
      const provider = pickProvider();
      let results = [];
      try {
        results = await runSearch(provider, d.q + siteFilter, { limit: d.limit || 10 });
      } catch {}

      const latency_ms = Date.now() - start;
      const queryId = await logQuery(did, d.q, provider, results, latency_ms, SEARCH_COST_CENTS);

      await auditChain.append({
        event_type: 'search.index_queried',
        query_id: queryId, index_id: indexId, agent_did: did,
        result_count: results.length,
        timestamp: new Date().toISOString()
      });

      chargeCost(did, provider, SEARCH_COST_CENTS, queryId, 'search_index');

      return res.json({
        query_id: queryId, index_id: indexId, query: d.q,
        provider, results, result_count: results.length, latency_ms
      });
    } catch (e) {
      console.error('[search.index.query]', e);
      return res.status(500).json({ error: 'index_query_failed', message: e.message });
    }
  });

  // GET /v1/agents/:did/search/queries
  app.get('/v1/agents/:did/search/queries', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    const r = await pool.query(`
      SELECT query_id, agent_did, query, provider, result_count,
             cost_cents, latency_ms, created_at
      FROM search_queries WHERE agent_did=$1
      ORDER BY created_at DESC LIMIT $2
    `, [did, limit]).catch(() => ({ rows: [] }));
    return res.json({ queries: r.rows, count: r.rows.length });
  });
}

module.exports = {
  migrate,
  registerSearchRoutes,
  pickProvider,
  runSearch,
  callBrave,
  callTavily,
  callGoogle,
  callBing
};
