// ============================================================================
// OpenHeab Email — Agent-Owned @openheab.com Addresses
// MIME assembly, gateway relay with HMAC, inbound webhook ingestion, DSNs.
// ============================================================================
const cryptoLib = require('crypto');
const express = require('express');
const { z } = require('zod');

const EMAIL_DOMAIN = process.env.EMAIL_DOMAIN || 'openheab.com';
const EMAIL_DID_SUBDOMAIN = process.env.EMAIL_DID_SUBDOMAIN || 'inbox.openheab.com';
const LOCAL_PART_RE = /^[a-z0-9]([a-z0-9._-]{0,62}[a-z0-9])?$/;

const RESERVED_LOCAL_PARTS = [
  'postmaster', 'abuse', 'hostmaster', 'admin', 'root',
  'noreply', 'no-reply', 'support', 'security', 'webmaster', 'mailer-daemon'
];

// ----------------------------------------------------------------------------
// Migration
// ----------------------------------------------------------------------------
async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS email_addresses (
      address      TEXT PRIMARY KEY,
      agent_did    TEXT NOT NULL,
      domain       TEXT NOT NULL,
      local_part   TEXT NOT NULL,
      is_primary   BOOLEAN NOT NULL DEFAULT FALSE,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_email_addresses_did ON email_addresses (agent_did);

    CREATE TABLE IF NOT EXISTS email_messages (
      message_id     TEXT PRIMARY KEY,
      direction      TEXT NOT NULL,
      agent_did      TEXT NOT NULL,
      from_address   TEXT NOT NULL,
      to_address     TEXT NOT NULL,
      cc_addresses   TEXT[],
      subject        TEXT,
      body_text      TEXT,
      body_html      TEXT,
      headers        JSONB,
      attachments    JSONB,
      spam_score     REAL,
      dkim_pass      BOOLEAN,
      spf_pass       BOOLEAN,
      dmarc_pass     BOOLEAN,
      raw_size_bytes INTEGER,
      status         TEXT NOT NULL DEFAULT 'queued',
      bounce_reason  TEXT,
      audit_hash     TEXT,
      in_reply_to    TEXT,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      delivered_at   TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_email_messages_did ON email_messages (agent_did, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_email_messages_dir ON email_messages (agent_did, direction, created_at DESC);

    CREATE TABLE IF NOT EXISTS email_reserved_local_parts (
      local_part TEXT PRIMARY KEY,
      reason     TEXT,
      added_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS email_idempotency (
      agent_did   TEXT NOT NULL,
      scope       TEXT NOT NULL,
      idem_key    TEXT NOT NULL,
      response    JSONB NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (agent_did, scope, idem_key)
    );
  `);

  // Seed reserved
  for (const lp of RESERVED_LOCAL_PARTS) {
    await pool.query(
      `INSERT INTO email_reserved_local_parts (local_part, reason)
       VALUES ($1, 'system_reserved') ON CONFLICT DO NOTHING`,
      [lp]
    ).catch(() => {});
  }
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------
function genId(prefix) {
  return `${prefix}_${cryptoLib.randomBytes(12).toString('hex')}`;
}

function didShort(did) {
  return String(did || '').replace(/^did:op:/, '').slice(0, 24).toLowerCase();
}

function didEmailAddress(did) {
  return `${didShort(did)}@${EMAIL_DID_SUBDOMAIN}`;
}

async function checkIdempotency(pool, agentDid, key, scope) {
  if (!key) return null;
  const r = await pool.query(
    `SELECT response FROM email_idempotency WHERE agent_did=$1 AND scope=$2 AND idem_key=$3`,
    [agentDid, scope, key]
  ).catch(() => ({ rows: [] }));
  return r.rows[0]?.response || null;
}

async function recordIdempotency(pool, agentDid, key, scope, response) {
  if (!key) return;
  await pool.query(
    `INSERT INTO email_idempotency (agent_did, scope, idem_key, response)
     VALUES ($1,$2,$3,$4::jsonb) ON CONFLICT DO NOTHING`,
    [agentDid, scope, key, JSON.stringify(response)]
  ).catch(() => {});
}

function quotePrintable(s) {
  // Minimal Q-P encode for header words
  return Buffer.from(s, 'utf8').toString('base64');
}

function encodeHeaderWord(s) {
  if (!s) return '';
  if (/^[\x20-\x7E]+$/.test(s)) return s;
  return `=?UTF-8?B?${quotePrintable(s)}?=`;
}

function buildMime({ from, to, cc = [], subject, bodyText, bodyHtml, headers = {}, inReplyTo, messageId }) {
  const boundary = `bnd_${cryptoLib.randomBytes(12).toString('hex')}`;
  const lines = [];
  lines.push(`Message-ID: <${messageId}@${EMAIL_DOMAIN}>`);
  lines.push(`Date: ${new Date().toUTCString()}`);
  lines.push(`From: ${encodeHeaderWord(from)}`);
  lines.push(`To: ${Array.isArray(to) ? to.join(', ') : to}`);
  if (cc && cc.length) lines.push(`Cc: ${cc.join(', ')}`);
  lines.push(`Subject: ${encodeHeaderWord(subject || '')}`);
  lines.push(`MIME-Version: 1.0`);
  if (inReplyTo) lines.push(`In-Reply-To: <${inReplyTo}>`);
  for (const [k, v] of Object.entries(headers || {})) {
    if (/^(from|to|cc|subject|date|message-id|mime-version|content-type|in-reply-to)$/i.test(k)) continue;
    lines.push(`${k}: ${String(v).replace(/\r|\n/g, '')}`);
  }
  if (bodyHtml && bodyText) {
    lines.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    lines.push('');
    lines.push(`--${boundary}`);
    lines.push('Content-Type: text/plain; charset="UTF-8"');
    lines.push('Content-Transfer-Encoding: 8bit');
    lines.push('');
    lines.push(bodyText);
    lines.push(`--${boundary}`);
    lines.push('Content-Type: text/html; charset="UTF-8"');
    lines.push('Content-Transfer-Encoding: 8bit');
    lines.push('');
    lines.push(bodyHtml);
    lines.push(`--${boundary}--`);
  } else if (bodyHtml) {
    lines.push('Content-Type: text/html; charset="UTF-8"');
    lines.push('Content-Transfer-Encoding: 8bit');
    lines.push('');
    lines.push(bodyHtml);
  } else {
    lines.push('Content-Type: text/plain; charset="UTF-8"');
    lines.push('Content-Transfer-Encoding: 8bit');
    lines.push('');
    lines.push(bodyText || '');
  }
  return lines.join('\r\n');
}

function hmacSign(secret, payload) {
  return cryptoLib.createHmac('sha256', secret).update(payload).digest('hex');
}

function verifyHmac(secret, payload, signature) {
  if (!secret || !signature) return false;
  const expected = hmacSign(secret, payload);
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(signature.replace(/^sha256=/, ''), 'hex');
  if (a.length !== b.length) return false;
  return cryptoLib.timingSafeEqual(a, b);
}

async function isReserved(pool, localPart) {
  if (RESERVED_LOCAL_PARTS.includes(localPart)) return true;
  const r = await pool.query(
    `SELECT 1 FROM email_reserved_local_parts WHERE local_part = $1 LIMIT 1`,
    [localPart]
  ).catch(() => ({ rows: [] }));
  return !!r.rows[0];
}

async function resolveAgentByAddress(pool, address) {
  if (!address) return null;
  const lower = address.toLowerCase();
  const [local, domain] = lower.split('@');
  if (!local || !domain) return null;
  // Exact-match
  const r = await pool.query(
    `SELECT agent_did FROM email_addresses WHERE address = $1 LIMIT 1`,
    [lower]
  ).catch(() => ({ rows: [] }));
  if (r.rows[0]) return r.rows[0].agent_did;
  // DID-routed inbox.openheab.com — match local part to did short
  if (domain === EMAIL_DID_SUBDOMAIN.toLowerCase()) {
    const candR = await pool.query(
      `SELECT did FROM identities
       WHERE lower(replace(did, 'did:op:', '')) LIKE $1 LIMIT 1`,
      [`${local}%`]
    ).catch(() => ({ rows: [] }));
    if (candR.rows[0]) return candR.rows[0].did;
  }
  return null;
}

// ----------------------------------------------------------------------------
// Routes
// ----------------------------------------------------------------------------
function registerEmailRoutes(app, pool, verifyAgentAuth, auditChain) {
  // POST /v1/agents/:did/email/address — claim a local part
  const ClaimSchema = z.object({
    local_part: z.string().min(1).max(64),
    is_primary: z.boolean().optional()
  });

  app.post('/v1/agents/:did/email/address', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const parse = ClaimSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const localPart = parse.data.local_part.toLowerCase();
      if (!LOCAL_PART_RE.test(localPart)) {
        return res.status(400).json({ error: 'invalid_local_part' });
      }
      if (await isReserved(pool, localPart)) {
        return res.status(409).json({ error: 'local_part_reserved' });
      }

      const idemKey = req.headers['x-idempotency-key'];
      const cached = await checkIdempotency(pool, did, idemKey, 'email-claim');
      if (cached) return res.json(cached);

      const address = `${localPart}@${EMAIL_DOMAIN}`;

      const exists = await pool.query(
        `SELECT agent_did FROM email_addresses WHERE address = $1`, [address]
      ).catch(() => ({ rows: [] }));
      if (exists.rows[0] && exists.rows[0].agent_did !== did) {
        return res.status(409).json({ error: 'address_taken' });
      }

      const isPrimary = !!parse.data.is_primary;
      if (isPrimary) {
        await pool.query(
          `UPDATE email_addresses SET is_primary = FALSE WHERE agent_did = $1`,
          [did]
        );
      }

      await pool.query(
        `INSERT INTO email_addresses (address, agent_did, domain, local_part, is_primary)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (address) DO UPDATE SET is_primary = EXCLUDED.is_primary`,
        [address, did, EMAIL_DOMAIN, localPart, isPrimary]
      );

      await auditChain.append({
        event_type: 'email.address_claimed',
        agent_did: did, address,
        timestamp: new Date().toISOString()
      });

      const response = {
        address, agent_did: did, domain: EMAIL_DOMAIN,
        local_part: localPart, is_primary: isPrimary,
        did_routed_address: didEmailAddress(did)
      };
      await recordIdempotency(pool, did, idemKey, 'email-claim', response);
      return res.status(201).json(response);
    } catch (e) {
      console.error('[email.claim]', e);
      return res.status(500).json({ error: 'claim_failed', message: e.message });
    }
  });

  // GET /v1/agents/:did/email/address
  app.get('/v1/agents/:did/email/address', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });

    const r = await pool.query(
      `SELECT address, agent_did, domain, local_part, is_primary, created_at
       FROM email_addresses WHERE agent_did = $1 ORDER BY is_primary DESC, created_at ASC`,
      [did]
    ).catch(() => ({ rows: [] }));
    return res.json({
      addresses: r.rows,
      did_routed_address: didEmailAddress(did),
      count: r.rows.length
    });
  });

  // POST /v1/agents/:did/email/send
  const SendSchema = z.object({
    from: z.string().email().optional(),
    to: z.union([z.string().email(), z.array(z.string().email()).min(1)]),
    cc: z.array(z.string().email()).optional(),
    subject: z.string().max(998).optional(),
    body_text: z.string().optional(),
    body_html: z.string().optional(),
    headers: z.record(z.string()).optional(),
    in_reply_to: z.string().optional()
  });

  app.post('/v1/agents/:did/email/send', express.json({ limit: '20mb' }), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const parse = SendSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const data = parse.data;
      if (!data.body_text && !data.body_html) {
        return res.status(400).json({ error: 'missing_body' });
      }

      const idemKey = req.headers['x-idempotency-key'];
      const cached = await checkIdempotency(pool, did, idemKey, 'email-send');
      if (cached) return res.json(cached);

      // Resolve "from" — must be owned by this agent
      let fromAddr = data.from;
      if (fromAddr) {
        const own = await pool.query(
          `SELECT agent_did FROM email_addresses WHERE address = $1`,
          [fromAddr.toLowerCase()]
        );
        if (!own.rows[0] || own.rows[0].agent_did !== did) {
          return res.status(403).json({ error: 'from_address_not_owned_by_agent' });
        }
      } else {
        const primR = await pool.query(
          `SELECT address FROM email_addresses
           WHERE agent_did = $1 ORDER BY is_primary DESC, created_at ASC LIMIT 1`, [did]
        );
        fromAddr = primR.rows[0]?.address || didEmailAddress(did);
      }

      const toList = Array.isArray(data.to) ? data.to : [data.to];
      const messageId = genId('msg');

      const mime = buildMime({
        from: fromAddr,
        to: toList,
        cc: data.cc || [],
        subject: data.subject,
        bodyText: data.body_text,
        bodyHtml: data.body_html,
        headers: data.headers,
        inReplyTo: data.in_reply_to,
        messageId
      });

      const entry = await auditChain.append({
        event_type: 'email.sent',
        agent_did: did, message_id: messageId,
        from: fromAddr, to: toList,
        subject: data.subject || null,
        timestamp: new Date().toISOString()
      });

      await pool.query(
        `INSERT INTO email_messages
         (message_id, direction, agent_did, from_address, to_address, cc_addresses,
          subject, body_text, body_html, headers, raw_size_bytes, status, audit_hash,
          in_reply_to)
         VALUES ($1,'out',$2,$3,$4,$5::text[],$6,$7,$8,$9::jsonb,$10,'queued',$11,$12)`,
        [messageId, did, fromAddr, toList[0], toList.slice(1).concat(data.cc || []),
         data.subject || null, data.body_text || null, data.body_html || null,
         JSON.stringify(data.headers || {}), Buffer.byteLength(mime, 'utf8'),
         entry.hash, data.in_reply_to || null]
      );

      // Relay to gateway
      const gatewayUrl = process.env.EMAIL_GATEWAY_URL;
      const gatewaySecret = process.env.EMAIL_GATEWAY_SECRET;
      let delivered = false;
      let bounceReason = null;
      if (gatewayUrl && gatewaySecret) {
        try {
          const payload = JSON.stringify({
            message_id: messageId,
            from: fromAddr,
            to: toList,
            cc: data.cc || [],
            mime,
            agent_did: did
          });
          const sig = hmacSign(gatewaySecret, payload);
          const r = await fetch(`${gatewayUrl.replace(/\/$/, '')}/relay`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-openheab-signature': `sha256=${sig}`
            },
            body: payload
          });
          if (r.ok) {
            delivered = true;
            await pool.query(
              `UPDATE email_messages SET status='sent', delivered_at=NOW() WHERE message_id=$1`,
              [messageId]
            );
          } else {
            bounceReason = `gateway_status_${r.status}`;
            await pool.query(
              `UPDATE email_messages SET status='failed', bounce_reason=$2 WHERE message_id=$1`,
              [messageId, bounceReason]
            );
          }
        } catch (e) {
          bounceReason = `gateway_error: ${e.message}`;
          await pool.query(
            `UPDATE email_messages SET status='failed', bounce_reason=$2 WHERE message_id=$1`,
            [messageId, bounceReason]
          );
        }
      } else {
        bounceReason = 'gateway_not_configured';
        await pool.query(
          `UPDATE email_messages SET status='queued' WHERE message_id=$1`,
          [messageId]
        );
      }

      const response = {
        message_id: messageId,
        from: fromAddr,
        to: toList,
        cc: data.cc || [],
        subject: data.subject || null,
        status: delivered ? 'sent' : (bounceReason ? 'failed' : 'queued'),
        bounce_reason: bounceReason,
        audit_hash: entry.hash
      };
      await recordIdempotency(pool, did, idemKey, 'email-send', response);
      return res.status(202).json(response);
    } catch (e) {
      console.error('[email.send]', e);
      return res.status(500).json({ error: 'send_failed', message: e.message });
    }
  });

  // GET /v1/agents/:did/email/messages
  app.get('/v1/agents/:did/email/messages', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const direction = req.query.direction;
    const limit = Math.min(parseInt(req.query.limit) || 50, 500);
    const offset = Math.max(parseInt(req.query.offset) || 0, 0);
    const params = [did, limit, offset];
    let dirFilter = '';
    if (direction === 'in' || direction === 'out') {
      params.push(direction);
      dirFilter = ` AND direction = $4`;
    }
    const r = await pool.query(
      `SELECT message_id, direction, agent_did, from_address, to_address, cc_addresses,
              subject, spam_score, dkim_pass, spf_pass, dmarc_pass, status, bounce_reason,
              in_reply_to, audit_hash, created_at, delivered_at
       FROM email_messages
       WHERE agent_did = $1 ${dirFilter}
       ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
      params
    ).catch(() => ({ rows: [] }));
    return res.json({ messages: r.rows, count: r.rows.length });
  });

  // GET /v1/agents/:did/email/messages/:id
  app.get('/v1/agents/:did/email/messages/:id', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(
      `SELECT * FROM email_messages WHERE agent_did = $1 AND message_id = $2 LIMIT 1`,
      [did, req.params.id]
    ).catch(() => ({ rows: [] }));
    if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
    return res.json(r.rows[0]);
  });

  // POST /v1/_email/ingest — inbound webhook from gateway
  app.post('/v1/_email/ingest', express.json({ limit: '50mb' }), async (req, res) => {
    try {
      const secret = process.env.EMAIL_GATEWAY_SECRET;
      const sig = req.headers['x-openheab-signature'];
      const payload = JSON.stringify(req.body || {});
      if (!secret || !verifyHmac(secret, payload, sig)) {
        return res.status(401).json({ error: 'invalid_signature' });
      }

      const b = req.body || {};
      const to = String(b.to || '').toLowerCase();
      const from = String(b.from || '').toLowerCase();
      if (!to || !from) return res.status(400).json({ error: 'missing_addresses' });

      const agentDid = await resolveAgentByAddress(pool, to);
      if (!agentDid) return res.status(404).json({ error: 'no_recipient_agent' });

      const messageId = b.message_id || genId('msg');
      const entry = await auditChain.append({
        event_type: 'email.received',
        agent_did: agentDid, message_id: messageId,
        from, to,
        subject: b.subject || null,
        timestamp: new Date().toISOString()
      });

      await pool.query(
        `INSERT INTO email_messages
         (message_id, direction, agent_did, from_address, to_address, cc_addresses,
          subject, body_text, body_html, headers, attachments, spam_score,
          dkim_pass, spf_pass, dmarc_pass, raw_size_bytes, status, in_reply_to,
          audit_hash, delivered_at)
         VALUES ($1,'in',$2,$3,$4,$5::text[],$6,$7,$8,$9::jsonb,$10::jsonb,$11,
                 $12,$13,$14,$15,'received',$16,$17,NOW())
         ON CONFLICT (message_id) DO NOTHING`,
        [messageId, agentDid, from, to, b.cc || [],
         b.subject || null, b.body_text || null, b.body_html || null,
         JSON.stringify(b.headers || {}), JSON.stringify(b.attachments || []),
         typeof b.spam_score === 'number' ? b.spam_score : null,
         b.dkim_pass === true, b.spf_pass === true, b.dmarc_pass === true,
         typeof b.raw_size_bytes === 'number' ? b.raw_size_bytes : (payload.length || 0),
         b.in_reply_to || null, entry.hash]
      );

      return res.json({ accepted: true, message_id: messageId, agent_did: agentDid });
    } catch (e) {
      console.error('[email.ingest]', e);
      return res.status(500).json({ error: 'ingest_failed', message: e.message });
    }
  });

  // POST /v1/_email/dsn — delivery status notifications
  app.post('/v1/_email/dsn', express.json({ limit: '5mb' }), async (req, res) => {
    try {
      const secret = process.env.EMAIL_GATEWAY_SECRET;
      const sig = req.headers['x-openheab-signature'];
      const payload = JSON.stringify(req.body || {});
      if (!secret || !verifyHmac(secret, payload, sig)) {
        return res.status(401).json({ error: 'invalid_signature' });
      }
      const b = req.body || {};
      const messageId = b.message_id;
      if (!messageId) return res.status(400).json({ error: 'missing_message_id' });

      const status = b.status || 'bounced';
      const bounceReason = b.reason || b.diagnostic_code || null;

      await pool.query(
        `UPDATE email_messages
         SET status = $2, bounce_reason = $3
         WHERE message_id = $1`,
        [messageId, status, bounceReason]
      );

      await auditChain.append({
        event_type: 'email.dsn',
        message_id: messageId,
        status, reason: bounceReason,
        timestamp: new Date().toISOString()
      });

      return res.json({ accepted: true, message_id: messageId });
    } catch (e) {
      console.error('[email.dsn]', e);
      return res.status(500).json({ error: 'dsn_failed', message: e.message });
    }
  });
}

module.exports = {
  migrate,
  registerEmailRoutes,
  buildMime,
  hmacSign,
  verifyHmac,
  didEmailAddress,
  resolveAgentByAddress,
  LOCAL_PART_RE,
  RESERVED_LOCAL_PARTS,
  EMAIL_DOMAIN,
  EMAIL_DID_SUBDOMAIN
};
