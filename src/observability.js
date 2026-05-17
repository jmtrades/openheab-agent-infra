// ============================================================================
// Observability — request IDs, structured JSON logs, Prometheus metrics
// ============================================================================
const crypto = require('crypto');

const metrics = {
  request_total: new Map(),
  request_duration_ms_bucket: new Map(),
  in_flight: 0,
  primitive_family_total: new Map()
};

const BUCKETS_MS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];

function incCounter(map, key) { map.set(key, (map.get(key) || 0) + 1); }
function observeDuration(method, ms) {
  for (const b of BUCKETS_MS) {
    if (ms <= b) {
      const k = `${method} le="${b}"`;
      metrics.request_duration_ms_bucket.set(k, (metrics.request_duration_ms_bucket.get(k) || 0) + 1);
    }
  }
  const k = `${method} le="+Inf"`;
  metrics.request_duration_ms_bucket.set(k, (metrics.request_duration_ms_bucket.get(k) || 0) + 1);
}

function familyFromPath(path) {
  if (path.startsWith('/v1/agents/')) {
    const parts = path.split('/').filter(Boolean);
    return parts[3] || 'agents';
  }
  if (path.startsWith('/v1/')) {
    const parts = path.split('/').filter(Boolean);
    return parts[1] || 'v1';
  }
  if (path.startsWith('/.well-known/')) return 'well-known';
  return 'root';
}

function requestId(req, res, next) {
  const incoming = req.headers['x-request-id'];
  req.id = (typeof incoming === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(incoming))
    ? incoming : 'req_' + crypto.randomBytes(10).toString('hex');
  res.setHeader('X-Request-Id', req.id);
  next();
}

function jsonLogger(req, res, next) {
  const start = Date.now();
  metrics.in_flight++;
  const origEnd = res.end.bind(res);
  res.end = function (...args) {
    metrics.in_flight--;
    const ms = Date.now() - start;
    const statusClass = `${Math.floor(res.statusCode / 100)}xx`;
    incCounter(metrics.request_total, `${req.method} ${statusClass}`);
    incCounter(metrics.primitive_family_total, familyFromPath(req.path));
    observeDuration(req.method, ms);
    const isHealth = req.path === '/healthz' || req.path === '/readyz';
    if (!isHealth || res.statusCode >= 400) {
      const line = {
        ts: new Date().toISOString(),
        level: res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info',
        request_id: req.id, method: req.method, path: req.path,
        status: res.statusCode, latency_ms: ms,
        agent_did: req.headers['x-agent-did'] || undefined,
        ua: (req.headers['user-agent'] || '').slice(0, 100) || undefined
      };
      const out = res.statusCode >= 500 ? console.error : console.log;
      out(JSON.stringify(line));
    }
    return origEnd(...args);
  };
  next();
}

function renderPrometheus() {
  const lines = [];
  lines.push('# HELP openheab_request_total Total HTTP requests by method and status class');
  lines.push('# TYPE openheab_request_total counter');
  for (const [k, v] of metrics.request_total.entries()) {
    const [method, statusClass] = k.split(' ');
    lines.push(`openheab_request_total{method="${method}",status="${statusClass}"} ${v}`);
  }
  lines.push('# HELP openheab_request_duration_ms HTTP request latency histogram');
  lines.push('# TYPE openheab_request_duration_ms histogram');
  for (const [k, v] of metrics.request_duration_ms_bucket.entries()) {
    const [method, le] = k.split(' ');
    lines.push(`openheab_request_duration_ms_bucket{method="${method}",${le}} ${v}`);
  }
  lines.push('# HELP openheab_in_flight Currently in-flight requests');
  lines.push('# TYPE openheab_in_flight gauge');
  lines.push(`openheab_in_flight ${metrics.in_flight}`);
  lines.push('# HELP openheab_primitive_family_total Requests per primitive family');
  lines.push('# TYPE openheab_primitive_family_total counter');
  for (const [family, count] of metrics.primitive_family_total.entries()) {
    lines.push(`openheab_primitive_family_total{family="${family}"} ${count}`);
  }
  return lines.join('\n') + '\n';
}

function metricsHandler(req, res) {
  res.setHeader('content-type', 'text/plain; version=0.0.4');
  res.send(renderPrometheus());
}

const PUBLIC_PATH_RE = /^(\/$|\/healthz$|\/readyz$|\/metrics$|\/openapi\.json$|\/sitemap\.xml$|\/robots\.txt$|\/llms\.txt$|\/\.well-known\/|\/v1\/audit\/|\/v1\/bank\/(info|assets)$|\/v1\/analytics\/global$|\/v1\/extensions(\/categories)?$|\/v1\/extensions\/[a-z0-9-]+$|\/v1\/identities$|\/v1\/marketplace\/listings$|\/mcp|\/mcp\/manifest)/;

function corsMiddleware(req, res, next) {
  const origin = req.headers.origin;
  const isPublic = PUBLIC_PATH_RE.test(req.path);
  if (isPublic && origin) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'content-type, authorization, x-agent-did, x-agent-sig, x-idempotency-key');
    res.setHeader('Access-Control-Max-Age', '3600');
    if (req.method === 'OPTIONS') return res.status(204).end();
  }
  next();
}

// Security headers: HSTS, CSP, X-Frame-Options, etc.
// Applied to every response. For HTML routes we set a relaxed CSP that
// allows inline styles + scripts (we ship a lot of inline-styled HTML pages);
// for JSON routes we use a stricter "none" default.
function securityHeaders(req, res, next) {
  // Strict-Transport-Security — 1 year, include subdomains, preload eligible
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
  }
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=(), payment=()');
  res.setHeader('X-DNS-Prefetch-Control', 'off');
  // CSP: relaxed for HTML pages we ship (inline styles + the demo JS); strict for everything else
  const acceptsHtml = (req.headers.accept || '').includes('text/html');
  if (acceptsHtml) {
    res.setHeader('Content-Security-Policy',
      "default-src 'self'; " +
      "style-src 'self' 'unsafe-inline'; " +
      "script-src 'self' 'unsafe-inline'; " +
      "img-src 'self' data: blob: https:; " +
      "font-src 'self' data:; " +
      "connect-src 'self' https://*.openheab.com https://api.stripe.com https://js.stripe.com; " +
      "frame-ancestors 'none'; " +
      "form-action 'self'; " +
      "base-uri 'self'"
    );
  } else {
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
  }
  next();
}

function wantsHtml(req) {
  const a = String(req.headers.accept || '');
  // Treat browsers (which always send text/html in Accept) as HTML clients,
  // but never JSON-by-default API clients.
  return a.includes('text/html');
}

function renderErrorPage(status, title, message, requestId) {
  let ds;
  try { ds = require('./design_system'); } catch { ds = null; }
  if (!ds) {
    // Fallback if design_system not available
    return `<!doctype html><meta charset=utf-8><title>${status}</title><body style="font:14px/1.5 system-ui;background:#08090b;color:#f4f4f5;display:grid;place-items:center;min-height:100vh;margin:0"><div style="text-align:center;padding:24px"><h1 style="font:600 64px/1 ui-monospace,monospace;letter-spacing:-2px;margin:0 0 12px">${status}</h1><p style="color:#a1a1aa;margin:0 0 18px">${message}</p><a href="/" style="color:#7dd3fc">← Home</a></div>`;
  }
  const extraHead = `<style>
.err-shell{min-height:calc(100vh - 160px);display:flex;align-items:center;justify-content:center;padding:48px 0;text-align:center}
.err-card{max-width:520px;animation:rise 500ms var(--ease-out) both}
.err-code{font:600 96px/1 var(--mono);letter-spacing:-4px;background:linear-gradient(180deg,var(--acc),var(--acc-strong));-webkit-background-clip:text;background-clip:text;color:transparent;margin-bottom:12px;font-feature-settings:'tnum'}
.err-title{font-size:26px;letter-spacing:-0.8px;margin-bottom:8px;font-weight:600}
.err-msg{color:var(--fg-dim);margin:0 0 28px;font-size:15.5px;line-height:1.55}
.err-rid{color:var(--fg-dim3);font:500 11.5px/1 var(--mono);margin-top:18px;letter-spacing:0.5px}
.err-btns{display:flex;gap:10px;justify-content:center;flex-wrap:wrap}
</style>`;
  return ds.head(`${status} — OpenHeab`, message, { path: '/', extraHead }) + ds.NAV_HTML() + `<main>
<div class="err-shell">
  <div class="err-card">
    <div class="err-code">${status}</div>
    <h1 class="err-title">${title}</h1>
    <p class="err-msg">${message}</p>
    <div class="err-btns">
      <a href="/" class="btn primary">Home <span class="arr">→</span></a>
      <a href="/docs" class="btn">Read docs</a>
      <a href="/console" class="btn">Browse routes</a>
    </div>
    ${requestId ? `<div class="err-rid">request_id: ${requestId}</div>` : ''}
  </div>
</div>
</main>` + ds.FOOTER_HTML();
}

function notFoundHandler(req, res) {
  if (wantsHtml(req)) {
    res.status(404).setHeader('content-type', 'text/html; charset=utf-8');
    return res.send(renderErrorPage(404,
      'Page not found',
      `We couldn't find <code style="background:rgba(255,255,255,0.06);padding:2px 6px;border-radius:4px;font-family:ui-monospace,monospace;font-size:0.9em">${String(req.path).replace(/[<>&"']/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&#39;'}[c]))}</code> on openheab.com.`,
      req.id));
  }
  res.status(404).json({
    error: 'not_found', method: req.method, path: req.path,
    request_id: req.id,
    hint: 'See /openapi.json or /llms.txt for the route catalog.'
  });
}

// Final error handler — catches body-parser SyntaxError and any uncaught
// async throw. Logs the request_id but never leaks a stack trace to the
// caller. Must be registered AFTER all routes via `app.use(errorHandler)`.
function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);
  const status = err.statusCode || err.status || (err.type === 'entity.parse.failed' ? 400 : 500);
  const code = err.type === 'entity.parse.failed' ? 'invalid_json'
            : err.type === 'entity.too.large' ? 'body_too_large'
            : status >= 500 ? 'internal_error'
            : (err.code || 'request_failed');
  try { console.error(JSON.stringify({ level: 'error', request_id: req.id, code, message: err.message })); } catch {}

  if (wantsHtml(req) && status >= 500) {
    res.status(status).setHeader('content-type', 'text/html; charset=utf-8');
    return res.send(renderErrorPage(status,
      'Something went wrong on our end',
      `An internal error occurred while handling your request. The operator has been notified, and the audit chain logged this incident. Try again, or check the <a href="/status">status page</a>.`,
      req.id));
  }
  res.status(status).json({
    error: code,
    message: status < 500 ? err.message : 'An internal error occurred. The operator has been notified.',
    request_id: req.id
  });
}

function faviconHandler(req, res) {
  res.setHeader('content-type', 'image/svg+xml');
  res.setHeader('cache-control', 'public, max-age=86400');
  res.send(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
<rect width="64" height="64" rx="12" fill="#0a0a0a"/>
<text x="32" y="44" font-family="ui-monospace,Menlo,monospace" font-size="34"
      font-weight="700" fill="#6cf" text-anchor="middle">OH</text>
</svg>`);
}

module.exports = {
  requestId, jsonLogger, corsMiddleware, securityHeaders, metricsHandler,
  notFoundHandler, errorHandler, faviconHandler, metrics, renderPrometheus
};
