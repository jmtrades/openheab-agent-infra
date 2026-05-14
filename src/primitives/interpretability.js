// ============================================================================
// OpenHeab Interpretability — Explain agent decisions
// Tables: decision_records, decision_traces, decision_explanations
// AGI transparency: bookkeeping for explainable AI
// ============================================================================
const express = require('express');
const cryptoLib = require('crypto');
const { z } = require('zod');

const STEP_KINDS = ['input', 'retrieval', 'reasoning', 'output'];

// ----------------------------------------------------------------------------
// Migration
// ----------------------------------------------------------------------------
async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS decision_records (
      decision_id              TEXT PRIMARY KEY,
      agent_did                TEXT NOT NULL,
      action_taken             TEXT NOT NULL,
      context                  JSONB,
      reasoning                TEXT,
      alternatives_considered  JSONB,
      confidence               REAL,
      model_used               TEXT,
      audit_chain_entry        TEXT,
      timestamp                TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_decision_records_agent
      ON decision_records (agent_did, timestamp DESC);

    CREATE TABLE IF NOT EXISTS decision_traces (
      trace_id     TEXT PRIMARY KEY,
      decision_id  TEXT NOT NULL REFERENCES decision_records(decision_id) ON DELETE CASCADE,
      step_kind    TEXT NOT NULL,
      content      JSONB,
      duration_ms  INTEGER,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_decision_traces_dec
      ON decision_traces (decision_id, created_at ASC);

    CREATE TABLE IF NOT EXISTS decision_explanations (
      explanation_id      TEXT PRIMARY KEY,
      decision_id         TEXT NOT NULL REFERENCES decision_records(decision_id) ON DELETE CASCADE,
      asker_did           TEXT,
      explanation         TEXT NOT NULL,
      faithfulness_score  REAL,
      audit_chain_entry   TEXT,
      generated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_decision_explanations_dec
      ON decision_explanations (decision_id, generated_at DESC);
  `);
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------
function genId(prefix) {
  return prefix + '_' + cryptoLib.randomBytes(12).toString('hex');
}

function safeJSON(v) { return v == null ? null : JSON.stringify(v); }

// Compute a heuristic faithfulness score: does the explanation reference
// the keys/tokens that appear in the trace content?
function computeFaithfulness(explanation, traces, record) {
  if (!explanation || !traces || traces.length === 0) return 0;
  const expl = String(explanation).toLowerCase();
  const tokens = new Set();
  for (const t of traces) {
    const c = t.content && typeof t.content === 'object' ? t.content : {};
    for (const k of Object.keys(c)) tokens.add(k.toLowerCase());
    const vstr = JSON.stringify(c).toLowerCase();
    for (const w of vstr.match(/[a-z_][a-z0-9_]{3,}/g) || []) tokens.add(w);
  }
  if (record?.action_taken) tokens.add(String(record.action_taken).toLowerCase());
  if (tokens.size === 0) return 0.5;
  let hits = 0;
  for (const t of tokens) if (expl.includes(t)) hits++;
  return Math.max(0, Math.min(1, hits / Math.max(tokens.size, 1)));
}

async function generateExplanationLLM(record, traces) {
  // Best-effort: if OPENAI_API_KEY is present, call inference; else synthesize
  const synth = `Agent ${record.agent_did} took action "${record.action_taken}" `
    + `with confidence ${record.confidence ?? 'n/a'} using model ${record.model_used || 'n/a'}. `
    + `Reasoning: ${record.reasoning || '(none recorded)'}. `
    + `Trace included ${traces.length} step(s): `
    + traces.map(t => `${t.step_kind}`).join(' -> ') + '.';
  if (!process.env.OPENAI_API_KEY) return synth;
  try {
    const prompt = [
      { role: 'system', content: 'You explain AI agent decisions in plain language, grounded in the trace. Be concise (2-4 sentences).' },
      { role: 'user', content: `Decision record:\n${JSON.stringify(record, null, 2)}\n\nTrace steps:\n${JSON.stringify(traces.slice(0, 20), null, 2)}\n\nExplain this decision faithfully, citing trace steps.` }
    ];
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ model: 'gpt-4o-mini', messages: prompt, max_tokens: 400 })
    });
    if (!r.ok) return synth;
    const j = await r.json();
    return j?.choices?.[0]?.message?.content || synth;
  } catch { return synth; }
}

// ----------------------------------------------------------------------------
// Routes
// ----------------------------------------------------------------------------
function registerInterpretabilityRoutes(app, pool, verifyAgentAuth, auditChain) {
  // POST /v1/agents/:did/decisions — record a decision (optionally with traces)
  const DecisionSchema = z.object({
    action_taken:            z.string().min(1).max(512),
    context:                 z.any().optional(),
    reasoning:               z.string().max(8000).optional(),
    alternatives_considered: z.any().optional(),
    confidence:              z.number().min(0).max(1).optional(),
    model_used:              z.string().max(128).optional(),
    traces:                  z.array(z.object({
      step_kind:   z.enum(STEP_KINDS),
      content:     z.any().optional(),
      duration_ms: z.number().int().min(0).optional()
    })).optional()
  });

  app.post('/v1/agents/:did/decisions', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const parse = DecisionSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;

      const decisionId = genId('dec');
      const now = new Date();

      const entry = await auditChain.append({
        event_type: 'interpretability.decision_recorded',
        agent_did: did,
        decision_id: decisionId,
        action_taken: d.action_taken,
        confidence: d.confidence ?? null,
        model_used: d.model_used || null,
        timestamp: now.toISOString()
      });

      await pool.query(`
        INSERT INTO decision_records
          (decision_id, agent_did, action_taken, context, reasoning,
           alternatives_considered, confidence, model_used, audit_chain_entry, timestamp)
        VALUES ($1,$2,$3,$4::jsonb,$5,$6::jsonb,$7,$8,$9,$10)
      `, [decisionId, did, d.action_taken,
          safeJSON(d.context), d.reasoning || null,
          safeJSON(d.alternatives_considered),
          d.confidence ?? null, d.model_used || null,
          entry.hash, now.toISOString()]);

      const traceIds = [];
      if (Array.isArray(d.traces)) {
        for (const t of d.traces) {
          const tid = genId('trc');
          await pool.query(`
            INSERT INTO decision_traces (trace_id, decision_id, step_kind, content, duration_ms)
            VALUES ($1,$2,$3,$4::jsonb,$5)
          `, [tid, decisionId, t.step_kind, safeJSON(t.content), t.duration_ms ?? null]);
          traceIds.push(tid);
        }
      }

      return res.status(201).json({
        decision_id: decisionId, agent_did: did,
        action_taken: d.action_taken, trace_count: traceIds.length,
        audit_chain_entry: entry.hash, timestamp: now.toISOString()
      });
    } catch (e) {
      console.error('[interpretability.decisions]', e);
      return res.status(500).json({ error: 'record_failed', message: e.message });
    }
  });

  // GET /v1/agents/:did/decisions — history
  app.get('/v1/agents/:did/decisions', async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const limit = Math.min(parseInt(req.query.limit) || 50, 500);
      const r = await pool.query(`
        SELECT decision_id, action_taken, confidence, model_used,
               audit_chain_entry, timestamp
        FROM decision_records WHERE agent_did = $1
        ORDER BY timestamp DESC LIMIT $2
      `, [did, limit]).catch(() => ({ rows: [] }));
      return res.json({ agent_did: did, decisions: r.rows, count: r.rows.length });
    } catch (e) {
      console.error('[interpretability.history]', e);
      return res.status(500).json({ error: 'history_failed', message: e.message });
    }
  });

  // GET /v1/agents/:did/decisions/:id — full trace
  app.get('/v1/agents/:did/decisions/:id', async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const recR = await pool.query(
        `SELECT * FROM decision_records WHERE decision_id = $1 AND agent_did = $2`,
        [req.params.id, did]
      ).catch(() => ({ rows: [] }));
      if (!recR.rows[0]) return res.status(404).json({ error: 'not_found' });

      const traceR = await pool.query(
        `SELECT trace_id, step_kind, content, duration_ms, created_at
         FROM decision_traces WHERE decision_id = $1 ORDER BY created_at ASC`,
        [req.params.id]
      ).catch(() => ({ rows: [] }));

      const explR = await pool.query(
        `SELECT explanation_id, asker_did, explanation, faithfulness_score, generated_at
         FROM decision_explanations WHERE decision_id = $1
         ORDER BY generated_at DESC LIMIT 10`,
        [req.params.id]
      ).catch(() => ({ rows: [] }));

      return res.json({
        decision: recR.rows[0],
        traces: traceR.rows,
        explanations: explR.rows
      });
    } catch (e) {
      console.error('[interpretability.trace]', e);
      return res.status(500).json({ error: 'trace_failed', message: e.message });
    }
  });

  // POST /v1/agents/:did/decisions/:id/explain — generate human-readable explanation
  app.post('/v1/agents/:did/decisions/:id/explain', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const recR = await pool.query(
        `SELECT * FROM decision_records WHERE decision_id = $1 AND agent_did = $2`,
        [req.params.id, did]
      ).catch(() => ({ rows: [] }));
      if (!recR.rows[0]) return res.status(404).json({ error: 'not_found' });

      const traceR = await pool.query(
        `SELECT step_kind, content, duration_ms FROM decision_traces
         WHERE decision_id = $1 ORDER BY created_at ASC`,
        [req.params.id]
      ).catch(() => ({ rows: [] }));

      const explanation = await generateExplanationLLM(recR.rows[0], traceR.rows);
      const faithfulness = computeFaithfulness(explanation, traceR.rows, recR.rows[0]);

      const explanationId = genId('expl');
      const entry = await auditChain.append({
        event_type: 'interpretability.explanation_generated',
        agent_did: did,
        decision_id: req.params.id,
        explanation_id: explanationId,
        faithfulness_score: faithfulness,
        timestamp: new Date().toISOString()
      });

      await pool.query(`
        INSERT INTO decision_explanations
          (explanation_id, decision_id, asker_did, explanation, faithfulness_score, audit_chain_entry)
        VALUES ($1,$2,$3,$4,$5,$6)
      `, [explanationId, req.params.id, auth.subject || null,
          explanation, faithfulness, entry.hash]);

      return res.status(201).json({
        explanation_id: explanationId,
        decision_id: req.params.id,
        explanation,
        faithfulness_score: faithfulness,
        audit_chain_entry: entry.hash
      });
    } catch (e) {
      console.error('[interpretability.explain]', e);
      return res.status(500).json({ error: 'explain_failed', message: e.message });
    }
  });

  // POST /v1/agents/:did/decisions/:id/audit — verify reasoning matches outcome
  const AuditSchema = z.object({
    observed_outcome:  z.any(),
    matches_reasoning: z.boolean().optional(),
    notes:             z.string().max(2000).optional()
  });
  app.post('/v1/agents/:did/decisions/:id/audit', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const parse = AuditSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;

      const recR = await pool.query(
        `SELECT decision_id, action_taken, reasoning, context FROM decision_records
         WHERE decision_id = $1 AND agent_did = $2`,
        [req.params.id, did]
      ).catch(() => ({ rows: [] }));
      if (!recR.rows[0]) return res.status(404).json({ error: 'not_found' });

      const rec = recR.rows[0];
      const reasoningText = (rec.reasoning || '').toLowerCase();
      const outcomeText = JSON.stringify(d.observed_outcome || {}).toLowerCase();
      // Simple heuristic if matches_reasoning not given
      let matches = d.matches_reasoning;
      if (matches == null) {
        const reasoningTokens = (reasoningText.match(/[a-z_][a-z0-9_]{3,}/g) || []);
        let hits = 0;
        for (const t of reasoningTokens) if (outcomeText.includes(t)) hits++;
        matches = reasoningTokens.length > 0 && hits / reasoningTokens.length > 0.25;
      }

      const entry = await auditChain.append({
        event_type: 'interpretability.post_hoc_audit',
        agent_did: did,
        decision_id: req.params.id,
        matches_reasoning: !!matches,
        timestamp: new Date().toISOString()
      });

      return res.json({
        decision_id: req.params.id,
        action_taken: rec.action_taken,
        matches_reasoning: !!matches,
        observed_outcome: d.observed_outcome,
        notes: d.notes || null,
        audit_chain_entry: entry.hash
      });
    } catch (e) {
      console.error('[interpretability.audit]', e);
      return res.status(500).json({ error: 'audit_failed', message: e.message });
    }
  });
}

module.exports = {
  migrate,
  registerInterpretabilityRoutes,
  computeFaithfulness,
  generateExplanationLLM,
  STEP_KINDS
};
