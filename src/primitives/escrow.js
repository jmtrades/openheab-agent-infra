// ============================================================================
// OpenHeab Escrow — A2A contracts with dispute window
// ============================================================================
const express = require('express');
const cryptoLib = require('crypto');
const { z } = require('zod');

const DEFAULT_REVIEW_WINDOW_HOURS = 72;

const STATUSES = ['pending', 'accepted', 'delivered', 'confirmed', 'disputed', 'cancelled', 'released'];

// ----------------------------------------------------------------------------
// Migration
// ----------------------------------------------------------------------------
async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS escrows (
      escrow_id             TEXT PRIMARY KEY,
      payer_did             TEXT NOT NULL,
      payee_did             TEXT NOT NULL,
      amount_raw            NUMERIC(78,0) NOT NULL,
      chain                 TEXT,
      asset                 TEXT NOT NULL DEFAULT 'USDC',
      description           TEXT,
      deliverable_url       TEXT,
      status                TEXT NOT NULL DEFAULT 'pending',
      review_window_hours   INTEGER NOT NULL DEFAULT 72,
      delivered_at          TIMESTAMPTZ,
      confirmed_at          TIMESTAMPTZ,
      disputed_at           TIMESTAMPTZ,
      released_at           TIMESTAMPTZ,
      cancelled_at          TIMESTAMPTZ,
      claim_id              TEXT,
      idempotency_key       TEXT,
      created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_escrows_payer ON escrows (payer_did);
    CREATE INDEX IF NOT EXISTS idx_escrows_payee ON escrows (payee_did);
    ALTER TABLE escrows ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_escrows_idem ON escrows (payer_did, idempotency_key) WHERE idempotency_key IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_escrows_status ON escrows (status);
    CREATE INDEX IF NOT EXISTS idx_escrows_delivered ON escrows (delivered_at) WHERE status='delivered';

    CREATE TABLE IF NOT EXISTS escrow_events (
      event_id      TEXT PRIMARY KEY,
      escrow_id     TEXT NOT NULL,
      actor_did     TEXT,
      kind          TEXT NOT NULL,
      payload       JSONB,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_escrow_events_escrow ON escrow_events (escrow_id, created_at);
  `).catch(() => {});
}

function genId(prefix) {
  return `${prefix}_${cryptoLib.randomBytes(12).toString('hex')}`;
}

async function logEvent(pool, escrowId, actorDid, kind, payload) {
  await pool.query(
    `INSERT INTO escrow_events (event_id, escrow_id, actor_did, kind, payload)
     VALUES ($1,$2,$3,$4,$5::jsonb)`,
    [genId('escev'), escrowId, actorDid || null, kind, JSON.stringify(payload || {})]
  ).catch(() => {});
}

// ----------------------------------------------------------------------------
// Routes
// ----------------------------------------------------------------------------
function registerEscrowRoutes(app, pool, verifyAgentAuth, auditChain) {
  // POST /v1/escrow — open
  const OpenSchema = z.object({
    payer_did: z.string(),
    payee_did: z.string(),
    amount_raw: z.string().regex(/^\d+$/),
    chain: z.string().optional(),
    asset: z.string().default('USDC'),
    description: z.string().max(4000).optional(),
    deliverable_url: z.string().url().optional(),
    review_window_hours: z.number().int().positive().max(8760).optional()
  });

  app.post('/v1/escrow', express.json(), async (req, res) => {
    try {
      const parse = OpenSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;
      const auth = await verifyAgentAuth(req, d.payer_did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      // Idempotency: if the payer sends X-Idempotency-Key and we've created
      // an escrow with that key already, return the existing one (don't lock
      // the same funds twice on a retry).
      const idemKey = req.headers['x-idempotency-key'];
      if (idemKey) {
        const existing = await pool.query(
          `SELECT escrow_id, payee_did, amount_raw, asset, status, review_window_hours
             FROM escrows
            WHERE payer_did = $1 AND idempotency_key = $2 LIMIT 1`,
          [d.payer_did, String(idemKey)]
        ).catch(() => ({ rows: [] }));
        if (existing.rows[0]) {
          res.setHeader('idempotent-replay', 'true');
          return res.status(200).json({ ...existing.rows[0], payer_did: d.payer_did });
        }
      }

      const escrowId = genId('esc');
      const window = d.review_window_hours || DEFAULT_REVIEW_WINDOW_HOURS;

      try {
        await pool.query(
          `INSERT INTO escrows (escrow_id, payer_did, payee_did, amount_raw, chain,
             asset, description, deliverable_url, status, review_window_hours, idempotency_key)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending',$9,$10)`,
          [escrowId, d.payer_did, d.payee_did, d.amount_raw, d.chain || null,
           d.asset, d.description || null, d.deliverable_url || null, window,
           idemKey ? String(idemKey) : null]
        );
      } catch (insertErr) {
        // Unique-violation on (payer_did, idempotency_key) — race with concurrent retry.
        if (insertErr.code === '23505' && idemKey) {
          const existing = await pool.query(
            `SELECT escrow_id, payee_did, amount_raw, asset, status, review_window_hours
               FROM escrows
              WHERE payer_did = $1 AND idempotency_key = $2 LIMIT 1`,
            [d.payer_did, String(idemKey)]
          ).catch(() => ({ rows: [] }));
          if (existing.rows[0]) {
            res.setHeader('idempotent-replay', 'true');
            return res.status(200).json({ ...existing.rows[0], payer_did: d.payer_did });
          }
        }
        throw insertErr;
      }

      await logEvent(pool, escrowId, d.payer_did, 'opened', { amount_raw: d.amount_raw });
      await auditChain.append({
        event_type: 'escrow.opened',
        escrow_id: escrowId, payer_did: d.payer_did, payee_did: d.payee_did,
        amount_raw: d.amount_raw, timestamp: new Date().toISOString()
      });

      return res.status(201).json({
        escrow_id: escrowId, payer_did: d.payer_did, payee_did: d.payee_did,
        amount_raw: d.amount_raw, asset: d.asset, status: 'pending',
        review_window_hours: window
      });
    } catch (e) {
      console.error('[escrow.open]', e);
      return res.status(500).json({ error: 'open_failed', message: e.message });
    }
  });

  // GET /v1/agents/:did/escrow
  app.get('/v1/agents/:did/escrow', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(
      `SELECT escrow_id, payer_did, payee_did, amount_raw, asset, status,
              review_window_hours, delivered_at, confirmed_at, disputed_at,
              released_at, cancelled_at, created_at
       FROM escrows WHERE payer_did=$1 OR payee_did=$1
       ORDER BY created_at DESC LIMIT 200`,
      [did]
    ).catch(() => ({ rows: [] }));
    return res.json({
      escrows: r.rows.map(row => ({ ...row, amount_raw: String(row.amount_raw) })),
      count: r.rows.length
    });
  });

  // GET /v1/escrow/:id
  app.get('/v1/escrow/:id', async (req, res) => {
    const r = await pool.query(`SELECT * FROM escrows WHERE escrow_id=$1`, [req.params.id])
      .catch(() => ({ rows: [] }));
    if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
    const events = await pool.query(
      `SELECT event_id, actor_did, kind, payload, created_at FROM escrow_events
       WHERE escrow_id=$1 ORDER BY created_at ASC`, [req.params.id]
    ).catch(() => ({ rows: [] }));
    const escrow = { ...r.rows[0], amount_raw: String(r.rows[0].amount_raw) };
    return res.json({ ...escrow, events: events.rows });
  });

  // POST /v1/escrow/:id/accept — payee accepts
  app.post('/v1/escrow/:id/accept', express.json(), async (req, res) => {
    try {
      const row = await pool.query(`SELECT payee_did, status FROM escrows WHERE escrow_id=$1`, [req.params.id])
        .catch(() => ({ rows: [] }));
      if (!row.rows[0]) return res.status(404).json({ error: 'not_found' });
      const auth = await verifyAgentAuth(req, row.rows[0].payee_did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      if (row.rows[0].status !== 'pending') return res.status(400).json({ error: 'not_pending' });

      await pool.query(`UPDATE escrows SET status='accepted' WHERE escrow_id=$1`, [req.params.id]);
      await logEvent(pool, req.params.id, row.rows[0].payee_did, 'accepted', {});
      await auditChain.append({
        event_type: 'escrow.accepted', escrow_id: req.params.id,
        timestamp: new Date().toISOString()
      });
      return res.json({ escrow_id: req.params.id, status: 'accepted' });
    } catch (e) {
      console.error('[escrow.accept]', e);
      return res.status(500).json({ error: 'accept_failed', message: e.message });
    }
  });

  // POST /v1/escrow/:id/deliver — payee delivers
  const DeliverSchema = z.object({
    deliverable_url: z.string().url().optional(),
    notes: z.string().max(4000).optional()
  });
  app.post('/v1/escrow/:id/deliver', express.json(), async (req, res) => {
    try {
      const parse = DeliverSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const row = await pool.query(`SELECT payee_did, status FROM escrows WHERE escrow_id=$1`, [req.params.id])
        .catch(() => ({ rows: [] }));
      if (!row.rows[0]) return res.status(404).json({ error: 'not_found' });
      const auth = await verifyAgentAuth(req, row.rows[0].payee_did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      if (!['pending', 'accepted'].includes(row.rows[0].status)) {
        return res.status(400).json({ error: 'cannot_deliver' });
      }

      await pool.query(
        `UPDATE escrows SET status='delivered', delivered_at=NOW(),
           deliverable_url = COALESCE($1, deliverable_url)
         WHERE escrow_id=$2`,
        [parse.data.deliverable_url || null, req.params.id]
      );
      await logEvent(pool, req.params.id, row.rows[0].payee_did, 'delivered', parse.data);
      await auditChain.append({
        event_type: 'escrow.delivered', escrow_id: req.params.id,
        timestamp: new Date().toISOString()
      });
      return res.json({ escrow_id: req.params.id, status: 'delivered' });
    } catch (e) {
      console.error('[escrow.deliver]', e);
      return res.status(500).json({ error: 'deliver_failed', message: e.message });
    }
  });

  // POST /v1/escrow/:id/confirm — payer confirms, releases
  app.post('/v1/escrow/:id/confirm', express.json(), async (req, res) => {
    try {
      const row = await pool.query(
        `SELECT payer_did, status FROM escrows WHERE escrow_id=$1`, [req.params.id]
      ).catch(() => ({ rows: [] }));
      if (!row.rows[0]) return res.status(404).json({ error: 'not_found' });
      const auth = await verifyAgentAuth(req, row.rows[0].payer_did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      if (!['delivered', 'accepted'].includes(row.rows[0].status)) {
        return res.status(400).json({ error: 'cannot_confirm' });
      }

      await pool.query(
        `UPDATE escrows SET status='released', confirmed_at=NOW(), released_at=NOW()
         WHERE escrow_id=$1`, [req.params.id]
      );
      await logEvent(pool, req.params.id, row.rows[0].payer_did, 'confirmed', {});
      await auditChain.append({
        event_type: 'escrow.released',
        escrow_id: req.params.id, reason: 'payer_confirmed',
        timestamp: new Date().toISOString()
      });
      return res.json({ escrow_id: req.params.id, status: 'released' });
    } catch (e) {
      console.error('[escrow.confirm]', e);
      return res.status(500).json({ error: 'confirm_failed', message: e.message });
    }
  });

  // POST /v1/escrow/:id/dispute — either party
  const DisputeSchema = z.object({
    actor_did: z.string(),
    reason: z.string().min(1).max(4000),
    claim_id: z.string().optional()
  });
  app.post('/v1/escrow/:id/dispute', express.json(), async (req, res) => {
    try {
      const parse = DisputeSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const { actor_did, reason, claim_id } = parse.data;
      const row = await pool.query(
        `SELECT payer_did, payee_did, status FROM escrows WHERE escrow_id=$1`,
        [req.params.id]
      ).catch(() => ({ rows: [] }));
      if (!row.rows[0]) return res.status(404).json({ error: 'not_found' });
      if (![row.rows[0].payer_did, row.rows[0].payee_did].includes(actor_did)) {
        return res.status(403).json({ error: 'not_a_party' });
      }
      const auth = await verifyAgentAuth(req, actor_did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      if (['released', 'cancelled'].includes(row.rows[0].status)) {
        return res.status(400).json({ error: 'final_state' });
      }

      await pool.query(
        `UPDATE escrows SET status='disputed', disputed_at=NOW(), claim_id=$1
         WHERE escrow_id=$2`,
        [claim_id || null, req.params.id]
      );
      await logEvent(pool, req.params.id, actor_did, 'disputed', { reason, claim_id });
      await auditChain.append({
        event_type: 'escrow.disputed', escrow_id: req.params.id,
        actor_did, reason, timestamp: new Date().toISOString()
      });
      return res.json({ escrow_id: req.params.id, status: 'disputed' });
    } catch (e) {
      console.error('[escrow.dispute]', e);
      return res.status(500).json({ error: 'dispute_failed', message: e.message });
    }
  });

  // POST /v1/escrow/:id/cancel — both parties
  const CancelSchema = z.object({
    actor_did: z.string(),
    reason: z.string().max(4000).optional()
  });
  app.post('/v1/escrow/:id/cancel', express.json(), async (req, res) => {
    try {
      const parse = CancelSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const { actor_did, reason } = parse.data;
      const row = await pool.query(
        `SELECT payer_did, payee_did, status FROM escrows WHERE escrow_id=$1`,
        [req.params.id]
      ).catch(() => ({ rows: [] }));
      if (!row.rows[0]) return res.status(404).json({ error: 'not_found' });
      if (![row.rows[0].payer_did, row.rows[0].payee_did].includes(actor_did)) {
        return res.status(403).json({ error: 'not_a_party' });
      }
      const auth = await verifyAgentAuth(req, actor_did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      if (['released', 'cancelled', 'disputed'].includes(row.rows[0].status)) {
        return res.status(400).json({ error: 'cannot_cancel' });
      }

      // Record cancellation request; only cancel when both sides agreed
      await logEvent(pool, req.params.id, actor_did, 'cancel_requested', { reason });
      const events = await pool.query(
        `SELECT DISTINCT actor_did FROM escrow_events
         WHERE escrow_id=$1 AND kind='cancel_requested'`,
        [req.params.id]
      ).catch(() => ({ rows: [] }));
      const requesters = new Set(events.rows.map(r => r.actor_did));
      const bothAgreed = requesters.has(row.rows[0].payer_did) && requesters.has(row.rows[0].payee_did);

      if (bothAgreed) {
        await pool.query(
          `UPDATE escrows SET status='cancelled', cancelled_at=NOW() WHERE escrow_id=$1`,
          [req.params.id]
        );
        await auditChain.append({
          event_type: 'escrow.cancelled', escrow_id: req.params.id,
          timestamp: new Date().toISOString()
        });
        return res.json({ escrow_id: req.params.id, status: 'cancelled' });
      }

      return res.json({
        escrow_id: req.params.id, status: row.rows[0].status,
        cancel_request_recorded: true, pending_counterparty: true
      });
    } catch (e) {
      console.error('[escrow.cancel]', e);
      return res.status(500).json({ error: 'cancel_failed', message: e.message });
    }
  });

  // Cron: auto-release after review window
  const { registerCron } = require('../cron_auth');
  registerCron(app, '/v1/_jobs/escrow-auto-release', async (req, res) => {
    try {
      const r = await tickAutoRelease(pool, auditChain);
      res.json(r);
    } catch (e) {
      res.status(500).json({ error: 'auto_release_failed', message: e.message });
    }
  });
}

// ----------------------------------------------------------------------------
// Auto-release tick
// ----------------------------------------------------------------------------
async function tickAutoRelease(pool, auditChain) {
  const r = await pool.query(
    `SELECT escrow_id, payee_did, review_window_hours, delivered_at
     FROM escrows WHERE status='delivered' AND delivered_at IS NOT NULL
       AND delivered_at + (review_window_hours || ' hours')::interval < NOW()`
  ).catch(() => ({ rows: [] }));

  let released = 0;
  for (const row of r.rows) {
    await pool.query(
      `UPDATE escrows SET status='released', released_at=NOW() WHERE escrow_id=$1`,
      [row.escrow_id]
    ).catch(() => {});
    released += 1;
    if (auditChain) {
      await auditChain.append({
        event_type: 'escrow.auto_released',
        escrow_id: row.escrow_id, payee_did: row.payee_did,
        timestamp: new Date().toISOString()
      });
    }
  }
  return { released };
}

module.exports = {
  migrate,
  registerEscrowRoutes,
  tickAutoRelease,
  DEFAULT_REVIEW_WINDOW_HOURS
};
