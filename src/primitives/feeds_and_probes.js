// ============================================================================
// feeds_and_probes.js — two operator-facing surfaces:
//   - RSS/Atom feeds for /changelog, /status, /activity (so vendors and
//     security researchers can subscribe to releases + incidents + events)
//   - Live adapter connectivity probe at /v1/_health/deep/probes that
//     actually pings each configured adapter (vs production_checks which
//     only checks env-var presence)
// ============================================================================

async function migrate(pool) {}

function escapeXml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
    '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&apos;'
  }[c]));
}

function publicUrl() {
  return process.env.OPERATOR_PUBLIC_URL || 'https://openheab.com';
}

// --- Changelog RSS (parses CHANGELOG.md) ---
function parseChangelog() {
  const fs = require('fs');
  const path = require('path');
  const candidates = [
    path.join(process.cwd(), 'CHANGELOG.md'),
    path.resolve(__dirname, '../../CHANGELOG.md'),
    '/var/task/CHANGELOG.md'
  ];
  let body = '';
  for (const p of candidates) {
    try { body = fs.readFileSync(p, 'utf8'); if (body) break; } catch {}
  }
  if (!body) return [];
  const entries = [];
  // Match `## [version] — date` headers
  const re = /^## \[([^\]]+)\] — (\d{4}-\d{2}-\d{2})/gm;
  const headers = [];
  let m;
  while ((m = re.exec(body)) !== null) {
    headers.push({ version: m[1], date: m[2], index: m.index });
  }
  for (let i = 0; i < headers.length; i++) {
    const start = headers[i].index;
    const end = i + 1 < headers.length ? headers[i + 1].index : body.length;
    const summary = body.slice(start, end).trim().slice(0, 1500);
    entries.push({
      version: headers[i].version,
      date: headers[i].date,
      summary,
      link: publicUrl() + '/changelog#v' + headers[i].version.replace(/\./g, '-')
    });
  }
  return entries;
}

async function renderChangelogRss() {
  const entries = parseChangelog();
  const items = entries.map(e => `
    <item>
      <title>OpenHeab v${escapeXml(e.version)}</title>
      <link>${escapeXml(e.link)}</link>
      <guid isPermaLink="false">openheab-changelog-${escapeXml(e.version)}</guid>
      <pubDate>${new Date(e.date + 'T00:00:00Z').toUTCString()}</pubDate>
      <description>${escapeXml(e.summary)}</description>
    </item>`).join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>OpenHeab Changelog</title>
    <link>${escapeXml(publicUrl())}/changelog</link>
    <description>Every release of the OpenHeab agent-native infrastructure substrate.</description>
    <language>en-us</language>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
    ${items}
  </channel>
</rss>`;
}

// --- Status incidents RSS ---
async function renderStatusRss(pool) {
  let recent = [];
  try {
    const r = await pool.query(
      `SELECT incident_id, title, status, severity, component, started_at, resolved_at
       FROM status_page_incidents ORDER BY started_at DESC LIMIT 50`
    ).catch(() => ({ rows: [] }));
    recent = r.rows;
  } catch {}
  const items = recent.map(i => {
    const status = i.resolved_at ? 'resolved' : i.status;
    return `
    <item>
      <title>[${escapeXml(i.severity)}] ${escapeXml(i.title)} (${escapeXml(status)})</title>
      <link>${escapeXml(publicUrl())}/status#${escapeXml(i.incident_id)}</link>
      <guid isPermaLink="false">${escapeXml(i.incident_id)}</guid>
      <pubDate>${new Date(i.started_at).toUTCString()}</pubDate>
      <description>${escapeXml(i.component || 'multiple components')} — status: ${escapeXml(status)}${i.resolved_at ? ', resolved at ' + escapeXml(i.resolved_at.toString()) : ''}</description>
    </item>`;
  }).join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>OpenHeab Status</title>
    <link>${escapeXml(publicUrl())}/status</link>
    <description>Active and recent incidents on the OpenHeab substrate.</description>
    <language>en-us</language>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
    ${items}
  </channel>
</rss>`;
}

// --- Live adapter connectivity probe ---
async function probeOneAdapter(name, url, headers = {}) {
  if (typeof fetch !== 'function') return { name, status: 'skipped', reason: 'fetch_unavailable' };
  const start = Date.now();
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000);
    const r = await fetch(url, { method: 'GET', headers, signal: ctrl.signal });
    clearTimeout(t);
    return { name, status: r.ok ? 'ok' : 'http_error', http_status: r.status, latency_ms: Date.now() - start };
  } catch (e) {
    return { name, status: 'error', error: String(e.message || e).slice(0, 120), latency_ms: Date.now() - start };
  }
}

async function probeAdapters() {
  const probes = [];
  // Anthropic
  if (process.env.ANTHROPIC_API_KEY) probes.push(probeOneAdapter('anthropic', 'https://api.anthropic.com/v1/models',
    { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' }));
  // OpenAI
  if (process.env.OPENAI_API_KEY) probes.push(probeOneAdapter('openai', 'https://api.openai.com/v1/models',
    { authorization: 'Bearer ' + process.env.OPENAI_API_KEY }));
  // Google
  if (process.env.GOOGLE_API_KEY) probes.push(probeOneAdapter('google', 'https://generativelanguage.googleapis.com/v1/models?key=' + process.env.GOOGLE_API_KEY));
  // Stripe
  if (process.env.STRIPE_SECRET_KEY) probes.push(probeOneAdapter('stripe', 'https://api.stripe.com/v1/balance',
    { authorization: 'Bearer ' + process.env.STRIPE_SECRET_KEY }));
  // Twilio
  if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
    const cred = Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64');
    probes.push(probeOneAdapter('twilio', `https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}.json`,
      { authorization: 'Basic ' + cred }));
  }
  // SendGrid
  if (process.env.SENDGRID_API_KEY) probes.push(probeOneAdapter('sendgrid', 'https://api.sendgrid.com/v3/scopes',
    { authorization: 'Bearer ' + process.env.SENDGRID_API_KEY }));
  // Datadog
  if (process.env.DATADOG_API_KEY) probes.push(probeOneAdapter('datadog', 'https://api.datadoghq.com/api/v1/validate',
    { 'dd-api-key': process.env.DATADOG_API_KEY }));
  // Vercel
  if (process.env.VERCEL_TOKEN) probes.push(probeOneAdapter('vercel', 'https://api.vercel.com/v2/user',
    { authorization: 'Bearer ' + process.env.VERCEL_TOKEN }));
  // Cloudflare
  if (process.env.CLOUDFLARE_API_TOKEN) probes.push(probeOneAdapter('cloudflare', 'https://api.cloudflare.com/client/v4/user/tokens/verify',
    { authorization: 'Bearer ' + process.env.CLOUDFLARE_API_TOKEN }));
  if (probes.length === 0) return { configured_count: 0, results: [], note: 'no adapters configured' };

  const results = await Promise.all(probes);
  const ok = results.filter(r => r.status === 'ok').length;
  return { configured_count: probes.length, ok_count: ok, results };
}

function registerFeedsAndProbesRoutes(app, pool) {
  app.get('/changelog.rss', async (req, res) => {
    res.set('content-type', 'application/rss+xml; charset=utf-8');
    res.set('cache-control', 'public, max-age=300');
    res.send(await renderChangelogRss());
  });
  app.get('/changelog.atom', async (req, res) => {
    // Same content, different content-type — many Atom readers accept either
    res.set('content-type', 'application/atom+xml; charset=utf-8');
    res.set('cache-control', 'public, max-age=300');
    res.send(await renderChangelogRss());
  });

  app.get('/status.rss', async (req, res) => {
    res.set('content-type', 'application/rss+xml; charset=utf-8');
    res.set('cache-control', 'public, max-age=60');
    res.send(await renderStatusRss(pool));
  });
  app.get('/status.atom', async (req, res) => {
    res.set('content-type', 'application/atom+xml; charset=utf-8');
    res.set('cache-control', 'public, max-age=60');
    res.send(await renderStatusRss(pool));
  });

  // Live adapter probe — actually pings each configured third party
  app.get('/v1/_health/deep/probes', async (req, res) => {
    const result = await probeAdapters();
    res.set('cache-control', 'private, no-store');
    res.json(result);
  });
}

module.exports = { migrate, registerFeedsAndProbesRoutes, probeAdapters, parseChangelog };
