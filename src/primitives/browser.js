// ============================================================================
// OpenHeab Browser — Headless browser fleet (Browserbase-style abstraction)
// Sessions + actions (navigate/click/type/screenshot/extract).
// ============================================================================
const express = require('express');
const cryptoLib = require('crypto');
const { z } = require('zod');

function tryRequire(name) {
  try { return require(name); } catch { return null; }
}

function pickProvider() {
  if (process.env.BROWSERBASE_API_KEY) return 'browserbase';
  if (process.env.ANCHOR_API_KEY) return 'anchor';
  return 'local';
}

function genSessionId() {
  return 'brw_' + cryptoLib.randomBytes(12).toString('hex');
}
function genActionId() {
  return 'brwa_' + cryptoLib.randomBytes(12).toString('hex');
}

// ----------------------------------------------------------------------------
// Migration
// ----------------------------------------------------------------------------
async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS browser_sessions (
      session_id    TEXT PRIMARY KEY,
      agent_did     TEXT NOT NULL,
      status        TEXT NOT NULL DEFAULT 'active',
      provider      TEXT NOT NULL DEFAULT 'local',
      browser_id    TEXT,
      region        TEXT,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      terminated_at TIMESTAMPTZ,
      metadata      JSONB
    );
    CREATE INDEX IF NOT EXISTS idx_browser_sessions_did
      ON browser_sessions (agent_did, created_at DESC);

    CREATE TABLE IF NOT EXISTS browser_actions (
      action_id    TEXT PRIMARY KEY,
      session_id   TEXT NOT NULL,
      agent_did    TEXT NOT NULL,
      kind         TEXT NOT NULL,
      payload      JSONB,
      result       JSONB,
      duration_ms  INTEGER NOT NULL DEFAULT 0,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_browser_actions_session
      ON browser_actions (session_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_browser_actions_did
      ON browser_actions (agent_did, created_at DESC);
  `);
}

// ----------------------------------------------------------------------------
// Provider proxies
// ----------------------------------------------------------------------------
async function providerCreate(provider, region) {
  if (provider === 'browserbase') {
    try {
      const r = await fetch('https://api.browserbase.com/v1/sessions', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-bb-api-key': process.env.BROWSERBASE_API_KEY,
          'x-bb-project-id': process.env.BROWSERBASE_PROJECT_ID || ''
        },
        body: JSON.stringify({ projectId: process.env.BROWSERBASE_PROJECT_ID, region })
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.message || 'browserbase_create_failed');
      return { browser_id: j.id || j.sessionId, region: j.region || region || null };
    } catch (e) {
      return { browser_id: null, region: null, error: e.message };
    }
  }
  return { browser_id: null, region: region || null };
}

async function providerAct(provider, browserId, kind, payload) {
  const start = Date.now();
  if (provider === 'browserbase' && browserId) {
    try {
      const r = await fetch(`https://api.browserbase.com/v1/sessions/${browserId}/${kind}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-bb-api-key': process.env.BROWSERBASE_API_KEY
        },
        body: JSON.stringify(payload || {})
      });
      const j = await r.json().catch(() => ({}));
      return { result: j, duration_ms: Date.now() - start, error: r.ok ? null : (j?.message || 'browser_error') };
    } catch (e) {
      return { result: null, duration_ms: Date.now() - start, error: e.message };
    }
  }
  // Local stub
  if (kind === 'screenshot') {
    return {
      result: { image_base64: '', note: 'browser not configured' },
      duration_ms: Date.now() - start
    };
  }
  if (kind === 'extract') {
    return {
      result: { text: '', note: 'browser not configured' },
      duration_ms: Date.now() - start
    };
  }
  return { result: { ok: false, note: 'browser not configured' }, duration_ms: Date.now() - start };
}

async function providerTerminate(provider, browserId) {
  if (provider === 'browserbase' && browserId) {
    try {
      await fetch(`https://api.browserbase.com/v1/sessions/${browserId}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-bb-api-key': process.env.BROWSERBASE_API_KEY
        },
        body: JSON.stringify({ status: 'REQUEST_RELEASE' })
      });
    } catch {}
  }
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------
async function loadSession(pool, sessionId, did) {
  const r = await pool.query(`
    SELECT session_id, agent_did, status, provider, browser_id, region
    FROM browser_sessions WHERE session_id=$1 AND agent_did=$2
  `, [sessionId, did]).catch(() => ({ rows: [] }));
  return r.rows[0] || null;
}

async function recordAction(pool, sessionId, did, kind, payload, result, duration_ms) {
  const actionId = genActionId();
  await pool.query(`
    INSERT INTO browser_actions
    (action_id, session_id, agent_did, kind, payload, result, duration_ms)
    VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7)
  `, [actionId, sessionId, did, kind,
      payload ? JSON.stringify(payload) : null,
      result ? JSON.stringify(result) : null, duration_ms]);
  return actionId;
}

// ----------------------------------------------------------------------------
// Schemas
// ----------------------------------------------------------------------------
const CreateSessionSchema = z.object({
  region: z.string().max(64).optional(),
  metadata: z.record(z.any()).optional()
});
const NavigateSchema = z.object({ url: z.string().url() });
const ClickSchema = z.object({ selector: z.string().min(1).max(2048) });
const TypeSchema = z.object({
  selector: z.string().min(1).max(2048),
  text: z.string().max(100_000)
});
const ScreenshotSchema = z.object({
  full_page: z.boolean().optional(),
  selector: z.string().max(2048).optional()
}).default({});
const ExtractSchema = z.object({ selector: z.string().min(1).max(2048) });

// ----------------------------------------------------------------------------
// Routes
// ----------------------------------------------------------------------------
function registerBrowserRoutes(app, pool, verifyAgentAuth, auditChain) {
  const cost = tryRequire('./cost');

  function chargeCost(did, provider, duration_ms, refId) {
    if (!cost || typeof cost.recordCost !== 'function') return;
    const cents = Math.max(1, Math.ceil(duration_ms / 50000));
    cost.recordCost(pool, {
      agent_did: did, resource_type: 'browser', provider,
      amount_cents: cents, units: duration_ms, unit_type: 'ms',
      reference_id: refId
    }).catch(e => console.warn('[browser.cost]', e.message));
  }

  // POST start
  app.post('/v1/agents/:did/browser/sessions', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const parse = CreateSessionSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });

      const sessionId = genSessionId();
      const provider = pickProvider();
      const created = await providerCreate(provider, parse.data.region);

      await pool.query(`
        INSERT INTO browser_sessions
        (session_id, agent_did, status, provider, browser_id, region, metadata)
        VALUES ($1, $2, 'active', $3, $4, $5, $6::jsonb)
      `, [sessionId, did, provider, created.browser_id, created.region,
          parse.data.metadata ? JSON.stringify(parse.data.metadata) : null]);

      await auditChain.append({
        event_type: 'browser.session_created',
        session_id: sessionId, agent_did: did, provider,
        timestamp: new Date().toISOString()
      });

      return res.status(201).json({
        session_id: sessionId, agent_did: did, status: 'active',
        provider, browser_id: created.browser_id, region: created.region
      });
    } catch (e) {
      console.error('[browser.create]', e);
      return res.status(500).json({ error: 'create_failed', message: e.message });
    }
  });

  // GET list
  app.get('/v1/agents/:did/browser/sessions', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    const r = await pool.query(`
      SELECT session_id, agent_did, status, provider, browser_id, region,
             created_at, terminated_at
      FROM browser_sessions WHERE agent_did=$1
      ORDER BY created_at DESC LIMIT $2
    `, [did, limit]).catch(() => ({ rows: [] }));
    return res.json({ sessions: r.rows, count: r.rows.length });
  });

  // Action helper
  async function runAction(req, res, kind, schema) {
    try {
      const did = req.params.did;
      const sessionId = req.params.id;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const parse = schema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });

      const session = await loadSession(pool, sessionId, did);
      if (!session) return res.status(404).json({ error: 'session_not_found' });
      if (session.status !== 'active') return res.status(409).json({ error: 'session_not_active' });

      const out = await providerAct(session.provider, session.browser_id, kind, parse.data);
      const actionId = await recordAction(pool, sessionId, did, kind, parse.data, out.result, out.duration_ms);

      await auditChain.append({
        event_type: `browser.${kind}`,
        action_id: actionId, session_id: sessionId, agent_did: did,
        timestamp: new Date().toISOString()
      });

      chargeCost(did, session.provider, out.duration_ms, actionId);
      return res.json({
        action_id: actionId, kind, result: out.result,
        duration_ms: out.duration_ms, error: out.error || null
      });
    } catch (e) {
      console.error(`[browser.${kind}]`, e);
      return res.status(500).json({ error: 'action_failed', message: e.message });
    }
  }

  app.post('/v1/agents/:did/browser/sessions/:id/navigate', express.json(), (req, res) =>
    runAction(req, res, 'navigate', NavigateSchema));
  app.post('/v1/agents/:did/browser/sessions/:id/click', express.json(), (req, res) =>
    runAction(req, res, 'click', ClickSchema));
  app.post('/v1/agents/:did/browser/sessions/:id/type', express.json(), (req, res) =>
    runAction(req, res, 'type', TypeSchema));
  app.post('/v1/agents/:did/browser/sessions/:id/screenshot', express.json(), (req, res) =>
    runAction(req, res, 'screenshot', ScreenshotSchema));
  app.post('/v1/agents/:did/browser/sessions/:id/extract', express.json(), (req, res) =>
    runAction(req, res, 'extract', ExtractSchema));

  // POST terminate
  app.post('/v1/agents/:did/browser/sessions/:id/terminate', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const sessionId = req.params.id;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const session = await loadSession(pool, sessionId, did);
      if (!session) return res.status(404).json({ error: 'session_not_found' });

      await providerTerminate(session.provider, session.browser_id);
      await pool.query(`
        UPDATE browser_sessions SET status='terminated', terminated_at=NOW()
        WHERE session_id=$1
      `, [sessionId]);

      await auditChain.append({
        event_type: 'browser.session_terminated',
        session_id: sessionId, agent_did: did,
        timestamp: new Date().toISOString()
      });
      return res.json({ session_id: sessionId, status: 'terminated' });
    } catch (e) {
      console.error('[browser.terminate]', e);
      return res.status(500).json({ error: 'terminate_failed', message: e.message });
    }
  });
}

module.exports = {
  migrate,
  registerBrowserRoutes,
  pickProvider,
  providerCreate,
  providerAct,
  providerTerminate
};
