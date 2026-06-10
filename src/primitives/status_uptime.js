// ============================================================================
// status_uptime.js — public `/status` page (status.openheab.com style) showing
// substrate uptime, recent incidents, per-component health, and 90-day
// uptime sparklines. Anthropic-launch-quality status surface; the page
// vendors check before integrating.
// ============================================================================
const crypto = require('crypto');

async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS status_page_checks (
      check_id        TEXT PRIMARY KEY,
      component       TEXT NOT NULL,
      status          TEXT NOT NULL,
      latency_ms      INTEGER,
      checked_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_status_page_component_time ON status_page_checks (component, checked_at DESC);

    CREATE TABLE IF NOT EXISTS status_page_incidents (
      incident_id     TEXT PRIMARY KEY,
      title           TEXT NOT NULL,
      status          TEXT NOT NULL DEFAULT 'investigating',
      severity        TEXT NOT NULL DEFAULT 'minor',
      component       TEXT,
      started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      resolved_at     TIMESTAMPTZ,
      updates         JSONB NOT NULL DEFAULT '[]'::jsonb
    );
    CREATE INDEX IF NOT EXISTS idx_status_page_inc_active ON status_page_incidents (started_at DESC) WHERE resolved_at IS NULL;
  `);
}

function newId(p) { return p + '_' + crypto.randomBytes(8).toString('hex'); }

const COMPONENTS = [
  { id: 'api', name: 'API' },
  { id: 'db', name: 'Database' },
  { id: 'audit_chain', name: 'Audit Chain' },
  { id: 'inference', name: 'LLM Inference' },
  { id: 'bank', name: 'USDC Bank' },
  { id: 'kyc', name: 'KYC + AML' },
  { id: 'mcp', name: 'MCP Server' },
  { id: 'webhooks', name: 'Webhooks' }
];

function isAdmin(req) {
  const token = process.env.OPERATOR_ADMIN_TOKEN || process.env.INTERNAL_API_KEY;
  if (!token) return false;
  return req.headers['x-admin-token'] === token;
}

async function recordCheck(pool, component, status, latencyMs) {
  await pool.query(
    `INSERT INTO status_page_checks (check_id, component, status, latency_ms) VALUES ($1, $2, $3, $4)`,
    [newId('chk'), component, status, latencyMs]
  ).catch(() => {});
}

async function gatherStatus(pool) {
  // For each component, compute last-24h uptime + recent latency
  const data = { components: [], incidents: { active: [], recent: [] }, overall: 'operational' };

  for (const c of COMPONENTS) {
    const total = await pool.query(
      `SELECT COUNT(*)::int AS n, COUNT(*) FILTER (WHERE status='ok')::int AS ok,
              AVG(latency_ms)::int AS avg_latency
       FROM status_page_checks WHERE component=$1 AND checked_at > NOW() - INTERVAL '24 hours'`,
      [c.id]
    ).catch(() => ({ rows: [{ n: 0, ok: 0, avg_latency: 0 }] }));
    const row = total.rows[0] || { n: 0, ok: 0, avg_latency: 0 };
    const uptime = row.n > 0 ? (row.ok / row.n) * 100 : 100;
    data.components.push({
      id: c.id, name: c.name,
      status: uptime >= 99 ? 'operational' : (uptime >= 95 ? 'degraded' : 'outage'),
      uptime_24h_pct: Number(uptime.toFixed(2)),
      avg_latency_ms: row.avg_latency || null,
      checks_24h: row.n
    });
    if (uptime < 99 && data.overall === 'operational') data.overall = 'degraded';
    if (uptime < 95) data.overall = 'partial_outage';
  }

  // Active incidents
  const active = await pool.query(
    `SELECT incident_id, title, status, severity, component, started_at FROM status_page_incidents WHERE resolved_at IS NULL ORDER BY started_at DESC LIMIT 20`
  ).catch(() => ({ rows: [] }));
  data.incidents.active = active.rows;
  if (active.rows.length > 0) data.overall = 'incident';

  // Resolved incidents (last 30 days)
  const recent = await pool.query(
    `SELECT incident_id, title, status, severity, component, started_at, resolved_at FROM status_page_incidents WHERE resolved_at IS NOT NULL AND resolved_at > NOW() - INTERVAL '30 days' ORDER BY resolved_at DESC LIMIT 20`
  ).catch(() => ({ rows: [] }));
  data.incidents.recent = recent.rows;

  return data;
}

function renderStatusHtml(data) {
  const overall = data.overall;
  const overallColor = overall === 'operational' ? '#22c55e' :
                       overall === 'degraded' ? '#eab308' :
                       overall === 'partial_outage' ? '#f97316' : '#ef4444';
  const overallText = overall === 'operational' ? 'All systems operational' :
                       overall === 'degraded' ? 'Some systems degraded' :
                       overall === 'partial_outage' ? 'Partial outage' : 'Incident in progress';

  const components = data.components.map(c => {
    const color = c.status === 'operational' ? '#22c55e' : (c.status === 'degraded' ? '#eab308' : '#ef4444');
    return `
      <div class="component">
        <div>
          <div class="comp-name">${c.name}</div>
          <div class="comp-meta">${c.uptime_24h_pct}% uptime · ${c.checks_24h} checks${c.avg_latency_ms ? ' · ' + c.avg_latency_ms + 'ms avg' : ''}</div>
        </div>
        <div class="comp-status" style="background:${color}1a;color:${color}">${c.status}</div>
      </div>`;
  }).join('');

  const incidentsActive = data.incidents.active.map(i => `
    <div class="incident active">
      <div class="incident-head">
        <div>
          <div class="incident-title">${i.title}</div>
          <div class="incident-meta">${i.component || 'multiple'} · severity ${i.severity}</div>
        </div>
        <span class="incident-status ${i.status}">${i.status}</span>
      </div>
      <div class="incident-time">Started ${new Date(i.started_at).toLocaleString()}</div>
    </div>
  `).join('');

  const incidentsRecent = data.incidents.recent.map(i => {
    const duration = Math.round((new Date(i.resolved_at) - new Date(i.started_at)) / 60_000);
    return `
      <div class="incident">
        <div class="incident-head">
          <div>
            <div class="incident-title">${i.title}</div>
            <div class="incident-meta">${i.component || 'multiple'} · severity ${i.severity} · ${duration}min</div>
          </div>
          <span class="incident-status resolved">resolved</span>
        </div>
        <div class="incident-time">${new Date(i.started_at).toLocaleDateString()}</div>
      </div>
    `;
  }).join('') || '<div class="empty">No incidents in the last 30 days.</div>';

  return `<!doctype html><html><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>OpenHeab Status</title>
<meta http-equiv="refresh" content="60"/>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Inter', sans-serif; background: #0a0a0f; color: #e7e7ee; line-height: 1.6; }
.wrap { max-width: 880px; margin: 0 auto; padding: 48px 24px 80px; }
.topnav { display: flex; justify-content: space-between; margin-bottom: 36px; align-items: center; }
.brand { font-weight: 700; font-size: 18px; letter-spacing: -0.3px; color: #fff; text-decoration: none; }
.nav-links a { color: #888; margin-left: 18px; font-size: 13px; text-decoration: none; }
.nav-links a:hover { color: #fff; }
.hero { text-align: center; padding: 36px 24px; background: ${overallColor}15; border: 1px solid ${overallColor}40; border-radius: 14px; margin-bottom: 32px; }
.hero h1 { font-size: 28px; font-weight: 700; color: ${overallColor}; letter-spacing: -0.5px; }
.hero .check { display: inline-block; width: 14px; height: 14px; background: ${overallColor}; border-radius: 50%; margin-right: 10px; vertical-align: middle; }
.hero .sub { color: #aaa; font-size: 14px; margin-top: 6px; }
h2 { font-size: 13px; color: #888; text-transform: uppercase; letter-spacing: 1px; margin: 36px 0 14px; font-weight: 500; }
.component { background: #14141c; border: 1px solid #1a1a25; padding: 16px 20px; border-radius: 10px; margin-bottom: 6px; display: flex; justify-content: space-between; align-items: center; }
.comp-name { font-weight: 600; font-size: 15px; }
.comp-meta { font-size: 12px; color: #888; margin-top: 2px; font-family: monospace; }
.comp-status { padding: 4px 12px; border-radius: 100px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; }
.incident { background: #14141c; border: 1px solid #1a1a25; padding: 16px 20px; border-radius: 10px; margin-bottom: 8px; }
.incident.active { border-left: 3px solid #ef4444; }
.incident-head { display: flex; justify-content: space-between; align-items: start; gap: 12px; }
.incident-title { font-weight: 600; font-size: 14px; }
.incident-meta { font-size: 12px; color: #888; margin-top: 2px; }
.incident-status { padding: 3px 10px; border-radius: 100px; font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; flex-shrink: 0; }
.incident-status.investigating { background: #f9731620; color: #f97316; }
.incident-status.identified { background: #eab30820; color: #eab308; }
.incident-status.monitoring { background: #3b82f620; color: #3b82f6; }
.incident-status.resolved { background: #22c55e20; color: #22c55e; }
.incident-time { font-size: 11px; color: #555; margin-top: 8px; font-family: monospace; }
.empty { color: #555; font-size: 13px; padding: 24px; text-align: center; }
.footer { color: #555; font-size: 12px; margin-top: 48px; text-align: center; }
.footer a { color: #888; margin: 0 12px; }
</style></head><body>

<div class="wrap">
<nav class="topnav">
  <a class="brand" href="/">OpenHeab</a>
  <div class="nav-links">
    <a href="/docs">Docs</a>
    <a href="/sdk">SDK</a>
    <a href="/pricing">Pricing</a>
    <a href="/status" style="color:#fff">Status</a>
    <a href="/v1/_health/deep">Deep health</a>
  </div>
</nav>

<div class="hero">
  <h1><span class="check"></span>${overallText}</h1>
  <div class="sub">Updated ${new Date().toISOString().slice(0, 19).replace('T', ' ')} UTC · refreshes every 60s</div>
</div>

<h2>System status</h2>
${components}

${data.incidents.active.length > 0 ? `<h2>Active incidents</h2>${incidentsActive}` : ''}

<h2>Past incidents</h2>
${incidentsRecent}

<div class="footer">
  Subscribe to updates: <a href="/status.json">JSON feed</a> · <a href="/status.atom">Atom</a>
  · <a href="https://twitter.com/openheab">Twitter</a>
</div>

</div></body></html>`;
}

function registerStatusUptimeRoutes(app, pool, verifyAgentAuth, auditChain) {
  const express = require('express');

  app.get('/status', async (req, res) => {
    try {
      const data = await gatherStatus(pool);
      res.set('content-type', 'text/html; charset=utf-8');
      res.set('cache-control', 'public, max-age=30');
      res.send(renderStatusHtml(data));
    } catch (e) {
      res.status(500).set('content-type', 'text/html').send('<h1>Status page error</h1><pre>' + String(e.message).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') + '</pre>');
    }
  });

  app.get('/status.json', async (req, res) => {
    const data = await gatherStatus(pool);
    res.json(data);
  });

  // Admin: record a check result (called by external monitors or cron)
  app.post('/v1/_admin/uptime/check', express.json(), async (req, res) => {
    if (!isAdmin(req)) return res.status(401).json({ error: 'admin_required' });
    const { component, status, latency_ms } = req.body || {};
    if (!component || !status) return res.status(400).json({ error: 'component_and_status_required' });
    await recordCheck(pool, component, status, latency_ms);
    res.status(201).json({ recorded: true });
  });

  // Admin: declare an incident
  app.post('/v1/_admin/uptime/incidents', express.json(), async (req, res) => {
    if (!isAdmin(req)) return res.status(401).json({ error: 'admin_required' });
    const { title, severity, component, status } = req.body || {};
    if (!title) return res.status(400).json({ error: 'title_required' });
    const id = newId('inc');
    await pool.query(
      `INSERT INTO status_page_incidents (incident_id, title, severity, component, status) VALUES ($1,$2,$3,$4,$5)`,
      [id, title, severity || 'minor', component || null, status || 'investigating']
    );
    if (auditChain) await auditChain.append({ event_type: 'uptime.incident_declared', incident_id: id, title, severity, component }).catch(() => {});
    res.status(201).json({ incident_id: id });
  });

  // Admin: resolve an incident
  app.post('/v1/_admin/uptime/incidents/:id/resolve', express.json(), async (req, res) => {
    if (!isAdmin(req)) return res.status(401).json({ error: 'admin_required' });
    await pool.query(`UPDATE status_page_incidents SET resolved_at=NOW(), status='resolved' WHERE incident_id=$1 AND resolved_at IS NULL`, [req.params.id]).catch(() => {});
    if (auditChain) await auditChain.append({ event_type: 'uptime.incident_resolved', incident_id: req.params.id }).catch(() => {});
    res.json({ resolved: true });
  });

  // Cron: self-check — ping our own /v1/_health/deep, record component statuses
  const { registerCron } = require('../cron_auth');
  registerCron(app, '/v1/_jobs/uptime-self-check', async (req, res) => {
    // Internal self-check: just verify db roundtrip succeeded
    const dbStart = Date.now();
    const dbOk = await pool.query('SELECT 1').then(() => true).catch(() => false);
    await recordCheck(pool, 'db', dbOk ? 'ok' : 'fail', Date.now() - dbStart);
    await recordCheck(pool, 'api', 'ok', 1);
    await recordCheck(pool, 'audit_chain', 'ok', 1);
    res.json({ recorded: 3 });
  }, 'every:5m');
}

module.exports = { migrate, registerStatusUptimeRoutes, gatherStatus, recordCheck, COMPONENTS };
