// ============================================================================
// notifications_whatsnew_visualizer.js — three more polish surfaces:
//   - /v1/me/notifications (+ /notifications UI)  — in-app notifications
//     for the current agent (KYC approved, payment received, key rotated, ...)
//   - /whatsnew                                    — auto-generated "what
//     shipped recently" page parsed from CHANGELOG.md
//   - /audit/visualize                             — Merkle-style audit chain
//     visualizer with linked nodes (SVG), shows hash linking
// ============================================================================
const crypto = require('crypto');

async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS notifications (
      notification_id TEXT PRIMARY KEY,
      agent_did       TEXT NOT NULL,
      kind            TEXT NOT NULL,
      title           TEXT NOT NULL,
      body            TEXT,
      severity        TEXT NOT NULL DEFAULT 'info',
      action_url      TEXT,
      read_at         TIMESTAMPTZ,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_notifications_agent_unread
      ON notifications (agent_did, read_at NULLS FIRST, created_at DESC);
  `);
}

async function resolveAgent(pool, req) {
  try { return await require('./me_endpoints').resolveAgentFromRequest(pool, req); }
  catch { return null; }
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

// --- Notify helper (callable from other primitives) ---
async function notify(pool, agent_did, { kind, title, body, severity, action_url } = {}) {
  if (!agent_did || !kind || !title) return null;
  const id = 'notif_' + crypto.randomBytes(10).toString('hex');
  await pool.query(
    `INSERT INTO notifications (notification_id, agent_did, kind, title, body, severity, action_url)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [id, agent_did, String(kind).slice(0, 50), String(title).slice(0, 200),
     body ? String(body).slice(0, 2000) : null,
     ['info', 'success', 'warning', 'error'].includes(severity) ? severity : 'info',
     action_url ? String(action_url).slice(0, 500) : null]
  ).catch(() => {});
  return id;
}

function renderNotificationsPage() {
  return `<!doctype html><html><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>Notifications — OpenHeab</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Inter', sans-serif; background: #0a0a0f; color: #e7e7ee; line-height: 1.6; }
.wrap { max-width: 760px; margin: 0 auto; padding: 40px 24px 80px; }
.nav { display: flex; justify-content: space-between; align-items: center; margin-bottom: 32px; padding-bottom: 18px; border-bottom: 1px solid #1a1a25; }
.nav .logo { font-weight: 700; font-size: 18px; color: #fff; text-decoration: none; }
.nav .links a { color: #888; margin-left: 18px; font-size: 13px; text-decoration: none; }
.nav .links a:hover { color: #fff; }
h1 { font-size: 32px; font-weight: 700; letter-spacing: -0.6px; margin-bottom: 6px; display: flex; align-items: center; gap: 12px; }
.unread-badge { background: #ef4444; color: #fff; font-size: 12px; padding: 4px 10px; border-radius: 100px; font-weight: 700; }
.subtitle { color: #888; font-size: 14px; margin-bottom: 24px; }
.auth { background: #14141c; padding: 14px 18px; border-radius: 10px; margin-bottom: 20px; display: flex; gap: 10px; align-items: center; }
.auth input { flex: 1; padding: 8px 12px; background: #0f0f17; border: 1px solid #1f1f2a; color: #fff; border-radius: 6px; font-family: monospace; font-size: 13px; outline: none; }
.auth input:focus { border-color: #4f46e5; }
.auth button { padding: 8px 16px; background: #4f46e5; color: #fff; border: 0; border-radius: 6px; font-weight: 600; cursor: pointer; font-size: 13px; }
.actions { display: flex; gap: 8px; margin-bottom: 16px; }
.actions button { padding: 6px 12px; background: #1a1a25; color: #ccc; border: 1px solid #25253a; border-radius: 6px; cursor: pointer; font-size: 12px; }
.actions button:hover { background: #25253a; color: #fff; }
.notif { background: #14141c; border: 1px solid #1a1a25; border-left: 3px solid #4f46e5; padding: 16px 20px; border-radius: 8px; margin-bottom: 8px; transition: all 0.15s; }
.notif.unread { border-left-color: #818cf8; }
.notif.read { opacity: 0.55; }
.notif.warning { border-left-color: #eab308; }
.notif.error { border-left-color: #ef4444; }
.notif.success { border-left-color: #22c55e; }
.notif-head { display: flex; justify-content: space-between; align-items: center; gap: 10px; margin-bottom: 4px; }
.notif-title { font-weight: 600; font-size: 14px; }
.notif-time { color: #666; font-size: 11px; font-family: monospace; flex-shrink: 0; }
.notif-body { color: #aaa; font-size: 13px; margin-bottom: 6px; line-height: 1.5; }
.notif-meta { display: flex; gap: 12px; align-items: center; font-size: 11px; font-family: monospace; }
.notif-meta .kind { background: #1f1f2a; padding: 2px 8px; border-radius: 4px; color: #888; }
.notif-meta a { color: #818cf8; text-decoration: none; }
.notif-meta a:hover { text-decoration: underline; }
.notif-meta .mark { color: #666; cursor: pointer; margin-left: auto; }
.notif-meta .mark:hover { color: #fff; }
.empty { color: #555; font-size: 14px; padding: 40px; text-align: center; background: #14141c; border-radius: 10px; }
</style></head><body><div class="wrap">

<nav class="nav">
  <a class="logo" href="/">OpenHeab</a>
  <div class="links">
    <a href="/notifications" style="color:#fff">Notifications</a>
    <a href="/dashboard">Dashboard</a>
    <a href="/inspector">Inspector</a>
    <a href="/help">Help</a>
  </div>
</nav>

<h1>Notifications <span id="badge" style="display:none" class="unread-badge"></span></h1>
<p class="subtitle">In-app notifications for your agent — KYC updates, payments, security alerts, all in one place.</p>

<div class="auth">
  <input id="did" placeholder="Your DID (did:op:...) or API key" />
  <button onclick="load()">Open</button>
</div>

<div class="actions" id="actions" style="display:none">
  <button onclick="markAllRead()">Mark all read</button>
  <button onclick="load()">Refresh</button>
</div>

<div id="list"></div>

<script>
let did = '', apikey = '';
const listEl = document.getElementById('list');
const badge = document.getElementById('badge');

function headers() {
  const h = {};
  if (apikey) h.authorization = 'Bearer ' + apikey;
  if (did) h['x-agent-did'] = did;
  return h;
}

async function load() {
  const v = document.getElementById('did').value.trim();
  if (!v) return;
  if (v.startsWith('did:')) { did = v; apikey = ''; }
  else { apikey = v; did = ''; }
  const r = await fetch('/v1/me/notifications', { headers: headers() });
  if (!r.ok) { listEl.innerHTML = '<div class="empty">Auth failed (status ' + r.status + ')</div>'; return; }
  const j = await r.json();
  document.getElementById('actions').style.display = '';
  const unread = (j.notifications || []).filter(n => !n.read_at).length;
  if (unread > 0) { badge.textContent = unread; badge.style.display = ''; } else { badge.style.display = 'none'; }
  if (!j.notifications?.length) {
    listEl.innerHTML = '<div class="empty">No notifications yet. They will appear here when events touch your agent.</div>';
    return;
  }
  listEl.innerHTML = j.notifications.map(n => {
    const time = new Date(n.created_at);
    const ago = Math.floor((Date.now() - time) / 60000);
    const ts = ago < 60 ? ago + 'm ago' : Math.floor(ago / 60) + 'h ago';
    return '<div class="notif ' + (n.read_at ? 'read' : 'unread') + ' ' + escapeHtml(n.severity || 'info') + '">' +
      '<div class="notif-head"><span class="notif-title">' + escapeHtml(n.title) + '</span><span class="notif-time">' + ts + '</span></div>' +
      (n.body ? '<div class="notif-body">' + escapeHtml(n.body) + '</div>' : '') +
      '<div class="notif-meta">' +
        '<span class="kind">' + escapeHtml(n.kind) + '</span>' +
        (n.action_url ? '<a href="' + escapeHtml(n.action_url) + '">View →</a>' : '') +
        (!n.read_at ? '<span class="mark" onclick="markRead(\\'' + n.notification_id + '\\')">Mark read</span>' : '') +
      '</div></div>';
  }).join('');
}

async function markRead(id) {
  await fetch('/v1/me/notifications/' + id + '/read', { method: 'POST', headers: headers() });
  load();
}

async function markAllRead() {
  await fetch('/v1/me/notifications/read-all', { method: 'POST', headers: headers() });
  load();
}

function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }
</script>
</body></html>`;
}

function parseChangelogEntries() {
  const fs = require('fs');
  const path = require('path');
  let body = '';
  for (const p of [
    path.join(process.cwd(), 'CHANGELOG.md'),
    path.resolve(__dirname, '../../CHANGELOG.md'),
    '/var/task/CHANGELOG.md'
  ]) {
    try { body = fs.readFileSync(p, 'utf8'); if (body) break; } catch {}
  }
  if (!body) return [];
  const entries = [];
  const re = /^## \[([^\]]+)\] — (\d{4}-\d{2}-\d{2})/gm;
  let m;
  const headers = [];
  while ((m = re.exec(body)) !== null) {
    headers.push({ version: m[1], date: m[2], index: m.index });
  }
  for (let i = 0; i < headers.length; i++) {
    const start = headers[i].index;
    const end = i + 1 < headers.length ? headers[i + 1].index : body.length;
    entries.push({
      version: headers[i].version,
      date: headers[i].date,
      raw: body.slice(start, end).trim()
    });
  }
  return entries;
}

function renderWhatsNewPage() {
  const entries = parseChangelogEntries();
  return `<!doctype html><html><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>What's New — OpenHeab</title>
<meta name="description" content="Every primitive we shipped recently. Subscribe via RSS to never miss an update.">
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Inter', sans-serif; background: #0a0a0f; color: #e7e7ee; line-height: 1.7; }
.wrap { max-width: 860px; margin: 0 auto; padding: 48px 24px 80px; }
.nav { display: flex; justify-content: space-between; align-items: center; margin-bottom: 40px; }
.nav .logo { font-weight: 700; font-size: 18px; color: #fff; text-decoration: none; }
.nav .links a { color: #888; margin-left: 20px; font-size: 14px; text-decoration: none; }
.nav .links a:hover { color: #fff; }
h1 { font-size: 40px; font-weight: 700; letter-spacing: -1px; margin-bottom: 10px; }
.subtitle { color: #888; font-size: 16px; margin-bottom: 36px; }
.subtitle a { color: #818cf8; }
.entry { background: #14141c; border: 1px solid #1f1f2a; border-radius: 12px; padding: 24px 28px; margin-bottom: 14px; }
.entry-head { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }
.entry-head h2 { font-size: 22px; font-weight: 700; }
.entry-head .ver { background: #4f46e520; color: #818cf8; font-size: 12px; padding: 4px 10px; border-radius: 100px; font-weight: 700; font-family: monospace; }
.entry-head .date { color: #666; font-size: 12px; font-family: monospace; margin-left: auto; }
.entry-body { color: #c5c5d5; font-size: 14px; }
.entry-body h2 { display: none; }
.entry-body h3 { font-size: 14px; color: #818cf8; margin: 16px 0 8px; text-transform: uppercase; letter-spacing: 1px; }
.entry-body ul { padding-left: 22px; margin: 8px 0; }
.entry-body li { padding: 3px 0; font-size: 13px; }
.entry-body p { margin: 8px 0; }
.entry-body code { background: #0f0f17; padding: 2px 6px; border-radius: 4px; font-size: 12px; }
.entry-body strong { color: #fff; }
.subscribe { background: #181822; border: 1px solid #2a2a36; padding: 16px 22px; border-radius: 10px; margin-bottom: 32px; display: flex; justify-content: space-between; align-items: center; gap: 14px; flex-wrap: wrap; }
.subscribe .text { font-size: 14px; color: #c5c5d5; }
.subscribe a { color: #818cf8; }
.footer { color: #555; font-size: 12px; margin-top: 48px; text-align: center; }
</style></head><body><div class="wrap">

<nav class="nav">
  <a class="logo" href="/">OpenHeab</a>
  <div class="links">
    <a href="/whatsnew" style="color:#fff">What's New</a>
    <a href="/changelog">Full changelog</a>
    <a href="/docs">Docs</a>
    <a href="/pricing">Pricing</a>
  </div>
</nav>

<h1>What's New</h1>
<p class="subtitle">Every recent release. Subscribe to <a href="/changelog.rss">RSS</a> or <a href="/changelog.atom">Atom</a> to never miss an update.</p>

<div class="subscribe">
  <div class="text">📡 <b>Subscribe to release notifications</b> — RSS / Atom / email digest.</div>
  <div>
    <a href="/changelog.rss" style="margin-right:12px">RSS</a>
    <a href="/changelog.atom">Atom</a>
  </div>
</div>

${entries.length === 0 ? '<div class="entry"><p>No changelog entries found.</p></div>' :
  entries.slice(0, 10).map(e => {
    // Convert markdown headers + lists to HTML (lightweight)
    let html = e.raw
      .replace(/^## \[[^\]]+\] — \d{4}-\d{2}-\d{2}\s*\n*/, '')  // strip header (already in entry-head)
      .replace(/^### (.+)$/gm, '<h3>$1</h3>')
      .replace(/^- (.+)$/gm, '<li>$1</li>')
      .replace(/(<li>.*<\/li>\s*)+/gs, m => '<ul>' + m + '</ul>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/^\s*\n/gm, '<br>');
    return `<div class="entry">
      <div class="entry-head">
        <h2>v${escapeHtml(e.version)}</h2>
        <span class="ver">${escapeHtml(e.version)}</span>
        <span class="date">${escapeHtml(e.date)}</span>
      </div>
      <div class="entry-body">${html}</div>
    </div>`;
  }).join('')}

<div class="footer">
  Want the full history? <a href="/changelog" style="color:#888">View full changelog</a>
</div>

</div></body></html>`;
}

function renderAuditVisualizerPage(entries) {
  // Render the last N entries as linked chain nodes
  const W = 1100, NODE_W = 220, NODE_H = 70, GAP = 18;
  const cols = Math.floor((W - 40) / (NODE_W + GAP)) || 1;
  const nodes = entries.map((e, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const x = 20 + col * (NODE_W + GAP);
    const y = 60 + row * (NODE_H + 30);
    return { ...e, x, y, idx: i };
  });
  const totalH = 80 + Math.ceil(entries.length / cols) * (NODE_H + 30);

  const nodesSvg = nodes.map(n => {
    let entryObj = {}; try { entryObj = typeof n.entry === 'string' ? JSON.parse(n.entry) : n.entry; } catch {}
    const eventType = escapeHtml((entryObj.event_type || 'event').slice(0, 28));
    const hashShort = escapeHtml((n.hash || '').slice(0, 8));
    return `
      <g transform="translate(${n.x},${n.y})">
        <rect width="${NODE_W}" height="${NODE_H}" rx="6" fill="#14141c" stroke="#1f1f2a"/>
        <text x="12" y="20" fill="#818cf8" font-family="monospace" font-size="11" font-weight="600">#${n.length || '?'}</text>
        <text x="${NODE_W - 12}" y="20" fill="#666" font-family="monospace" font-size="10" text-anchor="end">${hashShort}…</text>
        <text x="12" y="44" fill="#fff" font-family="monospace" font-size="12" font-weight="600">${eventType}</text>
        <text x="12" y="62" fill="#888" font-family="monospace" font-size="10">${escapeHtml(String(n.created_at || '').slice(0, 19).replace('T', ' '))}</text>
      </g>`;
  }).join('');

  // Connect adjacent nodes
  const links = nodes.slice(0, -1).map((n, i) => {
    const next = nodes[i + 1];
    const x1 = n.x + NODE_W;
    const y1 = n.y + NODE_H / 2;
    const x2 = next.x;
    const y2 = next.y + NODE_H / 2;
    if (Math.floor(i / cols) === Math.floor((i + 1) / cols)) {
      // Same row — straight line
      return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#2a2a36" stroke-width="1.5"/>`;
    } else {
      // Wrap — curve down then over
      const midX = n.x + NODE_W / 2;
      const midY = n.y + NODE_H + 15;
      return `<path d="M ${x1} ${y1} L ${n.x + NODE_W + 10} ${y1} L ${n.x + NODE_W + 10} ${midY} L ${next.x - 10} ${midY} L ${next.x - 10} ${y2} L ${x2} ${y2}" fill="none" stroke="#2a2a36" stroke-width="1.5"/>`;
    }
  }).join('');

  return `<!doctype html><html><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>Audit Chain Visualizer — OpenHeab</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Inter', sans-serif; background: #0a0a0f; color: #e7e7ee; }
.wrap { max-width: 1180px; margin: 0 auto; padding: 32px 24px 80px; }
.nav { display: flex; justify-content: space-between; align-items: center; margin-bottom: 28px; padding-bottom: 18px; border-bottom: 1px solid #1a1a25; }
.nav .logo { font-weight: 700; font-size: 18px; color: #fff; text-decoration: none; }
.nav .links a { color: #888; margin-left: 18px; font-size: 13px; text-decoration: none; }
.nav .links a:hover { color: #fff; }
h1 { font-size: 28px; font-weight: 700; letter-spacing: -0.6px; margin-bottom: 6px; }
.subtitle { color: #888; font-size: 14px; margin-bottom: 24px; }
.callout { background: #14141c; border-left: 3px solid #22c55e; padding: 14px 20px; border-radius: 4px; margin-bottom: 24px; font-size: 13px; color: #c5c5d5; }
.callout b { color: #22c55e; }
.svg-wrap { background: #0a0a12; border: 1px solid #1a1a25; border-radius: 10px; padding: 20px; overflow-x: auto; }
.actions { display: flex; gap: 10px; margin-top: 20px; }
.actions a { padding: 10px 18px; background: #1a1a25; color: #ccc; text-decoration: none; border: 1px solid #25253a; border-radius: 6px; font-size: 13px; }
.actions a:hover { background: #25253a; color: #fff; }
.actions a.primary { background: #4f46e5; color: #fff; border-color: transparent; }
</style></head><body><div class="wrap">

<nav class="nav">
  <a class="logo" href="/">OpenHeab</a>
  <div class="links">
    <a href="/audit/visualize" style="color:#fff">Audit Chain</a>
    <a href="/inspector">Inspector</a>
    <a href="/activity">Activity</a>
    <a href="/admin">Admin</a>
  </div>
</nav>

<h1>Audit Chain Visualizer</h1>
<p class="subtitle">The last ${entries.length} entries in the SHA-256 Merkle chain. Each node references the previous hash — tampering invalidates everything downstream.</p>

<div class="callout">
  <b>Integrity:</b> chain integrity is verified at <a href="/v1/audit/verify" style="color:#22c55e">/v1/audit/verify</a>. Every state change in the substrate appends here. Read-only, append-only, signed with Ed25519.
</div>

<div class="svg-wrap">
  <svg width="${W}" height="${totalH}" viewBox="0 0 ${W} ${totalH}" xmlns="http://www.w3.org/2000/svg">
    ${links}
    ${nodesSvg}
  </svg>
</div>

<div class="actions">
  <a class="primary" href="/v1/audit/verify">Verify integrity →</a>
  <a href="/v1/audit/chain?limit=100">Raw JSON feed</a>
  <a href="/activity">Live activity feed</a>
  <a href="/inspector">Real-time SSE inspector</a>
</div>

</div></body></html>`;
}

function registerNotificationsWhatsNewVisualizerRoutes(app, pool, verifyAgentAuth, auditChain) {
  const express = require('express');

  // GET /v1/me/notifications — list (unread first)
  app.get('/v1/me/notifications', async (req, res) => {
    const ctx = await resolveAgent(pool, req);
    if (!ctx) return res.status(401).json({ error: 'unauthenticated' });
    const includeRead = req.query.include_read !== 'false';
    const r = await pool.query(
      `SELECT notification_id, kind, title, body, severity, action_url, read_at, created_at
       FROM notifications WHERE agent_did=$1 ${includeRead ? '' : 'AND read_at IS NULL'}
       ORDER BY read_at NULLS FIRST, created_at DESC LIMIT 100`,
      [ctx.did]
    ).catch(() => ({ rows: [] }));
    res.json({ did: ctx.did, notifications: r.rows, unread_count: r.rows.filter(n => !n.read_at).length });
  });

  // POST /v1/me/notifications/:id/read
  app.post('/v1/me/notifications/:id/read', async (req, res) => {
    const ctx = await resolveAgent(pool, req);
    if (!ctx) return res.status(401).json({ error: 'unauthenticated' });
    await pool.query(
      `UPDATE notifications SET read_at=NOW() WHERE notification_id=$1 AND agent_did=$2 AND read_at IS NULL`,
      [req.params.id, ctx.did]
    ).catch(() => {});
    res.json({ ok: true });
  });

  // POST /v1/me/notifications/read-all
  app.post('/v1/me/notifications/read-all', async (req, res) => {
    const ctx = await resolveAgent(pool, req);
    if (!ctx) return res.status(401).json({ error: 'unauthenticated' });
    const r = await pool.query(
      `UPDATE notifications SET read_at=NOW() WHERE agent_did=$1 AND read_at IS NULL`,
      [ctx.did]
    ).catch(() => ({ rowCount: 0 }));
    res.json({ ok: true, marked_read: r.rowCount || 0 });
  });

  // POST /v1/_internal/notify — create a notification (internal-key gated)
  app.post('/v1/_internal/notify', express.json(), async (req, res) => {
    const tok = process.env.INTERNAL_API_KEY;
    // SECURITY: refuse when no token configured (otherwise undefined === undefined
    // would silently allow anyone). Same foot-gun as the admin endpoints had.
    if (!tok || req.headers['x-internal-api-key'] !== tok) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    const { agent_did, kind, title, body, severity, action_url } = req.body || {};
    const id = await notify(pool, agent_did, { kind, title, body, severity, action_url });
    if (auditChain) auditChain.append({ event_type: 'notification.created', notification_id: id, agent_did, kind }).catch(() => {});
    res.status(201).json({ notification_id: id });
  });

  app.get('/notifications', (req, res) => {
    res.set('content-type', 'text/html; charset=utf-8');
    res.set('cache-control', 'public, max-age=300');
    res.send(renderNotificationsPage());
  });

  // /whatsnew — auto-generated from CHANGELOG.md
  app.get('/whatsnew', (req, res) => {
    res.set('content-type', 'text/html; charset=utf-8');
    res.set('cache-control', 'public, max-age=600');
    res.send(renderWhatsNewPage());
  });

  // /audit/visualize — chain visualization
  app.get('/audit/visualize', async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 40, 200);
    const r = await pool.query(
      `SELECT length, hash, prev_hash, entry, created_at FROM audit_chain ORDER BY length DESC LIMIT $1`,
      [limit]
    ).catch(() => ({ rows: [] }));
    // Reverse so oldest is first (matches chain order)
    const entries = r.rows.reverse();
    res.set('content-type', 'text/html; charset=utf-8');
    res.set('cache-control', 'no-store');
    res.send(renderAuditVisualizerPage(entries));
  });
}

module.exports = {
  migrate, registerNotificationsWhatsNewVisualizerRoutes, notify, parseChangelogEntries
};
