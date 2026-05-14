// ============================================================================
// OpenHeab Events — Internal event bus with topics, subscribers, ack, retention
// Tables: event_topics, events_log, event_subscriptions, event_acks
// Cron: /v1/_jobs/events-deliver, /v1/_jobs/events-retain
// ============================================================================
const cryptoLib = require('crypto');
const express = require('express');
const { z } = require('zod');
const { registerCron } = require('../cron_auth');

const DELIVERY_KINDS = ['webhook', 'inbox', 'poll'];
const BATCH_SIZE = parseInt(process.env.EVENTS_BATCH_SIZE || '100');

// ----------------------------------------------------------------------------
// Migration
// ----------------------------------------------------------------------------
async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS event_topics (
      topic_id        TEXT PRIMARY KEY,
      owner_did       TEXT NOT NULL,
      name            TEXT NOT NULL,
      description     TEXT,
      retention_hours INTEGER NOT NULL DEFAULT 168,
      max_size        INTEGER NOT NULL DEFAULT 1000000,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (owner_did, name)
    );

    CREATE TABLE IF NOT EXISTS events_log (
      event_id    TEXT PRIMARY KEY,
      topic_id    TEXT NOT NULL REFERENCES event_topics(topic_id) ON DELETE CASCADE,
      kind        TEXT NOT NULL,
      source_did  TEXT,
      payload     JSONB,
      ts          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      sequence    BIGSERIAL
    );
    CREATE INDEX IF NOT EXISTS idx_elog_topic_seq ON events_log (topic_id, sequence);
    CREATE INDEX IF NOT EXISTS idx_elog_topic_ts ON events_log (topic_id, ts DESC);

    CREATE TABLE IF NOT EXISTS event_subscriptions (
      subscription_id TEXT PRIMARY KEY,
      topic_id        TEXT NOT NULL REFERENCES event_topics(topic_id) ON DELETE CASCADE,
      subscriber_did  TEXT NOT NULL,
      delivery_kind   TEXT NOT NULL DEFAULT 'webhook',
      target_url      TEXT,
      filter          JSONB,
      last_event_id   TEXT,
      active          BOOLEAN NOT NULL DEFAULT TRUE,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_esubs_topic ON event_subscriptions (topic_id);
    CREATE INDEX IF NOT EXISTS idx_esubs_subscriber ON event_subscriptions (subscriber_did);

    CREATE TABLE IF NOT EXISTS event_acks (
      subscription_id TEXT NOT NULL REFERENCES event_subscriptions(subscription_id) ON DELETE CASCADE,
      event_id        TEXT NOT NULL REFERENCES events_log(event_id) ON DELETE CASCADE,
      acked_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (subscription_id, event_id)
    );
  `);
}

function genTopicId() { return 'topic_' + cryptoLib.randomBytes(12).toString('hex'); }
function genEventId() { return 'ev_' + cryptoLib.randomBytes(12).toString('hex'); }
function genSubId()   { return 'sub_' + cryptoLib.randomBytes(12).toString('hex'); }

function matchesFilter(filter, kind, payload) {
  if (!filter || typeof filter !== 'object') return true;
  if (filter.kind && filter.kind !== kind) {
    if (Array.isArray(filter.kind) && !filter.kind.includes(kind)) return false;
    else if (!Array.isArray(filter.kind) && filter.kind !== kind) return false;
  }
  if (filter.kind_prefix && !String(kind).startsWith(filter.kind_prefix)) return false;
  if (filter.match && payload) {
    for (const [k, v] of Object.entries(filter.match)) {
      if (payload[k] !== v) return false;
    }
  }
  return true;
}

// ----------------------------------------------------------------------------
// Deliver loop
// ----------------------------------------------------------------------------
async function deliverEvents(pool, auditChain) {
  // For webhook subs: deliver all undelivered (un-acked) events since last_event_id
  const subs = await pool.query(`
    SELECT s.subscription_id, s.topic_id, s.target_url, s.filter,
           s.last_event_id, s.delivery_kind
      FROM event_subscriptions s
     WHERE s.active = TRUE AND s.delivery_kind = 'webhook'
     LIMIT 200
  `).catch(() => ({ rows: [] }));

  let delivered = 0, scanned = 0;
  for (const sub of subs.rows) {
    // Find new events
    let sinceSeq = 0;
    if (sub.last_event_id) {
      const seqR = await pool.query(
        `SELECT sequence FROM events_log WHERE event_id = $1`,
        [sub.last_event_id]
      ).catch(() => ({ rows: [] }));
      sinceSeq = seqR.rows[0]?.sequence || 0;
    }
    const evR = await pool.query(`
      SELECT event_id, kind, source_did, payload, ts, sequence
        FROM events_log WHERE topic_id = $1 AND sequence > $2
        ORDER BY sequence ASC LIMIT $3
    `, [sub.topic_id, sinceSeq, BATCH_SIZE]).catch(() => ({ rows: [] }));

    let lastEvent = null;
    for (const ev of evR.rows) {
      scanned++;
      if (!matchesFilter(sub.filter, ev.kind, ev.payload)) {
        lastEvent = ev;
        continue;
      }
      if (sub.target_url) {
        try {
          const resp = await fetch(sub.target_url, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-openheab-event': ev.kind,
              'x-openheab-event-id': ev.event_id
            },
            body: JSON.stringify({
              event_id: ev.event_id, topic_id: sub.topic_id,
              kind: ev.kind, source_did: ev.source_did,
              payload: ev.payload, ts: ev.ts, sequence: ev.sequence
            })
          });
          if (resp.status >= 200 && resp.status < 300) {
            await pool.query(
              `INSERT INTO event_acks (subscription_id, event_id) VALUES ($1, $2)
               ON CONFLICT DO NOTHING`,
              [sub.subscription_id, ev.event_id]
            ).catch(() => {});
            delivered++;
            lastEvent = ev;
          } else {
            // Stop on first failure for in-order delivery
            break;
          }
        } catch {
          break;
        }
      } else {
        lastEvent = ev;
      }
    }
    if (lastEvent) {
      await pool.query(
        `UPDATE event_subscriptions SET last_event_id = $1 WHERE subscription_id = $2`,
        [lastEvent.event_id, sub.subscription_id]
      ).catch(() => {});
    }
  }
  if (auditChain && delivered > 0) {
    await auditChain.append({
      event_type: 'events.batch_delivered',
      delivered, scanned, subscriptions_count: subs.rows.length,
      timestamp: new Date().toISOString()
    });
  }
  return { delivered, scanned, subscriptions: subs.rows.length };
}

async function retainEvents(pool) {
  const r = await pool.query(`
    DELETE FROM events_log el USING event_topics t
     WHERE el.topic_id = t.topic_id
       AND el.ts < NOW() - (t.retention_hours || ' hours')::interval
  `).catch(() => ({ rowCount: 0 }));
  return { pruned: r.rowCount || 0 };
}

// ----------------------------------------------------------------------------
// Routes
// ----------------------------------------------------------------------------
function registerEventsRoutes(app, pool, verifyAgentAuth, auditChain) {
  // POST /v1/agents/:did/events/topics
  const TopicSchema = z.object({
    name: z.string().min(1).max(256).regex(/^[a-zA-Z0-9_.-]+$/),
    description: z.string().max(2048).optional(),
    retention_hours: z.number().int().min(1).max(8760).optional().default(168),
    max_size: z.number().int().min(1).max(100000000).optional().default(1000000)
  });

  app.post('/v1/agents/:did/events/topics', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const parse = TopicSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;

      const topicId = genTopicId();
      try {
        await pool.query(
          `INSERT INTO event_topics
           (topic_id, owner_did, name, description, retention_hours, max_size)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [topicId, did, d.name, d.description || null, d.retention_hours, d.max_size]
        );
      } catch (e) {
        if (e.code === '23505') return res.status(409).json({ error: 'topic_name_taken' });
        throw e;
      }

      await auditChain.append({
        event_type: 'events.topic_created',
        topic_id: topicId, owner_did: did, name: d.name,
        timestamp: new Date().toISOString()
      });

      return res.status(201).json({
        topic_id: topicId, owner_did: did, name: d.name,
        description: d.description || null, retention_hours: d.retention_hours,
        max_size: d.max_size, created_at: new Date().toISOString()
      });
    } catch (e) {
      console.error('[events.topic.create]', e);
      return res.status(500).json({ error: 'topic_create_failed', message: e.message });
    }
  });

  // POST /v1/events/topics/:id/publish
  const PublishSchema = z.object({
    kind: z.string().min(1).max(256),
    source_did: z.string().max(256).optional(),
    payload: z.any().optional()
  });

  app.post('/v1/events/topics/:id/publish', express.json({ limit: '2mb' }), async (req, res) => {
    try {
      const parse = PublishSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;

      const topicR = await pool.query(
        `SELECT topic_id, owner_did, max_size FROM event_topics WHERE topic_id = $1`,
        [req.params.id]
      ).catch(() => ({ rows: [] }));
      if (!topicR.rows[0]) return res.status(404).json({ error: 'topic_not_found' });
      const topic = topicR.rows[0];

      // Auth: must be owner_did or signed by source_did
      const sourceDid = d.source_did || topic.owner_did;
      const auth = await verifyAgentAuth(req, sourceDid, { strictSignatureRequired: true });
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const eventId = genEventId();
      const r = await pool.query(
        `INSERT INTO events_log (event_id, topic_id, kind, source_did, payload)
         VALUES ($1,$2,$3,$4,$5::jsonb) RETURNING ts, sequence`,
        [eventId, req.params.id, d.kind, sourceDid,
         d.payload != null ? JSON.stringify(d.payload) : null]
      );

      // Prune oldest if past max_size (best-effort)
      if (topic.max_size > 0) {
        await pool.query(`
          DELETE FROM events_log
           WHERE event_id IN (
             SELECT event_id FROM events_log
              WHERE topic_id = $1 ORDER BY sequence DESC OFFSET $2
           )
        `, [req.params.id, topic.max_size]).catch(() => {});
      }

      return res.status(201).json({
        event_id: eventId, topic_id: req.params.id,
        kind: d.kind, source_did: sourceDid,
        ts: r.rows[0].ts, sequence: r.rows[0].sequence
      });
    } catch (e) {
      console.error('[events.publish]', e);
      return res.status(500).json({ error: 'publish_failed', message: e.message });
    }
  });

  // POST /v1/events/topics/:id/subscribe
  const SubSchema = z.object({
    subscriber_did: z.string().min(1).max(256),
    delivery_kind: z.enum(DELIVERY_KINDS).optional().default('webhook'),
    target_url: z.string().max(2048).optional(),
    filter: z.record(z.any()).optional()
  });

  app.post('/v1/events/topics/:id/subscribe', express.json(), async (req, res) => {
    try {
      const parse = SubSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;

      const auth = await verifyAgentAuth(req, d.subscriber_did, { strictSignatureRequired: true });
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const topicR = await pool.query(
        `SELECT topic_id FROM event_topics WHERE topic_id = $1`,
        [req.params.id]
      ).catch(() => ({ rows: [] }));
      if (!topicR.rows[0]) return res.status(404).json({ error: 'topic_not_found' });

      if (d.delivery_kind === 'webhook' && !d.target_url) {
        return res.status(400).json({ error: 'target_url_required_for_webhook' });
      }

      const subscriptionId = genSubId();
      await pool.query(
        `INSERT INTO event_subscriptions
         (subscription_id, topic_id, subscriber_did, delivery_kind, target_url, filter)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
        [subscriptionId, req.params.id, d.subscriber_did, d.delivery_kind,
         d.target_url || null, d.filter ? JSON.stringify(d.filter) : null]
      );

      await auditChain.append({
        event_type: 'events.subscribed',
        subscription_id: subscriptionId, topic_id: req.params.id,
        subscriber_did: d.subscriber_did, delivery_kind: d.delivery_kind,
        timestamp: new Date().toISOString()
      });

      return res.status(201).json({
        subscription_id: subscriptionId, topic_id: req.params.id,
        subscriber_did: d.subscriber_did, delivery_kind: d.delivery_kind,
        target_url: d.target_url || null, filter: d.filter || null,
        active: true, created_at: new Date().toISOString()
      });
    } catch (e) {
      console.error('[events.subscribe]', e);
      return res.status(500).json({ error: 'subscribe_failed', message: e.message });
    }
  });

  // GET /v1/events/topics/:id/poll
  app.get('/v1/events/topics/:id/poll', async (req, res) => {
    const sinceEventId = req.query.since_event_id;
    const limit = Math.min(parseInt(req.query.limit) || 100, 1000);

    const topicR = await pool.query(
      `SELECT topic_id, owner_did FROM event_topics WHERE topic_id = $1`,
      [req.params.id]
    ).catch(() => ({ rows: [] }));
    if (!topicR.rows[0]) return res.status(404).json({ error: 'topic_not_found' });

    // Optional auth: any agent may poll (events are private to owner unless shared)
    const auth = await verifyAgentAuth(req, topicR.rows[0].owner_did).catch(() => ({ valid: false }));
    if (!auth.valid) return res.status(401).json({ error: 'unauthorized' });

    let sinceSeq = 0;
    if (sinceEventId) {
      const seqR = await pool.query(
        `SELECT sequence FROM events_log WHERE event_id = $1`,
        [sinceEventId]
      ).catch(() => ({ rows: [] }));
      sinceSeq = seqR.rows[0]?.sequence || 0;
    }

    const r = await pool.query(
      `SELECT event_id, kind, source_did, payload, ts, sequence
       FROM events_log WHERE topic_id = $1 AND sequence > $2
       ORDER BY sequence ASC LIMIT $3`,
      [req.params.id, sinceSeq, limit]
    ).catch(() => ({ rows: [] }));

    return res.json({
      topic_id: req.params.id, events: r.rows, count: r.rows.length,
      last_event_id: r.rows[r.rows.length - 1]?.event_id || sinceEventId || null
    });
  });

  // POST /v1/events/subscriptions/:id/ack
  const AckSchema = z.object({
    event_ids: z.array(z.string()).min(1).max(1000)
  });

  app.post('/v1/events/subscriptions/:id/ack', express.json(), async (req, res) => {
    try {
      const parse = AckSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;

      const subR = await pool.query(
        `SELECT subscription_id, subscriber_did FROM event_subscriptions WHERE subscription_id = $1`,
        [req.params.id]
      ).catch(() => ({ rows: [] }));
      if (!subR.rows[0]) return res.status(404).json({ error: 'subscription_not_found' });

      const auth = await verifyAgentAuth(req, subR.rows[0].subscriber_did, { strictSignatureRequired: true });
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      let acked = 0;
      for (const eid of d.event_ids) {
        const r = await pool.query(
          `INSERT INTO event_acks (subscription_id, event_id) VALUES ($1, $2)
           ON CONFLICT DO NOTHING RETURNING event_id`,
          [req.params.id, eid]
        ).catch(() => ({ rows: [] }));
        if (r.rows[0]) acked++;
      }
      // Update last_event_id to highest sequence
      const seqR = await pool.query(
        `SELECT event_id FROM events_log
         WHERE event_id = ANY($1::text[])
         ORDER BY sequence DESC LIMIT 1`,
        [d.event_ids]
      ).catch(() => ({ rows: [] }));
      if (seqR.rows[0]) {
        await pool.query(
          `UPDATE event_subscriptions SET last_event_id = $1
           WHERE subscription_id = $2 AND (last_event_id IS NULL
              OR (SELECT sequence FROM events_log WHERE event_id = $1)
                 > (SELECT sequence FROM events_log WHERE event_id = last_event_id))`,
          [seqR.rows[0].event_id, req.params.id]
        ).catch(() => {});
      }

      return res.json({ subscription_id: req.params.id, acked });
    } catch (e) {
      console.error('[events.ack]', e);
      return res.status(500).json({ error: 'ack_failed', message: e.message });
    }
  });

  // GET /v1/agents/:did/events/topics
  app.get('/v1/agents/:did/events/topics', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(
      `SELECT topic_id, name, description, retention_hours, max_size, created_at
       FROM event_topics WHERE owner_did = $1 ORDER BY created_at DESC`,
      [did]
    ).catch(() => ({ rows: [] }));
    return res.json({ topics: r.rows, count: r.rows.length });
  });

  // GET /v1/agents/:did/events/subscriptions
  app.get('/v1/agents/:did/events/subscriptions', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(
      `SELECT subscription_id, topic_id, delivery_kind, target_url, filter,
              last_event_id, active, created_at
       FROM event_subscriptions WHERE subscriber_did = $1 ORDER BY created_at DESC`,
      [did]
    ).catch(() => ({ rows: [] }));
    return res.json({ subscriptions: r.rows, count: r.rows.length });
  });

  // Cron: events-deliver
  registerCron(app, '/v1/_jobs/events-deliver', async (req, res) => {
    try {
      const r = await deliverEvents(pool, auditChain);
      return res.json(r);
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  });

  // Cron: events-retain
  registerCron(app, '/v1/_jobs/events-retain', async (req, res) => {
    try {
      const r = await retainEvents(pool);
      return res.json(r);
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  });
}

module.exports = {
  migrate,
  registerEventsRoutes,
  deliverEvents,
  retainEvents,
  matchesFilter,
  DELIVERY_KINDS
};
