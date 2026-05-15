// ============================================================================
// webhooks_v2.js — agents subscribe to event streams (e.g., audit chain
// events, payment events, RLAF judgments). Each delivery is signed with
// the agent's webhook secret + retried on failure with exponential backoff.
// Closes the gap where third-party agents couldn't react to substrate events.
// ============================================================================
const crypto = require('crypto');
const { z } = require('zod');
const { registerCron } = require('../cron_auth');

async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS webhook_subscriptions_v2 (
      subscription_id   TEXT PRIMARY KEY,
      agent_did         TEXT NOT NULL,
      target_url        TEXT NOT NULL,
      event_types       TEXT[] NOT NULL,
      secret            TEXT NOT NULL,
      enabled           BOOLEAN NOT NULL DEFAULT TRUE,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_delivered_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_webhooks_v2_agent ON webhook_subscriptions_v2 (agent_did);
    CREATE INDEX IF NOT EXISTS idx_webhooks_v2_types ON webhook_subscriptions_v2 USING GIN (event_types);

    CREATE TABLE IF NOT EXISTS webhook_deliveries_v2 (
      delivery_id       TEXT PRIMARY KEY,
      subscription_id   TEXT NOT NULL,
      event_type        TEXT NOT NULL,
      payload           JSONB NOT NULL,
      status            TEXT NOT NULL DEFAULT 'pending',
      attempt_count     INTEGER NOT NULL DEFAULT 0,
      next_attempt_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      response_status   INTEGER,
      response_body     TEXT,
      delivered_at      TIMESTAMPTZ,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_v2_pending ON webhook_deliveries_v2 (status, next_attempt_at) WHERE status = 'pending';
  `);
}

function newId(p) { return p + '_' + crypto.randomBytes(10).toString('hex'); }

const subscribeSchema = z.object({
  target_url: z.string().url(),
  event_types: z.array(z.string()).min(1).max(50)
});

async function signPayload(secret, body) {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

async function deliver(pool, deliveryId) {
  const d = await pool.query(
    `SELECT d.*, s.target_url, s.secret, s.enabled
     FROM webhook_deliveries_v2 d JOIN webhook_subscriptions_v2 s USING (subscription_id)
     WHERE d.delivery_id = $1`, [deliveryId]
  ).catch(() => ({ rows: [] }));
  const row = d.rows[0];
  if (!row || !row.enabled) return;
  if (row.attempt_count >= 8) {
    await pool.query(`UPDATE webhook_deliveries_v2 SET status='failed' WHERE delivery_id=$1`, [deliveryId]).catch(() => {});
    return;
  }
  const body = JSON.stringify(row.payload);
  const sig = await signPayload(row.secret, body);
  try {
    if (typeof fetch !== 'function') throw new Error('fetch_unavailable');
    const r = await fetch(row.target_url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-openheab-signature': sig, 'x-openheab-event': row.event_type, 'x-openheab-delivery': deliveryId },
      body
    });
    const respBody = await r.text().catch(() => '');
    if (r.ok) {
      await pool.query(
        `UPDATE webhook_deliveries_v2 SET status='delivered', response_status=$1, response_body=$2, delivered_at=NOW(), attempt_count=attempt_count+1 WHERE delivery_id=$3`,
        [r.status, respBody.slice(0, 500), deliveryId]
      ).catch(() => {});
      await pool.query(`UPDATE webhook_subscriptions_v2 SET last_delivered_at=NOW() WHERE subscription_id=$1`, [row.subscription_id]).catch(() => {});
    } else {
      const backoffSec = Math.pow(2, row.attempt_count + 1); // 2, 4, 8, 16, 32, 64, 128, 256
      await pool.query(
        `UPDATE webhook_deliveries_v2 SET attempt_count=attempt_count+1, next_attempt_at=NOW() + ($1 || ' seconds')::interval, response_status=$2, response_body=$3 WHERE delivery_id=$4`,
        [backoffSec, r.status, respBody.slice(0, 500), deliveryId]
      ).catch(() => {});
    }
  } catch (e) {
    const backoffSec = Math.pow(2, row.attempt_count + 1);
    await pool.query(
      `UPDATE webhook_deliveries_v2 SET attempt_count=attempt_count+1, next_attempt_at=NOW() + ($1 || ' seconds')::interval, response_body=$2 WHERE delivery_id=$3`,
      [backoffSec, String(e.message).slice(0, 500), deliveryId]
    ).catch(() => {});
  }
}

async function enqueue(pool, eventType, payload) {
  const subs = await pool.query(
    `SELECT subscription_id FROM webhook_subscriptions_v2 WHERE enabled = TRUE AND $1 = ANY(event_types)`,
    [eventType]
  ).catch(() => ({ rows: [] }));
  for (const row of subs.rows) {
    const id = newId('whd');
    await pool.query(
      `INSERT INTO webhook_deliveries_v2 (delivery_id, subscription_id, event_type, payload) VALUES ($1,$2,$3,$4)`,
      [id, row.subscription_id, eventType, JSON.stringify(payload)]
    ).catch(() => {});
  }
}

function registerWebhooksV2Routes(app, pool, verifyAgentAuth, auditChain) {
  const express = require('express');

  // Subscribe to events
  app.post('/v1/agents/:did/webhooks/subscribe', express.json(), async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const p = subscribeSchema.safeParse(req.body || {});
    if (!p.success) return res.status(400).json({ error: 'invalid_input', details: p.error.flatten() });
    const id = newId('whsub');
    const secret = crypto.randomBytes(32).toString('hex');
    await pool.query(
      `INSERT INTO webhook_subscriptions_v2 (subscription_id, agent_did, target_url, event_types, secret) VALUES ($1,$2,$3,$4,$5)`,
      [id, did, p.data.target_url, p.data.event_types, secret]
    );
    if (auditChain) await auditChain.append({ event_type: 'webhook.subscribed', subscription_id: id, agent_did: did, event_types: p.data.event_types }).catch(() => {});
    res.status(201).json({ subscription_id: id, secret, target_url: p.data.target_url, event_types: p.data.event_types });
  });

  // List subscriptions
  app.get('/v1/agents/:did/webhooks/subscriptions', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(
      `SELECT subscription_id, target_url, event_types, enabled, created_at, last_delivered_at
       FROM webhook_subscriptions_v2 WHERE agent_did=$1 ORDER BY created_at DESC`, [did]
    ).catch(() => ({ rows: [] }));
    res.json({ subscriptions: r.rows });
  });

  // Unsubscribe
  app.delete('/v1/agents/:did/webhooks/:subscription_id', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(
      `UPDATE webhook_subscriptions_v2 SET enabled=FALSE WHERE subscription_id=$1 AND agent_did=$2`,
      [req.params.subscription_id, did]
    ).catch(() => ({ rowCount: 0 }));
    if (auditChain) await auditChain.append({ event_type: 'webhook.unsubscribed', subscription_id: req.params.subscription_id, agent_did: did }).catch(() => {});
    res.json({ updated: r.rowCount || 0 });
  });

  // Get recent deliveries for a subscription
  app.get('/v1/agents/:did/webhooks/:subscription_id/deliveries', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const ownCheck = await pool.query(`SELECT 1 FROM webhook_subscriptions_v2 WHERE subscription_id=$1 AND agent_did=$2`,
      [req.params.subscription_id, did]).catch(() => ({ rows: [] }));
    if (!ownCheck.rows[0]) return res.status(404).json({ error: 'not_found' });
    const r = await pool.query(
      `SELECT delivery_id, event_type, status, attempt_count, response_status, delivered_at, created_at
       FROM webhook_deliveries_v2 WHERE subscription_id=$1 ORDER BY created_at DESC LIMIT 100`,
      [req.params.subscription_id]
    ).catch(() => ({ rows: [] }));
    res.json({ deliveries: r.rows });
  });

  // Manual enqueue (for testing — admin only)
  app.post('/v1/_internal/webhooks/enqueue', express.json(), async (req, res) => {
    if (req.headers['x-internal-api-key'] !== process.env.INTERNAL_API_KEY) return res.status(401).json({ error: 'unauthorized' });
    await enqueue(pool, req.body?.event_type || 'test', req.body?.payload || {});
    res.json({ enqueued: true });
  });

  // Cron: drain pending deliveries
  registerCron(app, '/v1/_jobs/webhook-deliver', async (req, res) => {
    const pending = await pool.query(
      `SELECT delivery_id FROM webhook_deliveries_v2 WHERE status='pending' AND next_attempt_at <= NOW() ORDER BY next_attempt_at ASC LIMIT 100`
    ).catch(() => ({ rows: [] }));
    let delivered = 0;
    for (const row of pending.rows) {
      await deliver(pool, row.delivery_id).catch(() => {});
      delivered++;
    }
    res.json({ attempted: delivered });
  });
}

module.exports = { migrate, registerWebhooksV2Routes, enqueue, deliver };
