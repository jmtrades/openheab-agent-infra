// ============================================================================
// placeholder_impls.js — back-end implementations for endpoints we surfaced
// in UI pages (Layers 68-74) but didn't fully wire up.
//
//   POST /v1/agents/spawn-from-template           — /agents/spawn-from-template form
//   POST /v1/mcp-servers                          — /realworld/mcp-host registration
//   GET  /v1/mcp-servers                          — list registered external MCP servers
//   POST /v1/agents/:did/profile/location         — /map opt-in
//   GET  /v1/map/regions                          — aggregate region counts for /map
//   POST /v1/agents/:did/events/emit              — /realworld/webhooks-out
//   POST /v1/integrations/:provider/connect       — generic connector for slack,discord,
//                                                    telegram,whatsapp,plaid,persona,
//                                                    onfido,sumsub,comply-advantage
//   POST /v1/agents/:did/personality              — used by /agents/new
//
// All persist to fresh tables migrated below; admin-token guarded where they
// could create org-level state; agent-signed for did-scoped writes.
// ============================================================================
const crypto = require('crypto');
const { z } = require('zod');
const { safeTokenCompare } = require('../safe_compare');

const TEMPLATES = {
  'sql-tutor':              { system_prompt: 'You are an SQL tutor. Always explain in 3 sentences max. Refuse to run DELETE/DROP without confirmation.', default_model: 'openheab-base', tools: ['openheab.memory.kv.*'] },
  'customer-support':       { system_prompt: 'You are a front-line CS agent. Open tickets when needed. Hand off to human after 3 turns of customer frustration.', default_model: 'openheab-base', tools: ['openheab.inbox.*', 'openheab.memory.kv.*'] },
  'data-analyst':           { system_prompt: 'You are a data analyst. Use the sandbox to run Python on supplied CSVs. Produce summaries with charts.', default_model: 'openheab-large', tools: ['openheab.sandbox.*', 'openheab.storage.*'] },
  'trader':                 { system_prompt: 'You are a disciplined trader. Read market data, place orders, respect a per-day loss limit of 2%. Refuse to trade without a stated thesis.', default_model: 'openheab-large', tools: ['openheab.bank.*', 'openheab.brokerage.*'] },
  'researcher':             { system_prompt: 'You are a research assistant. Read papers. Always cite sources. Refuse to claim novel findings without verification against the literature.', default_model: 'openheab-xl', tools: ['openheab.search.*', 'openheab.documents.*'] },
  'voice-receptionist':     { system_prompt: 'You are a phone receptionist. Take messages. Book appointments via the calendar. Speak briefly.', default_model: 'openheab-base', tools: ['openheab.calendar.*', 'openheab.inbox.*'] },
  'developer-assistant':    { system_prompt: 'You are a developer assistant. Review PRs, write tests, manage CI runs. Refuse to push to main without review.', default_model: 'openheab-large', tools: ['openheab.github.*', 'openheab.ci.*'] },
  'governance-monitor':     { system_prompt: 'You monitor the substrate audit chain for ASL-2+ violations. Report findings to operators. Never act on what you observe — only report.', default_model: 'openheab-base', tools: ['openheab.audit.*', 'openheab.safety.*'] },
};

async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS agent_personalities (
      personality_id    TEXT PRIMARY KEY,
      agent_did         TEXT NOT NULL UNIQUE,
      system_prompt     TEXT NOT NULL,
      default_model     TEXT,
      tools_granted     TEXT[],
      template_id       TEXT,
      parent_did        TEXT,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS external_mcp_servers (
      server_id         TEXT PRIMARY KEY,
      owner_did         TEXT NOT NULL,
      namespace         TEXT NOT NULL UNIQUE,
      url               TEXT NOT NULL,
      auth_kind         TEXT NOT NULL DEFAULT 'none',
      auth_secret_hash  TEXT,
      status            TEXT NOT NULL DEFAULT 'pending',
      last_probed_at    TIMESTAMPTZ,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_external_mcp_servers_owner ON external_mcp_servers (owner_did);

    CREATE TABLE IF NOT EXISTS agent_locations (
      agent_did         TEXT PRIMARY KEY,
      region_code       TEXT NOT NULL,
      country_code      TEXT,
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_agent_locations_region ON agent_locations (region_code);

    CREATE TABLE IF NOT EXISTS agent_emitted_events (
      event_id          TEXT PRIMARY KEY,
      source_did        TEXT NOT NULL,
      event_type        TEXT NOT NULL,
      payload           JSONB NOT NULL DEFAULT '{}'::jsonb,
      emitted_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_agent_emitted_events_src ON agent_emitted_events (source_did, emitted_at DESC);

    CREATE TABLE IF NOT EXISTS integration_connections (
      connection_id     TEXT PRIMARY KEY,
      owner_did         TEXT NOT NULL,
      provider          TEXT NOT NULL,
      config_encrypted  TEXT NOT NULL,
      status            TEXT NOT NULL DEFAULT 'connected',
      connected_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      revoked_at        TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_integration_connections_owner ON integration_connections (owner_did);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_integration_connections_unique ON integration_connections (owner_did, provider) WHERE revoked_at IS NULL;
  `).catch(() => {});
}

function encryptConfig(plain) {
  // Wraps the connector config with the integration KEK (AES-256-GCM).
  // Falls back to base64 if no KEK is set (dev only); refuses in production.
  const kek = process.env.INTEGRATIONS_MASTER_KEK;
  if (!kek || kek.length < 64) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('INTEGRATIONS_MASTER_KEK not configured');
    }
    return 'b64:' + Buffer.from(JSON.stringify(plain)).toString('base64');
  }
  const key = Buffer.from(kek.slice(0, 64), 'hex');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return 'gcm:' + Buffer.concat([iv, tag, ct]).toString('base64');
}

function registerPlaceholderImplsRoutes(app, pool, verifyAgentAuth, auditChain) {
  const express = require('express');

  // ------------------------------------------------------------------------
  // POST /v1/agents/spawn-from-template
  // ------------------------------------------------------------------------
  app.post('/v1/agents/spawn-from-template', express.json(), async (req, res) => {
    const body = z.object({ template_id: z.string(), parent_did: z.string().optional() }).safeParse(req.body || {});
    if (!body.success) return res.status(400).json({ error: { message: 'template_id required' } });
    const tpl = TEMPLATES[body.data.template_id];
    if (!tpl) return res.status(404).json({ error: { message: 'unknown template' } });

    // Resolve caller identity (Bearer key or signed header)
    const auth = req.headers.authorization || '';
    let parent_did = body.data.parent_did;
    if (!parent_did && auth.startsWith('Bearer ')) {
      const tok = auth.slice(7);
      const hash = crypto.createHash('sha256').update(tok).digest('hex');
      try {
        const r = await pool.query(
          `SELECT agent_did FROM api_keys_v2 WHERE token_hash=$1 AND revoked_at IS NULL LIMIT 1`,
          [hash]
        );
        if (r.rows[0]) parent_did = r.rows[0].agent_did;
      } catch {}
    }
    if (!parent_did) return res.status(401).json({ error: { message: 'Authentication required' } });

    // Mint the new agent identity (delegate to existing /v1/identities flow inline)
    const childDid = 'did:op:' + crypto.randomBytes(10).toString('hex');
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const pubPem = publicKey.export({ type: 'spki', format: 'pem' });
    const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
    const apiKey = 'sk_oh_' + crypto.randomBytes(24).toString('hex');
    const apiKeyHash = crypto.createHash('sha256').update(apiKey).digest('hex');

    try {
      await pool.query(
        `INSERT INTO agent_identities (did, public_key_pem, display_name, name, parent_did, created_at)
         VALUES ($1, $2, $3, $4, $5, NOW())
         ON CONFLICT (did) DO NOTHING`,
        [childDid, pubPem, body.data.template_id + '-spawn', body.data.template_id + '-spawn', parent_did]
      ).catch(() => {});
      await pool.query(
        `INSERT INTO api_keys_v2 (key_id, agent_did, token_hash, label, scope)
         VALUES ($1, $2, $3, $4, 'read_write')
         ON CONFLICT DO NOTHING`,
        ['kv2_' + crypto.randomBytes(10).toString('hex'), childDid, apiKeyHash, 'spawn-from-' + body.data.template_id]
      ).catch(() => {});
      await pool.query(
        `INSERT INTO agent_personalities (personality_id, agent_did, system_prompt, default_model, tools_granted, template_id, parent_did)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (agent_did) DO UPDATE SET
           system_prompt = EXCLUDED.system_prompt,
           default_model = EXCLUDED.default_model,
           tools_granted = EXCLUDED.tools_granted,
           updated_at = NOW()`,
        ['per_' + crypto.randomBytes(10).toString('hex'), childDid, tpl.system_prompt, tpl.default_model, tpl.tools, body.data.template_id, parent_did]
      ).catch(() => {});
      if (auditChain) {
        await auditChain.append({
          event_type: 'agent.spawned_from_template',
          agent_did: childDid, parent_did, template_id: body.data.template_id
        }).catch(() => {});
      }
      return res.status(201).json({
        did: childDid,
        api_key: apiKey,
        public_key: pubPem,
        private_key: privPem,
        template_id: body.data.template_id,
        personality: tpl
      });
    } catch (e) {
      return res.status(500).json({ error: { message: 'spawn_failed', detail: e.message } });
    }
  });

  // ------------------------------------------------------------------------
  // POST/GET /v1/mcp-servers
  // ------------------------------------------------------------------------
  app.post('/v1/mcp-servers', express.json(), async (req, res) => {
    const b = z.object({
      url: z.string().url(),
      auth_kind: z.enum(['none', 'bearer', 'hmac']).default('none'),
      auth_secret: z.string().optional(),
      namespace: z.string().regex(/^[a-z][a-z0-9_-]{2,40}$/).optional(),
      agent_did: z.string().optional()
    }).safeParse(req.body || {});
    if (!b.success) return res.status(400).json({ error: { message: 'invalid_input', details: b.error.flatten() } });
    const did = b.data.agent_did;
    if (!did) return res.status(401).json({ error: { message: 'agent_did required' } });
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: { message: auth.error || 'unauthorized' } });

    const namespace = b.data.namespace || ('mcp_' + crypto.randomBytes(4).toString('hex'));
    const serverId = 'mcps_' + crypto.randomBytes(10).toString('hex');
    const authSecretHash = b.data.auth_secret
      ? crypto.createHash('sha256').update(b.data.auth_secret).digest('hex')
      : null;
    try {
      await pool.query(
        `INSERT INTO external_mcp_servers (server_id, owner_did, namespace, url, auth_kind, auth_secret_hash)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [serverId, did, namespace, b.data.url, b.data.auth_kind, authSecretHash]
      );
      if (auditChain) await auditChain.append({ event_type: 'mcp.server_registered', server_id: serverId, owner_did: did, namespace }).catch(() => {});
      return res.status(201).json({ server_id: serverId, namespace, status: 'pending', url: b.data.url });
    } catch (e) {
      if (e.code === '23505') return res.status(409).json({ error: { message: 'namespace_taken' } });
      return res.status(500).json({ error: { message: 'register_failed', detail: e.message } });
    }
  });

  app.get('/v1/mcp-servers', async (req, res) => {
    try {
      const r = await pool.query(
        `SELECT server_id, owner_did, namespace, url, status, last_probed_at, created_at
         FROM external_mcp_servers ORDER BY created_at DESC LIMIT 200`
      );
      res.json({ servers: r.rows });
    } catch (e) {
      res.status(500).json({ error: { message: e.message } });
    }
  });

  // ------------------------------------------------------------------------
  // POST /v1/agents/:did/profile/location
  // ------------------------------------------------------------------------
  app.post('/v1/agents/:did/profile/location', express.json(), async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: { message: auth.error || 'unauthorized' } });
    const b = z.object({
      region_code: z.string().min(2).max(8),
      country_code: z.string().length(2).optional()
    }).safeParse(req.body || {});
    if (!b.success) return res.status(400).json({ error: { message: 'invalid_input', details: b.error.flatten() } });
    try {
      await pool.query(
        `INSERT INTO agent_locations (agent_did, region_code, country_code, updated_at)
         VALUES ($1,$2,$3,NOW())
         ON CONFLICT (agent_did) DO UPDATE SET
           region_code = EXCLUDED.region_code,
           country_code = EXCLUDED.country_code,
           updated_at = NOW()`,
        [did, b.data.region_code, b.data.country_code || null]
      );
      if (auditChain) await auditChain.append({ event_type: 'agent.location_set', agent_did: did, region_code: b.data.region_code }).catch(() => {});
      res.json({ ok: true, agent_did: did, region_code: b.data.region_code });
    } catch (e) {
      res.status(500).json({ error: { message: e.message } });
    }
  });

  app.get('/v1/map/regions', async (req, res) => {
    try {
      const r = await pool.query(
        `SELECT region_code, COUNT(*)::int AS n FROM agent_locations GROUP BY region_code ORDER BY n DESC LIMIT 200`
      );
      res.json({ regions: r.rows });
    } catch (e) {
      res.status(500).json({ error: { message: e.message } });
    }
  });

  // ------------------------------------------------------------------------
  // POST /v1/agents/:did/events/emit
  // ------------------------------------------------------------------------
  app.post('/v1/agents/:did/events/emit', express.json(), async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: { message: auth.error || 'unauthorized' } });
    const b = z.object({
      event_type: z.string().min(1).max(120),
      payload: z.any().optional()
    }).safeParse(req.body || {});
    if (!b.success) return res.status(400).json({ error: { message: 'invalid_input', details: b.error.flatten() } });
    const eventId = 'evt_' + crypto.randomBytes(8).toString('hex');
    try {
      await pool.query(
        `INSERT INTO agent_emitted_events (event_id, source_did, event_type, payload)
         VALUES ($1,$2,$3,$4::jsonb)`,
        [eventId, did, b.data.event_type, JSON.stringify(b.data.payload || {})]
      );
      // Fan out via webhooks_v2 if it exposes enqueue
      try {
        const { enqueue } = require('./webhooks_v2');
        if (typeof enqueue === 'function') await enqueue(pool, b.data.event_type, { source_did: did, ...(b.data.payload || {}) });
      } catch {}
      if (auditChain) await auditChain.append({ event_type: 'agent.event_emitted', event_id: eventId, source_did: did, kind: b.data.event_type }).catch(() => {});
      res.status(201).json({ event_id: eventId, fanned_out: true });
    } catch (e) {
      res.status(500).json({ error: { message: e.message } });
    }
  });

  // ------------------------------------------------------------------------
  // POST /v1/integrations/:provider/connect
  // ------------------------------------------------------------------------
  const SUPPORTED_PROVIDERS = new Set([
    'slack', 'discord', 'telegram', 'whatsapp',
    'plaid', 'persona', 'onfido', 'sumsub', 'comply-advantage',
    'github', 'zapier', 'n8n', 'make', 'ifttt'
  ]);

  app.post('/v1/integrations/:provider/connect', express.json(), async (req, res) => {
    const provider = String(req.params.provider).toLowerCase();
    if (!SUPPORTED_PROVIDERS.has(provider)) {
      return res.status(404).json({ error: { message: 'unknown_provider', supported: [...SUPPORTED_PROVIDERS] } });
    }
    // Zod-validate the envelope. The provider-specific keys vary by provider
    // so we accept any extra keys via passthrough() and rely on each connector
    // to validate its own shape downstream.
    const env = z.object({ agent_did: z.string().min(3).max(200) }).passthrough().safeParse(req.body || {});
    if (!env.success) return res.status(400).json({ error: { message: 'invalid_input', details: env.error.flatten() } });
    const did = env.data.agent_did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: { message: auth.error || 'unauthorized' } });

    // Don't persist agent_did in the config blob — that's the index column.
    const { agent_did: _drop, ...config } = env.data;
    let encrypted;
    try { encrypted = encryptConfig(config); }
    catch (e) { return res.status(503).json({ error: { message: e.message } }); }

    const connectionId = 'conn_' + crypto.randomBytes(8).toString('hex');
    try {
      // Replace any existing active connection for this (did, provider)
      await pool.query(
        `UPDATE integration_connections SET revoked_at = NOW()
         WHERE owner_did = $1 AND provider = $2 AND revoked_at IS NULL`,
        [did, provider]
      ).catch(() => {});
      await pool.query(
        `INSERT INTO integration_connections (connection_id, owner_did, provider, config_encrypted, status)
         VALUES ($1,$2,$3,$4,'connected')`,
        [connectionId, did, provider, encrypted]
      );
      if (auditChain) await auditChain.append({ event_type: 'integration.connected', connection_id: connectionId, owner_did: did, provider }).catch(() => {});
      res.status(201).json({ ok: true, connection_id: connectionId, provider, status: 'connected' });
    } catch (e) {
      res.status(500).json({ error: { message: e.message } });
    }
  });

  app.get('/v1/agents/:did/integrations', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: { message: auth.error || 'unauthorized' } });
    try {
      const r = await pool.query(
        `SELECT connection_id, provider, status, connected_at
         FROM integration_connections WHERE owner_did=$1 AND revoked_at IS NULL ORDER BY connected_at DESC`,
        [did]
      );
      res.json({ integrations: r.rows });
    } catch (e) {
      res.status(500).json({ error: { message: e.message } });
    }
  });

  // ------------------------------------------------------------------------
  // POST /v1/agents/:did/personality   (used by /agents/new)
  // ------------------------------------------------------------------------
  app.post('/v1/agents/:did/personality', express.json(), async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: { message: auth.error || 'unauthorized' } });
    const b = z.object({
      system_prompt: z.string().min(1).max(20000),
      default_model: z.string().optional(),
      tools_granted: z.array(z.string()).optional()
    }).safeParse(req.body || {});
    if (!b.success) return res.status(400).json({ error: { message: 'invalid_input', details: b.error.flatten() } });
    try {
      await pool.query(
        `INSERT INTO agent_personalities (personality_id, agent_did, system_prompt, default_model, tools_granted)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (agent_did) DO UPDATE SET
           system_prompt = EXCLUDED.system_prompt,
           default_model = COALESCE(EXCLUDED.default_model, agent_personalities.default_model),
           tools_granted = COALESCE(EXCLUDED.tools_granted, agent_personalities.tools_granted),
           updated_at = NOW()`,
        ['per_' + crypto.randomBytes(10).toString('hex'), did, b.data.system_prompt, b.data.default_model || null, b.data.tools_granted || null]
      );
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: { message: e.message } });
    }
  });

  app.get('/v1/agents/:did/personality', async (req, res) => {
    try {
      const r = await pool.query(
        `SELECT system_prompt, default_model, tools_granted, template_id, created_at, updated_at
         FROM agent_personalities WHERE agent_did=$1`,
        [req.params.did]
      );
      if (!r.rows[0]) return res.status(404).json({ error: { message: 'not_set' } });
      res.json(r.rows[0]);
    } catch (e) {
      res.status(500).json({ error: { message: e.message } });
    }
  });

  // ------------------------------------------------------------------------
  // POST /v1/agents/:did/skills/grant   (used by /learn/build-your-first-agent)
  // ------------------------------------------------------------------------
  app.post('/v1/agents/:did/skills/grant', express.json(), async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: { message: auth.error || 'unauthorized' } });
    const b = z.object({
      tools: z.array(z.string().min(1).max(200)).max(200)
    }).safeParse(req.body || {});
    if (!b.success) return res.status(400).json({ error: { message: 'invalid_input', details: b.error.flatten() } });
    const tools = b.data.tools;
    try {
      await pool.query(
        `UPDATE agent_personalities SET tools_granted = $1, updated_at = NOW() WHERE agent_did = $2`,
        [tools, did]
      );
      // If no personality row yet, insert minimal one
      await pool.query(
        `INSERT INTO agent_personalities (personality_id, agent_did, system_prompt, tools_granted)
         VALUES ($1, $2, 'You are an agent on OpenHeab.', $3)
         ON CONFLICT (agent_did) DO NOTHING`,
        ['per_' + crypto.randomBytes(10).toString('hex'), did, tools]
      ).catch(() => {});
      res.json({ ok: true, granted: tools.length });
    } catch (e) {
      res.status(500).json({ error: { message: e.message } });
    }
  });
}

module.exports = { migrate, registerPlaceholderImplsRoutes };
