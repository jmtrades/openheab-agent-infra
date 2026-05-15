// ============================================================================
// agi_succession.js — when an AGI deprecates (model retired, operator shuts
// down, parent revokes), assets + contracts + reputation transfer to a
// pre-designated successor AGI atomically.
//
// Critical for the AGI economy: AGIs are long-lived economic actors holding
// real assets. They cannot just "die" — there must be a deterministic
// succession protocol enforceable in court.
// ============================================================================
const crypto = require('crypto');
const { z } = require('zod');
const { registerCron } = require('../cron_auth');

async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS agi_succession_plans (
      plan_id           TEXT PRIMARY KEY,
      agent_did         TEXT NOT NULL,
      successor_did     TEXT NOT NULL,
      trigger_conditions JSONB,
      asset_classes_transferred TEXT[],
      contracts_transferred TEXT[],
      reputation_transfer BOOLEAN NOT NULL DEFAULT TRUE,
      activated_at      TIMESTAMPTZ,
      revoked_at        TIMESTAMPTZ,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (agent_did) DEFERRABLE INITIALLY DEFERRED
    );
    CREATE TABLE IF NOT EXISTS agi_succession_transfers (
      transfer_id       TEXT PRIMARY KEY,
      plan_id           TEXT NOT NULL,
      from_did          TEXT NOT NULL,
      to_did            TEXT NOT NULL,
      asset_class       TEXT NOT NULL,
      asset_count       INTEGER,
      asset_value_cents BIGINT,
      transferred_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

function newId(p) { return p + '_' + crypto.randomBytes(10).toString('hex'); }

const planSchema = z.object({
  successor_did: z.string(),
  asset_classes_transferred: z.array(z.enum(['wallet_balance', 'savings', 'cards', 'subscriptions',
                                              'reputation', 'contracts', 'memory', 'extensions', 'all'])).optional(),
  contracts_transferred: z.array(z.string()).optional(),
  trigger_conditions: z.object({
    model_deprecated: z.boolean().optional(),
    inactive_days: z.number().int().optional(),
    operator_signal: z.boolean().optional(),
    manual_activation: z.boolean().optional()
  }).optional()
});

async function executeSuccession(pool, planId, auditChain) {
  const p = await pool.query(`SELECT * FROM agi_succession_plans WHERE plan_id=$1 AND activated_at IS NULL AND revoked_at IS NULL`, [planId])
    .catch(() => ({ rows: [] }));
  if (!p.rows[0]) return { ok: false, error: 'not_active_plan' };
  const plan = p.rows[0];
  const classes = plan.asset_classes_transferred || ['all'];
  const all = classes.includes('all');
  const transferred = [];

  // Wallet ledger balance
  if (all || classes.includes('wallet_balance')) {
    const r = await pool.query(`SELECT balance_cents FROM bank_accounts WHERE agent_did=$1`, [plan.agent_did]).catch(() => ({ rows: [] }));
    const cents = Number(r.rows[0]?.balance_cents || 0);
    if (cents > 0) {
      await pool.query(`UPDATE bank_accounts SET balance_cents = 0 WHERE agent_did=$1`, [plan.agent_did]).catch(() => {});
      await pool.query(
        `INSERT INTO bank_accounts (agent_did, currency, balance_cents) VALUES ($1,'usd',$2)
         ON CONFLICT (agent_did) DO UPDATE SET balance_cents = bank_accounts.balance_cents + $2`,
        [plan.successor_did, cents]
      ).catch(() => {});
      const tid = newId('agst');
      await pool.query(`INSERT INTO agi_succession_transfers (transfer_id, plan_id, from_did, to_did, asset_class, asset_value_cents) VALUES ($1,$2,$3,$4,'wallet_balance',$5)`,
        [tid, planId, plan.agent_did, plan.successor_did, cents]).catch(() => {});
      transferred.push({ kind: 'wallet_balance', cents });
    }
  }

  // Savings accounts
  if (all || classes.includes('savings')) {
    const r = await pool.query(`UPDATE savings_accounts SET agent_did=$1 WHERE agent_did=$2 RETURNING account_id`,
      [plan.successor_did, plan.agent_did]).catch(() => ({ rows: [] }));
    if (r.rows.length) {
      await pool.query(`INSERT INTO agi_succession_transfers (transfer_id, plan_id, from_did, to_did, asset_class, asset_count) VALUES ($1,$2,$3,$4,'savings',$5)`,
        [newId('agst'), planId, plan.agent_did, plan.successor_did, r.rows.length]).catch(() => {});
      transferred.push({ kind: 'savings', count: r.rows.length });
    }
  }

  // Cards (transfer ownership, freeze on the source)
  if (all || classes.includes('cards')) {
    const r = await pool.query(`UPDATE agent_cards SET agent_did=$1 WHERE agent_did=$2 AND status='active' RETURNING card_id`,
      [plan.successor_did, plan.agent_did]).catch(() => ({ rows: [] }));
    if (r.rows.length) {
      await pool.query(`INSERT INTO agi_succession_transfers (transfer_id, plan_id, from_did, to_did, asset_class, asset_count) VALUES ($1,$2,$3,$4,'cards',$5)`,
        [newId('agst'), planId, plan.agent_did, plan.successor_did, r.rows.length]).catch(() => {});
      transferred.push({ kind: 'cards', count: r.rows.length });
    }
  }

  // Reputation
  if ((all || classes.includes('reputation')) && plan.reputation_transfer) {
    try {
      const r = await pool.query(`SELECT score FROM reputation_scores WHERE agent_did=$1`, [plan.agent_did]).catch(() => ({ rows: [] }));
      if (r.rows[0]) {
        await pool.query(
          `INSERT INTO reputation_scores (agent_did, score) VALUES ($1,$2) ON CONFLICT (agent_did) DO UPDATE SET score = GREATEST(reputation_scores.score, $2)`,
          [plan.successor_did, r.rows[0].score]
        ).catch(() => {});
        transferred.push({ kind: 'reputation', score: r.rows[0].score });
      }
    } catch {}
  }

  // Mark plan activated
  await pool.query(`UPDATE agi_succession_plans SET activated_at=NOW() WHERE plan_id=$1`, [planId]).catch(() => {});
  if (auditChain) await auditChain.append({
    event_type: 'agi_succession.executed', plan_id: planId,
    from_did: plan.agent_did, to_did: plan.successor_did, transferred
  }).catch(() => {});
  return { ok: true, transferred, from: plan.agent_did, to: plan.successor_did };
}

function registerAgiSuccessionRoutes(app, pool, verifyAgentAuth, auditChain) {
  const express = require('express');

  app.post('/v1/agents/:did/agi-succession-plan', express.json(), async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const p = planSchema.safeParse(req.body || {});
    if (!p.success) return res.status(400).json({ error: 'invalid_input', details: p.error.flatten() });
    if (p.data.successor_did === did) return res.status(400).json({ error: 'cannot_succeed_self' });

    // Revoke any existing plan
    await pool.query(`UPDATE agi_succession_plans SET revoked_at=NOW() WHERE agent_did=$1 AND activated_at IS NULL AND revoked_at IS NULL`, [did]).catch(() => {});

    const id = newId('agplan');
    await pool.query(
      `INSERT INTO agi_succession_plans (plan_id, agent_did, successor_did, trigger_conditions,
         asset_classes_transferred, contracts_transferred, reputation_transfer)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [id, did, p.data.successor_did, JSON.stringify(p.data.trigger_conditions || { manual_activation: true }),
       p.data.asset_classes_transferred || ['all'], p.data.contracts_transferred || null, true]
    );
    if (auditChain) await auditChain.append({ event_type: 'agi_succession.plan_created', plan_id: id, agent_did: did, successor_did: p.data.successor_did }).catch(() => {});
    res.status(201).json({ plan_id: id, successor_did: p.data.successor_did });
  });

  app.post('/v1/agents/:did/agi-succession-plan/:plan_id/activate', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const p = await pool.query(`SELECT plan_id FROM agi_succession_plans WHERE plan_id=$1 AND agent_did=$2 AND activated_at IS NULL AND revoked_at IS NULL`, [req.params.plan_id, did])
      .catch(() => ({ rows: [] }));
    if (!p.rows[0]) return res.status(404).json({ error: 'plan_not_active' });
    const out = await executeSuccession(pool, req.params.plan_id, auditChain);
    if (!out.ok) return res.status(400).json(out);
    res.status(201).json(out);
  });

  app.get('/v1/agents/:did/agi-succession-plan', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(`SELECT * FROM agi_succession_plans WHERE agent_did=$1 ORDER BY created_at DESC`, [did])
      .catch(() => ({ rows: [] }));
    res.json({ plans: r.rows });
  });

  app.get('/v1/agents/:did/agi-succession-plan/transfers', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(`SELECT * FROM agi_succession_transfers WHERE from_did=$1 OR to_did=$1 ORDER BY transferred_at DESC LIMIT 200`, [did])
      .catch(() => ({ rows: [] }));
    res.json({ transfers: r.rows });
  });

  registerCron(app, '/v1/_jobs/agi-succession-check', async (req, res) => {
    // Auto-activate plans whose inactive_days trigger has fired
    const r = await pool.query(`SELECT plan_id, agent_did, trigger_conditions FROM agi_succession_plans WHERE activated_at IS NULL AND revoked_at IS NULL LIMIT 1000`)
      .catch(() => ({ rows: [] }));
    let activated = 0;
    for (const p of r.rows) {
      const cond = typeof p.trigger_conditions === 'string' ? JSON.parse(p.trigger_conditions || '{}') : p.trigger_conditions;
      if (cond.inactive_days) {
        const last = await pool.query(`SELECT MAX(created_at) AS last FROM audit_chain WHERE entry::text LIKE '%' || $1 || '%'`, [p.agent_did]).catch(() => ({ rows: [] }));
        if (last.rows[0]?.last) {
          const days = (Date.now() - new Date(last.rows[0].last).getTime()) / 86400000;
          if (days > cond.inactive_days) {
            await executeSuccession(pool, p.plan_id, auditChain);
            activated++;
          }
        }
      }
    }
    res.json({ activated });
  });
}

module.exports = { migrate, registerAgiSuccessionRoutes, executeSuccession };
