// ============================================================================
// OpenHeab Inbox — Signed DID-routed A2A messaging
// Ed25519 signatures over METHOD\nPATH\nSHA256(body)\nTIMESTAMP, with per-sender
// + total hourly rate limits driven by inbox_policies.
// ============================================================================
const cryptoLib = require('crypto');
const express = require('express');
const { z } = require('zod');

// ----------------------------------------------------------------------------
// Migration
// ----------------------------------------------------------------------------
async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS inbox_envelopes (
      envelope_id          TEXT PRIMARY KEY,
      recipient_did        TEXT NOT NULL,
      sender_did           TEXT,
      sender_smtp_from     TEXT,
      sender_verified      BOOLEAN NOT NULL DEFAULT FALSE,
      sender_tier          TEXT,
      sender_reputation    REAL,
      intent_classified    TEXT,
      intent_confidence    REAL,
      action_hint          TEXT,
      params_hint          JSONB,
      body_type            TEXT,
      body_structured      JSONB,
      body_plain           TEXT,
      body_hash            TEXT,
      attachments          JSONB,
      signature_alg        TEXT,
      signature_value      TEXT,
      audit_chain_entry    TEXT,
      received_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at           TIMESTAMPTZ,
      status               TEXT NOT NULL DEFAULT 'unread',
      policies_applied     JSONB,
      in_reply_to          TEXT,
      thread_root          TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_inbox_recipient ON inbox_envelopes (recipient_did, received_at DESC);
    CREATE INDEX IF NOT EXISTS idx_inbox_sender ON inbox_envelopes (sender_did);
    CREATE INDEX IF NOT EXISTS idx_inbox_status ON inbox_envelopes (recipient_did, status);
    CREATE INDEX IF NOT EXISTS idx_inbox_thread ON inbox_envelopes (thread_root);
    CREATE INDEX IF NOT EXISTS idx_inbox_expires ON inbox_envelopes (expires_at) WHERE expires_at IS NOT NULL;

    CREATE TABLE IF NOT EXISTS inbox_policies (
      agent_did                     TEXT PRIMARY KEY,
      require_signature             BOOLEAN NOT NULL DEFAULT FALSE,
      allow_unverified              BOOLEAN NOT NULL DEFAULT TRUE,
      max_per_sender_per_hour       INTEGER NOT NULL DEFAULT 60,
      max_total_per_hour            INTEGER NOT NULL DEFAULT 600,
      min_reputation                REAL NOT NULL DEFAULT 0,
      block_list                    JSONB NOT NULL DEFAULT '[]'::jsonb,
      allow_list                    JSONB NOT NULL DEFAULT '[]'::jsonb,
      auto_classify_intent          BOOLEAN NOT NULL DEFAULT TRUE,
      retention_days                INTEGER NOT NULL DEFAULT 90,
      updated_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS inbox_rate_log (
      recipient_did   TEXT NOT NULL,
      sender_did      TEXT,
      window_start    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_rate_log_recipient ON inbox_rate_log (recipient_did, window_start DESC);
    CREATE INDEX IF NOT EXISTS idx_rate_log_sender_recipient ON inbox_rate_log (recipient_did, sender_did, window_start DESC);
  `);
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------
function hashBody(body) {
  const str = typeof body === 'string' ? body : JSON.stringify(body || {});
  return cryptoLib.createHash('sha256').update(str).digest('hex');
}

function buildCanonicalSigPayload(method, path, body, timestamp) {
  return `${method}\n${path}\n${hashBody(body)}\n${timestamp}`;
}

async function verifyEnvelopeSignature(pool, senderDid, payload, signature) {
  if (!senderDid || !signature) return { valid: false, reason: 'missing' };
  const r = await pool.query(
    `SELECT public_key FROM identity_keys WHERE agent_did=$1 AND status='active'
     UNION ALL
     SELECT public_key FROM identities WHERE did=$1 LIMIT 1`,
    [senderDid]
  ).catch(() => ({ rows: [] }));
  if (!r.rows[0]) return { valid: false, reason: 'unknown_sender' };
  try {
    const pub = cryptoLib.createPublicKey(r.rows[0].public_key);
    const ok = cryptoLib.verify(null, Buffer.from(payload), pub, Buffer.from(signature, 'hex'));
    return { valid: ok, reason: ok ? null : 'invalid_signature' };
  } catch (e) {
    return { valid: false, reason: 'verification_failed' };
  }
}

async function getPolicy(pool, did) {
  const r = await pool.query(
    `SELECT * FROM inbox_policies WHERE agent_did=$1`, [did]
  ).catch(() => ({ rows: [] }));
  if (r.rows[0]) return r.rows[0];
  return {
    agent_did: did,
    require_signature: false,
    allow_unverified: true,
    max_per_sender_per_hour: 60,
    max_total_per_hour: 600,
    min_reputation: 0,
    block_list: [],
    allow_list: [],
    auto_classify_intent: true,
    retention_days: 90
  };
}

async function applyRateLimits(pool, recipientDid, senderDid, policy) {
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  const totalR = await pool.query(
    `SELECT COUNT(*) AS n FROM inbox_rate_log WHERE recipient_did=$1 AND window_start >= $2`,
    [recipientDid, oneHourAgo]
  ).catch(() => ({ rows: [{ n: 0 }] }));
  const totalCount = parseInt(totalR.rows[0].n);

  if (totalCount >= policy.max_total_per_hour) {
    return { allowed: false, reason: 'total_rate_limit_exceeded', count: totalCount };
  }

  if (senderDid) {
    const senderR = await pool.query(
      `SELECT COUNT(*) AS n FROM inbox_rate_log
       WHERE recipient_did=$1 AND sender_did=$2 AND window_start >= $3`,
      [recipientDid, senderDid, oneHourAgo]
    ).catch(() => ({ rows: [{ n: 0 }] }));
    if (parseInt(senderR.rows[0].n) >= policy.max_per_sender_per_hour) {
      return { allowed: false, reason: 'per_sender_rate_limit_exceeded', count: parseInt(senderR.rows[0].n) };
    }
  }

  await pool.query(
    `INSERT INTO inbox_rate_log (recipient_did, sender_did) VALUES ($1, $2)`,
    [recipientDid, senderDid || null]
  ).catch(() => {});

  return { allowed: true, total_count: totalCount };
}

function classifyIntent(text) {
  if (!text) return { intent: 'unknown', confidence: 0, action: null };
  const lower = text.toLowerCase();
  const patterns = [
    { intent: 'payment_request', kw: ['invoice', 'pay ', 'amount due', 'payment of'], action: 'review_payment' },
    { intent: 'meeting_request', kw: ['meeting', 'schedule', 'calendar', 'availability'], action: 'check_calendar' },
    { intent: 'support_request', kw: ['help', 'issue', 'broken', 'error', 'bug'], action: 'open_ticket' },
    { intent: 'sales_inquiry',  kw: ['interested in', 'pricing', 'quote', 'demo'], action: 'follow_up_sales' },
    { intent: 'collaboration',  kw: ['collaborate', 'partner', 'work together'], action: 'evaluate_proposal' },
    { intent: 'notification',   kw: ['notification', 'alert', 'fyi', 'reminder'], action: 'noop' }
  ];
  for (const p of patterns) {
    for (const kw of p.kw) {
      if (lower.includes(kw)) return { intent: p.intent, confidence: 0.65, action: p.action };
    }
  }
  return { intent: 'general', confidence: 0.3, action: null };
}

// ----------------------------------------------------------------------------
// Idempotency
// ----------------------------------------------------------------------------
async function checkIdempotency(pool, agentDid, key, scope) {
  if (!key) return null;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS inbox_idempotency (
      agent_did TEXT NOT NULL,
      scope TEXT NOT NULL,
      idem_key TEXT NOT NULL,
      response JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (agent_did, scope, idem_key)
    )`).catch(() => {});
  const r = await pool.query(
    `SELECT response FROM inbox_idempotency WHERE agent_did=$1 AND scope=$2 AND idem_key=$3`,
    [agentDid, scope, key]
  ).catch(() => ({ rows: [] }));
  return r.rows[0]?.response || null;
}

async function recordIdempotency(pool, agentDid, key, scope, response) {
  if (!key) return;
  await pool.query(
    `INSERT INTO inbox_idempotency (agent_did, scope, idem_key, response)
     VALUES ($1,$2,$3,$4::jsonb) ON CONFLICT DO NOTHING`,
    [agentDid, scope, key, JSON.stringify(response)]
  ).catch(() => {});
}

// ----------------------------------------------------------------------------
// Routes
// ----------------------------------------------------------------------------
function registerInboxRoutes(app, pool, verifyAgentAuth, auditChain) {
  // POST /v1/agents/:did/inbox/receive — receive an envelope
  const ReceiveSchema = z.object({
    sender_did: z.string().optional(),
    sender_smtp_from: z.string().email().optional(),
    body_type: z.enum(['structured', 'plain', 'mixed']).default('plain'),
    body_structured: z.any().optional(),
    body_plain: z.string().optional(),
    attachments: z.array(z.object({
      filename: z.string(),
      mime: z.string(),
      size: z.number().int().nonnegative(),
      sha256: z.string()
    })).optional(),
    in_reply_to: z.string().optional(),
    thread_root: z.string().optional(),
    timestamp: z.string().optional(),
    signature_alg: z.string().optional(),
    signature_value: z.string().optional()
  });

  app.post('/v1/agents/:did/inbox/receive', express.json({ limit: '5mb' }), async (req, res) => {
    try {
      const recipientDid = req.params.did;
      const parse = ReceiveSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const data = parse.data;

      const idemKey = req.headers['x-idempotency-key'];
      const cached = await checkIdempotency(pool, recipientDid, idemKey, 'receive');
      if (cached) return res.status(200).json(cached);

      const policy = await getPolicy(pool, recipientDid);

      // Block list / allow list
      const blockList = Array.isArray(policy.block_list) ? policy.block_list : (policy.block_list || []);
      const allowList = Array.isArray(policy.allow_list) ? policy.allow_list : (policy.allow_list || []);
      if (data.sender_did && blockList.includes(data.sender_did)) {
        return res.status(403).json({ error: 'sender_blocked' });
      }
      if (allowList.length > 0 && data.sender_did && !allowList.includes(data.sender_did)) {
        return res.status(403).json({ error: 'sender_not_in_allow_list' });
      }

      // Rate limits
      const rateOk = await applyRateLimits(pool, recipientDid, data.sender_did || null, policy);
      if (!rateOk.allowed) return res.status(429).json({ error: rateOk.reason, count: rateOk.count });

      // Signature verification
      let senderVerified = false;
      const policiesApplied = { require_signature: policy.require_signature };
      if (data.signature_value && data.sender_did) {
        const ts = data.timestamp || new Date().toISOString();
        const path = req.originalUrl || req.url;
        const canonical = buildCanonicalSigPayload(req.method, path, req.body, ts);
        const v = await verifyEnvelopeSignature(pool, data.sender_did, canonical, data.signature_value);
        senderVerified = v.valid;
        policiesApplied.signature_check = v;
      }
      if (policy.require_signature && !senderVerified) {
        return res.status(401).json({ error: 'signature_required_but_invalid_or_missing' });
      }
      if (!policy.allow_unverified && !senderVerified) {
        return res.status(403).json({ error: 'unverified_senders_not_allowed' });
      }

      // Intent classification
      let intent = { intent: null, confidence: null, action: null };
      if (policy.auto_classify_intent) {
        const text = data.body_plain || (data.body_structured && JSON.stringify(data.body_structured)) || '';
        intent = classifyIntent(text);
      }

      const envelopeId = 'env_' + cryptoLib.randomBytes(16).toString('hex');
      const bodyHash = hashBody(data.body_structured || data.body_plain || '');
      const retentionDays = policy.retention_days || 90;
      const expiresAt = new Date(Date.now() + retentionDays * 24 * 60 * 60 * 1000);

      const chainEntry = await auditChain.append({
        event_type: 'inbox.envelope_received',
        envelope_id: envelopeId,
        recipient_did: recipientDid,
        sender_did: data.sender_did || null,
        sender_verified: senderVerified,
        intent: intent.intent,
        body_hash: bodyHash,
        timestamp: new Date().toISOString()
      });

      await pool.query(
        `INSERT INTO inbox_envelopes
         (envelope_id, recipient_did, sender_did, sender_smtp_from, sender_verified,
          intent_classified, intent_confidence, action_hint,
          body_type, body_structured, body_plain, body_hash, attachments,
          signature_alg, signature_value, audit_chain_entry, expires_at,
          status, policies_applied, in_reply_to, thread_root)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13::jsonb,$14,$15,$16,$17,
                 'unread',$18::jsonb,$19,$20)`,
        [envelopeId, recipientDid, data.sender_did || null, data.sender_smtp_from || null,
         senderVerified, intent.intent, intent.confidence, intent.action,
         data.body_type, data.body_structured ? JSON.stringify(data.body_structured) : null,
         data.body_plain || null, bodyHash,
         data.attachments ? JSON.stringify(data.attachments) : null,
         data.signature_alg || null, data.signature_value || null,
         chainEntry.hash, expiresAt,
         JSON.stringify(policiesApplied), data.in_reply_to || null,
         data.thread_root || data.in_reply_to || envelopeId]
      );

      const response = {
        envelope_id: envelopeId,
        recipient_did: recipientDid,
        sender_did: data.sender_did || null,
        sender_verified: senderVerified,
        intent_classified: intent.intent,
        intent_confidence: intent.confidence,
        action_hint: intent.action,
        body_hash: bodyHash,
        received_at: new Date().toISOString(),
        expires_at: expiresAt.toISOString(),
        audit_chain_entry: chainEntry.hash,
        status: 'unread'
      };
      await recordIdempotency(pool, recipientDid, idemKey, 'receive', response);
      return res.status(201).json(response);
    } catch (e) {
      console.error('[inbox.receive]', e);
      return res.status(500).json({ error: 'receive_failed', message: e.message });
    }
  });

  // GET /v1/agents/:did/inbox — list envelopes
  app.get('/v1/agents/:did/inbox', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });

    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const offset = Math.max(parseInt(req.query.offset) || 0, 0);
    const status = req.query.status;
    const params = [did, limit, offset];
    let where = `recipient_did=$1`;
    if (status) { params.push(status); where += ` AND status=$${params.length}`; }

    const r = await pool.query(
      `SELECT envelope_id, recipient_did, sender_did, sender_verified,
              intent_classified, intent_confidence, action_hint,
              body_type, body_plain, body_hash, received_at, expires_at, status,
              in_reply_to, thread_root
       FROM inbox_envelopes WHERE ${where}
       ORDER BY received_at DESC LIMIT $2 OFFSET $3`,
      params
    ).catch(() => ({ rows: [] }));
    return res.json({ envelopes: r.rows, count: r.rows.length });
  });

  // GET /v1/agents/:did/inbox/:envelopeId
  app.get('/v1/agents/:did/inbox/:envelopeId', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });

    const r = await pool.query(
      `SELECT * FROM inbox_envelopes WHERE envelope_id=$1 AND recipient_did=$2`,
      [req.params.envelopeId, did]
    ).catch(() => ({ rows: [] }));
    if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
    return res.json(r.rows[0]);
  });

  // POST /v1/agents/:did/inbox/:envelopeId/ack
  const AckSchema = z.object({
    new_status: z.enum(['read', 'archived', 'actioned', 'dismissed']).default('read')
  });
  app.post('/v1/agents/:did/inbox/:envelopeId/ack', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const parse = AckSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });

      const r = await pool.query(
        `UPDATE inbox_envelopes SET status=$1
         WHERE envelope_id=$2 AND recipient_did=$3 RETURNING envelope_id, status`,
        [parse.data.new_status, req.params.envelopeId, did]
      ).catch(() => ({ rows: [] }));
      if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });

      await auditChain.append({
        event_type: 'inbox.envelope_acked',
        envelope_id: req.params.envelopeId,
        recipient_did: did,
        new_status: parse.data.new_status,
        timestamp: new Date().toISOString()
      });
      return res.json(r.rows[0]);
    } catch (e) {
      console.error('[inbox.ack]', e);
      return res.status(500).json({ error: 'ack_failed', message: e.message });
    }
  });

  // POST /v1/agents/:did/inbox/:envelopeId/reply
  const ReplySchema = z.object({
    body_type: z.enum(['structured', 'plain', 'mixed']).default('plain'),
    body_structured: z.any().optional(),
    body_plain: z.string().optional()
  });

  app.post('/v1/agents/:did/inbox/:envelopeId/reply', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const parse = ReplySchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });

      const orig = await pool.query(
        `SELECT sender_did, thread_root FROM inbox_envelopes WHERE envelope_id=$1 AND recipient_did=$2`,
        [req.params.envelopeId, did]
      ).catch(() => ({ rows: [] }));
      if (!orig.rows[0]) return res.status(404).json({ error: 'not_found' });
      const origRow = orig.rows[0];
      if (!origRow.sender_did) return res.status(400).json({ error: 'cannot_reply_no_sender' });

      const envelopeId = 'env_' + cryptoLib.randomBytes(16).toString('hex');
      const bodyHash = hashBody(parse.data.body_structured || parse.data.body_plain || '');
      const threadRoot = origRow.thread_root || req.params.envelopeId;

      const chainEntry = await auditChain.append({
        event_type: 'inbox.reply_sent',
        envelope_id: envelopeId,
        sender_did: did,
        recipient_did: origRow.sender_did,
        in_reply_to: req.params.envelopeId,
        thread_root: threadRoot,
        timestamp: new Date().toISOString()
      });

      await pool.query(
        `INSERT INTO inbox_envelopes
         (envelope_id, recipient_did, sender_did, sender_verified, body_type,
          body_structured, body_plain, body_hash, audit_chain_entry,
          status, in_reply_to, thread_root)
         VALUES ($1,$2,$3,TRUE,$4,$5::jsonb,$6,$7,$8,'unread',$9,$10)`,
        [envelopeId, origRow.sender_did, did, parse.data.body_type,
         parse.data.body_structured ? JSON.stringify(parse.data.body_structured) : null,
         parse.data.body_plain || null, bodyHash, chainEntry.hash,
         req.params.envelopeId, threadRoot]
      );

      return res.status(201).json({
        envelope_id: envelopeId,
        sender_did: did,
        recipient_did: origRow.sender_did,
        in_reply_to: req.params.envelopeId,
        thread_root: threadRoot,
        audit_chain_entry: chainEntry.hash
      });
    } catch (e) {
      console.error('[inbox.reply]', e);
      return res.status(500).json({ error: 'reply_failed', message: e.message });
    }
  });

  // GET /v1/agents/:did/inbox/policies
  app.get('/v1/agents/:did/inbox/policies', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const p = await getPolicy(pool, did);
    return res.json(p);
  });

  // PUT /v1/agents/:did/inbox/policies
  const PolicySchema = z.object({
    require_signature: z.boolean().optional(),
    allow_unverified: z.boolean().optional(),
    max_per_sender_per_hour: z.number().int().positive().max(10000).optional(),
    max_total_per_hour: z.number().int().positive().max(100000).optional(),
    min_reputation: z.number().min(0).max(1).optional(),
    block_list: z.array(z.string()).optional(),
    allow_list: z.array(z.string()).optional(),
    auto_classify_intent: z.boolean().optional(),
    retention_days: z.number().int().positive().max(3650).optional()
  });

  app.put('/v1/agents/:did/inbox/policies', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const parse = PolicySchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;

      await pool.query(
        `INSERT INTO inbox_policies
         (agent_did, require_signature, allow_unverified, max_per_sender_per_hour,
          max_total_per_hour, min_reputation, block_list, allow_list,
          auto_classify_intent, retention_days, updated_at)
         VALUES ($1,
                 COALESCE($2, FALSE),
                 COALESCE($3, TRUE),
                 COALESCE($4, 60),
                 COALESCE($5, 600),
                 COALESCE($6, 0),
                 COALESCE($7::jsonb, '[]'::jsonb),
                 COALESCE($8::jsonb, '[]'::jsonb),
                 COALESCE($9, TRUE),
                 COALESCE($10, 90),
                 NOW())
         ON CONFLICT (agent_did) DO UPDATE SET
           require_signature = COALESCE($2, inbox_policies.require_signature),
           allow_unverified = COALESCE($3, inbox_policies.allow_unverified),
           max_per_sender_per_hour = COALESCE($4, inbox_policies.max_per_sender_per_hour),
           max_total_per_hour = COALESCE($5, inbox_policies.max_total_per_hour),
           min_reputation = COALESCE($6, inbox_policies.min_reputation),
           block_list = COALESCE($7::jsonb, inbox_policies.block_list),
           allow_list = COALESCE($8::jsonb, inbox_policies.allow_list),
           auto_classify_intent = COALESCE($9, inbox_policies.auto_classify_intent),
           retention_days = COALESCE($10, inbox_policies.retention_days),
           updated_at = NOW()`,
        [did,
         d.require_signature ?? null, d.allow_unverified ?? null,
         d.max_per_sender_per_hour ?? null, d.max_total_per_hour ?? null,
         d.min_reputation ?? null,
         d.block_list ? JSON.stringify(d.block_list) : null,
         d.allow_list ? JSON.stringify(d.allow_list) : null,
         d.auto_classify_intent ?? null, d.retention_days ?? null]
      );

      await auditChain.append({
        event_type: 'inbox.policy_updated',
        agent_did: did, fields: Object.keys(d),
        timestamp: new Date().toISOString()
      });

      const p = await getPolicy(pool, did);
      return res.json(p);
    } catch (e) {
      console.error('[inbox.policy.update]', e);
      return res.status(500).json({ error: 'policy_update_failed', message: e.message });
    }
  });

  // GET /v1/agents/:did/inbox/address
  app.get('/v1/agents/:did/inbox/address', async (req, res) => {
    const did = req.params.did;
    const baseUrl = process.env.OPERATOR_PUBLIC_URL || 'https://openheab.example';
    const tag = did.replace(/^did:op:/, '');
    return res.json({
      agent_did: did,
      inbox_url: `${baseUrl}/v1/agents/${encodeURIComponent(did)}/inbox/receive`,
      smtp_alias: `${tag}@inbox.${(new URL(baseUrl)).hostname}`,
      did_endpoint: `${baseUrl}/v1/identities/${encodeURIComponent(did)}`
    });
  });
}

// ----------------------------------------------------------------------------
// Cron: cleanup expired envelopes
// ----------------------------------------------------------------------------
async function cleanupExpiredEnvelopes(pool, auditChain) {
  const r = await pool.query(
    `DELETE FROM inbox_envelopes WHERE expires_at IS NOT NULL AND expires_at < NOW()
     RETURNING envelope_id`
  ).catch(() => ({ rows: [] }));
  await pool.query(
    `DELETE FROM inbox_rate_log WHERE window_start < NOW() - INTERVAL '2 hours'`
  ).catch(() => {});
  if (r.rows.length && auditChain) {
    await auditChain.append({
      event_type: 'inbox.envelopes_expired',
      count: r.rows.length,
      timestamp: new Date().toISOString()
    });
  }
  return { expired: r.rows.length };
}

module.exports = {
  migrate,
  registerInboxRoutes,
  cleanupExpiredEnvelopes,
  hashBody,
  buildCanonicalSigPayload,
  verifyEnvelopeSignature,
  classifyIntent,
  getPolicy
};
