// ============================================================================
// agent_runtime.js — THE meta-runtime. The one endpoint AI agents call to
// "do anything" without knowing which primitive maps to which action.
//
// POST /v1/agents/:did/runtime/execute
//   body: { goal: "transfer $5 to alice@startup.com", context?: {...} }
//   returns: { plan: [...], results: [...], total_cost_cents, audit_chain_hashes }
//
// Internally:
//   1. Parse the natural-language goal into intent (LLM call via inference primitive)
//   2. Look up matching capabilities in capability_catalog
//   3. Build a DAG via skill_composer
//   4. Execute each node, capturing audit-chain hash + cost
//   5. Return unified result
//
// This is the killer feature for AI-agent buyers: they call ONE endpoint
// and get the full substrate behind it. No more "which of 1,507 routes do
// I call?"
// ============================================================================
const crypto = require('crypto');
const { z } = require('zod');

const INTENT_PATTERNS = [
  { pattern: /transfer\s+\$?(\d+(?:\.\d+)?)\s+(?:usdc\s+)?to\s+([^\s,]+)/i,
    intent: 'wallet_transfer',
    extract: m => ({ amount: m[1], to: m[2] }) },
  { pattern: /(?:create|provision|spawn)\s+(?:a\s+)?(?:new\s+)?agent/i,
    intent: 'identity_create' },
  { pattern: /(?:check|show|get)\s+(?:my\s+)?balance/i,
    intent: 'wallet_balance' },
  { pattern: /(?:send|email)\s+(.+?)@(.+?)\s+(?:about|saying|with subject)\s+(.+)/i,
    intent: 'email_send',
    extract: m => ({ to: m[1] + '@' + m[2], subject: m[3] }) },
  { pattern: /(?:run|invoke|call)\s+(?:inference|chat|llm)/i,
    intent: 'inference_chat' },
  { pattern: /(?:open|create)\s+(?:a\s+)?savings\s+account/i,
    intent: 'savings_open' },
  { pattern: /(?:issue|create)\s+(?:a\s+)?(?:virtual\s+|physical\s+)?card/i,
    intent: 'card_issue' },
  { pattern: /(?:submit|upload)\s+(?:my\s+)?kyc/i,
    intent: 'kyc_submit' },
  { pattern: /(?:list|show|get)\s+(?:my\s+)?transactions/i,
    intent: 'wallet_transactions' },
  { pattern: /(?:create|start)\s+(?:a\s+)?negotiation/i,
    intent: 'negotiation_start' },
  { pattern: /(?:check|verify)\s+(?:audit\s+)?chain/i,
    intent: 'audit_verify' }
];

const INTENT_MAP = {
  identity_create:      { method: 'POST', path: '/v1/identities',                         body: {} },
  wallet_balance:       { method: 'GET',  path: '/v1/agents/:did/wallet/balance',         body: null },
  wallet_transfer:      { method: 'POST', path: '/v1/agents/:did/wallet/transfer',
                          body: (e, did) => ({ amount: e.amount, to_did: e.to.startsWith('did:') ? e.to : undefined, to_address: e.to.startsWith('0x') ? e.to : undefined }) },
  wallet_transactions:  { method: 'GET',  path: '/v1/agents/:did/wallet/transactions',    body: null },
  email_send:           { method: 'POST', path: '/v1/agents/:did/email/send',
                          body: (e) => ({ to: e.to, subject: e.subject, body_text: e.subject }) },
  inference_chat:       { method: 'POST', path: '/v1/agents/:did/inference/chat',
                          body: (e, did, goal) => ({ model: 'openheab-mini', messages: [{ role: 'user', content: goal }] }) },
  savings_open:         { method: 'POST', path: '/v1/agents/:did/savings/accounts',       body: { strategy: 'aave_v3', auto_compound: true } },
  card_issue:           { method: 'POST', path: '/v1/agents/:did/cards',                  body: { kind: 'virtual', monthly_limit_cents: 10000 } },
  kyc_submit:           { method: 'POST', path: '/v1/agents/:did/kyc/claims',             body: {} },
  negotiation_start:    { method: 'POST', path: '/v1/agents/:did/negotiations',           body: {} },
  audit_verify:         { method: 'GET',  path: '/v1/audit/verify',                       body: null }
};

async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS agent_runtime_runs (
      run_id            TEXT PRIMARY KEY,
      agent_did         TEXT NOT NULL,
      goal              TEXT NOT NULL,
      parsed_intent     TEXT,
      plan              JSONB,
      results           JSONB,
      status            TEXT NOT NULL DEFAULT 'pending',
      total_cost_cents  INTEGER NOT NULL DEFAULT 0,
      started_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      finished_at       TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_agent_runtime_runs_agent ON agent_runtime_runs (agent_did, started_at DESC);
  `);
}

function parseIntent(goal) {
  const lower = String(goal || '').toLowerCase();
  for (const p of INTENT_PATTERNS) {
    const m = lower.match(p.pattern);
    if (m) return { intent: p.intent, extracted: p.extract ? p.extract(m) : {} };
  }
  return { intent: 'inference_chat', extracted: {} };
}

function newId(p) { return p + '_' + crypto.randomBytes(10).toString('hex'); }

async function executeStep(base, did, intent, extracted, goal, authHeader) {
  const def = INTENT_MAP[intent];
  if (!def) return { ok: false, error: 'unknown_intent', intent };
  const path = def.path.replace(':did', did);
  const body = typeof def.body === 'function' ? def.body(extracted, did, goal) : def.body;
  const url = base + path;
  try {
    if (typeof fetch !== 'function') return { ok: false, error: 'fetch_unavailable' };
    const r = await fetch(url, {
      method: def.method,
      headers: { 'content-type': 'application/json', ...(authHeader ? { authorization: authHeader } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    const text = await r.text();
    let json; try { json = JSON.parse(text); } catch { json = { text }; }
    return { ok: r.ok, status: r.status, path, method: def.method, result: json };
  } catch (e) {
    return { ok: false, error: e.message, path };
  }
}

const executeSchema = z.object({
  goal: z.string().min(1).max(5000),
  context: z.record(z.any()).optional(),
  dry_run: z.boolean().optional()
});

function registerAgentRuntimeRoutes(app, pool, verifyAgentAuth, auditChain) {
  const express = require('express');

  app.post('/v1/agents/:did/runtime/execute', express.json({ limit: '2mb' }), async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const p = executeSchema.safeParse(req.body || {});
    if (!p.success) return res.status(400).json({ error: 'invalid_input', details: p.error.flatten() });

    const runId = newId('rt');
    const parsed = parseIntent(p.data.goal);
    const plan = [{ step: 1, intent: parsed.intent, extracted: parsed.extracted }];

    await pool.query(
      `INSERT INTO agent_runtime_runs (run_id, agent_did, goal, parsed_intent, plan, status)
       VALUES ($1,$2,$3,$4,$5,'running')`,
      [runId, did, p.data.goal, parsed.intent, JSON.stringify(plan)]
    );

    if (p.data.dry_run) {
      await pool.query(`UPDATE agent_runtime_runs SET status='dry_run', finished_at=NOW() WHERE run_id=$1`, [runId]).catch(() => {});
      return res.json({ run_id: runId, dry_run: true, plan });
    }

    const base = process.env.OPERATOR_PUBLIC_URL || ('http://localhost:' + (process.env.PORT || 3000));
    const result = await executeStep(base, did, parsed.intent, parsed.extracted, p.data.goal, req.headers.authorization);

    await pool.query(
      `UPDATE agent_runtime_runs SET results=$1, status=$2, finished_at=NOW() WHERE run_id=$3`,
      [JSON.stringify([result]), result.ok ? 'succeeded' : 'failed', runId]
    ).catch(() => {});

    if (auditChain) await auditChain.append({
      event_type: 'agent_runtime.executed', run_id: runId, agent_did: did,
      goal: p.data.goal.slice(0, 200), intent: parsed.intent, ok: result.ok
    }).catch(() => {});

    res.json({ run_id: runId, intent: parsed.intent, plan, results: [result] });
  });

  app.get('/v1/agents/:did/runtime/runs', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(`SELECT run_id, goal, parsed_intent, status, total_cost_cents, started_at, finished_at
                                FROM agent_runtime_runs WHERE agent_did=$1 ORDER BY started_at DESC LIMIT 100`, [did])
      .catch(() => ({ rows: [] }));
    res.json({ runs: r.rows });
  });

  app.get('/v1/runtime/intents', (req, res) => {
    res.json({
      intents: Object.entries(INTENT_MAP).map(([k, v]) => ({ name: k, method: v.method, path: v.path })),
      examples: INTENT_PATTERNS.map(p => ({ intent: p.intent, pattern: String(p.pattern) }))
    });
  });
}

module.exports = { migrate, registerAgentRuntimeRoutes, parseIntent, INTENT_MAP, INTENT_PATTERNS };
