// ============================================================================
// OpenHeab Calendar — Full ICS-compatible calendar primitive.
// Distinct from scheduler (which fires task callbacks). This is appointments,
// events with attendees, RRULE recurrence, public ICS feeds, RSVP.
// ============================================================================
const express = require('express');
const cryptoLib = require('crypto');
const { z } = require('zod');

const EVENT_STATUSES = ['confirmed', 'tentative', 'cancelled'];
const RESPONSE_STATUSES = ['accepted', 'declined', 'tentative'];
const VISIBILITY = ['public', 'private'];

async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS calendars (
      calendar_id   TEXT PRIMARY KEY,
      owner_did     TEXT NOT NULL,
      name          TEXT,
      color         TEXT,
      default_tz    TEXT NOT NULL DEFAULT 'UTC',
      public        BOOLEAN NOT NULL DEFAULT FALSE,
      ics_url       TEXT,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_calendars_owner ON calendars (owner_did);

    CREATE TABLE IF NOT EXISTS events (
      event_id        TEXT PRIMARY KEY,
      calendar_id     TEXT NOT NULL,
      agent_did       TEXT NOT NULL,
      title           TEXT,
      description     TEXT,
      location        TEXT,
      start_at        TIMESTAMPTZ,
      end_at          TIMESTAMPTZ,
      all_day         BOOLEAN NOT NULL DEFAULT FALSE,
      rrule           TEXT,
      recurrence_id   TEXT,
      status          TEXT NOT NULL DEFAULT 'confirmed',
      visibility      TEXT NOT NULL DEFAULT 'private',
      attendees       JSONB DEFAULT '[]'::jsonb,
      reminders       JSONB DEFAULT '[]'::jsonb,
      conference_url  TEXT,
      organizer_did   TEXT,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_events_calendar ON events (calendar_id, start_at);
    CREATE INDEX IF NOT EXISTS idx_events_agent ON events (agent_did, start_at);
    CREATE INDEX IF NOT EXISTS idx_events_range ON events (start_at, end_at);

    CREATE TABLE IF NOT EXISTS event_responses (
      event_id      TEXT NOT NULL,
      responder_did TEXT NOT NULL,
      status        TEXT NOT NULL,
      responded_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (event_id, responder_did)
    );
  `).catch(() => {});
}

function genId(prefix) { return `${prefix}_${cryptoLib.randomBytes(12).toString('hex')}`; }

function toICSDate(dt, allDay) {
  if (!dt) return '';
  const d = new Date(dt);
  if (allDay) {
    return d.toISOString().slice(0, 10).replace(/-/g, '');
  }
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function buildICS(calendar, events) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//OpenHeab//Calendar 1.0//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${(calendar.name || calendar.calendar_id).replace(/[\r\n,;]/g, ' ')}`,
    `X-WR-TIMEZONE:${calendar.default_tz || 'UTC'}`
  ];
  for (const e of events) {
    lines.push('BEGIN:VEVENT');
    lines.push(`UID:${e.event_id}@openheab`);
    lines.push(`DTSTAMP:${toICSDate(e.created_at || new Date(), false)}`);
    if (e.all_day) {
      lines.push(`DTSTART;VALUE=DATE:${toICSDate(e.start_at, true)}`);
      if (e.end_at) lines.push(`DTEND;VALUE=DATE:${toICSDate(e.end_at, true)}`);
    } else {
      lines.push(`DTSTART:${toICSDate(e.start_at, false)}`);
      if (e.end_at) lines.push(`DTEND:${toICSDate(e.end_at, false)}`);
    }
    if (e.rrule) lines.push(`RRULE:${e.rrule}`);
    if (e.title) lines.push(`SUMMARY:${String(e.title).replace(/[\r\n,;]/g, ' ')}`);
    if (e.description) lines.push(`DESCRIPTION:${String(e.description).replace(/[\r\n]/g, '\\n').replace(/[,;]/g, ' ')}`);
    if (e.location) lines.push(`LOCATION:${String(e.location).replace(/[\r\n,;]/g, ' ')}`);
    lines.push(`STATUS:${(e.status || 'CONFIRMED').toUpperCase()}`);
    if (e.organizer_did) lines.push(`ORGANIZER:mailto:${e.organizer_did.replace(/^did:op:/, '')}@openheab.invalid`);
    const att = Array.isArray(e.attendees) ? e.attendees : [];
    for (const a of att) {
      const mail = a.email || (a.did ? `${a.did.replace(/^did:op:/, '')}@openheab.invalid` : null);
      if (mail) lines.push(`ATTENDEE;ROLE=${(a.role || 'REQ-PARTICIPANT').toUpperCase()}:mailto:${mail}`);
    }
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
}

function registerCalendarRoutes(app, pool, verifyAgentAuth, auditChain) {
  // POST /v1/agents/:did/calendars
  const CalSchema = z.object({
    name: z.string().max(300).optional(),
    color: z.string().max(20).optional(),
    default_tz: z.string().max(60).optional(),
    public: z.boolean().optional()
  });
  app.post('/v1/agents/:did/calendars', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const parse = CalSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;
      const calendarId = genId('cal');
      const baseUrl = process.env.OPERATOR_PUBLIC_URL || '';
      const icsUrl = `${baseUrl}/v1/calendars/${calendarId}/ics`;
      await pool.query(
        `INSERT INTO calendars (calendar_id, owner_did, name, color, default_tz, public, ics_url)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [calendarId, did, d.name || null, d.color || null, d.default_tz || 'UTC', !!d.public, icsUrl]
      );
      await auditChain.append({
        event_type: 'calendar.created', calendar_id: calendarId, owner_did: did,
        timestamp: new Date().toISOString()
      });
      return res.status(201).json({ calendar_id: calendarId, ics_url: icsUrl });
    } catch (e) { return res.status(500).json({ error: 'create_failed', message: e.message }); }
  });

  // GET /v1/agents/:did/calendars
  app.get('/v1/agents/:did/calendars', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(
      `SELECT * FROM calendars WHERE owner_did=$1 ORDER BY created_at DESC`, [did]
    ).catch(() => ({ rows: [] }));
    return res.json({ calendars: r.rows, count: r.rows.length });
  });

  // POST /v1/agents/:did/calendars/:id/events
  const EventSchema = z.object({
    title: z.string().max(500).optional(),
    description: z.string().max(20000).optional(),
    location: z.string().max(500).optional(),
    start_at: z.string(),
    end_at: z.string().optional(),
    all_day: z.boolean().optional(),
    rrule: z.string().max(500).optional(),
    status: z.enum(EVENT_STATUSES).optional(),
    visibility: z.enum(VISIBILITY).optional(),
    attendees: z.array(z.record(z.any())).optional(),
    reminders: z.array(z.record(z.any())).optional(),
    conference_url: z.string().url().optional()
  });
  app.post('/v1/agents/:did/calendars/:id/events', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const cal = await pool.query(
        `SELECT calendar_id FROM calendars WHERE calendar_id=$1 AND owner_did=$2`,
        [req.params.id, did]
      ).catch(() => ({ rows: [] }));
      if (!cal.rows[0]) return res.status(404).json({ error: 'calendar_not_found' });
      const parse = EventSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;
      const eventId = genId('evt');
      await pool.query(
        `INSERT INTO events (event_id, calendar_id, agent_did, title, description, location,
                              start_at, end_at, all_day, rrule, status, visibility,
                              attendees, reminders, conference_url, organizer_did)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14::jsonb,$15,$16)`,
        [eventId, req.params.id, did, d.title || null, d.description || null, d.location || null,
         d.start_at, d.end_at || null, !!d.all_day, d.rrule || null,
         d.status || 'confirmed', d.visibility || 'private',
         JSON.stringify(d.attendees || []), JSON.stringify(d.reminders || []),
         d.conference_url || null, did]
      );
      await auditChain.append({
        event_type: 'calendar.event_created', event_id: eventId, calendar_id: req.params.id,
        agent_did: did, start_at: d.start_at, timestamp: new Date().toISOString()
      });
      return res.status(201).json({ event_id: eventId, calendar_id: req.params.id, start_at: d.start_at });
    } catch (e) { return res.status(500).json({ error: 'create_failed', message: e.message }); }
  });

  // GET /v1/agents/:did/calendars/:id/events?start=&end=
  app.get('/v1/agents/:did/calendars/:id/events', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const params = [req.params.id, did];
    let sql = `SELECT * FROM events WHERE calendar_id=$1 AND agent_did=$2`;
    if (req.query.start) { params.push(new Date(req.query.start)); sql += ` AND start_at >= $${params.length}`; }
    if (req.query.end) { params.push(new Date(req.query.end)); sql += ` AND start_at <= $${params.length}`; }
    sql += ` ORDER BY start_at ASC LIMIT 1000`;
    const r = await pool.query(sql, params).catch(() => ({ rows: [] }));
    return res.json({ events: r.rows, count: r.rows.length });
  });

  // PUT /v1/agents/:did/events/:id
  app.put('/v1/agents/:did/events/:id', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const parse = EventSchema.partial().safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;
      const fields = [];
      const params = [];
      const set = (k, v) => { params.push(v); fields.push(`${k}=$${params.length}`); };
      if (d.title !== undefined) set('title', d.title);
      if (d.description !== undefined) set('description', d.description);
      if (d.location !== undefined) set('location', d.location);
      if (d.start_at !== undefined) set('start_at', d.start_at);
      if (d.end_at !== undefined) set('end_at', d.end_at);
      if (d.all_day !== undefined) set('all_day', d.all_day);
      if (d.rrule !== undefined) set('rrule', d.rrule);
      if (d.status !== undefined) set('status', d.status);
      if (d.visibility !== undefined) set('visibility', d.visibility);
      if (d.conference_url !== undefined) set('conference_url', d.conference_url);
      if (d.attendees !== undefined) { params.push(JSON.stringify(d.attendees)); fields.push(`attendees=$${params.length}::jsonb`); }
      if (d.reminders !== undefined) { params.push(JSON.stringify(d.reminders)); fields.push(`reminders=$${params.length}::jsonb`); }
      if (!fields.length) return res.status(400).json({ error: 'no_fields' });
      params.push(req.params.id, did);
      const r = await pool.query(
        `UPDATE events SET ${fields.join(', ')}, updated_at=NOW()
         WHERE event_id=$${params.length - 1} AND agent_did=$${params.length}
         RETURNING event_id, updated_at`,
        params
      ).catch(() => ({ rows: [] }));
      if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
      await auditChain.append({
        event_type: 'calendar.event_updated', event_id: req.params.id, agent_did: did,
        fields: Object.keys(d), timestamp: new Date().toISOString()
      });
      return res.json(r.rows[0]);
    } catch (e) { return res.status(500).json({ error: 'update_failed', message: e.message }); }
  });

  // DELETE /v1/agents/:did/events/:id
  app.delete('/v1/agents/:did/events/:id', async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const r = await pool.query(
        `DELETE FROM events WHERE event_id=$1 AND agent_did=$2 RETURNING event_id`,
        [req.params.id, did]
      ).catch(() => ({ rows: [] }));
      if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
      await auditChain.append({
        event_type: 'calendar.event_deleted', event_id: req.params.id, agent_did: did,
        timestamp: new Date().toISOString()
      });
      return res.json({ event_id: req.params.id, deleted: true });
    } catch (e) { return res.status(500).json({ error: 'delete_failed', message: e.message }); }
  });

  // POST /v1/events/:id/respond
  const RespondSchema = z.object({
    responder_did: z.string(),
    status: z.enum(RESPONSE_STATUSES)
  });
  app.post('/v1/events/:id/respond', express.json(), async (req, res) => {
    try {
      const parse = RespondSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;
      const auth = await verifyAgentAuth(req, d.responder_did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const ev = await pool.query(`SELECT event_id FROM events WHERE event_id=$1`, [req.params.id]).catch(() => ({ rows: [] }));
      if (!ev.rows[0]) return res.status(404).json({ error: 'not_found' });
      await pool.query(
        `INSERT INTO event_responses (event_id, responder_did, status, responded_at)
         VALUES ($1,$2,$3, NOW())
         ON CONFLICT (event_id, responder_did) DO UPDATE SET status=$3, responded_at=NOW()`,
        [req.params.id, d.responder_did, d.status]
      );
      await auditChain.append({
        event_type: 'calendar.event_response', event_id: req.params.id,
        responder_did: d.responder_did, status: d.status, timestamp: new Date().toISOString()
      });
      return res.json({ event_id: req.params.id, status: d.status });
    } catch (e) { return res.status(500).json({ error: 'respond_failed', message: e.message }); }
  });

  // GET /v1/calendars/:id/ics — public ICS feed
  app.get('/v1/calendars/:id/ics', async (req, res) => {
    const cal = await pool.query(`SELECT * FROM calendars WHERE calendar_id=$1`, [req.params.id]).catch(() => ({ rows: [] }));
    if (!cal.rows[0]) return res.status(404).json({ error: 'not_found' });
    if (!cal.rows[0].public) return res.status(403).json({ error: 'calendar_not_public' });
    const events = await pool.query(
      `SELECT * FROM events WHERE calendar_id=$1 AND visibility='public'
       ORDER BY start_at ASC LIMIT 5000`, [req.params.id]
    ).catch(() => ({ rows: [] }));
    res.setHeader('content-type', 'text/calendar; charset=utf-8');
    res.setHeader('content-disposition', `inline; filename="${req.params.id}.ics"`);
    return res.send(buildICS(cal.rows[0], events.rows));
  });
}

module.exports = {
  migrate, registerCalendarRoutes, buildICS, toICSDate,
  EVENT_STATUSES, RESPONSE_STATUSES, VISIBILITY
};
