// ============================================================================
// OpenHeab Phone — Twilio Numbers, SMS, Voice, OTP Parsing
// Tables: phone_numbers, phone_sms, phone_calls, phone_policies
// ============================================================================
const cryptoLib = require('crypto');
const express = require('express');
const { z } = require('zod');

// ----------------------------------------------------------------------------
// Migration
// ----------------------------------------------------------------------------
async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS phone_numbers (
      phone_id           TEXT PRIMARY KEY,
      agent_did          TEXT NOT NULL,
      number_e164        TEXT UNIQUE NOT NULL,
      twilio_sid         TEXT,
      capabilities       JSONB,
      country            TEXT,
      number_type        TEXT NOT NULL DEFAULT 'local',
      monthly_cost_cents INTEGER NOT NULL DEFAULT 100,
      assigned_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      released_at        TIMESTAMPTZ,
      status             TEXT NOT NULL DEFAULT 'active'
    );
    CREATE INDEX IF NOT EXISTS idx_phone_numbers_did ON phone_numbers (agent_did);
    CREATE INDEX IF NOT EXISTS idx_phone_numbers_status ON phone_numbers (status);

    CREATE TABLE IF NOT EXISTS phone_sms (
      sms_id              TEXT PRIMARY KEY,
      phone_id            TEXT NOT NULL,
      agent_did           TEXT NOT NULL,
      direction           TEXT NOT NULL,
      from_e164           TEXT NOT NULL,
      to_e164             TEXT NOT NULL,
      body                TEXT,
      body_hash           TEXT,
      twilio_sid          TEXT,
      status              TEXT,
      segments            INTEGER,
      cost_cents          INTEGER,
      classified_intent   TEXT,
      parsed_otp          TEXT,
      parsed_url          TEXT,
      parsed_sender_brand TEXT,
      inbox_envelope_id   TEXT,
      audit_chain_entry   TEXT,
      idempotency_key     TEXT,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_phone_sms_did ON phone_sms (agent_did, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_phone_sms_phone ON phone_sms (phone_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_phone_sms_idem ON phone_sms (agent_did, idempotency_key)
      WHERE idempotency_key IS NOT NULL;

    CREATE TABLE IF NOT EXISTS phone_calls (
      call_id           TEXT PRIMARY KEY,
      phone_id          TEXT NOT NULL,
      agent_did         TEXT NOT NULL,
      direction         TEXT NOT NULL,
      from_e164         TEXT NOT NULL,
      to_e164           TEXT NOT NULL,
      twilio_sid        TEXT,
      status            TEXT,
      duration_seconds  INTEGER,
      cost_cents        INTEGER,
      recording_url     TEXT,
      transcript        TEXT,
      audit_chain_entry TEXT,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      ended_at          TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_phone_calls_did ON phone_calls (agent_did, created_at DESC);

    CREATE TABLE IF NOT EXISTS phone_policies (
      agent_did                       TEXT PRIMARY KEY,
      sms_per_minute                  INTEGER NOT NULL DEFAULT 10,
      sms_per_day                     INTEGER NOT NULL DEFAULT 500,
      allow_international             BOOLEAN NOT NULL DEFAULT FALSE,
      allowed_destination_prefixes    TEXT[],
      blocked_destination_prefixes    TEXT[],
      max_cost_per_message_cents      INTEGER NOT NULL DEFAULT 25,
      auto_forward_otp_to_inbox       BOOLEAN NOT NULL DEFAULT TRUE,
      auto_classify_intent            BOOLEAN NOT NULL DEFAULT TRUE,
      updated_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------
function genId(prefix) {
  return `${prefix}_${cryptoLib.randomBytes(12).toString('hex')}`;
}

function hashBody(s) {
  return cryptoLib.createHash('sha256').update(String(s || '')).digest('hex');
}

function smsCostCents(segments = 1, isInternational = false) {
  const per = isInternational ? 5 : 1;
  return Math.max(1, per * Math.max(1, segments));
}

function callCostCents(durationSeconds = 0, isInternational = false) {
  const perMinute = isInternational ? 15 : 2;
  return Math.ceil(durationSeconds / 60) * perMinute;
}

// OTP / classification
const OTP_PATTERNS = [
  /\b(\d{4,8})\s*(?:is|=)\s*(?:your|the)?\s*(?:code|otp|pin|verification|security)/i,
  /(?:code|otp|pin|verification|security\s*code)\s+is\s+(\d{4,8})\b/i,
  /(?:code|otp|pin|verification|security\s*code)\s*[:=]\s*(\d{4,8})\b/i,
  /\buse\s+(\d{4,8})\s+to\s+(?:verify|confirm|authenticate|sign[\s-]?in)/i,
  /\benter\s+(\d{4,8})\b/i,
  /\bg-?(\d{4,8})\b/i
];

const URL_RE = /\bhttps?:\/\/[^\s<>"']+/i;
const BRAND_PREFIX_RE = /^([A-Z][A-Z0-9_-]{1,30}):\s*/;

function parseOtp(body) {
  if (!body) return null;
  for (const re of OTP_PATTERNS) {
    const m = body.match(re);
    if (m && m[1]) return m[1];
  }
  return null;
}

function parseUrl(body) {
  if (!body) return null;
  const m = body.match(URL_RE);
  return m ? m[0] : null;
}

function parseSenderBrand(body) {
  if (!body) return null;
  const m = body.match(BRAND_PREFIX_RE);
  return m ? m[1] : null;
}

function classifyIntent(body) {
  if (!body) return 'unknown';
  const b = body.toLowerCase();
  if (parseOtp(body)) return 'otp';
  if (/\b(stop|unsubscribe|opt[- ]?out|quit|cancel)\b/.test(b)) return 'stop';
  if (/\bshipped|delivered|tracking|out for delivery|package\b/.test(b)) return 'shipping';
  if (/\bappointment|reminder|scheduled|tomorrow at|today at\b/.test(b)) return 'reminder';
  if (/\b(sale|% off|discount|promo|coupon|deal)\b/.test(b)) return 'promo';
  if (/\b(fraud|suspicious|alert|unauthorized)\b/.test(b)) return 'alert';
  if (/\b(payment|invoice|due|charge|refund)\b/.test(b)) return 'payment';
  return 'other';
}

// Twilio webhook signature
function validateTwilioSignature(authToken, url, params, signature) {
  if (!authToken || !signature) return false;
  try {
    const sortedKeys = Object.keys(params).sort();
    let data = url;
    for (const k of sortedKeys) data += k + params[k];
    const expected = cryptoLib.createHmac('sha1', authToken).update(data).digest('base64');
    const a = Buffer.from(expected);
    const b = Buffer.from(signature);
    if (a.length !== b.length) return false;
    return cryptoLib.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// Rate limiting
async function checkSmsRateLimit(pool, phoneId, agentDid, policy) {
  const perMin = policy?.sms_per_minute || 10;
  const perDay = policy?.sms_per_day || 500;
  const r = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '1 minute') AS m,
      COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '1 day') AS d
    FROM phone_sms
    WHERE agent_did = $1 AND direction = 'out'
  `, [agentDid]).catch(() => ({ rows: [{ m: 0, d: 0 }] }));
  const m = parseInt(r.rows[0].m), d = parseInt(r.rows[0].d);
  if (m >= perMin) return { ok: false, reason: 'rate_limit_per_minute' };
  if (d >= perDay) return { ok: false, reason: 'rate_limit_per_day' };
  return { ok: true };
}

async function getPolicy(pool, agentDid) {
  const r = await pool.query(
    `SELECT * FROM phone_policies WHERE agent_did = $1`,
    [agentDid]
  ).catch(() => ({ rows: [] }));
  return r.rows[0] || {
    agent_did: agentDid,
    sms_per_minute: 10, sms_per_day: 500,
    allow_international: false,
    allowed_destination_prefixes: null,
    blocked_destination_prefixes: null,
    max_cost_per_message_cents: 25,
    auto_forward_otp_to_inbox: true,
    auto_classify_intent: true
  };
}

function isDestinationAllowed(toE164, policy) {
  const blocked = policy.blocked_destination_prefixes || [];
  for (const p of blocked) if (toE164.startsWith(p)) return false;
  const allowed = policy.allowed_destination_prefixes;
  if (allowed && allowed.length) {
    return allowed.some(p => toE164.startsWith(p));
  }
  return true;
}

function isInternational(toE164, fromE164) {
  // Same country code (e.g. +1 → +1) is local
  if (!toE164 || !fromE164) return false;
  const m1 = toE164.match(/^\+(\d{1,3})/);
  const m2 = fromE164.match(/^\+(\d{1,3})/);
  if (!m1 || !m2) return false;
  return m1[1] !== m2[1];
}

// ----------------------------------------------------------------------------
// Routes
// ----------------------------------------------------------------------------
function registerPhoneRoutes(app, pool, verifyAgentAuth, auditChain, twilio, inboxModule, twilioAuthToken) {
  // POST /v1/agents/:did/phone/rent
  const RentSchema = z.object({
    country: z.string().length(2).optional(),
    area_code: z.string().optional(),
    number_type: z.enum(['local', 'toll_free', 'mobile']).optional(),
    contains: z.string().optional()
  });

  app.post('/v1/agents/:did/phone/rent', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const parse = RentSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const { country = 'US', area_code, number_type = 'local', contains } = parse.data;

      const idemKey = req.headers['x-idempotency-key'];
      if (idemKey) {
        const existing = await pool.query(
          `SELECT phone_id, number_e164, twilio_sid, country, number_type, monthly_cost_cents, status
           FROM phone_numbers WHERE agent_did = $1 AND twilio_sid LIKE $2 LIMIT 1`,
          [did, `idem-${idemKey}-%`]
        ).catch(() => ({ rows: [] }));
        if (existing.rows[0]) return res.json(existing.rows[0]);
      }

      let available;
      try {
        const listFn = number_type === 'toll_free'
          ? twilio.availablePhoneNumbers(country).tollFree
          : number_type === 'mobile'
          ? twilio.availablePhoneNumbers(country).mobile
          : twilio.availablePhoneNumbers(country).local;
        const opts = { limit: 1 };
        if (area_code) opts.areaCode = area_code;
        if (contains) opts.contains = contains;
        available = await listFn.list(opts);
      } catch (e) {
        return res.status(502).json({ error: 'twilio_lookup_failed', message: e.message });
      }
      if (!available || !available.length) return res.status(404).json({ error: 'no_numbers_available' });
      const e164 = available[0].phoneNumber;

      let purchased;
      try {
        purchased = await twilio.incomingPhoneNumbers.create({
          phoneNumber: e164,
          smsUrl: `${process.env.OPERATOR_PUBLIC_URL || ''}/v1/phone/_webhooks/twilio/sms`,
          voiceUrl: `${process.env.OPERATOR_PUBLIC_URL || ''}/v1/phone/_webhooks/twilio/voice`
        });
      } catch (e) {
        return res.status(502).json({ error: 'twilio_purchase_failed', message: e.message });
      }

      const phoneId = genId('ph');
      const monthlyCost = number_type === 'toll_free' ? 200 : 100;
      const capabilities = available[0].capabilities || {
        sms: true, voice: true, mms: true
      };
      const twilioSidStored = idemKey ? `idem-${idemKey}-${purchased.sid}` : purchased.sid;

      await pool.query(
        `INSERT INTO phone_numbers
         (phone_id, agent_did, number_e164, twilio_sid, capabilities, country,
          number_type, monthly_cost_cents, status)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,'active')`,
        [phoneId, did, e164, twilioSidStored, JSON.stringify(capabilities),
         country, number_type, monthlyCost]
      );

      await auditChain.append({
        event_type: 'phone.rented',
        agent_did: did, phone_id: phoneId, number_e164: e164,
        timestamp: new Date().toISOString()
      });

      return res.status(201).json({
        phone_id: phoneId,
        agent_did: did,
        number_e164: e164,
        twilio_sid: purchased.sid,
        country, number_type,
        capabilities,
        monthly_cost_cents: monthlyCost,
        status: 'active'
      });
    } catch (e) {
      console.error('[phone.rent]', e);
      return res.status(500).json({ error: 'rent_failed', message: e.message });
    }
  });

  // GET /v1/agents/:did/phones
  app.get('/v1/agents/:did/phones', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(
      `SELECT phone_id, number_e164, twilio_sid, capabilities, country, number_type,
              monthly_cost_cents, status, assigned_at, released_at
       FROM phone_numbers WHERE agent_did = $1
       ORDER BY assigned_at DESC`,
      [did]
    ).catch(() => ({ rows: [] }));
    return res.json({ phones: r.rows, count: r.rows.length });
  });

  // POST /v1/agents/:did/phones/:phoneId/release
  app.post('/v1/agents/:did/phones/:phoneId/release', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const phoneId = req.params.phoneId;
      const r = await pool.query(
        `SELECT twilio_sid FROM phone_numbers
         WHERE phone_id = $1 AND agent_did = $2 AND status = 'active'`,
        [phoneId, did]
      ).catch(() => ({ rows: [] }));
      if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });

      // Strip idem prefix
      const sid = r.rows[0].twilio_sid.replace(/^idem-[^-]+-/, '');
      try {
        await twilio.incomingPhoneNumbers(sid).remove();
      } catch (e) {
        console.warn('[phone.release] twilio release error:', e.message);
      }

      await pool.query(
        `UPDATE phone_numbers SET status='released', released_at=NOW()
         WHERE phone_id = $1`, [phoneId]
      );

      await auditChain.append({
        event_type: 'phone.released',
        agent_did: did, phone_id: phoneId,
        timestamp: new Date().toISOString()
      });

      return res.json({ phone_id: phoneId, status: 'released' });
    } catch (e) {
      console.error('[phone.release]', e);
      return res.status(500).json({ error: 'release_failed', message: e.message });
    }
  });

  // POST /v1/agents/:did/phones/:phoneId/sms/send
  const SmsSendSchema = z.object({
    to_e164: z.string().regex(/^\+\d{8,15}$/),
    body: z.string().min(1).max(1600)
  });

  app.post('/v1/agents/:did/phones/:phoneId/sms/send', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const parse = SmsSendSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const { to_e164, body } = parse.data;

      const idemKey = req.headers['x-idempotency-key'];
      if (idemKey) {
        const dup = await pool.query(
          `SELECT sms_id, to_e164, from_e164, status, segments, cost_cents,
                  classified_intent, parsed_otp, audit_chain_entry
           FROM phone_sms WHERE agent_did = $1 AND idempotency_key = $2 LIMIT 1`,
          [did, idemKey]
        ).catch(() => ({ rows: [] }));
        if (dup.rows[0]) return res.json(dup.rows[0]);
      }

      const phoneR = await pool.query(
        `SELECT phone_id, number_e164, status FROM phone_numbers
         WHERE phone_id = $1 AND agent_did = $2 LIMIT 1`,
        [req.params.phoneId, did]
      ).catch(() => ({ rows: [] }));
      const phone = phoneR.rows[0];
      if (!phone) return res.status(404).json({ error: 'phone_not_found' });
      if (phone.status !== 'active') return res.status(409).json({ error: 'phone_not_active' });

      const policy = await getPolicy(pool, did);
      const intl = isInternational(to_e164, phone.number_e164);
      if (intl && !policy.allow_international) {
        return res.status(403).json({ error: 'international_not_allowed' });
      }
      if (!isDestinationAllowed(to_e164, policy)) {
        return res.status(403).json({ error: 'destination_blocked_by_policy' });
      }
      const rl = await checkSmsRateLimit(pool, phone.phone_id, did, policy);
      if (!rl.ok) return res.status(429).json({ error: rl.reason });

      const segments = Math.max(1, Math.ceil(body.length / 160));
      const cost = smsCostCents(segments, intl);
      if (cost > (policy.max_cost_per_message_cents || 25)) {
        return res.status(403).json({ error: 'cost_exceeds_policy', cost_cents: cost });
      }

      let twilioMsg;
      try {
        twilioMsg = await twilio.messages.create({
          from: phone.number_e164,
          to: to_e164,
          body
        });
      } catch (e) {
        return res.status(502).json({ error: 'twilio_send_failed', message: e.message });
      }

      const smsId = genId('sms');
      const entry = await auditChain.append({
        event_type: 'phone.sms_sent',
        agent_did: did, phone_id: phone.phone_id,
        from: phone.number_e164, to: to_e164,
        body_hash: hashBody(body),
        timestamp: new Date().toISOString()
      });

      await pool.query(
        `INSERT INTO phone_sms
         (sms_id, phone_id, agent_did, direction, from_e164, to_e164, body, body_hash,
          twilio_sid, status, segments, cost_cents, audit_chain_entry, idempotency_key)
         VALUES ($1,$2,$3,'out',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [smsId, phone.phone_id, did, phone.number_e164, to_e164, body,
         hashBody(body), twilioMsg.sid, twilioMsg.status || 'sent',
         segments, cost, entry.hash, idemKey || null]
      );

      return res.status(201).json({
        sms_id: smsId,
        from_e164: phone.number_e164, to_e164,
        twilio_sid: twilioMsg.sid,
        status: twilioMsg.status || 'sent',
        segments, cost_cents: cost,
        audit_chain_entry: entry.hash
      });
    } catch (e) {
      console.error('[phone.sms.send]', e);
      return res.status(500).json({ error: 'send_failed', message: e.message });
    }
  });

  // GET /v1/agents/:did/phones/:phoneId/sms
  app.get('/v1/agents/:did/phones/:phoneId/sms', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const limit = Math.min(parseInt(req.query.limit) || 50, 500);
    const r = await pool.query(
      `SELECT sms_id, direction, from_e164, to_e164, body, status, segments,
              cost_cents, classified_intent, parsed_otp, parsed_url, parsed_sender_brand,
              inbox_envelope_id, audit_chain_entry, created_at
       FROM phone_sms WHERE phone_id = $1 AND agent_did = $2
       ORDER BY created_at DESC LIMIT $3`,
      [req.params.phoneId, did, limit]
    ).catch(() => ({ rows: [] }));
    return res.json({ messages: r.rows, count: r.rows.length });
  });

  // POST /v1/agents/:did/phones/:phoneId/call
  const CallSchema = z.object({
    to_e164: z.string().regex(/^\+\d{8,15}$/),
    twiml_url: z.string().url().optional(),
    twiml: z.string().optional()
  });

  app.post('/v1/agents/:did/phones/:phoneId/call', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const parse = CallSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });

      const phoneR = await pool.query(
        `SELECT phone_id, number_e164, status FROM phone_numbers
         WHERE phone_id = $1 AND agent_did = $2 LIMIT 1`,
        [req.params.phoneId, did]
      );
      const phone = phoneR.rows[0];
      if (!phone) return res.status(404).json({ error: 'phone_not_found' });
      if (phone.status !== 'active') return res.status(409).json({ error: 'phone_not_active' });

      const policy = await getPolicy(pool, did);
      const intl = isInternational(parse.data.to_e164, phone.number_e164);
      if (intl && !policy.allow_international) {
        return res.status(403).json({ error: 'international_not_allowed' });
      }

      let twilioCall;
      try {
        const opts = { from: phone.number_e164, to: parse.data.to_e164 };
        if (parse.data.twiml_url) opts.url = parse.data.twiml_url;
        else if (parse.data.twiml) opts.twiml = parse.data.twiml;
        else opts.twiml = '<Response><Say>Hello from OpenHeab.</Say></Response>';
        twilioCall = await twilio.calls.create(opts);
      } catch (e) {
        return res.status(502).json({ error: 'twilio_call_failed', message: e.message });
      }

      const callId = genId('call');
      const entry = await auditChain.append({
        event_type: 'phone.call_initiated',
        agent_did: did, phone_id: phone.phone_id,
        from: phone.number_e164, to: parse.data.to_e164,
        timestamp: new Date().toISOString()
      });
      await pool.query(
        `INSERT INTO phone_calls
         (call_id, phone_id, agent_did, direction, from_e164, to_e164, twilio_sid,
          status, audit_chain_entry)
         VALUES ($1,$2,$3,'out',$4,$5,$6,$7,$8)`,
        [callId, phone.phone_id, did, phone.number_e164, parse.data.to_e164,
         twilioCall.sid, twilioCall.status || 'initiated', entry.hash]
      );

      return res.status(201).json({
        call_id: callId,
        twilio_sid: twilioCall.sid,
        status: twilioCall.status || 'initiated',
        from_e164: phone.number_e164,
        to_e164: parse.data.to_e164,
        audit_chain_entry: entry.hash
      });
    } catch (e) {
      console.error('[phone.call]', e);
      return res.status(500).json({ error: 'call_failed', message: e.message });
    }
  });

  // GET /v1/agents/:did/phone/policy
  app.get('/v1/agents/:did/phone/policy', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const policy = await getPolicy(pool, did);
    return res.json(policy);
  });

  // PUT /v1/agents/:did/phone/policy
  const PolicySchema = z.object({
    sms_per_minute: z.number().int().min(0).max(10000).optional(),
    sms_per_day: z.number().int().min(0).max(1000000).optional(),
    allow_international: z.boolean().optional(),
    allowed_destination_prefixes: z.array(z.string()).optional(),
    blocked_destination_prefixes: z.array(z.string()).optional(),
    max_cost_per_message_cents: z.number().int().min(0).optional(),
    auto_forward_otp_to_inbox: z.boolean().optional(),
    auto_classify_intent: z.boolean().optional()
  });

  app.put('/v1/agents/:did/phone/policy', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const parse = PolicySchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });

      const current = await getPolicy(pool, did);
      const merged = { ...current, ...parse.data };
      await pool.query(`
        INSERT INTO phone_policies
        (agent_did, sms_per_minute, sms_per_day, allow_international,
         allowed_destination_prefixes, blocked_destination_prefixes,
         max_cost_per_message_cents, auto_forward_otp_to_inbox,
         auto_classify_intent, updated_at)
        VALUES ($1,$2,$3,$4,$5::text[],$6::text[],$7,$8,$9,NOW())
        ON CONFLICT (agent_did) DO UPDATE SET
          sms_per_minute = EXCLUDED.sms_per_minute,
          sms_per_day = EXCLUDED.sms_per_day,
          allow_international = EXCLUDED.allow_international,
          allowed_destination_prefixes = EXCLUDED.allowed_destination_prefixes,
          blocked_destination_prefixes = EXCLUDED.blocked_destination_prefixes,
          max_cost_per_message_cents = EXCLUDED.max_cost_per_message_cents,
          auto_forward_otp_to_inbox = EXCLUDED.auto_forward_otp_to_inbox,
          auto_classify_intent = EXCLUDED.auto_classify_intent,
          updated_at = NOW()
      `, [did, merged.sms_per_minute, merged.sms_per_day, merged.allow_international,
          merged.allowed_destination_prefixes, merged.blocked_destination_prefixes,
          merged.max_cost_per_message_cents, merged.auto_forward_otp_to_inbox,
          merged.auto_classify_intent]);

      await auditChain.append({
        event_type: 'phone.policy_updated',
        agent_did: did, changes: Object.keys(parse.data),
        timestamp: new Date().toISOString()
      });

      const out = await getPolicy(pool, did);
      return res.json(out);
    } catch (e) {
      console.error('[phone.policy]', e);
      return res.status(500).json({ error: 'policy_failed', message: e.message });
    }
  });

  // POST /v1/phone/_webhooks/twilio/sms — inbound SMS
  app.post(
    '/v1/phone/_webhooks/twilio/sms',
    express.urlencoded({ extended: false }),
    async (req, res) => {
      try {
        const sig = req.headers['x-twilio-signature'];
        const fullUrl = `${process.env.OPERATOR_PUBLIC_URL || ''}${req.originalUrl || req.url}`;
        if (twilioAuthToken) {
          const valid = validateTwilioSignature(twilioAuthToken, fullUrl, req.body || {}, sig);
          if (!valid && process.env.NODE_ENV === 'production') {
            return res.status(401).type('text/xml').send('<Response/>');
          }
        }

        const from = req.body.From;
        const to = req.body.To;
        const body = req.body.Body || '';
        const twSid = req.body.MessageSid;
        if (!from || !to) return res.status(400).type('text/xml').send('<Response/>');

        const phoneR = await pool.query(
          `SELECT phone_id, agent_did FROM phone_numbers
           WHERE number_e164 = $1 AND status = 'active' LIMIT 1`, [to]
        );
        if (!phoneR.rows[0]) {
          return res.status(404).type('text/xml').send('<Response/>');
        }
        const { phone_id, agent_did } = phoneR.rows[0];

        const policy = await getPolicy(pool, agent_did);
        const otp = parseOtp(body);
        const url = parseUrl(body);
        const brand = parseSenderBrand(body);
        const intent = policy.auto_classify_intent ? classifyIntent(body) : null;

        let inboxEnvelopeId = null;
        if (otp && policy.auto_forward_otp_to_inbox && inboxModule &&
            typeof inboxModule.deliverEnvelope === 'function') {
          try {
            const env = await inboxModule.deliverEnvelope(pool, auditChain, {
              recipient_did: agent_did,
              channel: 'sms_otp',
              payload: { otp, body, from, brand, url, sms_twilio_sid: twSid },
              priority: 'high'
            });
            inboxEnvelopeId = env?.envelope_id || null;
          } catch (e) {
            console.warn('[phone.sms.inbound] inbox forward failed:', e.message);
          }
        }

        const smsId = genId('sms');
        const entry = await auditChain.append({
          event_type: 'phone.sms_received',
          agent_did, phone_id, from, to,
          body_hash: hashBody(body),
          intent, otp_detected: !!otp,
          timestamp: new Date().toISOString()
        });

        await pool.query(
          `INSERT INTO phone_sms
           (sms_id, phone_id, agent_did, direction, from_e164, to_e164, body, body_hash,
            twilio_sid, status, segments, cost_cents, classified_intent, parsed_otp,
            parsed_url, parsed_sender_brand, inbox_envelope_id, audit_chain_entry)
           VALUES ($1,$2,$3,'in',$4,$5,$6,$7,$8,'received',$9,$10,$11,$12,$13,$14,$15,$16)`,
          [smsId, phone_id, agent_did, from, to, body, hashBody(body), twSid,
           Math.max(1, Math.ceil((body || '').length / 160)), 0,
           intent, otp, url, brand, inboxEnvelopeId, entry.hash]
        );

        return res.status(200).type('text/xml').send('<Response/>');
      } catch (e) {
        console.error('[phone.sms.inbound]', e);
        return res.status(500).type('text/xml').send('<Response/>');
      }
    }
  );
}

module.exports = {
  migrate,
  registerPhoneRoutes,
  parseOtp,
  parseUrl,
  parseSenderBrand,
  classifyIntent,
  smsCostCents,
  callCostCents,
  validateTwilioSignature
};
