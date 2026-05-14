// ============================================================================
// OpenHeab Legal Research — Westlaw/LexisNexis-style legal database.
// Cases, statutes, regulations, treatises, articles.
// CourtListener API integration stub. Embeddings via pgvector if installed.
// ============================================================================
const express = require('express');
const cryptoLib = require('crypto');
const { z } = require('zod');

const DOC_KINDS = ['case', 'statute', 'regulation', 'treatise', 'article'];
const ALERT_FREQUENCIES = ['daily', 'weekly'];
const BRIEF_STATUSES = ['drafted', 'filed'];

const SEARCH_COST_CENTS = 5; // $0.05 per search

// ----------------------------------------------------------------------------
// Migration
// ----------------------------------------------------------------------------
async function migrate(pool) {
  let hasVector = false;
  try {
    const ext = await pool.query(`SELECT 1 FROM pg_extension WHERE extname='vector'`);
    hasVector = ext.rows.length > 0;
  } catch {}
  const embeddingCol = hasVector ? 'embedding vector(1536)' : 'embedding JSONB';

  await pool.query(`
    CREATE TABLE IF NOT EXISTS legal_documents (
      doc_id        TEXT PRIMARY KEY,
      kind          TEXT NOT NULL,
      citation      TEXT,
      title         TEXT NOT NULL,
      jurisdiction  TEXT,
      court         TEXT,
      judge         TEXT,
      decided_at    DATE,
      body          TEXT,
      keywords      TEXT[] DEFAULT '{}',
      summary       TEXT,
      ${embeddingCol},
      public        BOOLEAN NOT NULL DEFAULT TRUE,
      source        TEXT,
      ingested_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_legal_documents_kind ON legal_documents (kind);
    CREATE INDEX IF NOT EXISTS idx_legal_documents_jurisdiction ON legal_documents (jurisdiction);
    CREATE INDEX IF NOT EXISTS idx_legal_documents_keywords ON legal_documents USING GIN (keywords);
    CREATE INDEX IF NOT EXISTS idx_legal_documents_public ON legal_documents (public) WHERE public=TRUE;

    CREATE TABLE IF NOT EXISTS legal_searches (
      search_id    TEXT PRIMARY KEY,
      agent_did    TEXT,
      query        TEXT NOT NULL,
      jurisdiction TEXT,
      kinds        TEXT[] DEFAULT '{}',
      results      JSONB,
      cost_cents   INTEGER NOT NULL DEFAULT 0,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_legal_searches_agent ON legal_searches (agent_did, created_at DESC);

    CREATE TABLE IF NOT EXISTS legal_briefs (
      brief_id    TEXT PRIMARY KEY,
      agent_did   TEXT NOT NULL,
      title       TEXT NOT NULL,
      citations   TEXT[] DEFAULT '{}',
      outline     TEXT,
      body        TEXT,
      status      TEXT NOT NULL DEFAULT 'drafted',
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_legal_briefs_agent ON legal_briefs (agent_did, created_at DESC);

    CREATE TABLE IF NOT EXISTS legal_alerts (
      alert_id      TEXT PRIMARY KEY,
      agent_did     TEXT NOT NULL,
      name          TEXT NOT NULL,
      query         TEXT NOT NULL,
      jurisdiction  TEXT,
      frequency     TEXT NOT NULL DEFAULT 'daily',
      last_run_at   TIMESTAMPTZ,
      active        BOOLEAN NOT NULL DEFAULT TRUE,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_legal_alerts_agent ON legal_alerts (agent_did);
  `).catch(() => {});
}

function genId(prefix) { return `${prefix}_${cryptoLib.randomBytes(12).toString('hex')}`; }

// CourtListener API integration
async function searchCourtListener(query, jurisdiction) {
  try {
    const url = new URL('https://www.courtlistener.com/api/rest/v3/search/');
    url.searchParams.set('q', query);
    if (jurisdiction) url.searchParams.set('court', jurisdiction.toLowerCase());
    url.searchParams.set('type', 'o'); // opinions
    const headers = { 'accept': 'application/json' };
    if (process.env.COURTLISTENER_API_TOKEN) {
      headers['authorization'] = `Token ${process.env.COURTLISTENER_API_TOKEN}`;
    }
    const r = await fetch(url.toString(), { headers });
    if (!r.ok) return [];
    const j = await r.json();
    return (j.results || []).slice(0, 25).map(r => ({
      doc_id: 'cl_' + String(r.id || r.cluster_id || cryptoLib.randomBytes(6).toString('hex')),
      title: r.caseName || r.case_name || r.absolute_url || 'untitled',
      citation: (r.citation && r.citation[0]) || null,
      court: r.court || null,
      decided_at: r.dateFiled || null,
      snippet: (r.snippet || r.text || '').slice(0, 400),
      score: r.score || 0.5
    }));
  } catch (e) { return []; }
}

// ----------------------------------------------------------------------------
// Routes
// ----------------------------------------------------------------------------
function registerLegalResearchRoutes(app, pool, verifyAgentAuth, auditChain) {
  // ---- Search --------------------------------------------------------------
  const SearchSchema = z.object({
    q: z.string().min(1).max(2000),
    jurisdiction: z.string().max(60).optional(),
    kinds: z.array(z.enum(DOC_KINDS)).optional(),
    agent_did: z.string().optional()
  });
  app.post('/v1/legal/search', express.json(), async (req, res) => {
    try {
      const parse = SearchSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;

      let agentDid = d.agent_did || null;
      if (agentDid) {
        const auth = await verifyAgentAuth(req, agentDid);
        if (!auth.valid) return res.status(401).json({ error: auth.error });
      }

      // Local DB search
      const params = [`%${d.q}%`];
      const conds = [`(title ILIKE $1 OR body ILIKE $1 OR summary ILIKE $1 OR $1 = ANY(keywords))`];
      if (d.jurisdiction) { params.push(d.jurisdiction); conds.push(`jurisdiction=$${params.length}`); }
      if (d.kinds && d.kinds.length) { params.push(d.kinds); conds.push(`kind = ANY($${params.length}::text[])`); }
      const local = await pool.query(
        `SELECT doc_id, title, citation, court, judge, decided_at, jurisdiction, kind,
                LEFT(COALESCE(summary, body), 400) AS snippet
           FROM legal_documents
          WHERE ${conds.join(' AND ')}
          ORDER BY decided_at DESC NULLS LAST
          LIMIT 50`, params
      ).catch(() => ({ rows: [] }));

      const localResults = local.rows.map(r => ({ ...r, score: 0.5, source: 'local' }));

      // CourtListener (optional)
      let externalResults = [];
      try { externalResults = (await searchCourtListener(d.q, d.jurisdiction)).map(r => ({ ...r, source: 'courtlistener' })); }
      catch { externalResults = []; }

      const all = [...localResults, ...externalResults].slice(0, 75);

      const searchId = genId('lsr');
      await pool.query(
        `INSERT INTO legal_searches (search_id, agent_did, query, jurisdiction, kinds, results, cost_cents)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)`,
        [searchId, agentDid, d.q, d.jurisdiction || null, d.kinds || [],
         JSON.stringify(all), agentDid ? SEARCH_COST_CENTS : 0]
      );

      if (agentDid) {
        try {
          const cost = require('./cost');
          await cost.recordCost(pool, {
            agent_did: agentDid, resource_type: 'legal_search',
            provider: 'courtlistener', amount_cents: SEARCH_COST_CENTS,
            reference_id: searchId, auditChain
          });
        } catch {}
      }

      return res.json({
        search_id: searchId, query: d.q, jurisdiction: d.jurisdiction,
        results: all, count: all.length
      });
    } catch (e) { return res.status(500).json({ error: 'search_failed', message: e.message }); }
  });

  // ---- Document detail ----------------------------------------------------
  app.get('/v1/legal/docs/:id', async (req, res) => {
    const r = await pool.query(`SELECT * FROM legal_documents WHERE doc_id=$1`, [req.params.id])
      .catch(() => ({ rows: [] }));
    if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
    const row = r.rows[0];
    delete row.embedding;
    return res.json(row);
  });

  // ---- Briefs --------------------------------------------------------------
  const BriefSchema = z.object({
    title: z.string().min(1).max(500),
    citations: z.array(z.string()).optional(),
    outline: z.string().max(50000).optional(),
    body: z.string().max(500000).optional(),
    status: z.enum(BRIEF_STATUSES).optional()
  });
  app.post('/v1/agents/:did/legal/briefs', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const parse = BriefSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;
      const id = genId('brief');
      await pool.query(
        `INSERT INTO legal_briefs (brief_id, agent_did, title, citations, outline, body, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [id, did, d.title, d.citations || [], d.outline || null,
         d.body || null, d.status || 'drafted']
      );
      await auditChain.append({
        event_type: 'legal.brief_created', brief_id: id, agent_did: did,
        title: d.title, status: d.status || 'drafted',
        timestamp: new Date().toISOString()
      });
      return res.status(201).json({ brief_id: id, title: d.title, status: d.status || 'drafted' });
    } catch (e) { return res.status(500).json({ error: 'create_failed', message: e.message }); }
  });

  app.get('/v1/agents/:did/legal/briefs', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(
      `SELECT * FROM legal_briefs WHERE agent_did=$1 ORDER BY created_at DESC LIMIT 500`, [did]
    ).catch(() => ({ rows: [] }));
    return res.json({ briefs: r.rows, count: r.rows.length });
  });

  // ---- Alerts --------------------------------------------------------------
  const AlertSchema = z.object({
    name: z.string().min(1).max(200),
    query: z.string().min(1).max(2000),
    jurisdiction: z.string().max(60).optional(),
    frequency: z.enum(ALERT_FREQUENCIES).optional(),
    active: z.boolean().optional()
  });
  app.post('/v1/agents/:did/legal/alerts', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const parse = AlertSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;
      const id = genId('alert');
      await pool.query(
        `INSERT INTO legal_alerts (alert_id, agent_did, name, query, jurisdiction, frequency, active)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [id, did, d.name, d.query, d.jurisdiction || null,
         d.frequency || 'daily', d.active !== false]
      );
      await auditChain.append({
        event_type: 'legal.alert_created', alert_id: id, agent_did: did,
        name: d.name, frequency: d.frequency || 'daily',
        timestamp: new Date().toISOString()
      });
      return res.status(201).json({ alert_id: id, name: d.name, frequency: d.frequency || 'daily' });
    } catch (e) { return res.status(500).json({ error: 'create_failed', message: e.message }); }
  });

  app.get('/v1/agents/:did/legal/alerts', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(
      `SELECT * FROM legal_alerts WHERE agent_did=$1 ORDER BY created_at DESC LIMIT 500`, [did]
    ).catch(() => ({ rows: [] }));
    return res.json({ alerts: r.rows, count: r.rows.length });
  });
}

module.exports = {
  migrate, registerLegalResearchRoutes,
  DOC_KINDS, ALERT_FREQUENCIES, BRIEF_STATUSES, SEARCH_COST_CENTS,
  searchCourtListener
};
