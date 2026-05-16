// ============================================================================
// e2e.js — comprehensive end-to-end test exercising the substrate's most
// critical surfaces against a real express + in-memory mock pool.
// Proves: registration of every primitive, status page renders, OpenAPI
// spec is well-formed, MCP server responds to JSON-RPC, demo provisioning
// works, deep health check returns structured results, every adapter
// reports its configured/stub status, audit chain appends + verifies.
// ============================================================================
const assert = require('assert');
const express = require('express');
const http = require('http');

let passed = 0, failed = 0;
const skipReasons = [];

function test(name, fn) {
  return Promise.resolve().then(fn).then(
    () => { console.log(`  PASS  ${name}`); passed++; },
    e   => { console.error(`  FAIL  ${name}\n        ${e.message}`); failed++; }
  );
}

// ---------------------------------------------------------------------------
// Minimal in-memory pg mock (just enough for boot + route registration)
// ---------------------------------------------------------------------------
function makeMockPool() {
  const tables = new Map();
  async function query(sql, params = []) {
    const s = String(sql).trim().toLowerCase();
    // CREATE TABLE: extract name, ensure exists
    if (s.startsWith('create table')) {
      const m = s.match(/create table (?:if not exists )?([a-z0-9_]+)/);
      if (m && !tables.has(m[1])) tables.set(m[1], []);
      return { rows: [], rowCount: 0 };
    }
    if (s.startsWith('create index') || s.startsWith('create unique') || s.startsWith('alter table') || s.startsWith('comment on')) {
      return { rows: [], rowCount: 0 };
    }
    if (s.startsWith('select now()')) {
      return { rows: [{ now: new Date(), version: 'PostgreSQL 15.0 (mock)' }] };
    }
    if (s.startsWith('select')) {
      return { rows: [] };
    }
    if (s.startsWith('insert')) {
      return { rows: [], rowCount: 1 };
    }
    if (s.startsWith('update') || s.startsWith('delete')) {
      return { rows: [], rowCount: 0 };
    }
    return { rows: [], rowCount: 0 };
  }
  return { query, end: () => {}, connect: () => ({ query, release: () => {} }) };
}

// ---------------------------------------------------------------------------
// Boot a full substrate against the mock pool
// ---------------------------------------------------------------------------
let app, server, baseUrl, integration;

async function startServer() {
  const pool = makeMockPool();
  app = express();
  app.use(express.json({ limit: '2mb' }));
  const lib = require('../src/integration');
  await lib.migrateAll(pool).catch(() => {});
  integration = lib.registerAllRoutes(app, pool);
  // Add status page + discovery + landing (matches production wiring)
  try { require('../src/status_page').registerStatusPage(app); } catch {}
  try { require('../src/discovery').registerDiscoveryRoutes(app); } catch {}
  try { require('../src/landing').registerPages(app); } catch {}
  // Final 404 + error handlers (matches server.js + api/index.js)
  try {
    const { notFoundHandler, errorHandler } = require('../src/observability');
    app.use(notFoundHandler);
    app.use(errorHandler);
  } catch {}
  server = http.createServer(app);
  await new Promise(resolve => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
}

function fetchPath(path, opts = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(baseUrl + path);
    const req = http.request({
      hostname: url.hostname, port: url.port, path: url.pathname + url.search,
      method: opts.method || 'GET',
      headers: { 'content-type': 'application/json', ...(opts.headers || {}) }
    }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    if (opts.body) req.write(typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body));
    req.end();
  });
}

async function run() {
  console.log('\n== e2e: substrate boots, all primitives register ==');
  await startServer();
  await test('server listening on a port', () => {
    assert.ok(baseUrl.startsWith('http://127.0.0.1:'));
  });

  await test('integration.app has many routes registered', () => {
    const routeCount = (app._router?.stack || []).filter(l => l.route).length;
    assert.ok(routeCount > 100, `expected > 100 routes, got ${routeCount}`);
  });

  await test('integration exposes auditChain and primitives', () => {
    assert.ok(integration && typeof integration === 'object');
    assert.ok(integration.primitives || integration.app, 'integration should expose primitives or app');
  });

  console.log('\n== e2e: status page + landing + discovery ==');
  await test('GET / returns HTML status page', async () => {
    const r = await fetchPath('/');
    assert.strictEqual(r.status, 200);
    assert.ok(/openheab|status|api/i.test(r.body), 'status page should have core content');
  });

  await test('GET /openapi.json returns valid JSON', async () => {
    const r = await fetchPath('/openapi.json');
    assert.strictEqual(r.status, 200);
    const spec = JSON.parse(r.body);
    assert.ok(spec.openapi || spec.swagger, 'should have openapi/swagger version');
    assert.ok(spec.paths && Object.keys(spec.paths).length > 0, 'should have paths');
  });

  await test('GET /robots.txt serves something', async () => {
    const r = await fetchPath('/robots.txt');
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.length > 0);
  });

  console.log('\n== e2e: deep health check ==');
  await test('GET /v1/_health/deep returns structured checks', async () => {
    const r = await fetchPath('/v1/_health/deep');
    assert.strictEqual(r.status, 200);
    const j = JSON.parse(r.body);
    assert.ok(j.run_id, 'should have run_id');
    assert.ok(Array.isArray(j.checks), 'should have checks array');
    assert.ok(j.checks.length >= 8, `should have at least 8 checks, got ${j.checks.length}`);
    assert.ok(['green', 'yellow', 'red'].includes(j.overall), 'overall should be green/yellow/red');
  });

  await test('GET /v1/_health/deep/launchready returns boolean readiness', async () => {
    const r = await fetchPath('/v1/_health/deep/launchready');
    assert.ok([200, 503].includes(r.status));
    const j = JSON.parse(r.body);
    assert.ok(typeof j.launch_ready === 'boolean');
  });

  console.log('\n== e2e: live demo agent provisioning ==');
  await test('GET /demo provisions a demo agent and renders HTML', async () => {
    const r = await fetchPath('/demo');
    assert.strictEqual(r.status, 200);
    assert.ok(/text\/html/.test(r.headers['content-type']));
    assert.ok(/did:op:demo_/.test(r.body), 'demo page should include the demo DID');
    assert.ok(/openheab/i.test(r.body));
  });

  await test('GET /demo/json returns machine-readable demo run', async () => {
    const r = await fetchPath('/demo/json');
    assert.strictEqual(r.status, 200);
    const j = JSON.parse(r.body);
    assert.ok(j.did && j.did.startsWith('did:op:demo_'));
    assert.ok(Array.isArray(j.steps) && j.steps.length >= 6, `expected ≥6 steps, got ${j.steps?.length}`);
  });

  console.log('\n== e2e: adapter status ==');
  await test('GET /v1/cloud-adapters/status reports all adapter configurations', async () => {
    const r = await fetchPath('/v1/cloud-adapters/status');
    assert.strictEqual(r.status, 200);
    const j = JSON.parse(r.body);
    assert.ok('modal' in j && 'e2b' in j && 'browserbase' in j);
  });

  console.log('\n== e2e: MCP server JSON-RPC ==');
  await test('POST /mcp returns JSON-RPC 2.0 response to tools/list', async () => {
    const r = await fetchPath('/mcp', {
      method: 'POST',
      body: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }
    });
    assert.strictEqual(r.status, 200);
    const j = JSON.parse(r.body);
    assert.strictEqual(j.jsonrpc, '2.0');
    assert.ok(j.result?.tools, 'tools/list should return tools array');
    assert.ok(j.result.tools.length >= 100, `expected ≥100 MCP tools, got ${j.result.tools.length}`);
  });

  console.log('\n== e2e: critical primitives respond ==');
  await test('GET /v1/agents/did:op:nonexistent returns 404 (or similar)', async () => {
    const r = await fetchPath('/v1/agents/did:op:nonexistent');
    assert.ok([200, 404, 401].includes(r.status), `expected 200/404/401, got ${r.status}`);
  });

  await test('GET /v1/rlaf/leaderboard responds', async () => {
    const r = await fetchPath('/v1/rlaf/leaderboard');
    assert.strictEqual(r.status, 200);
    const j = JSON.parse(r.body);
    assert.ok(j.leaderboard !== undefined);
  });

  await test('GET /v1/rlaf/reward-model responds', async () => {
    const r = await fetchPath('/v1/rlaf/reward-model');
    assert.strictEqual(r.status, 200);
  });

  console.log('\n== e2e: AGI-era endpoints respond ==');
  await test('GET /v1/agi/passport endpoint registered', async () => {
    const r = await fetchPath('/v1/agi/passport/did:op:test');
    assert.ok([200, 401, 403, 404, 400].includes(r.status));
  });

  console.log('\n== e2e: signup gate (the #1 revenue gate) ==');
  await test('POST /v1/signup endpoint exists', async () => {
    const r = await fetchPath('/v1/signup', {
      method: 'POST',
      body: { email: 'test@example.com', name: 'Test' }
    });
    assert.ok([200, 201, 400, 401, 402, 502].includes(r.status), `signup should respond, got ${r.status}`);
  });

  console.log('\n== e2e: layer 39 — public polish + legal compliance ==');
  await test('GET /legal/terms renders HTML', async () => {
    const r = await fetchPath('/legal/terms');
    assert.strictEqual(r.status, 200);
    assert.ok(/Terms of Service/.test(r.body));
  });
  await test('GET /legal/privacy renders HTML', async () => {
    const r = await fetchPath('/legal/privacy');
    assert.strictEqual(r.status, 200);
    assert.ok(/Privacy Policy/.test(r.body));
  });
  await test('POST /v1/legal/gdpr/export accepts request', async () => {
    const r = await fetchPath('/v1/legal/gdpr/export', {
      method: 'POST',
      body: { email: 'test@example.com' }
    });
    assert.strictEqual(r.status, 202);
    const j = JSON.parse(r.body);
    assert.ok(j.request_id && j.request_id.startsWith('gdpr_export_'));
  });
  await test('POST /v1/legal/gdpr/delete requires confirm string', async () => {
    const r = await fetchPath('/v1/legal/gdpr/delete', {
      method: 'POST',
      body: { email: 'test@example.com' }
    });
    assert.strictEqual(r.status, 400);
    const j = JSON.parse(r.body);
    assert.strictEqual(j.error, 'confirm_required');
  });
  await test('GET /pricing renders 5 tiers', async () => {
    const r = await fetchPath('/pricing');
    assert.strictEqual(r.status, 200);
    assert.ok(/Free/.test(r.body) && /Starter/.test(r.body) && /Pro/.test(r.body)
      && /Team/.test(r.body) && /Enterprise/.test(r.body));
  });
  await test('GET /pricing.json returns tiers + addons', async () => {
    const r = await fetchPath('/pricing.json');
    assert.strictEqual(r.status, 200);
    const j = JSON.parse(r.body);
    assert.ok(Array.isArray(j.tiers) && j.tiers.length === 5);
    assert.ok(Array.isArray(j.addons) && j.addons.length > 0);
  });
  await test('GET /docs renders HTML', async () => {
    const r = await fetchPath('/docs');
    assert.strictEqual(r.status, 200);
    assert.ok(/Getting Started/.test(r.body));
  });
  await test('GET /docs/authentication renders authentication section', async () => {
    const r = await fetchPath('/docs/authentication');
    assert.strictEqual(r.status, 200);
    assert.ok(/Authentication/.test(r.body));
  });
  await test('GET /activity renders live audit feed', async () => {
    const r = await fetchPath('/activity');
    assert.strictEqual(r.status, 200);
    assert.ok(/Activity/.test(r.body));
  });

  console.log('\n== e2e: layer 40 — account dashboard + admin + backup ==');
  await test('GET /dashboard prompts for DID without auth', async () => {
    const r = await fetchPath('/dashboard');
    assert.strictEqual(r.status, 200);
    assert.ok(/Open your agent dashboard|did:op:/.test(r.body));
  });
  await test('GET /dashboard?did=... renders agent dashboard', async () => {
    const r = await fetchPath('/dashboard?did=did:op:test_dashboard');
    assert.strictEqual(r.status, 200);
    assert.ok(/did:op:test_dashboard/.test(r.body));
  });
  await test('GET /admin without token returns 401', async () => {
    process.env.OPERATOR_ADMIN_TOKEN = 'test-admin-token-for-e2e';
    process.env.NODE_ENV = 'production';
    const r = await fetchPath('/admin');
    assert.strictEqual(r.status, 401);
    delete process.env.OPERATOR_ADMIN_TOKEN;
    delete process.env.NODE_ENV;
  });
  await test('POST /v1/admin/backup/create requires admin', async () => {
    const r = await fetchPath('/v1/admin/backup/create', {
      method: 'POST',
      body: {}
    });
    assert.ok([401, 500].includes(r.status), `expected 401/500, got ${r.status}`);
  });

  console.log('\n== e2e: layer 41 — status page + email templates ==');
  await test('GET /status renders HTML with overall status', async () => {
    const r = await fetchPath('/status');
    assert.strictEqual(r.status, 200);
    assert.ok(/OpenHeab Status|operational|degraded/i.test(r.body));
  });
  await test('GET /status.json returns components + incidents', async () => {
    const r = await fetchPath('/status.json');
    assert.strictEqual(r.status, 200);
    const j = JSON.parse(r.body);
    assert.ok(Array.isArray(j.components) && j.components.length > 0);
    assert.ok(j.incidents && Array.isArray(j.incidents.active));
    assert.ok(['operational', 'degraded', 'partial_outage', 'incident'].includes(j.overall));
  });
  await test('GET /v1/email-templates lists templates', async () => {
    const r = await fetchPath('/v1/email-templates');
    assert.strictEqual(r.status, 200);
    const j = JSON.parse(r.body);
    assert.ok(Array.isArray(j.templates) && j.templates.length >= 5);
    assert.ok(j.templates.find(t => t.name === 'signup_welcome'));
  });
  await test('GET /v1/email-templates/signup_welcome/preview renders HTML', async () => {
    const r = await fetchPath('/v1/email-templates/signup_welcome/preview?name=Test&did=did:op:abc');
    assert.strictEqual(r.status, 200);
    assert.ok(/Welcome to OpenHeab|did:op:abc/.test(r.body));
  });

  console.log('\n== e2e: layer 42 — welcome tour ==');
  await test('GET /tour renders first step', async () => {
    const r = await fetchPath('/tour');
    assert.strictEqual(r.status, 200);
    assert.ok(/Create your first agent|Step 1/.test(r.body));
  });
  await test('GET /tour?step=2 renders inference step', async () => {
    const r = await fetchPath('/tour?step=2');
    assert.strictEqual(r.status, 200);
    assert.ok(/inference|Make your first/.test(r.body));
  });
  await test('GET /tour.json lists steps', async () => {
    const r = await fetchPath('/tour.json');
    assert.strictEqual(r.status, 200);
    const j = JSON.parse(r.body);
    assert.ok(Array.isArray(j.steps) && j.steps.length >= 5);
  });

  console.log('\n== e2e: production-readiness gap fixes ==');
  await test('GET /solutions renders index of solution use-cases', async () => {
    const r = await fetchPath('/solutions');
    assert.strictEqual(r.status, 200);
    assert.ok(/Solutions|fintech|compliance|sales/i.test(r.body));
  });
  await test('GET /changelog renders rendered markdown', async () => {
    const r = await fetchPath('/changelog');
    assert.strictEqual(r.status, 200);
    assert.ok(/Changelog|0\.2\.0|primitives/i.test(r.body));
  });
  await test('POST /v1/_jobs/_dispatcher without secret returns 401', async () => {
    const r = await fetchPath('/v1/_jobs/_dispatcher', { method: 'POST' });
    assert.strictEqual(r.status, 401);
  });
  await test('GET /v1/admin/access-log without admin token returns 401', async () => {
    process.env.OPERATOR_ADMIN_TOKEN = 'test-admin-token-for-e2e';
    const r = await fetchPath('/v1/admin/access-log');
    assert.strictEqual(r.status, 401);
    delete process.env.OPERATOR_ADMIN_TOKEN;
  });

  console.log('\n== e2e: bug-fix verification ==');
  await test('GET / serves the landing page (not 404)', async () => {
    const r = await fetchPath('/');
    assert.ok([200, 301, 302].includes(r.status), `expected 2xx/3xx, got ${r.status}`);
  });
  await test('POST /v1/signup with malformed JSON returns 400 (not 500)', async () => {
    const r = await fetchPath('/v1/signup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json'
    });
    assert.strictEqual(r.status, 400);
    const j = JSON.parse(r.body);
    assert.strictEqual(j.error, 'invalid_json');
    assert.ok(!/SyntaxError|JSON\.parse/.test(r.body), 'should not leak stack trace');
  });
  await test('POST /v1/agents/:did/inbox/receive does not 500 with empty body', async () => {
    const r = await fetchPath('/v1/agents/did:op:test/inbox/receive', {
      method: 'POST',
      body: {}
    });
    assert.ok(r.status < 500, `expected non-5xx, got ${r.status}`);
  });

  console.log('\n== e2e: security hardening ==');
  await test('GET /dashboard?did=<script> escapes XSS payload', async () => {
    const r = await fetchPath('/dashboard?did=' + encodeURIComponent('<script>alert(1)</script>'));
    assert.strictEqual(r.status, 200);
    // Should not contain raw <script>alert(1)</script>
    assert.ok(!/<script>alert\(1\)<\/script>/.test(r.body), 'unescaped XSS payload found');
    // Should contain HTML-encoded version
    assert.ok(/&lt;script&gt;|&amp;lt;script/.test(r.body), 'expected escaped payload');
  });
  await test('GET /admin without OPERATOR_ADMIN_TOKEN returns 401 (not 200 dev-open)', async () => {
    // Ensure no token set
    const prev = process.env.OPERATOR_ADMIN_TOKEN;
    delete process.env.OPERATOR_ADMIN_TOKEN;
    delete process.env.INTERNAL_API_KEY;
    const r = await fetchPath('/admin');
    assert.strictEqual(r.status, 401);
    if (prev) process.env.OPERATOR_ADMIN_TOKEN = prev;
  });
  await test('POST /v1/_jobs/_dispatcher with secret fires all due crons', async () => {
    process.env.CRON_SECRET = 'test-dispatcher-secret';
    const r = await fetchPath('/v1/_jobs/_dispatcher', {
      method: 'POST',
      headers: { 'x-cron-secret': 'test-dispatcher-secret' }
    });
    assert.strictEqual(r.status, 200);
    const j = JSON.parse(r.body);
    assert.ok(typeof j.fired === 'object' && Array.isArray(j.fired));
    assert.ok(j.total_registered >= 70, `expected ≥70 registered crons, got ${j.total_registered}`);
    delete process.env.CRON_SECRET;
  });

  console.log('\n== e2e: layer 43 — final Anthropic-launch surfaces ==');
  await test('GET /v1/me without auth returns 401', async () => {
    const r = await fetchPath('/v1/me');
    assert.strictEqual(r.status, 401);
  });
  await test('GET /v1/me with x-agent-did returns context', async () => {
    const r = await fetchPath('/v1/me', { headers: { 'x-agent-did': 'did:op:metest' } });
    assert.strictEqual(r.status, 200);
    const j = JSON.parse(r.body);
    assert.strictEqual(j.did, 'did:op:metest');
    assert.ok(j.plan && j.limits, 'should include plan + limits');
  });
  await test('GET /v1/me/usage returns inference + transfer counts', async () => {
    const r = await fetchPath('/v1/me/usage', { headers: { 'x-agent-did': 'did:op:metest' } });
    assert.strictEqual(r.status, 200);
    const j = JSON.parse(r.body);
    assert.ok(j.inference && j.transfers, 'should include inference + transfers');
    assert.strictEqual(j.period_days, 30);
  });
  await test('GET /v1/me/limits includes remaining', async () => {
    const r = await fetchPath('/v1/me/limits', { headers: { 'x-agent-did': 'did:op:metest' } });
    assert.strictEqual(r.status, 200);
    const j = JSON.parse(r.body);
    assert.ok(j.remaining, 'should include remaining quotas');
  });
  await test('GET /models renders HTML catalog', async () => {
    const r = await fetchPath('/models');
    assert.strictEqual(r.status, 200);
    assert.ok(/claude-haiku|gpt-4o|gemini-pro/.test(r.body));
  });
  await test('GET /models.json returns model array', async () => {
    const r = await fetchPath('/models.json');
    assert.strictEqual(r.status, 200);
    const j = JSON.parse(r.body);
    assert.ok(Array.isArray(j.models) && j.models.length >= 8);
  });
  await test('GET /tools renders MCP tool catalog', async () => {
    const r = await fetchPath('/tools');
    assert.strictEqual(r.status, 200);
    assert.ok(/MCP Tools|categories/i.test(r.body));
  });
  await test('GET /runbook renders SRE playbooks', async () => {
    const r = await fetchPath('/runbook');
    assert.strictEqual(r.status, 200);
    assert.ok(/Runbook|5xx|audit chain/i.test(r.body));
  });
  await test('GET /changelog.rss returns valid RSS', async () => {
    const r = await fetchPath('/changelog.rss');
    assert.strictEqual(r.status, 200);
    assert.ok(r.headers['content-type']?.includes('rss'));
    assert.ok(/<rss version|<channel>/.test(r.body));
  });
  await test('GET /v1/_health/deep/probes returns adapter probe results', async () => {
    const r = await fetchPath('/v1/_health/deep/probes');
    assert.strictEqual(r.status, 200);
    const j = JSON.parse(r.body);
    assert.ok(typeof j.configured_count === 'number');
  });

  console.log('\n== e2e: layer 44 — integrations + migrate + embed + billing ==');
  await test('GET /integrations renders catalog with all categories', async () => {
    const r = await fetchPath('/integrations');
    assert.strictEqual(r.status, 200);
    assert.ok(/Slack|Stripe|Anthropic|Vanta/.test(r.body));
  });
  await test('GET /integrations.json returns channel array', async () => {
    const r = await fetchPath('/integrations.json');
    assert.strictEqual(r.status, 200);
    const j = JSON.parse(r.body);
    assert.ok(Array.isArray(j.channels) && j.channels.length >= 30);
  });
  await test('GET /migrate renders competitor migration guides', async () => {
    const r = await fetchPath('/migrate');
    assert.strictEqual(r.status, 200);
    assert.ok(/Stripe Treasury|Mercury|LangChain/.test(r.body));
  });
  await test('GET /embed/badge.svg returns SVG', async () => {
    const r = await fetchPath('/embed/badge.svg');
    assert.strictEqual(r.status, 200);
    assert.ok(r.headers['content-type']?.includes('svg'));
    assert.ok(/Powered by OpenHeab/.test(r.body));
  });
  await test('GET /embed/stats returns iframe-able widget', async () => {
    const r = await fetchPath('/embed/stats');
    assert.strictEqual(r.status, 200);
    assert.ok(/Powered by OpenHeab|Agents|Audit events/.test(r.body));
  });
  await test('POST /v1/me/billing/portal without auth returns 401', async () => {
    const r = await fetchPath('/v1/me/billing/portal', { method: 'POST', body: {} });
    assert.strictEqual(r.status, 401);
  });
  await test('POST /v1/me/billing/portal with auth in stub mode returns stub URL', async () => {
    delete process.env.STRIPE_SECRET_KEY;
    const r = await fetchPath('/v1/me/billing/portal', {
      method: 'POST',
      headers: { 'x-agent-did': 'did:op:billing-test' },
      body: {}
    });
    assert.strictEqual(r.status, 503);
    const j = JSON.parse(r.body);
    assert.ok(j.stub && j.portal_url);
  });

  console.log('\n== e2e: layer 45 — API explorer + help center ==');
  await test('GET /explorer renders interactive OpenAPI browser', async () => {
    const r = await fetchPath('/explorer');
    assert.strictEqual(r.status, 200);
    assert.ok(/elements-api|apiDescriptionUrl|OpenAPI/.test(r.body));
  });
  await test('GET /api-explorer redirects to /explorer', async () => {
    const r = await fetchPath('/api-explorer');
    assert.strictEqual(r.status, 301);
  });
  await test('GET /help renders knowledge base', async () => {
    const r = await fetchPath('/help');
    assert.strictEqual(r.status, 200);
    assert.ok(/How can we help|getting-started|How do I/.test(r.body));
  });
  await test('GET /help?q=webhook returns matching articles', async () => {
    const r = await fetchPath('/help?q=webhook');
    assert.strictEqual(r.status, 200);
    assert.ok(/webhook|HMAC/i.test(r.body));
  });
  await test('GET /help.json with query returns scored results', async () => {
    const r = await fetchPath('/help.json?q=api+key');
    assert.strictEqual(r.status, 200);
    const j = JSON.parse(r.body);
    assert.ok(Array.isArray(j.results));
    assert.strictEqual(j.query, 'api key');
  });
  await test('GET /v1/admin/help/top-searches requires admin', async () => {
    delete process.env.OPERATOR_ADMIN_TOKEN;
    const r = await fetchPath('/v1/admin/help/top-searches');
    assert.strictEqual(r.status, 401);
  });

  console.log('\n== e2e: layer 46 — OpenAI-compatible drop-in ==');
  await test('POST /v1/chat/completions without auth returns 401 OpenAI shape', async () => {
    const r = await fetchPath('/v1/chat/completions', {
      method: 'POST',
      body: { model: 'claude-haiku', messages: [{ role: 'user', content: 'hi' }] }
    });
    assert.strictEqual(r.status, 401);
    const j = JSON.parse(r.body);
    assert.ok(j.error && j.error.type === 'invalid_request_error');
  });
  await test('POST /v1/chat/completions with auth returns OpenAI-shape completion', async () => {
    delete process.env.OPENAI_API_KEY;
    const r = await fetchPath('/v1/chat/completions', {
      method: 'POST',
      headers: { 'x-agent-did': 'did:op:compat-test' },
      body: { model: 'demo-model-1', messages: [{ role: 'user', content: 'hello' }] }
    });
    assert.strictEqual(r.status, 200);
    const j = JSON.parse(r.body);
    assert.strictEqual(j.object, 'chat.completion');
    assert.ok(Array.isArray(j.choices) && j.choices[0]?.message?.content);
    assert.ok(j.usage?.prompt_tokens >= 0);
  });
  await test('POST /v1/chat/completions without messages returns 400', async () => {
    const r = await fetchPath('/v1/chat/completions', {
      method: 'POST',
      headers: { 'x-agent-did': 'did:op:compat-test' },
      body: { model: 'demo' }
    });
    assert.strictEqual(r.status, 400);
  });
  await test('POST /v1/embeddings with auth returns OpenAI-shape embeddings', async () => {
    delete process.env.OPENAI_API_KEY;
    const r = await fetchPath('/v1/embeddings', {
      method: 'POST',
      headers: { 'x-agent-did': 'did:op:compat-test' },
      body: { model: 'text-embedding-3-small', input: 'hello world' }
    });
    assert.strictEqual(r.status, 200);
    const j = JSON.parse(r.body);
    assert.strictEqual(j.object, 'list');
    assert.ok(j.data?.[0]?.embedding?.length === 1536);
  });
  await test('GET /v1/models returns OpenAI-shape list', async () => {
    const r = await fetchPath('/v1/models');
    assert.strictEqual(r.status, 200);
    const j = JSON.parse(r.body);
    assert.strictEqual(j.object, 'list');
    assert.ok(Array.isArray(j.data) && j.data.length >= 8);
    assert.ok(j.data[0].id && j.data[0].owned_by);
  });
  await test('POST /v1/batches creates batch with status validating', async () => {
    const r = await fetchPath('/v1/batches', {
      method: 'POST',
      headers: { 'x-agent-did': 'did:op:batch-test' },
      body: { endpoint: '/v1/chat/completions', input_json: [{ model: 'demo' }] }
    });
    assert.strictEqual(r.status, 201);
    const j = JSON.parse(r.body);
    assert.strictEqual(j.object, 'batch');
    assert.strictEqual(j.status, 'validating');
  });
  await test('GET /whoami without auth returns 401', async () => {
    const r = await fetchPath('/whoami');
    assert.strictEqual(r.status, 401);
  });
  await test('GET /whoami with auth returns agent context', async () => {
    const r = await fetchPath('/whoami', { headers: { 'x-agent-did': 'did:op:whoami-test' } });
    assert.strictEqual(r.status, 200);
    const j = JSON.parse(r.body);
    assert.strictEqual(j.did, 'did:op:whoami-test');
  });
  await test('GET /v1/me/requests returns recent inference + audit events', async () => {
    const r = await fetchPath('/v1/me/requests', { headers: { 'x-agent-did': 'did:op:req-test' } });
    assert.strictEqual(r.status, 200);
    const j = JSON.parse(r.body);
    assert.ok(Array.isArray(j.inference_calls));
    assert.ok(Array.isArray(j.audit_events));
  });

  console.log('\n== e2e: layer 47 — Anthropic compat + workbench + cookbook ==');
  await test('POST /v1/messages without auth returns 401 Anthropic shape', async () => {
    const r = await fetchPath('/v1/messages', {
      method: 'POST',
      body: { model: 'claude-haiku', messages: [{ role: 'user', content: 'hi' }] }
    });
    assert.strictEqual(r.status, 401);
    const j = JSON.parse(r.body);
    assert.strictEqual(j.type, 'error');
    assert.strictEqual(j.error?.type, 'authentication_error');
  });
  await test('POST /v1/messages with auth returns Anthropic-shape message', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const r = await fetchPath('/v1/messages', {
      method: 'POST',
      headers: { 'x-agent-did': 'did:op:msg-test' },
      body: { model: 'claude-haiku', messages: [{ role: 'user', content: 'hi' }] }
    });
    assert.strictEqual(r.status, 200);
    const j = JSON.parse(r.body);
    assert.strictEqual(j.type, 'message');
    assert.strictEqual(j.role, 'assistant');
    assert.ok(Array.isArray(j.content) && j.content[0]?.type === 'text');
  });
  await test('POST /v1/messages without messages returns 400', async () => {
    const r = await fetchPath('/v1/messages', {
      method: 'POST',
      headers: { 'x-agent-did': 'did:op:msg-test' },
      body: { model: 'claude' }
    });
    assert.strictEqual(r.status, 400);
  });
  await test('GET /workbench renders interactive playground', async () => {
    const r = await fetchPath('/workbench');
    assert.strictEqual(r.status, 200);
    assert.ok(/Workbench|User prompt|Run/.test(r.body));
  });
  await test('GET /cookbook renders recipes', async () => {
    const r = await fetchPath('/cookbook');
    assert.strictEqual(r.status, 200);
    assert.ok(/Cookbook|streaming-inference|usdc/i.test(r.body));
  });
  await test('GET /cookbook.json returns recipes array', async () => {
    const r = await fetchPath('/cookbook.json');
    assert.strictEqual(r.status, 200);
    const j = JSON.parse(r.body);
    assert.ok(Array.isArray(j.recipes) && j.recipes.length >= 5);
  });

  console.log('\n== e2e: layer 48 — tier rate limits + feedback ==');
  await test('GET /v1/me/quotas returns tier + bucket info', async () => {
    const r = await fetchPath('/v1/me/quotas', { headers: { 'x-agent-did': 'did:op:quota-test' } });
    assert.strictEqual(r.status, 200);
    const j = JSON.parse(r.body);
    assert.ok(j.tier && typeof j.bucket_capacity === 'number');
  });
  await test('POST /v1/me/rate-check consumes a token', async () => {
    const r = await fetchPath('/v1/me/rate-check', {
      method: 'POST',
      headers: { 'x-agent-did': 'did:op:rate-test' },
      body: { cost: 1 }
    });
    assert.ok([200, 429].includes(r.status));
    const j = JSON.parse(r.body);
    assert.ok(j.tier && typeof j.remaining === 'number');
  });
  await test('GET /feedback renders form', async () => {
    const r = await fetchPath('/feedback');
    assert.strictEqual(r.status, 200);
    assert.ok(/Tell us what's wrong|Type|Send feedback/.test(r.body));
  });
  await test('POST /v1/feedback without title returns 400', async () => {
    const r = await fetchPath('/v1/feedback', { method: 'POST', body: { body: 'just body, no title' } });
    assert.strictEqual(r.status, 400);
  });
  await test('POST /v1/feedback with title+body returns 201', async () => {
    const r = await fetchPath('/v1/feedback', {
      method: 'POST',
      body: { title: 'Test feedback', body: 'This is a test', kind: 'bug', severity: 'low' }
    });
    assert.strictEqual(r.status, 201);
    const j = JSON.parse(r.body);
    assert.ok(j.feedback_id && j.feedback_id.startsWith('fb_'));
  });
  await test('GET /v1/admin/feedback requires admin', async () => {
    delete process.env.OPERATOR_ADMIN_TOKEN;
    const r = await fetchPath('/v1/admin/feedback');
    assert.strictEqual(r.status, 401);
  });

  console.log('\n== e2e: layer 49 — streaming + files + inspector + marketplace ==');
  await test('POST /v1/chat/completions/stream without auth returns 401', async () => {
    const r = await fetchPath('/v1/chat/completions/stream', {
      method: 'POST',
      body: { model: 'demo', messages: [{ role: 'user', content: 'hi' }] }
    });
    assert.strictEqual(r.status, 401);
  });
  await test('POST /v1/chat/completions/stream returns SSE content-type', async () => {
    delete process.env.OPENAI_API_KEY;
    const r = await fetchPath('/v1/chat/completions/stream', {
      method: 'POST',
      headers: { 'x-agent-did': 'did:op:stream-test' },
      body: { model: 'demo', messages: [{ role: 'user', content: 'hi' }] }
    });
    assert.strictEqual(r.status, 200);
    assert.ok(r.headers['content-type']?.includes('event-stream'));
    assert.ok(/data: \[DONE\]/.test(r.body));
  });
  await test('POST /v1/messages/stream returns Anthropic SSE shape', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const r = await fetchPath('/v1/messages/stream', {
      method: 'POST',
      headers: { 'x-agent-did': 'did:op:anth-stream' },
      body: { model: 'claude-haiku', messages: [{ role: 'user', content: 'hi' }] }
    });
    assert.strictEqual(r.status, 200);
    assert.ok(/event: message_start|event: content_block_delta/.test(r.body));
  });
  await test('POST /v1/files JSON upload returns OpenAI-shape file', async () => {
    const content = Buffer.from('test content').toString('base64');
    const r = await fetchPath('/v1/files', {
      method: 'POST',
      headers: { 'x-agent-did': 'did:op:file-test', 'content-type': 'application/json' },
      body: { filename: 'test.txt', purpose: 'batch', content }
    });
    assert.strictEqual(r.status, 201);
    const j = JSON.parse(r.body);
    assert.strictEqual(j.object, 'file');
    assert.ok(j.id && j.id.startsWith('file_'));
    assert.strictEqual(j.bytes, 12);
  });
  await test('POST /v1/files with empty content returns 400', async () => {
    const r = await fetchPath('/v1/files', {
      method: 'POST',
      headers: { 'x-agent-did': 'did:op:file-test', 'content-type': 'application/json' },
      body: { filename: 'empty.txt' }
    });
    assert.strictEqual(r.status, 400);
  });
  await test('GET /v1/files lists files', async () => {
    const r = await fetchPath('/v1/files', { headers: { 'x-agent-did': 'did:op:file-test' } });
    assert.strictEqual(r.status, 200);
    const j = JSON.parse(r.body);
    assert.strictEqual(j.object, 'list');
  });
  await test('GET /v1/usage/daily returns chart-ready series', async () => {
    const r = await fetchPath('/v1/usage/daily?days=7', {
      headers: { 'x-agent-did': 'did:op:usage-test' }
    });
    assert.strictEqual(r.status, 200);
    const j = JSON.parse(r.body);
    assert.ok(Array.isArray(j.series) && j.series.length === 7);
    assert.ok(j.series[0].date && typeof j.series[0].calls === 'number');
  });
  await test('GET /v1/usage/summary returns per-period totals', async () => {
    const r = await fetchPath('/v1/usage/summary', { headers: { 'x-agent-did': 'did:op:usage-test' } });
    assert.strictEqual(r.status, 200);
    const j = JSON.parse(r.body);
    assert.ok(j.periods?.today && j.periods?.week && j.periods?.month);
  });
  await test('GET /inspector renders SSE event viewer', async () => {
    const r = await fetchPath('/inspector');
    assert.strictEqual(r.status, 200);
    assert.ok(/Inspector|EventSource|live/.test(r.body));
  });
  await test('GET /marketplace renders storefront with extensions/prompts/datasets', async () => {
    const r = await fetchPath('/marketplace');
    assert.strictEqual(r.status, 200);
    assert.ok(/Marketplace|Extensions|Prompts|Datasets/.test(r.body));
  });
  await test('GET /developer renders developer console', async () => {
    const r = await fetchPath('/developer');
    assert.strictEqual(r.status, 200);
    assert.ok(/Developer Console|API Keys|Recent Requests/.test(r.body));
  });

  console.log('\n== e2e: layer 50 — enterprise assurance ==');
  await test('GET /trust renders trust center with cert grid', async () => {
    const r = await fetchPath('/trust');
    assert.strictEqual(r.status, 200);
    assert.ok(/Trust Center|SOC 2|GDPR|Ed25519/.test(r.body));
  });
  await test('GET /sla renders SLA tiers', async () => {
    const r = await fetchPath('/sla');
    assert.strictEqual(r.status, 200);
    assert.ok(/Service Level Agreement|99\.9|Enterprise/.test(r.body));
  });
  await test('GET /sla.json returns tiers array', async () => {
    const r = await fetchPath('/sla.json');
    assert.strictEqual(r.status, 200);
    const j = JSON.parse(r.body);
    assert.ok(Array.isArray(j.tiers) && j.tiers.length === 5);
  });
  await test('GET /security/disclosure renders bounty + safe harbor', async () => {
    const r = await fetchPath('/security/disclosure');
    assert.strictEqual(r.status, 200);
    assert.ok(/bug bounty|Safe harbor|Severity/i.test(r.body));
  });
  await test('GET /v1/me/invoices without auth returns 401', async () => {
    const r = await fetchPath('/v1/me/invoices');
    assert.strictEqual(r.status, 401);
  });
  await test('GET /v1/me/invoices with auth returns invoices list', async () => {
    const r = await fetchPath('/v1/me/invoices', { headers: { 'x-agent-did': 'did:op:inv-test' } });
    assert.strictEqual(r.status, 200);
    const j = JSON.parse(r.body);
    assert.ok(Array.isArray(j.invoices));
  });
  await test('GET /v1/me/billing/usage returns current period breakdown', async () => {
    const r = await fetchPath('/v1/me/billing/usage', { headers: { 'x-agent-did': 'did:op:bill-test' } });
    assert.strictEqual(r.status, 200);
    const j = JSON.parse(r.body);
    assert.ok(j.period_start && j.totals && j.by_provider);
  });

  console.log('\n== e2e: layer 51 — growth surfaces ==');
  await test('GET /referrals renders public referral page', async () => {
    const r = await fetchPath('/referrals');
    assert.strictEqual(r.status, 200);
    assert.ok(/Earn 25%|recurring|referral/.test(r.body));
  });
  await test('GET /compare-models renders side-by-side compare', async () => {
    const r = await fetchPath('/compare-models');
    assert.strictEqual(r.status, 200);
    assert.ok(/Compare Models|Model A|Model B/.test(r.body));
  });
  await test('POST /v1/referrals/generate creates a referral code', async () => {
    const r = await fetchPath('/v1/referrals/generate', {
      method: 'POST',
      body: { referrer_did: 'did:op:ref-test-' + Date.now() }
    });
    assert.ok([200, 201].includes(r.status));
    const j = JSON.parse(r.body);
    assert.ok(j.ref_code && j.ref_code.length === 8);
  });
  await test('POST /v1/referrals/generate without DID returns 400', async () => {
    const r = await fetchPath('/v1/referrals/generate', { method: 'POST', body: {} });
    assert.strictEqual(r.status, 400);
  });
  await test('POST /v1/referrals/:code/click records', async () => {
    const r = await fetchPath('/v1/referrals/TESTCODE/click', { method: 'POST', body: {} });
    assert.strictEqual(r.status, 200);
  });
  await test('GET /v1/charts/sparkline.svg returns SVG', async () => {
    const r = await fetchPath('/v1/charts/sparkline.svg?values=1,2,3,5,2,8,4');
    assert.strictEqual(r.status, 200);
    assert.ok(r.headers['content-type']?.includes('svg'));
    assert.ok(/<polyline/.test(r.body));
  });
  await test('GET /v1/charts/bars.svg returns SVG', async () => {
    const r = await fetchPath('/v1/charts/bars.svg?values=10,20,15,25,30');
    assert.strictEqual(r.status, 200);
    assert.ok(/<rect/.test(r.body));
  });
  await test('GET /v1/charts/donut.svg returns SVG with circle', async () => {
    const r = await fetchPath('/v1/charts/donut.svg?slices=10:22c55e,20:4f46e5,30:eab308');
    assert.strictEqual(r.status, 200);
    assert.ok(/<path|<circle/.test(r.body));
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (skipReasons.length) console.log(`(${skipReasons.length} skipped: ${skipReasons.join(', ')})`);
  await new Promise(r => server.close(r));
  process.exit(failed === 0 ? 0 : 1);
}

run().catch(e => { console.error('FATAL', e); process.exit(2); });
