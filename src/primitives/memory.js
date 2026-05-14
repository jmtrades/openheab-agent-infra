// ============================================================================
// OpenHeab Memory — KV + episodic + pgvector embeddings, sharing, snapshots
// Uses OpenAI text-embedding-3-small with a deterministic stdlib fallback for
// tests. Embeddings dimension: 1536.
// ============================================================================
const cryptoLib = require('crypto');
const express = require('express');
const { z } = require('zod');

const EMBED_DIM = 1536;
const EMBED_MODEL = 'text-embedding-3-small';

// ----------------------------------------------------------------------------
// Migration
// ----------------------------------------------------------------------------
async function migrate(pool) {
  // pgvector is optional — try to enable, then fall back to JSON if missing.
  let pgvectorOk = false;
  try {
    await pool.query(`CREATE EXTENSION IF NOT EXISTS vector`);
    pgvectorOk = true;
  } catch {
    pgvectorOk = false;
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS memory_kv (
      agent_did         TEXT NOT NULL,
      namespace         TEXT NOT NULL,
      key               TEXT NOT NULL,
      value             JSONB NOT NULL,
      value_size_bytes  INTEGER NOT NULL DEFAULT 0,
      ttl_seconds       INTEGER,
      expires_at        TIMESTAMPTZ,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (agent_did, namespace, key)
    );
    CREATE INDEX IF NOT EXISTS idx_memory_kv_agent_ns ON memory_kv (agent_did, namespace);
    CREATE INDEX IF NOT EXISTS idx_memory_kv_expires ON memory_kv (expires_at) WHERE expires_at IS NOT NULL;

    CREATE TABLE IF NOT EXISTS memory_episodes (
      episode_id        TEXT PRIMARY KEY,
      agent_did         TEXT NOT NULL,
      namespace         TEXT NOT NULL DEFAULT 'default',
      event_type        TEXT NOT NULL,
      content           JSONB NOT NULL,
      content_hash      TEXT,
      tags              JSONB,
      related_episode   TEXT,
      source            TEXT,
      audit_chain_entry TEXT,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_episodes_agent ON memory_episodes (agent_did, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_episodes_type ON memory_episodes (agent_did, event_type);
  `);

  if (pgvectorOk) {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS memory_embeddings (
        embedding_id     TEXT PRIMARY KEY,
        agent_did        TEXT NOT NULL,
        namespace        TEXT NOT NULL DEFAULT 'default',
        content          TEXT NOT NULL,
        embedding        vector(${EMBED_DIM}),
        embedding_model  TEXT NOT NULL DEFAULT '${EMBED_MODEL}',
        metadata         JSONB,
        content_hash     TEXT,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_embeddings_agent ON memory_embeddings (agent_did, namespace);
    `).catch(() => {});
  } else {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS memory_embeddings (
        embedding_id     TEXT PRIMARY KEY,
        agent_did        TEXT NOT NULL,
        namespace        TEXT NOT NULL DEFAULT 'default',
        content          TEXT NOT NULL,
        embedding        JSONB,
        embedding_model  TEXT NOT NULL DEFAULT '${EMBED_MODEL}',
        metadata         JSONB,
        content_hash     TEXT,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_embeddings_agent ON memory_embeddings (agent_did, namespace);
    `);
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS memory_shares (
      grant_id      TEXT PRIMARY KEY,
      owner_did     TEXT NOT NULL,
      grantee_did   TEXT NOT NULL,
      namespace     TEXT NOT NULL,
      permission    TEXT NOT NULL DEFAULT 'read',
      memory_types  JSONB NOT NULL DEFAULT '["kv","episodes","embeddings"]'::jsonb,
      expires_at    TIMESTAMPTZ,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      revoked_at    TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_shares_owner ON memory_shares (owner_did);
    CREATE INDEX IF NOT EXISTS idx_shares_grantee ON memory_shares (grantee_did);

    CREATE TABLE IF NOT EXISTS memory_snapshots (
      snapshot_id   TEXT PRIMARY KEY,
      agent_did     TEXT NOT NULL,
      namespace     TEXT,
      payload       JSONB NOT NULL,
      kv_count      INTEGER NOT NULL DEFAULT 0,
      episode_count INTEGER NOT NULL DEFAULT 0,
      embed_count   INTEGER NOT NULL DEFAULT 0,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      note          TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_snapshots_agent ON memory_snapshots (agent_did, created_at DESC);

    CREATE TABLE IF NOT EXISTS memory_policies (
      agent_did             TEXT PRIMARY KEY,
      max_kv_bytes          BIGINT NOT NULL DEFAULT 10485760,
      max_episodes          INTEGER NOT NULL DEFAULT 100000,
      max_embeddings        INTEGER NOT NULL DEFAULT 100000,
      default_ttl_seconds   INTEGER,
      auto_episode_capture  BOOLEAN NOT NULL DEFAULT FALSE,
      updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

// ----------------------------------------------------------------------------
// Embedding helpers — OpenAI with deterministic stdlib fallback
// ----------------------------------------------------------------------------
function fallbackEmbed(text) {
  // Deterministic pseudo-embedding for tests / offline mode.
  const v = new Array(EMBED_DIM).fill(0);
  const tokens = String(text || '').toLowerCase().split(/\s+/).filter(Boolean);
  for (const tok of tokens) {
    const h = cryptoLib.createHash('sha256').update(tok).digest();
    for (let i = 0; i < h.length; i++) {
      v[(i * 11) % EMBED_DIM] += (h[i] / 255) - 0.5;
    }
  }
  // L2 normalise
  let norm = 0;
  for (let i = 0; i < EMBED_DIM; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < EMBED_DIM; i++) v[i] /= norm;
  return v;
}

async function getEmbedding(text) {
  if (!process.env.OPENAI_API_KEY) return fallbackEmbed(text);
  try {
    const resp = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ model: EMBED_MODEL, input: text })
    });
    if (!resp.ok) throw new Error(`openai_${resp.status}`);
    const j = await resp.json();
    return j.data[0].embedding;
  } catch (e) {
    console.warn('[memory.embed] fallback:', e.message);
    return fallbackEmbed(text);
  }
}

function pgVectorLiteral(arr) { return `[${arr.map(Number).join(',')}]`; }

function cosineSimilarity(a, b) {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

// ----------------------------------------------------------------------------
// Policy / quota helpers
// ----------------------------------------------------------------------------
async function getPolicy(pool, did) {
  const r = await pool.query(`SELECT * FROM memory_policies WHERE agent_did=$1`, [did])
    .catch(() => ({ rows: [] }));
  if (r.rows[0]) return r.rows[0];
  return {
    agent_did: did,
    max_kv_bytes: 10 * 1024 * 1024,
    max_episodes: 100000,
    max_embeddings: 100000,
    default_ttl_seconds: null,
    auto_episode_capture: false
  };
}

// ----------------------------------------------------------------------------
// Idempotency helper
// ----------------------------------------------------------------------------
async function checkIdempotency(pool, agentDid, key, scope) {
  if (!key) return null;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS memory_idempotency (
      agent_did TEXT NOT NULL,
      scope TEXT NOT NULL,
      idem_key TEXT NOT NULL,
      response JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (agent_did, scope, idem_key)
    )`).catch(() => {});
  const r = await pool.query(
    `SELECT response FROM memory_idempotency WHERE agent_did=$1 AND scope=$2 AND idem_key=$3`,
    [agentDid, scope, key]
  ).catch(() => ({ rows: [] }));
  return r.rows[0]?.response || null;
}

async function recordIdempotency(pool, agentDid, key, scope, response) {
  if (!key) return;
  await pool.query(
    `INSERT INTO memory_idempotency (agent_did, scope, idem_key, response)
     VALUES ($1,$2,$3,$4::jsonb) ON CONFLICT DO NOTHING`,
    [agentDid, scope, key, JSON.stringify(response)]
  ).catch(() => {});
}

// ----------------------------------------------------------------------------
// Routes
// ----------------------------------------------------------------------------
function registerMemoryRoutes(app, pool, verifyAgentAuth, auditChain) {

  // ---- KV ------------------------------------------------------------------
  const KvPutSchema = z.object({
    namespace: z.string().min(1).max(128).default('default'),
    value: z.any(),
    ttl_seconds: z.number().int().positive().max(60 * 60 * 24 * 365).optional()
  });

  app.put('/v1/agents/:did/memory/kv/:key', express.json({ limit: '2mb' }), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const parse = KvPutSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });

      const idemKey = req.headers['x-idempotency-key'];
      const cached = await checkIdempotency(pool, did, idemKey, 'kv-put');
      if (cached) return res.json(cached);

      const valueStr = JSON.stringify(parse.data.value);
      const sizeBytes = Buffer.byteLength(valueStr, 'utf8');
      const policy = await getPolicy(pool, did);

      // Quota check
      const totalR = await pool.query(
        `SELECT COALESCE(SUM(value_size_bytes), 0) AS total FROM memory_kv WHERE agent_did=$1`,
        [did]
      ).catch(() => ({ rows: [{ total: 0 }] }));
      if (parseInt(totalR.rows[0].total) + sizeBytes > policy.max_kv_bytes) {
        return res.status(413).json({ error: 'kv_quota_exceeded', limit_bytes: policy.max_kv_bytes });
      }

      const ttl = parse.data.ttl_seconds || policy.default_ttl_seconds || null;
      const expiresAt = ttl ? new Date(Date.now() + ttl * 1000) : null;

      await pool.query(
        `INSERT INTO memory_kv (agent_did, namespace, key, value, value_size_bytes, ttl_seconds, expires_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, NOW(), NOW())
         ON CONFLICT (agent_did, namespace, key) DO UPDATE SET
           value = $4::jsonb,
           value_size_bytes = $5,
           ttl_seconds = $6,
           expires_at = $7,
           updated_at = NOW()`,
        [did, parse.data.namespace, req.params.key, valueStr, sizeBytes, ttl, expiresAt]
      );

      await auditChain.append({
        event_type: 'memory.kv_set',
        agent_did: did, namespace: parse.data.namespace, key: req.params.key,
        size_bytes: sizeBytes,
        timestamp: new Date().toISOString()
      });

      const response = {
        agent_did: did, namespace: parse.data.namespace, key: req.params.key,
        size_bytes: sizeBytes, expires_at: expiresAt?.toISOString() || null
      };
      await recordIdempotency(pool, did, idemKey, 'kv-put', response);
      return res.json(response);
    } catch (e) {
      console.error('[memory.kv.put]', e);
      return res.status(500).json({ error: 'kv_put_failed', message: e.message });
    }
  });

  app.get('/v1/agents/:did/memory/kv/:key', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const namespace = req.query.namespace || 'default';
    const r = await pool.query(
      `SELECT value, value_size_bytes, ttl_seconds, expires_at, created_at, updated_at
       FROM memory_kv WHERE agent_did=$1 AND namespace=$2 AND key=$3
         AND (expires_at IS NULL OR expires_at > NOW())`,
      [did, namespace, req.params.key]
    ).catch(() => ({ rows: [] }));
    if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
    return res.json({ key: req.params.key, namespace, ...r.rows[0] });
  });

  app.delete('/v1/agents/:did/memory/kv/:key', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const namespace = req.query.namespace || 'default';
    const r = await pool.query(
      `DELETE FROM memory_kv WHERE agent_did=$1 AND namespace=$2 AND key=$3
       RETURNING key`, [did, namespace, req.params.key]
    ).catch(() => ({ rows: [] }));
    if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
    await auditChain.append({
      event_type: 'memory.kv_deleted',
      agent_did: did, namespace, key: req.params.key,
      timestamp: new Date().toISOString()
    });
    return res.json({ deleted: true });
  });

  app.get('/v1/agents/:did/memory/kv', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const namespace = req.query.namespace || 'default';
    const limit = Math.min(parseInt(req.query.limit) || 100, 1000);
    const r = await pool.query(
      `SELECT key, value, value_size_bytes, ttl_seconds, expires_at, created_at, updated_at
       FROM memory_kv WHERE agent_did=$1 AND namespace=$2
         AND (expires_at IS NULL OR expires_at > NOW())
       ORDER BY updated_at DESC LIMIT $3`,
      [did, namespace, limit]
    ).catch(() => ({ rows: [] }));
    return res.json({ namespace, entries: r.rows, count: r.rows.length });
  });

  // ---- Episodes ------------------------------------------------------------
  const EpisodeSchema = z.object({
    namespace: z.string().min(1).max(128).default('default'),
    event_type: z.string().min(1).max(128),
    content: z.any(),
    tags: z.array(z.string()).max(64).optional(),
    related_episode: z.string().optional(),
    source: z.string().optional()
  });

  app.post('/v1/agents/:did/memory/episodes', express.json({ limit: '2mb' }), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const parse = EpisodeSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });

      const idemKey = req.headers['x-idempotency-key'];
      const cached = await checkIdempotency(pool, did, idemKey, 'episode-create');
      if (cached) return res.status(201).json(cached);

      const episodeId = 'ep_' + cryptoLib.randomBytes(16).toString('hex');
      const contentStr = JSON.stringify(parse.data.content);
      const contentHash = cryptoLib.createHash('sha256').update(contentStr).digest('hex');

      const chainEntry = await auditChain.append({
        event_type: 'memory.episode_created',
        agent_did: did, episode_id: episodeId,
        episode_type: parse.data.event_type, content_hash: contentHash,
        timestamp: new Date().toISOString()
      });

      await pool.query(
        `INSERT INTO memory_episodes
         (episode_id, agent_did, namespace, event_type, content, content_hash, tags,
          related_episode, source, audit_chain_entry)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7::jsonb,$8,$9,$10)`,
        [episodeId, did, parse.data.namespace, parse.data.event_type,
         contentStr, contentHash,
         parse.data.tags ? JSON.stringify(parse.data.tags) : null,
         parse.data.related_episode || null, parse.data.source || null,
         chainEntry.hash]
      );

      const response = {
        episode_id: episodeId, agent_did: did,
        namespace: parse.data.namespace, event_type: parse.data.event_type,
        content_hash: contentHash, audit_chain_entry: chainEntry.hash
      };
      await recordIdempotency(pool, did, idemKey, 'episode-create', response);
      return res.status(201).json(response);
    } catch (e) {
      console.error('[memory.episode.create]', e);
      return res.status(500).json({ error: 'episode_create_failed', message: e.message });
    }
  });

  app.get('/v1/agents/:did/memory/episodes', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });

    const namespace = req.query.namespace || null;
    const eventType = req.query.event_type || null;
    const limit = Math.min(parseInt(req.query.limit) || 50, 500);

    const params = [did, limit];
    let where = `agent_did=$1`;
    if (namespace) { params.push(namespace); where += ` AND namespace=$${params.length}`; }
    if (eventType) { params.push(eventType); where += ` AND event_type=$${params.length}`; }

    const r = await pool.query(
      `SELECT episode_id, agent_did, namespace, event_type, content, tags,
              related_episode, source, audit_chain_entry, created_at
       FROM memory_episodes WHERE ${where} ORDER BY created_at DESC LIMIT $2`,
      params
    ).catch(() => ({ rows: [] }));
    return res.json({ episodes: r.rows, count: r.rows.length });
  });

  // ---- Embeddings ----------------------------------------------------------
  const EmbedSchema = z.object({
    namespace: z.string().min(1).max(128).default('default'),
    content: z.string().min(1).max(20000),
    metadata: z.any().optional()
  });

  app.post('/v1/agents/:did/memory/embeddings', express.json({ limit: '500kb' }), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const parse = EmbedSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });

      const idemKey = req.headers['x-idempotency-key'];
      const cached = await checkIdempotency(pool, did, idemKey, 'embed-create');
      if (cached) return res.status(201).json(cached);

      const vec = await getEmbedding(parse.data.content);
      const embeddingId = 'emb_' + cryptoLib.randomBytes(16).toString('hex');
      const contentHash = cryptoLib.createHash('sha256').update(parse.data.content).digest('hex');

      // Detect if embedding column is pgvector or jsonb
      const colR = await pool.query(`
        SELECT data_type, udt_name FROM information_schema.columns
        WHERE table_name='memory_embeddings' AND column_name='embedding'`)
        .catch(() => ({ rows: [] }));
      const isPgVector = colR.rows[0] && colR.rows[0].udt_name === 'vector';

      if (isPgVector) {
        await pool.query(
          `INSERT INTO memory_embeddings
           (embedding_id, agent_did, namespace, content, embedding, embedding_model,
            metadata, content_hash)
           VALUES ($1, $2, $3, $4, $5::vector, $6, $7::jsonb, $8)`,
          [embeddingId, did, parse.data.namespace, parse.data.content, pgVectorLiteral(vec),
           EMBED_MODEL,
           parse.data.metadata ? JSON.stringify(parse.data.metadata) : null,
           contentHash]
        );
      } else {
        await pool.query(
          `INSERT INTO memory_embeddings
           (embedding_id, agent_did, namespace, content, embedding, embedding_model,
            metadata, content_hash)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7::jsonb, $8)`,
          [embeddingId, did, parse.data.namespace, parse.data.content, JSON.stringify(vec),
           EMBED_MODEL,
           parse.data.metadata ? JSON.stringify(parse.data.metadata) : null,
           contentHash]
        );
      }

      await auditChain.append({
        event_type: 'memory.embedding_created',
        agent_did: did, embedding_id: embeddingId, content_hash: contentHash,
        timestamp: new Date().toISOString()
      });

      const response = {
        embedding_id: embeddingId, agent_did: did,
        namespace: parse.data.namespace, content_hash: contentHash,
        embedding_model: EMBED_MODEL, dimension: EMBED_DIM
      };
      await recordIdempotency(pool, did, idemKey, 'embed-create', response);
      return res.status(201).json(response);
    } catch (e) {
      console.error('[memory.embed.create]', e);
      return res.status(500).json({ error: 'embed_create_failed', message: e.message });
    }
  });

  const SearchSchema = z.object({
    query: z.string().min(1).max(20000),
    namespace: z.string().optional(),
    top_k: z.number().int().positive().max(100).default(10)
  });

  app.post('/v1/agents/:did/memory/embeddings/search', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const parse = SearchSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });

      const vec = await getEmbedding(parse.data.query);
      const colR = await pool.query(`
        SELECT udt_name FROM information_schema.columns
        WHERE table_name='memory_embeddings' AND column_name='embedding'`)
        .catch(() => ({ rows: [] }));
      const isPgVector = colR.rows[0] && colR.rows[0].udt_name === 'vector';

      const params = [did, parse.data.top_k];
      let where = `agent_did=$1`;
      if (parse.data.namespace) {
        params.push(parse.data.namespace);
        where += ` AND namespace=$${params.length}`;
      }

      let results;
      if (isPgVector) {
        params.push(pgVectorLiteral(vec));
        const queryParamIdx = params.length;
        const r = await pool.query(
          `SELECT embedding_id, namespace, content, metadata, content_hash,
                  1 - (embedding <=> $${queryParamIdx}::vector) AS similarity
           FROM memory_embeddings WHERE ${where}
           ORDER BY embedding <=> $${queryParamIdx}::vector ASC LIMIT $2`,
          params
        ).catch(() => ({ rows: [] }));
        results = r.rows;
      } else {
        const r = await pool.query(
          `SELECT embedding_id, namespace, content, metadata, content_hash, embedding
           FROM memory_embeddings WHERE ${where}`,
          params.slice(0, params.length === 3 ? 3 : 2)
        ).catch(() => ({ rows: [] }));
        const scored = r.rows.map(row => {
          const e = typeof row.embedding === 'string' ? JSON.parse(row.embedding) : row.embedding;
          return { ...row, similarity: cosineSimilarity(vec, e || []), embedding: undefined };
        });
        scored.sort((a, b) => b.similarity - a.similarity);
        results = scored.slice(0, parse.data.top_k);
      }

      return res.json({ query: parse.data.query, top_k: parse.data.top_k, results });
    } catch (e) {
      console.error('[memory.embed.search]', e);
      return res.status(500).json({ error: 'search_failed', message: e.message });
    }
  });

  app.delete('/v1/agents/:did/memory/embeddings/:id', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });

    const r = await pool.query(
      `DELETE FROM memory_embeddings WHERE agent_did=$1 AND embedding_id=$2
       RETURNING embedding_id`,
      [did, req.params.id]
    ).catch(() => ({ rows: [] }));
    if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
    await auditChain.append({
      event_type: 'memory.embedding_deleted',
      agent_did: did, embedding_id: req.params.id,
      timestamp: new Date().toISOString()
    });
    return res.json({ deleted: true });
  });

  // ---- Shares --------------------------------------------------------------
  const ShareSchema = z.object({
    grantee_did: z.string(),
    namespace: z.string().min(1).max(128),
    permission: z.enum(['read', 'write']).default('read'),
    memory_types: z.array(z.enum(['kv', 'episodes', 'embeddings'])).optional(),
    expires_in_seconds: z.number().int().positive().max(60 * 60 * 24 * 365).optional()
  });

  app.post('/v1/agents/:did/memory/shares', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const parse = ShareSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;

      const grantId = 'gr_' + cryptoLib.randomBytes(16).toString('hex');
      const expiresAt = d.expires_in_seconds
        ? new Date(Date.now() + d.expires_in_seconds * 1000) : null;

      await pool.query(
        `INSERT INTO memory_shares
         (grant_id, owner_did, grantee_did, namespace, permission, memory_types, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
        [grantId, did, d.grantee_did, d.namespace, d.permission,
         JSON.stringify(d.memory_types || ['kv', 'episodes', 'embeddings']),
         expiresAt]
      );

      await auditChain.append({
        event_type: 'memory.share_created',
        grant_id: grantId, owner_did: did, grantee_did: d.grantee_did,
        namespace: d.namespace, permission: d.permission,
        timestamp: new Date().toISOString()
      });

      return res.status(201).json({
        grant_id: grantId, owner_did: did, grantee_did: d.grantee_did,
        namespace: d.namespace, permission: d.permission,
        memory_types: d.memory_types || ['kv', 'episodes', 'embeddings'],
        expires_at: expiresAt?.toISOString() || null
      });
    } catch (e) {
      console.error('[memory.share.create]', e);
      return res.status(500).json({ error: 'share_create_failed', message: e.message });
    }
  });

  app.delete('/v1/agents/:did/memory/shares/:grantId', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(
      `UPDATE memory_shares SET revoked_at=NOW()
       WHERE grant_id=$1 AND owner_did=$2 AND revoked_at IS NULL
       RETURNING grant_id`,
      [req.params.grantId, did]
    ).catch(() => ({ rows: [] }));
    if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
    await auditChain.append({
      event_type: 'memory.share_revoked',
      grant_id: req.params.grantId, owner_did: did,
      timestamp: new Date().toISOString()
    });
    return res.json({ revoked: true });
  });

  app.get('/v1/agents/:did/memory/shares', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(
      `SELECT grant_id, owner_did, grantee_did, namespace, permission, memory_types,
              expires_at, created_at, revoked_at
       FROM memory_shares WHERE owner_did=$1 OR grantee_did=$1
       ORDER BY created_at DESC LIMIT 200`,
      [did]
    ).catch(() => ({ rows: [] }));
    return res.json({ shares: r.rows, count: r.rows.length });
  });

  // ---- Snapshots ----------------------------------------------------------
  const SnapshotSchema = z.object({
    namespace: z.string().optional(),
    note: z.string().max(500).optional()
  });

  app.post('/v1/agents/:did/memory/snapshots', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const parse = SnapshotSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });

      const params = [did];
      let nsFilter = '';
      if (parse.data.namespace) { params.push(parse.data.namespace); nsFilter = ` AND namespace=$2`; }

      const kvR = await pool.query(
        `SELECT namespace, key, value, ttl_seconds, expires_at
         FROM memory_kv WHERE agent_did=$1${nsFilter}`, params
      ).catch(() => ({ rows: [] }));
      const epR = await pool.query(
        `SELECT * FROM memory_episodes WHERE agent_did=$1${nsFilter}`, params
      ).catch(() => ({ rows: [] }));
      const emR = await pool.query(
        `SELECT embedding_id, namespace, content, metadata, content_hash, created_at
         FROM memory_embeddings WHERE agent_did=$1${nsFilter}`, params
      ).catch(() => ({ rows: [] }));

      const snapshotId = 'snap_' + cryptoLib.randomBytes(16).toString('hex');
      const payload = { kv: kvR.rows, episodes: epR.rows, embeddings: emR.rows };

      await pool.query(
        `INSERT INTO memory_snapshots
         (snapshot_id, agent_did, namespace, payload, kv_count, episode_count, embed_count, note)
         VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8)`,
        [snapshotId, did, parse.data.namespace || null, JSON.stringify(payload),
         kvR.rows.length, epR.rows.length, emR.rows.length, parse.data.note || null]
      );

      await auditChain.append({
        event_type: 'memory.snapshot_created',
        agent_did: did, snapshot_id: snapshotId,
        kv_count: kvR.rows.length, episode_count: epR.rows.length, embed_count: emR.rows.length,
        timestamp: new Date().toISOString()
      });

      return res.status(201).json({
        snapshot_id: snapshotId, agent_did: did,
        namespace: parse.data.namespace || null,
        kv_count: kvR.rows.length, episode_count: epR.rows.length, embed_count: emR.rows.length
      });
    } catch (e) {
      console.error('[memory.snapshot.create]', e);
      return res.status(500).json({ error: 'snapshot_failed', message: e.message });
    }
  });

  app.get('/v1/agents/:did/memory/snapshots', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(
      `SELECT snapshot_id, agent_did, namespace, kv_count, episode_count, embed_count,
              created_at, note
       FROM memory_snapshots WHERE agent_did=$1 ORDER BY created_at DESC LIMIT 100`,
      [did]
    ).catch(() => ({ rows: [] }));
    return res.json({ snapshots: r.rows, count: r.rows.length });
  });

  app.post('/v1/agents/:did/memory/snapshots/:id/restore', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const r = await pool.query(
        `SELECT payload FROM memory_snapshots WHERE snapshot_id=$1 AND agent_did=$2`,
        [req.params.id, did]
      ).catch(() => ({ rows: [] }));
      if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });

      const payload = typeof r.rows[0].payload === 'string'
        ? JSON.parse(r.rows[0].payload) : r.rows[0].payload;

      let restored = { kv: 0, episodes: 0, embeddings: 0 };

      for (const kv of (payload.kv || [])) {
        await pool.query(
          `INSERT INTO memory_kv (agent_did, namespace, key, value, value_size_bytes, ttl_seconds, expires_at)
           VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7)
           ON CONFLICT (agent_did, namespace, key) DO UPDATE SET
             value=$4::jsonb, value_size_bytes=$5, ttl_seconds=$6, expires_at=$7, updated_at=NOW()`,
          [did, kv.namespace, kv.key, JSON.stringify(kv.value),
           Buffer.byteLength(JSON.stringify(kv.value)), kv.ttl_seconds || null, kv.expires_at || null]
        ).catch(() => {});
        restored.kv++;
      }
      for (const ep of (payload.episodes || [])) {
        await pool.query(
          `INSERT INTO memory_episodes
           (episode_id, agent_did, namespace, event_type, content, content_hash, tags,
            related_episode, source, audit_chain_entry)
           VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7::jsonb,$8,$9,$10)
           ON CONFLICT (episode_id) DO NOTHING`,
          [ep.episode_id, did, ep.namespace, ep.event_type,
           typeof ep.content === 'string' ? ep.content : JSON.stringify(ep.content),
           ep.content_hash,
           ep.tags ? (typeof ep.tags === 'string' ? ep.tags : JSON.stringify(ep.tags)) : null,
           ep.related_episode, ep.source, ep.audit_chain_entry]
        ).catch(() => {});
        restored.episodes++;
      }

      await auditChain.append({
        event_type: 'memory.snapshot_restored',
        agent_did: did, snapshot_id: req.params.id,
        restored,
        timestamp: new Date().toISOString()
      });
      return res.json({ restored, snapshot_id: req.params.id });
    } catch (e) {
      console.error('[memory.snapshot.restore]', e);
      return res.status(500).json({ error: 'restore_failed', message: e.message });
    }
  });

  // ---- Policy --------------------------------------------------------------
  const PolicySchema = z.object({
    max_kv_bytes: z.number().int().positive().optional(),
    max_episodes: z.number().int().positive().optional(),
    max_embeddings: z.number().int().positive().optional(),
    default_ttl_seconds: z.number().int().positive().nullable().optional(),
    auto_episode_capture: z.boolean().optional()
  });

  app.get('/v1/agents/:did/memory/policy', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const p = await getPolicy(pool, did);
    return res.json(p);
  });

  app.put('/v1/agents/:did/memory/policy', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const parse = PolicySchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;

      await pool.query(
        `INSERT INTO memory_policies (agent_did, max_kv_bytes, max_episodes, max_embeddings,
                                      default_ttl_seconds, auto_episode_capture, updated_at)
         VALUES ($1,
                 COALESCE($2, 10485760),
                 COALESCE($3, 100000),
                 COALESCE($4, 100000),
                 $5,
                 COALESCE($6, FALSE),
                 NOW())
         ON CONFLICT (agent_did) DO UPDATE SET
           max_kv_bytes = COALESCE($2, memory_policies.max_kv_bytes),
           max_episodes = COALESCE($3, memory_policies.max_episodes),
           max_embeddings = COALESCE($4, memory_policies.max_embeddings),
           default_ttl_seconds = COALESCE($5, memory_policies.default_ttl_seconds),
           auto_episode_capture = COALESCE($6, memory_policies.auto_episode_capture),
           updated_at = NOW()`,
        [did, d.max_kv_bytes ?? null, d.max_episodes ?? null,
         d.max_embeddings ?? null, d.default_ttl_seconds ?? null,
         d.auto_episode_capture ?? null]
      );

      await auditChain.append({
        event_type: 'memory.policy_updated', agent_did: did, fields: Object.keys(d),
        timestamp: new Date().toISOString()
      });
      const p = await getPolicy(pool, did);
      return res.json(p);
    } catch (e) {
      console.error('[memory.policy.put]', e);
      return res.status(500).json({ error: 'policy_update_failed', message: e.message });
    }
  });
}

// ----------------------------------------------------------------------------
// Cron: expire kv
// ----------------------------------------------------------------------------
async function expireKv(pool) {
  const r = await pool.query(
    `DELETE FROM memory_kv WHERE expires_at IS NOT NULL AND expires_at < NOW()
     RETURNING agent_did`
  ).catch(() => ({ rows: [] }));
  return { expired: r.rows.length };
}

module.exports = {
  migrate,
  registerMemoryRoutes,
  expireKv,
  getEmbedding,
  fallbackEmbed,
  cosineSimilarity,
  EMBED_DIM,
  EMBED_MODEL
};
