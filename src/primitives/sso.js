// ============================================================================
// OpenHeab SSO — SAML 2.0 + OIDC Single Sign-On for enterprise customers.
// JIT-provisions agents from IdP, stores encrypted OIDC client secrets,
// validates SAML assertions and OIDC id_tokens.
// ============================================================================
const cryptoLib = require('crypto');
const express = require('express');
const { z } = require('zod');

// ----------------------------------------------------------------------------
// Encryption (HKDF-derived KEK from SSO_MASTER_KEK or IDENTITY_MASTER_KEK)
// ----------------------------------------------------------------------------
function deriveSsoKek(providerId) {
  const masterKek = process.env.SSO_MASTER_KEK || process.env.IDENTITY_MASTER_KEK;
  if (!masterKek) throw new Error('SSO_MASTER_KEK or IDENTITY_MASTER_KEK not configured');
  let ikm;
  try {
    ikm = Buffer.from(masterKek, 'hex');
    if (ikm.length !== 32) ikm = cryptoLib.createHash('sha256').update(masterKek).digest();
  } catch {
    ikm = cryptoLib.createHash('sha256').update(masterKek).digest();
  }
  const salt = Buffer.from('openheab-sso-v1', 'utf8');
  const info = Buffer.from(`provider=${providerId}`, 'utf8');
  return cryptoLib.hkdfSync('sha256', ikm, salt, info, 32);
}

function encryptSecret(plaintext, providerId) {
  const kek = deriveSsoKek(providerId);
  const iv = cryptoLib.randomBytes(12);
  const cipher = cryptoLib.createCipheriv('aes-256-gcm', kek, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Pack: iv(12) + tag(16) + ciphertext
  return Buffer.concat([iv, tag, enc]);
}

function decryptSecret(blob, providerId) {
  if (!blob) return null;
  const buf = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
  const iv = buf.slice(0, 12);
  const tag = buf.slice(12, 28);
  const enc = buf.slice(28);
  const kek = deriveSsoKek(providerId);
  const decipher = cryptoLib.createDecipheriv('aes-256-gcm', kek, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
  return dec.toString('utf8');
}

function genId(prefix) { return `${prefix}_${cryptoLib.randomBytes(12).toString('hex')}`; }

// ----------------------------------------------------------------------------
// Migration
// ----------------------------------------------------------------------------
async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sso_providers (
      provider_id                  TEXT PRIMARY KEY,
      org_id                       TEXT NOT NULL,
      kind                         TEXT NOT NULL,
      name                         TEXT NOT NULL,
      idp_entity_id                TEXT,
      idp_sso_url                  TEXT,
      idp_metadata_xml             TEXT,
      idp_cert_pem                 TEXT,
      oidc_issuer_url              TEXT,
      oidc_client_id               TEXT,
      oidc_client_secret_encrypted BYTEA,
      default_role                 TEXT NOT NULL DEFAULT 'member',
      jit_provisioning             BOOLEAN NOT NULL DEFAULT TRUE,
      status                       TEXT NOT NULL DEFAULT 'active',
      created_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_sso_providers_org ON sso_providers (org_id);

    CREATE TABLE IF NOT EXISTS sso_sessions (
      session_id   TEXT PRIMARY KEY,
      provider_id  TEXT NOT NULL,
      org_id       TEXT NOT NULL,
      agent_did    TEXT,
      email        TEXT,
      idp_subject  TEXT,
      attributes   JSONB,
      expires_at   TIMESTAMPTZ,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      ip_address   TEXT,
      user_agent   TEXT,
      revoked_at   TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_sso_sessions_provider ON sso_sessions (provider_id);
    CREATE INDEX IF NOT EXISTS idx_sso_sessions_did ON sso_sessions (agent_did);

    CREATE TABLE IF NOT EXISTS sso_attribute_mappings (
      mapping_id          TEXT PRIMARY KEY,
      provider_id         TEXT NOT NULL,
      idp_attribute       TEXT NOT NULL,
      openheab_attribute  TEXT NOT NULL,
      transform           TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_sso_attr_mappings_provider ON sso_attribute_mappings (provider_id);

    CREATE TABLE IF NOT EXISTS sso_login_events (
      event_id        TEXT PRIMARY KEY,
      provider_id     TEXT NOT NULL,
      email           TEXT,
      success         BOOLEAN NOT NULL,
      failure_reason  TEXT,
      ip_address      TEXT,
      occurred_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_sso_login_events_provider ON sso_login_events (provider_id, occurred_at DESC);
  `).catch(() => {});
}

// ----------------------------------------------------------------------------
// SAML helpers — regex-based parser (xml2js fallback)
// ----------------------------------------------------------------------------
function tryRequireXml2js() {
  try { return require('xml2js'); } catch { return null; }
}

function extractSamlAttributes(xml) {
  // Returns { nameId, attributes: { name: [values] }, conditionsNotOnOrAfter, signatureValue, signedInfo }
  const out = { nameId: null, attributes: {}, conditionsNotOnOrAfter: null, audience: null };

  const xml2js = tryRequireXml2js();
  if (xml2js) {
    try {
      let parsed;
      xml2js.parseString(xml, { explicitArray: false, tagNameProcessors: [(n) => n.replace(/^.*:/, '')] }, (e, r) => {
        if (!e) parsed = r;
      });
      if (parsed) {
        const resp = parsed.Response || parsed;
        const assertion = resp.Assertion || (resp.EncryptedAssertion && resp.EncryptedAssertion.Assertion);
        if (assertion) {
          const subj = assertion.Subject;
          if (subj && subj.NameID) out.nameId = typeof subj.NameID === 'string' ? subj.NameID : subj.NameID._;
          const conds = assertion.Conditions;
          if (conds) {
            out.conditionsNotOnOrAfter = conds.$ && conds.$.NotOnOrAfter;
            const restr = conds.AudienceRestriction;
            if (restr && restr.Audience) out.audience = restr.Audience;
          }
          const stmt = assertion.AttributeStatement;
          if (stmt && stmt.Attribute) {
            const attrs = Array.isArray(stmt.Attribute) ? stmt.Attribute : [stmt.Attribute];
            for (const a of attrs) {
              const name = a.$ && a.$.Name;
              if (!name) continue;
              const av = a.AttributeValue;
              const vals = Array.isArray(av) ? av : [av];
              out.attributes[name] = vals.map(v => (typeof v === 'string' ? v : (v && v._) || ''));
            }
          }
          return out;
        }
      }
    } catch { /* fall through to regex */ }
  }

  // Regex fallback
  const nameIdMatch = xml.match(/<(?:[a-zA-Z0-9]+:)?NameID[^>]*>([^<]+)<\/(?:[a-zA-Z0-9]+:)?NameID>/);
  if (nameIdMatch) out.nameId = nameIdMatch[1].trim();

  const condMatch = xml.match(/<(?:[a-zA-Z0-9]+:)?Conditions[^>]*NotOnOrAfter="([^"]+)"/);
  if (condMatch) out.conditionsNotOnOrAfter = condMatch[1];

  const audMatch = xml.match(/<(?:[a-zA-Z0-9]+:)?Audience[^>]*>([^<]+)<\/(?:[a-zA-Z0-9]+:)?Audience>/);
  if (audMatch) out.audience = audMatch[1].trim();

  // Attributes — iterate
  const attrRe = /<(?:[a-zA-Z0-9]+:)?Attribute\s+[^>]*Name="([^"]+)"[^>]*>([\s\S]*?)<\/(?:[a-zA-Z0-9]+:)?Attribute>/g;
  let m;
  while ((m = attrRe.exec(xml))) {
    const name = m[1];
    const inner = m[2];
    const valRe = /<(?:[a-zA-Z0-9]+:)?AttributeValue[^>]*>([\s\S]*?)<\/(?:[a-zA-Z0-9]+:)?AttributeValue>/g;
    const vals = [];
    let v;
    while ((v = valRe.exec(inner))) vals.push(v[1].replace(/<[^>]+>/g, '').trim());
    out.attributes[name] = vals;
  }

  return out;
}

function verifySamlAssertion(xmlString, idpCertPem) {
  // Best-effort SAML signature verification. Parses signature/digest from XML.
  // Returns { valid: bool, reason?: string, attributes }
  const result = { valid: false, attributes: extractSamlAttributes(xmlString) };

  // Time-window check
  if (result.attributes.conditionsNotOnOrAfter) {
    const notAfter = new Date(result.attributes.conditionsNotOnOrAfter);
    if (Number.isFinite(notAfter.getTime()) && notAfter < new Date()) {
      result.reason = 'assertion_expired';
      return result;
    }
  }

  if (!idpCertPem) {
    // If no cert configured, accept the parse but mark unsigned
    result.valid = !!result.attributes.nameId;
    if (!result.valid) result.reason = 'missing_name_id';
    result.unsigned = true;
    return result;
  }

  // Extract base64 signature value
  const sigMatch = xmlString.match(/<(?:[a-zA-Z0-9]+:)?SignatureValue[^>]*>([\s\S]+?)<\/(?:[a-zA-Z0-9]+:)?SignatureValue>/);
  const signedInfoMatch = xmlString.match(/<(?:[a-zA-Z0-9]+:)?SignedInfo[\s\S]+?<\/(?:[a-zA-Z0-9]+:)?SignedInfo>/);
  if (!sigMatch || !signedInfoMatch) {
    result.reason = 'no_signature';
    return result;
  }
  try {
    const verifier = cryptoLib.createVerify('RSA-SHA256');
    verifier.update(signedInfoMatch[0]);
    const ok = verifier.verify(idpCertPem, sigMatch[1].replace(/\s+/g, ''), 'base64');
    result.valid = ok && !!result.attributes.nameId;
    if (!ok) result.reason = 'signature_invalid';
  } catch (e) {
    result.reason = 'signature_verification_error: ' + e.message;
  }
  return result;
}

function extractCertFromMetadata(metadataXml) {
  if (!metadataXml) return null;
  const m = metadataXml.match(/<(?:[a-zA-Z0-9]+:)?X509Certificate[^>]*>([\s\S]+?)<\/(?:[a-zA-Z0-9]+:)?X509Certificate>/);
  if (!m) return null;
  const b64 = m[1].replace(/\s+/g, '');
  return `-----BEGIN CERTIFICATE-----\n${b64.match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----\n`;
}

function extractSsoUrlFromMetadata(metadataXml) {
  if (!metadataXml) return null;
  const m = metadataXml.match(/<(?:[a-zA-Z0-9]+:)?SingleSignOnService[^>]*Location="([^"]+)"/);
  return m ? m[1] : null;
}

function extractEntityIdFromMetadata(metadataXml) {
  if (!metadataXml) return null;
  const m = metadataXml.match(/entityID="([^"]+)"/);
  return m ? m[1] : null;
}

// ----------------------------------------------------------------------------
// OIDC helpers
// ----------------------------------------------------------------------------
function b64urlDecode(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64');
}

function base64urlBigIntToHex(b64) {
  return b64urlDecode(b64).toString('hex');
}

function jwkRsaToPem(jwk) {
  // Build SubjectPublicKeyInfo for RSA from n & e (per RFC 8017)
  // Easier: use Node 16+ KeyObject.from(jwk)
  return cryptoLib.createPublicKey({ key: jwk, format: 'jwk' }).export({ type: 'spki', format: 'pem' });
}

async function fetchJson(url) {
  if (typeof fetch !== 'function') throw new Error('fetch_not_available');
  const r = await fetch(url, { headers: { 'accept': 'application/json' } });
  if (!r.ok) throw new Error(`fetch_failed_${r.status}`);
  return r.json();
}

async function getOidcDiscovery(issuerUrl) {
  const u = issuerUrl.replace(/\/$/, '') + '/.well-known/openid-configuration';
  return fetchJson(u);
}

async function validateOidcIdToken(jwt, jwksUrl) {
  // Implements RS256 signature verification + standard claim checks.
  const parts = jwt.split('.');
  if (parts.length !== 3) return { valid: false, reason: 'malformed_jwt' };
  let header, payload;
  try {
    header = JSON.parse(b64urlDecode(parts[0]).toString('utf8'));
    payload = JSON.parse(b64urlDecode(parts[1]).toString('utf8'));
  } catch {
    return { valid: false, reason: 'jwt_parse_error' };
  }

  if (header.alg !== 'RS256' && header.alg !== 'RS384' && header.alg !== 'RS512') {
    return { valid: false, reason: `unsupported_alg_${header.alg}` };
  }
  if (payload.exp && (Date.now() / 1000) > payload.exp) {
    return { valid: false, reason: 'token_expired', payload };
  }

  let jwks;
  try { jwks = await fetchJson(jwksUrl); }
  catch (e) { return { valid: false, reason: 'jwks_fetch_failed: ' + e.message }; }

  const key = (jwks.keys || []).find(k => k.kid === header.kid) || (jwks.keys || [])[0];
  if (!key) return { valid: false, reason: 'no_jwks_key' };

  let pubPem;
  try { pubPem = jwkRsaToPem(key); }
  catch (e) { return { valid: false, reason: 'jwk_conversion_failed: ' + e.message }; }

  const algMap = { RS256: 'RSA-SHA256', RS384: 'RSA-SHA384', RS512: 'RSA-SHA512' };
  const verifier = cryptoLib.createVerify(algMap[header.alg]);
  verifier.update(`${parts[0]}.${parts[1]}`);
  const sigBuf = b64urlDecode(parts[2]);
  let ok;
  try { ok = verifier.verify(pubPem, sigBuf); }
  catch { ok = false; }

  if (!ok) return { valid: false, reason: 'signature_invalid', payload };
  return { valid: true, payload, header };
}

// ----------------------------------------------------------------------------
// Org/role helpers (org primitive may not be loaded yet — graceful fallback)
// ----------------------------------------------------------------------------
async function isOrgAdmin(pool, orgId, agentDid) {
  if (!orgId || !agentDid) return false;
  const r = await pool.query(`
    SELECT role FROM (
      SELECT role FROM org_members WHERE org_id=$1 AND agent_did=$2
      UNION ALL SELECT 'owner'::text AS role FROM orgs WHERE org_id=$1 AND owner_did=$2
    ) t WHERE role IN ('owner','admin') LIMIT 1
  `, [orgId, agentDid]).catch(() => ({ rows: [] }));
  return r.rows.length > 0;
}

// ----------------------------------------------------------------------------
// JIT provisioning — creates an agent identity if not already present
// ----------------------------------------------------------------------------
async function ensureAgentForEmail(pool, email) {
  if (!email) return null;
  // Stable DID derived from email so re-logins map to the same agent
  const fingerprint = cryptoLib.createHash('sha256').update(`sso:${email.toLowerCase()}`).digest('hex').slice(0, 32);
  const did = `did:op:${fingerprint}`;
  const r = await pool.query(`SELECT did FROM identities WHERE did=$1`, [did]).catch(() => ({ rows: [] }));
  if (r.rows[0]) return did;
  // Create deterministic placeholder identity (no priv key surfaced)
  const { publicKey } = cryptoLib.generateKeyPairSync('ed25519');
  const pubPem = publicKey.export({ type: 'spki', format: 'pem' });
  await pool.query(
    `INSERT INTO identities (did, public_key, metadata) VALUES ($1,$2,$3::jsonb)
     ON CONFLICT (did) DO NOTHING`,
    [did, pubPem, JSON.stringify({ jit_sso: true, email })]
  ).catch(() => {});
  return did;
}

// ----------------------------------------------------------------------------
// Session creation
// ----------------------------------------------------------------------------
async function createSession(pool, providerId, attrs) {
  const sessionId = genId('ssosess');
  const expiresAt = new Date(Date.now() + (parseInt(process.env.SSO_SESSION_TTL_SECONDS || '28800') * 1000));
  await pool.query(
    `INSERT INTO sso_sessions
     (session_id, provider_id, org_id, agent_did, email, idp_subject, attributes,
      expires_at, ip_address, user_agent)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10)`,
    [sessionId, providerId, attrs.org_id, attrs.agent_did || null, attrs.email || null,
     attrs.idp_subject || null, JSON.stringify(attrs.attributes || {}), expiresAt,
     attrs.ip_address || null, attrs.user_agent || null]
  );
  return { session_id: sessionId, expires_at: expiresAt.toISOString() };
}

async function recordLoginEvent(pool, providerId, email, success, failureReason, ipAddress) {
  await pool.query(
    `INSERT INTO sso_login_events (event_id, provider_id, email, success, failure_reason, ip_address)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [genId('ssoev'), providerId, email || null, !!success, failureReason || null, ipAddress || null]
  ).catch(() => {});
}

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  return fwd ? String(fwd).split(',')[0].trim() : (req.ip || 'unknown');
}

// ----------------------------------------------------------------------------
// Routes
// ----------------------------------------------------------------------------
function registerSsoRoutes(app, pool, verifyAgentAuth, auditChain) {
  const ProviderSchema = z.object({
    kind: z.enum(['saml', 'oidc']),
    name: z.string().min(1).max(200),
    idp_entity_id: z.string().optional(),
    idp_sso_url: z.string().url().optional(),
    idp_metadata_xml: z.string().optional(),
    idp_cert_pem: z.string().optional(),
    oidc_issuer_url: z.string().url().optional(),
    oidc_client_id: z.string().optional(),
    oidc_client_secret: z.string().optional(),
    default_role: z.enum(['admin', 'member', 'viewer']).optional(),
    jit_provisioning: z.boolean().optional()
  });

  // POST /v1/orgs/:id/sso/providers (admin only)
  app.post('/v1/orgs/:id/sso/providers', express.json({ limit: '1mb' }), async (req, res) => {
    try {
      const orgId = req.params.id;
      // Need agent_did from auth header; verify they're org admin
      const did = req.headers['x-agent-did'];
      if (!did) return res.status(401).json({ error: 'missing_agent_did' });
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      if (!(await isOrgAdmin(pool, orgId, did))) {
        return res.status(403).json({ error: 'requires_org_admin' });
      }
      const parse = ProviderSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;

      const providerId = genId('sso');

      // SAML: extract from metadata if not given explicitly
      let entityId = d.idp_entity_id || null;
      let ssoUrl = d.idp_sso_url || null;
      let certPem = d.idp_cert_pem || null;
      if (d.kind === 'saml' && d.idp_metadata_xml) {
        entityId = entityId || extractEntityIdFromMetadata(d.idp_metadata_xml);
        ssoUrl = ssoUrl || extractSsoUrlFromMetadata(d.idp_metadata_xml);
        certPem = certPem || extractCertFromMetadata(d.idp_metadata_xml);
      }

      // OIDC: encrypt client secret
      let secretBlob = null;
      if (d.kind === 'oidc' && d.oidc_client_secret) {
        secretBlob = encryptSecret(d.oidc_client_secret, providerId);
      }

      await pool.query(
        `INSERT INTO sso_providers
         (provider_id, org_id, kind, name, idp_entity_id, idp_sso_url, idp_metadata_xml,
          idp_cert_pem, oidc_issuer_url, oidc_client_id, oidc_client_secret_encrypted,
          default_role, jit_provisioning, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'active')`,
        [providerId, orgId, d.kind, d.name, entityId, ssoUrl, d.idp_metadata_xml || null,
         certPem, d.oidc_issuer_url || null, d.oidc_client_id || null, secretBlob,
         d.default_role || 'member', d.jit_provisioning !== false]
      );

      await auditChain.append({
        event_type: 'sso.provider_created',
        provider_id: providerId, org_id: orgId, kind: d.kind, name: d.name,
        actor_did: did, timestamp: new Date().toISOString()
      });

      return res.status(201).json({
        provider_id: providerId, org_id: orgId, kind: d.kind, name: d.name,
        status: 'active', default_role: d.default_role || 'member',
        jit_provisioning: d.jit_provisioning !== false,
        sp_metadata_url: `${process.env.OPERATOR_PUBLIC_URL || ''}/v1/sso/saml/${providerId}/metadata.xml`,
        acs_url: `${process.env.OPERATOR_PUBLIC_URL || ''}/v1/sso/saml/${providerId}/acs`,
        oidc_callback_url: `${process.env.OPERATOR_PUBLIC_URL || ''}/v1/sso/oidc/${providerId}/callback`
      });
    } catch (e) {
      console.error('[sso.provider_create]', e);
      return res.status(500).json({ error: 'create_failed', message: e.message });
    }
  });

  // GET /v1/orgs/:id/sso/providers
  app.get('/v1/orgs/:id/sso/providers', async (req, res) => {
    try {
      const orgId = req.params.id;
      const did = req.headers['x-agent-did'];
      if (did) {
        const auth = await verifyAgentAuth(req, did);
        if (!auth.valid) return res.status(401).json({ error: auth.error });
        if (!(await isOrgAdmin(pool, orgId, did))) {
          return res.status(403).json({ error: 'requires_org_admin' });
        }
      } else {
        const adminToken = req.headers['x-admin-token'];
        if (adminToken !== process.env.OPERATOR_ADMIN_TOKEN) return res.status(401).json({ error: 'unauthorized' });
      }
      const r = await pool.query(
        `SELECT provider_id, org_id, kind, name, idp_entity_id, idp_sso_url,
                oidc_issuer_url, oidc_client_id, default_role, jit_provisioning,
                status, created_at
         FROM sso_providers WHERE org_id=$1 ORDER BY created_at DESC`,
        [orgId]
      );
      return res.json({ providers: r.rows, count: r.rows.length });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  });

  // DELETE /v1/orgs/:id/sso/providers/:pid
  app.delete('/v1/orgs/:id/sso/providers/:pid', async (req, res) => {
    try {
      const { id: orgId, pid } = req.params;
      const did = req.headers['x-agent-did'];
      if (!did) return res.status(401).json({ error: 'missing_agent_did' });
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      if (!(await isOrgAdmin(pool, orgId, did))) {
        return res.status(403).json({ error: 'requires_org_admin' });
      }
      const r = await pool.query(
        `DELETE FROM sso_providers WHERE provider_id=$1 AND org_id=$2 RETURNING provider_id`,
        [pid, orgId]
      );
      if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
      await auditChain.append({
        event_type: 'sso.provider_deleted',
        provider_id: pid, org_id: orgId, actor_did: did,
        timestamp: new Date().toISOString()
      });
      return res.json({ provider_id: pid, deleted: true });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  });

  // POST /v1/sso/saml/:pid/acs (SAML AssertionConsumer)
  app.post('/v1/sso/saml/:pid/acs', express.urlencoded({ extended: true, limit: '5mb' }),
    express.json({ limit: '5mb' }),
    async (req, res) => {
      const pid = req.params.pid;
      const ipAddress = clientIp(req);
      try {
        const provider = await pool.query(
          `SELECT * FROM sso_providers WHERE provider_id=$1 AND kind='saml' AND status='active'`,
          [pid]
        );
        if (!provider.rows[0]) {
          await recordLoginEvent(pool, pid, null, false, 'provider_not_found', ipAddress);
          return res.status(404).json({ error: 'provider_not_found' });
        }
        const p = provider.rows[0];

        const samlResponseB64 = (req.body && req.body.SAMLResponse) || null;
        if (!samlResponseB64) {
          await recordLoginEvent(pool, pid, null, false, 'missing_saml_response', ipAddress);
          return res.status(400).json({ error: 'missing_SAMLResponse' });
        }
        let xml;
        try { xml = Buffer.from(samlResponseB64, 'base64').toString('utf8'); }
        catch { return res.status(400).json({ error: 'invalid_base64_saml' }); }

        const verification = verifySamlAssertion(xml, p.idp_cert_pem);
        if (!verification.valid) {
          await recordLoginEvent(pool, pid, null, false,
            verification.reason || 'saml_invalid', ipAddress);
          await auditChain.append({
            event_type: 'sso.login_failed', provider_id: pid, org_id: p.org_id,
            reason: verification.reason || 'saml_invalid',
            timestamp: new Date().toISOString()
          });
          return res.status(401).json({ error: 'saml_assertion_invalid', reason: verification.reason });
        }

        const attrs = verification.attributes.attributes || {};
        const email = (attrs.email && attrs.email[0]) ||
                      (attrs['urn:oid:0.9.2342.19200300.100.1.3'] && attrs['urn:oid:0.9.2342.19200300.100.1.3'][0]) ||
                      verification.attributes.nameId || null;

        let agentDid = null;
        if (p.jit_provisioning) {
          agentDid = await ensureAgentForEmail(pool, email);
        }

        const session = await createSession(pool, pid, {
          org_id: p.org_id,
          agent_did: agentDid,
          email,
          idp_subject: verification.attributes.nameId,
          attributes: attrs,
          ip_address: ipAddress,
          user_agent: req.headers['user-agent'] || null
        });

        await recordLoginEvent(pool, pid, email, true, null, ipAddress);
        await auditChain.append({
          event_type: 'sso.login_succeeded',
          provider_id: pid, org_id: p.org_id, agent_did: agentDid, email,
          session_id: session.session_id, timestamp: new Date().toISOString()
        });

        // RelayState support for redirect-style login
        const relayState = req.body && req.body.RelayState;
        if (relayState && /^https?:\/\//.test(relayState)) {
          const u = new URL(relayState);
          u.searchParams.set('sso_session', session.session_id);
          return res.redirect(302, u.toString());
        }
        return res.json({
          session_id: session.session_id, agent_did: agentDid, email,
          org_id: p.org_id, expires_at: session.expires_at
        });
      } catch (e) {
        console.error('[sso.acs]', e);
        await recordLoginEvent(pool, pid, null, false, 'internal_error', ipAddress);
        return res.status(500).json({ error: 'acs_failed', message: e.message });
      }
    });

  // GET /v1/sso/saml/:pid/metadata.xml — Service Provider metadata
  app.get('/v1/sso/saml/:pid/metadata.xml', async (req, res) => {
    const pid = req.params.pid;
    const provider = await pool.query(
      `SELECT * FROM sso_providers WHERE provider_id=$1 AND kind='saml'`,
      [pid]
    );
    if (!provider.rows[0]) return res.status(404).json({ error: 'provider_not_found' });
    const baseUrl = process.env.OPERATOR_PUBLIC_URL || '';
    const acsUrl = `${baseUrl}/v1/sso/saml/${pid}/acs`;
    const entityId = `${baseUrl}/v1/sso/saml/${pid}`;
    const xml = `<?xml version="1.0"?>
<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="${entityId}">
  <md:SPSSODescriptor AuthnRequestsSigned="false" WantAssertionsSigned="true" protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    <md:NameIDFormat>urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress</md:NameIDFormat>
    <md:AssertionConsumerService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="${acsUrl}" index="0"/>
  </md:SPSSODescriptor>
</md:EntityDescriptor>`;
    res.setHeader('content-type', 'application/xml');
    res.send(xml);
  });

  // GET /v1/sso/oidc/:pid/callback?code=...
  app.get('/v1/sso/oidc/:pid/callback', async (req, res) => {
    const pid = req.params.pid;
    const ipAddress = clientIp(req);
    const code = req.query.code;
    if (!code) return res.status(400).json({ error: 'missing_code' });
    try {
      const provider = await pool.query(
        `SELECT * FROM sso_providers WHERE provider_id=$1 AND kind='oidc' AND status='active'`,
        [pid]
      );
      if (!provider.rows[0]) return res.status(404).json({ error: 'provider_not_found' });
      const p = provider.rows[0];

      let discovery;
      try { discovery = await getOidcDiscovery(p.oidc_issuer_url); }
      catch (e) {
        await recordLoginEvent(pool, pid, null, false, 'discovery_failed', ipAddress);
        return res.status(502).json({ error: 'oidc_discovery_failed', message: e.message });
      }

      const clientSecret = decryptSecret(p.oidc_client_secret_encrypted, pid);
      const baseUrl = process.env.OPERATOR_PUBLIC_URL || '';
      const redirectUri = `${baseUrl}/v1/sso/oidc/${pid}/callback`;

      // Exchange code for tokens
      let tokens;
      try {
        if (typeof fetch !== 'function') throw new Error('fetch_not_available');
        const body = new URLSearchParams({
          grant_type: 'authorization_code',
          code: String(code),
          redirect_uri: redirectUri,
          client_id: p.oidc_client_id,
          client_secret: clientSecret || ''
        });
        const r = await fetch(discovery.token_endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body
        });
        tokens = await r.json();
        if (!r.ok || tokens.error) throw new Error(tokens.error_description || tokens.error || `http_${r.status}`);
      } catch (e) {
        await recordLoginEvent(pool, pid, null, false, 'token_exchange_failed', ipAddress);
        return res.status(502).json({ error: 'token_exchange_failed', message: e.message });
      }

      const idToken = tokens.id_token;
      if (!idToken) {
        await recordLoginEvent(pool, pid, null, false, 'missing_id_token', ipAddress);
        return res.status(502).json({ error: 'missing_id_token' });
      }

      const verification = await validateOidcIdToken(idToken, discovery.jwks_uri);
      if (!verification.valid) {
        await recordLoginEvent(pool, pid, null, false, verification.reason, ipAddress);
        await auditChain.append({
          event_type: 'sso.login_failed', provider_id: pid, org_id: p.org_id,
          reason: verification.reason, timestamp: new Date().toISOString()
        });
        return res.status(401).json({ error: 'id_token_invalid', reason: verification.reason });
      }

      const claims = verification.payload || {};
      const email = claims.email || claims.preferred_username || claims.sub;
      let agentDid = null;
      if (p.jit_provisioning) agentDid = await ensureAgentForEmail(pool, email);

      const session = await createSession(pool, pid, {
        org_id: p.org_id, agent_did: agentDid, email,
        idp_subject: claims.sub, attributes: claims,
        ip_address: ipAddress, user_agent: req.headers['user-agent'] || null
      });

      await recordLoginEvent(pool, pid, email, true, null, ipAddress);
      await auditChain.append({
        event_type: 'sso.login_succeeded', provider_id: pid, org_id: p.org_id,
        agent_did: agentDid, email, session_id: session.session_id,
        timestamp: new Date().toISOString()
      });

      const state = req.query.state;
      if (state && typeof state === 'string' && /^https?:\/\//.test(state)) {
        const u = new URL(state);
        u.searchParams.set('sso_session', session.session_id);
        return res.redirect(302, u.toString());
      }
      return res.json({
        session_id: session.session_id, agent_did: agentDid, email,
        org_id: p.org_id, expires_at: session.expires_at
      });
    } catch (e) {
      console.error('[sso.oidc.callback]', e);
      await recordLoginEvent(pool, pid, null, false, 'internal_error', ipAddress);
      return res.status(500).json({ error: 'oidc_callback_failed', message: e.message });
    }
  });

  // POST /v1/sso/sessions/:sid/logout
  app.post('/v1/sso/sessions/:sid/logout', express.json(), async (req, res) => {
    try {
      const sid = req.params.sid;
      const r = await pool.query(
        `UPDATE sso_sessions SET revoked_at=NOW() WHERE session_id=$1 AND revoked_at IS NULL
         RETURNING session_id, agent_did, org_id, provider_id`,
        [sid]
      );
      if (!r.rows[0]) return res.status(404).json({ error: 'session_not_found_or_already_revoked' });
      const s = r.rows[0];
      await auditChain.append({
        event_type: 'sso.session_logout', session_id: sid,
        provider_id: s.provider_id, org_id: s.org_id, agent_did: s.agent_did,
        timestamp: new Date().toISOString()
      });
      return res.json({ session_id: sid, revoked: true });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  });

  // GET /v1/orgs/:id/sso/login-events
  app.get('/v1/orgs/:id/sso/login-events', async (req, res) => {
    try {
      const orgId = req.params.id;
      const did = req.headers['x-agent-did'];
      if (did) {
        const auth = await verifyAgentAuth(req, did);
        if (!auth.valid) return res.status(401).json({ error: auth.error });
        if (!(await isOrgAdmin(pool, orgId, did))) {
          return res.status(403).json({ error: 'requires_org_admin' });
        }
      } else {
        const adminToken = req.headers['x-admin-token'];
        if (adminToken !== process.env.OPERATOR_ADMIN_TOKEN) return res.status(401).json({ error: 'unauthorized' });
      }
      const limit = Math.min(parseInt(req.query.limit) || 100, 1000);
      const r = await pool.query(`
        SELECT e.event_id, e.provider_id, e.email, e.success, e.failure_reason,
               e.ip_address, e.occurred_at, p.name AS provider_name, p.kind
          FROM sso_login_events e
          JOIN sso_providers p ON p.provider_id = e.provider_id
         WHERE p.org_id = $1
         ORDER BY e.occurred_at DESC
         LIMIT $2
      `, [orgId, limit]);
      return res.json({ events: r.rows, count: r.rows.length });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  });
}

module.exports = {
  migrate,
  registerSsoRoutes,
  // helpers
  createSession,
  verifySamlAssertion,
  validateOidcIdToken,
  extractSamlAttributes,
  extractCertFromMetadata,
  extractSsoUrlFromMetadata,
  extractEntityIdFromMetadata,
  encryptSecret,
  decryptSecret,
  ensureAgentForEmail,
  isOrgAdmin
};
