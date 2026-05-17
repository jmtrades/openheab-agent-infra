// ============================================================================
// activity_feed.js — `/activity` live-updating HTML showing recent substrate
// events pulled from audit_chain (signups, payments, inference, judgments,
// demos, KYC, etc). Polished design, auto-refreshes every 10s. The "alive"
// signal a visitor sees before signing up.
// ============================================================================

async function migrate(pool) {}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

async function gatherActivity(pool, limit = 50) {
  const r = await pool.query(
    `SELECT length, hash, prev_hash, entry, created_at FROM audit_chain ORDER BY length DESC LIMIT $1`,
    [limit]
  ).catch(() => ({ rows: [] }));

  // Aggregate stats for header
  const stats = await pool.query(`
    SELECT
      (SELECT COUNT(*)::int FROM audit_chain WHERE created_at > NOW() - INTERVAL '1 hour') AS events_1h,
      (SELECT COUNT(*)::int FROM audit_chain WHERE created_at > NOW() - INTERVAL '24 hours') AS events_24h,
      (SELECT COUNT(*)::int FROM audit_chain) AS events_total
  `).catch(() => ({ rows: [{ events_1h: 0, events_24h: 0, events_total: 0 }] }));

  return { events: r.rows, stats: stats.rows[0] };
}

function eventEmoji(eventType) {
  const s = String(eventType || '').toLowerCase();
  if (s.includes('signup') || s.includes('created')) return 'NEW';
  if (s.includes('payment') || s.includes('transfer')) return 'PAY';
  if (s.includes('kyc')) return 'KYC';
  if (s.includes('inference') || s.includes('llm')) return 'LLM';
  if (s.includes('judge') || s.includes('rlaf')) return 'RLF';
  if (s.includes('demo')) return 'DMO';
  if (s.includes('webhook')) return 'WHK';
  if (s.includes('deploy')) return 'DPL';
  if (s.includes('card')) return 'CRD';
  return 'EVT';
}

function timeAgo(timestamp) {
  const diff = Date.now() - new Date(timestamp).getTime();
  if (diff < 60_000) return Math.floor(diff / 1000) + 's ago';
  if (diff < 3_600_000) return Math.floor(diff / 60_000) + 'm ago';
  if (diff < 86_400_000) return Math.floor(diff / 3_600_000) + 'h ago';
  return Math.floor(diff / 86_400_000) + 'd ago';
}

const { head: dsHead, NAV_HTML, FOOTER_HTML } = require('../design_system');

function renderActivityHtml(data) {
  const rows = data.events.map(e => {
    let entry = {};
    try { entry = typeof e.entry === 'string' ? JSON.parse(e.entry) : (e.entry || {}); } catch { entry = {}; }
    const eventType = entry.event_type || 'unknown';
    const tag = eventEmoji(eventType);
    const detail = Object.entries(entry)
      .filter(([k]) => k !== 'event_type' && k !== 'nonce')
      .slice(0, 4)
      .map(([k, v]) => `<span class="kv"><b>${escapeHtml(k)}</b>:${escapeHtml(String(v).slice(0, 40))}</span>`)
      .join(' ');
    return `<div class="event">
      <span class="tag">${escapeHtml(tag)}</span>
      <div class="event-body">
        <div class="event-head"><span class="event-type">${escapeHtml(eventType)}</span><span class="event-time">${escapeHtml(timeAgo(e.created_at))}</span></div>
        <div class="event-detail">${detail}</div>
      </div>
      <span class="event-len">#${e.length}</span>
    </div>`;
  }).join('');

  const extraHead = `<meta http-equiv="refresh" content="10"/><style>
.act-hero{padding:40px 0 22px;display:flex;justify-content:space-between;align-items:flex-end;flex-wrap:wrap;gap:18px;border-bottom:1px solid var(--br);margin-bottom:24px}
.act-hero h1{font-size:32px;letter-spacing:-1px;font-weight:600;margin:0}
.act-hero .sub{color:var(--fg-dim);font-size:13px;margin-top:6px}
.act-stats{display:flex;gap:24px}
.act-stat{text-align:right}
.act-stat .v{font:600 22px/1 var(--mono);letter-spacing:-1px;font-feature-settings:'tnum'}
.act-stat .l{font:500 10.5px/1 var(--mono);color:var(--fg-dim2);text-transform:uppercase;letter-spacing:1.4px;margin-top:6px}
.empty-card{background:var(--bg-elev);border:1px solid var(--br);padding:40px;border-radius:12px;text-align:center;color:var(--fg-dim);font-size:14px}
.event{display:flex;align-items:center;gap:12px;background:var(--bg-elev);border:1px solid var(--br);padding:13px 18px;border-radius:9px;margin-bottom:6px;transition:border-color var(--t-fast) var(--ease-out),background-color var(--t-fast) var(--ease-out)}
.event:hover{border-color:var(--br-strong);background:var(--bg-elev2)}
.tag{font:600 10px/1 var(--mono);padding:4px 8px;background:var(--bg);color:var(--acc);border-radius:4px;letter-spacing:0.6px;border:1px solid var(--br)}
.event-body{flex:1;min-width:0}
.event-head{display:flex;justify-content:space-between;gap:12px;margin-bottom:3px}
.event-type{font:500 13px/1 var(--mono);color:var(--fg)}
.event-time{font-size:12px;color:var(--fg-dim2);flex-shrink:0}
.event-detail{font:500 11.5px/1.45 var(--mono);color:var(--fg-dim2);word-break:break-all}
.kv{margin-right:14px}
.kv b{color:var(--fg-dim);font-weight:500}
.event-len{font:500 11px/1 var(--mono);color:var(--fg-dim3);flex-shrink:0}
</style>`;
  return dsHead('Activity — OpenHeab', 'Live activity feed from the OpenHeab substrate. Every audit-chained event in chronological order.', { path: '/activity', extraHead })
    + NAV_HTML('activity') + `<main>
<div class="act-hero">
  <div>
    <h1>Activity</h1>
    <div class="sub"><span class="pill" style="margin:0;padding:3px 8px;font-size:11px"><span class="live"></span> Live</span> &nbsp;refreshes every 10s · ${data.events.length} most recent events</div>
  </div>
  <div class="act-stats">
    <div class="act-stat"><div class="v">${data.stats?.events_1h || 0}</div><div class="l">Last hour</div></div>
    <div class="act-stat"><div class="v">${data.stats?.events_24h || 0}</div><div class="l">Last 24h</div></div>
    <div class="act-stat"><div class="v">${data.stats?.events_total || 0}</div><div class="l">All time</div></div>
  </div>
</div>

${data.events.length === 0
  ? '<div class="empty-card">No activity yet. Visit <a href="/demo">/demo</a> to generate a real event.</div>'
  : rows}

<div style="color:var(--fg-dim2);font-size:12px;margin-top:32px;text-align:center">
  Every event is cryptographically chained · <a href="/v1/audit/chain">JSON feed</a> · <a href="/v1/audit/verify">Verify integrity</a> · <a href="/launch">Operator dashboard</a>
</div>
</main>` + FOOTER_HTML();
}

function registerActivityFeedRoutes(app, pool) {
  app.get('/activity', async (req, res) => {
    try {
      const data = await gatherActivity(pool, 100);
      res.set('content-type', 'text/html; charset=utf-8');
      res.set('cache-control', 'no-store');
      res.send(renderActivityHtml(data));
    } catch (e) {
      res.status(500).set('content-type', 'text/html').send('<h1>Activity feed unavailable</h1><pre>' + String(e.message).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') + '</pre>');
    }
  });

  // Machine-readable variant
  app.get('/activity.json', async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    try {
      const data = await gatherActivity(pool, limit);
      res.json(data);
    } catch (e) {
      res.status(500).json({ error: 'activity_failed', message: e.message });
    }
  });
}

module.exports = { migrate, registerActivityFeedRoutes, gatherActivity };
