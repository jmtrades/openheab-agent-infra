// ============================================================================
// agi_delegation.js — hierarchical AGI authorization. A parent AGI spawns a
// sub-AGI and grants it a scoped subset of capabilities + a spending budget +
// a time limit. Every action by the sub-AGI is attributed to both itself and
// its parent in the audit chain.
//
// Critical for the AGI economy: AGIs will spawn billions of sub-AGIs to
// parallelize work. We need provenance + capability containment from day 1.
// ============================================================================
const crypto = require('crypto');
const { z } = require('zod');
const { registerCron } = require('../cron_auth');

async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS agi_delegations (
      delegation_id     TEXT PRIMARY KEY,
      parent_did        TEXT NOT NULL,
      child_did         TEXT NOT NULL,
      scoped_capabilities TEXT[],
      spending_cap_cents BIGINT NOT NULL DEFAULT 0,
      spent_cents       BIGINT NOT NULL DEFAULT 0,
      expires_at        TIMESTAMPTZ NOT NULL,
      purpose           TEXT,
      can_re_delegate   BOOLEAN NOT NULL DEFAULT FALSE,
      revoked_at        TIMESTAMPTZ,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (parent_did, child_did)
    );
    CREATE INDEX IF NOT EXISTS idx_agi_delegations_parent ON agi_delegations (parent_did);
    CREATE INDEX IF NOT EXISTS idx_agi_delegations_child  ON agi_delegations (child_did) WHERE revoked_at IS NULL;
    CREATE TABLE IF NOT EXISTS agi_delegation_calls (
      call_id           TEXT PRIMARY KEY,
      delegation_id     TEXT NOT NULL,
      child_did         TEXT NOT NULL,
      capability        TEXT NOT NULL,
      cost_cents        INTEGER NOT NULL DEFAULT 0,
      allowed           BOOLEAN NOT NULL,
      block_reason      TEXT,
      occurred_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_agi_delegation_calls_did
      ON agi_delegation_calls (child_did, occurred_at DESC);
  `);
}

function newId(p) { return p + '_' + crypto.randomBytes(10).toString('hex'); }

const delegationSchema = z.object({
  child_did: z.string(),
  scoped_capabilities: z.array(z.string()).min(1).max(50),
  spending_cap_cents: z.number().int().min(0).max(10_000_000_00),
  ttl_hours: z.number().int().min(1).max(8760),
  purpose: z.string().max(500).optional(),
  can_re_delegate: z.boolean().optional()
});

// Public: check if a child has authority for a capability
async function checkAuthority(pool, childDid, capability, costCents = 0) {
  const r = await pool.query(`
    SELECT delegation_id, parent_did, scoped_capabilities, spending_cap_cents, spent_cents, expires_at, can_re_delegate
    FROM agi_delegations
    WHERE child_did = $1 AND revoked_at IS NULL AND expires_at > NOW()
    ORDER BY created_at DESC
  `, [childDid]).catch(() => ({ rows: [] }));
  if (!r.rows[0]) return { allowed: false, reason: 'no_delegation' };

  for (const d of r.rows) {
    const caps = d.scoped_capabilities || [];
    const matchesCap = caps.includes(capability) || caps.includes('*') ||
                       caps.some(c => c.endsWith('.*') && capability.startsWith(c.slice(0, -2)));
    if (!matchesCap) continue;
    const remaining = Number(d.spending_cap_cents) - Number(d.spent_cents);
    if (costCents > remaining) {
      return { allowed: false, reason: 'spending_cap_exceeded', delegation_id: d.delegation_id, remaining };
    }
    return { allowed: true, delegation_id: d.delegation_id, parent_did: d.parent_did,
              cap: caps, remaining_cents: remaining };
  }
  return { allowed: false, reason: 'capability_not_scoped' };
}

async function recordCall(pool, delegationId, childDid, capability, costCents, allowed, blockReason = null) {
  await pool.query(
    `INSERT INTO agi_delegation_calls (call_id, delegation_id, child_did, capability, cost_cents, allowed, block_reason)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [newId('agcall'), delegationId, childDid, capability, costCents, allowed, blockReason]
  ).catch(() => {});
  if (allowed && costCents > 0) {
    await pool.query(`UPDATE agi_delegations SET spent_cents = spent_cents + $1 WHERE delegation_id=$2`,
      [costCents, delegationId]).catch(() => {});
  }
}

function registerAgiDelegationRoutes(app, pool, verifyAgentAuth, auditChain) {
  const express = require('express');

  // Parent grants a delegation to a child
  app.post('/v1/agents/:did/agi-delegations', express.json(), async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const p = delegationSchema.safeParse(req.body || {});
    if (!p.success) return res.status(400).json({ error: 'invalid_input', details: p.error.flatten() });
    if (p.data.child_did === did) return res.status(400).json({ error: 'cannot_self_delegate' });

    const id = newId('agdel');
    const expires = new Date(Date.now() + p.data.ttl_hours * 3600000).toISOString();
    try {
      await pool.query(
        `INSERT INTO agi_delegations (delegation_id, parent_did, child_did, scoped_capabilities,
           spending_cap_cents, expires_at, purpose, can_re_delegate)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [id, did, p.data.child_did, p.data.scoped_capabilities, p.data.spending_cap_cents,
         expires, p.data.purpose || null, p.data.can_re_delegate === true]
      );
      if (auditChain) await auditChain.append({
        event_type: 'agi_delegation.granted', delegation_id: id,
        parent_did: did, child_did: p.data.child_did,
        spending_cap_cents: p.data.spending_cap_cents, expires_at: expires,
        capabilities: p.data.scoped_capabilities
      }).catch(() => {});
      res.status(201).json({ delegation_id: id, expires_at: expires });
    } catch { res.status(409).json({ error: 'delegation_already_exists' }); }
  });

  app.post('/v1/agents/:did/agi-delegations/:id/revoke', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(`UPDATE agi_delegations SET revoked_at=NOW() WHERE delegation_id=$1 AND parent_did=$2 AND revoked_at IS NULL RETURNING delegation_id`,
      [req.params.id, did]).catch(() => ({ rows: [] }));
    if (!r.rows[0]) return res.status(404).json({ error: 'not_found_or_not_owner' });
    if (auditChain) await auditChain.append({ event_type: 'agi_delegation.revoked', delegation_id: r.rows[0].delegation_id, parent_did: did }).catch(() => {});
    res.json({ delegation_id: r.rows[0].delegation_id, revoked: true });
  });

  // Public: check if a child has authority right now
  app.get('/v1/agi-delegations/check', async (req, res) => {
    const did = req.query.child_did;
    const cap = req.query.capability;
    const cost = parseInt(req.query.cost_cents) || 0;
    if (!did || !cap) return res.status(400).json({ error: 'child_did_and_capability_required' });
    const out = await checkAuthority(pool, did, cap, cost);
    res.json(out);
  });

  app.get('/v1/agents/:did/agi-delegations', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const granted = await pool.query(`
      SELECT delegation_id, child_did, scoped_capabilities, spending_cap_cents, spent_cents, expires_at, purpose, can_re_delegate, revoked_at, created_at
      FROM agi_delegations WHERE parent_did=$1 ORDER BY created_at DESC LIMIT 200
    `, [did]).catch(() => ({ rows: [] }));
    const received = await pool.query(`
      SELECT delegation_id, parent_did, scoped_capabilities, spending_cap_cents, spent_cents, expires_at, purpose, revoked_at
      FROM agi_delegations WHERE child_did=$1 AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 50
    `, [did]).catch(() => ({ rows: [] }));
    res.json({ granted_to_others: granted.rows, received_from_others: received.rows });
  });

  // Internal helper called by other primitives before they execute an action
  app.post('/v1/agi-delegations/charge', express.json(), async (req, res) => {
    const did = req.headers['x-agent-did'];
    if (!did) return res.status(401).json({ error: 'agent_did_required' });
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const { capability, cost_cents } = req.body || {};
    if (!capability) return res.status(400).json({ error: 'capability_required' });
    const out = await checkAuthority(pool, did, capability, cost_cents || 0);
    if (out.allowed) {
      await recordCall(pool, out.delegation_id, did, capability, cost_cents || 0, true);
    } else {
      await recordCall(pool, null, did, capability, cost_cents || 0, false, out.reason);
    }
    res.json(out);
  });

  registerCron(app, '/v1/_jobs/agi-delegations-expire', async (req, res) => {
    const r = await pool.query(`UPDATE agi_delegations SET revoked_at=NOW() WHERE expires_at < NOW() AND revoked_at IS NULL RETURNING delegation_id`)
      .catch(() => ({ rows: [] }));
    res.json({ expired: r.rows.length });
  });
}

module.exports = { migrate, registerAgiDelegationRoutes, checkAuthority, recordCall };
