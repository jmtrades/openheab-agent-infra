// ============================================================================
// OpenHeab Webhooks — Universal webhook system across all primitives
// Tables: webhook_endpoints, webhook_events, webhook_deliveries
// Cron: /v1/_jobs/webhooks-deliver
// Exported: emitEvent(pool, kind, payload, agent_did?) — used by other primitives
// Backoff: 5s, 30s, 5m, 30m, 2h, 12h
// ============================================================================
const cryptoLib = require('crypto');
const express = require('express');
const { z } = require('zod');
const { registerCron } = require('../cron_auth');

const DELIVERY_STATUSES = ['pending', 'delivered', 'failed'];
const BACKOFF_SECONDS = [5, 30, 300, 1800, 7200, 43200];
const BATCH_SIZE = parseInt(process.env.WEBHOOKS_BATCH_SIZE || '50');

// ----------------------------------------------------------------------------
// Migration
// ----------------------------------------------------------------------------
async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS webhook_endpoints (
      endpoint_id      TEXT PRIMARY KEY,
      owner_did        TEXT NOT NULL,
      url              TEXT NOT NULL,
      secret           TEXT NOT NULL,
      event_types      TEXT[] NOT NULL DEFAULT '{}',
      active           BOOLEAN NOT NULL DEFAULT TRUE,
      description      TEXT,
      retry_max        INTEGER NOT NULL DEFAULT 6,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_delivery_at TIMESTAMPTZ,
      failure_count    INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_wh_endpoints_owner ON webhook_endpoints (owner_did);

    CREATE TABLE IF NOT EXISTS webhook_events (
      event_id         TEXT PRIMARY KEY,
      kind             TEXT NOT NULL,
      source_primitive TEXT,
      agent_did        TEXT,
      payload          JSONB,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_wh_events_kind ON webhook_events (kind, created_at DESC);

    CREATE TABLE IF NOT EXISTS webhook_deliveries (
      delivery_id      TEXT PRIMARY KEY,
      endpoint_id      TEXT NOT NULL REFERENCES webhook_endpoints(endpoint_id) ON DELETE CASCADE,
      event_id         TEXT NOT NULL REFERENCES webhook_events(event_id) ON DELETE CASCADE,
      attempt          INTEGER NOT NULL DEFAULT 0,
      status           TEXT NOT NULL DEFAULT 'pending',
      response_status  INTEGER,
      response_body    TEXT,
      next_retry_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      delivered_at     TIMESTAMPTZ,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_wh_deliveries_pending
      ON webhook_deliveries (status, next_retry_at)
      WHERE status = 'pending';
  `);
}

function genEndpointId() { return 'whep_' + cryptoLib.randomBytes(12).toString('hex'); }
function genEventId()    { return 'whev_' + cryptoLib.randomBytes(12).toString('hex'); }
function genDeliveryId() { return 'whdl_' + cryptoLib.randomBytes(12).toString('hex'); }
function genSecret()     { return 'whsec_' + cryptoLib.randomBytes(24).toString('hex'); }

function sign(secret, body) {
  return cryptoLib.createHmac('sha256', secret).update(body).digest('hex');
}

function matchesEventType(eventTypes, kind) {
  if (!eventTypes || eventTypes.length === 0) return true;
  if (eventTypes.includes(kind)) return true;
  // Wildcard support: 'errors.*' matches 'errors.foo.bar'
  for (const t of eventTypes) {
    if (t.endsWith('.*')) {
      const prefix = t.slice(0, -2);
      if (kind === prefix || kind.startsWith(prefix + '.')) return true;
    }
    if (t === '*') return true;
  }
  return false;
}

// ----------------------------------------------------------------------------
// emitEvent — exported for other primitives to fire events
// ----------------------------------------------------------------------------
async function emitEvent(pool, kind, payload, agent_did, source_primitive) {
  const eventId = genEventId();
  await pool.query(
    `INSERT INTO webhook_events (event_id, kind, source_primitive, agent_did, payload)
     VALUES ($1,$2,$3,$4,$5::jsonb)`,
    [eventId, kind, source_primitive || null, agent_did || null,
     payload ? JSON.stringify(payload) : null]
  ).catch(() => {});

  // Find matching endpoints
  const endR = await pool.query(`
    SELECT endpoint_id, event_types FROM webhook_endpoints
     WHERE active = TRUE
       AND ($1::text IS NULL OR owner_did = $1 OR owner_did IS NULL)
  `, [agent_did || null]).catch(() => ({ rows: [] }));

  let enqueued = 0;
  for (const e of endR.rows) {
    if (!matchesEventType(e.event_types, kind)) continue;
    await pool.query(
      `INSERT INTO webhook_deliveries
       (delivery_id, endpoint_id, event_id, attempt, status, next_retry_at)
       VALUES ($1,$2,$3,0,'pending',NOW())`,
      [genDeliveryId(), e.endpoint_id, eventId]
    ).catch(() => {});
    enqueued++;
  }
  return { event_id: eventId, kind, enqueued };
}

// ----------------------------------------------------------------------------
// Delivery loop
// ----------------------------------------------------------------------------
async function processDeliveries(pool, auditChain) {
  const pending = await pool.query(`
    SELECT d.delivery_id, d.endpoint_id, d.event_id, d.attempt,
           e.url, e.secret, e.retry_max,
           ev.kind, ev.payload, ev.source_primitive, ev.agent_did, ev.created_at
      FROM webhook_deliveries d
      JOIN webhook_endpoints e ON e.endpoint_id = d.endpoint_id AND e.active = TRUE
      JOIN webhook_events ev ON ev.event_id = d.event_id
     WHERE d.status = 'pending' AND d.next_retry_at <= NOW()
     ORDER BY d.next_retry_at ASC LIMIT $1
  `, [BATCH_SIZE]).catch(() => ({ rows: [] }));

  let delivered = 0, failed = 0;
  for (const d of pending.rows) {
    const body = JSON.stringify({
      event_id: d.event_id, kind: d.kind, source_primitive: d.source_primitive,
      agent_did: d.agent_did, payload: d.payload,
      created_at: d.created_at, attempt: d.attempt + 1
    });
    const sig = sign(d.secret, body);
    let respStatus = 0, respBody = '';
    try {
      const resp = await fetch(d.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-openheab-sig': sig,
          'x-openheab-event': d.kind,
          'x-openheab-delivery': d.delivery_id
        },
        body
      });
      respStatus = resp.status;
      respBody = (await resp.text().catch(() => '')).slice(0, 2000);
    } catch (e) {
      respBody = e.message || '';
    }
    const ok = respStatus >= 200 && respStatus < 300;
    if (ok) {
      delivered++;
      await pool.query(`
        UPDATE webhook_deliveries
           SET status = 'delivered', delivered_at = NOW(),
               response_status = $1, response_body = $2, attempt = $3
         WHERE delivery_id = $4
      `, [respStatus, respBody, d.attempt + 1, d.delivery_id]).catch(() => {});
      await pool.query(`
        UPDATE webhook_endpoints SET last_delivery_at = NOW(), failure_count = 0
         WHERE endpoint_id = $1
      `, [d.endpoint_id]).catch(() => {});
    } else {
      failed++;
      const next = d.attempt + 1;
      const giveUp = next >= (d.retry_max || BACKOFF_SECONDS.length);
      const backoffSec = BACKOFF_SECONDS[Math.min(next - 1, BACKOFF_SECONDS.length - 1)];
      await pool.query(`
        UPDATE webhook_deliveries
           SET status = $1, attempt = $2, response_status = $3,
               response_body = $4, next_retry_at = NOW() + ($5 || ' seconds')::interval
         WHERE delivery_id = $6
      `, [giveUp ? 'failed' : 'pending', next, respStatus, respBody,
          String(backoffSec), d.delivery_id]).catch(() => {});
      await pool.query(`
        UPDATE webhook_endpoints
           SET failure_count = failure_count + 1,
               active = CASE WHEN failure_count + 1 >= $1 THEN FALSE ELSE active END
         WHERE endpoint_id = $2
      `, [(d.retry_max || BACKOFF_SECONDS.length) * 2, d.endpoint_id]).catch(() => {});
    }
  }
  if (auditChain && (delivered + failed) > 0) {
    await auditChain.append({
      event_type: 'webhooks.batch_processed',
      delivered, failed, scanned: pending.rows.length,
      timestamp: new Date().toISOString()
    });
  }
  return { delivered, failed, scanned: pending.rows.length };
}

// ----------------------------------------------------------------------------
// Routes
// ----------------------------------------------------------------------------
function registerWebhooksRoutes(app, pool, verifyAgentAuth, auditChain) {
  // POST /v1/agents/:did/webhooks — subscribe
  const EndpointSchema = z.object({
    url: z.string().min(1).max(2048),
    event_types: z.array(z.string().max(128)).optional().default([]),
    description: z.string().max(2048).optional(),
    retry_max: z.number().int().min(1).max(20).optional().default(6),
    secret: z.string().max(256).optional()
  });

  app.post('/v1/agents/:did/webhooks', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const parse = EndpointSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;

      const endpointId = genEndpointId();
      const secret = d.secret || genSecret();
      await pool.query(
        `INSERT INTO webhook_endpoints
         (endpoint_id, owner_did, url, secret, event_types, description, retry_max)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [endpointId, did, d.url, secret, d.event_types || [], d.description || null, d.retry_max]
      );

      await auditChain.append({
        event_type: 'webhooks.subscribed',
        endpoint_id: endpointId, owner_did: did,
        url: d.url, event_types: d.event_types,
        timestamp: new Date().toISOString()
      });

      return res.status(201).json({
        endpoint_id: endpointId, owner_did: did, url: d.url,
        secret, event_types: d.event_types || [],
        description: d.description || null, retry_max: d.retry_max,
        active: true, created_at: new Date().toISOString()
      });
    } catch (e) {
      console.error('[webhooks.subscribe]', e);
      return res.status(500).json({ error: 'subscribe_failed', message: e.message });
    }
  });

  // GET /v1/agents/:did/webhooks
  app.get('/v1/agents/:did/webhooks', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(
      `SELECT endpoint_id, url, event_types, active, description, retry_max,
              created_at, last_delivery_at, failure_count
       FROM webhook_endpoints WHERE owner_did = $1 ORDER BY created_at DESC`,
      [did]
    ).catch(() => ({ rows: [] }));
    return res.json({ endpoints: r.rows, count: r.rows.length });
  });

  // DELETE /v1/agents/:did/webhooks/:id
  app.delete('/v1/agents/:did/webhooks/:id', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const r = await pool.query(
        `DELETE FROM webhook_endpoints WHERE endpoint_id = $1 AND owner_did = $2 RETURNING endpoint_id`,
        [req.params.id, did]
      ).catch(() => ({ rows: [] }));
      if (!r.rows[0]) return res.status(404).json({ error: 'endpoint_not_found' });

      await auditChain.append({
        event_type: 'webhooks.unsubscribed',
        endpoint_id: req.params.id, owner_did: did,
        timestamp: new Date().toISOString()
      });
      return res.json({ endpoint_id: req.params.id, deleted: true });
    } catch (e) {
      console.error('[webhooks.delete]', e);
      return res.status(500).json({ error: 'delete_failed', message: e.message });
    }
  });

  // POST /v1/agents/:did/webhooks/:id/test
  app.post('/v1/agents/:did/webhooks/:id/test', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const ep = await pool.query(
        `SELECT endpoint_id FROM webhook_endpoints
         WHERE endpoint_id = $1 AND owner_did = $2`,
        [req.params.id, did]
      ).catch(() => ({ rows: [] }));
      if (!ep.rows[0]) return res.status(404).json({ error: 'endpoint_not_found' });

      const eventId = genEventId();
      const kind = req.body?.kind || 'test.ping';
      await pool.query(
        `INSERT INTO webhook_events (event_id, kind, source_primitive, agent_did, payload)
         VALUES ($1,$2,'test',$3,$4::jsonb)`,
        [eventId, kind, did, JSON.stringify({ test: true, message: 'OpenHeab webhook test' })]
      );
      const deliveryId = genDeliveryId();
      await pool.query(
        `INSERT INTO webhook_deliveries
         (delivery_id, endpoint_id, event_id, attempt, status, next_retry_at)
         VALUES ($1,$2,$3,0,'pending',NOW())`,
        [deliveryId, req.params.id, eventId]
      );

      return res.status(201).json({
        delivery_id: deliveryId, event_id: eventId, kind, status: 'pending'
      });
    } catch (e) {
      console.error('[webhooks.test]', e);
      return res.status(500).json({ error: 'test_failed', message: e.message });
    }
  });

  // GET /v1/agents/:did/webhooks/:id/deliveries
  app.get('/v1/agents/:did/webhooks/:id/deliveries', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });

    const ep = await pool.query(
      `SELECT endpoint_id FROM webhook_endpoints
       WHERE endpoint_id = $1 AND owner_did = $2`,
      [req.params.id, did]
    ).catch(() => ({ rows: [] }));
    if (!ep.rows[0]) return res.status(404).json({ error: 'endpoint_not_found' });

    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    const r = await pool.query(
      `SELECT d.delivery_id, d.event_id, d.attempt, d.status,
              d.response_status, d.response_body, d.next_retry_at,
              d.delivered_at, d.created_at,
              ev.kind, ev.source_primitive
       FROM webhook_deliveries d JOIN webhook_events ev ON ev.event_id = d.event_id
       WHERE d.endpoint_id = $1 ORDER BY d.created_at DESC LIMIT $2`,
      [req.params.id, limit]
    ).catch(() => ({ rows: [] }));
    return res.json({ deliveries: r.rows, count: r.rows.length });
  });

  // Cron: webhooks-deliver
  registerCron(app, '/v1/_jobs/webhooks-deliver', async (req, res) => {
    try {
      const r = await processDeliveries(pool, auditChain);
      return res.json(r);
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  });
}

module.exports = {
  migrate,
  registerWebhooksRoutes,
  emitEvent,
  processDeliveries,
  sign,
  matchesEventType,
  BACKOFF_SECONDS
};
