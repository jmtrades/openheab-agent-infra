// ============================================================================
// Vercel Serverless entrypoint
// ============================================================================
const express = require('express');
require('express-async-errors'); // routes async-rejections to the errorHandler middleware
const { Pool } = require('pg');

// Process-level safety nets. Vercel restarts the lambda on uncaught exception
// anyway, but logging makes the root cause discoverable in their dashboard.
process.on('unhandledRejection', (reason, p) => {
  console.error('[unhandledRejection]', reason instanceof Error ? reason.stack : reason);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err.stack || err.message);
});
const { migrateAll, registerAllRoutes } = require('../src/integration');
const { registerStatusPage } = require('../src/status_page');
const { registerPages } = require('../src/landing');
const { registerDiscoveryRoutes } = require('../src/discovery');
const { rateLimit, skipForHealth } = require('../src/rate_limit');
const { requestId, jsonLogger, corsMiddleware, securityHeaders, metricsHandler,
        notFoundHandler, errorHandler, faviconHandler } = require('../src/observability');

let cachedHandler = null;
let cachedPromise = null;

async function buildHandler() {
  const dbUrl = process.env.DATABASE_URL || '';
  // Production-grade SSL: verify the cert chain. Neon/Supabase/AWS RDS all
  // present valid certs — only disable verification if the caller explicitly
  // opts out (PG_INSECURE_TLS=true), which we never want in prod.
  const wantSsl = dbUrl.includes('sslmode=require') || dbUrl.includes('sslmode=verify');
  const sslConfig = wantSsl
    ? { rejectUnauthorized: process.env.PG_INSECURE_TLS !== 'true' }
    : undefined;
  const pool = new Pool({
    connectionString: dbUrl,
    ssl: sslConfig,
    max: 1,
    idleTimeoutMillis: 30000,
    // Cap each query at 30s so a stuck query can't eat the whole 60s function timeout.
    statement_timeout: 30_000,
    // Don't hang forever on initial connection — fail fast if Neon is down.
    connectionTimeoutMillis: 8_000,
    // Application name shows up in pg_stat_activity for easier debugging.
    application_name: 'openheab-vercel',
  });
  // Surface errors so a poisoned pool doesn't silently rot. The boot retry
  // logic in module.exports will recreate the handler next request.
  pool.on('error', (e) => console.error('[pg:pool]', e.message));

  const app = express();
  app.disable('x-powered-by');
  app.use(requestId);
  app.use(jsonLogger);
  app.use(corsMiddleware);
  app.use(securityHeaders);
  app.get('/favicon.ico', faviconHandler);
  app.get('/favicon.svg', faviconHandler);
  app.get('/metrics', metricsHandler);
  app.use(rateLimit({ windowMs: 60_000, max: parseInt(process.env.RATE_LIMIT_PER_MIN || '600'), skip: skipForHealth }));
  // Webhook routes that need the raw request body for signature verification
  // must be excluded from the global JSON parser — once express.json sets
  // req.body, stripe.webhooks.constructEvent + HMAC checks can't read the bytes.
  const RAW_BODY_ROUTES = new Set([
    '/v1/_webhooks/stripe',
    '/v1/_webhooks/stripe-checkout',
    '/v1/_webhooks/stripe-subscription',
    '/v1/_webhooks/stripe-issuing',
    '/v1/_webhooks/stripe-issuing-capture',
    '/v1/_webhooks/stripe-real',
    '/v1/_webhooks/github',
    '/v1/_webhooks/slack-real',
    '/v1/_webhooks/alchemy',
    '/v1/_webhooks/payout-provider',
  ]);
  app.use((req, res, next) => {
    if (RAW_BODY_ROUTES.has(req.path)) return next();
    if (req.path.startsWith('/v1/_webhooks/workflow/')) return next();
    express.json({ limit: '4mb' })(req, res, next);
  });

  app.get('/healthz', (req, res) => res.json({ ok: true, ts: new Date().toISOString() }));
  app.get('/readyz', async (req, res) => {
    try { await pool.query('SELECT 1'); res.json({ ready: true }); }
    catch (e) { res.status(503).json({ ready: false, error: e.message }); }
  });

  if (process.env.RUN_MIGRATIONS_ON_BOOT === 'true') {
    await migrateAll(pool);
  }

  registerAllRoutes(app, pool);
  registerPages(app);
  registerStatusPage(app, pool);
  registerDiscoveryRoutes(app);
  app.use(notFoundHandler);
  app.use(errorHandler);

  app.post('/v1/_admin/migrate', express.json(), async (req, res) => {
    if (req.headers['x-admin-token'] !== process.env.OPERATOR_ADMIN_TOKEN) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    try { await migrateAll(pool); res.json({ migrated: true }); }
    catch (e) { console.error('[admin.migrate]', e); res.status(500).json({ error: e.message }); }
  });

  return app;
}

module.exports = async (req, res) => {
  try {
    if (!cachedHandler) {
      if (!cachedPromise) cachedPromise = buildHandler();
      try {
        cachedHandler = await cachedPromise;
      } catch (e) {
        cachedPromise = null;
        throw e;
      }
    }
    return cachedHandler(req, res);
  } catch (e) {
    console.error('[boot]', e);
    res.status(500).json({ error: 'boot_failed', message: e.message });
  }
};
