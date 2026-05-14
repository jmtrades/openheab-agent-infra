// ============================================================================
// OpenHeab OAuth Bridge — Encrypted Token Vault + Provider Proxy
// AES-256-GCM with HKDF-derived KEKs. Stores access/refresh tokens for
// third-party providers and proxies API calls on behalf of agents.
// ============================================================================
const cryptoLib = require('crypto');
const express = require('express');
const { z } = require('zod');

const PROVIDERS = {
  slack:   { base: 'https://slack.com/api',         refresh: 'https://slack.com/api/oauth.v2.access' },
  github:  { base: 'https://api.github.com',        refresh: null },
  google:  { base: 'https://www.googleapis.com',    refresh: 'https://oauth2.googleapis.com/token' },
  notion:  { base: 'https://api.notion.com/v1',     refresh: null },
  linear:  { base: 'https://api.linear.app',        refresh: 'https://api.linear.app/oauth/token' },
  asana:   { base: 'https://app.asana.com/api/1.0', refresh: 'https://app.asana.com/-/oauth_token' },
  hubspot: { base: 'https://api.hubapi.com',        refresh: 'https://api.hubapi.com/oauth/v1/token' },
  zoom:    { base: 'https://api.zoom.us/v2',        refresh: 'https://zoom.us/oauth/token' }
};

// ----------------------------------------------------------------------------
// Migration
// ----------------------------------------------------------------------------
async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS oauth_grants (
      grant_id          TEXT PRIMARY KEY,
      agent_did         TEXT NOT NULL,
      provider          TEXT NOT NULL,
      human_user_ref    TEXT NOT NULL,
      scopes            TEXT[],
      access_token_enc  BYTEA,
      access_kek_salt   BYTEA,
      refresh_token_enc BYTEA,
      refresh_kek_salt  BYTEA,
      token_type        TEXT,
      expires_at        TIMESTAMPTZ,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      revoked_at        TIMESTAMPTZ,
      UNIQUE (agent_did, provider, human_user_ref)
    );
    CREATE INDEX IF NOT EXISTS idx_oauth_grants_did ON oauth_grants (agent_did);
    CREATE INDEX IF NOT EXISTS idx_oauth_grants_exp ON oauth_grants (expires_at)
      WHERE revoked_at IS NULL;

    CREATE TABLE IF NOT EXISTS oauth_idempotency (
      agent_did   TEXT NOT NULL,
      scope       TEXT NOT NULL,
      idem_key    TEXT NOT NULL,
      response    JSONB NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (agent_did, scope, idem_key)
    );
  `);
}

// ----------------------------------------------------------------------------
// KEK + AES-256-GCM
// ----------------------------------------------------------------------------
function masterKey() {
  const raw = process.env.OAUTH_MASTER_KEK || process.env.IDENTITY_MASTER_KEK;
  if (!raw) throw new Error('OAUTH_MASTER_KEK_or_IDENTITY_MASTER_KEK_not_configured');
  const buf = Buffer.from(raw, 'hex');
  return buf.length === 32 ? buf : cryptoLib.createHash('sha256').update(raw).digest();
}

function deriveKek(agentDid, provider, salt) {
  const ikm = masterKey();
  const info = Buffer.from(`openheab-oauth:${agentDid}:${provider}`, 'utf8');
  return cryptoLib.hkdfSync('sha256', ikm, salt, info, 32);
}

function encryptToken(plain, agentDid, provider) {
  if (!plain) return { enc: null, salt: null };
  const salt = cryptoLib.randomBytes(16);
  const kek = deriveKek(agentDid, provider, salt);
  const iv = cryptoLib.randomBytes(12);
  const cipher = cryptoLib.createCipheriv('aes-256-gcm', kek, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Layout: iv(12) || tag(16) || ciphertext
  return { enc: Buffer.concat([iv, tag, enc]), salt };
}

function decryptToken(blob, salt, agentDid, provider) {
  if (!blob || !salt) return null;
  const buf = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
  const saltBuf = Buffer.isBuffer(salt) ? salt : Buffer.from(salt);
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ct = buf.subarray(28);
  const kek = deriveKek(agentDid, provider, saltBuf);
  const decipher = cryptoLib.createDecipheriv('aes-256-gcm', kek, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(ct), decipher.final()]);
  return dec.toString('utf8');
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------
function genId(prefix) {
  return `${prefix}_${cryptoLib.randomBytes(12).toString('hex')}`;
}

async function checkIdempotency(pool, agentDid, key, scope) {
  if (!key) return null;
  const r = await pool.query(
    `SELECT response FROM oauth_idempotency WHERE agent_did=$1 AND scope=$2 AND idem_key=$3`,
    [agentDid, scope, key]
  ).catch(() => ({ rows: [] }));
  return r.rows[0]?.response || null;
}

async function recordIdempotency(pool, agentDid, key, scope, response) {
  if (!key) return;
  await pool.query(
    `INSERT INTO oauth_idempotency (agent_did, scope, idem_key, response)
     VALUES ($1,$2,$3,$4::jsonb) ON CONFLICT DO NOTHING`,
    [agentDid, scope, key, JSON.stringify(response)]
  ).catch(() => {});
}

function isKnownProvider(p) {
  return Object.prototype.hasOwnProperty.call(PROVIDERS, String(p || '').toLowerCase());
}

// ----------------------------------------------------------------------------
// Refresh logic
// ----------------------------------------------------------------------------
async function refreshGrant(pool, grant) {
  const provider = grant.provider;
  const cfg = PROVIDERS[provider];
  if (!cfg || !cfg.refresh) return { refreshed: false, reason: 'no_refresh_url' };
  if (!grant.refresh_token_enc) return { refreshed: false, reason: 'no_refresh_token' };

  const clientId = process.env[`OAUTH_${provider.toUpperCase()}_CLIENT_ID`];
  const clientSecret = process.env[`OAUTH_${provider.toUpperCase()}_CLIENT_SECRET`];
  if (!clientId || !clientSecret) {
    return { refreshed: false, reason: 'client_credentials_missing' };
  }

  const refreshToken = decryptToken(
    grant.refresh_token_enc, grant.refresh_kek_salt, grant.agent_did, provider
  );

  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret
  });

  let resp;
  try {
    resp = await fetch(cfg.refresh, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: params.toString()
    });
  } catch (e) {
    return { refreshed: false, reason: `network_error: ${e.message}` };
  }

  if (!resp.ok) {
    const txt = await resp.text().catch(() => '');
    return { refreshed: false, reason: `http_${resp.status}: ${txt.slice(0, 200)}` };
  }
  let data;
  try { data = await resp.json(); }
  catch (e) { return { refreshed: false, reason: 'invalid_json' }; }

  if (!data.access_token) return { refreshed: false, reason: 'no_access_token_in_response' };

  const accessEnc = encryptToken(data.access_token, grant.agent_did, provider);
  const refreshEnc = data.refresh_token
    ? encryptToken(data.refresh_token, grant.agent_did, provider)
    : { enc: grant.refresh_token_enc, salt: grant.refresh_kek_salt };
  const expiresAt = data.expires_in
    ? new Date(Date.now() + Number(data.expires_in) * 1000)
    : null;

  await pool.query(
    `UPDATE oauth_grants
     SET access_token_enc = $2, access_kek_salt = $3,
         refresh_token_enc = $4, refresh_kek_salt = $5,
         token_type = COALESCE($6, token_type),
         expires_at = $7, updated_at = NOW()
     WHERE grant_id = $1`,
    [grant.grant_id, accessEnc.enc, accessEnc.salt,
     refreshEnc.enc, refreshEnc.salt,
     data.token_type || null, expiresAt]
  );
  return { refreshed: true, expires_at: expiresAt };
}

async function refreshExpiringGrants(pool, auditChain, { withinSeconds = 600, limit = 200 } = {}) {
  const r = await pool.query(`
    SELECT grant_id, agent_did, provider, refresh_token_enc, refresh_kek_salt,
           access_token_enc, access_kek_salt, expires_at
    FROM oauth_grants
    WHERE revoked_at IS NULL
      AND refresh_token_enc IS NOT NULL
      AND expires_at IS NOT NULL
      AND expires_at < NOW() + ($1 || ' seconds')::interval
    ORDER BY expires_at ASC NULLS LAST
    LIMIT $2
  `, [String(withinSeconds), limit]).catch(() => ({ rows: [] }));

  const results = [];
  for (const g of r.rows) {
    try {
      const res = await refreshGrant(pool, g);
      if (auditChain && res.refreshed) {
        await auditChain.append({
          event_type: 'oauth.refreshed',
          agent_did: g.agent_did, provider: g.provider,
          grant_id: g.grant_id,
          timestamp: new Date().toISOString()
        });
      }
      results.push({ grant_id: g.grant_id, provider: g.provider, ...res });
    } catch (e) {
      results.push({ grant_id: g.grant_id, refreshed: false, reason: e.message });
    }
  }
  return { processed: r.rows.length, results };
}

// ----------------------------------------------------------------------------
// Routes
// ----------------------------------------------------------------------------
function registerOAuthRoutes(app, pool, verifyAgentAuth, auditChain) {
  // POST /v1/agents/:did/oauth/:provider/grant
  const GrantSchema = z.object({
    human_user_ref: z.string().min(1).max(255),
    access_token: z.string().min(1),
    refresh_token: z.string().optional(),
    scopes: z.array(z.string()).optional(),
    token_type: z.string().optional(),
    expires_in: z.number().int().positive().optional(),
    expires_at: z.string().datetime().optional()
  });

  app.post('/v1/agents/:did/oauth/:provider/grant', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const provider = String(req.params.provider).toLowerCase();
      if (!isKnownProvider(provider)) {
        return res.status(400).json({ error: 'unknown_provider', supported: Object.keys(PROVIDERS) });
      }
      const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const parse = GrantSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const { human_user_ref, access_token, refresh_token, scopes, token_type, expires_in, expires_at } = parse.data;

      const idemKey = req.headers['x-idempotency-key'];
      const cached = await checkIdempotency(pool, did, idemKey, `oauth-grant-${provider}`);
      if (cached) return res.json(cached);

      const accessEnc = encryptToken(access_token, did, provider);
      const refreshEnc = refresh_token ? encryptToken(refresh_token, did, provider) : { enc: null, salt: null };
      const expAt = expires_at
        ? new Date(expires_at)
        : (expires_in ? new Date(Date.now() + expires_in * 1000) : null);

      const grantId = genId('grt');

      // UNIQUE(agent_did, provider, human_user_ref) — upsert
      const upR = await pool.query(`
        INSERT INTO oauth_grants
        (grant_id, agent_did, provider, human_user_ref, scopes,
         access_token_enc, access_kek_salt, refresh_token_enc, refresh_kek_salt,
         token_type, expires_at, updated_at)
        VALUES ($1,$2,$3,$4,$5::text[],$6,$7,$8,$9,$10,$11,NOW())
        ON CONFLICT (agent_did, provider, human_user_ref) DO UPDATE SET
          scopes = EXCLUDED.scopes,
          access_token_enc = EXCLUDED.access_token_enc,
          access_kek_salt = EXCLUDED.access_kek_salt,
          refresh_token_enc = COALESCE(EXCLUDED.refresh_token_enc, oauth_grants.refresh_token_enc),
          refresh_kek_salt = COALESCE(EXCLUDED.refresh_kek_salt, oauth_grants.refresh_kek_salt),
          token_type = EXCLUDED.token_type,
          expires_at = EXCLUDED.expires_at,
          updated_at = NOW(),
          revoked_at = NULL
        RETURNING grant_id, created_at, updated_at
      `, [grantId, did, provider, human_user_ref, scopes || [],
          accessEnc.enc, accessEnc.salt, refreshEnc.enc, refreshEnc.salt,
          token_type || 'Bearer', expAt]);

      const finalGrantId = upR.rows[0].grant_id;

      await auditChain.append({
        event_type: 'oauth.grant_stored',
        agent_did: did, provider, human_user_ref,
        grant_id: finalGrantId, scopes: scopes || [],
        timestamp: new Date().toISOString()
      });

      const response = {
        grant_id: finalGrantId,
        agent_did: did, provider, human_user_ref,
        scopes: scopes || [],
        token_type: token_type || 'Bearer',
        expires_at: expAt ? expAt.toISOString() : null,
        has_refresh_token: !!refresh_token
      };
      await recordIdempotency(pool, did, idemKey, `oauth-grant-${provider}`, response);
      return res.status(201).json(response);
    } catch (e) {
      console.error('[oauth.grant]', e);
      return res.status(500).json({ error: 'grant_failed', message: e.message });
    }
  });

  // GET /v1/agents/:did/oauth/grants
  app.get('/v1/agents/:did/oauth/grants', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(
      `SELECT grant_id, agent_did, provider, human_user_ref, scopes, token_type,
              expires_at, created_at, updated_at, revoked_at,
              (refresh_token_enc IS NOT NULL) AS has_refresh_token
       FROM oauth_grants WHERE agent_did = $1
       ORDER BY created_at DESC`,
      [did]
    ).catch(() => ({ rows: [] }));
    return res.json({ grants: r.rows, count: r.rows.length });
  });

  // DELETE /v1/agents/:did/oauth/:provider/grant
  const RevokeSchema = z.object({
    human_user_ref: z.string().optional(),
    grant_id: z.string().optional()
  });

  app.delete('/v1/agents/:did/oauth/:provider/grant', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const provider = String(req.params.provider).toLowerCase();
      if (!isKnownProvider(provider)) {
        return res.status(400).json({ error: 'unknown_provider' });
      }
      const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const parse = RevokeSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const { human_user_ref, grant_id } = parse.data;

      const params = [did, provider];
      let extra = '';
      if (grant_id) { params.push(grant_id); extra = ` AND grant_id = $${params.length}`; }
      else if (human_user_ref) { params.push(human_user_ref); extra = ` AND human_user_ref = $${params.length}`; }
      else return res.status(400).json({ error: 'must_specify_grant_id_or_human_user_ref' });

      const r = await pool.query(
        `UPDATE oauth_grants SET revoked_at = NOW(), updated_at = NOW()
         WHERE agent_did = $1 AND provider = $2 ${extra} AND revoked_at IS NULL
         RETURNING grant_id`,
        params
      );
      if (!r.rows.length) return res.status(404).json({ error: 'not_found' });

      for (const row of r.rows) {
        await auditChain.append({
          event_type: 'oauth.grant_revoked',
          agent_did: did, provider, grant_id: row.grant_id,
          timestamp: new Date().toISOString()
        });
      }

      return res.json({ revoked: r.rows.map(x => x.grant_id), count: r.rows.length });
    } catch (e) {
      console.error('[oauth.revoke]', e);
      return res.status(500).json({ error: 'revoke_failed', message: e.message });
    }
  });

  // POST /v1/agents/:did/oauth/:provider/proxy
  const ProxySchema = z.object({
    human_user_ref: z.string(),
    method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).optional(),
    path: z.string().min(1),
    query: z.record(z.any()).optional(),
    headers: z.record(z.string()).optional(),
    body: z.any().optional()
  });

  app.post('/v1/agents/:did/oauth/:provider/proxy', express.json({ limit: '10mb' }), async (req, res) => {
    try {
      const did = req.params.did;
      const provider = String(req.params.provider).toLowerCase();
      if (!isKnownProvider(provider)) {
        return res.status(400).json({ error: 'unknown_provider' });
      }
      const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const parse = ProxySchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const { human_user_ref, method = 'GET', path, query, headers, body } = parse.data;

      const grantR = await pool.query(
        `SELECT grant_id, agent_did, provider, access_token_enc, access_kek_salt,
                refresh_token_enc, refresh_kek_salt, token_type, expires_at
         FROM oauth_grants
         WHERE agent_did = $1 AND provider = $2 AND human_user_ref = $3
           AND revoked_at IS NULL LIMIT 1`,
        [did, provider, human_user_ref]
      );
      let grant = grantR.rows[0];
      if (!grant) return res.status(404).json({ error: 'grant_not_found' });

      // Auto-refresh if within 60s of expiry
      if (grant.expires_at && new Date(grant.expires_at).getTime() < Date.now() + 60_000) {
        const r = await refreshGrant(pool, grant);
        if (r.refreshed) {
          const upd = await pool.query(
            `SELECT access_token_enc, access_kek_salt, token_type, expires_at
             FROM oauth_grants WHERE grant_id = $1`, [grant.grant_id]
          );
          if (upd.rows[0]) grant = { ...grant, ...upd.rows[0] };
        }
      }

      const accessToken = decryptToken(
        grant.access_token_enc, grant.access_kek_salt, did, provider
      );
      if (!accessToken) return res.status(500).json({ error: 'token_decrypt_failed' });

      const cfg = PROVIDERS[provider];
      let targetUrl = cfg.base.replace(/\/$/, '') + (path.startsWith('/') ? path : `/${path}`);
      if (query && Object.keys(query).length) {
        const qs = new URLSearchParams();
        for (const [k, v] of Object.entries(query)) {
          if (v === null || v === undefined) continue;
          qs.append(k, String(v));
        }
        const sep = targetUrl.includes('?') ? '&' : '?';
        targetUrl += sep + qs.toString();
      }

      const reqHeaders = {
        'authorization': `Bearer ${accessToken}`,
        'accept': 'application/json',
        ...(headers || {})
      };
      // Strip Host & dangerous overrides
      delete reqHeaders.host;
      delete reqHeaders['content-length'];

      const fetchOpts = { method, headers: reqHeaders };
      if (body !== undefined && method !== 'GET' && method !== 'DELETE') {
        if (typeof body === 'string') {
          fetchOpts.body = body;
          if (!reqHeaders['content-type']) reqHeaders['content-type'] = 'text/plain';
        } else {
          fetchOpts.body = JSON.stringify(body);
          if (!reqHeaders['content-type']) reqHeaders['content-type'] = 'application/json';
        }
      }

      let upstream;
      try { upstream = await fetch(targetUrl, fetchOpts); }
      catch (e) { return res.status(502).json({ error: 'upstream_unreachable', message: e.message }); }

      const ct = upstream.headers.get('content-type') || '';
      const text = await upstream.text();
      let payload;
      if (ct.includes('application/json')) {
        try { payload = JSON.parse(text); } catch { payload = text; }
      } else {
        payload = text;
      }

      await auditChain.append({
        event_type: 'oauth.proxy_call',
        agent_did: did, provider, human_user_ref,
        method, path, status: upstream.status,
        timestamp: new Date().toISOString()
      });

      return res.status(200).json({
        upstream_status: upstream.status,
        upstream_url: targetUrl,
        method,
        response: payload
      });
    } catch (e) {
      console.error('[oauth.proxy]', e);
      return res.status(500).json({ error: 'proxy_failed', message: e.message });
    }
  });

  // Cron — refresh tokens expiring within 10 minutes
  require('../cron_auth').registerCron(app, '/v1/_jobs/oauth-refresh', async (req, res) => {
    try {
      const withinSeconds = parseInt(req.query.within_seconds) || 600;
      const limit = Math.min(parseInt(req.query.limit) || 200, 1000);
      const r = await refreshExpiringGrants(pool, auditChain, { withinSeconds, limit });
      return res.json({ ok: true, ...r });
    } catch (e) {
      console.error('[oauth.cron]', e);
      return res.status(500).json({ ok: false, error: e.message });
    }
  });
}

module.exports = {
  migrate,
  registerOAuthRoutes,
  encryptToken,
  decryptToken,
  refreshGrant,
  refreshExpiringGrants,
  PROVIDERS
};
