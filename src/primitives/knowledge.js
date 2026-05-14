// ============================================================================
// OpenHeab Knowledge — Knowledge graphs + wikis for agents
// Tables: knowledge_graphs, knowledge_nodes, knowledge_edges, knowledge_pages
// Wiki linking via [[page_slug]]. Cypher-like simple traversal queries.
// ============================================================================
const express = require('express');
const cryptoLib = require('crypto');
const { z } = require('zod');

const NODE_TYPES = ['entity', 'concept', 'event', 'agent'];

// ----------------------------------------------------------------------------
// Migration
// ----------------------------------------------------------------------------
async function migrate(pool) {
  // pgvector if available; fall back to JSONB for embeddings if not
  let hasVector = false;
  try {
    const ext = await pool.query(`SELECT 1 FROM pg_extension WHERE extname='vector'`);
    hasVector = ext.rows.length > 0;
  } catch {}

  const embeddingCol = hasVector ? 'embeddings vector(1536)' : 'embeddings JSONB';

  await pool.query(`
    CREATE TABLE IF NOT EXISTS knowledge_graphs (
      graph_id     TEXT PRIMARY KEY,
      owner_did    TEXT NOT NULL,
      name         TEXT NOT NULL,
      description  TEXT,
      public       BOOLEAN NOT NULL DEFAULT FALSE,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_kg_owner ON knowledge_graphs (owner_did);

    CREATE TABLE IF NOT EXISTS knowledge_nodes (
      node_id     TEXT PRIMARY KEY,
      graph_id    TEXT NOT NULL,
      type        TEXT NOT NULL,
      label       TEXT NOT NULL,
      properties  JSONB,
      ${embeddingCol},
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_kn_graph ON knowledge_nodes (graph_id);
    CREATE INDEX IF NOT EXISTS idx_kn_type ON knowledge_nodes (graph_id, type);
    CREATE INDEX IF NOT EXISTS idx_kn_label ON knowledge_nodes (graph_id, label);

    CREATE TABLE IF NOT EXISTS knowledge_edges (
      edge_id    TEXT PRIMARY KEY,
      graph_id   TEXT NOT NULL,
      from_node  TEXT NOT NULL,
      to_node    TEXT NOT NULL,
      relation   TEXT NOT NULL,
      weight     REAL NOT NULL DEFAULT 1.0,
      properties JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_ke_graph ON knowledge_edges (graph_id);
    CREATE INDEX IF NOT EXISTS idx_ke_from ON knowledge_edges (graph_id, from_node);
    CREATE INDEX IF NOT EXISTS idx_ke_to ON knowledge_edges (graph_id, to_node);

    CREATE TABLE IF NOT EXISTS knowledge_pages (
      page_id      TEXT PRIMARY KEY,
      graph_id     TEXT NOT NULL,
      title        TEXT NOT NULL,
      slug         TEXT NOT NULL,
      body         TEXT NOT NULL,
      links_to     TEXT[] NOT NULL DEFAULT '{}',
      author_did   TEXT,
      version      INTEGER NOT NULL DEFAULT 1,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (graph_id, slug)
    );
    CREATE INDEX IF NOT EXISTS idx_kp_graph ON knowledge_pages (graph_id);
  `).catch(() => {});
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------
function genId(prefix) {
  return `${prefix}_${cryptoLib.randomBytes(12).toString('hex')}`;
}

function slugify(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '').slice(0, 100) || 'untitled';
}

function extractWikiLinks(body) {
  const re = /\[\[([a-zA-Z0-9_\-\s]{1,100})\]\]/g;
  const out = new Set();
  let m;
  while ((m = re.exec(body)) != null) {
    out.add(slugify(m[1]));
  }
  return Array.from(out);
}

async function assertOwnerOrPublic(pool, graphId, did, requireOwner) {
  const r = await pool.query(
    `SELECT owner_did, public FROM knowledge_graphs WHERE graph_id = $1`,
    [graphId]
  ).catch(() => ({ rows: [] }));
  if (!r.rows[0]) return { ok: false, reason: 'not_found' };
  if (r.rows[0].owner_did === did) return { ok: true, owner: true };
  if (requireOwner) return { ok: false, reason: 'forbidden' };
  if (r.rows[0].public) return { ok: true, owner: false };
  return { ok: false, reason: 'forbidden' };
}

// ----------------------------------------------------------------------------
// Routes
// ----------------------------------------------------------------------------
function registerKnowledgeRoutes(app, pool, verifyAgentAuth, auditChain) {
  // POST /v1/agents/:did/knowledge/graphs
  const GraphSchema = z.object({
    name: z.string().min(1).max(256),
    description: z.string().max(4000).optional(),
    public: z.boolean().optional().default(false)
  });
  app.post('/v1/agents/:did/knowledge/graphs', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const parse = GraphSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;

      const graphId = genId('kg');
      await pool.query(
        `INSERT INTO knowledge_graphs (graph_id, owner_did, name, description, public)
         VALUES ($1,$2,$3,$4,$5)`,
        [graphId, did, d.name, d.description || null, d.public]
      );
      await auditChain.append({
        event_type: 'knowledge.graph_created',
        graph_id: graphId, owner_did: did, name: d.name,
        timestamp: new Date().toISOString()
      });
      return res.status(201).json({
        graph_id: graphId, owner_did: did, name: d.name,
        description: d.description, public: d.public
      });
    } catch (e) {
      console.error('[knowledge.graph.create]', e);
      return res.status(500).json({ error: 'create_failed', message: e.message });
    }
  });

  // GET /v1/agents/:did/knowledge/graphs
  app.get('/v1/agents/:did/knowledge/graphs', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(
      `SELECT g.graph_id, g.name, g.description, g.public, g.created_at, g.updated_at,
              (SELECT COUNT(*) FROM knowledge_nodes n WHERE n.graph_id = g.graph_id) AS node_count,
              (SELECT COUNT(*) FROM knowledge_edges e WHERE e.graph_id = g.graph_id) AS edge_count,
              (SELECT COUNT(*) FROM knowledge_pages p WHERE p.graph_id = g.graph_id) AS page_count
       FROM knowledge_graphs g
       WHERE g.owner_did = $1
       ORDER BY g.updated_at DESC`,
      [did]
    ).catch(() => ({ rows: [] }));
    return res.json({ graphs: r.rows, count: r.rows.length });
  });

  // POST /v1/knowledge/graphs/:id/nodes
  const NodeSchema = z.object({
    type: z.enum(NODE_TYPES),
    label: z.string().min(1).max(512),
    properties: z.record(z.any()).optional(),
    embeddings: z.array(z.number()).length(1536).optional(),
    agent_did: z.string()
  });
  app.post('/v1/knowledge/graphs/:id/nodes', express.json({ limit: '5mb' }), async (req, res) => {
    try {
      const parse = NodeSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;
      const auth = await verifyAgentAuth(req, d.agent_did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const owner = await assertOwnerOrPublic(pool, req.params.id, d.agent_did, true);
      if (!owner.ok) return res.status(owner.reason === 'not_found' ? 404 : 403).json({ error: owner.reason });

      const nodeId = genId('node');
      const embStr = d.embeddings ? JSON.stringify(d.embeddings) : null;
      await pool.query(
        `INSERT INTO knowledge_nodes (node_id, graph_id, type, label, properties, embeddings)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6)`,
        [nodeId, req.params.id, d.type, d.label,
         d.properties ? JSON.stringify(d.properties) : null, embStr]
      );
      await pool.query(
        `UPDATE knowledge_graphs SET updated_at = NOW() WHERE graph_id = $1`,
        [req.params.id]
      ).catch(() => {});
      await auditChain.append({
        event_type: 'knowledge.node_created',
        node_id: nodeId, graph_id: req.params.id, type: d.type, label: d.label,
        timestamp: new Date().toISOString()
      });
      return res.status(201).json({
        node_id: nodeId, graph_id: req.params.id, type: d.type, label: d.label
      });
    } catch (e) {
      console.error('[knowledge.node.create]', e);
      return res.status(500).json({ error: 'node_create_failed', message: e.message });
    }
  });

  // POST /v1/knowledge/graphs/:id/edges
  const EdgeSchema = z.object({
    from_node: z.string(),
    to_node: z.string(),
    relation: z.string().min(1).max(128),
    weight: z.number().optional().default(1.0),
    properties: z.record(z.any()).optional(),
    agent_did: z.string()
  });
  app.post('/v1/knowledge/graphs/:id/edges', express.json(), async (req, res) => {
    try {
      const parse = EdgeSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;
      const auth = await verifyAgentAuth(req, d.agent_did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const owner = await assertOwnerOrPublic(pool, req.params.id, d.agent_did, true);
      if (!owner.ok) return res.status(owner.reason === 'not_found' ? 404 : 403).json({ error: owner.reason });

      const edgeId = genId('edge');
      await pool.query(
        `INSERT INTO knowledge_edges (edge_id, graph_id, from_node, to_node, relation, weight, properties)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
        [edgeId, req.params.id, d.from_node, d.to_node, d.relation, d.weight,
         d.properties ? JSON.stringify(d.properties) : null]
      );
      await auditChain.append({
        event_type: 'knowledge.edge_created',
        edge_id: edgeId, graph_id: req.params.id, from: d.from_node, to: d.to_node,
        relation: d.relation, timestamp: new Date().toISOString()
      });
      return res.status(201).json({
        edge_id: edgeId, graph_id: req.params.id,
        from_node: d.from_node, to_node: d.to_node,
        relation: d.relation, weight: d.weight
      });
    } catch (e) {
      console.error('[knowledge.edge.create]', e);
      return res.status(500).json({ error: 'edge_create_failed', message: e.message });
    }
  });

  // POST /v1/knowledge/graphs/:id/query — simple Cypher-like traversal
  // { start_node?, label?, type?, relation?, depth?, direction?: in/out/both, limit? }
  const QuerySchema = z.object({
    agent_did: z.string(),
    start_node: z.string().optional(),
    label: z.string().optional(),
    type: z.string().optional(),
    relation: z.string().optional(),
    depth: z.number().int().min(0).max(5).default(1),
    direction: z.enum(['in', 'out', 'both']).default('both'),
    limit: z.number().int().positive().max(500).default(100)
  });
  app.post('/v1/knowledge/graphs/:id/query', express.json(), async (req, res) => {
    try {
      const parse = QuerySchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;
      const auth = await verifyAgentAuth(req, d.agent_did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const ok = await assertOwnerOrPublic(pool, req.params.id, d.agent_did, false);
      if (!ok.ok) return res.status(ok.reason === 'not_found' ? 404 : 403).json({ error: ok.reason });

      // Find seed nodes
      const seedParams = [req.params.id];
      const conds = ['graph_id = $1'];
      if (d.start_node) { seedParams.push(d.start_node); conds.push(`node_id = $${seedParams.length}`); }
      if (d.label) { seedParams.push(`%${d.label}%`); conds.push(`label ILIKE $${seedParams.length}`); }
      if (d.type) { seedParams.push(d.type); conds.push(`type = $${seedParams.length}`); }
      seedParams.push(d.limit);
      const seedR = await pool.query(
        `SELECT node_id, type, label, properties
         FROM knowledge_nodes WHERE ${conds.join(' AND ')}
         LIMIT $${seedParams.length}`,
        seedParams
      ).catch(() => ({ rows: [] }));

      const visited = new Set(seedR.rows.map(n => n.node_id));
      const allNodes = [...seedR.rows];
      const allEdges = [];

      // BFS by depth
      let frontier = seedR.rows.map(n => n.node_id);
      for (let i = 0; i < d.depth && frontier.length > 0; i++) {
        const edgeParams = [req.params.id, frontier];
        let dirCond = `(from_node = ANY($2) OR to_node = ANY($2))`;
        if (d.direction === 'out') dirCond = `from_node = ANY($2)`;
        if (d.direction === 'in') dirCond = `to_node = ANY($2)`;
        let relCond = '';
        if (d.relation) { edgeParams.push(d.relation); relCond = ` AND relation = $${edgeParams.length}`; }
        edgeParams.push(d.limit);
        const edgeR = await pool.query(
          `SELECT edge_id, from_node, to_node, relation, weight, properties
           FROM knowledge_edges WHERE graph_id = $1 AND ${dirCond}${relCond}
           LIMIT $${edgeParams.length}`,
          edgeParams
        ).catch(() => ({ rows: [] }));

        allEdges.push(...edgeR.rows);
        const nextIds = new Set();
        for (const e of edgeR.rows) {
          if (!visited.has(e.from_node)) nextIds.add(e.from_node);
          if (!visited.has(e.to_node)) nextIds.add(e.to_node);
        }
        if (nextIds.size === 0) break;
        const nextR = await pool.query(
          `SELECT node_id, type, label, properties FROM knowledge_nodes
           WHERE graph_id = $1 AND node_id = ANY($2) LIMIT $3`,
          [req.params.id, Array.from(nextIds), d.limit]
        ).catch(() => ({ rows: [] }));
        for (const n of nextR.rows) {
          if (!visited.has(n.node_id)) {
            visited.add(n.node_id);
            allNodes.push(n);
          }
        }
        frontier = nextR.rows.map(n => n.node_id);
      }

      return res.json({
        graph_id: req.params.id, query: d,
        nodes: allNodes, edges: allEdges,
        counts: { nodes: allNodes.length, edges: allEdges.length }
      });
    } catch (e) {
      console.error('[knowledge.query]', e);
      return res.status(500).json({ error: 'query_failed', message: e.message });
    }
  });

  // POST /v1/knowledge/graphs/:id/pages
  const PageSchema = z.object({
    title: z.string().min(1).max(256),
    slug: z.string().regex(/^[a-z0-9-]+$/).max(100).optional(),
    body: z.string().min(1).max(1_000_000),
    agent_did: z.string()
  });
  app.post('/v1/knowledge/graphs/:id/pages', express.json({ limit: '5mb' }), async (req, res) => {
    try {
      const parse = PageSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;
      const auth = await verifyAgentAuth(req, d.agent_did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const owner = await assertOwnerOrPublic(pool, req.params.id, d.agent_did, true);
      if (!owner.ok) return res.status(owner.reason === 'not_found' ? 404 : 403).json({ error: owner.reason });

      const slug = d.slug || slugify(d.title);
      const linksTo = extractWikiLinks(d.body);
      const pageId = genId('page');

      const r = await pool.query(
        `INSERT INTO knowledge_pages (page_id, graph_id, title, slug, body, links_to, author_did, version)
         VALUES ($1,$2,$3,$4,$5,$6,$7,1)
         ON CONFLICT (graph_id, slug) DO UPDATE
           SET title = EXCLUDED.title,
               body = EXCLUDED.body,
               links_to = EXCLUDED.links_to,
               version = knowledge_pages.version + 1,
               updated_at = NOW()
         RETURNING page_id, version`,
        [pageId, req.params.id, d.title, slug, d.body, linksTo, d.agent_did]
      ).catch(() => ({ rows: [] }));

      await auditChain.append({
        event_type: 'knowledge.page_saved',
        page_id: r.rows[0]?.page_id || pageId, graph_id: req.params.id,
        slug, version: r.rows[0]?.version || 1,
        timestamp: new Date().toISOString()
      });

      return res.status(201).json({
        page_id: r.rows[0]?.page_id || pageId,
        graph_id: req.params.id, title: d.title, slug,
        version: r.rows[0]?.version || 1, links_to: linksTo
      });
    } catch (e) {
      console.error('[knowledge.page.create]', e);
      return res.status(500).json({ error: 'page_create_failed', message: e.message });
    }
  });

  // GET /v1/knowledge/graphs/:id/pages/:slug
  app.get('/v1/knowledge/graphs/:id/pages/:slug', async (req, res) => {
    const r = await pool.query(
      `SELECT p.*, g.owner_did, g.public
       FROM knowledge_pages p
       JOIN knowledge_graphs g ON g.graph_id = p.graph_id
       WHERE p.graph_id = $1 AND p.slug = $2`,
      [req.params.id, req.params.slug]
    ).catch(() => ({ rows: [] }));
    if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
    const row = r.rows[0];
    if (!row.public) {
      const agentDid = req.headers['x-agent-did'];
      if (!agentDid || agentDid !== row.owner_did) {
        return res.status(403).json({ error: 'forbidden' });
      }
    }
    delete row.owner_did;
    return res.json(row);
  });
}

module.exports = {
  migrate,
  registerKnowledgeRoutes,
  extractWikiLinks,
  slugify,
  NODE_TYPES
};
