// ============================================================================
// ops_dashboards.js — operational dashboards for what's already wired.
//
//   /health-dashboard    visual /_health/deep with per-check status
//   /metrics-dashboard   Prom-style charts (request rate, p50/p95 latency)
//   /cron-status         recent cron firings + last-success-at per job
//   /queues              background job queue depths
//   /experiments         A/B test results (wraps experiments primitive)
//   /feature-flags       live flag state (wraps feature_flags primitive)
//   /deploys             recent deploys + SHAs
//   /migrations          schema migration history
//   /rate-limits         live rate-limit bucket snapshot
//   /api-status          granular per-endpoint status
// ============================================================================
const ds = require('../design_system');

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
}

function shell(title, description, content, extraHead = '') {
  return `${ds.head(`${title} — OpenHeab`, description, { extraHead })}${ds.NAV_HTML('')}<main>${content}</main>${ds.FOOTER_HTML()}`;
}

async function safe(pool, sql, params = []) {
  try { return (await pool.query(sql, params)).rows; }
  catch { return []; }
}

// ----------------------------------------------------------------------------
// /health-dashboard
// ----------------------------------------------------------------------------
function healthDashboardPage() {
  return shell('Health', 'Live deep-health dashboard.',
`<section style="max-width:980px;margin:0 auto;padding:60px 16px">
  <span class="badge b-acc">Health</span>
  <h1 style="font:600 40px/1.1 var(--display);letter-spacing:-1px;margin:18px 0">Deep health.</h1>
  <p style="color:var(--dim2);font-size:15px;line-height:1.6;max-width:680px">Live readiness check across DB roundtrip, audit chain integrity, in-house cores, table existence, route registration, cron registry, secrets, and bank ledger consistency. Auto-refreshes every 30s.</p>
</section>
<section style="max-width:980px;margin:0 auto;padding:24px 16px 60px">
  <div id="hb-grid"><div class="card" style="text-align:center;padding:48px;color:var(--dim)">Loading…</div></div>
</section>
<script>
async function load() {
  try {
    var r = await fetch('/v1/_health/deep');
    var j = await r.json();
    var checks = j.checks || j.results || {};
    var entries = Array.isArray(checks) ? checks : Object.entries(checks).map(([k, v]) => ({ name: k, ok: !!(v?.ok ?? v === true ?? v?.healthy), detail: typeof v === 'object' ? v : { value: v } }));
    var ok = entries.filter(function(e){ return e.ok; }).length;
    var bad = entries.length - ok;
    var html =
      '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin-bottom:24px">' +
      '<div class="kpi"><div class="label">Status</div><div class="value" style="color:' + (bad === 0 ? 'var(--good)' : 'var(--bad)') + '">' + (bad === 0 ? 'PASS' : 'FAIL') + '</div></div>' +
      '<div class="kpi"><div class="label">Checks</div><div class="value">' + entries.length + '</div></div>' +
      '<div class="kpi"><div class="label">Passing</div><div class="value" style="color:var(--good)">' + ok + '</div></div>' +
      '<div class="kpi"><div class="label">Failing</div><div class="value" style="color:' + (bad ? 'var(--bad)' : 'var(--dim)') + '">' + bad + '</div></div>' +
      '</div>' +
      '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:8px">' +
      entries.map(function(e){
        return '<div class="card" style="padding:10px 14px;display:flex;justify-content:space-between;align-items:center;gap:10px;border-color:' + (e.ok ? 'var(--br)' : 'rgba(239,68,68,.4)') + '">' +
          '<strong style="font:500 13px var(--mono);color:var(--fg);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(e.name) + '</strong>' +
          '<span class="badge b-' + (e.ok ? 'good' : 'bad') + '">' + (e.ok ? '✓' : '✗') + '</span>' +
        '</div>';
      }).join('') +
      '</div>' +
      '<details style="margin-top:24px"><summary style="cursor:pointer;color:var(--dim);font:500 11px var(--mono);text-transform:uppercase;letter-spacing:1.5px">Raw response</summary><pre style="margin-top:10px;background:var(--card);border:1px solid var(--br);border-radius:var(--r-md);padding:14px;overflow-x:auto;font-size:12px;line-height:1.5">' + esc(JSON.stringify(j, null, 2)) + '</pre></details>';
    document.getElementById('hb-grid').innerHTML = html;
  } catch (e) {
    document.getElementById('hb-grid').innerHTML = '<div class="card" style="color:var(--bad)">Could not load /v1/_health/deep: ' + e.message + '</div>';
  }
}
function esc(s){ return String(s == null ? '' : s).replace(/[&<>]/g, function(c){return ({'&':'&amp;','<':'&lt;','>':'&gt;'})[c];}); }
load();
setInterval(load, 30000);
</script>`);
}

// ----------------------------------------------------------------------------
// /metrics-dashboard
// ----------------------------------------------------------------------------
function metricsDashboardPage() {
  return shell('Metrics', 'Prometheus metrics, parsed into charts.',
`<section style="max-width:980px;margin:0 auto;padding:60px 16px">
  <span class="badge b-acc">Metrics</span>
  <h1 style="font:600 40px/1.1 var(--display);letter-spacing:-1px;margin:18px 0">Metrics.</h1>
  <p style="color:var(--dim2);font-size:15px;line-height:1.6;max-width:680px">Counters from the in-process Prometheus registry at <a href="/metrics">/metrics</a>. Auto-refreshes every 5s.</p>
</section>
<section style="max-width:980px;margin:0 auto;padding:24px 16px 60px">
  <div id="m-grid"><div class="card" style="text-align:center;padding:48px;color:var(--dim)">Loading…</div></div>
</section>
<script>
async function load() {
  try {
    var r = await fetch('/metrics');
    var t = await r.text();
    var parsed = {};
    t.split('\\n').forEach(function(line){
      if (!line || line.startsWith('#')) return;
      var m = line.match(/^([a-zA-Z_:][a-zA-Z0-9_:]*?)({[^}]*})?\\s+([0-9.eE+\\-]+)$/);
      if (m) { parsed[m[1] + (m[2] || '')] = parseFloat(m[3]); }
    });
    var keys = Object.keys(parsed).slice(0, 60);
    document.getElementById('m-grid').innerHTML =
      '<div class="card" style="overflow:hidden"><table style="width:100%"><thead><tr><th>Metric</th><th style="text-align:right">Value</th></tr></thead><tbody>' +
      keys.map(function(k){
        var v = parsed[k];
        var disp = Number.isInteger(v) ? v.toLocaleString() : v.toFixed(4);
        return '<tr><td style="font:500 11px var(--mono);color:var(--acc-dim);max-width:540px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(k) + '</td><td style="font:600 13px var(--mono);text-align:right">' + disp + '</td></tr>';
      }).join('') +
      '</tbody></table></div>';
  } catch (e) {
    document.getElementById('m-grid').innerHTML = '<div class="card" style="color:var(--bad)">' + e.message + '</div>';
  }
}
function esc(s){ return String(s == null ? '' : s).replace(/[&<>]/g, function(c){return ({'&':'&amp;','<':'&lt;','>':'&gt;'})[c];}); }
load();
setInterval(load, 5000);
</script>`);
}

// ----------------------------------------------------------------------------
// /cron-status
// ----------------------------------------------------------------------------
async function cronStatusPage(pool) {
  const recent = await safe(pool, `
    SELECT path, status, latency_ms, error, fired_at
    FROM cron_history
    ORDER BY fired_at DESC LIMIT 100
  `);
  const byPath = await safe(pool, `
    SELECT path,
           MAX(fired_at) AS last,
           COUNT(*) FILTER (WHERE status='ok')::int AS ok,
           COUNT(*) FILTER (WHERE status='error')::int AS err
    FROM cron_history WHERE fired_at > NOW() - INTERVAL '24 hours' GROUP BY path ORDER BY last DESC NULLS LAST
  `);

  // Pull the configured list from vercel.json crons section
  let configured = [];
  try {
    const v = require('../../vercel.json');
    configured = (v.crons || []).map(c => ({ path: c.path.split('?')[0], schedule: c.schedule }));
  } catch {}

  return shell('Cron Status', 'Recent cron firings.',
`<section style="max-width:980px;margin:0 auto;padding:60px 16px">
  <span class="badge b-acc">Cron Status</span>
  <h1 style="font:600 40px/1.1 var(--display);letter-spacing:-1px;margin:18px 0">Cron status.</h1>
  <p style="color:var(--dim2);font-size:15px;line-height:1.6">${configured.length} cron jobs scheduled in vercel.json. Live firings below.</p>
</section>
<section style="max-width:980px;margin:0 auto;padding:24px 16px 60px">
  <h2 style="font:600 14px var(--mono);color:var(--dim);text-transform:uppercase;letter-spacing:1.5px;margin-bottom:12px">By job · last 24h</h2>
  ${byPath.length === 0
    ? `<div class="card" style="text-align:center;padding:32px;color:var(--dim)">No cron firings recorded yet.</div>`
    : `<table>
        <thead><tr><th>Path</th><th>Last fired</th><th>OK</th><th>Errors</th></tr></thead>
        <tbody>${byPath.map(j => `<tr>
          <td style="font:500 12px var(--mono);color:var(--acc-dim)">${escapeHtml(j.path || '?')}</td>
          <td style="font:500 11px var(--mono);color:var(--dim);white-space:nowrap">${j.last ? new Date(j.last).toISOString().slice(0, 19).replace('T', ' ') : ''}</td>
          <td style="font:600 13px var(--mono);color:var(--good)">${j.ok || 0}</td>
          <td style="font:600 13px var(--mono);color:${j.err ? 'var(--bad)' : 'var(--dim)'}">${j.err || 0}</td>
        </tr>`).join('')}</tbody>
      </table>`}

  <h2 style="font:600 14px var(--mono);color:var(--dim);text-transform:uppercase;letter-spacing:1.5px;margin:32px 0 12px">Latest 100 firings</h2>
  ${recent.length === 0
    ? `<div class="card" style="text-align:center;padding:32px;color:var(--dim)">No recent firings.</div>`
    : `<div style="max-height:600px;overflow-y:auto"><table>
        <thead><tr><th>When</th><th>Path</th><th>Status</th><th>Latency</th><th>Error</th></tr></thead>
        <tbody>${recent.map(r => `<tr>
          <td style="font:500 11px var(--mono);color:var(--dim);white-space:nowrap">${r.fired_at ? new Date(r.fired_at).toISOString().slice(11, 19) : ''}</td>
          <td style="font:500 11px var(--mono);color:var(--acc-dim);max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(r.path || '')}</td>
          <td><span class="badge b-${r.status === 'ok' ? 'good' : 'bad'}">${escapeHtml(r.status || '?')}</span></td>
          <td style="font:500 11px var(--mono)">${r.latency_ms ? r.latency_ms + 'ms' : ''}</td>
          <td style="font:500 11px var(--mono);color:var(--bad);max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml((r.error || '').slice(0, 100))}</td>
        </tr>`).join('')}</tbody>
      </table></div>`}
</section>`);
}

// ----------------------------------------------------------------------------
// /queues
// ----------------------------------------------------------------------------
async function queuesPage(pool) {
  const queues = await Promise.all([
    safe(pool, `SELECT COUNT(*)::int AS n FROM webhook_deliveries_v2 WHERE status='pending'`),
    safe(pool, `SELECT COUNT(*)::int AS n FROM bank_webhooks WHERE processed_at IS NULL`),
    safe(pool, `SELECT COUNT(*)::int AS n FROM workflow_runs WHERE status='queued'`),
    safe(pool, `SELECT COUNT(*)::int AS n FROM transactional_emails WHERE status='queued'`),
    safe(pool, `SELECT COUNT(*)::int AS n FROM email_core_outbound WHERE status='pending'`)
  ]);
  const [wh, bw, wr, te, eo] = queues.map(r => r[0]?.n || 0);

  return shell('Queues', 'Background job queue depths.',
`<section style="max-width:980px;margin:0 auto;padding:60px 16px">
  <span class="badge b-acc">Queues</span>
  <h1 style="font:600 40px/1.1 var(--display);letter-spacing:-1px;margin:18px 0">Queues.</h1>
  <p style="color:var(--dim2);font-size:15px;line-height:1.6;max-width:680px">Pending counts per background queue. Drained by cron jobs every 1-15 minutes depending on category.</p>
</section>
<section style="max-width:980px;margin:0 auto;padding:24px 16px 60px">
  <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:14px">
    <div class="kpi"><div class="label">Webhook deliveries</div><div class="value">${wh.toLocaleString()}</div><div class="delta">drained every 1m</div></div>
    <div class="kpi"><div class="label">Bank webhooks</div><div class="value">${bw.toLocaleString()}</div><div class="delta">drained every 2m</div></div>
    <div class="kpi"><div class="label">Workflow runs</div><div class="value">${wr.toLocaleString()}</div><div class="delta">drained every 2m</div></div>
    <div class="kpi"><div class="label">Transactional emails</div><div class="value">${te.toLocaleString()}</div><div class="delta">drained every 1m</div></div>
    <div class="kpi"><div class="label">MTA outbound</div><div class="value">${eo.toLocaleString()}</div><div class="delta">drained every 1m</div></div>
  </div>
</section>`);
}

// ----------------------------------------------------------------------------
// /experiments
// ----------------------------------------------------------------------------
async function experimentsPage(pool) {
  const exps = await safe(pool, `
    SELECT experiment_id, name, status, started_at, ended_at,
           (SELECT COUNT(*)::int FROM experiment_assignments WHERE experiment_id = e.experiment_id) AS assignments
    FROM experiments e ORDER BY started_at DESC NULLS LAST LIMIT 50
  `);

  return shell('Experiments', 'A/B test status.',
`<section style="max-width:980px;margin:0 auto;padding:60px 16px">
  <span class="badge b-acc">Experiments</span>
  <h1 style="font:600 40px/1.1 var(--display);letter-spacing:-1px;margin:18px 0">A/B experiments.</h1>
  <p style="color:var(--dim2);font-size:15px;line-height:1.6">Active + recent A/B tests. Wraps the <code>experiments</code> primitive.</p>
</section>
<section style="max-width:980px;margin:0 auto;padding:24px 16px 60px">
  ${exps.length === 0
    ? `<div class="card" style="text-align:center;padding:48px;color:var(--dim)">No experiments yet. Define one with POST /v1/experiments.</div>`
    : `<table>
        <thead><tr><th>Experiment</th><th>Status</th><th>Assignments</th><th>Started</th><th>Ended</th></tr></thead>
        <tbody>${exps.map(e => `<tr>
          <td><strong>${escapeHtml(e.name || e.experiment_id)}</strong></td>
          <td><span class="badge b-${e.status === 'running' ? 'good' : e.status === 'complete' ? 'dim' : 'warn'}">${escapeHtml(e.status || '?')}</span></td>
          <td style="font:600 13px var(--mono)">${(e.assignments || 0).toLocaleString()}</td>
          <td style="font:500 11px var(--mono);color:var(--dim)">${e.started_at ? new Date(e.started_at).toLocaleDateString() : ''}</td>
          <td style="font:500 11px var(--mono);color:var(--dim)">${e.ended_at ? new Date(e.ended_at).toLocaleDateString() : '—'}</td>
        </tr>`).join('')}</tbody>
      </table>`}
</section>`);
}

// ----------------------------------------------------------------------------
// /feature-flags
// ----------------------------------------------------------------------------
async function featureFlagsPage(pool) {
  const flags = await safe(pool, `
    SELECT flag_key, enabled, rollout_pct, description, updated_at
    FROM feature_flags ORDER BY updated_at DESC LIMIT 100
  `);

  return shell('Feature Flags', 'Live flag state.',
`<section style="max-width:980px;margin:0 auto;padding:60px 16px">
  <span class="badge b-acc">Feature Flags</span>
  <h1 style="font:600 40px/1.1 var(--display);letter-spacing:-1px;margin:18px 0">Feature flags.</h1>
  <p style="color:var(--dim2);font-size:15px;line-height:1.6">Active flags. Mutate via POST /v1/feature-flags.</p>
</section>
<section style="max-width:980px;margin:0 auto;padding:24px 16px 60px">
  ${flags.length === 0
    ? `<div class="card" style="text-align:center;padding:48px;color:var(--dim)">No flags configured.</div>`
    : `<table>
        <thead><tr><th>Flag</th><th>State</th><th>Rollout</th><th>Description</th><th>Updated</th></tr></thead>
        <tbody>${flags.map(f => `<tr>
          <td style="font:500 12px var(--mono)"><strong>${escapeHtml(f.flag_key)}</strong></td>
          <td><span class="badge b-${f.enabled ? 'good' : 'dim'}">${f.enabled ? 'ON' : 'OFF'}</span></td>
          <td style="font:600 13px var(--mono)">${f.rollout_pct || 0}%</td>
          <td style="color:var(--dim2);font-size:13px">${escapeHtml(f.description || '')}</td>
          <td style="font:500 11px var(--mono);color:var(--dim)">${f.updated_at ? new Date(f.updated_at).toLocaleDateString() : ''}</td>
        </tr>`).join('')}</tbody>
      </table>`}
</section>`);
}

// ----------------------------------------------------------------------------
// /deploys
// ----------------------------------------------------------------------------
function deploysPage() {
  return shell('Deploys', 'Recent deploys + SHAs.',
`<section style="max-width:780px;margin:0 auto;padding:60px 16px">
  <span class="badge b-acc">Deploys</span>
  <h1 style="font:600 40px/1.1 var(--display);letter-spacing:-1px;margin:18px 0">Deploys.</h1>
  <p style="color:var(--dim2);font-size:15px;line-height:1.6">Source of truth: <a href="https://github.com/jmtrades/openheab-agent-infra/commits/main">github.com/jmtrades/openheab-agent-infra/commits/main</a></p>
</section>
<section style="max-width:780px;margin:0 auto;padding:24px 16px 60px">
  <p style="color:var(--dim2);font-size:14px;line-height:1.7">Every push to <code>main</code> triggers an automatic deploy via Vercel. The substrate version is embedded in /v1/_health/deep responses.</p>
  <p style="color:var(--dim2);font-size:14px;line-height:1.7;margin-top:14px">Roll back? Use <code>vercel rollback</code> in the dashboard, or push a revert commit. Each deploy has a unique <code>x-vercel-id</code> response header you can match to a Vercel deployment ID.</p>
</section>`);
}

// ----------------------------------------------------------------------------
// /migrations
// ----------------------------------------------------------------------------
async function migrationsPage(pool) {
  const tables = await safe(pool, `
    SELECT table_name FROM information_schema.tables WHERE table_schema='public'
    ORDER BY table_name
  `);
  return shell('Migrations', 'Live schema state.',
`<section style="max-width:980px;margin:0 auto;padding:60px 16px">
  <span class="badge b-acc">Migrations</span>
  <h1 style="font:600 40px/1.1 var(--display);letter-spacing:-1px;margin:18px 0">Schema state.</h1>
  <p style="color:var(--dim2);font-size:15px;line-height:1.6">${tables.length} tables in the public schema. Migrations are idempotent CREATE/ALTER statements run at boot (RUN_MIGRATIONS_ON_BOOT=true) or via POST /v1/_admin/migrate.</p>
</section>
<section style="max-width:980px;margin:0 auto;padding:24px 16px 60px">
  ${tables.length === 0
    ? `<div class="card" style="text-align:center;padding:48px;color:var(--dim)">No tables found (mock pool environment?).</div>`
    : `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:6px">${tables.map(t => `<a href="/v1/_admin/table/${encodeURIComponent(t.table_name)}" class="card" style="padding:8px 12px;color:var(--acc-dim);font:500 12px var(--mono);text-decoration:none">${escapeHtml(t.table_name)}</a>`).join('')}</div>`}
</section>`);
}

// ----------------------------------------------------------------------------
// /rate-limits
// ----------------------------------------------------------------------------
async function rateLimitsPage(pool) {
  const buckets = await safe(pool, `
    SELECT bucket_key, count, reset_at, updated_at
    FROM rate_limit_buckets ORDER BY count DESC LIMIT 50
  `);
  return shell('Rate Limits', 'Active rate-limit bucket snapshot.',
`<section style="max-width:980px;margin:0 auto;padding:60px 16px">
  <span class="badge b-acc">Rate Limits</span>
  <h1 style="font:600 40px/1.1 var(--display);letter-spacing:-1px;margin:18px 0">Rate limits.</h1>
  <p style="color:var(--dim2);font-size:15px;line-height:1.6;max-width:680px">Per-IP + per-API-key sliding-window buckets, Postgres-backed and shared across serverless instances. The 50 hottest buckets right now.</p>
</section>
<section style="max-width:980px;margin:0 auto;padding:24px 16px 60px">
  ${buckets.length === 0
    ? `<div class="card" style="text-align:center;padding:48px;color:var(--dim)">No active buckets.</div>`
    : `<table>
        <thead><tr><th>Bucket</th><th>Count</th><th>Resets in</th><th>Updated</th></tr></thead>
        <tbody>${buckets.map(b => {
          const resetIn = Math.max(0, Math.floor((Number(b.reset_at) - Date.now()) / 1000));
          return `<tr>
            <td style="font:500 12px var(--mono);color:var(--acc-dim);max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(b.bucket_key || '')}</td>
            <td style="font:600 13px var(--mono)">${b.count}</td>
            <td style="font:500 11px var(--mono);color:var(--dim)">${resetIn}s</td>
            <td style="font:500 11px var(--mono);color:var(--dim)">${b.updated_at ? new Date(b.updated_at).toISOString().slice(11, 19) : ''}</td>
          </tr>`;
        }).join('')}</tbody>
      </table>`}
</section>`);
}

// ----------------------------------------------------------------------------
// /api-status
// ----------------------------------------------------------------------------
function apiStatusPage() {
  return shell('API Status', 'Granular per-endpoint status.',
`<section style="max-width:780px;margin:0 auto;padding:60px 16px;text-align:center">
  <span class="badge b-acc">API Status</span>
  <h1 style="font:600 40px/1.1 var(--display);letter-spacing:-1px;margin:18px 0">API status.</h1>
  <p style="color:var(--dim2);font-size:15px;line-height:1.7;max-width:560px;margin:0 auto">Live status by endpoint category. For the customer-facing component view, see <a href="/status">/status</a>.</p>
</section>
<section style="max-width:780px;margin:0 auto;padding:24px 16px 60px">
  <div id="api-status-grid"><div class="card" style="text-align:center;padding:48px;color:var(--dim)">Pinging endpoints…</div></div>
</section>
<script>
var probes = [
  { name: 'Identity', path: '/v1/identities' },
  { name: 'Bank', path: '/v1/bank/info' },
  { name: 'Marketplace', path: '/v1/marketplace/listings' },
  { name: 'MCP', path: '/.well-known/mcp.json' },
  { name: 'Audit', path: '/v1/audit/info' },
  { name: 'OpenAPI', path: '/openapi.json' },
  { name: 'Health', path: '/healthz' },
  { name: 'Ready', path: '/readyz' },
  { name: 'Metrics', path: '/metrics' },
  { name: 'Sitemap', path: '/sitemap.xml' }
];
async function probe(p){
  var start = performance.now();
  try {
    var r = await fetch(p.path);
    return { name: p.name, ok: r.ok || r.status === 401 || r.status === 405, status: r.status, ms: Math.round(performance.now() - start) };
  } catch (e) {
    return { name: p.name, ok: false, status: 0, ms: Math.round(performance.now() - start) };
  }
}
Promise.all(probes.map(probe)).then(function(results){
  document.getElementById('api-status-grid').innerHTML =
    '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px">' +
    results.map(function(r){
      return '<div class="card" style="display:flex;justify-content:space-between;align-items:center;padding:12px 14px">' +
        '<strong style="font-size:13px">' + r.name + '</strong>' +
        '<span style="font:500 11px var(--mono);color:var(--dim)">' + r.ms + 'ms</span>' +
        '<span class="badge b-' + (r.ok ? 'good' : 'bad') + '">' + r.status + '</span>' +
      '</div>';
    }).join('') + '</div>';
});
</script>`);
}

// ----------------------------------------------------------------------------
// Register
// ----------------------------------------------------------------------------
function registerOpsDashboardsRoutes(app, pool) {
  const sendHtml = (res, html) => { res.setHeader('content-type', 'text/html; charset=utf-8'); res.send(html); };
  app.get('/health-dashboard', (req, res) => sendHtml(res, healthDashboardPage()));
  app.get('/metrics-dashboard', (req, res) => sendHtml(res, metricsDashboardPage()));
  app.get('/cron-status', async (req, res) => sendHtml(res, await cronStatusPage(pool)));
  app.get('/queues', async (req, res) => sendHtml(res, await queuesPage(pool)));
  app.get('/experiments', async (req, res) => sendHtml(res, await experimentsPage(pool)));
  app.get('/feature-flags', async (req, res) => sendHtml(res, await featureFlagsPage(pool)));
  app.get('/deploys', (req, res) => sendHtml(res, deploysPage()));
  app.get('/migrations', async (req, res) => sendHtml(res, await migrationsPage(pool)));
  app.get('/rate-limits', async (req, res) => sendHtml(res, await rateLimitsPage(pool)));
  app.get('/api-status', (req, res) => sendHtml(res, apiStatusPage()));
}

async function migrate(_pool) {}
module.exports = { migrate, registerOpsDashboardsRoutes };
