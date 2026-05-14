// ============================================================================
// OpenHeab Outreach — Cold outreach campaigns (email/sms/dm)
// ============================================================================
const express = require('express');
const cryptoLib = require('crypto');
const { z } = require('zod');

const CHANNELS = ['email', 'sms', 'dm'];
const CAMPAIGN_STATUSES = ['draft', 'active', 'paused', 'complete'];
const SEND_STATUSES = ['sent', 'opened', 'replied', 'bounced', 'unsubscribed'];

async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS outreach_campaigns (
      campaign_id    TEXT PRIMARY KEY,
      owner_did      TEXT NOT NULL,
      name           TEXT NOT NULL,
      channel        TEXT NOT NULL DEFAULT 'email',
      template_id    TEXT,
      status         TEXT NOT NULL DEFAULT 'draft',
      sent           INTEGER NOT NULL DEFAULT 0,
      opened         INTEGER NOT NULL DEFAULT 0,
      replied        INTEGER NOT NULL DEFAULT 0,
      total_targets  INTEGER NOT NULL DEFAULT 0,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_outreach_campaigns_owner ON outreach_campaigns (owner_did);

    CREATE TABLE IF NOT EXISTS outreach_templates (
      template_id  TEXT PRIMARY KEY,
      owner_did    TEXT NOT NULL,
      name         TEXT NOT NULL,
      subject      TEXT,
      body         TEXT NOT NULL,
      variables    TEXT[] DEFAULT '{}',
      channel      TEXT NOT NULL DEFAULT 'email',
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_outreach_templates_owner ON outreach_templates (owner_did);

    CREATE TABLE IF NOT EXISTS outreach_sends (
      send_id       TEXT PRIMARY KEY,
      campaign_id   TEXT NOT NULL,
      lead_id       TEXT,
      sent_at       TIMESTAMPTZ,
      opened_at     TIMESTAMPTZ,
      replied_at    TIMESTAMPTZ,
      bounced       BOOLEAN DEFAULT FALSE,
      status        TEXT NOT NULL DEFAULT 'sent',
      tracking_id   TEXT UNIQUE
    );
    CREATE INDEX IF NOT EXISTS idx_outreach_sends_campaign ON outreach_sends (campaign_id);
    CREATE INDEX IF NOT EXISTS idx_outreach_sends_lead ON outreach_sends (lead_id);
  `).catch(() => {});
}

function genId(prefix) {
  return `${prefix}_${cryptoLib.randomBytes(12).toString('hex')}`;
}

function registerOutreachRoutes(app, pool, verifyAgentAuth, auditChain, emailPrimitive) {
  const CampaignSchema = z.object({
    name: z.string().min(1).max(300),
    channel: z.enum(CHANNELS).optional(),
    template_id: z.string().optional(),
    total_targets: z.number().int().min(0).optional()
  });

  app.post('/v1/agents/:did/outreach/campaigns', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const parse = CampaignSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;
      const campaignId = genId('cmp');
      await pool.query(
        `INSERT INTO outreach_campaigns (campaign_id, owner_did, name, channel, template_id, total_targets)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [campaignId, did, d.name, d.channel || 'email', d.template_id || null, d.total_targets || 0]
      );
      await auditChain.append({ event_type: 'outreach.campaign_created', campaign_id: campaignId, owner_did: did, timestamp: new Date().toISOString() });
      return res.status(201).json({ campaign_id: campaignId, owner_did: did, status: 'draft' });
    } catch (e) { return res.status(500).json({ error: 'create_failed', message: e.message }); }
  });

  app.post('/v1/agents/:did/outreach/campaigns/:id/start', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(
      `UPDATE outreach_campaigns SET status='active' WHERE campaign_id=$1 AND owner_did=$2 RETURNING campaign_id`,
      [req.params.id, did]
    ).catch(() => ({ rows: [] }));
    if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
    await auditChain.append({ event_type: 'outreach.campaign_started', campaign_id: req.params.id, owner_did: did, timestamp: new Date().toISOString() });
    return res.json({ campaign_id: req.params.id, status: 'active' });
  });

  app.post('/v1/agents/:did/outreach/campaigns/:id/pause', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(
      `UPDATE outreach_campaigns SET status='paused' WHERE campaign_id=$1 AND owner_did=$2 RETURNING campaign_id`,
      [req.params.id, did]
    ).catch(() => ({ rows: [] }));
    if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
    await auditChain.append({ event_type: 'outreach.campaign_paused', campaign_id: req.params.id, owner_did: did, timestamp: new Date().toISOString() });
    return res.json({ campaign_id: req.params.id, status: 'paused' });
  });

  app.get('/v1/agents/:did/outreach/campaigns/:id/stats', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const camp = await pool.query(
      `SELECT * FROM outreach_campaigns WHERE campaign_id=$1 AND owner_did=$2`,
      [req.params.id, did]
    ).catch(() => ({ rows: [] }));
    if (!camp.rows[0]) return res.status(404).json({ error: 'not_found' });
    const c = camp.rows[0];
    const openRate = c.sent > 0 ? (c.opened / c.sent) : 0;
    const replyRate = c.sent > 0 ? (c.replied / c.sent) : 0;
    return res.json({
      campaign_id: req.params.id,
      sent: c.sent, opened: c.opened, replied: c.replied,
      total_targets: c.total_targets, status: c.status,
      open_rate: openRate, reply_rate: replyRate
    });
  });

  const TemplateSchema = z.object({
    name: z.string().min(1).max(300),
    subject: z.string().max(500).optional(),
    body: z.string().min(1).max(50000),
    variables: z.array(z.string()).optional(),
    channel: z.enum(CHANNELS).optional()
  });

  app.post('/v1/agents/:did/outreach/templates', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const parse = TemplateSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;
      const tid = genId('tpl');
      await pool.query(
        `INSERT INTO outreach_templates (template_id, owner_did, name, subject, body, variables, channel)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [tid, did, d.name, d.subject || null, d.body, d.variables || [], d.channel || 'email']
      );
      await auditChain.append({ event_type: 'outreach.template_created', template_id: tid, owner_did: did, timestamp: new Date().toISOString() });
      return res.status(201).json({ template_id: tid, owner_did: did });
    } catch (e) { return res.status(500).json({ error: 'create_failed', message: e.message }); }
  });

  app.get('/v1/agents/:did/outreach/templates', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(
      `SELECT * FROM outreach_templates WHERE owner_did=$1 ORDER BY created_at DESC`, [did]
    ).catch(() => ({ rows: [] }));
    return res.json({ templates: r.rows, count: r.rows.length });
  });

  // Public-ish webhook for email tracking
  app.post('/v1/_webhooks/email-tracking', express.json(), async (req, res) => {
    try {
      const body = z.object({
        tracking_id: z.string(),
        event: z.enum(['opened', 'replied', 'bounced', 'unsubscribed'])
      }).safeParse(req.body || {});
      if (!body.success) return res.status(400).json({ error: 'invalid_input' });
      const { tracking_id, event } = body.data;
      const updates = {
        opened: `opened_at=NOW(), status='opened'`,
        replied: `replied_at=NOW(), status='replied'`,
        bounced: `bounced=TRUE, status='bounced'`,
        unsubscribed: `status='unsubscribed'`
      };
      const r = await pool.query(
        `UPDATE outreach_sends SET ${updates[event]} WHERE tracking_id=$1 RETURNING campaign_id, send_id`,
        [tracking_id]
      ).catch(() => ({ rows: [] }));
      if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
      const campId = r.rows[0].campaign_id;
      if (event === 'opened') await pool.query(`UPDATE outreach_campaigns SET opened=opened+1 WHERE campaign_id=$1`, [campId]).catch(() => {});
      if (event === 'replied') await pool.query(`UPDATE outreach_campaigns SET replied=replied+1 WHERE campaign_id=$1`, [campId]).catch(() => {});
      await auditChain.append({ event_type: `outreach.${event}`, tracking_id, campaign_id: campId, timestamp: new Date().toISOString() });
      return res.json({ ok: true, send_id: r.rows[0].send_id, event });
    } catch (e) { return res.status(500).json({ error: 'tracking_failed', message: e.message }); }
  });
}

module.exports = { migrate, registerOutreachRoutes, CHANNELS, CAMPAIGN_STATUSES };
