// ============================================================================
// Vercel Serverless entrypoint
// ============================================================================
const express = require('express');
require('express-async-errors'); // routes async-rejections to the errorHandler middleware
const { Pool } = require('pg');
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
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('sslmode=require')
      ? { rejectUnauthorized: false }
      : undefined,
    max: 1,
    idleTimeoutMillis: 30000
  });

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
  app.use((req, res, next) => {
    if (req.path === '/v1/_webhooks/stripe') return next();
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
