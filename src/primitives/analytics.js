// ============================================================================
// OpenHeab Analytics — Event ingestion and rollups
// ============================================================================
const express = require('express');
const { z } = require('zod');

const PRIMITIVES = [
  'identity', 'inbox', 'bank', 'crypto', 'phone', 'memory', 'reputation',
  'marketplace', 'publishing', 'governance', 'eval', 'continuity', 'other'
];

const PrimitiveEnum = z.enum(PRIMITIVES);

// ----------------------------------------------------------------------------
// Migration
// ----------------------------------------------------------------------------
async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS analytics_events (
      event_id      TEXT PRIMARY KEY,
      agent_did     TEXT,
      event_type    TEXT NOT NULL,
      primitive     TEXT NOT NULL,
      cost_cents    INTEGER NOT NULL DEFAULT 0,
      bytes_in      BIGINT  NOT NULL DEFAULT 0,
      bytes_out     BIGINT  NOT NULL DEFAULT 0,
      latency_ms    INTEGER,
      status_code   INTEGER,
      metadata      JSONB,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_analytics_events_agent     ON analytics_events (agent_did, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_analytics_events_primitive ON analytics_events (primitive, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_analytics_events_created   ON analytics_events (created_at DESC);

    CREATE TABLE IF NOT EXISTS analytics_rollups_hourly (
      agent_did         TEXT NOT NULL,
      primitive         TEXT NOT NULL,
      hour_bucket       TIMESTAMPTZ NOT NULL,
      event_count       BIGINT NOT NULL DEFAULT 0,
      total_cost_cents  BIGINT NOT NULL DEFAULT 0,
      total_bytes_in    BIGINT NOT NULL DEFAULT 0,
      total_bytes_out   BIGINT NOT NULL DEFAULT 0,
      avg_latency_ms    REAL,
      error_count       BIGINT NOT NULL DEFAULT 0,
      PRIMARY KEY (agent_did, primitive, hour_bucket)
    );
    CREATE INDEX IF NOT EXISTS idx_analytics_hourly_bucket ON analytics_rollups_hourly (hour_bucket DESC);

    CREATE TABLE IF NOT EXISTS analytics_rollups_daily (
      agent_did         TEXT NOT NULL,
      primitive         TEXT NOT NULL,
      day_bucket        DATE NOT NULL,
      event_count       BIGINT NOT NULL DEFAULT 0,
      total_cost_cents  BIGINT NOT NULL DEFAULT 0,
      total_bytes_in    BIGINT NOT NULL DEFAULT 0,
      total_bytes_out   BIGINT NOT NULL DEFAULT 0,
      avg_latency_ms    REAL,
      error_count       BIGINT NOT NULL DEFAULT 0,
      PRIMARY KEY (agent_did, primitive, day_bucket)
    );
    CREATE INDEX IF NOT EXISTS idx_analytics_daily_bucket ON analytics_rollups_daily (day_bucket DESC);
  `);
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------
function genEventId() {
  return 'evt_' + require('crypto').randomBytes(12).toString('hex');
}

function normalizePrimitive(p) {
  return PRIMITIVES.includes(p) ? p : 'other';
}

function windowToInterval(w) {
  switch (w) {
    case '24h': return { sql: `NOW() - INTERVAL '24 hours'`, ms: 24 * 60 * 60 * 1000 };
    case '7d':  return { sql: `NOW() - INTERVAL '7 days'`,   ms: 7 * 24 * 60 * 60 * 1000 };
    case '30d': return { sql: `NOW() - INTERVAL '30 days'`,  ms: 30 * 24 * 60 * 60 * 1000 };
    default:    return { sql: `NOW() - INTERVAL '24 hours'`, ms: 24 * 60 * 60 * 1000 };
  }
}

async function updateRollups(pool, ev) {
  try {
    const hour = new Date(ev.created_at);
    hour.setMinutes(0, 0, 0);
    const day = new Date(hour);
    day.setHours(0, 0, 0, 0);
    const isError = ev.status_code && ev.status_code >= 400 ? 1 : 0;
    const lat = ev.latency_ms ?? null;

    await pool.query(`
      INSERT INTO analytics_rollups_hourly
        (agent_did, primitive, hour_bucket, event_count, total_cost_cents,
         total_bytes_in, total_bytes_out, avg_latency_ms, error_count)
      VALUES ($1, $2, $3, 1, $4, $5, $6, $7, $8)
      ON CONFLICT (agent_did, primitive, hour_bucket) DO UPDATE SET
        event_count      = analytics_rollups_hourly.event_count + 1,
        total_cost_cents = analytics_rollups_hourly.total_cost_cents + EXCLUDED.total_cost_cents,
        total_bytes_in   = analytics_rollups_hourly.total_bytes_in + EXCLUDED.total_bytes_in,
        total_bytes_out  = analytics_rollups_hourly.total_bytes_out + EXCLUDED.total_bytes_out,
        avg_latency_ms   = CASE
          WHEN EXCLUDED.avg_latency_ms IS NULL THEN analytics_rollups_hourly.avg_latency_ms
          WHEN analytics_rollups_hourly.avg_latency_ms IS NULL THEN EXCLUDED.avg_latency_ms
          ELSE ((analytics_rollups_hourly.avg_latency_ms * analytics_rollups_hourly.event_count) + EXCLUDED.avg_latency_ms)
               / (analytics_rollups_hourly.event_count + 1)
        END,
        error_count      = analytics_rollups_hourly.error_count + EXCLUDED.error_count
    `, [ev.agent_did || 'anon', ev.primitive, hour.toISOString(), ev.cost_cents || 0,
        ev.bytes_in || 0, ev.bytes_out || 0, lat, isError]);

    await pool.query(`
      INSERT INTO analytics_rollups_daily
        (agent_did, primitive, day_bucket, event_count, total_cost_cents,
         total_bytes_in, total_bytes_out, avg_latency_ms, error_count)
      VALUES ($1, $2, $3, 1, $4, $5, $6, $7, $8)
      ON CONFLICT (agent_did, primitive, day_bucket) DO UPDATE SET
        event_count      = analytics_rollups_daily.event_count + 1,
        total_cost_cents = analytics_rollups_daily.total_cost_cents + EXCLUDED.total_cost_cents,
        total_bytes_in   = analytics_rollups_daily.total_bytes_in + EXCLUDED.total_bytes_in,
        total_bytes_out  = analytics_rollups_daily.total_bytes_out + EXCLUDED.total_bytes_out,
        avg_latency_ms   = CASE
          WHEN EXCLUDED.avg_latency_ms IS NULL THEN analytics_rollups_daily.avg_latency_ms
          WHEN analytics_rollups_daily.avg_latency_ms IS NULL THEN EXCLUDED.avg_latency_ms
          ELSE ((analytics_rollups_daily.avg_latency_ms * analytics_rollups_daily.event_count) + EXCLUDED.avg_latency_ms)
               / (analytics_rollups_daily.event_count + 1)
        END,
        error_count      = analytics_rollups_daily.error_count + EXCLUDED.error_count
    `, [ev.agent_did || 'anon', ev.primitive, day.toISOString().slice(0, 10),
        ev.cost_cents || 0, ev.bytes_in || 0, ev.bytes_out || 0, lat, isError]);
  } catch (e) {
    console.warn('[analytics.rollup]', e.message);
  }
}

// ----------------------------------------------------------------------------
// Routes
// ----------------------------------------------------------------------------
const EventSchema = z.object({
  agent_did:   z.string().optional(),
  event_type:  z.string().min(1).max(128),
  primitive:   z.string().max(64).optional(),
  cost_cents:  z.number().int().min(0).optional(),
  bytes_in:    z.number().int().min(0).optional(),
  bytes_out:   z.number().int().min(0).optional(),
  latency_ms:  z.number().int().min(0).optional(),
  status_code: z.number().int().optional(),
  metadata:    z.record(z.any()).optional()
});

function registerAnalyticsRoutes(app, pool, verifyAgentAuth) {
  // POST /v1/analytics/event
  app.post('/v1/analytics/event', express.json(), async (req, res) => {
    try {
      const parse = EventSchema.safeParse(req.body || {});
      if (!parse.success) {
        return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      }
      const d = parse.data;
      if (d.agent_did) {
        const auth = await verifyAgentAuth(req, d.agent_did);
        if (!auth.valid) return res.status(401).json({ error: auth.error });
      }
      const eventId = genEventId();
      const now = new Date();
      const primitive = normalizePrimitive(d.primitive);
      await pool.query(
        `INSERT INTO analytics_events
         (event_id, agent_did, event_type, primitive, cost_cents,
          bytes_in, bytes_out, latency_ms, status_code, metadata, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11)`,
        [eventId, d.agent_did || null, d.event_type, primitive,
         d.cost_cents || 0, d.bytes_in || 0, d.bytes_out || 0,
         d.latency_ms ?? null, d.status_code ?? null,
         d.metadata ? JSON.stringify(d.metadata) : null, now.toISOString()]
      );
      await updateRollups(pool, {
        agent_did: d.agent_did, primitive,
        cost_cents: d.cost_cents || 0,
        bytes_in: d.bytes_in || 0, bytes_out: d.bytes_out || 0,
        latency_ms: d.latency_ms, status_code: d.status_code,
        created_at: now
      });
      return res.status(201).json({ event_id: eventId, recorded_at: now.toISOString() });
    } catch (e) {
      console.error('[analytics.event]', e);
      return res.status(500).json({ error: 'event_record_failed', message: e.message });
    }
  });

  // GET /v1/agents/:did/analytics/summary
  app.get('/v1/agents/:did/analytics/summary', async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const win = req.query.window || '24h';
      const iv = windowToInterval(win);
      const r = await pool.query(`
        SELECT primitive,
               COUNT(*)::bigint                       AS event_count,
               COALESCE(SUM(cost_cents), 0)::bigint   AS total_cost_cents,
               COALESCE(SUM(bytes_in), 0)::bigint     AS total_bytes_in,
               COALESCE(SUM(bytes_out), 0)::bigint    AS total_bytes_out,
               AVG(latency_ms)::real                  AS avg_latency_ms,
               SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END)::bigint AS error_count
        FROM analytics_events
        WHERE agent_did = $1 AND created_at >= ${iv.sql}
        GROUP BY primitive
        ORDER BY event_count DESC
      `, [did]).catch(() => ({ rows: [] }));

      const totals = r.rows.reduce((acc, row) => ({
        event_count:      acc.event_count      + Number(row.event_count),
        total_cost_cents: acc.total_cost_cents + Number(row.total_cost_cents),
        total_bytes_in:   acc.total_bytes_in   + Number(row.total_bytes_in),
        total_bytes_out:  acc.total_bytes_out  + Number(row.total_bytes_out),
        error_count:      acc.error_count      + Number(row.error_count)
      }), { event_count: 0, total_cost_cents: 0, total_bytes_in: 0, total_bytes_out: 0, error_count: 0 });

      return res.json({
        agent_did: did,
        window: win,
        totals,
        by_primitive: r.rows
      });
    } catch (e) {
      console.error('[analytics.summary]', e);
      return res.status(500).json({ error: 'summary_failed', message: e.message });
    }
  });

  // GET /v1/agents/:did/analytics/timeseries
  app.get('/v1/agents/:did/analytics/timeseries', async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const win = req.query.window || '24h';
      const granularity = req.query.granularity === 'daily' ? 'daily' : 'hourly';
      const table = granularity === 'daily' ? 'analytics_rollups_daily' : 'analytics_rollups_hourly';
      const bucketCol = granularity === 'daily' ? 'day_bucket' : 'hour_bucket';
      const iv = windowToInterval(win);

      const r = await pool.query(`
        SELECT ${bucketCol} AS bucket, primitive,
               event_count, total_cost_cents, total_bytes_in,
               total_bytes_out, avg_latency_ms, error_count
        FROM ${table}
        WHERE agent_did = $1 AND ${bucketCol} >= ${iv.sql}
        ORDER BY ${bucketCol} ASC
      `, [did]).catch(() => ({ rows: [] }));
      return res.json({
        agent_did: did, window: win, granularity, points: r.rows
      });
    } catch (e) {
      console.error('[analytics.timeseries]', e);
      return res.status(500).json({ error: 'timeseries_failed', message: e.message });
    }
  });

  // GET /v1/analytics/global  (public)
  app.get('/v1/analytics/global', async (req, res) => {
    try {
      const activeR = await pool.query(`
        SELECT COUNT(DISTINCT agent_did)::bigint AS active_agents
        FROM analytics_events
        WHERE agent_did IS NOT NULL AND created_at >= NOW() - INTERVAL '24 hours'
      `).catch(() => ({ rows: [{ active_agents: 0 }] }));

      const byPrimR = await pool.query(`
        SELECT primitive,
               COUNT(*)::bigint                       AS event_count,
               COALESCE(SUM(cost_cents), 0)::bigint   AS total_cost_cents,
               COUNT(DISTINCT agent_did)::bigint      AS unique_agents
        FROM analytics_events
        WHERE created_at >= NOW() - INTERVAL '24 hours'
        GROUP BY primitive
        ORDER BY event_count DESC
      `).catch(() => ({ rows: [] }));

      const trailingR = await pool.query(`
        SELECT day_bucket,
               SUM(event_count)::bigint               AS event_count,
               SUM(total_cost_cents)::bigint          AS total_cost_cents,
               COUNT(DISTINCT agent_did)::bigint      AS active_agents
        FROM analytics_rollups_daily
        WHERE day_bucket >= (CURRENT_DATE - INTERVAL '7 days')
        GROUP BY day_bucket
        ORDER BY day_bucket ASC
      `).catch(() => ({ rows: [] }));

      return res.json({
        active_agents_24h: Number(activeR.rows[0]?.active_agents || 0),
        by_primitive_24h: byPrimR.rows,
        trailing_7d: trailingR.rows,
        generated_at: new Date().toISOString()
      });
    } catch (e) {
      console.error('[analytics.global]', e);
      return res.status(500).json({ error: 'global_failed', message: e.message });
    }
  });
}

module.exports = {
  migrate,
  registerAnalyticsRoutes,
  PRIMITIVES,
  normalizePrimitive,
  updateRollups
};
