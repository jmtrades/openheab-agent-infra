// ============================================================================
// OpenHeab Identity Rotation + Capability Tokens
// Ed25519 key rotation with AES-256-GCM encrypted private keys and JWS-style
// capability tokens for delegated authority.
// ============================================================================
const cryptoLib = require('crypto');
const express = require('express');
const { z } = require('zod');

// ----------------------------------------------------------------------------
// Encryption helpers — AES-256-GCM with HKDF-derived KEK per agent
// ----------------------------------------------------------------------------
function deriveKek(agentDid, generation = 0) {
  const masterKek = process.env.IDENTITY_MASTER_KEK;
  if (!masterKek) throw new Error('IDENTITY_MASTER_KEK not configured');
  const ikm = Buffer.from(masterKek, 'hex').length === 32
    ? Buffer.from(masterKek, 'hex')
    : cryptoLib.createHash('sha256').update(masterKek).digest();
  const salt = Buffer.from('openheab-identity-v1', 'utf8');
  const info = Buffer.from(`${agentDid}:gen=${generation}`, 'utf8');
  return cryptoLib.hkdfSync('sha256', ikm, salt, info, 32);
}

function encryptPrivKey(privPem, agentDid, generation = 0) {
  const kek = deriveKek(agentDid, generation);
  const iv = cryptoLib.randomBytes(12);
  const cipher = cryptoLib.createCipheriv('aes-256-gcm', kek, iv);
  const enc = Buffer.concat([cipher.update(privPem, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { encrypted: enc.toString('base64'), iv: iv.toString('base64'), tag: tag.toString('base64') };
}

function decryptPrivKey({ encrypted, iv, tag }, agentDid, generation = 0) {
  const kek = deriveKek(agentDid, generation);
  const decipher = cryptoLib.createDecipheriv('aes-256-gcm', kek, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  const dec = Buffer.concat([
    decipher.update(Buffer.from(encrypted, 'base64')),
    decipher.final()
  ]);
  return dec.toString('utf8');
}

function genKeyId(pubPem) {
  return 'key_' + cryptoLib.createHash('sha256').update(pubPem).digest('hex').slice(0, 24);
}

// ----------------------------------------------------------------------------
// Migration
// ----------------------------------------------------------------------------
async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS identity_keys (
      key_id              TEXT PRIMARY KEY,
      agent_did           TEXT NOT NULL,
      public_key          TEXT NOT NULL,
      encrypted_priv      TEXT,
      encryption_iv       TEXT,
      encryption_tag      TEXT,
      status              TEXT NOT NULL DEFAULT 'active',
      generation          INTEGER NOT NULL DEFAULT 0,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      retired_at          TIMESTAMPTZ,
      retire_reason       TEXT,
      audit_chain_entry   TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_identity_keys_agent ON identity_keys (agent_did, status);
    CREATE INDEX IF NOT EXISTS idx_identity_keys_gen ON identity_keys (agent_did, generation DESC);

    CREATE TABLE IF NOT EXISTS capability_tokens (
      token_id        TEXT PRIMARY KEY,
      issuer_did      TEXT NOT NULL,
      issuer_key_id   TEXT NOT NULL,
      grantee_did     TEXT NOT NULL,
      scope           JSONB NOT NULL,
      constraints     JSONB,
      max_uses        INTEGER,
      use_count       INTEGER NOT NULL DEFAULT 0,
      issued_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at      TIMESTAMPTZ,
      revoked_at      TIMESTAMPTZ,
      signature       TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_cap_tokens_issuer ON capability_tokens (issuer_did);
    CREATE INDEX IF NOT EXISTS idx_cap_tokens_grantee ON capability_tokens (grantee_did);
    CREATE INDEX IF NOT EXISTS idx_cap_tokens_expires ON capability_tokens (expires_at)
      WHERE revoked_at IS NULL;
  `);
}

// ----------------------------------------------------------------------------
// Capability token helpers (JWS-style)
// ----------------------------------------------------------------------------
function b64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function signCapabilityToken(payload, privPem) {
  const header = { alg: 'EdDSA', typ: 'CAP+JWS', kid: payload.issuer_key_id };
  const headerB64 = b64url(JSON.stringify(header));
  const payloadB64 = b64url(JSON.stringify(payload));
  const signingInput = `${headerB64}.${payloadB64}`;
  const sig = cryptoLib.sign(null, Buffer.from(signingInput), cryptoLib.createPrivateKey(privPem));
  return `${signingInput}.${b64url(sig)}`;
}

function parseCapabilityToken(token) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('malformed_token');
  const decode = (s) => {
    s = s.replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    return Buffer.from(s, 'base64');
  };
  const header = JSON.parse(decode(parts[0]).toString('utf8'));
  const payload = JSON.parse(decode(parts[1]).toString('utf8'));
  const signature = decode(parts[2]);
  return { header, payload, signature, signingInput: `${parts[0]}.${parts[1]}` };
}

function verifyCapabilitySignature(token, pubPem) {
  const { signature, signingInput } = parseCapabilityToken(token);
  return cryptoLib.verify(null, Buffer.from(signingInput), cryptoLib.createPublicKey(pubPem), signature);
}

// ----------------------------------------------------------------------------
// Idempotency helper
// ----------------------------------------------------------------------------
async function checkIdempotency(pool, agentDid, key, scope) {
  if (!key) return null;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS identity_idempotency (
      agent_did TEXT NOT NULL,
      scope TEXT NOT NULL,
      idem_key TEXT NOT NULL,
      response JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (agent_did, scope, idem_key)
    )`).catch(() => {});
  const r = await pool.query(
    `SELECT response FROM identity_idempotency WHERE agent_did=$1 AND scope=$2 AND idem_key=$3`,
    [agentDid, scope, key]
  ).catch(() => ({ rows: [] }));
  return r.rows[0]?.response || null;
}

async function recordIdempotency(pool, agentDid, key, scope, response) {
  if (!key) return;
  await pool.query(
    `INSERT INTO identity_idempotency (agent_did, scope, idem_key, response)
     VALUES ($1,$2,$3,$4::jsonb) ON CONFLICT DO NOTHING`,
    [agentDid, scope, key, JSON.stringify(response)]
  ).catch(() => {});
}

// ----------------------------------------------------------------------------
// Routes
// ----------------------------------------------------------------------------
function registerIdentityRotationRoutes(app, pool, verifyAgentAuth, auditChain) {
  // POST /v1/agents/:did/identity/rotate-key
  const RotateSchema = z.object({
    reason: z.string().max(500).optional(),
    return_private_key: z.boolean().optional()
  });

  app.post('/v1/agents/:did/identity/rotate-key', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const parse = RotateSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });

      const idemKey = req.headers['x-idempotency-key'];
      const cached = await checkIdempotency(pool, did, idemKey, 'rotate-key');
      if (cached) return res.json(cached);

      // Determine next generation
      const genR = await pool.query(
        `SELECT COALESCE(MAX(generation), -1) + 1 AS next FROM identity_keys WHERE agent_did=$1`,
        [did]
      );
      const generation = parseInt(genR.rows[0].next);

      const { publicKey, privateKey } = cryptoLib.generateKeyPairSync('ed25519');
      const pubPem = publicKey.export({ type: 'spki', format: 'pem' });
      const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
      const keyId = genKeyId(pubPem);

      const enc = encryptPrivKey(privPem, did, generation);

      // Retire old active keys
      await pool.query(
        `UPDATE identity_keys SET status='retired', retired_at=NOW(),
                                 retire_reason=$2
         WHERE agent_did=$1 AND status='active'`,
        [did, parse.data.reason || 'rotated']
      );

      const chainEntry = await auditChain.append({
        event_type: 'identity.key_rotated',
        agent_did: did,
        new_key_id: keyId,
        generation,
        reason: parse.data.reason || null,
        timestamp: new Date().toISOString()
      });

      await pool.query(
        `INSERT INTO identity_keys
         (key_id, agent_did, public_key, encrypted_priv, encryption_iv, encryption_tag,
          status, generation, audit_chain_entry)
         VALUES ($1, $2, $3, $4, $5, $6, 'active', $7, $8)`,
        [keyId, did, pubPem, enc.encrypted, enc.iv, enc.tag, generation, chainEntry.hash]
      );

      const response = {
        key_id: keyId,
        agent_did: did,
        public_key: pubPem,
        generation,
        status: 'active',
        audit_chain_entry: chainEntry.hash,
        ...(parse.data.return_private_key ? { private_key: privPem } : {})
      };

      await recordIdempotency(pool, did, idemKey, 'rotate-key', response);
      return res.status(201).json(response);
    } catch (e) {
      console.error('[identity.rotate]', e);
      return res.status(500).json({ error: 'rotation_failed', message: e.message });
    }
  });

  // GET /v1/agents/:did/identity/keys
  app.get('/v1/agents/:did/identity/keys', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });

    const includeRetired = req.query.include_retired === 'true';
    const filter = includeRetired ? '' : `AND status = 'active'`;
    const r = await pool.query(
      `SELECT key_id, agent_did, public_key, status, generation, created_at,
              retired_at, retire_reason, audit_chain_entry
       FROM identity_keys WHERE agent_did=$1 ${filter}
       ORDER BY generation DESC`,
      [did]
    ).catch(() => ({ rows: [] }));

    return res.json({ keys: r.rows, count: r.rows.length });
  });

  // POST /v1/capabilities/issue
  const ConstraintsSchema = z.object({
    max_amount_cents: z.number().int().optional(),
    allowed_recipients: z.array(z.string()).optional(),
    allowed_paths: z.array(z.string()).optional(),
    rate_limit_per_hour: z.number().int().optional()
  }).passthrough().optional();

  const IssueSchema = z.object({
    issuer_did: z.string(),
    grantee_did: z.string(),
    scope: z.array(z.string()).min(1).max(64),
    constraints: ConstraintsSchema,
    max_uses: z.number().int().positive().optional(),
    expires_in_seconds: z.number().int().positive().max(60 * 60 * 24 * 365).optional()
  });

  app.post('/v1/capabilities/issue', express.json(), async (req, res) => {
    try {
      const parse = IssueSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const { issuer_did, grantee_did, scope, constraints, max_uses, expires_in_seconds } = parse.data;

      const auth = await verifyAgentAuth(req, issuer_did, { strictSignatureRequired: true });
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const idemKey = req.headers['x-idempotency-key'];
      const cached = await checkIdempotency(pool, issuer_did, idemKey, 'cap-issue');
      if (cached) return res.json(cached);

      const keyR = await pool.query(
        `SELECT key_id, public_key, encrypted_priv, encryption_iv, encryption_tag, generation
         FROM identity_keys WHERE agent_did=$1 AND status='active' LIMIT 1`,
        [issuer_did]
      );
      if (!keyR.rows[0]) return res.status(404).json({ error: 'no_active_key_for_issuer' });
      const key = keyR.rows[0];

      // For signing we need the private key. If not stored, we cannot sign on
      // behalf of the issuer — return error.
      if (!key.encrypted_priv) {
        return res.status(400).json({ error: 'issuer_private_key_unavailable_for_signing' });
      }

      const tokenId = 'cap_' + cryptoLib.randomBytes(16).toString('hex');
      const now = new Date();
      const expiresAt = expires_in_seconds
        ? new Date(now.getTime() + expires_in_seconds * 1000)
        : null;

      const payload = {
        token_id: tokenId,
        issuer_did,
        issuer_key_id: key.key_id,
        grantee_did,
        scope,
        constraints: constraints || null,
        max_uses: max_uses || null,
        iat: Math.floor(now.getTime() / 1000),
        exp: expiresAt ? Math.floor(expiresAt.getTime() / 1000) : null
      };

      const privPem = decryptPrivKey(
        { encrypted: key.encrypted_priv, iv: key.encryption_iv, tag: key.encryption_tag },
        issuer_did, key.generation
      );
      const signature = signCapabilityToken(payload, privPem);

      await pool.query(
        `INSERT INTO capability_tokens
         (token_id, issuer_did, issuer_key_id, grantee_did, scope, constraints, max_uses,
          issued_at, expires_at, signature)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, NOW(), $8, $9)`,
        [tokenId, issuer_did, key.key_id, grantee_did, JSON.stringify(scope),
         constraints ? JSON.stringify(constraints) : null,
         max_uses || null, expiresAt, signature]
      );

      await auditChain.append({
        event_type: 'capability.issued',
        token_id: tokenId,
        issuer_did, grantee_did, scope,
        timestamp: now.toISOString()
      });

      const response = {
        token_id: tokenId,
        token: signature,
        issuer_did,
        issuer_key_id: key.key_id,
        grantee_did,
        scope,
        constraints: constraints || null,
        max_uses: max_uses || null,
        issued_at: now.toISOString(),
        expires_at: expiresAt?.toISOString() || null
      };
      await recordIdempotency(pool, issuer_did, idemKey, 'cap-issue', response);
      return res.status(201).json(response);
    } catch (e) {
      console.error('[capabilities.issue]', e);
      return res.status(500).json({ error: 'issue_failed', message: e.message });
    }
  });

  // POST /v1/capabilities/verify
  const VerifySchema = z.object({
    token: z.string(),
    required_scope: z.string().optional()
  });

  app.post('/v1/capabilities/verify', express.json(), async (req, res) => {
    try {
      const parse = VerifySchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const { token, required_scope } = parse.data;

      let parsed;
      try { parsed = parseCapabilityToken(token); }
      catch { return res.status(400).json({ valid: false, error: 'malformed_token' }); }

      const tokenId = parsed.payload.token_id;
      const dbR = await pool.query(
        `SELECT t.*, k.public_key
         FROM capability_tokens t
         JOIN identity_keys k ON k.key_id = t.issuer_key_id
         WHERE t.token_id=$1`,
        [tokenId]
      ).catch(() => ({ rows: [] }));

      if (!dbR.rows[0]) return res.json({ valid: false, error: 'token_not_found' });
      const row = dbR.rows[0];

      if (row.revoked_at) return res.json({ valid: false, error: 'revoked' });
      if (row.expires_at && new Date(row.expires_at) < new Date())
        return res.json({ valid: false, error: 'expired' });
      if (row.max_uses && row.use_count >= row.max_uses)
        return res.json({ valid: false, error: 'max_uses_exceeded' });

      let sigOk = false;
      try { sigOk = verifyCapabilitySignature(token, row.public_key); }
      catch { sigOk = false; }
      if (!sigOk) return res.json({ valid: false, error: 'invalid_signature' });

      const scope = Array.isArray(row.scope) ? row.scope : JSON.parse(row.scope || '[]');
      if (required_scope && !scope.includes(required_scope) && !scope.includes('*')) {
        return res.json({ valid: false, error: 'scope_not_granted', scope });
      }

      await pool.query(
        `UPDATE capability_tokens SET use_count = use_count + 1 WHERE token_id=$1`,
        [tokenId]
      );

      return res.json({
        valid: true,
        token_id: tokenId,
        issuer_did: row.issuer_did,
        grantee_did: row.grantee_did,
        scope,
        constraints: row.constraints || null,
        uses_remaining: row.max_uses ? Math.max(0, row.max_uses - row.use_count - 1) : null,
        expires_at: row.expires_at
      });
    } catch (e) {
      console.error('[capabilities.verify]', e);
      return res.status(500).json({ valid: false, error: 'verify_failed', message: e.message });
    }
  });

  // DELETE /v1/capabilities/:tokenId
  app.delete('/v1/capabilities/:tokenId', express.json(), async (req, res) => {
    try {
      const tokenId = req.params.tokenId;
      const r = await pool.query(
        `SELECT issuer_did FROM capability_tokens WHERE token_id=$1`, [tokenId]
      );
      if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
      const issuer = r.rows[0].issuer_did;

      const auth = await verifyAgentAuth(req, issuer, { strictSignatureRequired: true });
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      await pool.query(
        `UPDATE capability_tokens SET revoked_at = NOW() WHERE token_id=$1 AND revoked_at IS NULL`,
        [tokenId]
      );

      await auditChain.append({
        event_type: 'capability.revoked',
        token_id: tokenId, issuer_did: issuer,
        timestamp: new Date().toISOString()
      });
      return res.json({ token_id: tokenId, revoked: true });
    } catch (e) {
      console.error('[capabilities.revoke]', e);
      return res.status(500).json({ error: 'revoke_failed', message: e.message });
    }
  });

  // GET /v1/agents/:did/capabilities/issued
  app.get('/v1/agents/:did/capabilities/issued', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(
      `SELECT token_id, issuer_did, issuer_key_id, grantee_did, scope, constraints,
              max_uses, use_count, issued_at, expires_at, revoked_at
       FROM capability_tokens WHERE issuer_did=$1 ORDER BY issued_at DESC LIMIT 200`,
      [did]
    ).catch(() => ({ rows: [] }));
    return res.json({ tokens: r.rows, count: r.rows.length });
  });

  // GET /v1/agents/:did/capabilities/received
  app.get('/v1/agents/:did/capabilities/received', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(
      `SELECT token_id, issuer_did, issuer_key_id, grantee_did, scope, constraints,
              max_uses, use_count, issued_at, expires_at, revoked_at
       FROM capability_tokens WHERE grantee_did=$1 ORDER BY issued_at DESC LIMIT 200`,
      [did]
    ).catch(() => ({ rows: [] }));
    return res.json({ tokens: r.rows, count: r.rows.length });
  });
}

module.exports = {
  migrate,
  registerIdentityRotationRoutes,
  deriveKek,
  encryptPrivKey,
  decryptPrivKey,
  signCapabilityToken,
  parseCapabilityToken,
  verifyCapabilitySignature,
  genKeyId
};
