// ============================================================================
// OpenHeab Sandbox — Code execution sandbox (E2B-style abstraction)
// Multi-provider: E2B, Modal, local stub. Sessions + executions tracked.
// ============================================================================
const express = require('express');
const cryptoLib = require('crypto');
const { z } = require('zod');

const SUPPORTED_LANGUAGES = ['python', 'node', 'bash', 'r'];
const TERMINAL_STATUSES = new Set(['terminated', 'failed']);

function tryRequire(name) {
  try { return require(name); } catch { return null; }
}

function pickProvider() {
  if (process.env.E2B_API_KEY) return 'e2b';
  if (process.env.MODAL_API_KEY) return 'modal';
  return 'local';
}

function genSessionId() {
  return 'sbx_' + cryptoLib.randomBytes(12).toString('hex');
}
function genExecutionId() {
  return 'sxe_' + cryptoLib.randomBytes(12).toString('hex');
}

// ----------------------------------------------------------------------------
// Migration
// ----------------------------------------------------------------------------
async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sandbox_sessions (
      session_id      TEXT PRIMARY KEY,
      agent_did       TEXT NOT NULL,
      language        TEXT NOT NULL,
      status          TEXT NOT NULL DEFAULT 'active',
      provider        TEXT NOT NULL DEFAULT 'local',
      provider_ref    TEXT,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      terminated_at   TIMESTAMPTZ,
      total_cpu_ms    BIGINT NOT NULL DEFAULT 0,
      total_memory_mb BIGINT NOT NULL DEFAULT 0,
      metadata        JSONB
    );
    CREATE INDEX IF NOT EXISTS idx_sandbox_sessions_did
      ON sandbox_sessions (agent_did, created_at DESC);

    CREATE TABLE IF NOT EXISTS sandbox_executions (
      execution_id TEXT PRIMARY KEY,
      session_id   TEXT NOT NULL,
      agent_did    TEXT NOT NULL,
      code         TEXT NOT NULL,
      stdout       TEXT,
      stderr       TEXT,
      exit_code    INTEGER,
      duration_ms  INTEGER NOT NULL DEFAULT 0,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_sandbox_executions_did
      ON sandbox_executions (agent_did, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_sandbox_executions_session
      ON sandbox_executions (session_id, created_at DESC);
  `);
}

// ----------------------------------------------------------------------------
// Provider proxies
// ----------------------------------------------------------------------------
async function providerCreateSession(provider, language) {
  if (provider === 'e2b') {
    try {
      const r = await fetch('https://api.e2b.dev/sandboxes', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'authorization': `Bearer ${process.env.E2B_API_KEY}`
        },
        body: JSON.stringify({ template: language === 'python' ? 'base' : language })
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.message || 'e2b_create_failed');
      return { provider_ref: j.sandboxID || j.id || null };
    } catch (e) {
      return { provider_ref: null, error: e.message };
    }
  }
  if (provider === 'modal') {
    return { provider_ref: 'modal_' + cryptoLib.randomBytes(6).toString('hex') };
  }
  return { provider_ref: null };
}

async function providerExec(provider, providerRef, language, code) {
  const start = Date.now();
  if (provider === 'e2b' && providerRef) {
    try {
      const r = await fetch(`https://api.e2b.dev/sandboxes/${providerRef}/exec`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'authorization': `Bearer ${process.env.E2B_API_KEY}`
        },
        body: JSON.stringify({ language, code })
      });
      const j = await r.json().catch(() => ({}));
      return {
        stdout: j.stdout || '',
        stderr: j.stderr || (r.ok ? '' : (j?.message || 'e2b_error')),
        exit_code: typeof j.exit_code === 'number' ? j.exit_code : (r.ok ? 0 : 1),
        duration_ms: Date.now() - start
      };
    } catch (e) {
      return { stdout: '', stderr: e.message, exit_code: 1, duration_ms: Date.now() - start };
    }
  }
  if (provider === 'modal' && providerRef) {
    try {
      const r = await fetch('https://api.modal.com/v1/sandbox/exec', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'authorization': `Bearer ${process.env.MODAL_API_KEY}`
        },
        body: JSON.stringify({ sandbox_id: providerRef, language, code })
      });
      const j = await r.json().catch(() => ({}));
      return {
        stdout: j.stdout || '',
        stderr: j.stderr || '',
        exit_code: typeof j.exit_code === 'number' ? j.exit_code : 0,
        duration_ms: Date.now() - start
      };
    } catch (e) {
      return { stdout: '', stderr: e.message, exit_code: 1, duration_ms: Date.now() - start };
    }
  }
  // Local stub
  return {
    stdout: '',
    stderr: 'sandbox not configured',
    exit_code: 127,
    duration_ms: Date.now() - start
  };
}

async function providerTerminate(provider, providerRef) {
  if (provider === 'e2b' && providerRef) {
    try {
      await fetch(`https://api.e2b.dev/sandboxes/${providerRef}`, {
        method: 'DELETE',
        headers: { 'authorization': `Bearer ${process.env.E2B_API_KEY}` }
      });
    } catch {}
  }
  if (provider === 'modal' && providerRef) {
    try {
      await fetch(`https://api.modal.com/v1/sandbox/${providerRef}`, {
        method: 'DELETE',
        headers: { 'authorization': `Bearer ${process.env.MODAL_API_KEY}` }
      });
    } catch {}
  }
}

// ----------------------------------------------------------------------------
// Schemas
// ----------------------------------------------------------------------------
const CreateSessionSchema = z.object({
  language: z.enum(['python', 'node', 'bash', 'r']),
  metadata: z.record(z.any()).optional()
});

const ExecSchema = z.object({
  code: z.string().min(1).max(1_000_000)
});

// ----------------------------------------------------------------------------
// Routes
// ----------------------------------------------------------------------------
function registerSandboxRoutes(app, pool, verifyAgentAuth, auditChain) {
  const cost = tryRequire('./cost');

  // POST /v1/agents/:did/sandbox/sessions
  app.post('/v1/agents/:did/sandbox/sessions', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const parse = CreateSessionSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;

      const sessionId = genSessionId();
      const provider = pickProvider();
      const createRes = await providerCreateSession(provider, d.language);

      await pool.query(`
        INSERT INTO sandbox_sessions
        (session_id, agent_did, language, status, provider, provider_ref, metadata)
        VALUES ($1, $2, $3, 'active', $4, $5, $6::jsonb)
      `, [sessionId, did, d.language, provider, createRes.provider_ref,
          d.metadata ? JSON.stringify(d.metadata) : null]);

      await auditChain.append({
        event_type: 'sandbox.session_created',
        session_id: sessionId, agent_did: did, language: d.language, provider,
        timestamp: new Date().toISOString()
      });

      return res.status(201).json({
        session_id: sessionId, agent_did: did, language: d.language,
        status: 'active', provider, provider_ref: createRes.provider_ref
      });
    } catch (e) {
      console.error('[sandbox.session.create]', e);
      return res.status(500).json({ error: 'session_creation_failed', message: e.message });
    }
  });

  // GET /v1/agents/:did/sandbox/sessions
  app.get('/v1/agents/:did/sandbox/sessions', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });

    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    const r = await pool.query(`
      SELECT session_id, agent_did, language, status, provider,
             created_at, terminated_at, total_cpu_ms, total_memory_mb
      FROM sandbox_sessions
      WHERE agent_did = $1
      ORDER BY created_at DESC
      LIMIT $2
    `, [did, limit]).catch(() => ({ rows: [] }));
    return res.json({ sessions: r.rows, count: r.rows.length });
  });

  // POST /v1/agents/:did/sandbox/sessions/:id/exec
  app.post('/v1/agents/:did/sandbox/sessions/:id/exec', express.json({ limit: '2mb' }), async (req, res) => {
    try {
      const did = req.params.did;
      const sessionId = req.params.id;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const parse = ExecSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });

      const sr = await pool.query(`
        SELECT session_id, language, status, provider, provider_ref
        FROM sandbox_sessions WHERE session_id=$1 AND agent_did=$2
      `, [sessionId, did]).catch(() => ({ rows: [] }));
      if (!sr.rows[0]) return res.status(404).json({ error: 'session_not_found' });
      const session = sr.rows[0];
      if (TERMINAL_STATUSES.has(session.status)) {
        return res.status(409).json({ error: 'session_not_active', status: session.status });
      }

      const execResult = await providerExec(session.provider, session.provider_ref, session.language, parse.data.code);
      const execId = genExecutionId();

      await pool.query(`
        INSERT INTO sandbox_executions
        (execution_id, session_id, agent_did, code, stdout, stderr, exit_code, duration_ms)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      `, [execId, sessionId, did, parse.data.code,
          execResult.stdout, execResult.stderr, execResult.exit_code, execResult.duration_ms]);

      await pool.query(`
        UPDATE sandbox_sessions
        SET total_cpu_ms = total_cpu_ms + $2
        WHERE session_id = $1
      `, [sessionId, execResult.duration_ms]).catch(() => {});

      await auditChain.append({
        event_type: 'sandbox.code_executed',
        execution_id: execId, session_id: sessionId, agent_did: did,
        exit_code: execResult.exit_code, duration_ms: execResult.duration_ms,
        timestamp: new Date().toISOString()
      });

      // Cost: charge by duration_ms. Rough rate: ~$0.0001 per CPU-second => 0.01 cents per second
      const costCents = Math.max(1, Math.ceil(execResult.duration_ms / 100000));
      if (cost && typeof cost.recordCost === 'function') {
        try {
          await cost.recordCost(pool, {
            agent_did: did, resource_type: 'sandbox',
            provider: session.provider,
            amount_cents: costCents,
            units: execResult.duration_ms,
            unit_type: 'ms',
            reference_id: execId
          });
        } catch (e) { console.warn('[sandbox.cost]', e.message); }
      }

      return res.json({
        execution_id: execId, session_id: sessionId,
        stdout: execResult.stdout, stderr: execResult.stderr,
        exit_code: execResult.exit_code, duration_ms: execResult.duration_ms,
        cost_cents: costCents
      });
    } catch (e) {
      console.error('[sandbox.exec]', e);
      return res.status(500).json({ error: 'exec_failed', message: e.message });
    }
  });

  // POST /v1/agents/:did/sandbox/sessions/:id/terminate
  app.post('/v1/agents/:did/sandbox/sessions/:id/terminate', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const sessionId = req.params.id;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const sr = await pool.query(`
        SELECT session_id, status, provider, provider_ref
        FROM sandbox_sessions WHERE session_id=$1 AND agent_did=$2
      `, [sessionId, did]).catch(() => ({ rows: [] }));
      if (!sr.rows[0]) return res.status(404).json({ error: 'session_not_found' });

      await providerTerminate(sr.rows[0].provider, sr.rows[0].provider_ref);
      await pool.query(`
        UPDATE sandbox_sessions
        SET status='terminated', terminated_at=NOW()
        WHERE session_id=$1
      `, [sessionId]);

      await auditChain.append({
        event_type: 'sandbox.session_terminated',
        session_id: sessionId, agent_did: did,
        timestamp: new Date().toISOString()
      });

      return res.json({ session_id: sessionId, status: 'terminated' });
    } catch (e) {
      console.error('[sandbox.terminate]', e);
      return res.status(500).json({ error: 'terminate_failed', message: e.message });
    }
  });

  // GET /v1/agents/:did/sandbox/executions
  app.get('/v1/agents/:did/sandbox/executions', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });

    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    const sessionId = req.query.session_id;
    const params = [did, limit];
    let where = `WHERE agent_did = $1`;
    if (sessionId) {
      params.splice(1, 0, sessionId);
      where = `WHERE agent_did = $1 AND session_id = $2`;
      params[2] = limit;
    }
    const r = await pool.query(`
      SELECT execution_id, session_id, agent_did, exit_code, duration_ms,
             LEFT(stdout, 4096) AS stdout, LEFT(stderr, 4096) AS stderr, created_at
      FROM sandbox_executions
      ${where}
      ORDER BY created_at DESC
      LIMIT $${params.length}
    `, params).catch(() => ({ rows: [] }));
    return res.json({ executions: r.rows, count: r.rows.length });
  });
}

module.exports = {
  migrate,
  registerSandboxRoutes,
  pickProvider,
  providerCreateSession,
  providerExec,
  providerTerminate
};
