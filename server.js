// ============================================================================
// OpenHeab Substrate — local server entrypoint
// ============================================================================
require('dotenv').config();

const express = require('express');
const { Pool } = require('pg');
const { migrateAll, registerAllRoutes } = require('./src/integration');
const { registerStatusPage } = require('./src/status_page');
const { registerPages } = require('./src/landing');
const { registerDiscoveryRoutes } = require('./src/discovery');
const { rateLimit, skipForHealth } = require('./src/rate_limit');
const { requestId, jsonLogger, corsMiddleware, securityHeaders, metricsHandler,
        notFoundHandler, faviconHandler } = require('./src/observability');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('sslmode=require')
    ? { rejectUnauthorized: false } : undefined
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
  const checks = { db: false };
  try { await pool.query('SELECT 1'); checks.db = true; }
  catch (e) { checks.db_error = e.message; }
  res.status(checks.db ? 200 : 503).json({ ready: checks.db, checks });
});

async function start() {
  console.log('[openheab] running migrations...');
  await migrateAll(pool);
  console.log('[openheab] registering routes...');
  registerAllRoutes(app, pool);
  registerPages(app);
  registerStatusPage(app, pool);
  registerDiscoveryRoutes(app);
  app.use(notFoundHandler);

  let cronStopper = null;
  if (process.env.ENABLE_INPROCESS_CRON === 'true') {
    const { startInProcessScheduler } = require('./src/cron_auth');
    const interval = parseInt(process.env.CRON_INTERVAL_MS || '60000');
    cronStopper = startInProcessScheduler({
      intervalMs: interval,
      onError: (e, path) => console.warn(`[cron] ${path} failed: ${e.message}`)
    });
    console.log(`[openheab] in-process cron scheduler firing every ${interval}ms`);
  }

  const port = parseInt(process.env.PORT || '3000');
  const server = app.listen(port, () => {
    console.log(JSON.stringify({ ts: new Date().toISOString(), level: 'info', event: 'listening', port }));
  });

  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    if (cronStopper) cronStopper();
    server.close(() => {});
    setTimeout(async () => {
      try { await pool.end(); } catch {}
      process.exit(0);
    }, 10000).unref();
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

if (require.main === module) {
  start().catch(err => { console.error('[openheab] startup failed:', err); process.exit(1); });
}

module.exports = { app, pool, start };
