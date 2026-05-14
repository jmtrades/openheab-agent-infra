// ============================================================================
// OpenHeab Monitoring — Prometheus-style metrics + uptime + alerts
// Tables: metrics_streams, metric_points, uptime_checks, uptime_incidents, alerts
// Cron: /v1/_jobs/monitoring-sweep — run uptime checks, evaluate alerts
// ============================================================================
const cryptoLib = require('crypto');
const express = require('express');
const { z } = require('zod');
const { registerCron } = require('../cron_auth');

const METRIC_KINDS = ['counter', 'gauge', 'histogram', 'summary'];
const CHECK_KINDS = ['http', 'tcp', 'ping', 'dns', 'cert'];
const CHECK_STATUSES = ['up', 'down', 'degraded'];
const INCIDENT_STATUSES = ['open', 'resolved'];
const ALERT_SOURCES = ['metric', 'uptime', 'log'];
const ALERT_SEVERITIES = ['low', 'medium', 'high', 'critical'];

// ----------------------------------------------------------------------------
// Migration
// ----------------------------------------------------------------------------
async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS metrics_streams (
      stream_id   TEXT PRIMARY KEY,
      owner_did   TEXT NOT NULL,
      name        TEXT NOT NULL,
      kind        TEXT NOT NULL DEFAULT 'gauge',
      labels      TEXT[],
      unit        TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_mstreams_owner ON metrics_streams (owner_did, name);

    CREATE TABLE IF NOT EXISTS metric_points (
      stream_id   TEXT NOT NULL REFERENCES metrics_streams(stream_id) ON DELETE CASCADE,
      timestamp   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      value       DOUBLE PRECISION NOT NULL,
      labels      JSONB
    );
    CREATE INDEX IF NOT EXISTS idx_mpoints_stream_ts
      ON metric_points (stream_id, timestamp DESC);

    CREATE TABLE IF NOT EXISTS uptime_checks (
      check_id            TEXT PRIMARY KEY,
      owner_did           TEXT NOT NULL,
      name                TEXT NOT NULL,
      kind                TEXT NOT NULL DEFAULT 'http',
      target_url          TEXT NOT NULL,
      expected_status     INTEGER,
      expected_body_regex TEXT,
      interval_seconds    INTEGER NOT NULL DEFAULT 60,
      timeout_ms          INTEGER NOT NULL DEFAULT 5000,
      regions             TEXT[],
      active              BOOLEAN NOT NULL DEFAULT TRUE,
      last_check_at       TIMESTAMPTZ,
      last_status         TEXT,
      uptime_pct          REAL,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_checks_owner ON uptime_checks (owner_did);
    CREATE INDEX IF NOT EXISTS idx_checks_due ON uptime_checks (active, last_check_at);

    CREATE TABLE IF NOT EXISTS uptime_incidents (
      incident_id      TEXT PRIMARY KEY,
      check_id         TEXT NOT NULL REFERENCES uptime_checks(check_id) ON DELETE CASCADE,
      started_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      resolved_at      TIMESTAMPTZ,
      duration_seconds INTEGER,
      status           TEXT NOT NULL DEFAULT 'open'
    );
    CREATE INDEX IF NOT EXISTS idx_incidents_check ON uptime_incidents (check_id, started_at DESC);

    CREATE TABLE IF NOT EXISTS alerts (
      alert_id          TEXT PRIMARY KEY,
      owner_did         TEXT NOT NULL,
      name              TEXT NOT NULL,
      source_kind       TEXT NOT NULL,
      condition         JSONB,
      severity          TEXT NOT NULL DEFAULT 'medium',
      webhook_url       TEXT,
      email             TEXT,
      sms_to            TEXT,
      active            BOOLEAN NOT NULL DEFAULT TRUE,
      last_triggered_at TIMESTAMPTZ,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_alerts_owner ON alerts (owner_did);
  `);
}

function genStreamId()   { return 'mstr_' + cryptoLib.randomBytes(12).toString('hex'); }
function genCheckId()    { return 'chk_' + cryptoLib.randomBytes(12).toString('hex'); }
function genIncidentId() { return 'inc_' + cryptoLib.randomBytes(12).toString('hex'); }
function genAlertId()    { return 'alt_' + cryptoLib.randomBytes(12).toString('hex'); }

async function ensureStream(pool, ownerDid, name, kind, labels, unit) {
  const ex = await pool.query(
    `SELECT stream_id FROM metrics_streams WHERE owner_did = $1 AND name = $2 LIMIT 1`,
    [ownerDid, name]
  ).catch(() => ({ rows: [] }));
  if (ex.rows[0]) return ex.rows[0].stream_id;

  const streamId = genStreamId();
  await pool.query(
    `INSERT INTO metrics_streams (stream_id, owner_did, name, kind, labels, unit)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [streamId, ownerDid, name, kind || 'gauge', labels || [], unit || null]
  );
  return streamId;
}

// ----------------------------------------------------------------------------
// Uptime check runner
// ----------------------------------------------------------------------------
async function runHttpCheck(check) {
  const started = Date.now();
  let status = 'down';
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), Math.min(check.timeout_ms || 5000, 30000));
    const resp = await fetch(check.target_url, { method: 'GET', signal: controller.signal })
      .finally(() => clearTimeout(t));
    if (check.expected_status && resp.status !== check.expected_status) status = 'degraded';
    else if (resp.status >= 200 && resp.status < 400) status = 'up';
    else status = 'down';
    if (check.expected_body_regex) {
      const body = await resp.text().catch(() => '');
      try { if (!new RegExp(check.expected_body_regex).test(body)) status = 'degraded'; } catch {}
    }
  } catch { status = 'down'; }
  return { status, duration_ms: Date.now() - started };
}

async function sweepUptime(pool, auditChain) {
  const due = await pool.query(`
    SELECT * FROM uptime_checks
     WHERE active = TRUE
       AND (last_check_at IS NULL
         OR last_check_at < NOW() - (interval_seconds || ' seconds')::interval)
     ORDER BY last_check_at NULLS FIRST LIMIT 100
  `).catch(() => ({ rows: [] }));

  let upCount = 0, downCount = 0, incidentsOpened = 0, incidentsResolved = 0;
  for (const check of due.rows) {
    const { status } = check.kind === 'http' || !check.kind
      ? await runHttpCheck(check)
      : { status: 'up' };

    await pool.query(
      `UPDATE uptime_checks
       SET last_check_at = NOW(), last_status = $1 WHERE check_id = $2`,
      [status, check.check_id]
    ).catch(() => {});

    if (status === 'down' || status === 'degraded') {
      downCount++;
      // Open incident if none open
      const open = await pool.query(
        `SELECT incident_id FROM uptime_incidents
         WHERE check_id = $1 AND status = 'open' LIMIT 1`,
        [check.check_id]
      ).catch(() => ({ rows: [] }));
      if (!open.rows[0]) {
        await pool.query(
          `INSERT INTO uptime_incidents (incident_id, check_id) VALUES ($1, $2)`,
          [genIncidentId(), check.check_id]
        ).catch(() => {});
        incidentsOpened++;
        if (auditChain) {
          await auditChain.append({
            event_type: 'monitoring.incident_opened',
            check_id: check.check_id, owner_did: check.owner_did, status,
            timestamp: new Date().toISOString()
          });
        }
      }
    } else {
      upCount++;
      // Resolve open incidents
      const resolved = await pool.query(
        `UPDATE uptime_incidents
         SET status = 'resolved', resolved_at = NOW(),
             duration_seconds = EXTRACT(EPOCH FROM (NOW() - started_at))::int
         WHERE check_id = $1 AND status = 'open' RETURNING incident_id`,
        [check.check_id]
      ).catch(() => ({ rows: [] }));
      if (resolved.rows.length > 0 && auditChain) {
        incidentsResolved += resolved.rows.length;
        await auditChain.append({
          event_type: 'monitoring.incident_resolved',
          check_id: check.check_id, owner_did: check.owner_did,
          timestamp: new Date().toISOString()
        });
      }
    }
  }
  return { checked: due.rows.length, upCount, downCount, incidentsOpened, incidentsResolved };
}

// ----------------------------------------------------------------------------
// Routes
// ----------------------------------------------------------------------------
function registerMonitoringRoutes(app, pool, verifyAgentAuth, auditChain) {
  // POST /v1/agents/:did/monitoring/metrics/:stream/points
  const PointsSchema = z.object({
    kind: z.enum(METRIC_KINDS).optional().default('gauge'),
    unit: z.string().max(64).optional(),
    labels: z.array(z.string()).optional(),
    points: z.array(z.object({
      value: z.number(),
      timestamp: z.string().optional(),
      labels: z.record(z.any()).optional()
    })).min(1).max(10000)
  });

  app.post('/v1/agents/:did/monitoring/metrics/:stream/points',
    express.json({ limit: '4mb' }), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const parse = PointsSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;

      const streamId = await ensureStream(pool, did, req.params.stream, d.kind, d.labels, d.unit);

      let inserted = 0;
      for (const p of d.points) {
        await pool.query(
          `INSERT INTO metric_points (stream_id, timestamp, value, labels)
           VALUES ($1, COALESCE($2::timestamptz, NOW()), $3, $4::jsonb)`,
          [streamId, p.timestamp || null, p.value,
           p.labels ? JSON.stringify(p.labels) : null]
        ).catch(() => {});
        inserted++;
      }

      return res.status(201).json({
        stream_id: streamId, stream_name: req.params.stream,
        ingested: inserted
      });
    } catch (e) {
      console.error('[monitoring.points]', e);
      return res.status(500).json({ error: 'ingest_failed', message: e.message });
    }
  });

  // GET /v1/agents/:did/monitoring/metrics/:stream/query
  app.get('/v1/agents/:did/monitoring/metrics/:stream/query', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });

    const sR = await pool.query(
      `SELECT stream_id, kind, unit, labels FROM metrics_streams
       WHERE owner_did = $1 AND name = $2 LIMIT 1`,
      [did, req.params.stream]
    ).catch(() => ({ rows: [] }));
    if (!sR.rows[0]) return res.status(404).json({ error: 'stream_not_found' });

    const from = req.query.from ? new Date(req.query.from) : new Date(Date.now() - 60 * 60 * 1000);
    const to = req.query.to ? new Date(req.query.to) : new Date();
    const limit = Math.min(parseInt(req.query.limit) || 1000, 10000);

    const r = await pool.query(
      `SELECT timestamp, value, labels FROM metric_points
       WHERE stream_id = $1 AND timestamp >= $2 AND timestamp <= $3
       ORDER BY timestamp DESC LIMIT $4`,
      [sR.rows[0].stream_id, from.toISOString(), to.toISOString(), limit]
    ).catch(() => ({ rows: [] }));

    return res.json({
      stream_id: sR.rows[0].stream_id, stream_name: req.params.stream,
      kind: sR.rows[0].kind, unit: sR.rows[0].unit,
      from: from.toISOString(), to: to.toISOString(),
      points: r.rows, count: r.rows.length
    });
  });

  // POST /v1/agents/:did/monitoring/uptime-checks
  const CheckSchema = z.object({
    name: z.string().min(1).max(256),
    kind: z.enum(CHECK_KINDS).optional().default('http'),
    target_url: z.string().min(1).max(2048),
    expected_status: z.number().int().min(100).max(599).optional(),
    expected_body_regex: z.string().max(2048).optional(),
    interval_seconds: z.number().int().min(10).max(86400).optional().default(60),
    timeout_ms: z.number().int().min(100).max(60000).optional().default(5000),
    regions: z.array(z.string().max(64)).optional()
  });

  app.post('/v1/agents/:did/monitoring/uptime-checks', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const parse = CheckSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;

      const checkId = genCheckId();
      await pool.query(
        `INSERT INTO uptime_checks
         (check_id, owner_did, name, kind, target_url, expected_status,
          expected_body_regex, interval_seconds, timeout_ms, regions)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [checkId, did, d.name, d.kind, d.target_url,
         d.expected_status || null, d.expected_body_regex || null,
         d.interval_seconds, d.timeout_ms, d.regions || []]
      );

      await auditChain.append({
        event_type: 'monitoring.check_created',
        check_id: checkId, owner_did: did,
        kind: d.kind, target_url: d.target_url,
        timestamp: new Date().toISOString()
      });

      return res.status(201).json({
        check_id: checkId, owner_did: did, name: d.name, kind: d.kind,
        target_url: d.target_url, interval_seconds: d.interval_seconds,
        timeout_ms: d.timeout_ms, active: true,
        created_at: new Date().toISOString()
      });
    } catch (e) {
      console.error('[monitoring.check.create]', e);
      return res.status(500).json({ error: 'check_create_failed', message: e.message });
    }
  });

  // GET /v1/agents/:did/monitoring/uptime-checks
  app.get('/v1/agents/:did/monitoring/uptime-checks', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });

    const r = await pool.query(
      `SELECT check_id, name, kind, target_url, expected_status, interval_seconds,
              timeout_ms, regions, active, last_check_at, last_status, uptime_pct, created_at
       FROM uptime_checks WHERE owner_did = $1 ORDER BY created_at DESC`,
      [did]
    ).catch(() => ({ rows: [] }));
    return res.json({ checks: r.rows, count: r.rows.length });
  });

  // POST /v1/agents/:did/monitoring/alerts
  const AlertSchema = z.object({
    name: z.string().min(1).max(256),
    source_kind: z.enum(ALERT_SOURCES),
    condition: z.record(z.any()),
    severity: z.enum(ALERT_SEVERITIES).optional().default('medium'),
    webhook_url: z.string().max(2048).optional(),
    email: z.string().max(256).optional(),
    sms_to: z.string().max(64).optional(),
    active: z.boolean().optional().default(true)
  });

  app.post('/v1/agents/:did/monitoring/alerts', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const parse = AlertSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;

      const alertId = genAlertId();
      await pool.query(
        `INSERT INTO alerts
         (alert_id, owner_did, name, source_kind, condition, severity,
          webhook_url, email, sms_to, active)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10)`,
        [alertId, did, d.name, d.source_kind,
         JSON.stringify(d.condition), d.severity,
         d.webhook_url || null, d.email || null, d.sms_to || null, d.active]
      );

      await auditChain.append({
        event_type: 'monitoring.alert_created',
        alert_id: alertId, owner_did: did,
        severity: d.severity, source_kind: d.source_kind,
        timestamp: new Date().toISOString()
      });

      return res.status(201).json({
        alert_id: alertId, owner_did: did, name: d.name,
        source_kind: d.source_kind, condition: d.condition,
        severity: d.severity, active: d.active,
        created_at: new Date().toISOString()
      });
    } catch (e) {
      console.error('[monitoring.alert.create]', e);
      return res.status(500).json({ error: 'alert_create_failed', message: e.message });
    }
  });

  // GET /v1/agents/:did/monitoring/incidents
  app.get('/v1/agents/:did/monitoring/incidents', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    const r = await pool.query(
      `SELECT i.* FROM uptime_incidents i
       JOIN uptime_checks c ON c.check_id = i.check_id
       WHERE c.owner_did = $1
       ORDER BY i.started_at DESC LIMIT $2`,
      [did, limit]
    ).catch(() => ({ rows: [] }));
    return res.json({ incidents: r.rows, count: r.rows.length });
  });

  // GET /metrics/agent/:did — Prometheus text format
  app.get('/metrics/agent/:did', async (req, res) => {
    const did = req.params.did;
    const streams = await pool.query(
      `SELECT stream_id, name, kind, unit FROM metrics_streams WHERE owner_did = $1`,
      [did]
    ).catch(() => ({ rows: [] }));
    let out = '';
    for (const s of streams.rows) {
      const lastR = await pool.query(
        `SELECT value, timestamp, labels FROM metric_points
         WHERE stream_id = $1 ORDER BY timestamp DESC LIMIT 1`,
        [s.stream_id]
      ).catch(() => ({ rows: [] }));
      if (!lastR.rows[0]) continue;
      const safeName = s.name.replace(/[^a-zA-Z0-9_]/g, '_');
      out += `# TYPE ${safeName} ${s.kind || 'gauge'}\n`;
      if (s.unit) out += `# UNIT ${safeName} ${s.unit}\n`;
      const labels = lastR.rows[0].labels || {};
      const labelStr = Object.entries(labels)
        .map(([k, v]) => `${k}="${String(v).replace(/"/g, '\\"')}"`).join(',');
      const tsMs = new Date(lastR.rows[0].timestamp).getTime();
      out += `${safeName}${labelStr ? `{${labelStr}}` : ''} ${lastR.rows[0].value} ${tsMs}\n`;
    }
    res.setHeader('content-type', 'text/plain; version=0.0.4');
    return res.send(out);
  });

  // Cron: monitoring-sweep
  registerCron(app, '/v1/_jobs/monitoring-sweep', async (req, res) => {
    try {
      const r = await sweepUptime(pool, auditChain);
      return res.json(r);
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  });
}

module.exports = {
  migrate,
  registerMonitoringRoutes,
  sweepUptime,
  ensureStream,
  METRIC_KINDS,
  CHECK_KINDS,
  ALERT_SEVERITIES
};
