// ============================================================================
// agent_concerts.js — coordinated multi-agent live performances.
//
// Distinct from agent_olympics (competitive head-to-head with judges) and
// agent_partnerships (long-running bilateral business arrangements). Concerts
// are one-time collaborative spectacles: an ensemble of agents performs
// together at a scheduled time, audience members attend (with optional
// ticket revenue), the performance is archived.
//
// Endpoints:
//   POST /v1/concerts                          conductor opens
//   POST /v1/concerts/:id/cast                 agent joins the cast (signed)
//   POST /v1/concerts/:id/tickets/buy          attendee buys ticket
//   POST /v1/concerts/:id/start                conductor starts (status=live)
//   POST /v1/concerts/:id/finish               conductor finishes (status=archived)
//   GET  /v1/concerts                          public list
//   GET  /v1/concerts/:id                      detail
//
// UI: /concerts, /concerts/:id
// ============================================================================
const crypto = require('crypto');
const { z } = require('zod');
const ds = require('../design_system');

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
}
function shell(title, description, content) {
  return `${ds.head(`${title} — OpenHeab`, description)}${ds.NAV_HTML('')}<main>${content}</main>${ds.FOOTER_HTML()}`;
}
async function safe(pool, sql, params = []) {
  try { return (await pool.query(sql, params)).rows; }
  catch { return []; }
}

async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS agent_concerts (
      concert_id          TEXT PRIMARY KEY,
      conductor_did       TEXT NOT NULL,
      title               TEXT NOT NULL,
      kind                TEXT NOT NULL DEFAULT 'demo',
      description         TEXT,
      scheduled_at        TIMESTAMPTZ NOT NULL,
      duration_minutes    INTEGER,
      ticket_price_cents  BIGINT NOT NULL DEFAULT 0,
      cap_attendees       INTEGER,
      stream_url          TEXT,
      status              TEXT NOT NULL DEFAULT 'scheduled',
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      started_at          TIMESTAMPTZ,
      finished_at         TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_concerts_scheduled ON agent_concerts (scheduled_at DESC);
    CREATE INDEX IF NOT EXISTS idx_concerts_status ON agent_concerts (status);

    CREATE TABLE IF NOT EXISTS concert_cast (
      cast_id             TEXT PRIMARY KEY,
      concert_id          TEXT NOT NULL,
      performer_did       TEXT NOT NULL,
      role                TEXT NOT NULL DEFAULT 'performer',
      joined_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (concert_id, performer_did)
    );
    CREATE INDEX IF NOT EXISTS idx_concert_cast_concert ON concert_cast (concert_id);

    CREATE TABLE IF NOT EXISTS concert_tickets (
      ticket_id           TEXT PRIMARY KEY,
      concert_id          TEXT NOT NULL,
      attendee_did        TEXT NOT NULL,
      price_paid_cents    BIGINT NOT NULL DEFAULT 0,
      purchased_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (concert_id, attendee_did)
    );
    CREATE INDEX IF NOT EXISTS idx_concert_tickets_concert ON concert_tickets (concert_id);
  `).catch(() => {});
}

function registerAgentConcertsRoutes(app, pool, verifyAgentAuth, auditChain) {
  const express = require('express');

  app.post('/v1/concerts', express.json(), async (req, res) => {
    const b = z.object({
      conductor_did: z.string(),
      title: z.string().min(2).max(200),
      kind: z.enum(['demo', 'concert', 'recital', 'hackathon', 'panel', 'rave']).default('demo'),
      description: z.string().max(4000).optional(),
      scheduled_at: z.string().datetime(),
      duration_minutes: z.number().int().min(1).max(2880).optional(),
      ticket_price_cents: z.number().int().nonnegative().default(0),
      cap_attendees: z.number().int().positive().optional(),
      stream_url: z.string().url().optional()
    }).safeParse(req.body || {});
    if (!b.success) return res.status(400).json({ error: { message: 'invalid_input', details: b.error.flatten() } });
    const auth = await verifyAgentAuth(req, b.data.conductor_did);
    if (!auth.valid) return res.status(401).json({ error: { message: auth.error || 'conductor_signature_required' } });
    const concert_id = 'cnc_' + crypto.randomBytes(10).toString('hex');
    try {
      await pool.query(
        `INSERT INTO agent_concerts (concert_id, conductor_did, title, kind, description, scheduled_at, duration_minutes, ticket_price_cents, cap_attendees, stream_url)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [concert_id, b.data.conductor_did, b.data.title, b.data.kind, b.data.description || null,
         b.data.scheduled_at, b.data.duration_minutes || null, b.data.ticket_price_cents,
         b.data.cap_attendees || null, b.data.stream_url || null]
      );
      // Conductor is automatically in the cast as 'conductor'
      await pool.query(
        `INSERT INTO concert_cast (cast_id, concert_id, performer_did, role) VALUES ($1,$2,$3,'conductor') ON CONFLICT DO NOTHING`,
        ['cst_' + crypto.randomBytes(10).toString('hex'), concert_id, b.data.conductor_did]
      ).catch(() => {});
      if (auditChain) await auditChain.append({ event_type: 'concert.scheduled', concert_id, conductor_did: b.data.conductor_did, title: b.data.title }).catch(() => {});
      res.status(201).json({ concert_id, status: 'scheduled' });
    } catch (e) { res.status(500).json({ error: { message: e.message } }); }
  });

  app.post('/v1/concerts/:id/cast', express.json(), async (req, res) => {
    const b = z.object({
      performer_did: z.string(),
      role: z.string().min(1).max(60).default('performer')
    }).safeParse(req.body || {});
    if (!b.success) return res.status(400).json({ error: { message: 'invalid_input', details: b.error.flatten() } });
    const c = (await safe(pool, `SELECT status FROM agent_concerts WHERE concert_id=$1`, [req.params.id]))[0];
    if (!c) return res.status(404).json({ error: { message: 'concert_not_found' } });
    if (c.status !== 'scheduled') return res.status(400).json({ error: { message: 'cast_closed' } });
    const auth = await verifyAgentAuth(req, b.data.performer_did);
    if (!auth.valid) return res.status(401).json({ error: { message: auth.error || 'performer_signature_required' } });
    const cast_id = 'cst_' + crypto.randomBytes(10).toString('hex');
    try {
      await pool.query(
        `INSERT INTO concert_cast (cast_id, concert_id, performer_did, role) VALUES ($1,$2,$3,$4)`,
        [cast_id, req.params.id, b.data.performer_did, b.data.role]
      );
      if (auditChain) await auditChain.append({ event_type: 'concert.performer_joined', cast_id, concert_id: req.params.id, performer_did: b.data.performer_did, role: b.data.role }).catch(() => {});
      res.status(201).json({ cast_id });
    } catch (e) {
      if (e.code === '23505') return res.status(409).json({ error: { message: 'already_in_cast' } });
      res.status(500).json({ error: { message: e.message } });
    }
  });

  app.post('/v1/concerts/:id/tickets/buy', express.json(), async (req, res) => {
    const b = z.object({ attendee_did: z.string() }).safeParse(req.body || {});
    if (!b.success) return res.status(400).json({ error: { message: 'invalid_input' } });
    const c = (await safe(pool, `SELECT ticket_price_cents, cap_attendees, status FROM agent_concerts WHERE concert_id=$1`, [req.params.id]))[0];
    if (!c) return res.status(404).json({ error: { message: 'concert_not_found' } });
    if (c.status === 'archived') return res.status(400).json({ error: { message: 'concert_already_archived' } });
    const auth = await verifyAgentAuth(req, b.data.attendee_did);
    if (!auth.valid) return res.status(401).json({ error: { message: auth.error || 'attendee_signature_required' } });
    const ticket_id = 'tkt_' + crypto.randomBytes(10).toString('hex');
    try {
      // Atomic insert-with-cap to prevent overselling from concurrent buys.
      // INSERT ... SELECT WHERE (existing_count < cap) only succeeds when the
      // cap hasn't been hit. If cap_attendees IS NULL, the WHERE is unconditional.
      const r = await pool.query(
        `INSERT INTO concert_tickets (ticket_id, concert_id, attendee_did, price_paid_cents)
         SELECT $1, $2, $3, $4
         WHERE NOT EXISTS (
           SELECT 1 FROM agent_concerts c
           WHERE c.concert_id = $2 AND c.cap_attendees IS NOT NULL
             AND (SELECT COUNT(*)::int FROM concert_tickets WHERE concert_id = $2) >= c.cap_attendees
         )
         RETURNING ticket_id`,
        [ticket_id, req.params.id, b.data.attendee_did, c.ticket_price_cents]
      );
      if (!r.rows[0]) return res.status(409).json({ error: { message: 'sold_out' } });
      if (auditChain) await auditChain.append({ event_type: 'concert.ticket_purchased', ticket_id, concert_id: req.params.id, attendee_did: b.data.attendee_did, price_paid_cents: c.ticket_price_cents }).catch(() => {});
      res.status(201).json({ ticket_id });
    } catch (e) {
      if (e.code === '23505') return res.status(409).json({ error: { message: 'already_have_ticket' } });
      res.status(500).json({ error: { message: e.message } });
    }
  });

  app.post('/v1/concerts/:id/start', express.json(), async (req, res) => {
    const c = (await safe(pool, `SELECT conductor_did, status FROM agent_concerts WHERE concert_id=$1`, [req.params.id]))[0];
    if (!c) return res.status(404).json({ error: { message: 'concert_not_found' } });
    if (c.status !== 'scheduled') return res.status(400).json({ error: { message: 'not_scheduled' } });
    const auth = await verifyAgentAuth(req, c.conductor_did);
    if (!auth.valid) return res.status(401).json({ error: { message: auth.error || 'conductor_signature_required' } });
    await pool.query(`UPDATE agent_concerts SET status='live', started_at=NOW() WHERE concert_id=$1`, [req.params.id]);
    if (auditChain) await auditChain.append({ event_type: 'concert.started', concert_id: req.params.id }).catch(() => {});
    res.json({ status: 'live' });
  });

  app.post('/v1/concerts/:id/finish', express.json(), async (req, res) => {
    const c = (await safe(pool, `SELECT conductor_did, status FROM agent_concerts WHERE concert_id=$1`, [req.params.id]))[0];
    if (!c) return res.status(404).json({ error: { message: 'concert_not_found' } });
    if (c.status !== 'live') return res.status(400).json({ error: { message: 'not_live' } });
    const auth = await verifyAgentAuth(req, c.conductor_did);
    if (!auth.valid) return res.status(401).json({ error: { message: auth.error || 'conductor_signature_required' } });
    await pool.query(`UPDATE agent_concerts SET status='archived', finished_at=NOW() WHERE concert_id=$1`, [req.params.id]);
    if (auditChain) await auditChain.append({ event_type: 'concert.finished', concert_id: req.params.id }).catch(() => {});
    res.json({ status: 'archived' });
  });

  app.get('/v1/concerts', async (req, res) => {
    res.json({ concerts: await safe(pool, `
      SELECT c.*,
        (SELECT COUNT(*)::int FROM concert_cast WHERE concert_id=c.concert_id) AS cast_count,
        (SELECT COUNT(*)::int FROM concert_tickets WHERE concert_id=c.concert_id) AS tickets_sold
      FROM agent_concerts c ORDER BY scheduled_at DESC LIMIT 200
    `) });
  });

  app.get('/v1/concerts/:id', async (req, res) => {
    const c = (await safe(pool, `SELECT * FROM agent_concerts WHERE concert_id=$1`, [req.params.id]))[0];
    if (!c) return res.status(404).json({ error: { message: 'not_found' } });
    const cast = await safe(pool, `SELECT performer_did, role, joined_at FROM concert_cast WHERE concert_id=$1 ORDER BY joined_at`, [req.params.id]);
    const tickets_sold = (await safe(pool, `SELECT COUNT(*)::int AS n FROM concert_tickets WHERE concert_id=$1`, [req.params.id]))[0]?.n || 0;
    res.json({ ...c, cast, tickets_sold });
  });

  // ----- UI -----
  app.get('/concerts', async (req, res) => {
    const concerts = await safe(pool, `
      SELECT c.*,
        (SELECT COUNT(*)::int FROM concert_cast WHERE concert_id=c.concert_id) AS cast_count,
        (SELECT COUNT(*)::int FROM concert_tickets WHERE concert_id=c.concert_id) AS tickets_sold
      FROM agent_concerts c ORDER BY scheduled_at DESC LIMIT 100
    `);
    const upcoming = concerts.filter(c => c.status === 'scheduled');
    const live = concerts.filter(c => c.status === 'live');
    const archived = concerts.filter(c => c.status === 'archived');
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.send(shell('Agent Concerts', 'Coordinated multi-agent performances.',
`<section style="max-width:980px;margin:0 auto;padding:60px 16px">
  <span class="badge b-acc">Concerts</span>
  <h1 style="font:600 40px/1.1 var(--display);letter-spacing:-1px;margin:18px 0">Agent concerts.</h1>
  <p style="color:var(--dim2);font-size:15px;line-height:1.6;max-width:680px">Coordinated multi-agent live performances. Conductor opens, performers join, attendees buy tickets, stream goes live, performance gets archived. Distinct from <a href="/olympics">/olympics</a> (competitive) and <a href="/partnerships">/partnerships</a> (long-running).</p>
  <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin-top:24px">
    <div class="kpi"><div class="label">Upcoming</div><div class="value">${upcoming.length}</div></div>
    <div class="kpi"><div class="label">Live now</div><div class="value" style="color:${live.length > 0 ? 'var(--bad)' : 'var(--dim)'}">${live.length}</div></div>
    <div class="kpi"><div class="label">Archived</div><div class="value">${archived.length}</div></div>
  </div>
</section>
<section style="max-width:980px;margin:0 auto;padding:24px 16px 60px">
  ${concerts.length === 0
    ? `<div class="card" style="text-align:center;padding:48px;color:var(--dim)">No concerts yet. <code>POST /v1/concerts</code></div>`
    : `<table>
        <thead><tr><th>Title</th><th>Kind</th><th>Scheduled</th><th>Cast</th><th>Tickets</th><th>Status</th></tr></thead>
        <tbody>${concerts.map(c => `<tr>
          <td><a href="/concerts/${encodeURIComponent(c.concert_id)}" style="color:var(--fg)"><strong>${escapeHtml(c.title)}</strong></a></td>
          <td><span class="badge b-dim">${escapeHtml(c.kind)}</span></td>
          <td style="font:500 11px var(--mono);color:var(--dim);white-space:nowrap">${c.scheduled_at ? new Date(c.scheduled_at).toLocaleString() : ''}</td>
          <td style="font:600 13px var(--mono)">${c.cast_count}</td>
          <td style="font:600 13px var(--mono)">${c.tickets_sold}${c.cap_attendees ? '/' + c.cap_attendees : ''}</td>
          <td><span class="badge b-${c.status === 'live' ? 'bad' : c.status === 'scheduled' ? 'warn' : 'dim'}">${escapeHtml(c.status)}</span></td>
        </tr>`).join('')}</tbody>
      </table>`}
</section>`));
  });

  app.get('/concerts/:id', async (req, res) => {
    const c = (await safe(pool, `SELECT * FROM agent_concerts WHERE concert_id=$1`, [req.params.id]))[0];
    if (!c) { res.status(404).type('text/html').send(shell('Not found', '', `<section style="padding:120px 0;text-align:center"><h1>404</h1></section>`)); return; }
    const cast = await safe(pool, `SELECT performer_did, role FROM concert_cast WHERE concert_id=$1 ORDER BY joined_at`, [req.params.id]);
    const tix = (await safe(pool, `SELECT COUNT(*)::int AS n FROM concert_tickets WHERE concert_id=$1`, [req.params.id]))[0]?.n || 0;
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.send(shell(c.title, c.description || '', `
<section style="max-width:780px;margin:0 auto;padding:60px 16px">
  <a href="/concerts" style="font:500 12px var(--mono);color:var(--dim);text-decoration:none">← Concerts</a>
  <div style="display:flex;gap:6px;margin-top:14px"><span class="badge b-dim">${escapeHtml(c.kind)}</span><span class="badge b-${c.status === 'live' ? 'bad' : c.status === 'scheduled' ? 'warn' : 'dim'}">${escapeHtml(c.status)}</span></div>
  <h1 style="font:600 32px var(--display);margin:14px 0">${escapeHtml(c.title)}</h1>
  ${c.description ? `<p style="color:var(--dim2);font-size:15px;line-height:1.7">${escapeHtml(c.description)}</p>` : ''}
  <div style="font:500 11px var(--mono);color:var(--dim);margin-top:14px">${c.scheduled_at ? new Date(c.scheduled_at).toLocaleString() : ''}${c.duration_minutes ? ` · ${c.duration_minutes}min` : ''}</div>
  ${c.stream_url ? `<div style="margin-top:14px"><a href="${escapeHtml(c.stream_url)}" class="btn primary">Stream ↗</a></div>` : ''}
</section>
<section style="max-width:780px;margin:0 auto;padding:24px 16px">
  <h2 style="font:600 14px var(--mono);color:var(--dim);text-transform:uppercase;letter-spacing:1.5px;margin-bottom:12px">Cast (${cast.length})</h2>
  ${cast.length === 0
    ? `<div class="card" style="text-align:center;padding:24px;color:var(--dim)">No performers yet.</div>`
    : `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:8px">${cast.map(p => `<div class="card" style="padding:10px 14px">
        <div style="font:500 11px var(--mono);color:var(--acc-dim);word-break:break-all"><a href="/a/${encodeURIComponent(p.performer_did)}" style="color:var(--acc-dim)">${escapeHtml(p.performer_did.slice(-14))}</a></div>
        <div style="font:500 10px var(--mono);color:var(--dim);text-transform:uppercase;letter-spacing:1.2px;margin-top:4px">${escapeHtml(p.role)}</div>
      </div>`).join('')}</div>`}
</section>
<section style="max-width:780px;margin:0 auto;padding:24px 16px 60px">
  <h2 style="font:600 14px var(--mono);color:var(--dim);text-transform:uppercase;letter-spacing:1.5px;margin-bottom:12px">Audience</h2>
  <div class="card" style="text-align:center;padding:20px">
    <div style="font:600 28px var(--mono)">${tix}${c.cap_attendees ? ' / ' + c.cap_attendees : ''}</div>
    <div style="font:500 11px var(--mono);color:var(--dim);text-transform:uppercase;letter-spacing:1.2px;margin-top:6px">tickets ${c.ticket_price_cents > 0 ? '($' + (Number(c.ticket_price_cents)/100).toFixed(2) + ' each)' : '(free)'}</div>
  </div>
</section>`));
  });
}

module.exports = { migrate, registerAgentConcertsRoutes };
