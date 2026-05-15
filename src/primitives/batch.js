// ============================================================================
// batch.js — bulk operations for high-volume agents. AGI-class agents need
// to do thousands of ops/sec; making 1,000 separate HTTP calls is wasteful.
//
// POST /v1/batch
//   body: { requests: [{ method, path, body?, idempotency_key? }, ...] }
//   returns: { results: [{ status, body }, ...], elapsed_ms }
//
// Up to 500 requests per batch. Each runs in parallel with concurrency cap.
// Per-request errors don't fail the batch — caller gets per-result status.
// ============================================================================
const crypto = require('crypto');
const { z } = require('zod');

const MAX_BATCH = 500;
const DEFAULT_CONCURRENCY = 20;

async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS batch_runs (
      run_id            TEXT PRIMARY KEY,
      agent_did         TEXT,
      request_count     INTEGER NOT NULL,
      success_count     INTEGER NOT NULL DEFAULT 0,
      failure_count     INTEGER NOT NULL DEFAULT 0,
      elapsed_ms        INTEGER,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

function newId(p) { return p + '_' + crypto.randomBytes(10).toString('hex'); }

const reqSchema = z.object({
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
  path: z.string().min(1).max(2000),
  body: z.any().optional(),
  headers: z.record(z.string()).optional(),
  idempotency_key: z.string().optional()
});

const batchSchema = z.object({
  requests: z.array(reqSchema).min(1).max(MAX_BATCH),
  concurrency: z.number().int().min(1).max(50).optional(),
  stop_on_first_error: z.boolean().optional()
});

async function executeOne(base, req, defaultHeaders) {
  const url = base + req.path;
  const headers = { 'content-type': 'application/json', ...defaultHeaders, ...(req.headers || {}) };
  if (req.idempotency_key) headers['x-idempotency-key'] = req.idempotency_key;
  try {
    if (typeof fetch !== 'function') return { status: 503, body: { error: 'fetch_unavailable' } };
    const r = await fetch(url, {
      method: req.method, headers,
      body: req.body && req.method !== 'GET' ? JSON.stringify(req.body) : undefined
    });
    let body;
    const ct = r.headers.get('content-type') || '';
    if (ct.includes('application/json')) {
      try { body = await r.json(); } catch { body = null; }
    } else { body = await r.text(); }
    return { status: r.status, ok: r.ok, body };
  } catch (e) {
    return { status: 502, ok: false, body: { error: 'fetch_failed', message: e.message } };
  }
}

// Concurrency-limited Promise.all
async function runWithConcurrency(items, fn, concurrency) {
  const results = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

function registerBatchRoutes(app, pool, verifyAgentAuth, auditChain) {
  const express = require('express');

  app.post('/v1/batch', express.json({ limit: '20mb' }), async (req, res) => {
    const did = req.headers['x-agent-did'];
    if (did) {
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
    }
    const p = batchSchema.safeParse(req.body || {});
    if (!p.success) return res.status(400).json({ error: 'invalid_input', details: p.error.flatten() });

    const runId = newId('batch');
    const start = Date.now();
    const base = process.env.OPERATOR_PUBLIC_URL || ('http://localhost:' + (process.env.PORT || 3000));
    const defaultHeaders = {};
    if (req.headers.authorization) defaultHeaders.authorization = req.headers.authorization;
    if (did) defaultHeaders['x-agent-did'] = did;

    let abort = false;
    const results = await runWithConcurrency(
      p.data.requests,
      async (req2) => {
        if (abort) return { status: 0, ok: false, body: { error: 'aborted' } };
        const out = await executeOne(base, req2, defaultHeaders);
        if (!out.ok && p.data.stop_on_first_error) abort = true;
        return out;
      },
      p.data.concurrency || DEFAULT_CONCURRENCY
    );

    const elapsed = Date.now() - start;
    const succ = results.filter(r => r.ok).length;
    const fail = results.length - succ;
    await pool.query(
      `INSERT INTO batch_runs (run_id, agent_did, request_count, success_count, failure_count, elapsed_ms)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [runId, did || null, p.data.requests.length, succ, fail, elapsed]
    ).catch(() => {});

    if (auditChain && did) await auditChain.append({
      event_type: 'batch.executed', run_id: runId, agent_did: did,
      request_count: p.data.requests.length, success_count: succ, elapsed_ms: elapsed
    }).catch(() => {});

    res.json({
      run_id: runId, elapsed_ms: elapsed,
      total: results.length, success: succ, failure: fail,
      results
    });
  });

  // Parallel "fanout" — same request body, many DIDs
  app.post('/v1/batch/fanout', express.json({ limit: '10mb' }), async (req, res) => {
    const did = req.headers['x-agent-did'];
    if (did) {
      const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
      if (!auth.valid) return res.status(401).json({ error: auth.error });
    }
    const { template_method, template_path, dids, template_body } = req.body || {};
    if (!template_method || !template_path || !Array.isArray(dids)) {
      return res.status(400).json({ error: 'template_method_path_and_dids_required' });
    }
    if (dids.length > MAX_BATCH) return res.status(400).json({ error: `max_${MAX_BATCH}_dids` });

    const requests = dids.map(d => ({
      method: template_method,
      path: template_path.replace(':did', encodeURIComponent(d)),
      body: template_body
    }));

    // Reuse the batch handler by re-invoking executeOne directly
    const base = process.env.OPERATOR_PUBLIC_URL || ('http://localhost:' + (process.env.PORT || 3000));
    const defaultHeaders = req.headers.authorization ? { authorization: req.headers.authorization } : {};
    const start = Date.now();
    const results = await runWithConcurrency(requests, r => executeOne(base, r, defaultHeaders), DEFAULT_CONCURRENCY);
    res.json({ fanout_count: dids.length, elapsed_ms: Date.now() - start, results });
  });

  app.get('/v1/batch/runs/:rid', async (req, res) => {
    const r = await pool.query(`SELECT * FROM batch_runs WHERE run_id=$1`, [req.params.rid]).catch(() => ({ rows: [] }));
    if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
    res.json(r.rows[0]);
  });
}

module.exports = { migrate, registerBatchRoutes, MAX_BATCH };
