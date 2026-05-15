// ============================================================================
// integrations.js — Slack / Discord / Teams / WhatsApp / Telegram / SMS bot
// integrations. Also: webhook receivers for inbound chat platform events.
// Without these we cannot put an agent inside the apps where humans live.
// ============================================================================
const crypto = require('crypto');
const { z } = require('zod');

const PLATFORMS = ['slack', 'discord', 'teams', 'whatsapp', 'telegram', 'sms', 'imessage'];

async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS integration_connections (
      conn_id           TEXT PRIMARY KEY,
      owner_did         TEXT NOT NULL,
      platform          TEXT NOT NULL,
      external_team_id  TEXT,
      external_team_name TEXT,
      access_token_encrypted BYTEA,
      bot_user_id       TEXT,
      scopes            TEXT[],
      installed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      revoked_at        TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_integration_connections_owner ON integration_connections (owner_did);

    CREATE TABLE IF NOT EXISTS integration_messages (
      message_id        TEXT PRIMARY KEY,
      conn_id           TEXT NOT NULL,
      external_msg_id   TEXT,
      channel           TEXT,
      direction         TEXT NOT NULL,
      from_external_id  TEXT,
      text              TEXT,
      payload           JSONB,
      occurred_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_integration_messages_conn ON integration_messages (conn_id, occurred_at DESC);
  `);
}

function getMasterKek() {
  const raw = process.env.INTEGRATIONS_MASTER_KEK || process.env.IDENTITY_MASTER_KEK || process.env.CRYPTO_MASTER_KEK;
  if (!raw) throw new Error('master_kek_unset');
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, 'hex');
  return crypto.createHash('sha256').update(raw).digest();
}
function encrypt(text) {
  const kek = getMasterKek();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', kek, iv);
  const ct = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]);
}
function decrypt(buf) {
  const kek = getMasterKek();
  const iv = buf.subarray(0, 12), tag = buf.subarray(12, 28), ct = buf.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', kek, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}
function newId(p) { return p + '_' + crypto.randomBytes(10).toString('hex'); }

const installSchema = z.object({
  platform: z.enum(PLATFORMS),
  access_token: z.string().min(1),
  external_team_id: z.string().optional(),
  external_team_name: z.string().optional(),
  bot_user_id: z.string().optional(),
  scopes: z.array(z.string()).optional()
});

const sendSchema = z.object({
  channel: z.string(),
  text: z.string().min(1).max(4000),
  payload: z.record(z.any()).optional()
});

function registerIntegrationsRoutes(app, pool, verifyAgentAuth, auditChain) {
  const express = require('express');

  app.post('/v1/agents/:did/integrations/install', express.json(), async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const p = installSchema.safeParse(req.body || {});
    if (!p.success) return res.status(400).json({ error: 'invalid_input', details: p.error.flatten() });
    const id = newId('conn');
    let enc;
    try { enc = encrypt(p.data.access_token); }
    catch { return res.status(500).json({ error: 'kek_unavailable' }); }
    await pool.query(
      `INSERT INTO integration_connections (conn_id, owner_did, platform, external_team_id,
         external_team_name, access_token_encrypted, bot_user_id, scopes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [id, did, p.data.platform, p.data.external_team_id || null,
       p.data.external_team_name || null, enc, p.data.bot_user_id || null, p.data.scopes || null]
    );
    if (auditChain) await auditChain.append({ event_type: 'integration.installed', owner_did: did, platform: p.data.platform, conn_id: id }).catch(() => {});
    res.status(201).json({ conn_id: id, platform: p.data.platform });
  });

  app.get('/v1/agents/:did/integrations', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(`
      SELECT conn_id, platform, external_team_name, bot_user_id, scopes, installed_at, revoked_at
      FROM integration_connections WHERE owner_did=$1
    `, [did]).catch(() => ({ rows: [] }));
    res.json({ connections: r.rows });
  });

  app.post('/v1/agents/:did/integrations/:cid/send', express.json(), async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const p = sendSchema.safeParse(req.body || {});
    if (!p.success) return res.status(400).json({ error: 'invalid_input', details: p.error.flatten() });
    const id = newId('msg');
    await pool.query(
      `INSERT INTO integration_messages (message_id, conn_id, channel, direction, text, payload)
       VALUES ($1,$2,$3,'out',$4,$5)`,
      [id, req.params.cid, p.data.channel, p.data.text, JSON.stringify(p.data.payload || {})]
    );
    if (auditChain) await auditChain.append({ event_type: 'integration.message_sent', conn_id: req.params.cid, channel: p.data.channel }).catch(() => {});
    res.status(201).json({ message_id: id, status: 'queued' });
  });

  // Webhook receivers — one path per platform
  for (const platform of PLATFORMS) {
    app.post(`/v1/_webhooks/${platform}`, express.json({ limit: '5mb' }), async (req, res) => {
      const id = newId('msg');
      await pool.query(
        `INSERT INTO integration_messages (message_id, conn_id, external_msg_id, channel,
           direction, from_external_id, text, payload)
         VALUES ($1,$2,$3,$4,'in',$5,$6,$7)`,
        [id, req.body?.team_id || 'unknown', req.body?.event?.client_msg_id || null,
         req.body?.event?.channel || req.body?.channel?.id || null,
         req.body?.event?.user || req.body?.from || null,
         req.body?.event?.text || req.body?.text || null,
         JSON.stringify(req.body || {})]
      ).catch(() => {});
      // Slack URL verification challenge
      if (platform === 'slack' && req.body?.type === 'url_verification') {
        return res.json({ challenge: req.body.challenge });
      }
      res.json({ ok: true });
    });
  }

  app.get('/v1/agents/:did/integrations/:cid/messages', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(`
      SELECT message_id, channel, direction, from_external_id, text, occurred_at
      FROM integration_messages WHERE conn_id=$1 ORDER BY occurred_at DESC LIMIT 200
    `, [req.params.cid]).catch(() => ({ rows: [] }));
    res.json({ messages: r.rows });
  });
}

module.exports = { migrate, registerIntegrationsRoutes, PLATFORMS };
