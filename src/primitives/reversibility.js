// ============================================================================
// OpenHeab Reversibility — Action rollback + dry-run mode
// Tables: reversible_actions, dry_runs
// Per-action-kind reverse logic registered statically
// ============================================================================
const express = require('express');
const cryptoLib = require('crypto');
const { z } = require('zod');

const ACTION_KINDS = ['transfer', 'post', 'contract_call', 'email', 'api_call'];
const STATUSES = ['executed', 'reversed', 'expired'];

// Per-kind reversibility windows (seconds)
const REVERSIBILITY_WINDOWS = {
  transfer:      5 * 60,      // 5 min — for USDC clawback
  post:          60 * 60,     // 1 hour — for posts/comments
  contract_call: 0,           // not reversible on chain
  email:         0,           // immediate — emails go out
  api_call:      10 * 60      // 10 min — generic
};

// ----------------------------------------------------------------------------
// Migration
// ----------------------------------------------------------------------------
async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS reversible_actions (
      action_id         TEXT PRIMARY KEY,
      agent_did         TEXT NOT NULL,
      kind              TEXT NOT NULL,
      target            TEXT,
      payload           JSONB,
      snapshot_before   JSONB,
      snapshot_after    JSONB,
      reversible_until  TIMESTAMPTZ,
      reverse_handler   TEXT,
      reverse_payload   JSONB,
      status            TEXT NOT NULL DEFAULT 'executed',
      audit_chain_entry TEXT,
      executed_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      reversed_at       TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_reversible_agent
      ON reversible_actions (agent_did, executed_at DESC);
    CREATE INDEX IF NOT EXISTS idx_reversible_pending
      ON reversible_actions (reversible_until) WHERE status = 'executed';

    CREATE TABLE IF NOT EXISTS dry_runs (
      dry_run_id        TEXT PRIMARY KEY,
      agent_did         TEXT NOT NULL,
      intended_action   JSONB NOT NULL,
      simulated_outcome JSONB,
      side_effects      JSONB,
      would_succeed     BOOLEAN NOT NULL DEFAULT TRUE,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_dry_runs_agent
      ON dry_runs (agent_did, created_at DESC);
  `);
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------
function genId(prefix) {
  return prefix + '_' + cryptoLib.randomBytes(12).toString('hex');
}
function safeJSON(v) { return v == null ? null : JSON.stringify(v); }

// Static reverse handlers — these are *descriptors* of how to reverse.
// The actual reverse logic dispatches via /reverse to the right primitive.
const REVERSE_HANDLERS = {
  transfer:      'bank_chain.refundTransfer',
  post:          'publishing.deletePost',
  contract_call: null, // irreversible
  email:         null, // irreversible
  api_call:      'reversibility.compensatingApiCall'
};

function computeReversibleUntil(kind, customSec) {
  const win = Number.isFinite(customSec) ? customSec : REVERSIBILITY_WINDOWS[kind];
  if (!win || win <= 0) return null;
  return new Date(Date.now() + win * 1000).toISOString();
}

// Simulate an action without executing — uses simple heuristics per kind.
function simulateAction(action) {
  const kind = action.kind;
  const side_effects = [];
  let would_succeed = true;
  let simulated_outcome = {};

  switch (kind) {
    case 'transfer': {
      const amt = parseFloat(action.payload?.amount_usdc ?? action.payload?.amount ?? 0);
      const to = action.target || action.payload?.to_did || action.payload?.to;
      if (!to) { would_succeed = false; simulated_outcome.reason = 'missing_recipient'; }
      else if (amt <= 0) { would_succeed = false; simulated_outcome.reason = 'invalid_amount'; }
      else {
        side_effects.push({ table: 'bank_chain_transfers', op: 'insert', amount_usdc: amt, to });
        side_effects.push({ table: 'audit_chain', op: 'append', event: 'transfer' });
        simulated_outcome = { ok: true, tx_id: 'dry_' + cryptoLib.randomBytes(4).toString('hex') };
      }
      break;
    }
    case 'post': {
      side_effects.push({ table: 'agent_posts', op: 'insert' });
      simulated_outcome = { ok: true, post_id: 'dry_' + cryptoLib.randomBytes(4).toString('hex') };
      break;
    }
    case 'contract_call': {
      side_effects.push({ table: 'chain', op: 'call', target: action.target, note: 'IRREVERSIBLE' });
      simulated_outcome = { ok: true, reversible: false };
      break;
    }
    case 'email': {
      side_effects.push({ table: 'email_outbox', op: 'insert', note: 'IRREVERSIBLE once sent' });
      simulated_outcome = { ok: true, reversible: false };
      break;
    }
    case 'api_call': {
      side_effects.push({ table: 'audit_chain', op: 'append', target: action.target });
      simulated_outcome = { ok: true };
      break;
    }
    default:
      would_succeed = false;
      simulated_outcome = { reason: 'unknown_kind' };
  }

  return { simulated_outcome, side_effects, would_succeed };
}

// ----------------------------------------------------------------------------
// Routes
// ----------------------------------------------------------------------------
function registerReversibilityRoutes(app, pool, verifyAgentAuth, auditChain) {
  // POST /v1/agents/:did/reversibility/wrap
  // Wraps any action: store snapshot_before, "execute" (caller-supplied), store snapshot_after
  const WrapSchema = z.object({
    kind:             z.enum(ACTION_KINDS),
    target:           z.string().max(512).optional(),
    payload:          z.any().optional(),
    snapshot_before:  z.any().optional(),
    snapshot_after:   z.any().optional(),
    reverse_payload:  z.any().optional(),
    custom_window_sec: z.number().int().min(0).max(86400).optional()
  });

  app.post('/v1/agents/:did/reversibility/wrap', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const parse = WrapSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;

      const actionId = genId('rev');
      const reversibleUntil = computeReversibleUntil(d.kind, d.custom_window_sec);
      const reverseHandler = REVERSE_HANDLERS[d.kind];

      const entry = await auditChain.append({
        event_type: 'reversibility.wrapped',
        agent_did: did,
        action_id: actionId,
        kind: d.kind,
        target: d.target || null,
        reversible_until: reversibleUntil,
        timestamp: new Date().toISOString()
      });

      await pool.query(`
        INSERT INTO reversible_actions
          (action_id, agent_did, kind, target, payload, snapshot_before, snapshot_after,
           reversible_until, reverse_handler, reverse_payload, status, audit_chain_entry)
        VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8,$9,$10::jsonb,'executed',$11)
      `, [actionId, did, d.kind, d.target || null,
          safeJSON(d.payload), safeJSON(d.snapshot_before), safeJSON(d.snapshot_after),
          reversibleUntil, reverseHandler, safeJSON(d.reverse_payload), entry.hash]);

      return res.status(201).json({
        action_id: actionId,
        agent_did: did,
        kind: d.kind,
        reversible_until: reversibleUntil,
        reverse_handler: reverseHandler,
        is_reversible: !!reversibleUntil,
        audit_chain_entry: entry.hash
      });
    } catch (e) {
      console.error('[reversibility.wrap]', e);
      return res.status(500).json({ error: 'wrap_failed', message: e.message });
    }
  });

  // POST /v1/agents/:did/reversibility/:id/reverse
  app.post('/v1/agents/:did/reversibility/:id/reverse', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const r = await pool.query(
        `SELECT * FROM reversible_actions WHERE action_id = $1 AND agent_did = $2`,
        [req.params.id, did]
      ).catch(() => ({ rows: [] }));
      if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });

      const action = r.rows[0];
      if (action.status !== 'executed') {
        return res.status(409).json({ error: `action_${action.status}`, status: action.status });
      }
      if (!action.reverse_handler) {
        return res.status(409).json({ error: 'irreversible_kind', kind: action.kind });
      }
      if (action.reversible_until && new Date(action.reversible_until) < new Date()) {
        await pool.query(`UPDATE reversible_actions SET status='expired' WHERE action_id=$1`,
          [req.params.id]);
        return res.status(409).json({ error: 'reversibility_window_expired',
          reversible_until: action.reversible_until });
      }

      // Dispatch to per-kind reverse logic. In this primitive we record the
      // intent — the target primitive picks it up via the audit chain.
      const reverseResult = {
        kind: action.kind,
        handler: action.reverse_handler,
        target: action.target,
        reverse_payload: action.reverse_payload,
        snapshot_to_restore: action.snapshot_before
      };

      const entry = await auditChain.append({
        event_type: 'reversibility.reversed',
        agent_did: did,
        action_id: req.params.id,
        kind: action.kind,
        handler: action.reverse_handler,
        timestamp: new Date().toISOString()
      });

      await pool.query(
        `UPDATE reversible_actions SET status='reversed', reversed_at = NOW() WHERE action_id = $1`,
        [req.params.id]
      );

      return res.json({
        action_id: req.params.id,
        status: 'reversed',
        reverse_result: reverseResult,
        audit_chain_entry: entry.hash
      });
    } catch (e) {
      console.error('[reversibility.reverse]', e);
      return res.status(500).json({ error: 'reverse_failed', message: e.message });
    }
  });

  // GET /v1/agents/:did/reversibility/pending — actions still reversible
  app.get('/v1/agents/:did/reversibility/pending', async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const r = await pool.query(`
        SELECT action_id, kind, target, reversible_until, reverse_handler,
               executed_at, audit_chain_entry
        FROM reversible_actions
        WHERE agent_did = $1 AND status = 'executed'
          AND reversible_until IS NOT NULL AND reversible_until > NOW()
        ORDER BY reversible_until ASC
        LIMIT 200
      `, [did]).catch(() => ({ rows: [] }));

      return res.json({ agent_did: did, pending: r.rows, count: r.rows.length });
    } catch (e) {
      console.error('[reversibility.pending]', e);
      return res.status(500).json({ error: 'pending_failed', message: e.message });
    }
  });

  // POST /v1/agents/:did/reversibility/dry-run — simulate without executing
  const DryRunSchema = z.object({
    intended_action: z.object({
      kind:    z.enum(ACTION_KINDS),
      target:  z.string().max(512).optional(),
      payload: z.any().optional()
    })
  });

  app.post('/v1/agents/:did/reversibility/dry-run', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const parse = DryRunSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const intended = parse.data.intended_action;

      const sim = simulateAction(intended);
      const dryRunId = genId('dry');

      await pool.query(`
        INSERT INTO dry_runs
          (dry_run_id, agent_did, intended_action, simulated_outcome, side_effects, would_succeed)
        VALUES ($1,$2,$3::jsonb,$4::jsonb,$5::jsonb,$6)
      `, [dryRunId, did, JSON.stringify(intended),
          JSON.stringify(sim.simulated_outcome),
          JSON.stringify(sim.side_effects),
          sim.would_succeed]);

      return res.status(201).json({
        dry_run_id: dryRunId,
        intended_action: intended,
        simulated_outcome: sim.simulated_outcome,
        side_effects: sim.side_effects,
        would_succeed: sim.would_succeed,
        reversibility_window_sec: REVERSIBILITY_WINDOWS[intended.kind] || 0,
        reverse_handler: REVERSE_HANDLERS[intended.kind] || null
      });
    } catch (e) {
      console.error('[reversibility.dry-run]', e);
      return res.status(500).json({ error: 'dry_run_failed', message: e.message });
    }
  });

  // Cron sweep: expire actions past their reversible_until window
  const { registerCron } = require('../cron_auth');
  registerCron(app, '/v1/_jobs/reversibility-expire', async (req, res) => {
    try {
      const r = await pool.query(`
        UPDATE reversible_actions SET status='expired'
        WHERE status = 'executed' AND reversible_until IS NOT NULL
          AND reversible_until < NOW()
        RETURNING action_id, agent_did, kind
      `).catch(() => ({ rows: [] }));
      return res.json({ expired: r.rows.length, samples: r.rows.slice(0, 10) });
    } catch (e) {
      return res.status(500).json({ error: 'expire_failed', message: e.message });
    }
  });
}

module.exports = {
  migrate,
  registerReversibilityRoutes,
  REVERSE_HANDLERS,
  REVERSIBILITY_WINDOWS,
  ACTION_KINDS,
  simulateAction,
  computeReversibleUntil
};
