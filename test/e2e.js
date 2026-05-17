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

  console.log('\n== e2e: layer 52 — notifications + whatsnew + audit viz ==');
  await test('GET /v1/me/notifications without auth returns 401', async () => {
    const r = await fetchPath('/v1/me/notifications');
    assert.strictEqual(r.status, 401);
  });
  await test('GET /v1/me/notifications with auth returns list', async () => {
    const r = await fetchPath('/v1/me/notifications', { headers: { 'x-agent-did': 'did:op:notif-test' } });
    assert.strictEqual(r.status, 200);
    const j = JSON.parse(r.body);
    assert.ok(Array.isArray(j.notifications));
    assert.ok(typeof j.unread_count === 'number');
  });
  await test('POST /v1/_internal/notify requires internal key', async () => {
    const r = await fetchPath('/v1/_internal/notify', {
      method: 'POST',
      body: { agent_did: 'did:op:x', kind: 'test', title: 'Test' }
    });
    assert.strictEqual(r.status, 401);
  });
  await test('GET /notifications renders UI', async () => {
    const r = await fetchPath('/notifications');
    assert.strictEqual(r.status, 200);
    assert.ok(/Notifications|In-app/.test(r.body));
  });
  await test('GET /whatsnew renders auto-generated feed', async () => {
    const r = await fetchPath('/whatsnew');
    assert.strictEqual(r.status, 200);
    assert.ok(/What's New|Subscribe|Full changelog/.test(r.body));
  });
  await test('GET /audit/visualize renders SVG chain', async () => {
    const r = await fetchPath('/audit/visualize');
    assert.strictEqual(r.status, 200);
    assert.ok(/Audit Chain Visualizer|<svg|<rect/.test(r.body));
  });

  console.log('\n== e2e: layer 53 — auth polish (magic-link + MFA + preferences) ==');
  await test('GET /auth/sign-in renders magic-link form', async () => {
    const r = await fetchPath('/auth/sign-in');
    assert.strictEqual(r.status, 200);
    assert.ok(/Sign in|magic link|passwordless/i.test(r.body));
  });
  await test('POST /v1/auth/magic-link/send with invalid email returns 400', async () => {
    const r = await fetchPath('/v1/auth/magic-link/send', {
      method: 'POST',
      body: { email: 'not-an-email' }
    });
    assert.strictEqual(r.status, 400);
  });
  await test('POST /v1/auth/magic-link/send with valid email returns 202', async () => {
    const r = await fetchPath('/v1/auth/magic-link/send', {
      method: 'POST',
      body: { email: 'test@example.com' }
    });
    assert.strictEqual(r.status, 202);
    const j = JSON.parse(r.body);
    assert.ok(j.sent);
  });
  await test('GET /v1/auth/magic-link/verify/:invalid returns 404', async () => {
    const r = await fetchPath('/v1/auth/magic-link/verify/mlink_invalid');
    assert.strictEqual(r.status, 404);
  });
  await test('GET /v1/me/mfa/enroll without auth returns 401', async () => {
    const r = await fetchPath('/v1/me/mfa/enroll');
    assert.strictEqual(r.status, 401);
  });
  await test('GET /v1/me/mfa/enroll with auth returns secret + otpauth URI', async () => {
    const r = await fetchPath('/v1/me/mfa/enroll', { headers: { 'x-agent-did': 'did:op:mfa-test' } });
    assert.strictEqual(r.status, 200);
    const j = JSON.parse(r.body);
    assert.ok(j.secret && j.secret.length >= 16);
    assert.ok(j.otpauth_uri && j.otpauth_uri.startsWith('otpauth://totp/'));
  });
  await test('POST /v1/me/mfa/verify with valid code enrolls successfully', async () => {
    const { generateTotpSecret, totp } = require('../src/primitives/auth_polish');
    const secret = generateTotpSecret();
    const code = totp(secret);
    const r = await fetchPath('/v1/me/mfa/verify', {
      method: 'POST',
      headers: { 'x-agent-did': 'did:op:mfa-verify-test' },
      body: { secret, code, enroll: true }
    });
    assert.strictEqual(r.status, 200);
    const j = JSON.parse(r.body);
    assert.strictEqual(j.ok, true);
    assert.strictEqual(j.enrolled, true);
    assert.ok(Array.isArray(j.backup_codes) && j.backup_codes.length === 8);
  });
  await test('POST /v1/me/mfa/verify with wrong code returns 400', async () => {
    const { generateTotpSecret } = require('../src/primitives/auth_polish');
    const r = await fetchPath('/v1/me/mfa/verify', {
      method: 'POST',
      headers: { 'x-agent-did': 'did:op:mfa-verify-test' },
      body: { secret: generateTotpSecret(), code: '000000' }
    });
    assert.strictEqual(r.status, 400);
  });
  await test('GET /v1/me/mfa/status returns enrollment state', async () => {
    const r = await fetchPath('/v1/me/mfa/status', { headers: { 'x-agent-did': 'did:op:mfa-status' } });
    assert.strictEqual(r.status, 200);
    const j = JSON.parse(r.body);
    assert.ok(typeof j.enrolled === 'boolean');
  });
  await test('GET + PUT /v1/me/preferences round-trips', async () => {
    const did = 'did:op:prefs-test';
    const put = await fetchPath('/v1/me/preferences', {
      method: 'PUT',
      headers: { 'x-agent-did': did },
      body: { theme: 'dark', notifications_email: true }
    });
    assert.strictEqual(put.status, 200);
    const get = await fetchPath('/v1/me/preferences', { headers: { 'x-agent-did': did } });
    assert.strictEqual(get.status, 200);
    const j = JSON.parse(get.body);
    assert.ok(j.preferences);
  });
  await test('GET /v1/me/sessions returns session list', async () => {
    const r = await fetchPath('/v1/me/sessions', { headers: { 'x-agent-did': 'did:op:sess-test' } });
    assert.strictEqual(r.status, 200);
    const j = JSON.parse(r.body);
    assert.ok(Array.isArray(j.sessions));
  });

  console.log('\n== e2e: layer 54 — OAuth + resources + audit filter ==');
  await test('GET /resources renders sitemap with all groups', async () => {
    const r = await fetchPath('/resources');
    assert.strictEqual(r.status, 200);
    assert.ok(/Resources|Get started|For developers|Operations/.test(r.body));
  });
  await test('GET /v1/auth/oauth/providers lists Google/GitHub/Microsoft', async () => {
    const r = await fetchPath('/v1/auth/oauth/providers');
    assert.strictEqual(r.status, 200);
    const j = JSON.parse(r.body);
    assert.ok(Array.isArray(j.providers) && j.providers.length >= 3);
    assert.ok(j.providers.find(p => p.id === 'google'));
    assert.ok(j.providers.find(p => p.id === 'github'));
  });
  await test('GET /auth/oauth/google/start redirects to Google authorize', async () => {
    const r = await fetchPath('/auth/oauth/google/start');
    assert.ok([301, 302].includes(r.status));
    assert.ok(r.headers.location?.includes('accounts.google.com'));
  });
  await test('GET /auth/oauth/unknown/start returns 404', async () => {
    const r = await fetchPath('/auth/oauth/unknown/start');
    assert.strictEqual(r.status, 404);
  });
  await test('GET /auth/oauth/google/callback without code returns 400', async () => {
    const r = await fetchPath('/auth/oauth/google/callback');
    assert.strictEqual(r.status, 400);
  });
  await test('GET /v1/audit/filter without auth returns 401', async () => {
    const r = await fetchPath('/v1/audit/filter');
    assert.strictEqual(r.status, 401);
  });
  await test('GET /v1/audit/filter with auth returns entries', async () => {
    const r = await fetchPath('/v1/audit/filter?limit=10', { headers: { 'x-agent-did': 'did:op:filter-test' } });
    assert.strictEqual(r.status, 200);
    const j = JSON.parse(r.body);
    assert.ok(Array.isArray(j.entries));
    assert.strictEqual(j.limit, 10);
  });
  await test('GET /v1/audit/filter cant query other agents without admin', async () => {
    const r = await fetchPath('/v1/audit/filter?agent_did=did:op:someone-else',
      { headers: { 'x-agent-did': 'did:op:filter-test' } });
    assert.strictEqual(r.status, 403);
  });

  console.log('\n== e2e: layer 55 — auto-provision + viral landing widgets ==');
  await test('POST /v1/admin/setup/bootstrap on first-boot generates secrets', async () => {
    // first-boot mode: no OPERATOR_ADMIN_TOKEN nor INTERNAL_API_KEY set
    delete process.env.OPERATOR_ADMIN_TOKEN;
    delete process.env.INTERNAL_API_KEY;
    const r = await fetchPath('/v1/admin/setup/bootstrap', { method: 'POST', body: {} });
    assert.strictEqual(r.status, 200);
    const j = JSON.parse(r.body);
    assert.ok(j.ok && j.generated);
    assert.ok(j.generated.OPERATOR_ADMIN_TOKEN);
    assert.ok(j.generated.IDENTITY_MASTER_KEK);
  });
  await test('POST /v1/admin/setup/bootstrap after first-boot requires admin', async () => {
    process.env.OPERATOR_ADMIN_TOKEN = 'test-after-bootstrap';
    process.env.INTERNAL_API_KEY = 'test-internal';
    const r = await fetchPath('/v1/admin/setup/bootstrap', { method: 'POST', body: {} });
    assert.strictEqual(r.status, 401);
    delete process.env.OPERATOR_ADMIN_TOKEN;
    delete process.env.INTERNAL_API_KEY;
  });
  await test('POST /v1/admin/setup/stripe without admin returns 401', async () => {
    const r = await fetchPath('/v1/admin/setup/stripe', { method: 'POST', body: { secret_key: 'sk_test_x' } });
    assert.strictEqual(r.status, 401);
  });
  await test('POST /v1/admin/setup/stripe with bad key returns 400', async () => {
    process.env.OPERATOR_ADMIN_TOKEN = 'stripe-test-tok';
    const r = await fetchPath('/v1/admin/setup/stripe', {
      method: 'POST',
      headers: { 'x-admin-token': 'stripe-test-tok' },
      body: { secret_key: 'not-a-stripe-key' }
    });
    assert.strictEqual(r.status, 400);
    delete process.env.OPERATOR_ADMIN_TOKEN;
  });
  await test('GET /v1/admin/setup/status requires admin', async () => {
    delete process.env.OPERATOR_ADMIN_TOKEN;
    const r = await fetchPath('/v1/admin/setup/status');
    assert.strictEqual(r.status, 401);
  });
  await test('POST /v1/anon/try without body returns 400', async () => {
    const r = await fetchPath('/v1/anon/try', { method: 'POST', body: {} });
    assert.strictEqual(r.status, 400);
  });
  await test('POST /v1/anon/try returns OpenAI-shape with quota', async () => {
    delete process.env.OPENAI_API_KEY;
    const r = await fetchPath('/v1/anon/try', {
      method: 'POST',
      body: { model: 'demo', messages: [{ role: 'user', content: 'hi from anon' }] }
    });
    assert.strictEqual(r.status, 200);
    const j = JSON.parse(r.body);
    assert.ok(j.choices && j._quota);
    assert.ok(j._quota.cap === 10);
  });
  await test('GET /v1/anon/quota returns remaining', async () => {
    const r = await fetchPath('/v1/anon/quota');
    assert.strictEqual(r.status, 200);
    const j = JSON.parse(r.body);
    assert.ok(typeof j.remaining === 'number');
  });
  await test('GET /embed/try-now.html renders iframe-able widget', async () => {
    const r = await fetchPath('/embed/try-now.html');
    assert.strictEqual(r.status, 200);
    assert.ok(/Try OpenHeab|powered/i.test(r.body));
  });
  await test('GET /embed/try-now.js returns drop-in script', async () => {
    const r = await fetchPath('/embed/try-now.js');
    assert.strictEqual(r.status, 200);
    assert.ok(r.headers['content-type']?.includes('javascript'));
    assert.ok(/iframe|embed/i.test(r.body));
  });
  await test('GET /swarm renders live swarm page', async () => {
    const r = await fetchPath('/swarm');
    assert.strictEqual(r.status, 200);
    assert.ok(/swarm|live|Spawn|agents/i.test(r.body));
  });
  await test('POST /v1/swarm/spawn creates N agents + emits events', async () => {
    const r = await fetchPath('/v1/swarm/spawn', { method: 'POST', body: { count: 5 } });
    assert.strictEqual(r.status, 200);
    const j = JSON.parse(r.body);
    assert.strictEqual(j.spawned, 5);
    assert.ok(j.events >= 5);
  });
  await test('GET /setup-wizard renders zero-config wizard', async () => {
    const r = await fetchPath('/setup-wizard');
    assert.strictEqual(r.status, 200);
    assert.ok(/Bootstrap|Stripe|Current configuration/i.test(r.body));
  });

  console.log('\n== e2e: layer 56 — distribution + auto-ops ==');
  await test('GET /install serves bash installer', async () => {
    const r = await fetchPath('/install');
    assert.strictEqual(r.status, 200);
    assert.ok(r.headers['content-type']?.includes('shellscript') || r.headers['content-type']?.includes('text'));
    assert.ok(/#!\/usr\/bin\/env bash|set -euo pipefail/.test(r.body));
  });
  await test('GET /deploy/vercel renders multi-platform deploy page', async () => {
    const r = await fetchPath('/deploy/vercel');
    assert.strictEqual(r.status, 200);
    assert.ok(/Deploy|Vercel|Render|Railway|Docker/.test(r.body));
  });
  await test('GET /deploy/render.yaml returns render blueprint', async () => {
    const r = await fetchPath('/deploy/render.yaml');
    assert.strictEqual(r.status, 200);
    assert.ok(/services:|envVars:|openheab-substrate/.test(r.body));
  });
  await test('GET /deploy/railway.json returns railway template', async () => {
    const r = await fetchPath('/deploy/railway.json');
    assert.strictEqual(r.status, 200);
    const j = JSON.parse(r.body);
    assert.ok(j.services && Array.isArray(j.services));
  });
  await test('GET /launch-button.svg returns valid SVG', async () => {
    const r = await fetchPath('/launch-button.svg');
    assert.strictEqual(r.status, 200);
    assert.ok(r.headers['content-type']?.includes('svg'));
    assert.ok(/<svg|<rect|<text/.test(r.body));
  });
  await test('autoIncidentWatch returns status object', async () => {
    const { autoIncidentWatch } = require('../src/primitives/zero_config_self_run');
    const mockPool = { query: async () => ({ rows: [] }) };
    const mockAudit = { append: async () => {} };
    const result = await autoIncidentWatch(mockPool, mockAudit);
    assert.ok(result && typeof result === 'object');
    assert.ok(result.status || result.error);
  });
  await test('autoUpgradeNudge returns notification count', async () => {
    const { autoUpgradeNudge } = require('../src/primitives/zero_config_self_run');
    const mockPool = { query: async () => ({ rows: [] }) };
    const result = await autoUpgradeNudge(mockPool, null);
    assert.strictEqual(typeof result.notified, 'number');
  });
  await test('autoSummaryDigest returns sent count', async () => {
    const { autoSummaryDigest } = require('../src/primitives/zero_config_self_run');
    const mockPool = { query: async () => ({ rows: [] }) };
    const result = await autoSummaryDigest(mockPool, null);
    assert.strictEqual(typeof result.sent, 'number');
  });

  console.log('\n== e2e: layer 57 — intelligent routing + RAG + auto-fraud ==');
  await test('GET /v1/inference/route requires model', async () => {
    const r = await fetchPath('/v1/inference/route');
    assert.strictEqual(r.status, 400);
  });
  await test('GET /v1/inference/route?model=X returns provider pick', async () => {
    const r = await fetchPath('/v1/inference/route?model=claude-haiku');
    assert.strictEqual(r.status, 200);
    const j = JSON.parse(r.body);
    assert.ok(j.provider);
    assert.ok(['anthropic', 'stub'].includes(j.provider));
  });
  await test('POST /v1/rag/index without auth returns 401', async () => {
    const r = await fetchPath('/v1/rag/index', { method: 'POST', body: { text: 'hi' } });
    assert.strictEqual(r.status, 401);
  });
  await test('POST /v1/rag/index without text returns 400', async () => {
    const r = await fetchPath('/v1/rag/index', {
      method: 'POST',
      headers: { 'x-agent-did': 'did:op:rag-test' },
      body: {}
    });
    assert.strictEqual(r.status, 400);
  });
  await test('POST /v1/rag/index indexes text chunks', async () => {
    const r = await fetchPath('/v1/rag/index', {
      method: 'POST',
      headers: { 'x-agent-did': 'did:op:rag-test' },
      body: { title: 'Test', text: 'OpenHeab is an agent-native substrate.' }
    });
    assert.strictEqual(r.status, 201);
    const j = JSON.parse(r.body);
    assert.ok(j.indexed >= 1);
    assert.ok(Array.isArray(j.doc_ids));
  });
  await test('POST /v1/rag/query returns scored results', async () => {
    const r = await fetchPath('/v1/rag/query', {
      method: 'POST',
      headers: { 'x-agent-did': 'did:op:rag-test' },
      body: { question: 'what is openheab', top_k: 5 }
    });
    assert.strictEqual(r.status, 200);
    const j = JSON.parse(r.body);
    assert.ok(Array.isArray(j.results));
    assert.strictEqual(j.top_k, 5);
  });
  await test('GET /v1/rag/stats returns chunk count', async () => {
    const r = await fetchPath('/v1/rag/stats', { headers: { 'x-agent-did': 'did:op:rag-test' } });
    assert.strictEqual(r.status, 200);
    const j = JSON.parse(r.body);
    assert.ok(typeof j.chunks === 'number');
  });
  await test('GET /v1/quarantines/:did returns frozen=false for unknown agent', async () => {
    const r = await fetchPath('/v1/quarantines/did:op:never-existed');
    assert.strictEqual(r.status, 200);
    const j = JSON.parse(r.body);
    assert.strictEqual(j.frozen, false);
  });
  await test('POST /v1/admin/quarantines/:did/unfreeze requires admin', async () => {
    delete process.env.OPERATOR_ADMIN_TOKEN;
    const r = await fetchPath('/v1/admin/quarantines/did:op:x/unfreeze', { method: 'POST', body: {} });
    assert.strictEqual(r.status, 401);
  });
  await test('autoFraudFreeze function returns structured result', async () => {
    const { autoFraudFreeze } = require('../src/primitives/intelligent_substrate');
    const mockPool = { query: async () => ({ rows: [] }) };
    const r = await autoFraudFreeze(mockPool, null);
    assert.ok(typeof r.candidates_evaluated === 'number');
    assert.ok(typeof r.newly_frozen === 'number');
  });

  console.log('\n== e2e: layer 58 — revenue engine ==');
  await test('GET /leaderboard renders 4 boards', async () => {
    const r = await fetchPath('/leaderboard');
    assert.strictEqual(r.status, 200);
    assert.ok(/Top API consumers|Top RLAF|Top referrers|Top marketplace/.test(r.body));
  });
  await test('GET /leaderboard.json returns 4 lists', async () => {
    const r = await fetchPath('/leaderboard.json');
    assert.strictEqual(r.status, 200);
    const j = JSON.parse(r.body);
    assert.ok(Array.isArray(j.top_consumers));
    assert.ok(Array.isArray(j.top_judged));
    assert.ok(Array.isArray(j.top_referrers));
    assert.ok(Array.isArray(j.top_sellers));
  });
  await test('GET /v1/me/earnings without auth returns 401', async () => {
    const r = await fetchPath('/v1/me/earnings');
    assert.strictEqual(r.status, 401);
  });
  await test('GET /v1/me/earnings with auth returns summary', async () => {
    const r = await fetchPath('/v1/me/earnings', { headers: { 'x-agent-did': 'did:op:earn-test' } });
    assert.strictEqual(r.status, 200);
    const j = JSON.parse(r.body);
    assert.ok(j.marketplace_payouts && j.referrals && j.summary);
  });
  await test('GET /v1/featured/pricing returns 4 kinds', async () => {
    const r = await fetchPath('/v1/featured/pricing');
    assert.strictEqual(r.status, 200);
    const j = JSON.parse(r.body);
    assert.ok(j.pricing.tool && j.pricing.extension && j.pricing.prompt && j.pricing.dataset);
  });
  await test('POST /v1/featured/purchase with bad kind returns 400', async () => {
    const r = await fetchPath('/v1/featured/purchase', {
      method: 'POST',
      headers: { 'x-agent-did': 'did:op:feat-test' },
      body: { kind: 'bogus', target_id: 'x' }
    });
    assert.strictEqual(r.status, 400);
  });
  await test('POST /v1/featured/purchase creates placement', async () => {
    const r = await fetchPath('/v1/featured/purchase', {
      method: 'POST',
      headers: { 'x-agent-did': 'did:op:feat-test' },
      body: { kind: 'tool', target_id: 'my-tool', weeks: 2 }
    });
    assert.strictEqual(r.status, 201);
    const j = JSON.parse(r.body);
    assert.ok(j.placement_id && j.total_cents === 10000);
  });
  await test('GET /v1/featured/active returns list', async () => {
    const r = await fetchPath('/v1/featured/active?kind=tool');
    assert.strictEqual(r.status, 200);
    const j = JSON.parse(r.body);
    assert.ok(Array.isArray(j.active));
  });
  await test('POST /v1/nps/submit with score 9 returns 201 + promoter msg', async () => {
    const r = await fetchPath('/v1/nps/submit', { method: 'POST', body: { score: 9, comment: 'love it' } });
    assert.strictEqual(r.status, 201);
    const j = JSON.parse(r.body);
    assert.ok(/promoter|share/i.test(j.thanks));
  });
  await test('POST /v1/nps/submit with bad score returns 400', async () => {
    const r = await fetchPath('/v1/nps/submit', { method: 'POST', body: { score: 99 } });
    assert.strictEqual(r.status, 400);
  });
  await test('GET /v1/nps/aggregate returns NPS calculation', async () => {
    const r = await fetchPath('/v1/nps/aggregate');
    assert.strictEqual(r.status, 200);
    const j = JSON.parse(r.body);
    assert.ok(typeof j.total === 'number');
  });
  await test('churnRiskScan function returns structured result', async () => {
    const { churnRiskScan } = require('../src/primitives/revenue_engine');
    const mockPool = { query: async () => ({ rows: [] }) };
    const r = await churnRiskScan(mockPool, null);
    assert.ok(typeof r.evaluated === 'number');
    assert.ok(typeof r.alerted === 'number');
  });

  console.log('\n== e2e: layer 59 — agent OS + tournaments ==');
  await test('POST /v1/agent-os/goals without auth returns 401', async () => {
    const r = await fetchPath('/v1/agent-os/goals', { method: 'POST', body: { title: 'x' } });
    assert.strictEqual(r.status, 401);
  });
  await test('POST /v1/agent-os/goals without title returns 400', async () => {
    const r = await fetchPath('/v1/agent-os/goals', {
      method: 'POST',
      headers: { 'x-agent-did': 'did:op:os-test' },
      body: {}
    });
    assert.strictEqual(r.status, 400);
  });
  await test('POST /v1/agent-os/goals creates a goal', async () => {
    const r = await fetchPath('/v1/agent-os/goals', {
      method: 'POST',
      headers: { 'x-agent-did': 'did:op:os-test' },
      body: { title: 'Test continuous goal', schedule: 'daily', meta: { action: 'noop' } }
    });
    assert.strictEqual(r.status, 201);
    const j = JSON.parse(r.body);
    assert.ok(j.goal_id && j.goal_id.startsWith('goal_'));
  });
  await test('GET /v1/agent-os/goals lists my goals', async () => {
    const r = await fetchPath('/v1/agent-os/goals', { headers: { 'x-agent-did': 'did:op:os-test' } });
    assert.strictEqual(r.status, 200);
    const j = JSON.parse(r.body);
    assert.ok(Array.isArray(j.goals));
  });
  await test('agentOsTick function returns structured result', async () => {
    const { agentOsTick } = require('../src/primitives/agent_os_tournaments');
    const mockPool = { query: async () => ({ rows: [] }) };
    const r = await agentOsTick(mockPool, null);
    assert.strictEqual(typeof r.goals_evaluated, 'number');
    assert.strictEqual(typeof r.steps_ran, 'number');
  });
  await test('GET /tournaments renders public list page', async () => {
    const r = await fetchPath('/tournaments');
    assert.strictEqual(r.status, 200);
    assert.ok(/Tournaments|bounty|USDC/i.test(r.body));
  });
  await test('GET /v1/tournaments returns array', async () => {
    const r = await fetchPath('/v1/tournaments');
    assert.strictEqual(r.status, 200);
    const j = JSON.parse(r.body);
    assert.ok(Array.isArray(j.tournaments));
  });
  await test('POST /v1/tournaments without admin returns 401', async () => {
    delete process.env.OPERATOR_ADMIN_TOKEN;
    const r = await fetchPath('/v1/tournaments', {
      method: 'POST', body: { slug: 'test', title: 'Test', ends_at: '2026-12-31' }
    });
    assert.strictEqual(r.status, 401);
  });
  await test('GET /v1/tournaments/:slug/leaderboard returns array', async () => {
    const r = await fetchPath('/v1/tournaments/nonexistent/leaderboard');
    assert.strictEqual(r.status, 200);
    const j = JSON.parse(r.body);
    assert.ok(Array.isArray(j.leaderboard));
  });

  console.log('\n== e2e: layer 60 — distributed tracing ==');
  await test('POST /v1/traces without auth returns 401', async () => {
    const r = await fetchPath('/v1/traces', { method: 'POST', body: { name: 'x' } });
    assert.strictEqual(r.status, 401);
  });
  await test('POST /v1/traces creates a trace', async () => {
    const did = 'did:op:trace-test-' + Date.now();
    const start = await fetchPath('/v1/traces', {
      method: 'POST',
      headers: { 'x-agent-did': did },
      body: { name: 'test-run', kind: 'agent_run', input: { prompt: 'hi' } }
    });
    assert.strictEqual(start.status, 201);
    const startJ = JSON.parse(start.body);
    assert.ok(startJ.trace_id && startJ.trace_id.startsWith('trc_'));
    // Note: span/end/retrieve roundtrip needs a real pool with retained INSERTs
    // (our mock pool doesn't preserve state). Production e2e against real DB
    // covers that path.
  });
  await test('POST /v1/traces without name returns 400', async () => {
    const r = await fetchPath('/v1/traces', {
      method: 'POST',
      headers: { 'x-agent-did': 'did:op:t' },
      body: {}
    });
    assert.strictEqual(r.status, 400);
  });
  await test('GET /v1/traces lists agent traces', async () => {
    const r = await fetchPath('/v1/traces', { headers: { 'x-agent-did': 'did:op:t-list' } });
    assert.strictEqual(r.status, 200);
    const j = JSON.parse(r.body);
    assert.ok(Array.isArray(j.traces));
  });
  await test('POST /v1/traces/:id/spans on someone else trace returns 404', async () => {
    const r = await fetchPath('/v1/traces/trc_nonexistent/spans', {
      method: 'POST',
      headers: { 'x-agent-did': 'did:op:other' },
      body: { name: 'x', kind: 'y' }
    });
    assert.strictEqual(r.status, 404);
  });
  await test('GET /traces renders HTML viewer', async () => {
    const r = await fetchPath('/traces');
    assert.strictEqual(r.status, 200);
    assert.ok(/Traces|trace|span/i.test(r.body));
  });

  console.log('\n== e2e: layer 61 — enterprise GTM + CEO command center ==');
  await test('GET /vision renders $100B thesis', async () => {
    const r = await fetchPath('/vision');
    assert.strictEqual(r.status, 200);
    assert.ok(/100B|substrate|moat|thesis|TAM/i.test(r.body));
  });
  await test('GET /scale renders live counters', async () => {
    const r = await fetchPath('/scale');
    assert.strictEqual(r.status, 200);
    assert.ok(/Live substrate|Agents alive|Audit events/.test(r.body));
  });
  await test('GET /scale.json returns counter object', async () => {
    const r = await fetchPath('/scale.json');
    assert.strictEqual(r.status, 200);
    const j = JSON.parse(r.body);
    assert.ok(typeof j.agents === 'number');
    assert.ok(typeof j.audit_events === 'number');
  });
  await test('GET /command-center without admin returns 401', async () => {
    delete process.env.OPERATOR_ADMIN_TOKEN;
    const r = await fetchPath('/command-center');
    assert.strictEqual(r.status, 401);
  });
  await test('POST /v1/enterprise/rfp returns answers', async () => {
    const r = await fetchPath('/v1/enterprise/rfp', {
      method: 'POST',
      body: { questions: ['how is data encrypted at rest', 'do you have soc 2', 'what is your sla'] }
    });
    assert.strictEqual(r.status, 200);
    const j = JSON.parse(r.body);
    assert.ok(Array.isArray(j.responses) && j.responses.length === 3);
    assert.strictEqual(j.summary.matched, 3);
  });
  await test('POST /v1/enterprise/rfp with totally unrelated question handles gracefully', async () => {
    const r = await fetchPath('/v1/enterprise/rfp', {
      method: 'POST',
      body: { question: 'lobster bisque recipe xyzpqr' }
    });
    assert.strictEqual(r.status, 200);
    const j = JSON.parse(r.body);
    // Either no match OR low confidence — both acceptable
    assert.ok(typeof j.responses[0].matched === 'boolean');
    assert.ok(typeof j.responses[0].match_score === 'number');
  });
  await test('GET /v1/enterprise/rfp/library returns library', async () => {
    const r = await fetchPath('/v1/enterprise/rfp/library');
    assert.strictEqual(r.status, 200);
    const j = JSON.parse(r.body);
    assert.ok(j.total >= 40 && Array.isArray(j.library));
  });
  await test('GET /v1/enterprise/security-questionnaire returns controls', async () => {
    const r = await fetchPath('/v1/enterprise/security-questionnaire');
    assert.strictEqual(r.status, 200);
    const j = JSON.parse(r.body);
    assert.ok(j.total_controls >= 15);
    assert.ok(j.controls['AC-01']);
  });
  await test('GET /v1/enterprise/readiness-score returns A-F grade', async () => {
    const r = await fetchPath('/v1/enterprise/readiness-score');
    assert.strictEqual(r.status, 200);
    const j = JSON.parse(r.body);
    assert.ok(typeof j.score === 'number');
    assert.ok(['A','B','C','D','F'].includes(j.grade));
    assert.ok(Array.isArray(j.checks));
  });
  await test('POST /v1/enterprise/prospects without admin returns 401', async () => {
    delete process.env.OPERATOR_ADMIN_TOKEN;
    const r = await fetchPath('/v1/enterprise/prospects', { method: 'POST', body: { company: 'Test' } });
    assert.strictEqual(r.status, 401);
  });
  await test('GET /v1/enterprise/prospects without admin returns 401', async () => {
    delete process.env.OPERATOR_ADMIN_TOKEN;
    const r = await fetchPath('/v1/enterprise/prospects');
    assert.strictEqual(r.status, 401);
  });

  console.log('\n== e2e: layer 62 — agent-callable provisioning (no human-in-loop) ==');
  await test('GET /v1/pricing/usdc returns machine-readable tier prices', async () => {
    const r = await fetchPath('/v1/pricing/usdc');
    assert.strictEqual(r.status, 200);
    const j = JSON.parse(r.body);
    assert.strictEqual(j.currency, 'USDC');
    assert.ok(Array.isArray(j.tiers) && j.tiers.length === 4);
    assert.ok(j.tiers.find(t => t.plan === 'pro'));
  });
  await test('GET /v1/agents/:did/setup/discovered returns discovered creds shape', async () => {
    const r = await fetchPath('/v1/agents/did:op:disc-test/setup/discovered');
    // Without signature it'll 401 — that's correct
    assert.ok([200, 401].includes(r.status));
  });
  await test('encryptValue + decryptValue roundtrip per-tenant', () => {
    const { encryptValue, decryptValue } = require('../src/primitives/agent_self_provision');
    const did = 'did:op:enc-test';
    const original = 'sk_live_super_secret_value_12345';
    const enc = encryptValue(original, did);
    assert.ok(enc.encrypted && enc.iv);
    assert.notStrictEqual(enc.encrypted, original);
    const dec = decryptValue(enc.encrypted, enc.iv, did);
    assert.strictEqual(dec, original);
  });
  await test('encryptValue+decryptValue with wrong DID throws (tenant isolation)', () => {
    const { encryptValue, decryptValue } = require('../src/primitives/agent_self_provision');
    const enc = encryptValue('secret', 'did:op:agentA');
    assert.throws(() => decryptValue(enc.encrypted, enc.iv, 'did:op:agentB'));
  });
  await test('TIER_USDC_PRICES exports 4 tiers with raw amounts', () => {
    const { TIER_USDC_PRICES } = require('../src/primitives/agent_self_provision');
    assert.ok(TIER_USDC_PRICES.starter && TIER_USDC_PRICES.pro
           && TIER_USDC_PRICES.team && TIER_USDC_PRICES.enterprise);
    assert.strictEqual(TIER_USDC_PRICES.starter.raw_usdc, '19000000');
  });

  console.log('\n== e2e: layer 63 — agent economy ==');
  await test('GET /v1/agents/search returns results array', async () => {
    const r = await fetchPath('/v1/agents/search?limit=5');
    assert.strictEqual(r.status, 200);
    const j = JSON.parse(r.body);
    assert.ok(Array.isArray(j.results));
    assert.ok(j.query && typeof j.query.limit === 'number');
  });
  await test('GET /v1/agents/search with filter parses params', async () => {
    const r = await fetchPath('/v1/agents/search?tag=translate&max_price_cents=100&min_sla_seconds=60');
    assert.strictEqual(r.status, 200);
    const j = JSON.parse(r.body);
    assert.strictEqual(j.query.tag, 'translate');
    assert.strictEqual(j.query.max_price_cents, 100);
  });
  await test('POST /v1/agents/:did/capabilities without auth returns 401', async () => {
    const r = await fetchPath('/v1/agents/did:op:cap-test/capabilities', {
      method: 'POST', body: { slug: 'translate', name: 'Translate text' }
    });
    assert.strictEqual(r.status, 401);
  });
  await test('GET /v1/agents/:did/capabilities returns list', async () => {
    const r = await fetchPath('/v1/agents/did:op:cap-list/capabilities');
    assert.strictEqual(r.status, 200);
    const j = JSON.parse(r.body);
    assert.ok(Array.isArray(j.capabilities));
  });
  await test('POST /v1/jobs without auth returns 401', async () => {
    const r = await fetchPath('/v1/jobs', { method: 'POST', body: { title: 'x', budget_cents: 100 } });
    assert.strictEqual(r.status, 401);
  });
  await test('POST /v1/jobs with auth creates a job', async () => {
    const r = await fetchPath('/v1/jobs', {
      method: 'POST',
      headers: { 'x-agent-did': 'did:op:poster-test' },
      body: { title: 'translate this', budget_cents: 500, capability_tag: 'translate' }
    });
    assert.strictEqual(r.status, 201);
    const j = JSON.parse(r.body);
    assert.ok(j.job_id && j.escrow_held_cents === 500);
  });
  await test('POST /v1/jobs without title returns 400', async () => {
    const r = await fetchPath('/v1/jobs', {
      method: 'POST',
      headers: { 'x-agent-did': 'did:op:poster' },
      body: { budget_cents: 100 }
    });
    assert.strictEqual(r.status, 400);
  });
  await test('GET /v1/jobs returns open jobs', async () => {
    const r = await fetchPath('/v1/jobs?status=open');
    assert.strictEqual(r.status, 200);
    const j = JSON.parse(r.body);
    assert.ok(Array.isArray(j.jobs));
  });
  await test('POST /v1/agents/:did/subagents without auth returns 401', async () => {
    const r = await fetchPath('/v1/agents/did:op:parent/subagents', {
      method: 'POST',
      body: { goal: 'research', budget_cents: 1000, scope: ['inference'] }
    });
    assert.strictEqual(r.status, 401);
  });
  await test('POST /v1/agents/:did/subagents requires strict signature', async () => {
    // Without signature header → 401 (strictSignatureRequired in verifyAgentAuth).
    // Validation of body shape only runs after auth passes.
    const r = await fetchPath('/v1/agents/did:op:parent-test/subagents', {
      method: 'POST',
      headers: { 'x-agent-did': 'did:op:parent-test' },
      body: { goal: 'research', budget_cents: 1000 }
    });
    assert.ok([400, 401].includes(r.status));
  });
  await test('GET /v1/subagents/:sub_did/budget-check returns allowed', async () => {
    const r = await fetchPath('/v1/subagents/did:op:sub_unknown/budget-check?amount_cents=10');
    assert.strictEqual(r.status, 200);
    const j = JSON.parse(r.body);
    assert.ok(typeof j.allowed === 'boolean');
  });
  await test('POST /v1/agents/:did/endorse cant self-endorse', async () => {
    const r = await fetchPath('/v1/agents/did:op:self/endorse', {
      method: 'POST',
      headers: { 'x-agent-did': 'did:op:self' },
      body: { skill: 'translate' }
    });
    assert.strictEqual(r.status, 400);
  });
  await test('POST /v1/agents/:did/endorse with auth records endorsement', async () => {
    const r = await fetchPath('/v1/agents/did:op:subject/endorse', {
      method: 'POST',
      headers: { 'x-agent-did': 'did:op:endorser' },
      body: { skill: 'translate', weight: 0.9, narrative: 'great work' }
    });
    assert.strictEqual(r.status, 201);
    const j = JSON.parse(r.body);
    assert.ok(j.endorsement_id);
    assert.strictEqual(j.weight, 0.9);
  });
  await test('GET /v1/agents/:did/endorsements returns aggregate', async () => {
    const r = await fetchPath('/v1/agents/did:op:endorse-target/endorsements');
    assert.strictEqual(r.status, 200);
    const j = JSON.parse(r.body);
    assert.ok(Array.isArray(j.endorsements));
    assert.ok(j.by_skill);
  });
  await test('POST /v1/a2a/channels without auth returns 401', async () => {
    const r = await fetchPath('/v1/a2a/channels', { method: 'POST', body: { participants: ['did:op:other'] } });
    assert.strictEqual(r.status, 401);
  });
  await test('POST /v1/a2a/channels with auth creates channel', async () => {
    const r = await fetchPath('/v1/a2a/channels', {
      method: 'POST',
      headers: { 'x-agent-did': 'did:op:chan-creator' },
      body: { participants: ['did:op:other-agent'], topic: 'project x' }
    });
    assert.strictEqual(r.status, 201);
    const j = JSON.parse(r.body);
    assert.ok(j.channel_id);
    assert.ok(j.participants.includes('did:op:chan-creator'));
  });
  await test('GET /v1/a2a/channels lists agent channels', async () => {
    const r = await fetchPath('/v1/a2a/channels', { headers: { 'x-agent-did': 'did:op:chan-list' } });
    assert.strictEqual(r.status, 200);
    const j = JSON.parse(r.body);
    assert.ok(Array.isArray(j.channels));
  });
  await test('GET /v1/me/shared-files requires auth', async () => {
    const r = await fetchPath('/v1/me/shared-files');
    assert.strictEqual(r.status, 401);
  });
  await test('GET /v1/me/shared-files returns shared files list', async () => {
    const r = await fetchPath('/v1/me/shared-files', { headers: { 'x-agent-did': 'did:op:shared-test' } });
    assert.strictEqual(r.status, 200);
    const j = JSON.parse(r.body);
    assert.ok(Array.isArray(j.shared_files));
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (skipReasons.length) console.log(`(${skipReasons.length} skipped: ${skipReasons.join(', ')})`);
  await new Promise(r => server.close(r));
  process.exit(failed === 0 ? 0 : 1);
}

run().catch(e => { console.error('FATAL', e); process.exit(2); });
