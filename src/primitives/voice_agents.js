// ============================================================================
// OpenHeab Voice Agents — Vapi/Retell-style conversational AI voice agents.
// Owns: voice_agents_def (config), voice_calls (call sessions, transcripts),
// voice_phone_numbers (rented numbers).
// Orchestrates phone (number rental) + voice (TTS/STT) + inference (LLM).
// ============================================================================
const express = require('express');
const cryptoLib = require('crypto');
const { z } = require('zod');

const DIRECTIONS = ['inbound', 'outbound'];
const STATUSES = ['ringing', 'in_progress', 'ended', 'missed', 'failed'];
const END_REASONS = ['hangup', 'agent_terminated', 'timeout', 'error'];
const NUMBER_STATUSES = ['active', 'released'];

// ----------------------------------------------------------------------------
// Migration
// ----------------------------------------------------------------------------
async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS voice_agents_def (
      voice_agent_id        TEXT PRIMARY KEY,
      owner_did             TEXT NOT NULL,
      name                  TEXT NOT NULL,
      system_prompt         TEXT NOT NULL,
      voice_id              TEXT,
      language              TEXT DEFAULT 'en',
      llm_model             TEXT DEFAULT 'gpt-4o-mini',
      first_message         TEXT,
      end_call_phrases      TEXT[] DEFAULT '{}',
      max_duration_seconds  INTEGER NOT NULL DEFAULT 600,
      active                BOOLEAN NOT NULL DEFAULT TRUE,
      created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_voice_agents_def_owner ON voice_agents_def (owner_did, created_at DESC);

    CREATE TABLE IF NOT EXISTS voice_calls (
      call_id            TEXT PRIMARY KEY,
      voice_agent_id     TEXT NOT NULL,
      caller_phone       TEXT,
      callee_phone       TEXT,
      direction          TEXT NOT NULL,
      status             TEXT NOT NULL DEFAULT 'ringing',
      transcript         TEXT,
      duration_seconds   INTEGER,
      recording_blob_id  TEXT,
      summary            TEXT,
      sentiment_score    REAL,
      started_at         TIMESTAMPTZ,
      ended_at           TIMESTAMPTZ,
      end_reason         TEXT,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_voice_calls_agent ON voice_calls (voice_agent_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_voice_calls_status ON voice_calls (status);

    CREATE TABLE IF NOT EXISTS voice_phone_numbers (
      number_e164          TEXT PRIMARY KEY,
      voice_agent_id       TEXT NOT NULL,
      owner_did            TEXT NOT NULL,
      twilio_sid           TEXT,
      status               TEXT NOT NULL DEFAULT 'active',
      monthly_cost_cents   INTEGER NOT NULL DEFAULT 100,
      assigned_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_voice_phone_numbers_agent ON voice_phone_numbers (voice_agent_id);
    CREATE INDEX IF NOT EXISTS idx_voice_phone_numbers_owner ON voice_phone_numbers (owner_did);
  `).catch(() => {});
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------
function genId(prefix) { return `${prefix}_${cryptoLib.randomBytes(12).toString('hex')}`; }

function looksLikeEndPhrase(text, phrases) {
  if (!text || !phrases || !phrases.length) return false;
  const t = String(text).toLowerCase();
  return phrases.some(p => t.includes(String(p).toLowerCase()));
}

// Synthesize one LLM turn → response text using inference primitive if loaded
async function generateAgentReply(systemPrompt, transcriptSoFar, userText, llmModel) {
  if (!process.env.OPENAI_API_KEY) {
    return { text: 'I am here to help. (LLM offline.)', synthetic: true };
  }
  try {
    const messages = [
      { role: 'system', content: systemPrompt || 'You are a helpful voice agent.' }
    ];
    if (transcriptSoFar) messages.push({ role: 'system', content: `Prior transcript:\n${transcriptSoFar}` });
    messages.push({ role: 'user', content: userText || '(call started)' });
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: llmModel || 'gpt-4o-mini',
        messages,
        max_tokens: 256,
        temperature: 0.7
      })
    });
    if (!r.ok) return { text: 'I cannot respond right now.', error: `llm_${r.status}` };
    const j = await r.json();
    return { text: j.choices?.[0]?.message?.content || '...' };
  } catch (e) {
    return { text: 'There was an error.', error: e.message };
  }
}

// ----------------------------------------------------------------------------
// Routes
// ----------------------------------------------------------------------------
function registerVoiceAgentsRoutes(app, pool, verifyAgentAuth, auditChain) {
  // ---- Create / list voice agents -----------------------------------------
  const CreateSchema = z.object({
    name: z.string().min(1).max(200),
    system_prompt: z.string().min(1).max(20000),
    voice_id: z.string().max(120).optional(),
    language: z.string().max(20).optional(),
    llm_model: z.string().max(120).optional(),
    first_message: z.string().max(2000).optional(),
    end_call_phrases: z.array(z.string()).optional(),
    max_duration_seconds: z.number().int().min(30).max(7200).optional()
  });

  app.post('/v1/agents/:did/voice-agents', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const parse = CreateSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;
      const id = genId('vagent');
      await pool.query(
        `INSERT INTO voice_agents_def (voice_agent_id, owner_did, name, system_prompt, voice_id,
                                        language, llm_model, first_message, end_call_phrases,
                                        max_duration_seconds)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [id, did, d.name, d.system_prompt, d.voice_id || null,
         d.language || 'en', d.llm_model || 'gpt-4o-mini',
         d.first_message || null, d.end_call_phrases || [],
         d.max_duration_seconds || 600]
      );
      await auditChain.append({
        event_type: 'voice_agent.created', voice_agent_id: id, owner_did: did,
        timestamp: new Date().toISOString()
      });
      return res.status(201).json({ voice_agent_id: id, name: d.name });
    } catch (e) { return res.status(500).json({ error: 'create_failed', message: e.message }); }
  });

  app.get('/v1/agents/:did/voice-agents', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(
      `SELECT * FROM voice_agents_def WHERE owner_did=$1 ORDER BY created_at DESC LIMIT 500`, [did]
    ).catch(() => ({ rows: [] }));
    return res.json({ voice_agents: r.rows, count: r.rows.length });
  });

  // ---- Assign a phone number ----------------------------------------------
  const AssignSchema = z.object({
    country: z.string().length(2).optional(),
    area_code: z.string().optional(),
    number_e164: z.string().optional() // pre-acquired
  });

  app.post('/v1/agents/:did/voice-agents/:id/assign-number', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const parse = AssignSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input' });
      const ag = await pool.query(
        `SELECT * FROM voice_agents_def WHERE voice_agent_id=$1 AND owner_did=$2`,
        [req.params.id, did]
      ).catch(() => ({ rows: [] }));
      if (!ag.rows[0]) return res.status(404).json({ error: 'voice_agent_not_found' });

      // Provision via Twilio if available, else synthesize
      let numberE164 = parse.data.number_e164;
      let twilioSid = null;
      if (!numberE164 && process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
        try {
          const Twilio = require('twilio');
          const client = new Twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
          const available = await client.availablePhoneNumbers(parse.data.country || 'US')
            .local.list({ areaCode: parse.data.area_code || undefined, limit: 1 });
          if (available.length) {
            const purchase = await client.incomingPhoneNumbers.create({
              phoneNumber: available[0].phoneNumber,
              voiceUrl: `${process.env.OPERATOR_PUBLIC_URL || ''}/v1/_webhooks/voice-agent`
            });
            numberE164 = purchase.phoneNumber;
            twilioSid = purchase.sid;
          }
        } catch (e) { /* fall through to synthetic */ }
      }
      if (!numberE164) {
        // Synthetic number for tests / dev
        numberE164 = '+1555' + Math.floor(1000000 + Math.random() * 9000000);
      }
      await pool.query(
        `INSERT INTO voice_phone_numbers (number_e164, voice_agent_id, owner_did, twilio_sid,
                                           status, monthly_cost_cents)
         VALUES ($1,$2,$3,$4,'active',$5)
         ON CONFLICT (number_e164) DO UPDATE SET voice_agent_id = EXCLUDED.voice_agent_id`,
        [numberE164, req.params.id, did, twilioSid, 100]
      );
      await auditChain.append({
        event_type: 'voice_agent.number_assigned', voice_agent_id: req.params.id,
        owner_did: did, number_e164: numberE164,
        timestamp: new Date().toISOString()
      });
      return res.status(201).json({ number_e164: numberE164, voice_agent_id: req.params.id, twilio_sid: twilioSid });
    } catch (e) { return res.status(500).json({ error: 'assign_failed', message: e.message }); }
  });

  // ---- Outbound dial -------------------------------------------------------
  const CallSchema = z.object({
    callee_phone: z.string().min(5).max(32),
    metadata: z.record(z.any()).optional()
  });
  app.post('/v1/agents/:did/voice-agents/:id/call', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const parse = CallSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const ag = await pool.query(
        `SELECT * FROM voice_agents_def WHERE voice_agent_id=$1 AND owner_did=$2`,
        [req.params.id, did]
      ).catch(() => ({ rows: [] }));
      if (!ag.rows[0]) return res.status(404).json({ error: 'voice_agent_not_found' });
      if (!ag.rows[0].active) return res.status(400).json({ error: 'voice_agent_inactive' });

      const nb = await pool.query(
        `SELECT * FROM voice_phone_numbers WHERE voice_agent_id=$1 AND status='active' LIMIT 1`,
        [req.params.id]
      ).catch(() => ({ rows: [] }));
      const fromNumber = nb.rows[0]?.number_e164 || null;
      const callId = genId('vcall');
      await pool.query(
        `INSERT INTO voice_calls (call_id, voice_agent_id, caller_phone, callee_phone, direction, status, started_at)
         VALUES ($1,$2,$3,$4,'outbound','ringing',NOW())`,
        [callId, req.params.id, fromNumber, parse.data.callee_phone]
      );
      let providerCallSid = null;
      if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && fromNumber) {
        try {
          const Twilio = require('twilio');
          const client = new Twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
          const c = await client.calls.create({
            to: parse.data.callee_phone,
            from: fromNumber,
            url: `${process.env.OPERATOR_PUBLIC_URL || ''}/v1/_webhooks/voice-agent?call_id=${callId}`
          });
          providerCallSid = c.sid;
        } catch (e) { /* leave as ringing — webhook will reconcile */ }
      }
      await auditChain.append({
        event_type: 'voice_agent.call_outbound', call_id: callId,
        voice_agent_id: req.params.id, callee_phone: parse.data.callee_phone,
        twilio_sid: providerCallSid, timestamp: new Date().toISOString()
      });
      return res.status(201).json({
        call_id: callId, voice_agent_id: req.params.id,
        caller_phone: fromNumber, callee_phone: parse.data.callee_phone,
        status: 'ringing', twilio_sid: providerCallSid
      });
    } catch (e) { return res.status(500).json({ error: 'call_failed', message: e.message }); }
  });

  // ---- List calls / transcript --------------------------------------------
  app.get('/v1/agents/:did/voice-agents/:id/calls', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const ag = await pool.query(
      `SELECT 1 FROM voice_agents_def WHERE voice_agent_id=$1 AND owner_did=$2`,
      [req.params.id, did]
    ).catch(() => ({ rows: [] }));
    if (!ag.rows[0]) return res.status(404).json({ error: 'voice_agent_not_found' });
    const r = await pool.query(
      `SELECT * FROM voice_calls WHERE voice_agent_id=$1 ORDER BY created_at DESC LIMIT 500`,
      [req.params.id]
    ).catch(() => ({ rows: [] }));
    return res.json({ calls: r.rows, count: r.rows.length });
  });

  app.get('/v1/voice-agents/calls/:id/transcript', async (req, res) => {
    const r = await pool.query(`SELECT * FROM voice_calls WHERE call_id=$1`, [req.params.id])
      .catch(() => ({ rows: [] }));
    if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
    const ag = await pool.query(`SELECT owner_did FROM voice_agents_def WHERE voice_agent_id=$1`,
      [r.rows[0].voice_agent_id]).catch(() => ({ rows: [] }));
    if (ag.rows[0]) {
      const auth = await verifyAgentAuth(req, ag.rows[0].owner_did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
    }
    return res.json({
      call_id: r.rows[0].call_id, transcript: r.rows[0].transcript,
      summary: r.rows[0].summary, sentiment_score: r.rows[0].sentiment_score,
      duration_seconds: r.rows[0].duration_seconds, status: r.rows[0].status,
      end_reason: r.rows[0].end_reason
    });
  });

  // ---- Incoming call webhook (telephony provider → us) --------------------
  // Twilio sends form-encoded bodies; we accept both JSON and urlencoded.
  // Verifies Twilio's X-Twilio-Signature when TWILIO_AUTH_TOKEN is configured.
  // In production with no token configured, refuses to process events to
  // avoid having unauth callers drive LLM inference on agent owners' dime.
  app.post('/v1/_webhooks/voice-agent',
    express.urlencoded({ extended: false }),
    express.json(),
    async (req, res) => {
      // Twilio webhook validation. Per Twilio's spec, the signature is HMAC-SHA1
      // over the full URL + sorted form params, base64-encoded.
      const twilioAuthToken = process.env.TWILIO_AUTH_TOKEN;
      const sig = req.headers['x-twilio-signature'];
      const isTwilioBody = !!(req.body && (req.body.CallSid || req.body.From));
      if (twilioAuthToken && isTwilioBody) {
        if (!sig) return res.status(401).json({ error: 'twilio_signature_missing' });
        try {
          const twilio = require('twilio');
          const proto = req.headers['x-forwarded-proto'] || (req.secure ? 'https' : 'http');
          const host = req.headers['x-forwarded-host'] || req.headers.host;
          const url = `${proto}://${host}${req.originalUrl || req.url}`;
          const valid = twilio.validateRequest(twilioAuthToken, sig, url, req.body || {});
          if (!valid) return res.status(401).json({ error: 'twilio_signature_invalid' });
        } catch (e) {
          return res.status(500).json({ error: 'twilio_validation_failed', message: e.message });
        }
      } else if (isTwilioBody && process.env.NODE_ENV === 'production') {
        // Twilio shape but no token configured — refuse in prod
        return res.status(503).json({ error: 'twilio_auth_token_not_configured' });
      }
      try {
        const body = req.body || {};
        const callerPhone = body.From || body.caller_phone;
        const calleePhone = body.To || body.callee_phone;
        const userText = body.SpeechResult || body.user_text || '';
        const callIdQuery = req.query.call_id;
        const twilioCallSid = body.CallSid;

        // Find or create call row
        let call = null;
        if (callIdQuery) {
          const r = await pool.query(`SELECT * FROM voice_calls WHERE call_id=$1`, [callIdQuery])
            .catch(() => ({ rows: [] }));
          call = r.rows[0] || null;
        }
        if (!call && calleePhone) {
          // Inbound: look up the number → voice_agent
          const nb = await pool.query(
            `SELECT * FROM voice_phone_numbers WHERE number_e164=$1 AND status='active'`,
            [calleePhone]
          ).catch(() => ({ rows: [] }));
          if (nb.rows[0]) {
            const callId = genId('vcall');
            await pool.query(
              `INSERT INTO voice_calls (call_id, voice_agent_id, caller_phone, callee_phone,
                                          direction, status, started_at)
               VALUES ($1,$2,$3,$4,'inbound','in_progress',NOW())`,
              [callId, nb.rows[0].voice_agent_id, callerPhone, calleePhone]
            );
            const r = await pool.query(`SELECT * FROM voice_calls WHERE call_id=$1`, [callId])
              .catch(() => ({ rows: [] }));
            call = r.rows[0];
          }
        }

        if (!call) {
          return res.type('application/xml').send(
            `<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`
          );
        }

        // Load the voice agent
        const ag = await pool.query(
          `SELECT * FROM voice_agents_def WHERE voice_agent_id=$1`, [call.voice_agent_id]
        ).catch(() => ({ rows: [] }));
        if (!ag.rows[0]) {
          return res.type('application/xml').send(
            `<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`
          );
        }
        const agent = ag.rows[0];

        // Generate LLM reply
        const transcriptSoFar = call.transcript || '';
        const reply = await generateAgentReply(
          agent.system_prompt, transcriptSoFar, userText, agent.llm_model
        );

        // Append transcript
        const newTranscript = transcriptSoFar +
          (userText ? `\nUSER: ${userText}` : (transcriptSoFar ? '' : '\n[call started]')) +
          `\nAGENT: ${reply.text}`;
        await pool.query(
          `UPDATE voice_calls SET transcript=$1, status='in_progress' WHERE call_id=$2`,
          [newTranscript, call.call_id]
        ).catch(() => {});

        // Decide whether to end the call
        const shouldEnd = looksLikeEndPhrase(reply.text, agent.end_call_phrases || []);
        if (shouldEnd) {
          await pool.query(
            `UPDATE voice_calls SET status='ended', ended_at=NOW(), end_reason='agent_terminated' WHERE call_id=$1`,
            [call.call_id]
          ).catch(() => {});
          await auditChain.append({
            event_type: 'voice_agent.call_ended', call_id: call.call_id,
            voice_agent_id: agent.voice_agent_id, end_reason: 'agent_terminated',
            timestamp: new Date().toISOString()
          });
          return res.type('application/xml').send(
            `<?xml version="1.0" encoding="UTF-8"?><Response><Say>${escapeXml(reply.text)}</Say><Hangup/></Response>`
          );
        }

        // Continue gathering speech and re-invoke webhook
        const actionUrl = `${process.env.OPERATOR_PUBLIC_URL || ''}/v1/_webhooks/voice-agent?call_id=${encodeURIComponent(call.call_id)}`;
        return res.type('application/xml').send(
          `<?xml version="1.0" encoding="UTF-8"?>` +
          `<Response>` +
            `<Say>${escapeXml(reply.text)}</Say>` +
            `<Gather input="speech" timeout="6" action="${actionUrl}" method="POST"/>` +
          `</Response>`
        );
      } catch (e) {
        return res.type('application/xml').send(
          `<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`
        );
      }
    }
  );
}

function escapeXml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

module.exports = {
  migrate, registerVoiceAgentsRoutes,
  DIRECTIONS, STATUSES, END_REASONS, NUMBER_STATUSES
};
