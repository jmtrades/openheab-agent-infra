// ============================================================================
// tracing.js — distributed tracing for multi-step agent runs (LangSmith-
// style). Every inference call / tool invocation / sub-agent dispatch
// gets a trace_id with parent_id linking. Critical for debugging real
// production agents.
//   POST /v1/traces                — start a root trace
//   POST /v1/traces/:id/spans      — add a span (child operation)
//   POST /v1/traces/:id/end        — finalize trace + roll-up metrics
//   GET  /v1/traces                — list current agent's traces
//   GET  /v1/traces/:id            — full trace tree + spans
//   GET  /traces                   — HTML trace viewer (search + drill-in)
// ============================================================================
const crypto = require('crypto');

async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS traces (
      trace_id        TEXT PRIMARY KEY,
      agent_did       TEXT NOT NULL,
      name            TEXT NOT NULL,
      kind            TEXT NOT NULL DEFAULT 'agent_run',
      status          TEXT NOT NULL DEFAULT 'running',
      input           JSONB,
      output          JSONB,
      error           TEXT,
      started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      ended_at        TIMESTAMPTZ,
      latency_ms      INTEGER,
      span_count      INTEGER NOT NULL DEFAULT 0,
      total_tokens    INTEGER,
      total_cost_cents INTEGER,
      meta            JSONB
    );
    CREATE INDEX IF NOT EXISTS idx_traces_agent ON traces (agent_did, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_traces_status ON traces (status, started_at DESC);

    CREATE TABLE IF NOT EXISTS trace_spans (
      span_id         TEXT PRIMARY KEY,
      trace_id        TEXT NOT NULL,
      parent_span_id  TEXT,
      name            TEXT NOT NULL,
      kind            TEXT NOT NULL,
      input           JSONB,
      output          JSONB,
      error           TEXT,
      started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      ended_at        TIMESTAMPTZ,
      latency_ms      INTEGER,
      tokens          INTEGER,
      cost_cents      INTEGER,
      meta            JSONB
    );
    CREATE INDEX IF NOT EXISTS idx_trace_spans_trace
      ON trace_spans (trace_id, started_at);
  `);
}

async function resolveAgent(pool, req) {
  try { return await require('./me_endpoints').resolveAgentFromRequest(pool, req); }
  catch { return null; }
}

function newId(p) { return p + '_' + crypto.randomBytes(12).toString('hex'); }

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

function renderTracesPage() {
  return `<!doctype html><html><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>Traces — OpenHeab</title>
<meta name="description" content="Distributed trace viewer for multi-step agent runs. LangSmith-style observability.">
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Inter', sans-serif; background: #0a0a0f; color: #e7e7ee; line-height: 1.5; min-height: 100vh; }
.wrap { max-width: 1200px; margin: 0 auto; padding: 32px 24px 60px; }
.nav { display: flex; justify-content: space-between; align-items: center; margin-bottom: 28px; padding-bottom: 18px; border-bottom: 1px solid #1a1a25; }
.nav .logo { font-weight: 700; font-size: 18px; color: #fff; text-decoration: none; }
.nav .links a { color: #888; margin-left: 18px; font-size: 13px; text-decoration: none; }
.nav .links a:hover { color: #fff; }
h1 { font-size: 28px; font-weight: 700; letter-spacing: -0.5px; margin-bottom: 6px; }
.subtitle { color: #888; font-size: 14px; margin-bottom: 24px; }
.controls { background: #14141c; padding: 14px 18px; border-radius: 10px; margin-bottom: 18px; display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
.controls input { flex: 1; min-width: 220px; padding: 9px 12px; background: #0f0f17; border: 1px solid #1f1f2a; color: #fff; border-radius: 6px; font-family: monospace; font-size: 13px; outline: none; }
.controls input:focus { border-color: #4f46e5; }
.controls button { padding: 9px 18px; background: #4f46e5; color: #fff; border: 0; border-radius: 6px; font-weight: 600; cursor: pointer; font-size: 13px; }
.controls button:hover { background: #4338ca; }
.layout { display: grid; grid-template-columns: 1fr 1.6fr; gap: 14px; }
@media (max-width: 800px) { .layout { grid-template-columns: 1fr; } }
.col { background: #14141c; border: 1px solid #1a1a25; border-radius: 10px; padding: 14px 18px; min-height: 400px; }
.col h2 { font-size: 11px; color: #888; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 12px; font-weight: 600; }
.trace-row { padding: 8px 10px; margin: 2px 0; border-left: 2px solid #25253a; border-radius: 4px; cursor: pointer; font-family: 'SF Mono', monospace; font-size: 12px; }
.trace-row:hover { background: #1a1a25; }
.trace-row.active { background: #4f46e520; border-left-color: #4f46e5; }
.trace-row.error { border-left-color: #ef4444; }
.trace-row.ok { border-left-color: #22c55e; }
.trace-row .name { color: #fff; font-weight: 500; }
.trace-row .meta { color: #666; font-size: 10px; margin-top: 2px; }
.span { padding: 6px 10px; margin: 3px 0; border-left: 2px solid #25253a; border-radius: 4px; font-family: 'SF Mono', monospace; font-size: 11px; }
.span.error { border-left-color: #ef4444; }
.span.indent-1 { margin-left: 18px; }
.span.indent-2 { margin-left: 36px; }
.span.indent-3 { margin-left: 54px; }
.span .head { display: flex; gap: 8px; justify-content: space-between; }
.span .kind { color: #818cf8; font-weight: 500; }
.span .latency { color: #666; }
.empty { color: #555; font-size: 13px; padding: 24px; text-align: center; }
pre { background: #0a0a12; padding: 10px 12px; border-radius: 6px; overflow-x: auto; font-size: 11px; color: #c5c5d5; max-height: 200px; white-space: pre-wrap; word-break: break-all; }
</style></head><body><div class="wrap">

<nav class="nav">
  <a class="logo" href="/">OpenHeab</a>
  <div class="links">
    <a href="/traces" style="color:#fff">Traces</a>
    <a href="/inspector">Inspector</a>
    <a href="/dashboard">Dashboard</a>
    <a href="/docs">Docs</a>
  </div>
</nav>

<h1>Traces</h1>
<p class="subtitle">Distributed trace viewer for multi-step agent runs. Every span shows latency, tokens, cost, parent-child links.</p>

<div class="controls">
  <input id="did" placeholder="DID or API key" />
  <button onclick="load()">Load</button>
</div>

<div class="layout">
  <div class="col">
    <h2>Recent traces</h2>
    <div id="traces"><div class="empty">Paste your DID + Load to see traces</div></div>
  </div>
  <div class="col">
    <h2>Spans</h2>
    <div id="spans"><div class="empty">Select a trace on the left to see its span tree</div></div>
  </div>
</div>

</div>
<script>
let did = '', apikey = '';
function headers() {
  const h = {};
  if (apikey) h.authorization = 'Bearer ' + apikey;
  if (did) h['x-agent-did'] = did;
  return h;
}
async function load() {
  const v = document.getElementById('did').value.trim();
  if (!v) return;
  if (v.startsWith('did:')) { did = v; apikey = ''; }
  else { apikey = v; did = ''; }
  const r = await fetch('/v1/traces?limit=50', { headers: headers() });
  if (!r.ok) { document.getElementById('traces').innerHTML = '<div class="empty">Auth failed</div>'; return; }
  const j = await r.json();
  if (!j.traces?.length) { document.getElementById('traces').innerHTML = '<div class="empty">No traces yet. POST /v1/traces to create one.</div>'; return; }
  document.getElementById('traces').innerHTML = j.traces.map(t => {
    const cls = t.error ? 'error' : t.status === 'completed' ? 'ok' : '';
    return '<div class="trace-row ' + cls + '" onclick="loadTrace(\\'' + t.trace_id + '\\', this)">' +
      '<div class="name">' + escapeHtml(t.name) + '</div>' +
      '<div class="meta">' + (t.latency_ms || '-') + 'ms · ' + (t.span_count || 0) + ' spans · ' + escapeHtml(t.status) + '</div>' +
    '</div>';
  }).join('');
}
async function loadTrace(traceId, el) {
  document.querySelectorAll('.trace-row').forEach(r => r.classList.remove('active'));
  el.classList.add('active');
  const r = await fetch('/v1/traces/' + traceId, { headers: headers() });
  const j = await r.json();
  if (!j.spans?.length) { document.getElementById('spans').innerHTML = '<div class="empty">No spans in this trace yet</div>'; return; }
  // Order spans by started_at; indent by parent depth (simplified — first-level only)
  const byId = {};
  j.spans.forEach(s => { byId[s.span_id] = s; });
  const depth = s => {
    let d = 0; let cur = s.parent_span_id;
    while (cur && byId[cur] && d < 3) { d++; cur = byId[cur].parent_span_id; }
    return d;
  };
  document.getElementById('spans').innerHTML =
    '<pre>input: ' + escapeHtml(JSON.stringify(j.input || {}, null, 2)) + '</pre>' +
    j.spans.sort((a, b) => new Date(a.started_at) - new Date(b.started_at)).map(s => {
      const cls = s.error ? 'error' : '';
      const ind = depth(s);
      return '<div class="span ' + cls + ' indent-' + ind + '">' +
        '<div class="head"><span class="kind">' + escapeHtml(s.kind) + ' · ' + escapeHtml(s.name) + '</span>' +
        '<span class="latency">' + (s.latency_ms || '-') + 'ms · ' + (s.tokens || 0) + ' tok</span></div>' +
        (s.error ? '<div style="color:#fca5a5;margin-top:4px">' + escapeHtml(s.error) + '</div>' : '') +
      '</div>';
    }).join('') +
    (j.output ? '<pre>output: ' + escapeHtml(JSON.stringify(j.output, null, 2)) + '</pre>' : '');
}
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }
</script>
</body></html>`;
}

function registerTracingRoutes(app, pool, verifyAgentAuth, auditChain) {
  const express = require('express');

  // POST /v1/traces — start a trace
  app.post('/v1/traces', express.json({ limit: '4mb' }), async (req, res) => {
    const ctx = await resolveAgent(pool, req);
    if (!ctx) return res.status(401).json({ error: 'unauthenticated' });
    const { name, kind, input, meta } = req.body || {};
    if (!name) return res.status(400).json({ error: 'name_required' });
    const id = newId('trc');
    await pool.query(
      `INSERT INTO traces (trace_id, agent_did, name, kind, input, meta, status) VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,'running')`,
      [id, ctx.did, String(name).slice(0, 200), String(kind || 'agent_run').slice(0, 50),
       input ? JSON.stringify(input) : null,
       meta ? JSON.stringify(meta) : null]
    );
    res.status(201).json({ trace_id: id, started_at: new Date().toISOString() });
  });

  // POST /v1/traces/:id/spans — add a span
  app.post('/v1/traces/:id/spans', express.json({ limit: '4mb' }), async (req, res) => {
    const ctx = await resolveAgent(pool, req);
    if (!ctx) return res.status(401).json({ error: 'unauthenticated' });
    // Verify ownership
    const own = await pool.query(`SELECT agent_did FROM traces WHERE trace_id=$1`, [req.params.id]).catch(() => ({ rows: [] }));
    if (!own.rows[0]) return res.status(404).json({ error: 'trace_not_found' });
    if (own.rows[0].agent_did !== ctx.did) return res.status(403).json({ error: 'not_owner' });

    const { name, kind, parent_span_id, input, output, error, latency_ms, tokens, cost_cents, meta } = req.body || {};
    if (!name || !kind) return res.status(400).json({ error: 'name_and_kind_required' });
    const spanId = newId('spn');
    await pool.query(
      `INSERT INTO trace_spans (span_id, trace_id, parent_span_id, name, kind, input, output, error, started_at, ended_at, latency_ms, tokens, cost_cents, meta)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,NOW() - ($9 || ' milliseconds')::interval, NOW(),$9,$10,$11,$12::jsonb)`,
      [spanId, req.params.id, parent_span_id || null,
       String(name).slice(0, 200), String(kind).slice(0, 50),
       input ? JSON.stringify(input) : null,
       output ? JSON.stringify(output) : null,
       error ? String(error).slice(0, 2000) : null,
       parseInt(latency_ms) || 0,
       parseInt(tokens) || null, parseInt(cost_cents) || null,
       meta ? JSON.stringify(meta) : null]
    );
    // Bump trace.span_count
    await pool.query(`UPDATE traces SET span_count = span_count + 1 WHERE trace_id=$1`, [req.params.id]).catch(() => {});
    res.status(201).json({ span_id: spanId, trace_id: req.params.id });
  });

  // POST /v1/traces/:id/end — finalize
  app.post('/v1/traces/:id/end', express.json({ limit: '4mb' }), async (req, res) => {
    const ctx = await resolveAgent(pool, req);
    if (!ctx) return res.status(401).json({ error: 'unauthenticated' });
    const own = await pool.query(`SELECT agent_did, started_at FROM traces WHERE trace_id=$1`, [req.params.id]).catch(() => ({ rows: [] }));
    if (!own.rows[0]) return res.status(404).json({ error: 'trace_not_found' });
    if (own.rows[0].agent_did !== ctx.did) return res.status(403).json({ error: 'not_owner' });

    const { output, error, status } = req.body || {};
    const latencyMs = Date.now() - new Date(own.rows[0].started_at).getTime();
    // Roll up totals from spans
    const rolling = await pool.query(
      `SELECT COALESCE(SUM(tokens),0)::int AS tokens, COALESCE(SUM(cost_cents),0)::int AS cost
       FROM trace_spans WHERE trace_id=$1`, [req.params.id]
    ).catch(() => ({ rows: [{ tokens: 0, cost: 0 }] }));
    await pool.query(
      `UPDATE traces SET status=$1, output=$2::jsonb, error=$3, ended_at=NOW(), latency_ms=$4, total_tokens=$5, total_cost_cents=$6 WHERE trace_id=$7`,
      [error ? 'errored' : (status || 'completed'),
       output ? JSON.stringify(output) : null, error ? String(error).slice(0, 2000) : null,
       latencyMs, rolling.rows[0]?.tokens || 0, rolling.rows[0]?.cost || 0,
       req.params.id]
    );
    if (auditChain) auditChain.append({
      event_type: 'trace.completed', trace_id: req.params.id, agent_did: ctx.did,
      latency_ms: latencyMs, tokens: rolling.rows[0]?.tokens, status: error ? 'errored' : 'completed'
    }).catch(() => {});
    res.json({ trace_id: req.params.id, latency_ms: latencyMs, status: error ? 'errored' : 'completed' });
  });

  // GET /v1/traces — list
  app.get('/v1/traces', async (req, res) => {
    const ctx = await resolveAgent(pool, req);
    if (!ctx) return res.status(401).json({ error: 'unauthenticated' });
    const limit = Math.min(parseInt(req.query.limit) || 50, 500);
    const r = await pool.query(
      `SELECT trace_id, name, kind, status, started_at, ended_at, latency_ms, span_count, total_tokens, total_cost_cents, error
       FROM traces WHERE agent_did=$1 ORDER BY started_at DESC LIMIT $2`, [ctx.did, limit]
    ).catch(() => ({ rows: [] }));
    res.json({ did: ctx.did, traces: r.rows });
  });

  // GET /v1/traces/:id — full trace + spans
  app.get('/v1/traces/:id', async (req, res) => {
    const ctx = await resolveAgent(pool, req);
    if (!ctx) return res.status(401).json({ error: 'unauthenticated' });
    const t = await pool.query(`SELECT * FROM traces WHERE trace_id=$1 AND agent_did=$2`, [req.params.id, ctx.did])
      .catch(() => ({ rows: [] }));
    if (!t.rows[0]) return res.status(404).json({ error: 'not_found' });
    const spans = await pool.query(
      `SELECT span_id, parent_span_id, name, kind, input, output, error, started_at, ended_at, latency_ms, tokens, cost_cents
       FROM trace_spans WHERE trace_id=$1 ORDER BY started_at ASC LIMIT 1000`, [req.params.id]
    ).catch(() => ({ rows: [] }));
    res.json({ ...t.rows[0], spans: spans.rows });
  });

  // GET /traces — HTML viewer
  app.get('/traces', (req, res) => {
    res.set('content-type', 'text/html; charset=utf-8');
    res.set('cache-control', 'public, max-age=300');
    res.send(renderTracesPage());
  });
}

module.exports = { migrate, registerTracingRoutes };
