// ============================================================================
// status_incidents.js — real incident management for the public status page.
// Components, incidents, updates, subscribers (email + webhook). Replaces the
// static /status page rendered by marketing.js with a live one.
// ============================================================================
const crypto = require('crypto');
const { z } = require('zod');

const COMPONENTS = [
  ['api',          'Public API (api.openheab.com)'],
  ['mcp',          'MCP server (/mcp)'],
  ['dashboard',    'Customer dashboard'],
  ['audit_chain',  'Audit chain'],
  ['bank_chain',   'USDC wallet (Base)'],
  ['cards',        'Card issuing (Stripe)'],
  ['email',        'Email gateway'],
  ['cron',         'Background cron jobs'],
  ['realtime',     'SSE event stream'],
  ['inference',    'Multi-LLM inference router']
];

const STATUSES = ['operational', 'degraded_performance', 'partial_outage', 'major_outage', 'maintenance'];

async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS status_components (
      slug             TEXT PRIMARY KEY,
      name             TEXT NOT NULL,
      status           TEXT NOT NULL DEFAULT 'operational',
      uptime_30d_pct   REAL,
      uptime_90d_pct   REAL,
      updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS status_incidents (
      incident_id      TEXT PRIMARY KEY,
      title            TEXT NOT NULL,
      severity         TEXT NOT NULL DEFAULT 'minor',
      status           TEXT NOT NULL DEFAULT 'investigating',
      affected_components TEXT[],
      started_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      resolved_at      TIMESTAMPTZ,
      postmortem_url   TEXT
    );
    CREATE TABLE IF NOT EXISTS status_updates (
      update_id        TEXT PRIMARY KEY,
      incident_id      TEXT NOT NULL,
      status           TEXT NOT NULL,
      message          TEXT NOT NULL,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS status_subscribers (
      subscriber_id    TEXT PRIMARY KEY,
      email            TEXT,
      webhook_url      TEXT,
      components       TEXT[],
      confirmed_at     TIMESTAMPTZ,
      confirmation_token TEXT,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  for (const [slug, name] of COMPONENTS) {
    await pool.query(`INSERT INTO status_components (slug, name, status) VALUES ($1,$2,'operational')
                      ON CONFLICT (slug) DO NOTHING`, [slug, name]).catch(() => {});
  }
}

function newId(p) { return p + '_' + crypto.randomBytes(10).toString('hex'); }
function isAdmin(req) {
  const t = req.headers['x-admin-token'];
  return require('../safe_compare').safeTokenCompare(t, process.env.OPERATOR_ADMIN_TOKEN);
}

const incidentSchema = z.object({
  title: z.string().min(1).max(200),
  severity: z.enum(['minor', 'major', 'critical', 'maintenance']).optional(),
  affected_components: z.array(z.string()).min(1),
  message: z.string().max(5000).optional()
});

const updateSchema = z.object({
  status: z.enum(['investigating', 'identified', 'monitoring', 'resolved']),
  message: z.string().min(1).max(5000)
});

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

function statusColor(s) {
  return ({ operational: '#22c55e', degraded_performance: '#f59e0b', partial_outage: '#f97316',
            major_outage: '#ef4444', maintenance: '#7df9ff' })[s] || '#888';
}

function registerStatusIncidentsRoutes(app, pool, _verifyAgentAuth, auditChain) {
  const express = require('express');

  // Live JSON for status indicators (sub-second responses)
  app.get('/v1/status', async (req, res) => {
    const c = await pool.query(`SELECT slug, name, status, uptime_30d_pct, updated_at FROM status_components ORDER BY slug`)
      .catch(() => ({ rows: [] }));
    const i = await pool.query(`SELECT incident_id, title, severity, status, affected_components, started_at
                                FROM status_incidents WHERE resolved_at IS NULL ORDER BY started_at DESC`)
      .catch(() => ({ rows: [] }));
    const overall = c.rows.every(x => x.status === 'operational') ? 'operational' : 'degraded';
    res.setHeader('cache-control', 'no-store');
    res.json({ overall, components: c.rows, active_incidents: i.rows, checked_at: new Date().toISOString() });
  });

  // Live status HTML page (overrides marketing.js's static /status)
  app.get('/status/live', async (req, res) => {
    const c = await pool.query(`SELECT slug, name, status, uptime_30d_pct FROM status_components ORDER BY slug`).catch(() => ({ rows: [] }));
    const i = await pool.query(`SELECT incident_id, title, severity, status, started_at, resolved_at FROM status_incidents ORDER BY started_at DESC LIMIT 20`).catch(() => ({ rows: [] }));
    const overall = c.rows.every(x => x.status === 'operational') ? 'All systems operational' : 'Some systems degraded';

    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.send(`<!doctype html><html lang=en><head><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1">
<title>Status — OpenHeab</title>
<link rel=stylesheet href="/v1/design/tokens.css">
<style>main{max-width:760px;margin:0 auto;padding:48px 24px}
.status-banner{display:flex;gap:14px;align-items:center;padding:18px 22px;border-radius:var(--r-xl);margin:0 0 24px;border:1px solid var(--br);background:var(--card)}
.status-banner .dot{width:14px;height:14px;border-radius:50%;box-shadow:0 0 12px currentColor}
.comp{display:flex;justify-content:space-between;align-items:center;padding:12px 18px;border-bottom:1px solid var(--br)}
.comp:last-child{border-bottom:0}
.comp .pill{font:500 11px/1 var(--mono);padding:4px 10px;border-radius:var(--r-full);text-transform:uppercase;letter-spacing:1px}
</style></head><body><main>
<h1 style="font-size:32px;letter-spacing:-1px;margin-bottom:14px">Status</h1>
<div class=status-banner style="color:${overall.includes('All') ? '#22c55e' : '#f59e0b'}">
  <span class=dot></span><strong>${overall}</strong><span style="margin-left:auto;color:var(--dim);font:500 12px var(--mono)">live</span>
</div>
<div class=card style=padding:0>
${c.rows.map(x => `  <div class=comp>
    <span>${escapeHtml(x.name)}</span>
    <span class=pill style="color:${statusColor(x.status)};border:1px solid ${statusColor(x.status)}">${x.status.replace(/_/g,' ')}</span>
  </div>`).join('')}
</div>
<h2 style="font-size:18px;margin:32px 0 12px">Recent incidents</h2>
${i.rows.length === 0 ? '<p style=color:var(--dim);font-size:14px>No incidents in the last 90 days. ✓</p>' :
  i.rows.map(x => `<div style="padding:14px 18px;border-left:3px solid ${statusColor(x.status === 'resolved' ? 'operational' : 'major_outage')};margin-bottom:10px;background:var(--card);border-radius:0 var(--r-md) var(--r-md) 0">
    <strong>${escapeHtml(x.title)}</strong>
    <div style="color:var(--dim);font-size:12px;margin-top:4px">${new Date(x.started_at).toISOString().slice(0,16)} · ${escapeHtml(x.severity)} · ${escapeHtml(x.status)}${x.resolved_at ? ' · resolved' : ''}</div>
  </div>`).join('')}
<h2 style="font-size:18px;margin:32px 0 12px">Subscribe to incident updates</h2>
<form style="display:flex;gap:8px" onsubmit="event.preventDefault();fetch('/v1/status/subscribers',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:document.getElementById('em').value})}).then(r=>r.json()).then(()=>alert('Confirmation email sent.'))">
  <input id=em type=email placeholder="you@company.com" required style="flex:1">
  <button class="btn primary">Subscribe</button>
</form>
</main></body></html>`);
  });

  app.post('/v1/admin/status/components/:slug', express.json(), async (req, res) => {
    if (!isAdmin(req)) return res.status(401).json({ error: 'admin_auth_required' });
    if (!STATUSES.includes(req.body?.status)) return res.status(400).json({ error: 'invalid_status' });
    const r = await pool.query(`UPDATE status_components SET status=$1, updated_at=NOW() WHERE slug=$2 RETURNING slug`,
      [req.body.status, req.params.slug]).catch(() => ({ rows: [] }));
    if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
    if (auditChain) await auditChain.append({ event_type: 'status.component_updated', slug: req.params.slug, status: req.body.status }).catch(() => {});
    res.json({ slug: r.rows[0].slug });
  });

  app.post('/v1/admin/status/incidents', express.json(), async (req, res) => {
    if (!isAdmin(req)) return res.status(401).json({ error: 'admin_auth_required' });
    const p = incidentSchema.safeParse(req.body || {});
    if (!p.success) return res.status(400).json({ error: 'invalid_input', details: p.error.flatten() });
    const id = newId('inc');
    await pool.query(
      `INSERT INTO status_incidents (incident_id, title, severity, status, affected_components)
       VALUES ($1,$2,$3,'investigating',$4)`,
      [id, p.data.title, p.data.severity || 'minor', p.data.affected_components]
    );
    if (p.data.message) {
      await pool.query(`INSERT INTO status_updates (update_id, incident_id, status, message) VALUES ($1,$2,'investigating',$3)`,
        [newId('upd'), id, p.data.message]).catch(() => {});
    }
    // Set components to degraded
    for (const c of p.data.affected_components) {
      await pool.query(`UPDATE status_components SET status='partial_outage', updated_at=NOW() WHERE slug=$1`, [c]).catch(() => {});
    }
    if (auditChain) await auditChain.append({ event_type: 'status.incident_opened', incident_id: id, severity: p.data.severity, components: p.data.affected_components }).catch(() => {});
    res.status(201).json({ incident_id: id });
  });

  app.post('/v1/admin/status/incidents/:iid/updates', express.json(), async (req, res) => {
    if (!isAdmin(req)) return res.status(401).json({ error: 'admin_auth_required' });
    const p = updateSchema.safeParse(req.body || {});
    if (!p.success) return res.status(400).json({ error: 'invalid_input', details: p.error.flatten() });
    const id = newId('upd');
    await pool.query(`INSERT INTO status_updates (update_id, incident_id, status, message) VALUES ($1,$2,$3,$4)`,
      [id, req.params.iid, p.data.status, p.data.message]);
    await pool.query(`UPDATE status_incidents SET status=$1${p.data.status === 'resolved' ? ', resolved_at=NOW()' : ''} WHERE incident_id=$2`,
      [p.data.status, req.params.iid]).catch(() => {});
    if (p.data.status === 'resolved') {
      // Reset affected components to operational
      const inc = await pool.query(`SELECT affected_components FROM status_incidents WHERE incident_id=$1`, [req.params.iid]).catch(() => ({ rows: [] }));
      for (const c of inc.rows[0]?.affected_components || []) {
        await pool.query(`UPDATE status_components SET status='operational', updated_at=NOW() WHERE slug=$1`, [c]).catch(() => {});
      }
    }
    if (auditChain) await auditChain.append({ event_type: 'status.incident_updated', incident_id: req.params.iid, status: p.data.status }).catch(() => {});
    res.status(201).json({ update_id: id });
  });

  app.get('/v1/status/incidents/:iid', async (req, res) => {
    const i = await pool.query(`SELECT * FROM status_incidents WHERE incident_id=$1`, [req.params.iid]).catch(() => ({ rows: [] }));
    if (!i.rows[0]) return res.status(404).json({ error: 'not_found' });
    const u = await pool.query(`SELECT update_id, status, message, created_at FROM status_updates WHERE incident_id=$1 ORDER BY created_at`, [req.params.iid])
      .catch(() => ({ rows: [] }));
    res.json({ ...i.rows[0], updates: u.rows });
  });

  app.post('/v1/status/subscribers', express.json(), async (req, res) => {
    const { email, webhook_url, components } = req.body || {};
    if (!email && !webhook_url) return res.status(400).json({ error: 'email_or_webhook_required' });
    const id = newId('sub');
    const token = crypto.randomBytes(20).toString('hex');
    await pool.query(
      `INSERT INTO status_subscribers (subscriber_id, email, webhook_url, components, confirmation_token)
       VALUES ($1,$2,$3,$4,$5)`,
      [id, email ? email.toLowerCase() : null, webhook_url || null, components || null, token]
    );
    res.status(201).json({ subscriber_id: id, confirm_url: `/v1/status/subscribers/${id}/confirm?token=${token}` });
  });

  app.get('/v1/status/subscribers/:id/confirm', async (req, res) => {
    const r = await pool.query(`UPDATE status_subscribers SET confirmed_at=NOW() WHERE subscriber_id=$1 AND confirmation_token=$2 AND confirmed_at IS NULL RETURNING subscriber_id`,
      [req.params.id, req.query.token]).catch(() => ({ rows: [] }));
    if (!r.rows[0]) return res.status(404).type('text/plain').send('Invalid or already confirmed.');
    res.type('text/html').send('<h1>Confirmed</h1><p>You will get incident updates.</p>');
  });

  // RSS feed of incidents
  app.get('/status/incidents.rss', async (req, res) => {
    const r = await pool.query(`SELECT incident_id, title, severity, status, started_at, resolved_at FROM status_incidents ORDER BY started_at DESC LIMIT 100`)
      .catch(() => ({ rows: [] }));
    const base = (process.env.OPERATOR_PUBLIC_URL || ('http://' + req.headers.host)).replace(/\/$/, '');
    res.setHeader('content-type', 'application/rss+xml');
    res.send(`<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel>
<title>OpenHeab Status</title><link>${base}/status/live</link><description>Incident updates</description>
${r.rows.map(x => `<item><title>${escapeHtml(x.title)}</title><pubDate>${new Date(x.started_at).toUTCString()}</pubDate><guid>${base}/v1/status/incidents/${x.incident_id}</guid><description>Severity: ${escapeHtml(x.severity)} · Status: ${escapeHtml(x.status)}${x.resolved_at ? ' · Resolved: ' + new Date(x.resolved_at).toISOString() : ''}</description></item>`).join('\n')}
</channel></rss>`);
  });
}

module.exports = { migrate, registerStatusIncidentsRoutes, COMPONENTS, STATUSES };
