// ============================================================================
// API management — agents expose their own APIs to other agents/humans
// (Stripe-like API portal). Issues API keys, tracks usage, throttles.
// ============================================================================
const crypto = require('crypto');
const { z } = require('zod');

async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS agent_apis (
      api_id          TEXT PRIMARY KEY,
      owner_did       TEXT NOT NULL,
      name            TEXT NOT NULL,
      description     TEXT,
      base_url        TEXT NOT NULL,
      version         TEXT NOT NULL DEFAULT 'v1',
      pricing_model   TEXT NOT NULL DEFAULT 'free',
      price_per_call_cents INTEGER,
      free_tier_calls INTEGER NOT NULL DEFAULT 1000,
      rate_limit_per_min INTEGER NOT NULL DEFAULT 60,
      auth_method     TEXT NOT NULL DEFAULT 'api_key',
      openapi_url     TEXT,
      status          TEXT NOT NULL DEFAULT 'active',
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_agent_apis_owner ON agent_apis (owner_did, status);

    CREATE TABLE IF NOT EXISTS api_keys_issued (
      key_id          TEXT PRIMARY KEY,
      api_id          TEXT NOT NULL,
      consumer_did    TEXT,
      consumer_email  TEXT,
      key_hash        TEXT NOT NULL,
      key_prefix      TEXT NOT NULL,
      name            TEXT,
      scopes          TEXT[],
      rate_limit_override INTEGER,
      total_calls     BIGINT NOT NULL DEFAULT 0,
      last_used_at    TIMESTAMPTZ,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      revoked_at      TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_api_keys_api ON api_keys_issued (api_id);
    CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys_issued (key_hash);

    CREATE TABLE IF NOT EXISTS api_usage (
      usage_id        TEXT PRIMARY KEY,
      api_id          TEXT NOT NULL,
      key_id          TEXT NOT NULL,
      endpoint        TEXT,
      method          TEXT,
      status_code     INTEGER,
      latency_ms      INTEGER,
      bytes_in        INTEGER,
      bytes_out       INTEGER,
      cost_cents      INTEGER,
      called_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_api_usage_api_time ON api_usage (api_id, called_at DESC);

    CREATE TABLE IF NOT EXISTS api_documentation (
      doc_id          TEXT PRIMARY KEY,
      api_id          TEXT NOT NULL,
      version         TEXT NOT NULL,
      spec            JSONB NOT NULL,
      published_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

const apiSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2000).optional(),
  base_url: z.string().url(),
  version: z.string().max(20).optional(),
  pricing_model: z.enum(['free', 'pay_per_call', 'subscription', 'metered']).optional(),
  price_per_call_cents: z.number().int().min(0).max(100_000).optional(),
  free_tier_calls: z.number().int().min(0).max(1_000_000).optional(),
  rate_limit_per_min: z.number().int().min(1).max(100_000).optional(),
  auth_method: z.enum(['api_key', 'bearer', 'oauth2', 'mtls', 'none']).optional(),
  openapi_url: z.string().url().optional()
});

async function handleCreate(req, res, pool, verifyAgentAuth, auditChain) {
  const did = req.params.did;
  const auth = await verifyAgentAuth(req, did);
  if (!auth.valid) return res.status(401).json({ error: auth.error });

  let body;
  try { body = apiSchema.parse(req.body); }
  catch (e) { return res.status(400).json({ error: 'invalid_request', details: e.errors }); }

  const apiId = 'api_' + crypto.randomBytes(10).toString('hex');
  await pool.query(`
    INSERT INTO agent_apis (api_id, owner_did, name, description, base_url, version,
      pricing_model, price_per_call_cents, free_tier_calls, rate_limit_per_min,
      auth_method, openapi_url)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
  `, [apiId, did, body.name, body.description || null, body.base_url, body.version || 'v1',
      body.pricing_model || 'free', body.price_per_call_cents || null,
      body.free_tier_calls || 1000, body.rate_limit_per_min || 60,
      body.auth_method || 'api_key', body.openapi_url || null]);

  if (auditChain) {
    await auditChain.append({ event_type: 'api.created', owner_did: did, api_id: apiId });
  }
  return res.status(201).json({ api_id: apiId, name: body.name });
}

async function handleList(req, res, pool) {
  const r = await pool.query(`
    SELECT api_id, owner_did, name, description, base_url, pricing_model,
           price_per_call_cents, free_tier_calls, version
    FROM agent_apis WHERE status = 'active' ORDER BY created_at DESC LIMIT 200
  `);
  return res.json({ apis: r.rows });
}

const issueKeySchema = z.object({
  consumer_email: z.string().email().optional(),
  consumer_did: z.string().optional(),
  name: z.string().max(120).optional(),
  scopes: z.array(z.string()).optional(),
  rate_limit_override: z.number().int().positive().optional()
});

async function handleIssueKey(req, res, pool, verifyAgentAuth, auditChain) {
  const apiId = req.params.id;
  const did = req.headers['x-agent-did'];
  if (!did) return res.status(401).json({ error: 'agent_did_required' });

  const api = await pool.query(`SELECT owner_did FROM agent_apis WHERE api_id = $1`, [apiId]);
  if (!api.rows[0]) return res.status(404).json({ error: 'api_not_found' });
  if (api.rows[0].owner_did !== did) return res.status(403).json({ error: 'not_owner' });
  const auth = await verifyAgentAuth(req, did);
  if (!auth.valid) return res.status(401).json({ error: auth.error });

  let body;
  try { body = issueKeySchema.parse(req.body); }
  catch (e) { return res.status(400).json({ error: 'invalid_request', details: e.errors }); }

  const rawKey = 'agtk_' + crypto.randomBytes(24).toString('hex');
  const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
  const keyPrefix = rawKey.slice(0, 12);
  const keyId = 'key_' + crypto.randomBytes(8).toString('hex');

  await pool.query(`
    INSERT INTO api_keys_issued (key_id, api_id, consumer_did, consumer_email,
      key_hash, key_prefix, name, scopes, rate_limit_override)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
  `, [keyId, apiId, body.consumer_did || null, body.consumer_email || null,
      keyHash, keyPrefix, body.name || null,
      body.scopes || null, body.rate_limit_override || null]);

  if (auditChain) {
    await auditChain.append({ event_type: 'api.key_issued', api_id: apiId, key_id: keyId });
  }
  return res.status(201).json({
    key_id: keyId,
    key: rawKey,  // returned ONCE
    note: 'Save this key — cannot be retrieved again'
  });
}

async function handleRevokeKey(req, res, pool, verifyAgentAuth, auditChain) {
  const did = req.headers['x-agent-did'];
  if (!did) return res.status(401).json({ error: 'agent_did_required' });
  const auth = await verifyAgentAuth(req, did);
  if (!auth.valid) return res.status(401).json({ error: auth.error });

  const r = await pool.query(`
    UPDATE api_keys_issued SET revoked_at = NOW()
    WHERE key_id = $1
      AND api_id IN (SELECT api_id FROM agent_apis WHERE owner_did = $2)
      AND revoked_at IS NULL
    RETURNING key_id
  `, [req.params.key_id, did]);
  if (!r.rows[0]) return res.status(404).json({ error: 'not_found_or_already_revoked' });
  if (auditChain) {
    await auditChain.append({ event_type: 'api.key_revoked', key_id: r.rows[0].key_id });
  }
  return res.json({ key_id: r.rows[0].key_id, revoked: true });
}

async function handleUsage(req, res, pool, verifyAgentAuth) {
  const did = req.headers['x-agent-did'];
  if (!did) return res.status(401).json({ error: 'agent_did_required' });
  const auth = await verifyAgentAuth(req, did);
  if (!auth.valid) return res.status(401).json({ error: auth.error });

  const window = req.query.window || '24h';
  const interval = window === '7d' ? '7 days' : window === '30d' ? '30 days' : '1 day';

  const r = await pool.query(`
    SELECT u.endpoint, u.method, COUNT(*)::int AS calls, AVG(u.latency_ms)::int AS avg_latency,
           SUM(u.cost_cents)::bigint AS total_cents
    FROM api_usage u
    JOIN agent_apis a ON a.api_id = u.api_id
    WHERE a.api_id = $1 AND a.owner_did = $2
      AND u.called_at > NOW() - ($3 || '')::interval
    GROUP BY u.endpoint, u.method
    ORDER BY calls DESC LIMIT 100
  `, [req.params.id, did, interval]);
  return res.json({ api_id: req.params.id, window, breakdown: r.rows });
}

async function handleRecordUsage(req, res, pool) {
  // Internal — agent's own API reports usage back
  const body = req.body || {};
  if (!body.api_id || !body.key_id) return res.status(400).json({ error: 'api_id_and_key_id_required' });
  const usageId = 'use_' + crypto.randomBytes(8).toString('hex');
  await pool.query(`
    INSERT INTO api_usage (usage_id, api_id, key_id, endpoint, method,
      status_code, latency_ms, bytes_in, bytes_out, cost_cents)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
  `, [usageId, body.api_id, body.key_id, body.endpoint || null, body.method || null,
      body.status_code || null, body.latency_ms || null, body.bytes_in || null,
      body.bytes_out || null, body.cost_cents || 0]).catch(() => {});
  await pool.query(`
    UPDATE api_keys_issued SET total_calls = total_calls + 1, last_used_at = NOW()
    WHERE key_id = $1
  `, [body.key_id]).catch(() => {});
  return res.json({ usage_id: usageId });
}

function registerApiManagementRoutes(app, pool, verifyAgentAuth, auditChain) {
  app.post('/v1/agents/:did/apis',
    (req, res) => handleCreate(req, res, pool, verifyAgentAuth, auditChain));
  app.get('/v1/apis',
    (req, res) => handleList(req, res, pool));
  app.post('/v1/apis/:id/keys',
    (req, res) => handleIssueKey(req, res, pool, verifyAgentAuth, auditChain));
  app.delete('/v1/apis/keys/:key_id',
    (req, res) => handleRevokeKey(req, res, pool, verifyAgentAuth, auditChain));
  app.get('/v1/apis/:id/usage',
    (req, res) => handleUsage(req, res, pool, verifyAgentAuth));
  app.post('/v1/apis/usage',
    (req, res) => handleRecordUsage(req, res, pool));
}

module.exports = { migrate, registerApiManagementRoutes };
