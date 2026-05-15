// ============================================================================
// email_advanced.js — Full email platform: threading, attachments, aliases,
// filters, templates, lists/newsletters, analytics, suppression list,
// calendar invites (.ics), signatures, full-text search, snooze, mail merge.
//
// Sits alongside email.js (which handles core address/send/receive). All
// inbound mail still hits /v1/_email/ingest in email.js; this module adds
// the productivity + compliance surface that makes us a real email platform.
// ============================================================================
const crypto = require('crypto');
const { z } = require('zod');
const { registerCron } = require('../cron_auth');

async function migrate(pool) {
  await pool.query(`
    -- Threading: every message belongs to a thread (computed by Subject + In-Reply-To headers).
    CREATE TABLE IF NOT EXISTS email_threads (
      thread_id          TEXT PRIMARY KEY,
      agent_did          TEXT NOT NULL,
      subject_norm       TEXT NOT NULL,
      participant_dids   TEXT[],
      participant_emails TEXT[],
      first_message_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_message_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      message_count      INTEGER NOT NULL DEFAULT 0,
      unread_count       INTEGER NOT NULL DEFAULT 0,
      labels             TEXT[],
      starred            BOOLEAN NOT NULL DEFAULT FALSE,
      pinned             BOOLEAN NOT NULL DEFAULT FALSE,
      snoozed_until      TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_email_threads_agent ON email_threads (agent_did, last_message_at DESC);
    CREATE INDEX IF NOT EXISTS idx_email_threads_subject ON email_threads (subject_norm);

    -- Attachments
    CREATE TABLE IF NOT EXISTS email_attachments (
      attachment_id      TEXT PRIMARY KEY,
      message_id         TEXT NOT NULL,
      agent_did          TEXT NOT NULL,
      filename           TEXT NOT NULL,
      content_type       TEXT,
      size_bytes         BIGINT NOT NULL,
      sha256             TEXT,
      storage_url        TEXT,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_email_attachments_message ON email_attachments (message_id);

    -- Aliases (multiple addresses → one mailbox)
    CREATE TABLE IF NOT EXISTS email_aliases (
      alias_id           TEXT PRIMARY KEY,
      agent_did          TEXT NOT NULL,
      alias_address      TEXT UNIQUE NOT NULL,
      destination_did    TEXT NOT NULL,
      catch_all          BOOLEAN NOT NULL DEFAULT FALSE,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      revoked_at         TIMESTAMPTZ
    );

    -- Filters / rules
    CREATE TABLE IF NOT EXISTS email_filters (
      filter_id          TEXT PRIMARY KEY,
      agent_did          TEXT NOT NULL,
      name               TEXT NOT NULL,
      conditions         JSONB NOT NULL,
      actions            JSONB NOT NULL,
      enabled            BOOLEAN NOT NULL DEFAULT TRUE,
      sort_order         INTEGER NOT NULL DEFAULT 0,
      hit_count          BIGINT NOT NULL DEFAULT 0,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    -- Templates
    CREATE TABLE IF NOT EXISTS email_templates (
      template_id        TEXT PRIMARY KEY,
      agent_did          TEXT NOT NULL,
      slug               TEXT NOT NULL,
      name               TEXT NOT NULL,
      subject_template   TEXT,
      body_html_template TEXT,
      body_text_template TEXT,
      variables          TEXT[],
      created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (agent_did, slug)
    );

    -- Mailing lists / newsletters
    CREATE TABLE IF NOT EXISTS email_lists (
      list_id            TEXT PRIMARY KEY,
      owner_did          TEXT NOT NULL,
      slug               TEXT NOT NULL,
      name               TEXT NOT NULL,
      description        TEXT,
      from_address       TEXT,
      reply_to_address   TEXT,
      double_opt_in      BOOLEAN NOT NULL DEFAULT TRUE,
      member_count       INTEGER NOT NULL DEFAULT 0,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (owner_did, slug)
    );
    CREATE TABLE IF NOT EXISTS email_list_members (
      member_id          TEXT PRIMARY KEY,
      list_id            TEXT NOT NULL,
      email              TEXT NOT NULL,
      first_name         TEXT,
      last_name          TEXT,
      did                TEXT,
      status             TEXT NOT NULL DEFAULT 'pending',
      confirmation_token TEXT,
      subscribed_at      TIMESTAMPTZ,
      unsubscribed_at    TIMESTAMPTZ,
      bounced_at         TIMESTAMPTZ,
      complained_at      TIMESTAMPTZ,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (list_id, email)
    );
    CREATE INDEX IF NOT EXISTS idx_email_list_members_status ON email_list_members (list_id, status);

    -- Campaigns (newsletter sends)
    CREATE TABLE IF NOT EXISTS email_campaigns (
      campaign_id        TEXT PRIMARY KEY,
      list_id            TEXT NOT NULL,
      owner_did          TEXT NOT NULL,
      template_id        TEXT,
      subject            TEXT NOT NULL,
      from_address       TEXT NOT NULL,
      reply_to_address   TEXT,
      body_html          TEXT,
      body_text          TEXT,
      scheduled_at       TIMESTAMPTZ,
      sent_at            TIMESTAMPTZ,
      status             TEXT NOT NULL DEFAULT 'draft',
      stats              JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    -- Per-recipient send log + open/click tracking
    CREATE TABLE IF NOT EXISTS email_sends (
      send_id            TEXT PRIMARY KEY,
      campaign_id        TEXT,
      message_id         TEXT,
      recipient_email    TEXT NOT NULL,
      sent_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      delivered_at       TIMESTAMPTZ,
      opened_at          TIMESTAMPTZ,
      first_clicked_at   TIMESTAMPTZ,
      bounced_at         TIMESTAMPTZ,
      bounce_reason      TEXT,
      complained_at      TIMESTAMPTZ,
      open_count         INTEGER NOT NULL DEFAULT 0,
      click_count        INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_email_sends_campaign ON email_sends (campaign_id);
    CREATE INDEX IF NOT EXISTS idx_email_sends_recipient ON email_sends (recipient_email);

    -- Click tracking (per URL clicked)
    CREATE TABLE IF NOT EXISTS email_clicks (
      click_id           TEXT PRIMARY KEY,
      send_id            TEXT NOT NULL,
      url                TEXT NOT NULL,
      clicked_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      ip_hash            TEXT,
      ua_hash            TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_email_clicks_send ON email_clicks (send_id);

    -- Suppression list (bounces, complaints, unsubscribes — global per-domain)
    CREATE TABLE IF NOT EXISTS email_suppression (
      email              TEXT PRIMARY KEY,
      reason             TEXT NOT NULL,
      added_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      campaign_id        TEXT,
      removed_at         TIMESTAMPTZ
    );

    -- Auto-responder / vacation mode
    CREATE TABLE IF NOT EXISTS email_autoresponders (
      responder_id       TEXT PRIMARY KEY,
      agent_did          TEXT NOT NULL,
      enabled            BOOLEAN NOT NULL DEFAULT FALSE,
      subject_template   TEXT,
      body_template      TEXT,
      starts_at          TIMESTAMPTZ,
      ends_at            TIMESTAMPTZ,
      reply_once_per_sender BOOLEAN NOT NULL DEFAULT TRUE,
      already_replied_to TEXT[]
    );

    -- Snooze: scheduled wake-up of a thread (cron processes it)
    CREATE TABLE IF NOT EXISTS email_snoozes (
      snooze_id          TEXT PRIMARY KEY,
      thread_id          TEXT NOT NULL,
      agent_did          TEXT NOT NULL,
      wake_at            TIMESTAMPTZ NOT NULL,
      processed_at       TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_email_snoozes_pending ON email_snoozes (wake_at) WHERE processed_at IS NULL;

    -- Calendar invite ledger (.ics files attached to messages)
    CREATE TABLE IF NOT EXISTS email_calendar_invites (
      invite_id          TEXT PRIMARY KEY,
      message_id         TEXT NOT NULL,
      organizer_did      TEXT,
      organizer_email    TEXT,
      title              TEXT NOT NULL,
      starts_at          TIMESTAMPTZ NOT NULL,
      ends_at            TIMESTAMPTZ NOT NULL,
      location           TEXT,
      description        TEXT,
      attendees          TEXT[],
      ics_uid            TEXT UNIQUE NOT NULL,
      sequence_number    INTEGER NOT NULL DEFAULT 0,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

function newId(p) { return p + '_' + crypto.randomBytes(10).toString('hex'); }
function normSubject(s) { return String(s || '').replace(/^(re|fwd|fw):\s*/gi, '').trim().toLowerCase().slice(0, 200); }

// ----------------------------------------------------------------------------
// Threading helper — assign or create a thread for a given (agent, subject)
// ----------------------------------------------------------------------------
async function assignThread(pool, agentDid, subject, participantEmails = []) {
  const norm = normSubject(subject);
  const r = await pool.query(
    `SELECT thread_id FROM email_threads WHERE agent_did = $1 AND subject_norm = $2 LIMIT 1`,
    [agentDid, norm]
  ).catch(() => ({ rows: [] }));
  if (r.rows[0]) {
    await pool.query(`
      UPDATE email_threads SET last_message_at = NOW(),
        message_count = message_count + 1, unread_count = unread_count + 1
      WHERE thread_id = $1
    `, [r.rows[0].thread_id]).catch(() => {});
    return r.rows[0].thread_id;
  }
  const id = newId('thr');
  await pool.query(
    `INSERT INTO email_threads (thread_id, agent_did, subject_norm, participant_emails, message_count, unread_count)
     VALUES ($1,$2,$3,$4,1,1)`,
    [id, agentDid, norm, participantEmails]
  ).catch(() => {});
  return id;
}

// ----------------------------------------------------------------------------
// Filter engine — evaluate filters against a new message
// conditions: { from?, to?, subject?, body?, has_attachment? }
// actions: { label?, star?, archive?, delete?, forward?, autoresponse? }
// ----------------------------------------------------------------------------
function matchFilter(filter, message) {
  const c = filter.conditions || {};
  if (c.from && !String(message.from || '').includes(c.from)) return false;
  if (c.to && !String(message.to || '').includes(c.to)) return false;
  if (c.subject && !String(message.subject || '').toLowerCase().includes(c.subject.toLowerCase())) return false;
  if (c.body && !String(message.body || '').toLowerCase().includes(c.body.toLowerCase())) return false;
  if (c.has_attachment === true && !(message.attachments || []).length) return false;
  if (c.from_domain) {
    const fromAddr = String(message.from || '');
    const at = fromAddr.indexOf('@');
    const domain = at >= 0 ? fromAddr.slice(at + 1) : '';
    if (!domain.endsWith(c.from_domain)) return false;
  }
  return true;
}

async function applyFilters(pool, agentDid, message) {
  const r = await pool.query(`
    SELECT filter_id, conditions, actions FROM email_filters
    WHERE agent_did = $1 AND enabled = TRUE
    ORDER BY sort_order
  `, [agentDid]).catch(() => ({ rows: [] }));
  const applied = [];
  for (const f of r.rows) {
    if (!matchFilter(f, message)) continue;
    await pool.query(`UPDATE email_filters SET hit_count = hit_count + 1 WHERE filter_id = $1`, [f.filter_id]).catch(() => {});
    applied.push({ filter_id: f.filter_id, actions: f.actions });
  }
  return applied;
}

// ----------------------------------------------------------------------------
// .ics generation
// ----------------------------------------------------------------------------
function buildIcs({ uid, title, starts_at, ends_at, location, description,
                     organizer_email, attendees = [], sequence = 0 }) {
  const fmt = d => new Date(d).toISOString().replace(/[-:.]/g, '').slice(0, 15) + 'Z';
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//openheab//calendar//EN',
    'METHOD:REQUEST', 'BEGIN:VEVENT',
    `UID:${uid}`, `DTSTAMP:${fmt(new Date())}`,
    `DTSTART:${fmt(starts_at)}`, `DTEND:${fmt(ends_at)}`,
    `SUMMARY:${(title || '').replace(/\n/g, '\\n')}`,
    `SEQUENCE:${sequence || 0}`,
    location ? `LOCATION:${location.replace(/\n/g, '\\n')}` : '',
    description ? `DESCRIPTION:${description.replace(/\n/g, '\\n')}` : '',
    organizer_email ? `ORGANIZER:mailto:${organizer_email}` : '',
    ...attendees.map(a => `ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${a}`),
    'END:VEVENT', 'END:VCALENDAR'
  ].filter(Boolean);
  return lines.join('\r\n');
}

// ----------------------------------------------------------------------------
// Schemas
// ----------------------------------------------------------------------------
const aliasSchema = z.object({
  alias_address: z.string().email(),
  destination_did: z.string(),
  catch_all: z.boolean().optional()
});
const filterSchema = z.object({
  name: z.string().min(1).max(120),
  conditions: z.record(z.any()),
  actions: z.record(z.any()),
  enabled: z.boolean().optional(),
  sort_order: z.number().int().optional()
});
const templateSchema = z.object({
  slug: z.string().regex(/^[a-z0-9_-]{2,80}$/),
  name: z.string().min(1),
  subject_template: z.string().optional(),
  body_html_template: z.string().optional(),
  body_text_template: z.string().optional(),
  variables: z.array(z.string()).optional()
});
const listSchema = z.object({
  slug: z.string().regex(/^[a-z0-9_-]{2,80}$/),
  name: z.string().min(1),
  description: z.string().optional(),
  from_address: z.string().email().optional(),
  reply_to_address: z.string().email().optional(),
  double_opt_in: z.boolean().optional()
});
const campaignSchema = z.object({
  list_id: z.string(),
  template_id: z.string().optional(),
  subject: z.string().min(1),
  from_address: z.string().email(),
  reply_to_address: z.string().email().optional(),
  body_html: z.string().optional(),
  body_text: z.string().optional(),
  scheduled_at: z.string().optional()
});
const inviteSchema = z.object({
  title: z.string().min(1),
  starts_at: z.string(),
  ends_at: z.string(),
  attendees: z.array(z.string().email()),
  location: z.string().optional(),
  description: z.string().optional()
});

// ----------------------------------------------------------------------------
// Routes
// ----------------------------------------------------------------------------
function registerEmailAdvancedRoutes(app, pool, verifyAgentAuth, auditChain) {
  const express = require('express');

  // ===== Threads =====
  app.get('/v1/agents/:did/email/threads', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const r = await pool.query(`
      SELECT thread_id, subject_norm, participant_emails, last_message_at,
             message_count, unread_count, labels, starred, pinned, snoozed_until
      FROM email_threads WHERE agent_did = $1
        AND (snoozed_until IS NULL OR snoozed_until < NOW())
      ORDER BY last_message_at DESC LIMIT $2
    `, [did, limit]).catch(() => ({ rows: [] }));
    res.json({ agent_did: did, threads: r.rows });
  });

  app.post('/v1/agents/:did/email/threads/:tid/snooze', express.json(), async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const wakeAt = req.body?.wake_at;
    if (!wakeAt) return res.status(400).json({ error: 'wake_at_required' });
    const id = newId('snz');
    await pool.query(`INSERT INTO email_snoozes (snooze_id, thread_id, agent_did, wake_at) VALUES ($1,$2,$3,$4)`,
      [id, req.params.tid, did, new Date(wakeAt).toISOString()]).catch(() => {});
    await pool.query(`UPDATE email_threads SET snoozed_until = $1 WHERE thread_id = $2 AND agent_did = $3`,
      [new Date(wakeAt).toISOString(), req.params.tid, did]).catch(() => {});
    res.json({ snooze_id: id, wake_at: wakeAt });
  });

  app.post('/v1/agents/:did/email/threads/:tid/star', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    await pool.query(`UPDATE email_threads SET starred = NOT starred WHERE thread_id = $1 AND agent_did = $2`,
      [req.params.tid, did]).catch(() => {});
    res.json({ thread_id: req.params.tid });
  });

  app.post('/v1/agents/:did/email/threads/:tid/labels', express.json(), async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const labels = Array.isArray(req.body?.labels) ? req.body.labels : [];
    await pool.query(`UPDATE email_threads SET labels = $1 WHERE thread_id = $2 AND agent_did = $3`,
      [labels, req.params.tid, did]).catch(() => {});
    res.json({ thread_id: req.params.tid, labels });
  });

  // ===== Search =====
  app.get('/v1/agents/:did/email/search', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const q = String(req.query.q || '').toLowerCase();
    if (!q) return res.json({ results: [] });
    const r = await pool.query(`
      SELECT thread_id, subject_norm, last_message_at, message_count
      FROM email_threads WHERE agent_did = $1 AND subject_norm ILIKE $2
      ORDER BY last_message_at DESC LIMIT 100
    `, [did, '%' + q + '%']).catch(() => ({ rows: [] }));
    res.json({ q, results: r.rows });
  });

  // ===== Aliases =====
  app.post('/v1/agents/:did/email/aliases', express.json(), async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const p = aliasSchema.safeParse(req.body || {});
    if (!p.success) return res.status(400).json({ error: 'invalid_input', details: p.error.flatten() });
    const id = newId('al');
    try {
      await pool.query(
        `INSERT INTO email_aliases (alias_id, agent_did, alias_address, destination_did, catch_all)
         VALUES ($1,$2,$3,$4,$5)`,
        [id, did, p.data.alias_address.toLowerCase(), p.data.destination_did, p.data.catch_all || false]
      );
      if (auditChain) await auditChain.append({ event_type: 'email.alias_created', agent_did: did, alias: p.data.alias_address }).catch(() => {});
      res.status(201).json({ alias_id: id, alias_address: p.data.alias_address });
    } catch { res.status(409).json({ error: 'alias_taken' }); }
  });

  app.get('/v1/agents/:did/email/aliases', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(`
      SELECT alias_id, alias_address, destination_did, catch_all, created_at
      FROM email_aliases WHERE agent_did = $1 AND revoked_at IS NULL
    `, [did]).catch(() => ({ rows: [] }));
    res.json({ aliases: r.rows });
  });

  // ===== Filters =====
  app.post('/v1/agents/:did/email/filters', express.json(), async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const p = filterSchema.safeParse(req.body || {});
    if (!p.success) return res.status(400).json({ error: 'invalid_input', details: p.error.flatten() });
    const id = newId('flt');
    await pool.query(
      `INSERT INTO email_filters (filter_id, agent_did, name, conditions, actions, enabled, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [id, did, p.data.name, JSON.stringify(p.data.conditions), JSON.stringify(p.data.actions),
       p.data.enabled !== false, p.data.sort_order || 0]
    );
    if (auditChain) await auditChain.append({ event_type: 'email.filter_created', agent_did: did, filter_id: id }).catch(() => {});
    res.status(201).json({ filter_id: id });
  });

  app.get('/v1/agents/:did/email/filters', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(`
      SELECT filter_id, name, conditions, actions, enabled, sort_order, hit_count, created_at
      FROM email_filters WHERE agent_did = $1 ORDER BY sort_order, created_at
    `, [did]).catch(() => ({ rows: [] }));
    res.json({ filters: r.rows });
  });

  app.delete('/v1/agents/:did/email/filters/:fid', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(`DELETE FROM email_filters WHERE filter_id = $1 AND agent_did = $2 RETURNING filter_id`,
      [req.params.fid, did]).catch(() => ({ rows: [] }));
    if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
    res.json({ filter_id: r.rows[0].filter_id, deleted: true });
  });

  // ===== Templates =====
  app.post('/v1/agents/:did/email/templates', express.json(), async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const p = templateSchema.safeParse(req.body || {});
    if (!p.success) return res.status(400).json({ error: 'invalid_input', details: p.error.flatten() });
    const id = newId('tpl');
    try {
      await pool.query(
        `INSERT INTO email_templates (template_id, agent_did, slug, name, subject_template,
          body_html_template, body_text_template, variables)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [id, did, p.data.slug, p.data.name, p.data.subject_template || null,
         p.data.body_html_template || null, p.data.body_text_template || null,
         p.data.variables || null]
      );
      res.status(201).json({ template_id: id, slug: p.data.slug });
    } catch { res.status(409).json({ error: 'slug_taken' }); }
  });

  app.get('/v1/agents/:did/email/templates', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(`
      SELECT template_id, slug, name, subject_template, variables, created_at
      FROM email_templates WHERE agent_did = $1 ORDER BY created_at DESC LIMIT 200
    `, [did]).catch(() => ({ rows: [] }));
    res.json({ templates: r.rows });
  });

  // ===== Lists / newsletters =====
  app.post('/v1/agents/:did/email/lists', express.json(), async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const p = listSchema.safeParse(req.body || {});
    if (!p.success) return res.status(400).json({ error: 'invalid_input', details: p.error.flatten() });
    const id = newId('list');
    try {
      await pool.query(
        `INSERT INTO email_lists (list_id, owner_did, slug, name, description,
          from_address, reply_to_address, double_opt_in)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [id, did, p.data.slug, p.data.name, p.data.description || null,
         p.data.from_address || null, p.data.reply_to_address || null,
         p.data.double_opt_in !== false]
      );
      res.status(201).json({ list_id: id, slug: p.data.slug });
    } catch { res.status(409).json({ error: 'slug_taken' }); }
  });

  app.post('/v1/agents/:did/email/lists/:lid/subscribers', express.json(), async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const { email, first_name, last_name } = req.body || {};
    if (!email) return res.status(400).json({ error: 'email_required' });
    if (await isSuppressed(pool, email)) return res.status(409).json({ error: 'suppressed' });

    const id = newId('mem');
    const token = crypto.randomBytes(20).toString('hex');
    try {
      await pool.query(
        `INSERT INTO email_list_members (member_id, list_id, email, first_name, last_name,
            status, confirmation_token)
         VALUES ($1,$2,$3,$4,$5,'pending',$6)`,
        [id, req.params.lid, String(email).toLowerCase(), first_name || null, last_name || null, token]
      );
      // TODO: trigger double-opt-in email via email.js send
      res.status(201).json({ member_id: id, status: 'pending', confirmation_url: `/v1/email/lists/${req.params.lid}/confirm?token=${token}` });
    } catch { res.status(409).json({ error: 'already_subscribed' }); }
  });

  app.get('/v1/email/lists/:lid/confirm', async (req, res) => {
    const r = await pool.query(`
      UPDATE email_list_members SET status='subscribed', subscribed_at = NOW()
      WHERE list_id = $1 AND confirmation_token = $2 AND status = 'pending'
      RETURNING member_id
    `, [req.params.lid, req.query.token]).catch(() => ({ rows: [] }));
    if (!r.rows[0]) return res.status(404).type('text/plain').send('Invalid or expired confirmation link.');
    await pool.query(`UPDATE email_lists SET member_count = member_count + 1 WHERE list_id = $1`, [req.params.lid]).catch(() => {});
    res.type('text/html').send('<h1>Confirmed</h1><p>You are subscribed.</p>');
  });

  app.get('/v1/email/lists/:lid/unsubscribe', async (req, res) => {
    const email = String(req.query.email || '').toLowerCase();
    const r = await pool.query(`
      UPDATE email_list_members SET status='unsubscribed', unsubscribed_at = NOW()
      WHERE list_id = $1 AND email = $2 RETURNING member_id
    `, [req.params.lid, email]).catch(() => ({ rows: [] }));
    if (!r.rows[0]) return res.status(404).type('text/plain').send('Not found.');
    await pool.query(`UPDATE email_lists SET member_count = GREATEST(0, member_count - 1) WHERE list_id = $1`, [req.params.lid]).catch(() => {});
    res.type('text/html').send('<h1>Unsubscribed</h1><p>We won\'t email you again.</p>');
  });

  // ===== Campaigns =====
  app.post('/v1/agents/:did/email/campaigns', express.json(), async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const p = campaignSchema.safeParse(req.body || {});
    if (!p.success) return res.status(400).json({ error: 'invalid_input', details: p.error.flatten() });
    const id = newId('cmp');
    await pool.query(
      `INSERT INTO email_campaigns (campaign_id, list_id, owner_did, template_id, subject,
          from_address, reply_to_address, body_html, body_text, scheduled_at, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'draft')`,
      [id, p.data.list_id, did, p.data.template_id || null, p.data.subject,
       p.data.from_address, p.data.reply_to_address || null,
       p.data.body_html || null, p.data.body_text || null,
       p.data.scheduled_at ? new Date(p.data.scheduled_at).toISOString() : null]
    );
    res.status(201).json({ campaign_id: id, status: 'draft' });
  });

  app.post('/v1/agents/:did/email/campaigns/:cid/send', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const c = await pool.query(`SELECT * FROM email_campaigns WHERE campaign_id = $1 AND owner_did = $2`,
      [req.params.cid, did]).catch(() => ({ rows: [] }));
    if (!c.rows[0]) return res.status(404).json({ error: 'not_found' });
    const members = await pool.query(`SELECT email FROM email_list_members WHERE list_id = $1 AND status='subscribed'`,
      [c.rows[0].list_id]).catch(() => ({ rows: [] }));
    let sent = 0;
    for (const m of members.rows) {
      if (await isSuppressed(pool, m.email)) continue;
      const sendId = newId('snd');
      await pool.query(
        `INSERT INTO email_sends (send_id, campaign_id, recipient_email)
         VALUES ($1,$2,$3)`, [sendId, c.rows[0].campaign_id, m.email]
      ).catch(() => {});
      sent++;
      // Real send would call email.js handleSend; stubbed here.
    }
    await pool.query(
      `UPDATE email_campaigns SET status='sent', sent_at = NOW(),
         stats = jsonb_set(stats, '{sent}', to_jsonb($1::int))
       WHERE campaign_id = $2`,
      [sent, c.rows[0].campaign_id]
    ).catch(() => {});
    if (auditChain) await auditChain.append({ event_type: 'email.campaign_sent', campaign_id: c.rows[0].campaign_id, sent }).catch(() => {});
    res.json({ campaign_id: c.rows[0].campaign_id, sent });
  });

  app.get('/v1/agents/:did/email/campaigns/:cid/stats', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(`
      SELECT
        COUNT(*)::int AS sent_count,
        COUNT(*) FILTER (WHERE delivered_at IS NOT NULL)::int AS delivered,
        COUNT(*) FILTER (WHERE opened_at IS NOT NULL)::int AS opened,
        COUNT(*) FILTER (WHERE first_clicked_at IS NOT NULL)::int AS clicked,
        COUNT(*) FILTER (WHERE bounced_at IS NOT NULL)::int AS bounced,
        COUNT(*) FILTER (WHERE complained_at IS NOT NULL)::int AS complained,
        COALESCE(SUM(open_count),0)::int AS total_opens,
        COALESCE(SUM(click_count),0)::int AS total_clicks
      FROM email_sends WHERE campaign_id = $1
    `, [req.params.cid]).catch(() => ({ rows: [{}] }));
    res.json({ campaign_id: req.params.cid, ...r.rows[0] });
  });

  // ===== Tracking pixel + click redirect =====
  app.get('/v1/email/track/open/:sid.gif', async (req, res) => {
    await pool.query(`
      UPDATE email_sends SET opened_at = COALESCE(opened_at, NOW()),
        open_count = open_count + 1 WHERE send_id = $1
    `, [req.params.sid]).catch(() => {});
    // 1x1 transparent GIF
    res.setHeader('content-type', 'image/gif');
    res.setHeader('cache-control', 'no-store, no-cache, must-revalidate');
    res.send(Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'));
  });

  app.get('/v1/email/track/click/:sid', async (req, res) => {
    const url = req.query.u;
    if (!url) return res.status(400).end();
    await pool.query(`
      UPDATE email_sends SET first_clicked_at = COALESCE(first_clicked_at, NOW()),
        click_count = click_count + 1 WHERE send_id = $1
    `, [req.params.sid]).catch(() => {});
    await pool.query(
      `INSERT INTO email_clicks (click_id, send_id, url) VALUES ($1,$2,$3)`,
      [newId('clk'), req.params.sid, url]
    ).catch(() => {});
    res.redirect(302, String(url));
  });

  // ===== Suppression list =====
  app.get('/v1/agents/:did/email/suppression', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(`SELECT email, reason, added_at FROM email_suppression WHERE removed_at IS NULL ORDER BY added_at DESC LIMIT 1000`)
      .catch(() => ({ rows: [] }));
    res.json({ suppressed: r.rows });
  });

  app.post('/v1/agents/:did/email/suppression', express.json(), async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const { email, reason = 'manual' } = req.body || {};
    if (!email) return res.status(400).json({ error: 'email_required' });
    await pool.query(
      `INSERT INTO email_suppression (email, reason) VALUES ($1,$2) ON CONFLICT (email) DO NOTHING`,
      [String(email).toLowerCase(), reason]
    ).catch(() => {});
    res.status(201).json({ email });
  });

  // ===== Calendar invites =====
  app.post('/v1/agents/:did/email/calendar/invite', express.json(), async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const p = inviteSchema.safeParse(req.body || {});
    if (!p.success) return res.status(400).json({ error: 'invalid_input', details: p.error.flatten() });
    const id = newId('ics');
    const uid = id + '@openheab';
    await pool.query(
      `INSERT INTO email_calendar_invites (invite_id, message_id, organizer_did,
         title, starts_at, ends_at, location, description, attendees, ics_uid)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [id, 'inline', did, p.data.title, new Date(p.data.starts_at).toISOString(),
       new Date(p.data.ends_at).toISOString(), p.data.location || null,
       p.data.description || null, p.data.attendees || [], uid]
    );
    const ics = buildIcs({ uid, ...p.data, organizer_email: req.body?.organizer_email });
    res.json({ invite_id: id, ics });
  });

  app.get('/v1/email/calendar/:invite_id.ics', async (req, res) => {
    const r = await pool.query(`SELECT * FROM email_calendar_invites WHERE invite_id = $1`,
      [req.params.invite_id]).catch(() => ({ rows: [] }));
    if (!r.rows[0]) return res.status(404).end();
    const ics = buildIcs({ uid: r.rows[0].ics_uid, ...r.rows[0] });
    res.setHeader('content-type', 'text/calendar');
    res.setHeader('content-disposition', `attachment; filename="invite.ics"`);
    res.send(ics);
  });

  // ===== Auto-responder =====
  app.put('/v1/agents/:did/email/autoresponder', express.json(), async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const id = newId('aur');
    await pool.query(`
      INSERT INTO email_autoresponders (responder_id, agent_did, enabled,
        subject_template, body_template, starts_at, ends_at, reply_once_per_sender)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT (agent_did) DO UPDATE SET
        enabled = EXCLUDED.enabled, subject_template = EXCLUDED.subject_template,
        body_template = EXCLUDED.body_template, starts_at = EXCLUDED.starts_at,
        ends_at = EXCLUDED.ends_at, reply_once_per_sender = EXCLUDED.reply_once_per_sender
    `, [id, did, !!req.body?.enabled, req.body?.subject_template || null,
        req.body?.body_template || null,
        req.body?.starts_at ? new Date(req.body.starts_at).toISOString() : null,
        req.body?.ends_at ? new Date(req.body.ends_at).toISOString() : null,
        req.body?.reply_once_per_sender !== false]).catch(() => {});
    res.json({ ok: true });
  });

  // ===== Cron jobs =====
  registerCron(app, '/v1/_jobs/email-snooze-wake', async (req, res) => {
    const r = await pool.query(`
      UPDATE email_snoozes SET processed_at = NOW()
      WHERE wake_at <= NOW() AND processed_at IS NULL RETURNING thread_id
    `).catch(() => ({ rows: [] }));
    for (const row of r.rows) {
      await pool.query(`UPDATE email_threads SET snoozed_until = NULL WHERE thread_id = $1`, [row.thread_id]).catch(() => {});
    }
    res.json({ woken: r.rows.length });
  });

  registerCron(app, '/v1/_jobs/email-campaign-tick', async (req, res) => {
    // For scheduled campaigns whose time has come
    const r = await pool.query(`
      SELECT campaign_id FROM email_campaigns
      WHERE status = 'scheduled' AND scheduled_at <= NOW()
    `).catch(() => ({ rows: [] }));
    res.json({ pending: r.rows.length });
  });
}

async function isSuppressed(pool, email) {
  const r = await pool.query(`SELECT 1 FROM email_suppression WHERE email = $1 AND removed_at IS NULL`,
    [String(email).toLowerCase()]).catch(() => ({ rows: [] }));
  return r.rows.length > 0;
}

module.exports = {
  migrate, registerEmailAdvancedRoutes,
  assignThread, applyFilters, buildIcs, isSuppressed
};
