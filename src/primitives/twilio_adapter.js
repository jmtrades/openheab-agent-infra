// twilio_adapter.js — REAL voice + SMS via Twilio API.
const crypto = require('crypto');
const { z } = require('zod');

const BASE = 'https://api.twilio.com/2010-04-01';

async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS twilio_messages (
      message_id TEXT PRIMARY KEY, agent_did TEXT,
      kind TEXT NOT NULL, to_number TEXT NOT NULL, from_number TEXT,
      body TEXT, twilio_sid TEXT, cost_cents INTEGER,
      status TEXT NOT NULL DEFAULT 'queued', error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_twilio_messages_agent ON twilio_messages (agent_did, created_at DESC);
  `);
}
function newId(p) { return p + '_' + crypto.randomBytes(10).toString('hex'); }

async function callTwilio(kind, params) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const tok = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !tok) return { stub: true, sid: 'SMstub_' + crypto.randomBytes(8).toString('hex'), status: 'queued' };
  if (typeof fetch !== 'function') throw new Error('fetch_unavailable');
  const path = kind === 'sms' ? `Accounts/${sid}/Messages.json` : `Accounts/${sid}/Calls.json`;
  const formBody = new URLSearchParams(params).toString();
  const auth = 'Basic ' + Buffer.from(`${sid}:${tok}`).toString('base64');
  const r = await fetch(`${BASE}/${path}`, {
    method: 'POST', headers: { authorization: auth, 'content-type': 'application/x-www-form-urlencoded' }, body: formBody
  });
  const json = await r.json();
  if (!r.ok) throw new Error(`twilio_${r.status}_${json.message || JSON.stringify(json).slice(0, 200)}`);
  return json;
}

const smsSchema = z.object({ to: z.string(), body: z.string().min(1).max(1600), from: z.string().optional() });
const callSchema = z.object({ to: z.string(), from: z.string().optional(), twiml_url: z.string().url().optional(), say: z.string().optional() });

function registerTwilioAdapterRoutes(app, pool, verifyAgentAuth, auditChain) {
  const express = require('express');
  app.post('/v1/agents/:did/twilio/sms', express.json(), async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const p = smsSchema.safeParse(req.body || {});
    if (!p.success) return res.status(400).json({ error: 'invalid_input', details: p.error.flatten() });
    const from = p.data.from || process.env.TWILIO_PHONE_NUMBER;
    if (!from) return res.status(400).json({ error: 'from_number_required' });
    const id = newId('twsms');
    try {
      const out = await callTwilio('sms', { To: p.data.to, From: from, Body: p.data.body });
      await pool.query(`INSERT INTO twilio_messages (message_id, agent_did, kind, to_number, from_number, body, twilio_sid, status) VALUES ($1,$2,'sms',$3,$4,$5,$6,'sent')`,
        [id, did, p.data.to, from, p.data.body, out.sid]).catch(() => {});
      if (auditChain) await auditChain.append({ event_type: 'twilio.sms_sent', agent_did: did, message_id: id, to: p.data.to }).catch(() => {});
      res.status(201).json({ message_id: id, sid: out.sid, stub: !!out.stub });
    } catch (e) {
      await pool.query(`INSERT INTO twilio_messages (message_id, agent_did, kind, to_number, body, status, error) VALUES ($1,$2,'sms',$3,$4,'failed',$5)`,
        [id, did, p.data.to, p.data.body, e.message]).catch(() => {});
      res.status(502).json({ error: 'twilio_failed', message: e.message });
    }
  });

  app.post('/v1/agents/:did/twilio/call', express.json(), async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const p = callSchema.safeParse(req.body || {});
    if (!p.success) return res.status(400).json({ error: 'invalid_input', details: p.error.flatten() });
    const from = p.data.from || process.env.TWILIO_PHONE_NUMBER;
    if (!from) return res.status(400).json({ error: 'from_number_required' });
    const id = newId('twcall');
    const params = { To: p.data.to, From: from };
    if (p.data.twiml_url) params.Url = p.data.twiml_url;
    else if (p.data.say) params.Twiml = `<Response><Say>${String(p.data.say).replace(/[<>&]/g, '')}</Say></Response>`;
    try {
      const out = await callTwilio('call', params);
      await pool.query(`INSERT INTO twilio_messages (message_id, agent_did, kind, to_number, from_number, twilio_sid, status) VALUES ($1,$2,'call',$3,$4,$5,'initiated')`,
        [id, did, p.data.to, from, out.sid]).catch(() => {});
      if (auditChain) await auditChain.append({ event_type: 'twilio.call_initiated', agent_did: did, message_id: id, to: p.data.to }).catch(() => {});
      res.status(201).json({ message_id: id, sid: out.sid, stub: !!out.stub });
    } catch (e) { res.status(502).json({ error: 'twilio_failed', message: e.message }); }
  });
}
module.exports = { migrate, registerTwilioAdapterRoutes, callTwilio };
