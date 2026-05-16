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

function renderActivityHtml(data) {
  const rows = data.events.map(e => {
    let entry = {};
    try { entry = typeof e.entry === 'string' ? JSON.parse(e.entry) : (e.entry || {}); } catch { entry = {}; }
    const eventType = entry.event_type || 'unknown';
    const tag = eventEmoji(eventType);
    // XSS guard: every value from audit_chain (DB-stored, agent-controlled) escaped before HTML
    const detail = Object.entries(entry)
      .filter(([k]) => k !== 'event_type' && k !== 'nonce')
      .slice(0, 4)
      .map(([k, v]) => `<span class="kv"><b>${escapeHtml(k)}</b>:${escapeHtml(String(v).slice(0, 40))}</span>`)
      .join(' ');
    return `
      <div class="event">
        <span class="tag">${escapeHtml(tag)}</span>
        <div class="event-body">
          <div class="event-head"><span class="event-type">${escapeHtml(eventType)}</span><span class="event-time">${escapeHtml(timeAgo(e.created_at))}</span></div>
          <div class="event-detail">${detail}</div>
        </div>
        <span class="event-len">#${e.length}</span>
      </div>`;
  }).join('');

  return `<!doctype html><html><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>Activity — OpenHeab</title>
<meta http-equiv="refresh" content="10"/>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Inter', sans-serif; background: #0a0a0f; color: #e7e7ee; line-height: 1.6; }
.wrap { max-width: 1000px; margin: 0 auto; padding: 40px 24px 80px; }
.header { display: flex; justify-content: space-between; align-items: flex-end; margin-bottom: 32px; }
h1 { font-size: 32px; font-weight: 700; letter-spacing: -0.6px; }
.live-dot { display: inline-block; width: 8px; height: 8px; background: #22c55e; border-radius: 50%; margin-right: 8px; animation: pulse 2s infinite; }
@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
.stats { display: flex; gap: 24px; }
.stat { text-align: right; }
.stat .v { font-size: 22px; font-weight: 700; }
.stat .l { font-size: 11px; color: #888; text-transform: uppercase; letter-spacing: 0.5px; margin-top: 2px; }
.empty { background: #14141c; border: 1px solid #1f1f2a; padding: 40px; border-radius: 12px; text-align: center; color: #888; }
.event { display: flex; align-items: center; gap: 12px; background: #14141c; border: 1px solid #1a1a25; padding: 14px 18px; border-radius: 8px; margin-bottom: 6px; transition: border-color 0.15s; }
.event:hover { border-color: #2a2a3a; }
.tag { font-size: 10px; font-weight: 700; padding: 4px 8px; background: #1f1f2a; color: #818cf8; border-radius: 4px; letter-spacing: 0.5px; font-family: monospace; }
.event-body { flex: 1; min-width: 0; }
.event-head { display: flex; justify-content: space-between; gap: 12px; margin-bottom: 3px; }
.event-type { font-family: 'SF Mono', monospace; font-size: 13px; font-weight: 500; color: #fff; }
.event-time { font-size: 12px; color: #666; flex-shrink: 0; }
.event-detail { font-family: 'SF Mono', monospace; font-size: 11px; color: #888; word-break: break-all; }
.kv { margin-right: 14px; }
.kv b { color: #aaa; font-weight: 500; }
.event-len { font-family: monospace; font-size: 11px; color: #444; flex-shrink: 0; }
.footer { color: #555; font-size: 12px; margin-top: 32px; text-align: center; }
.footer a { color: #888; margin: 0 8px; }
</style></head><body>
<div class="wrap">

<div class="header">
  <div>
    <h1>Activity</h1>
    <div style="color:#888;font-size:13px;margin-top:4px"><span class="live-dot"></span>Live · refreshes every 10s · ${data.events.length} most recent events</div>
  </div>
  <div class="stats">
    <div class="stat"><div class="v">${data.stats?.events_1h || 0}</div><div class="l">Last hour</div></div>
    <div class="stat"><div class="v">${data.stats?.events_24h || 0}</div><div class="l">Last 24h</div></div>
    <div class="stat"><div class="v">${data.stats?.events_total || 0}</div><div class="l">All time</div></div>
  </div>
</div>

${data.events.length === 0
  ? '<div class="empty">No activity yet. Visit <a href="/demo" style="color:#818cf8">/demo</a> to generate a real event!</div>'
  : rows}

<div class="footer">
  Every event is cryptographically chained · <a href="/v1/audit/chain">JSON feed</a> · <a href="/v1/audit/verify">Verify integrity</a> · <a href="/launch">Operator dashboard</a>
</div>

</div></body></html>`;
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
