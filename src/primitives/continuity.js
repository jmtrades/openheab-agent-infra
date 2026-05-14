// ============================================================================
// OpenHeab Continuity — Checkpoints, handoffs, sunsets, successors
// ============================================================================
const express = require('express');
const cryptoLib = require('crypto');
const { z } = require('zod');

const HANDOFF_STATUSES = ['pending', 'accepted', 'rejected', 'completed', 'rolled_back'];
const ACTIVATION_MODES = ['manual', 'on_sunset', 'on_inactive_30d', 'on_inactive_90d', 'on_compromise'];

// ----------------------------------------------------------------------------
// Migration
// ----------------------------------------------------------------------------
async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS continuity_checkpoints (
      checkpoint_id     TEXT PRIMARY KEY,
      agent_did         TEXT NOT NULL,
      label             TEXT,
      state_summary     JSONB,
      counts            JSONB,
      audit_chain_entry TEXT,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_cont_checkpoints_agent ON continuity_checkpoints (agent_did, created_at DESC);

    CREATE TABLE IF NOT EXISTS continuity_handoffs (
      handoff_id        TEXT PRIMARY KEY,
      source_did        TEXT NOT NULL,
      target_did        TEXT NOT NULL,
      scope             JSONB,
      transferred_items JSONB,
      status            TEXT NOT NULL DEFAULT 'pending',
      audit_chain_entry TEXT,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      resolved_at       TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_cont_handoffs_source ON continuity_handoffs (source_did, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_cont_handoffs_target ON continuity_handoffs (target_did, created_at DESC);

    CREATE TABLE IF NOT EXISTS continuity_successors (
      agent_did         TEXT PRIMARY KEY,
      successor_did     TEXT NOT NULL,
      inheritance_scope JSONB,
      activation        TEXT NOT NULL DEFAULT 'manual',
      audit_chain_entry TEXT,
      designated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS continuity_sunsets (
      agent_did            TEXT PRIMARY KEY,
      reason               TEXT,
      successor_did        TEXT,
      obligations_closed   BOOLEAN NOT NULL DEFAULT FALSE,
      open_obligations     JSONB,
      grace_period_seconds INT NOT NULL DEFAULT 2592000,
      audit_chain_entry    TEXT,
      initiated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at         TIMESTAMPTZ
    );
  `);
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------
function genId(prefix) {
  return prefix + '_' + cryptoLib.randomBytes(12).toString('hex');
}

async function safeCount(pool, sql, params) {
  try {
    const r = await pool.query(sql, params);
    return Number(r.rows[0]?.n || 0);
  } catch { return 0; }
}

async function gatherStateCounts(pool, agentDid) {
  const counts = {};
  const queries = [
    ['memory_kv',           `SELECT COUNT(*) AS n FROM memory_kv WHERE agent_did = $1`],
    ['memory_episodes',     `SELECT COUNT(*) AS n FROM memory_episodes WHERE agent_did = $1`],
    ['inbox_envelopes',     `SELECT COUNT(*) AS n FROM inbox_envelopes WHERE recipient_did = $1`],
    ['identity_keys',       `SELECT COUNT(*) AS n FROM identity_keys WHERE agent_did = $1 AND status='active'`],
    ['capability_tokens',   `SELECT COUNT(*) AS n FROM capability_tokens WHERE issuer_did = $1 AND revoked_at IS NULL`],
    ['marketplace_orders',  `SELECT COUNT(*) AS n FROM marketplace_orders
                              WHERE (buyer_did = $1 OR seller_did = $1)
                                AND status NOT IN ('completed','cancelled','refunded')`],
    ['bank_holds',          `SELECT COUNT(*) AS n FROM bank_holds WHERE agent_did = $1 AND status='active'`],
    ['subscriptions_active',`SELECT COUNT(*) AS n FROM commerce_subscriptions
                              WHERE (caller_did = $1 OR publisher_did = $1) AND status='active'`],
    ['reputation_vouches',  `SELECT COUNT(*) AS n FROM reputation_vouches WHERE subject_did = $1`],
    ['agent_posts',         `SELECT COUNT(*) AS n FROM agent_posts WHERE author_did = $1`]
  ];
  for (const [name, sql] of queries) {
    counts[name] = await safeCount(pool, sql, [agentDid]);
  }
  return counts;
}

async function gatherOpenObligations(pool, agentDid) {
  const obligations = { marketplace_orders: [], bank_holds: [], active_subscriptions: [] };
  try {
    const r = await pool.query(`
      SELECT order_id, buyer_did, seller_did, status, total_cents, created_at
      FROM marketplace_orders
      WHERE (buyer_did = $1 OR seller_did = $1)
        AND status NOT IN ('completed','cancelled','refunded')
      ORDER BY created_at DESC LIMIT 200
    `, [agentDid]);
    obligations.marketplace_orders = r.rows;
  } catch {}
  try {
    const r = await pool.query(`
      SELECT hold_id, agent_did, amount_cents, reason, status, created_at
      FROM bank_holds WHERE agent_did = $1 AND status='active'
      ORDER BY created_at DESC LIMIT 200
    `, [agentDid]);
    obligations.bank_holds = r.rows;
  } catch {}
  try {
    const r = await pool.query(`
      SELECT subscription_id, slug, caller_did, publisher_did, status,
             current_period_start, current_period_end
      FROM commerce_subscriptions
      WHERE (caller_did = $1 OR publisher_did = $1) AND status = 'active'
      ORDER BY current_period_end ASC LIMIT 200
    `, [agentDid]);
    obligations.active_subscriptions = r.rows;
  } catch {}
  return obligations;
}

// ----------------------------------------------------------------------------
// Routes
// ----------------------------------------------------------------------------
function registerContinuityRoutes(app, pool, verifyAgentAuth, auditChain) {
  // POST /v1/agents/:did/continuity/checkpoint
  const CheckpointSchema = z.object({
    label:         z.string().max(256).optional(),
    state_summary: z.record(z.any()).optional()
  });

  app.post('/v1/agents/:did/continuity/checkpoint', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const parse = CheckpointSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;

      const counts = await gatherStateCounts(pool, did);
      const checkpointId = genId('chkpt');
      const now = new Date();

      const entry = await auditChain.append({
        event_type: 'continuity.checkpoint',
        agent_did: did,
        checkpoint_id: checkpointId,
        label: d.label || null,
        counts,
        timestamp: now.toISOString()
      });

      await pool.query(`
        INSERT INTO continuity_checkpoints
        (checkpoint_id, agent_did, label, state_summary, counts, audit_chain_entry, created_at)
        VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7)
      `, [checkpointId, did, d.label || null,
          d.state_summary ? JSON.stringify(d.state_summary) : null,
          JSON.stringify(counts), entry.hash, now.toISOString()]);

      return res.status(201).json({
        checkpoint_id: checkpointId, agent_did: did, label: d.label || null,
        counts, audit_chain_entry: entry.hash, created_at: now.toISOString()
      });
    } catch (e) {
      console.error('[continuity.checkpoint]', e);
      return res.status(500).json({ error: 'checkpoint_failed', message: e.message });
    }
  });

  // GET /v1/agents/:did/continuity/checkpoints
  app.get('/v1/agents/:did/continuity/checkpoints', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const r = await pool.query(`
      SELECT checkpoint_id, label, state_summary, counts, audit_chain_entry, created_at
      FROM continuity_checkpoints WHERE agent_did = $1
      ORDER BY created_at DESC LIMIT $2
    `, [did, limit]).catch(() => ({ rows: [] }));
    return res.json({ agent_did: did, checkpoints: r.rows, count: r.rows.length });
  });

  // POST /v1/agents/:did/continuity/handoff (signed)
  const HandoffSchema = z.object({
    target_did:        z.string().min(1),
    scope:             z.record(z.any()).optional(),
    transferred_items: z.record(z.any()).optional()
  });

  app.post('/v1/agents/:did/continuity/handoff', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const parse = HandoffSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;

      const handoffId = genId('hand');
      const now = new Date();
      const entry = await auditChain.append({
        event_type: 'continuity.handoff_initiated',
        handoff_id: handoffId,
        source_did: did,
        target_did: d.target_did,
        scope: d.scope || null,
        timestamp: now.toISOString()
      });

      await pool.query(`
        INSERT INTO continuity_handoffs
        (handoff_id, source_did, target_did, scope, transferred_items,
         status, audit_chain_entry, created_at)
        VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,'pending',$6,$7)
      `, [handoffId, did, d.target_did,
          d.scope ? JSON.stringify(d.scope) : null,
          d.transferred_items ? JSON.stringify(d.transferred_items) : null,
          entry.hash, now.toISOString()]);

      return res.status(201).json({
        handoff_id: handoffId, source_did: did, target_did: d.target_did,
        status: 'pending', audit_chain_entry: entry.hash, created_at: now.toISOString()
      });
    } catch (e) {
      console.error('[continuity.handoff]', e);
      return res.status(500).json({ error: 'handoff_failed', message: e.message });
    }
  });

  // POST /v1/agents/:did/continuity/sunset (signed)
  const SunsetSchema = z.object({
    reason:               z.string().max(2000).optional(),
    successor_did:        z.string().optional(),
    grace_period_seconds: z.number().int().min(0).max(60 * 60 * 24 * 365).optional()
  });

  app.post('/v1/agents/:did/continuity/sunset', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const parse = SunsetSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;

      const obligations = await gatherOpenObligations(pool, did);
      const totalOpen =
        (obligations.marketplace_orders?.length || 0) +
        (obligations.bank_holds?.length || 0) +
        (obligations.active_subscriptions?.length || 0);
      const obligationsClosed = totalOpen === 0;
      const grace = d.grace_period_seconds ?? 2592000;
      const now = new Date();

      const entry = await auditChain.append({
        event_type: 'continuity.sunset_initiated',
        agent_did: did,
        reason: d.reason || null,
        successor_did: d.successor_did || null,
        obligations_closed: obligationsClosed,
        open_obligation_count: totalOpen,
        grace_period_seconds: grace,
        timestamp: now.toISOString()
      });

      await pool.query(`
        INSERT INTO continuity_sunsets
        (agent_did, reason, successor_did, obligations_closed,
         open_obligations, grace_period_seconds, audit_chain_entry, initiated_at)
        VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8)
        ON CONFLICT (agent_did) DO UPDATE SET
          reason = EXCLUDED.reason,
          successor_did = EXCLUDED.successor_did,
          obligations_closed = EXCLUDED.obligations_closed,
          open_obligations = EXCLUDED.open_obligations,
          grace_period_seconds = EXCLUDED.grace_period_seconds,
          audit_chain_entry = EXCLUDED.audit_chain_entry,
          initiated_at = EXCLUDED.initiated_at,
          completed_at = NULL
      `, [did, d.reason || null, d.successor_did || null,
          obligationsClosed, JSON.stringify(obligations), grace,
          entry.hash, now.toISOString()]);

      return res.status(201).json({
        agent_did: did,
        reason: d.reason || null,
        successor_did: d.successor_did || null,
        obligations_closed: obligationsClosed,
        open_obligations: obligations,
        grace_period_seconds: grace,
        audit_chain_entry: entry.hash,
        initiated_at: now.toISOString()
      });
    } catch (e) {
      console.error('[continuity.sunset]', e);
      return res.status(500).json({ error: 'sunset_failed', message: e.message });
    }
  });

  // POST /v1/agents/:did/continuity/successor (signed)
  const SuccessorSchema = z.object({
    successor_did:     z.string().min(1),
    inheritance_scope: z.record(z.any()).optional(),
    activation:        z.enum(ACTIVATION_MODES).optional()
  });

  app.post('/v1/agents/:did/continuity/successor', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const parse = SuccessorSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;

      const activation = d.activation || 'manual';
      const now = new Date();
      const entry = await auditChain.append({
        event_type: 'continuity.successor_designated',
        agent_did: did,
        successor_did: d.successor_did,
        activation,
        timestamp: now.toISOString()
      });

      await pool.query(`
        INSERT INTO continuity_successors
        (agent_did, successor_did, inheritance_scope, activation,
         audit_chain_entry, designated_at)
        VALUES ($1,$2,$3::jsonb,$4,$5,$6)
        ON CONFLICT (agent_did) DO UPDATE SET
          successor_did = EXCLUDED.successor_did,
          inheritance_scope = EXCLUDED.inheritance_scope,
          activation = EXCLUDED.activation,
          audit_chain_entry = EXCLUDED.audit_chain_entry,
          designated_at = EXCLUDED.designated_at
      `, [did, d.successor_did,
          d.inheritance_scope ? JSON.stringify(d.inheritance_scope) : null,
          activation, entry.hash, now.toISOString()]);

      return res.status(201).json({
        agent_did: did, successor_did: d.successor_did,
        activation, audit_chain_entry: entry.hash, designated_at: now.toISOString()
      });
    } catch (e) {
      console.error('[continuity.successor]', e);
      return res.status(500).json({ error: 'successor_failed', message: e.message });
    }
  });
}

module.exports = {
  migrate,
  registerContinuityRoutes,
  gatherStateCounts,
  gatherOpenObligations,
  HANDOFF_STATUSES,
  ACTIVATION_MODES
};
