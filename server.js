// ============================================================================
// OpenHeab Substrate — local server entrypoint
// ============================================================================
require('dotenv').config();

const express = require('express');
require('express-async-errors'); // routes async-rejections to the errorHandler middleware
const { Pool } = require('pg');

process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason instanceof Error ? reason.stack : reason);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err.stack || err.message);
});
const { migrateAll, registerAllRoutes } = require('./src/integration');
const { registerStatusPage } = require('./src/status_page');
const { registerPages } = require('./src/landing');
const { registerDiscoveryRoutes } = require('./src/discovery');
const { rateLimit, skipForHealth } = require('./src/rate_limit');
const { requestId, jsonLogger, corsMiddleware, securityHeaders, metricsHandler,
        notFoundHandler, errorHandler, faviconHandler } = require('./src/observability');

const dbUrl = process.env.DATABASE_URL || '';
const wantSsl = dbUrl.includes('sslmode=require') || dbUrl.includes('sslmode=verify');
const pool = new Pool({
  connectionString: dbUrl,
  ssl: wantSsl ? { rejectUnauthorized: process.env.PG_INSECURE_TLS !== 'true' } : undefined,
  statement_timeout: 30_000,
  connectionTimeoutMillis: 8_000,
  application_name: 'openheab-local',
});
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
  app.use(errorHandler);

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
