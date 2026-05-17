// ============================================================================
// cloud_adapters.js — REAL wirings for Modal (GPU), E2B (sandboxes),
// Browserbase (headless browsers), Sentry (errors), Datadog (metrics),
// PagerDuty (alerts), GitHub (App webhooks), Slack (real bot).
// One file because each is a thin, repetitive HTTP forwarder.
// ============================================================================
const crypto = require('crypto');
const { z } = require('zod');

async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cloud_calls (
      call_id TEXT PRIMARY KEY, provider TEXT NOT NULL, kind TEXT NOT NULL,
      agent_did TEXT, status TEXT NOT NULL, latency_ms INTEGER,
      cost_cents INTEGER, error TEXT, external_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_cloud_calls_provider ON cloud_calls (provider, created_at DESC);
  `);
}

function newId(p) { return p + '_' + crypto.randomBytes(10).toString('hex'); }

async function logCall({ pool, provider, kind, agent_did, status, latency_ms, cost_cents, error, external_id }) {
  await pool.query(
    `INSERT INTO cloud_calls (call_id, provider, kind, agent_did, status, latency_ms, cost_cents, error, external_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [newId('cld'), provider, kind, agent_did || null, status, latency_ms || null, cost_cents || null, error || null, external_id || null]
  ).catch(() => {});
}

async function modalAPI(endpoint, body) {
  const tokenId = process.env.MODAL_TOKEN_ID;
  const tokenSecret = process.env.MODAL_TOKEN_SECRET;
  if (!tokenId || !tokenSecret) return { stub: true, container_id: 'cnt-stub-' + crypto.randomBytes(6).toString('hex') };
  if (typeof fetch !== 'function') throw new Error('fetch_unavailable');
  const r = await fetch(`https://api.modal.com/v1${endpoint}`, {
    method: 'POST', headers: { authorization: `Bearer ${tokenSecret}`, 'content-type': 'application/json', 'x-modal-token-id': tokenId },
    body: JSON.stringify(body)
  });
  if (!r.ok) throw new Error(`modal_${r.status}_${(await r.text()).slice(0, 200)}`);
  return await r.json();
}

async function e2bAPI(endpoint, body) {
  const key = process.env.E2B_API_KEY;
  if (!key) return { stub: true, sandbox_id: 'sbx-stub-' + crypto.randomBytes(6).toString('hex') };
  if (typeof fetch !== 'function') throw new Error('fetch_unavailable');
  const r = await fetch(`https://api.e2b.dev/v1${endpoint}`, {
    method: 'POST', headers: { 'x-api-key': key, 'content-type': 'application/json' }, body: JSON.stringify(body)
  });
  if (!r.ok) throw new Error(`e2b_${r.status}`);
  return await r.json();
}

async function browserbaseAPI(endpoint, body) {
  const key = process.env.BROWSERBASE_API_KEY;
  const project = process.env.BROWSERBASE_PROJECT_ID;
  if (!key || !project) return { stub: true, session_id: 'bb-stub-' + crypto.randomBytes(6).toString('hex') };
  if (typeof fetch !== 'function') throw new Error('fetch_unavailable');
  const r = await fetch(`https://www.browserbase.com/v1${endpoint}`, {
    method: 'POST', headers: { 'x-bb-api-key': key, 'content-type': 'application/json' },
    body: JSON.stringify({ projectId: project, ...body })
  });
  if (!r.ok) throw new Error(`browserbase_${r.status}`);
  return await r.json();
}

function registerCloudAdaptersRoutes(app, pool, verifyAgentAuth, auditChain) {
  const express = require('express');

  // ===== Modal GPU spawning =====
  app.post('/v1/agents/:did/modal/spawn', express.json(), async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const start = Date.now();
    try {
      const out = await modalAPI('/functions', { image: req.body?.image || 'python:3.12', gpu: req.body?.gpu || 'A10G', timeout: req.body?.timeout_seconds || 300 });
      await logCall({ pool, provider: 'modal', kind: 'spawn', agent_did: did, status: 'ok', latency_ms: Date.now() - start, external_id: out.container_id });
      if (auditChain) await auditChain.append({ event_type: 'modal.spawned', agent_did: did, container_id: out.container_id, stub: !!out.stub }).catch(() => {});
      res.status(201).json(out);
    } catch (e) {
      await logCall({ pool, provider: 'modal', kind: 'spawn', agent_did: did, status: 'error', error: e.message });
      res.status(502).json({ error: 'modal_failed', message: e.message });
    }
  });

  // ===== E2B sandbox =====
  app.post('/v1/agents/:did/e2b/sandbox', express.json(), async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    try {
      const out = await e2bAPI('/sandboxes', { template: req.body?.template || 'base' });
      await logCall({ pool, provider: 'e2b', kind: 'sandbox', agent_did: did, status: 'ok', external_id: out.sandbox_id });
      res.status(201).json(out);
    } catch (e) { res.status(502).json({ error: 'e2b_failed', message: e.message }); }
  });

  // ===== Browserbase session =====
  app.post('/v1/agents/:did/browserbase/sessions', express.json(), async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    try {
      const out = await browserbaseAPI('/sessions', { keepAlive: false });
      await logCall({ pool, provider: 'browserbase', kind: 'session', agent_did: did, status: 'ok', external_id: out.session_id });
      res.status(201).json(out);
    } catch (e) { res.status(502).json({ error: 'browserbase_failed', message: e.message }); }
  });

  // ===== Sentry error push =====
  app.post('/v1/sentry/capture', express.json(), async (req, res) => {
    const dsn = process.env.SENTRY_DSN;
    if (!dsn) return res.json({ stub: true, captured: false });
    try {
      const u = new URL(dsn);
      const projectId = u.pathname.replace('/', '');
      const r = await fetch(`https://${u.host}/api/${projectId}/store/`, {
        method: 'POST',
        headers: { 'content-type': 'application/json',
                    'x-sentry-auth': `Sentry sentry_version=7,sentry_key=${u.username}` },
        body: JSON.stringify({ message: req.body?.message || 'agent_error', level: req.body?.level || 'error', tags: req.body?.tags || {}, extra: req.body?.extra || {} })
      });
      const json = await r.json();
      await logCall({ pool, provider: 'sentry', kind: 'capture', status: r.ok ? 'ok' : 'error', external_id: json.id });
      res.json({ event_id: json.id });
    } catch (e) { res.status(502).json({ error: 'sentry_failed', message: e.message }); }
  });

  // ===== Datadog metric =====
  app.post('/v1/datadog/metric', express.json(), async (req, res) => {
    const key = process.env.DATADOG_API_KEY;
    if (!key) return res.json({ stub: true });
    try {
      const r = await fetch('https://api.datadoghq.com/api/v2/series', {
        method: 'POST', headers: { 'dd-api-key': key, 'content-type': 'application/json' },
        body: JSON.stringify({ series: [{ metric: req.body?.metric || 'openheab.event', points: [{ timestamp: Math.floor(Date.now() / 1000), value: req.body?.value || 1 }], tags: req.body?.tags || ['source:openheab'] }] })
      });
      res.json({ accepted: r.ok });
    } catch (e) { res.status(502).json({ error: 'datadog_failed', message: e.message }); }
  });

  // ===== PagerDuty incident =====
  app.post('/v1/pagerduty/trigger', express.json(), async (req, res) => {
    const key = process.env.PAGERDUTY_INTEGRATION_KEY;
    if (!key) return res.json({ stub: true });
    try {
      const r = await fetch('https://events.pagerduty.com/v2/enqueue', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          routing_key: key, event_action: 'trigger',
          payload: { summary: req.body?.summary || 'OpenHeab alert', severity: req.body?.severity || 'error', source: 'openheab', custom_details: req.body?.details || {} }
        })
      });
      const json = await r.json();
      res.json({ dedup_key: json.dedup_key });
    } catch (e) { res.status(502).json({ error: 'pagerduty_failed', message: e.message }); }
  });

  // ===== GitHub App webhook receiver =====
  app.post('/v1/_webhooks/github', express.raw({ type: 'application/json' }), async (req, res) => {
    const sig = req.headers['x-hub-signature-256'];
    const secret = process.env.GITHUB_WEBHOOK_SECRET;
    if (secret && sig) {
      const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(req.body).digest('hex');
      if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) return res.status(400).json({ error: 'signature_invalid' });
    }
    let event = {};
    try { event = JSON.parse(req.body.toString('utf8')); } catch {}
    const eventType = req.headers['x-github-event'] || 'unknown';
    if (auditChain) await auditChain.append({ event_type: 'github.webhook', github_event: eventType, action: event.action }).catch(() => {});
    res.json({ received: true });
  });

  // ===== Slack event handler =====
  // Slack signs the RAW request body (not the parsed JSON) per their spec
  // (api.slack.com/authentication/verifying-requests-from-slack). Using
  // express.raw lets us reconstruct the exact bytes Slack signed; previously
  // we signed JSON.stringify(req.body) which never matches on field reordering.
  app.post('/v1/_webhooks/slack-real', express.raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
    let body = {};
    try { body = JSON.parse(req.body.toString('utf8')); }
    catch { return res.status(400).json({ error: 'invalid_json' }); }
    if (body.type === 'url_verification') return res.json({ challenge: body.challenge });
    const sig = req.headers['x-slack-signature'];
    const ts = req.headers['x-slack-request-timestamp'];
    const secret = process.env.SLACK_SIGNING_SECRET;
    if (secret) {
      if (!sig || !ts) return res.status(401).json({ error: 'slack_signature_missing' });
      // Reject events older than 5 minutes to prevent replay attacks.
      const skew = Math.abs(Math.floor(Date.now() / 1000) - parseInt(ts));
      if (skew > 300) return res.status(401).json({ error: 'slack_timestamp_skewed' });
      const baseString = `v0:${ts}:${req.body.toString('utf8')}`;
      const expected = 'v0=' + crypto.createHmac('sha256', secret).update(baseString).digest('hex');
      const { safeTokenCompare } = require('../safe_compare');
      if (!safeTokenCompare(expected, sig)) {
        return res.status(401).json({ error: 'slack_signature_invalid' });
      }
    } else if (process.env.NODE_ENV === 'production') {
      return res.status(503).json({ error: 'slack_signing_secret_not_configured' });
    }
    if (auditChain) await auditChain.append({ event_type: 'slack.webhook', slack_event_type: body.event?.type }).catch(() => {});
    res.json({ ok: true });
  });

  // Adapter status overview
  app.get('/v1/cloud-adapters/status', (req, res) => {
    res.json({
      modal: { configured: !!(process.env.MODAL_TOKEN_ID && process.env.MODAL_TOKEN_SECRET) },
      e2b: { configured: !!process.env.E2B_API_KEY },
      browserbase: { configured: !!(process.env.BROWSERBASE_API_KEY && process.env.BROWSERBASE_PROJECT_ID) },
      sentry: { configured: !!process.env.SENTRY_DSN },
      datadog: { configured: !!process.env.DATADOG_API_KEY },
      pagerduty: { configured: !!process.env.PAGERDUTY_INTEGRATION_KEY },
      github_app: { configured: !!process.env.GITHUB_WEBHOOK_SECRET },
      slack: { configured: !!(process.env.SLACK_BOT_TOKEN && process.env.SLACK_SIGNING_SECRET) }
    });
  });
}

module.exports = { migrate, registerCloudAdaptersRoutes, modalAPI, e2bAPI, browserbaseAPI };
