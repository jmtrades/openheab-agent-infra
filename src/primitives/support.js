// ============================================================================
// OpenHeab Support — Helpdesk ticketing (Intercom/Zendesk-style)
// ============================================================================
const express = require('express');
const cryptoLib = require('crypto');
const { z } = require('zod');

const TICKET_STATUSES = ['open', 'pending', 'solved', 'closed'];
const PRIORITIES = ['low', 'normal', 'high', 'urgent'];
const CHANNELS = ['email', 'chat', 'phone', 'api'];
const SENDER_KINDS = ['agent', 'customer', 'internal_note'];
const MACRO_ACTION_KINDS = ['set_status', 'set_priority', 'add_tag', 'assign'];

async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS support_tickets (
      ticket_id           TEXT PRIMARY KEY,
      owner_did           TEXT NOT NULL,
      requester_did       TEXT,
      requester_email     TEXT,
      subject             TEXT NOT NULL,
      body                TEXT,
      status              TEXT NOT NULL DEFAULT 'open',
      priority            TEXT NOT NULL DEFAULT 'normal',
      channel             TEXT NOT NULL DEFAULT 'api',
      assigned_to_did     TEXT,
      tags                TEXT[] DEFAULT '{}',
      satisfaction_rating INTEGER,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      solved_at           TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_support_tickets_owner ON support_tickets (owner_did);
    CREATE INDEX IF NOT EXISTS idx_support_tickets_status ON support_tickets (status);
    CREATE INDEX IF NOT EXISTS idx_support_tickets_requester_email ON support_tickets (requester_email);
    CREATE INDEX IF NOT EXISTS idx_support_tickets_assigned ON support_tickets (assigned_to_did);

    CREATE TABLE IF NOT EXISTS support_messages (
      message_id   TEXT PRIMARY KEY,
      ticket_id    TEXT NOT NULL,
      sender_did   TEXT,
      sender_kind  TEXT NOT NULL DEFAULT 'agent',
      body         TEXT NOT NULL,
      attachments  JSONB DEFAULT '[]'::jsonb,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_support_messages_ticket ON support_messages (ticket_id);

    CREATE TABLE IF NOT EXISTS support_macros (
      macro_id        TEXT PRIMARY KEY,
      owner_did       TEXT NOT NULL,
      name            TEXT NOT NULL,
      body_template   TEXT,
      actions         JSONB DEFAULT '[]'::jsonb,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_support_macros_owner ON support_macros (owner_did);

    CREATE TABLE IF NOT EXISTS support_sla_policies (
      policy_id              TEXT PRIMARY KEY,
      owner_did              TEXT NOT NULL,
      name                   TEXT NOT NULL,
      priority               TEXT NOT NULL DEFAULT 'normal',
      first_response_minutes INTEGER,
      resolution_hours       INTEGER,
      business_hours_only    BOOLEAN NOT NULL DEFAULT FALSE,
      created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_support_sla_owner ON support_sla_policies (owner_did);
  `).catch(() => {});
}

function genId(prefix) {
  return `${prefix}_${cryptoLib.randomBytes(12).toString('hex')}`;
}

function registerSupportRoutes(app, pool, verifyAgentAuth, auditChain) {
  // ---- Public ticket creation ----
  const PublicTicketSchema = z.object({
    owner_did: z.string().min(3),
    requester_did: z.string().optional(),
    requester_email: z.string().email().optional(),
    subject: z.string().min(1).max(500),
    body: z.string().max(50000).optional(),
    priority: z.enum(PRIORITIES).optional(),
    channel: z.enum(CHANNELS).optional(),
    tags: z.array(z.string()).optional()
  });

  app.post('/v1/support/tickets', express.json(), async (req, res) => {
    try {
      const parse = PublicTicketSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;
      if (!d.requester_did && !d.requester_email) {
        return res.status(400).json({ error: 'requester_did_or_email_required' });
      }
      const ticketId = genId('tkt');
      await pool.query(
        `INSERT INTO support_tickets (ticket_id, owner_did, requester_did, requester_email,
           subject, body, status, priority, channel, tags)
         VALUES ($1,$2,$3,$4,$5,$6,'open',$7,$8,$9)`,
        [ticketId, d.owner_did, d.requester_did || null, d.requester_email || null,
         d.subject, d.body || null, d.priority || 'normal', d.channel || 'api', d.tags || []]
      );
      if (d.body) {
        const msgId = genId('msg');
        await pool.query(
          `INSERT INTO support_messages (message_id, ticket_id, sender_did, sender_kind, body)
           VALUES ($1,$2,$3,'customer',$4)`,
          [msgId, ticketId, d.requester_did || null, d.body]
        ).catch(() => {});
      }
      await auditChain.append({
        event_type: 'support.ticket_created', ticket_id: ticketId, owner_did: d.owner_did,
        priority: d.priority || 'normal', channel: d.channel || 'api', timestamp: new Date().toISOString()
      });
      return res.status(201).json({ ticket_id: ticketId, owner_did: d.owner_did, status: 'open' });
    } catch (e) {
      console.error('[support.ticket.create]', e);
      return res.status(500).json({ error: 'create_failed', message: e.message });
    }
  });

  // ---- Ticket messages ----
  const MessageSchema = z.object({
    sender_kind: z.enum(SENDER_KINDS).optional(),
    body: z.string().min(1).max(50000),
    attachments: z.array(z.any()).optional()
  });

  app.post('/v1/agents/:did/support/tickets/:id/messages', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const parse = MessageSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;
      const ticket = await pool.query(
        `SELECT ticket_id, status FROM support_tickets WHERE ticket_id=$1 AND owner_did=$2`,
        [req.params.id, did]
      ).catch(() => ({ rows: [] }));
      if (!ticket.rows[0]) return res.status(404).json({ error: 'not_found' });
      const msgId = genId('msg');
      await pool.query(
        `INSERT INTO support_messages (message_id, ticket_id, sender_did, sender_kind, body, attachments)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
        [msgId, req.params.id, did, d.sender_kind || 'agent', d.body, JSON.stringify(d.attachments || [])]
      );
      // Reopen if closed/solved and agent replies as agent
      if ((d.sender_kind || 'agent') === 'agent' && (ticket.rows[0].status === 'solved' || ticket.rows[0].status === 'closed')) {
        await pool.query(`UPDATE support_tickets SET status='pending', updated_at=NOW() WHERE ticket_id=$1`, [req.params.id]).catch(() => {});
      } else {
        await pool.query(`UPDATE support_tickets SET updated_at=NOW() WHERE ticket_id=$1`, [req.params.id]).catch(() => {});
      }
      await auditChain.append({
        event_type: 'support.message_added', ticket_id: req.params.id, message_id: msgId,
        sender_did: did, sender_kind: d.sender_kind || 'agent', timestamp: new Date().toISOString()
      });
      return res.status(201).json({ message_id: msgId, ticket_id: req.params.id });
    } catch (e) { return res.status(500).json({ error: 'add_message_failed', message: e.message }); }
  });

  // ---- Assign ----
  app.post('/v1/agents/:did/support/tickets/:id/assign', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const body = z.object({ assigned_to_did: z.string().min(3) }).safeParse(req.body || {});
      if (!body.success) return res.status(400).json({ error: 'invalid_input', details: body.error.issues });
      const r = await pool.query(
        `UPDATE support_tickets SET assigned_to_did=$1, updated_at=NOW()
         WHERE ticket_id=$2 AND owner_did=$3 RETURNING ticket_id`,
        [body.data.assigned_to_did, req.params.id, did]
      ).catch(() => ({ rows: [] }));
      if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
      await auditChain.append({
        event_type: 'support.ticket_assigned', ticket_id: req.params.id, owner_did: did,
        assigned_to_did: body.data.assigned_to_did, timestamp: new Date().toISOString()
      });
      return res.json({ ticket_id: req.params.id, assigned_to_did: body.data.assigned_to_did });
    } catch (e) { return res.status(500).json({ error: 'assign_failed', message: e.message }); }
  });

  // ---- Status change ----
  app.post('/v1/agents/:did/support/tickets/:id/status', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const body = z.object({ status: z.enum(TICKET_STATUSES) }).safeParse(req.body || {});
      if (!body.success) return res.status(400).json({ error: 'invalid_input', details: body.error.issues });
      const solvedAt = (body.data.status === 'solved' || body.data.status === 'closed') ? 'NOW()' : 'NULL';
      const r = await pool.query(
        `UPDATE support_tickets SET status=$1, updated_at=NOW(),
           solved_at=CASE WHEN $1 IN ('solved','closed') THEN NOW() ELSE solved_at END
         WHERE ticket_id=$2 AND owner_did=$3 RETURNING ticket_id, status`,
        [body.data.status, req.params.id, did]
      ).catch(() => ({ rows: [] }));
      if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
      await auditChain.append({
        event_type: 'support.ticket_status_changed', ticket_id: req.params.id, owner_did: did,
        status: body.data.status, timestamp: new Date().toISOString()
      });
      return res.json({ ticket_id: req.params.id, status: r.rows[0].status });
    } catch (e) { return res.status(500).json({ error: 'status_failed', message: e.message }); }
  });

  // ---- List tickets ----
  app.get('/v1/agents/:did/support/tickets', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const status = req.query.status;
    const priority = req.query.priority;
    const assigned = req.query.assigned_to_did;
    const channel = req.query.channel;
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    const params = [did];
    let sql = `SELECT * FROM support_tickets WHERE owner_did=$1`;
    if (status) { params.push(status); sql += ` AND status=$${params.length}`; }
    if (priority) { params.push(priority); sql += ` AND priority=$${params.length}`; }
    if (assigned) { params.push(assigned); sql += ` AND assigned_to_did=$${params.length}`; }
    if (channel) { params.push(channel); sql += ` AND channel=$${params.length}`; }
    params.push(limit);
    sql += ` ORDER BY created_at DESC LIMIT $${params.length}`;
    const r = await pool.query(sql, params).catch(() => ({ rows: [] }));
    return res.json({ tickets: r.rows, count: r.rows.length });
  });

  app.get('/v1/agents/:did/support/tickets/:id', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const t = await pool.query(
      `SELECT * FROM support_tickets WHERE ticket_id=$1 AND owner_did=$2`,
      [req.params.id, did]
    ).catch(() => ({ rows: [] }));
    if (!t.rows[0]) return res.status(404).json({ error: 'not_found' });
    const m = await pool.query(
      `SELECT * FROM support_messages WHERE ticket_id=$1 ORDER BY created_at ASC LIMIT 500`,
      [req.params.id]
    ).catch(() => ({ rows: [] }));
    return res.json({ ticket: t.rows[0], messages: m.rows });
  });

  // ---- Macros ----
  const MacroSchema = z.object({
    name: z.string().min(1).max(200),
    body_template: z.string().max(20000).optional(),
    actions: z.array(z.object({
      kind: z.enum(MACRO_ACTION_KINDS),
      value: z.any()
    })).optional()
  });

  app.post('/v1/agents/:did/support/macros', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const parse = MacroSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;
      const macroId = genId('macro');
      await pool.query(
        `INSERT INTO support_macros (macro_id, owner_did, name, body_template, actions)
         VALUES ($1,$2,$3,$4,$5::jsonb)`,
        [macroId, did, d.name, d.body_template || null, JSON.stringify(d.actions || [])]
      );
      await auditChain.append({
        event_type: 'support.macro_created', macro_id: macroId, owner_did: did, timestamp: new Date().toISOString()
      });
      return res.status(201).json({ macro_id: macroId, owner_did: did, name: d.name });
    } catch (e) { return res.status(500).json({ error: 'create_failed', message: e.message }); }
  });

  app.get('/v1/agents/:did/support/macros', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(
      `SELECT * FROM support_macros WHERE owner_did=$1 ORDER BY created_at DESC LIMIT 200`,
      [did]
    ).catch(() => ({ rows: [] }));
    return res.json({ macros: r.rows, count: r.rows.length });
  });

  // ---- Apply macro ----
  app.post('/v1/agents/:did/support/tickets/:id/apply-macro/:macro_id', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const macro = await pool.query(
        `SELECT * FROM support_macros WHERE macro_id=$1 AND owner_did=$2`,
        [req.params.macro_id, did]
      ).catch(() => ({ rows: [] }));
      if (!macro.rows[0]) return res.status(404).json({ error: 'macro_not_found' });
      const ticket = await pool.query(
        `SELECT * FROM support_tickets WHERE ticket_id=$1 AND owner_did=$2`,
        [req.params.id, did]
      ).catch(() => ({ rows: [] }));
      if (!ticket.rows[0]) return res.status(404).json({ error: 'ticket_not_found' });

      const m = macro.rows[0];
      const applied = [];

      // Apply body template as message if provided
      if (m.body_template) {
        const msgId = genId('msg');
        await pool.query(
          `INSERT INTO support_messages (message_id, ticket_id, sender_did, sender_kind, body)
           VALUES ($1,$2,$3,'agent',$4)`,
          [msgId, req.params.id, did, m.body_template]
        ).catch(() => {});
        applied.push({ kind: 'message_sent', message_id: msgId });
      }

      const actions = Array.isArray(m.actions) ? m.actions : [];
      for (const a of actions) {
        try {
          if (a.kind === 'set_status' && TICKET_STATUSES.includes(a.value)) {
            await pool.query(
              `UPDATE support_tickets SET status=$1, updated_at=NOW(),
                 solved_at=CASE WHEN $1 IN ('solved','closed') THEN NOW() ELSE solved_at END
               WHERE ticket_id=$2`, [a.value, req.params.id]);
            applied.push({ kind: 'set_status', value: a.value });
          } else if (a.kind === 'set_priority' && PRIORITIES.includes(a.value)) {
            await pool.query(`UPDATE support_tickets SET priority=$1, updated_at=NOW() WHERE ticket_id=$2`, [a.value, req.params.id]);
            applied.push({ kind: 'set_priority', value: a.value });
          } else if (a.kind === 'add_tag' && typeof a.value === 'string') {
            await pool.query(
              `UPDATE support_tickets SET tags=array_append(coalesce(tags,'{}'), $1), updated_at=NOW() WHERE ticket_id=$2 AND NOT ($1 = ANY(coalesce(tags,'{}')))`,
              [a.value, req.params.id]);
            applied.push({ kind: 'add_tag', value: a.value });
          } else if (a.kind === 'assign' && typeof a.value === 'string') {
            await pool.query(`UPDATE support_tickets SET assigned_to_did=$1, updated_at=NOW() WHERE ticket_id=$2`, [a.value, req.params.id]);
            applied.push({ kind: 'assign', value: a.value });
          }
        } catch (err) { applied.push({ kind: a.kind, error: err.message }); }
      }

      await auditChain.append({
        event_type: 'support.macro_applied', ticket_id: req.params.id, macro_id: req.params.macro_id,
        owner_did: did, actions_applied: applied.length, timestamp: new Date().toISOString()
      });
      return res.json({ ticket_id: req.params.id, macro_id: req.params.macro_id, applied });
    } catch (e) { return res.status(500).json({ error: 'apply_failed', message: e.message }); }
  });

  // ---- Satisfaction rating (public — customer rates) ----
  app.post('/v1/support/tickets/:id/rate', express.json(), async (req, res) => {
    try {
      const body = z.object({
        rating: z.number().int().min(1).max(5),
        comment: z.string().max(2000).optional(),
        requester_email: z.string().email().optional(),
        requester_did: z.string().optional()
      }).safeParse(req.body || {});
      if (!body.success) return res.status(400).json({ error: 'invalid_input', details: body.error.issues });
      const t = await pool.query(
        `SELECT * FROM support_tickets WHERE ticket_id=$1`, [req.params.id]
      ).catch(() => ({ rows: [] }));
      if (!t.rows[0]) return res.status(404).json({ error: 'not_found' });
      // Verify the rater is the original requester (by email or did)
      const tk = t.rows[0];
      const matches =
        (body.data.requester_email && tk.requester_email && body.data.requester_email === tk.requester_email) ||
        (body.data.requester_did && tk.requester_did && body.data.requester_did === tk.requester_did);
      if (!matches) return res.status(403).json({ error: 'requester_mismatch' });
      await pool.query(
        `UPDATE support_tickets SET satisfaction_rating=$1, updated_at=NOW() WHERE ticket_id=$2`,
        [body.data.rating, req.params.id]
      );
      if (body.data.comment) {
        const msgId = genId('msg');
        await pool.query(
          `INSERT INTO support_messages (message_id, ticket_id, sender_did, sender_kind, body)
           VALUES ($1,$2,$3,'customer',$4)`,
          [msgId, req.params.id, tk.requester_did || null, `[CSAT comment] ${body.data.comment}`]
        ).catch(() => {});
      }
      await auditChain.append({
        event_type: 'support.ticket_rated', ticket_id: req.params.id, owner_did: tk.owner_did,
        rating: body.data.rating, timestamp: new Date().toISOString()
      });
      return res.json({ ticket_id: req.params.id, rating: body.data.rating });
    } catch (e) { return res.status(500).json({ error: 'rate_failed', message: e.message }); }
  });

  // ---- SLA policies ----
  const SlaSchema = z.object({
    name: z.string().min(1).max(200),
    priority: z.enum(PRIORITIES).optional(),
    first_response_minutes: z.number().int().min(1).optional(),
    resolution_hours: z.number().int().min(1).optional(),
    business_hours_only: z.boolean().optional()
  });

  app.post('/v1/agents/:did/support/sla', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const parse = SlaSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;
      const policyId = genId('sla');
      await pool.query(
        `INSERT INTO support_sla_policies (policy_id, owner_did, name, priority, first_response_minutes, resolution_hours, business_hours_only)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [policyId, did, d.name, d.priority || 'normal', d.first_response_minutes || null,
         d.resolution_hours || null, d.business_hours_only || false]
      );
      await auditChain.append({
        event_type: 'support.sla_created', policy_id: policyId, owner_did: did, timestamp: new Date().toISOString()
      });
      return res.status(201).json({ policy_id: policyId, owner_did: did });
    } catch (e) { return res.status(500).json({ error: 'create_failed', message: e.message }); }
  });

  app.get('/v1/agents/:did/support/sla', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(
      `SELECT * FROM support_sla_policies WHERE owner_did=$1 ORDER BY created_at DESC LIMIT 100`,
      [did]
    ).catch(() => ({ rows: [] }));
    return res.json({ policies: r.rows, count: r.rows.length });
  });
}

module.exports = {
  migrate,
  registerSupportRoutes,
  TICKET_STATUSES,
  PRIORITIES,
  CHANNELS,
  SENDER_KINDS,
  MACRO_ACTION_KINDS
};
