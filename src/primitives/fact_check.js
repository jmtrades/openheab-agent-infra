// ============================================================================
// OpenHeab Fact-Check — Fact verification + citation management
// Tables: fact_checks, citations, citation_collections
// Uses inference primitive (grounded with search results) for verdicts.
// ============================================================================
const express = require('express');
const cryptoLib = require('crypto');
const { z } = require('zod');

const VERDICTS = ['supported', 'refuted', 'mixed', 'uncheckable'];
const SOURCE_TYPES = ['article', 'paper', 'book', 'website', 'social'];
const FACT_CHECK_COST_CENTS = parseInt(process.env.FACT_CHECK_COST_CENTS || '5');
const CITATION_VERIFY_COST_CENTS = parseInt(process.env.CITATION_VERIFY_COST_CENTS || '1');

// ----------------------------------------------------------------------------
// Migration
// ----------------------------------------------------------------------------
async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS fact_checks (
      check_id     TEXT PRIMARY KEY,
      agent_did    TEXT,
      claim        TEXT NOT NULL,
      verdict      TEXT,
      confidence   REAL,
      evidence     JSONB,
      citations    JSONB,
      provider     TEXT,
      cost_cents   INTEGER NOT NULL DEFAULT 0,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_fc_agent ON fact_checks (agent_did, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_fc_verdict ON fact_checks (verdict);

    CREATE TABLE IF NOT EXISTS citations (
      citation_id    TEXT PRIMARY KEY,
      agent_did      TEXT NOT NULL,
      source_url     TEXT,
      source_type    TEXT,
      title          TEXT,
      author         TEXT,
      published_at   TIMESTAMPTZ,
      accessed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      quote          TEXT,
      verified       BOOLEAN NOT NULL DEFAULT FALSE,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_cit_agent ON citations (agent_did, created_at DESC);

    CREATE TABLE IF NOT EXISTS citation_collections (
      collection_id  TEXT PRIMARY KEY,
      agent_did      TEXT NOT NULL,
      name           TEXT NOT NULL,
      citation_ids   TEXT[] NOT NULL DEFAULT '{}',
      public         BOOLEAN NOT NULL DEFAULT FALSE,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_cc_agent ON citation_collections (agent_did);
  `).catch(() => {});
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------
function genId(prefix) {
  return `${prefix}_${cryptoLib.randomBytes(12).toString('hex')}`;
}

function tryRequire(name) {
  try { return require(name); } catch { return null; }
}

async function searchEvidence(claim, opts = {}) {
  // Try search primitive if it exists
  const search = tryRequire('./search');
  if (search && typeof search.search === 'function') {
    try {
      const out = await search.search(claim, { limit: 5 });
      if (Array.isArray(out) && out.length) return out;
    } catch {}
  }
  // Try Perplexity directly (if PERPLEXITY_API_KEY set)
  if (process.env.PERPLEXITY_API_KEY) {
    return null; // we'll route directly via Perplexity below
  }
  // Try Tavily search if configured
  if (process.env.TAVILY_API_KEY) {
    const r = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        api_key: process.env.TAVILY_API_KEY,
        query: claim, max_results: 5
      })
    }).then(x => x.json()).catch(() => null);
    if (r?.results) {
      return r.results.map(x => ({
        url: x.url, title: x.title, snippet: x.content || x.snippet
      }));
    }
  }
  return null;
}

async function callPerplexity(claim) {
  if (!process.env.PERPLEXITY_API_KEY) return null;
  const r = await fetch('https://api.perplexity.ai/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': `Bearer ${process.env.PERPLEXITY_API_KEY}`
    },
    body: JSON.stringify({
      model: process.env.PERPLEXITY_MODEL || 'llama-3.1-sonar-large-128k-online',
      messages: [
        { role: 'system', content: 'You are a fact checker. Reply with strict JSON: {"verdict":"supported|refuted|mixed|uncheckable","confidence":0.0-1.0,"reasoning":"...","citations":[{"url":"","title":""}]}' },
        { role: 'user', content: `Claim: ${claim}` }
      ],
      temperature: 0.0
    })
  }).then(x => x.json()).catch(() => null);
  const content = r?.choices?.[0]?.message?.content;
  if (!content) return null;
  try {
    const m = content.match(/\{[\s\S]*\}/);
    const parsed = m ? JSON.parse(m[0]) : null;
    if (parsed && VERDICTS.includes(parsed.verdict)) {
      return { ...parsed, provider: 'perplexity' };
    }
  } catch {}
  return null;
}

async function callGroundedInference(claim, evidence) {
  // Use inference primitive's openai-compatible call path indirectly via direct fetch
  if (!process.env.OPENAI_API_KEY && !process.env.ANTHROPIC_API_KEY) return null;
  const evidenceText = (evidence || [])
    .map((e, i) => `[${i + 1}] ${e.title || ''} ${e.url || ''}\n${e.snippet || ''}`).join('\n\n');
  const sys = `You are a fact checker. Given a claim and a set of evidence snippets, return STRICT JSON only: {"verdict":"supported|refuted|mixed|uncheckable","confidence":0.0-1.0,"reasoning":"short explanation","evidence":[{"snippet":"...","supports":true|false}]}`;
  const userMsg = `Claim: ${claim}\n\nEvidence:\n${evidenceText || '(none provided)'}`;

  if (process.env.OPENAI_API_KEY) {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: process.env.FACT_CHECK_MODEL || 'gpt-4o-mini',
        messages: [
          { role: 'system', content: sys },
          { role: 'user', content: userMsg }
        ],
        temperature: 0.0
      })
    }).then(x => x.json()).catch(() => null);
    const content = r?.choices?.[0]?.message?.content;
    if (content) {
      try {
        const m = content.match(/\{[\s\S]*\}/);
        const parsed = m ? JSON.parse(m[0]) : null;
        if (parsed && VERDICTS.includes(parsed.verdict)) {
          return { ...parsed, provider: 'openai-grounded' };
        }
      } catch {}
    }
  }
  if (process.env.ANTHROPIC_API_KEY) {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-3-5-sonnet-20241022',
        max_tokens: 800,
        system: sys,
        messages: [{ role: 'user', content: userMsg }]
      })
    }).then(x => x.json()).catch(() => null);
    const content = r?.content?.[0]?.text;
    if (content) {
      try {
        const m = content.match(/\{[\s\S]*\}/);
        const parsed = m ? JSON.parse(m[0]) : null;
        if (parsed && VERDICTS.includes(parsed.verdict)) {
          return { ...parsed, provider: 'anthropic-grounded' };
        }
      } catch {}
    }
  }
  return null;
}

async function tryRecordCost(pool, did, amount, kind) {
  if (!did) return;
  try {
    const cost = require('./cost');
    if (cost && typeof cost.recordCost === 'function') {
      await cost.recordCost(pool, {
        agent_did: did, resource_type: 'fact_check',
        provider: kind, amount_cents: amount
      });
    }
  } catch {}
}

// ----------------------------------------------------------------------------
// Routes
// ----------------------------------------------------------------------------
function registerFactCheckRoutes(app, pool, verifyAgentAuth, auditChain) {
  // POST /v1/fact-check
  const FCSchema = z.object({
    claim: z.string().min(3).max(4000),
    agent_did: z.string().optional()
  });
  app.post('/v1/fact-check', express.json(), async (req, res) => {
    try {
      const parse = FCSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;

      // 1) Prefer Perplexity online (built-in search + reasoning)
      let result = await callPerplexity(d.claim);

      // 2) Otherwise: search + grounded inference
      if (!result) {
        const evidence = await searchEvidence(d.claim) || [];
        const inf = await callGroundedInference(d.claim, evidence);
        if (inf) {
          result = { ...inf, citations: evidence.map(e => ({ url: e.url, title: e.title })) };
        }
      }

      if (!result) {
        result = {
          verdict: 'uncheckable',
          confidence: 0.0,
          reasoning: 'No fact-check provider configured (set PERPLEXITY_API_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY, or TAVILY_API_KEY).',
          citations: [], provider: 'unavailable'
        };
      }

      const checkId = genId('fc');
      await pool.query(
        `INSERT INTO fact_checks
         (check_id, agent_did, claim, verdict, confidence, evidence, citations, provider, cost_cents)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9)`,
        [checkId, d.agent_did || null, d.claim, result.verdict,
         result.confidence ?? null,
         JSON.stringify(result.evidence || []),
         JSON.stringify(result.citations || []),
         result.provider, FACT_CHECK_COST_CENTS]
      ).catch(() => {});
      await tryRecordCost(pool, d.agent_did, FACT_CHECK_COST_CENTS, result.provider);
      await auditChain.append({
        event_type: 'fact_check.completed',
        check_id: checkId, agent_did: d.agent_did,
        verdict: result.verdict, confidence: result.confidence,
        timestamp: new Date().toISOString()
      });

      return res.json({
        check_id: checkId, claim: d.claim,
        verdict: result.verdict, confidence: result.confidence,
        reasoning: result.reasoning || null,
        evidence: result.evidence || [],
        citations: result.citations || [],
        provider: result.provider
      });
    } catch (e) {
      console.error('[fact_check]', e);
      return res.status(500).json({ error: 'fact_check_failed', message: e.message });
    }
  });

  // POST /v1/agents/:did/citations — save citation
  const CSchema = z.object({
    source_url: z.string().url().optional(),
    source_type: z.enum(SOURCE_TYPES).optional(),
    title: z.string().max(1024).optional(),
    author: z.string().max(512).optional(),
    published_at: z.string().datetime().optional(),
    quote: z.string().max(10000).optional()
  });
  app.post('/v1/agents/:did/citations', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const parse = CSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;

      const citationId = genId('cite');
      await pool.query(
        `INSERT INTO citations
         (citation_id, agent_did, source_url, source_type, title, author, published_at, quote)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [citationId, did, d.source_url || null, d.source_type || null,
         d.title || null, d.author || null,
         d.published_at ? new Date(d.published_at) : null, d.quote || null]
      );
      await auditChain.append({
        event_type: 'fact_check.citation_saved',
        citation_id: citationId, agent_did: did,
        source_url: d.source_url, timestamp: new Date().toISOString()
      });
      return res.status(201).json({
        citation_id: citationId, agent_did: did,
        source_url: d.source_url, source_type: d.source_type,
        title: d.title, author: d.author
      });
    } catch (e) {
      console.error('[fact_check.citation.create]', e);
      return res.status(500).json({ error: 'citation_create_failed', message: e.message });
    }
  });

  // GET /v1/agents/:did/citations
  app.get('/v1/agents/:did/citations', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    const r = await pool.query(
      `SELECT * FROM citations WHERE agent_did = $1
       ORDER BY created_at DESC LIMIT $2`,
      [did, limit]
    ).catch(() => ({ rows: [] }));
    return res.json({ citations: r.rows, count: r.rows.length });
  });

  // POST /v1/agents/:did/citations/:id/verify — re-verify URL still resolves
  app.post('/v1/agents/:did/citations/:id/verify', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const r = await pool.query(
        `SELECT * FROM citations WHERE citation_id = $1 AND agent_did = $2`,
        [req.params.id, did]
      ).catch(() => ({ rows: [] }));
      if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
      const cite = r.rows[0];

      let verified = false;
      let httpStatus = null;
      if (cite.source_url) {
        try {
          const resp = await fetch(cite.source_url, {
            method: 'HEAD',
            redirect: 'follow',
            signal: AbortSignal.timeout(8000)
          });
          httpStatus = resp.status;
          verified = resp.ok;
        } catch {
          // Try GET if HEAD blocked
          try {
            const resp = await fetch(cite.source_url, {
              method: 'GET',
              redirect: 'follow',
              signal: AbortSignal.timeout(8000)
            });
            httpStatus = resp.status;
            verified = resp.ok;
          } catch {}
        }
      }

      await pool.query(
        `UPDATE citations SET verified = $2, accessed_at = NOW() WHERE citation_id = $1`,
        [req.params.id, verified]
      );
      await tryRecordCost(pool, did, CITATION_VERIFY_COST_CENTS, 'verify');
      await auditChain.append({
        event_type: 'fact_check.citation_verified',
        citation_id: req.params.id, agent_did: did,
        verified, http_status: httpStatus,
        timestamp: new Date().toISOString()
      });
      return res.json({
        citation_id: req.params.id, source_url: cite.source_url,
        verified, http_status: httpStatus, accessed_at: new Date().toISOString()
      });
    } catch (e) {
      console.error('[fact_check.citation.verify]', e);
      return res.status(500).json({ error: 'verify_failed', message: e.message });
    }
  });

  // POST /v1/agents/:did/citation-collections
  const CollSchema = z.object({
    name: z.string().min(1).max(256),
    citation_ids: z.array(z.string()).max(10000).default([]),
    public: z.boolean().optional().default(false)
  });
  app.post('/v1/agents/:did/citation-collections', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const parse = CollSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;

      const collectionId = genId('cc');
      await pool.query(
        `INSERT INTO citation_collections (collection_id, agent_did, name, citation_ids, public)
         VALUES ($1,$2,$3,$4,$5)`,
        [collectionId, did, d.name, d.citation_ids, d.public]
      );
      await auditChain.append({
        event_type: 'fact_check.collection_created',
        collection_id: collectionId, agent_did: did, name: d.name,
        public: d.public, timestamp: new Date().toISOString()
      });
      return res.status(201).json({
        collection_id: collectionId, agent_did: did, name: d.name,
        citation_ids: d.citation_ids, public: d.public
      });
    } catch (e) {
      console.error('[fact_check.collection.create]', e);
      return res.status(500).json({ error: 'collection_create_failed', message: e.message });
    }
  });

  // GET /v1/agents/:did/citation-collections/:id
  app.get('/v1/agents/:did/citation-collections/:id', async (req, res) => {
    const did = req.params.did;
    const r = await pool.query(
      `SELECT * FROM citation_collections WHERE collection_id = $1`,
      [req.params.id]
    ).catch(() => ({ rows: [] }));
    if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
    const coll = r.rows[0];
    if (!coll.public && coll.agent_did !== did) {
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid || auth.subject !== coll.agent_did) {
        return res.status(403).json({ error: 'forbidden' });
      }
    }
    // Hydrate citations
    let citations = [];
    if (coll.citation_ids && coll.citation_ids.length) {
      const cR = await pool.query(
        `SELECT * FROM citations WHERE citation_id = ANY($1)`,
        [coll.citation_ids]
      ).catch(() => ({ rows: [] }));
      citations = cR.rows;
    }
    return res.json({ ...coll, citations });
  });
}

module.exports = {
  migrate,
  registerFactCheckRoutes,
  VERDICTS,
  SOURCE_TYPES
};
