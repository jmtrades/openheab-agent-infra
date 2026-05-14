// ============================================================================
// relay.js — VPS-side bridge between postfix and the substrate
// ============================================================================
const fs = require('fs');
const http = require('http');
const https = require('https');
const crypto = require('crypto');

const DOMAIN = process.env.DOMAIN;
const SUBSTRATE_URL = process.env.SUBSTRATE_URL;
const SUBSTRATE_SECRET = process.env.SUBSTRATE_SECRET;
const RELAY_PORT = parseInt(process.env.RELAY_PORT || '3001');
const OUTBOUND_PORT = parseInt(process.env.OUTBOUND_PORT || '8443');
const LOG_FILE = process.env.LOG_FILE || '/var/log/openheab-gateway.log';

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch {}
}

function parseMime(raw) {
  const splitIdx = raw.indexOf('\r\n\r\n');
  const headerBlock = splitIdx > 0 ? raw.slice(0, splitIdx) : raw;
  const bodyBlock = splitIdx > 0 ? raw.slice(splitIdx + 4) : '';
  const headers = {};
  let lastKey = null;
  for (const line of headerBlock.split(/\r?\n/)) {
    if (/^\s/.test(line) && lastKey) { headers[lastKey] += ' ' + line.trim(); continue; }
    const m = line.match(/^([A-Za-z0-9-]+):\s*(.*)$/);
    if (m) { lastKey = m[1].toLowerCase(); headers[lastKey] = m[2]; }
  }
  const ct = (headers['content-type'] || 'text/plain').toLowerCase();
  let body_text = null, body_html = null;
  if (ct.includes('text/plain')) body_text = bodyBlock;
  else if (ct.includes('text/html')) body_html = bodyBlock;
  else body_text = bodyBlock;
  return {
    from: headers['from'] || '', to: headers['to'] || '',
    cc: headers['cc'] ? headers['cc'].split(',').map(s => s.trim()) : [],
    subject: headers['subject'] || '',
    body_text, body_html, headers,
    raw_size_bytes: Buffer.byteLength(raw)
  };
}

const inboundServer = http.createServer(async (req, res) => {
  if (req.url !== '/inbound' || req.method !== 'POST') return res.writeHead(404).end();
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  const envFrom = req.headers['x-relay-from'] || '';
  const envTo = req.headers['x-relay-to'] || '';

  const parsed = parseMime(raw);
  parsed.from = envFrom || parsed.from;
  parsed.to = envTo || parsed.to;
  parsed.dkim_pass = /dkim=pass/i.test(parsed.headers['authentication-results'] || '');
  parsed.spf_pass = /spf=pass/i.test(parsed.headers['authentication-results'] || '');
  parsed.dmarc_pass = /dmarc=pass/i.test(parsed.headers['authentication-results'] || '');

  const messageId = 'msg_' + crypto.randomBytes(12).toString('hex');
  log('[inbound]', `from=${parsed.from} to=${parsed.to} size=${parsed.raw_size_bytes}`);

  const sig = crypto.createHmac('sha256', SUBSTRATE_SECRET)
    .update(messageId + '\n' + parsed.from + '\n' + parsed.to).digest('hex');

  try {
    const r = await fetch(SUBSTRATE_URL + '/v1/_email/ingest', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-openheab-sig': sig,
        'x-openheab-message-id': messageId
      },
      body: JSON.stringify({ message_id: messageId, ...parsed })
    });
    const text = await r.text();
    log('[inbound]', `substrate status=${r.status}`);
    res.writeHead(r.ok ? 200 : 502).end(text);
  } catch (e) {
    log('[inbound]', `error: ${e.message}`);
    res.writeHead(502).end(JSON.stringify({ error: e.message }));
  }
});

inboundServer.listen(RELAY_PORT, '127.0.0.1', () => {
  log(`[inbound] listening on 127.0.0.1:${RELAY_PORT}`);
});

if (process.env.OUTBOUND_TLS_CERT && process.env.OUTBOUND_TLS_KEY) {
  const outboundServer = https.createServer({
    cert: fs.readFileSync(process.env.OUTBOUND_TLS_CERT),
    key: fs.readFileSync(process.env.OUTBOUND_TLS_KEY)
  }, async (req, res) => {
    if (req.url !== '/relay' || req.method !== 'POST') return res.writeHead(404).end();
    const chunks = [];
    for await (const c of req) chunks.push(c);
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { res.writeHead(400).end('bad_json'); return; }

    const sig = req.headers['x-openheab-sig'];
    const messageId = req.headers['x-openheab-message-id'] || '';
    const expected = crypto.createHmac('sha256', SUBSTRATE_SECRET)
      .update(messageId + '\n' + body.from + '\n' + body.to).digest('hex');
    let valid = false;
    try { valid = crypto.timingSafeEqual(Buffer.from(sig || ''), Buffer.from(expected)); } catch {}
    if (!valid) return res.writeHead(401).end('invalid_signature');

    log('[outbound]', `from=${body.from} to=${body.to}`);
    // Real SMTP delivery would go here. For now, log and accept.
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ accepted: true, message_id: messageId }));
  });

  outboundServer.listen(OUTBOUND_PORT, '0.0.0.0', () => {
    log(`[outbound] listening on 0.0.0.0:${OUTBOUND_PORT} (TLS)`);
  });
}
