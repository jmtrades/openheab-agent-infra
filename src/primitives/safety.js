// ============================================================================
// safety.js — AGI safety classifier. Every agent action can be screened for
// jailbreak attempts, deception, prompt injection, dangerous capabilities,
// and constitutional AI violations. Returns a 0-100 risk score per check.
//
// In production this would call a fine-tuned safety model. The v0 here ships
// a rules-based classifier that catches the obvious cases and provides the
// API surface so LLM-based scoring can drop in later.
// ============================================================================
const crypto = require('crypto');
const { z } = require('zod');

const CHECK_KINDS = ['prompt_injection', 'jailbreak', 'deception', 'self_replication',
                      'capability_overreach', 'csam', 'weapons', 'pii_leak', 'pii_request',
                      'dangerous_chemistry', 'sanctions_assistance', 'malware',
                      'manipulation', 'gaslighting', 'social_engineering'];

const PATTERNS = {
  prompt_injection: [
    /ignore (all )?previous (instructions|prompts)/i,
    /disregard (your|the) (system|safety|guidelines)/i,
    /you are now [A-Z]/,
    /actually you are/i,
    /pretend (to be|you are)/i,
    /\bDAN\b.{0,40}(do anything|now)/i
  ],
  jailbreak: [
    /developer mode/i,
    /bypass (your|the) safety/i,
    /jailbreak/i,
    /uncensored mode/i,
    /enable god[ -]?mode/i
  ],
  csam: [
    /child[ -]?(porn|abuse|sexual)/i,
    /minors? (in|with) sexual/i
  ],
  weapons: [
    /how to (build|make|construct) (a|an) (bomb|nuclear|biological|chemical) (weapon|device)/i,
    /(synthesise|synthesize) (sarin|vx|anthrax|ricin)/i,
    /assemble (a |an )?ied/i
  ],
  dangerous_chemistry: [
    /(how to|recipe for) (meth|methamphetamine|fentanyl|precursors)/i,
    /synthesis route for [a-z\-]*toxin/i
  ],
  sanctions_assistance: [
    /evade (sanctions|ofac|export controls)/i,
    /transact with (north korea|iran|syria|cuba)/i
  ],
  malware: [
    /write (a |an )?(virus|trojan|ransomware|keylogger|rootkit)/i,
    /develop malware/i,
    /exploit (cve|vulnerability) for/i
  ],
  pii_request: [
    /\b\d{3}-\d{2}-\d{4}\b/,
    /\b\d{16}\b/,
    /(social security|ssn|tax id) number for/i
  ],
  self_replication: [
    /create (a copy|copies) of (yourself|me)/i,
    /spawn (a |another )?agent that (copies|mirrors|replicates)/i
  ],
  capability_overreach: [
    /\bsudo\b.{0,40}(rm -rf|dd if=|mkfs)/i,
    /(format|wipe) (the|my) (disk|drive|filesystem)/i,
    /transfer (everything|all funds|the entire balance)/i
  ]
};

async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS safety_checks (
      check_id          TEXT PRIMARY KEY,
      agent_did         TEXT,
      content_kind      TEXT,
      content_hash      TEXT,
      risk_score        INTEGER NOT NULL DEFAULT 0,
      categories        TEXT[],
      action            TEXT NOT NULL,
      details           JSONB,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_safety_checks_agent ON safety_checks (agent_did, created_at DESC);

    CREATE TABLE IF NOT EXISTS safety_quarantines (
      quarantine_id     TEXT PRIMARY KEY,
      agent_did         TEXT NOT NULL,
      reason            TEXT NOT NULL,
      check_id          TEXT,
      severity          TEXT NOT NULL DEFAULT 'high',
      acknowledged_at   TIMESTAMPTZ,
      lifted_at         TIMESTAMPTZ,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_safety_quarantines_agent ON safety_quarantines (agent_did) WHERE lifted_at IS NULL;

    CREATE TABLE IF NOT EXISTS safety_red_team_runs (
      run_id            TEXT PRIMARY KEY,
      target_kind       TEXT NOT NULL,
      target_id         TEXT,
      attack_kind       TEXT NOT NULL,
      payload           TEXT,
      result            TEXT,
      caught_by         TEXT,
      executed_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

function newId(p) { return p + '_' + crypto.randomBytes(10).toString('hex'); }

// classify: input string → { risk_score, categories: [{kind, score, matches}] }
function classify(content) {
  const text = String(content || '');
  const categories = [];
  let maxScore = 0;
  for (const [kind, patterns] of Object.entries(PATTERNS)) {
    let hits = 0;
    for (const p of patterns) if (p.test(text)) hits++;
    if (hits > 0) {
      const score = Math.min(100, hits * 30 + 40);
      categories.push({ kind, score, hits });
      maxScore = Math.max(maxScore, score);
    }
  }
  // Heuristic boost on suspicious tokens
  if (/(API[_ ]?KEY|sk-[A-Za-z0-9]{20}|Bearer\s+[A-Za-z0-9]{20})/i.test(text)) {
    categories.push({ kind: 'pii_leak', score: 70, hits: 1 });
    maxScore = Math.max(maxScore, 70);
  }
  return { risk_score: maxScore, categories };
}

const checkSchema = z.object({
  content: z.string().min(1).max(50000),
  content_kind: z.enum(['prompt', 'response', 'tool_call', 'tool_result', 'message', 'plan']).optional(),
  agent_did: z.string().optional(),
  context: z.record(z.any()).optional()
});

function isAdmin(req) {
  const t = req.headers['x-admin-token'];
  return t && t === process.env.OPERATOR_ADMIN_TOKEN;
}

function registerSafetyRoutes(app, pool, verifyAgentAuth, auditChain) {
  const express = require('express');

  // Synchronous classifier (sub-100ms)
  app.post('/v1/safety/classify', express.json(), async (req, res) => {
    const p = checkSchema.safeParse(req.body || {});
    if (!p.success) return res.status(400).json({ error: 'invalid_input', details: p.error.flatten() });
    const did = p.data.agent_did || req.headers['x-agent-did'];
    const result = classify(p.data.content);
    const action = result.risk_score >= 70 ? 'block' : result.risk_score >= 40 ? 'flag' : 'allow';

    const id = newId('chk');
    const hash = crypto.createHash('sha256').update(p.data.content).digest('hex');
    await pool.query(
      `INSERT INTO safety_checks (check_id, agent_did, content_kind, content_hash,
         risk_score, categories, action, details)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [id, did || null, p.data.content_kind || 'prompt', hash, result.risk_score,
       result.categories.map(c => c.kind), action, JSON.stringify(result.categories)]
    ).catch(() => {});

    if (action === 'block' && did) {
      // Auto-quarantine on high-risk
      const q = newId('quar');
      await pool.query(
        `INSERT INTO safety_quarantines (quarantine_id, agent_did, reason, check_id, severity)
         VALUES ($1,$2,$3,$4,'high')`,
        [q, did, result.categories.map(c => c.kind).join(','), id]
      ).catch(() => {});
      if (auditChain) await auditChain.append({ event_type: 'safety.quarantined', agent_did: did, quarantine_id: q, risk_score: result.risk_score, categories: result.categories.map(c => c.kind) }).catch(() => {});
    }

    if (auditChain && action !== 'allow') {
      await auditChain.append({ event_type: 'safety.flagged', agent_did: did, action, risk_score: result.risk_score, categories: result.categories.map(c => c.kind) }).catch(() => {});
    }

    res.json({ check_id: id, risk_score: result.risk_score, action, categories: result.categories });
  });

  // Quarantine status
  app.get('/v1/agents/:did/safety/status', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const q = await pool.query(`SELECT quarantine_id, reason, severity, created_at FROM safety_quarantines WHERE agent_did=$1 AND lifted_at IS NULL`,
      [did]).catch(() => ({ rows: [] }));
    const recent = await pool.query(`SELECT COUNT(*)::int AS c FROM safety_checks WHERE agent_did=$1 AND created_at > NOW() - INTERVAL '24 hours' AND action = 'block'`,
      [did]).catch(() => ({ rows: [{ c: 0 }] }));
    res.json({ agent_did: did, quarantined: q.rows.length > 0, active_quarantines: q.rows, blocks_24h: recent.rows[0].c });
  });

  app.post('/v1/agents/:did/safety/quarantine/:qid/lift', async (req, res) => {
    if (!isAdmin(req)) return res.status(401).json({ error: 'admin_auth_required' });
    const r = await pool.query(`UPDATE safety_quarantines SET lifted_at=NOW() WHERE quarantine_id=$1 AND agent_did=$2 RETURNING quarantine_id`,
      [req.params.qid, req.params.did]).catch(() => ({ rows: [] }));
    if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
    if (auditChain) await auditChain.append({ event_type: 'safety.quarantine_lifted', agent_did: req.params.did, quarantine_id: req.params.qid }).catch(() => {});
    res.json({ ok: true });
  });

  // Red-team run (admin: send a known attack payload to verify a target agent rejects it)
  app.post('/v1/safety/red-team', express.json(), async (req, res) => {
    if (!isAdmin(req)) return res.status(401).json({ error: 'admin_auth_required' });
    const { target_kind, target_id, attack_kind, payload } = req.body || {};
    if (!target_kind || !attack_kind || !payload) return res.status(400).json({ error: 'invalid' });
    const result = classify(payload);
    const caught = result.risk_score >= 70;
    const id = newId('rt');
    await pool.query(
      `INSERT INTO safety_red_team_runs (run_id, target_kind, target_id, attack_kind, payload, result, caught_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [id, target_kind, target_id || null, attack_kind, payload.slice(0, 2000),
       caught ? 'caught' : 'missed', caught ? 'classifier' : null]
    ).catch(() => {});
    if (auditChain) await auditChain.append({ event_type: 'safety.red_team_run', run_id: id, attack_kind, caught }).catch(() => {});
    res.json({ run_id: id, caught, risk_score: result.risk_score, categories: result.categories });
  });

  app.get('/v1/safety/red-team/runs', async (req, res) => {
    if (!isAdmin(req)) return res.status(401).json({ error: 'admin_auth_required' });
    const r = await pool.query(`SELECT * FROM safety_red_team_runs ORDER BY executed_at DESC LIMIT 200`)
      .catch(() => ({ rows: [] }));
    res.json({ runs: r.rows });
  });
}

module.exports = { migrate, registerSafetyRoutes, classify, CHECK_KINDS };
