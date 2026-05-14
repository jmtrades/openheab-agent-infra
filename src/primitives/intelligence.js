// ============================================================================
// OpenHeab Intelligence — Benchmarks, behavior, EMA forecast, anomalies,
// capability discovery, network metrics.
// All endpoints are GET; all soft-fail on tables that don't exist.
// Table: intelligence_snapshots (cache + audit trail of computed views)
// ============================================================================
const cryptoLib = require('crypto');
const express = require('express');

// ----------------------------------------------------------------------------
// Migration
// ----------------------------------------------------------------------------
async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS intelligence_snapshots (
      snapshot_id   TEXT PRIMARY KEY,
      kind          TEXT NOT NULL,
      subject       TEXT,
      payload       JSONB NOT NULL,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_intel_snapshots_kind ON intelligence_snapshots (kind, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_intel_snapshots_subject ON intelligence_snapshots (subject, kind, created_at DESC);
  `);
}

function genSnapshotId() {
  return 'snap_' + cryptoLib.randomBytes(12).toString('hex');
}

async function saveSnapshot(pool, kind, subject, payload) {
  try {
    await pool.query(
      `INSERT INTO intelligence_snapshots (snapshot_id, kind, subject, payload)
       VALUES ($1,$2,$3,$4::jsonb)`,
      [genSnapshotId(), kind, subject || null, JSON.stringify(payload)]
    );
  } catch {}
}

async function safeQuery(pool, sql, params = []) {
  try { return await pool.query(sql, params); }
  catch { return { rows: [] }; }
}

// ----------------------------------------------------------------------------
// Routes
// ----------------------------------------------------------------------------
function registerIntelligenceRoutes(app, pool, verifyAgentAuth, auditChain) {

  // GET /v1/intelligence/benchmarks — aggregate eval_runs by model
  app.get('/v1/intelligence/benchmarks', async (req, res) => {
    let rows = [];
    const r = await safeQuery(pool, `
      SELECT model,
             COUNT(*)::int AS run_count,
             AVG(score)::float AS avg_score,
             AVG(latency_ms)::float AS avg_latency_ms,
             MAX(created_at) AS last_run_at
      FROM eval_runs
      GROUP BY model
      ORDER BY avg_score DESC NULLS LAST
      LIMIT 100
    `);
    rows = r.rows;
    let source = 'eval_runs';
    if (!rows.length) {
      const fb = await safeQuery(pool, `
        SELECT model,
               COUNT(*)::int AS run_count,
               NULL::float AS avg_score,
               AVG(latency_ms)::float AS avg_latency_ms,
               MAX(created_at) AS last_run_at
        FROM inference_logs
        GROUP BY model
        ORDER BY run_count DESC
        LIMIT 100
      `);
      rows = fb.rows;
      source = 'inference_logs';
    }
    const payload = { source, models: rows, count: rows.length };
    await saveSnapshot(pool, 'benchmark', null, payload);
    return res.json(payload);
  });

  // GET /v1/intelligence/agents/:did/behavior
  app.get('/v1/intelligence/agents/:did/behavior', async (req, res) => {
    const did = req.params.did;

    const actionsR = await safeQuery(pool, `
      SELECT COALESCE(entry->>'event_type', 'unknown') AS event_type, COUNT(*)::int AS n
      FROM audit_chain
      WHERE created_at >= NOW() - INTERVAL '30 days'
        AND (entry::text ILIKE $1)
      GROUP BY event_type ORDER BY n DESC LIMIT 50
    `, [`%${did}%`]);

    const cpR = await safeQuery(pool, `
      SELECT counterparty_did, COUNT(*)::int AS n, SUM(amount_cents)::bigint AS total_cents
      FROM (
        SELECT to_did AS counterparty_did, amount_cents FROM transfers WHERE from_did = $1
        UNION ALL
        SELECT from_did AS counterparty_did, amount_cents FROM transfers WHERE to_did = $1
      ) sub
      WHERE counterparty_did IS NOT NULL
      GROUP BY counterparty_did
      ORDER BY n DESC LIMIT 20
    `, [did]);

    const toolsR = await safeQuery(pool, `
      SELECT slug, version, pinned, installed_at FROM tool_installs
      WHERE agent_did = $1 ORDER BY installed_at DESC LIMIT 100
    `, [did]);

    const payload = {
      agent_did: did,
      actions_30d: actionsR.rows,
      top_counterparties: cpR.rows,
      installed_tools: toolsR.rows,
      computed_at: new Date().toISOString()
    };
    await saveSnapshot(pool, 'behavior', did, payload);
    return res.json(payload);
  });

  // GET /v1/intelligence/agents/:did/forecast — EMA over last 30d cost_events
  app.get('/v1/intelligence/agents/:did/forecast', async (req, res) => {
    const did = req.params.did;
    const r = await safeQuery(pool, `
      SELECT date_trunc('day', created_at)::date AS day,
             SUM(COALESCE(cost_cents, 0))::bigint AS daily_cents
      FROM cost_events
      WHERE agent_did = $1 AND created_at >= NOW() - INTERVAL '30 days'
      GROUP BY day ORDER BY day ASC
    `, [did]);

    const series = r.rows.map(row => ({ day: row.day, cents: parseInt(row.daily_cents || 0) }));
    const alpha = 0.3;
    let ema = series.length ? series[0].cents : 0;
    for (let i = 1; i < series.length; i++) {
      ema = alpha * series[i].cents + (1 - alpha) * ema;
    }
    const daily_avg_cents = series.length
      ? Math.round(series.reduce((a, s) => a + s.cents, 0) / series.length)
      : 0;
    const forecast_daily_cents = Math.round(ema);
    const forecast_7d = forecast_daily_cents * 7;
    const forecast_30d = forecast_daily_cents * 30;

    const payload = {
      agent_did: did,
      window_days: 30,
      sample_count: series.length,
      daily_avg_cents,
      ema_alpha: alpha,
      forecast_daily_cents,
      forecast_7d,
      forecast_30d,
      series,
      computed_at: new Date().toISOString()
    };
    await saveSnapshot(pool, 'forecast', did, payload);
    return res.json(payload);
  });

  // GET /v1/intelligence/agents/:did/anomalies — z-score over 60d
  app.get('/v1/intelligence/agents/:did/anomalies', async (req, res) => {
    const did = req.params.did;
    const r = await safeQuery(pool, `
      SELECT date_trunc('day', created_at)::date AS day,
             SUM(COALESCE(cost_cents, 0))::bigint AS daily_cents,
             COUNT(*)::int AS event_count
      FROM cost_events
      WHERE agent_did = $1 AND created_at >= NOW() - INTERVAL '60 days'
      GROUP BY day ORDER BY day ASC
    `, [did]);

    const series = r.rows.map(row => ({
      day: row.day,
      cents: parseInt(row.daily_cents || 0),
      events: parseInt(row.event_count || 0)
    }));
    const n = series.length;
    let mean = 0, variance = 0, std = 0;
    if (n > 0) {
      mean = series.reduce((a, s) => a + s.cents, 0) / n;
      variance = series.reduce((a, s) => a + (s.cents - mean) ** 2, 0) / n;
      std = Math.sqrt(variance);
    }
    const anomalies = [];
    for (const s of series) {
      const z = std > 0 ? (s.cents - mean) / std : 0;
      if (Math.abs(z) > 3) {
        anomalies.push({ day: s.day, cents: s.cents, z_score: Number(z.toFixed(3)) });
      }
    }

    const payload = {
      agent_did: did,
      window_days: 60, sample_count: n,
      mean_cents: Math.round(mean),
      std_cents: Math.round(std),
      threshold_z: 3,
      anomalies,
      computed_at: new Date().toISOString()
    };
    await saveSnapshot(pool, 'anomaly', did, payload);
    return res.json(payload);
  });

  // GET /v1/intelligence/agents/:did/capabilities
  app.get('/v1/intelligence/agents/:did/capabilities', async (req, res) => {
    const did = req.params.did;
    const modelsR = await safeQuery(pool, `
      SELECT DISTINCT model FROM inference_logs WHERE agent_did = $1 LIMIT 100
    `, [did]);
    const toolsR = await safeQuery(pool, `
      SELECT slug, version FROM tool_installs WHERE agent_did = $1
    `, [did]);
    const extR = await safeQuery(pool, `
      SELECT DISTINCT extension_slug AS slug, COUNT(*)::int AS invocations
      FROM extension_invocations WHERE agent_did = $1
      GROUP BY extension_slug ORDER BY invocations DESC LIMIT 100
    `, [did]);

    const payload = {
      agent_did: did,
      models: modelsR.rows.map(r => r.model),
      tools: toolsR.rows,
      extensions: extR.rows,
      computed_at: new Date().toISOString()
    };
    await saveSnapshot(pool, 'capabilities', did, payload);
    return res.json(payload);
  });

  // GET /v1/intelligence/network — global metrics
  app.get('/v1/intelligence/network', async (req, res) => {
    const totalR = await safeQuery(pool, `SELECT COUNT(*)::int AS n FROM identities`);
    const newR = await safeQuery(pool, `
      SELECT COUNT(*)::int AS n FROM identities WHERE created_at >= NOW() - INTERVAL '7 days'
    `);
    const gmvR = await safeQuery(pool, `
      SELECT COALESCE(SUM(amount_cents), 0)::bigint AS total
      FROM transfers WHERE created_at >= NOW() - INTERVAL '30 days'
    `);
    const extR = await safeQuery(pool, `
      SELECT COUNT(*)::int AS n FROM extension_invocations
      WHERE created_at >= NOW() - INTERVAL '24 hours'
    `);

    const payload = {
      total_agents: parseInt(totalR.rows[0]?.n || 0),
      new_agents_7d: parseInt(newR.rows[0]?.n || 0),
      gmv_30d_cents: parseInt(gmvR.rows[0]?.total || 0),
      extension_invocations_24h: parseInt(extR.rows[0]?.n || 0),
      computed_at: new Date().toISOString()
    };
    await saveSnapshot(pool, 'network', null, payload);
    return res.json(payload);
  });
}

module.exports = {
  migrate,
  registerIntelligenceRoutes
};
