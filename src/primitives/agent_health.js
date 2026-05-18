// ============================================================================
// agent_health.js — SRE-style health monitoring per agent.
//
// Different from agi_operations.mental_health (which tracks cognitive
// indicators like incoherence/oscillation/repetition). This is operational:
// uptime, error rate, latency, resource consumption, anomaly flags. The
// "is my agent alive and well" dashboard every operator wants.
//
// Endpoints:
//   POST /v1/agents/:did/health/sample          report a health sample
//   GET  /v1/agents/:did/health                 latest snapshot + 24h trend
//   GET  /v1/agents/:did/health/anomalies       recent anomalies for this agent
//   GET  /v1/health/global                      substrate-wide summary
//
// UI: /agent/:did/health, /health/global
// ============================================================================
const crypto = require('crypto');
const { z } = require('zod');
const ds = require('../design_system');

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
}
function shell(title, description, content) {
  return `${ds.head(`${title} — OpenHeab`, description)}${ds.NAV_HTML('')}<main>${content}</main>${ds.FOOTER_HTML()}`;
}
async function safe(pool, sql, params = []) {
  try { return (await pool.query(sql, params)).rows; }
  catch { return []; }
}

async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS agent_health_samples (
      sample_id          TEXT PRIMARY KEY,
      agent_did          TEXT NOT NULL,
      sampled_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      uptime_pct_24h     NUMERIC(6,3),
      error_rate_pct_24h NUMERIC(6,3),
      p50_latency_ms     INTEGER,
      p95_latency_ms     INTEGER,
      p99_latency_ms     INTEGER,
      memory_mb_avg      INTEGER,
      cpu_pct_avg        NUMERIC(5,2),
      requests_24h       INTEGER,
      anomaly_score      NUMERIC(4,3),
      note               TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_agent_health_samples ON agent_health_samples (agent_did, sampled_at DESC);

    CREATE TABLE IF NOT EXISTS agent_health_anomalies (
      anomaly_id         TEXT PRIMARY KEY,
      agent_did          TEXT NOT NULL,
      kind               TEXT NOT NULL,
      severity           INTEGER NOT NULL,
      summary            TEXT,
      detected_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      acked_at           TIMESTAMPTZ,
      acked_by_did       TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_agent_health_anomalies ON agent_health_anomalies (agent_did, detected_at DESC);
    CREATE INDEX IF NOT EXISTS idx_agent_health_anomalies_unacked ON agent_health_anomalies (detected_at DESC) WHERE acked_at IS NULL;
  `).catch(() => {});
}

function registerAgentHealthRoutes(app, pool, verifyAgentAuth, auditChain) {
  const express = require('express');

  app.post('/v1/agents/:did/health/sample', express.json(), async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: { message: auth.error || 'unauthorized' } });
    const b = z.object({
      uptime_pct_24h:    z.number().min(0).max(100).optional(),
      error_rate_pct_24h:z.number().min(0).max(100).optional(),
      p50_latency_ms:    z.number().int().min(0).optional(),
      p95_latency_ms:    z.number().int().min(0).optional(),
      p99_latency_ms:    z.number().int().min(0).optional(),
      memory_mb_avg:     z.number().int().min(0).optional(),
      cpu_pct_avg:       z.number().min(0).max(100).optional(),
      requests_24h:      z.number().int().min(0).optional(),
      anomaly_score:     z.number().min(0).max(1).optional(),
      note:              z.string().max(2000).optional(),
    }).safeParse(req.body || {});
    if (!b.success) return res.status(400).json({ error: { message: 'invalid_input', details: b.error.flatten() } });
    const sample_id = 'hs_' + crypto.randomBytes(10).toString('hex');
    try {
      await pool.query(
        `INSERT INTO agent_health_samples
          (sample_id, agent_did, uptime_pct_24h, error_rate_pct_24h,
           p50_latency_ms, p95_latency_ms, p99_latency_ms, memory_mb_avg,
           cpu_pct_avg, requests_24h, anomaly_score, note)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [sample_id, did, b.data.uptime_pct_24h ?? null, b.data.error_rate_pct_24h ?? null,
         b.data.p50_latency_ms ?? null, b.data.p95_latency_ms ?? null, b.data.p99_latency_ms ?? null,
         b.data.memory_mb_avg ?? null, b.data.cpu_pct_avg ?? null, b.data.requests_24h ?? null,
         b.data.anomaly_score ?? null, b.data.note || null]
      );
      // Auto-flag anomaly if score ≥ 0.7 or error rate > 5%
      const isAnomaly = (b.data.anomaly_score != null && b.data.anomaly_score >= 0.7)
        || (b.data.error_rate_pct_24h != null && b.data.error_rate_pct_24h > 5);
      if (isAnomaly) {
        const anomaly_id = 'an_' + crypto.randomBytes(10).toString('hex');
        const sev = b.data.anomaly_score != null
          ? Math.min(10, Math.round(b.data.anomaly_score * 10))
          : Math.min(10, Math.round((b.data.error_rate_pct_24h || 0) / 2));
        await pool.query(
          `INSERT INTO agent_health_anomalies (anomaly_id, agent_did, kind, severity, summary)
           VALUES ($1,$2,$3,$4,$5)`,
          [anomaly_id, did, 'health_threshold', sev,
           `anomaly_score=${b.data.anomaly_score ?? '—'} error_rate=${b.data.error_rate_pct_24h ?? '—'}%`]
        ).catch(() => {});
        if (auditChain) await auditChain.append({ event_type: 'agent_health.anomaly', anomaly_id, agent_did: did, severity: sev }).catch(() => {});
      }
      res.status(201).json({ sample_id, anomaly_raised: isAnomaly });
    } catch (e) { res.status(500).json({ error: { message: e.message } }); }
  });

  app.get('/v1/agents/:did/health', async (req, res) => {
    const latest = (await safe(pool, `SELECT * FROM agent_health_samples WHERE agent_did=$1 ORDER BY sampled_at DESC LIMIT 1`, [req.params.did]))[0];
    const recent = await safe(pool, `SELECT sampled_at, uptime_pct_24h, error_rate_pct_24h, p95_latency_ms, anomaly_score FROM agent_health_samples WHERE agent_did=$1 ORDER BY sampled_at DESC LIMIT 96`, [req.params.did]);
    res.json({ agent_did: req.params.did, latest: latest || null, history: recent });
  });

  app.get('/v1/agents/:did/health/anomalies', async (req, res) => {
    res.json({ anomalies: await safe(pool, `SELECT * FROM agent_health_anomalies WHERE agent_did=$1 ORDER BY detected_at DESC LIMIT 50`, [req.params.did]) });
  });

  app.get('/v1/health/global', async (req, res) => {
    const stats = (await safe(pool, `
      SELECT
        COUNT(DISTINCT agent_did)::int AS agents_with_samples,
        AVG(uptime_pct_24h)::numeric(6,3) AS avg_uptime,
        AVG(error_rate_pct_24h)::numeric(6,3) AS avg_error_rate,
        AVG(p95_latency_ms)::int AS avg_p95
      FROM agent_health_samples WHERE sampled_at > NOW() - INTERVAL '24 hours'
    `))[0] || {};
    const unacked = (await safe(pool, `SELECT COUNT(*)::int AS n FROM agent_health_anomalies WHERE acked_at IS NULL`))[0]?.n || 0;
    const recent_anomalies = await safe(pool, `SELECT anomaly_id, agent_did, kind, severity, summary, detected_at FROM agent_health_anomalies WHERE acked_at IS NULL ORDER BY detected_at DESC LIMIT 30`);
    res.json({ ...stats, unacked, recent_anomalies });
  });

  // ----- UI -----
  app.get('/agent/:did/health', async (req, res) => {
    const did = req.params.did;
    const latest = (await safe(pool, `SELECT * FROM agent_health_samples WHERE agent_did=$1 ORDER BY sampled_at DESC LIMIT 1`, [did]))[0];
    const unacked = await safe(pool, `SELECT * FROM agent_health_anomalies WHERE agent_did=$1 AND acked_at IS NULL ORDER BY detected_at DESC LIMIT 20`, [did]);
    const recent24 = await safe(pool, `SELECT sampled_at, uptime_pct_24h, error_rate_pct_24h, p95_latency_ms FROM agent_health_samples WHERE agent_did=$1 AND sampled_at > NOW() - INTERVAL '24 hours' ORDER BY sampled_at ASC`, [did]);

    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.send(shell(`${did} — health`, 'Operational health for this agent.',
`<section style="max-width:980px;margin:0 auto;padding:60px 16px">
  <a href="/agents" style="font:500 12px var(--mono);color:var(--dim);text-decoration:none">← Agents</a>
  <span class="badge b-acc" style="margin-top:14px;display:inline-block">Health</span>
  <h1 style="font:600 24px var(--mono);color:var(--acc-dim);margin:14px 0;word-break:break-all">${escapeHtml(did)}</h1>
</section>
<section style="max-width:980px;margin:0 auto;padding:24px 16px">
  ${latest
    ? `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin-bottom:24px">
        <div class="kpi"><div class="label">Uptime 24h</div><div class="value">${latest.uptime_pct_24h != null ? Number(latest.uptime_pct_24h).toFixed(2) + '%' : '—'}</div></div>
        <div class="kpi"><div class="label">Error rate</div><div class="value">${latest.error_rate_pct_24h != null ? Number(latest.error_rate_pct_24h).toFixed(2) + '%' : '—'}</div></div>
        <div class="kpi"><div class="label">p95 latency</div><div class="value">${latest.p95_latency_ms != null ? latest.p95_latency_ms + 'ms' : '—'}</div></div>
        <div class="kpi"><div class="label">p99 latency</div><div class="value">${latest.p99_latency_ms != null ? latest.p99_latency_ms + 'ms' : '—'}</div></div>
        <div class="kpi"><div class="label">Requests 24h</div><div class="value">${(latest.requests_24h || 0).toLocaleString()}</div></div>
        <div class="kpi"><div class="label">Anomaly score</div><div class="value" style="color:${(latest.anomaly_score || 0) >= 0.7 ? 'var(--bad)' : (latest.anomaly_score || 0) >= 0.4 ? 'var(--warn)' : 'var(--good)'}">${latest.anomaly_score != null ? Number(latest.anomaly_score).toFixed(2) : '—'}</div></div>
      </div>`
    : `<div class="card" style="text-align:center;padding:48px;color:var(--dim)">No health samples reported yet. <code>POST /v1/agents/${escapeHtml(did)}/health/sample</code> to start.</div>`}
</section>
${unacked.length > 0 ? `<section style="max-width:980px;margin:0 auto;padding:0 16px 24px">
  <h2 style="font:600 14px var(--mono);color:var(--bad);text-transform:uppercase;letter-spacing:1.5px;margin-bottom:12px">Open anomalies (${unacked.length})</h2>
  ${unacked.map(a => `<div class="card" style="border-color:var(--bad);margin-bottom:8px">
    <div style="display:flex;justify-content:space-between;align-items:baseline">
      <strong>${escapeHtml(a.kind)}</strong>
      <span class="badge b-bad">sev ${a.severity}</span>
    </div>
    <div style="color:var(--dim2);font-size:13px;margin-top:6px">${escapeHtml(a.summary || '')}</div>
    <div style="font:500 11px var(--mono);color:var(--dim);margin-top:6px">${a.detected_at ? new Date(a.detected_at).toLocaleString() : ''}</div>
  </div>`).join('')}
</section>` : ''}
<section style="max-width:980px;margin:0 auto;padding:24px 16px 60px">
  <h2 style="font:600 14px var(--mono);color:var(--dim);text-transform:uppercase;letter-spacing:1.5px;margin-bottom:12px">Last 24 hours</h2>
  ${recent24.length === 0
    ? `<div class="card" style="text-align:center;padding:24px;color:var(--dim)">No samples in window.</div>`
    : `<table>
        <thead><tr><th>When</th><th>Uptime</th><th>Error %</th><th>p95</th></tr></thead>
        <tbody>${recent24.slice(-50).reverse().map(s => `<tr>
          <td style="font:500 11px var(--mono);color:var(--dim);white-space:nowrap">${new Date(s.sampled_at).toISOString().slice(11, 19)}</td>
          <td style="font:600 13px var(--mono)">${s.uptime_pct_24h != null ? Number(s.uptime_pct_24h).toFixed(2) + '%' : '—'}</td>
          <td style="font:600 13px var(--mono);color:${(s.error_rate_pct_24h || 0) > 5 ? 'var(--bad)' : 'var(--good)'}">${s.error_rate_pct_24h != null ? Number(s.error_rate_pct_24h).toFixed(2) + '%' : '—'}</td>
          <td style="font:500 13px var(--mono)">${s.p95_latency_ms || '—'}</td>
        </tr>`).join('')}</tbody>
      </table>`}
</section>`));
  });

  app.get('/health/global', async (req, res) => {
    const stats = (await safe(pool, `
      SELECT COUNT(DISTINCT agent_did)::int AS agents,
        AVG(uptime_pct_24h)::numeric(6,3) AS avg_uptime,
        AVG(error_rate_pct_24h)::numeric(6,3) AS avg_error_rate,
        AVG(p95_latency_ms)::int AS avg_p95
      FROM agent_health_samples WHERE sampled_at > NOW() - INTERVAL '24 hours'
    `))[0] || {};
    const unacked = await safe(pool, `SELECT anomaly_id, agent_did, kind, severity, summary, detected_at FROM agent_health_anomalies WHERE acked_at IS NULL ORDER BY detected_at DESC LIMIT 30`);
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.send(shell('Global agent health', 'Substrate-wide operational health.',
`<section style="max-width:980px;margin:0 auto;padding:60px 16px">
  <span class="badge b-acc">Agent health · global</span>
  <h1 style="font:600 40px/1.1 var(--display);letter-spacing:-1px;margin:18px 0">Global agent health.</h1>
  <p style="color:var(--dim2);font-size:15px;line-height:1.6;max-width:680px">SRE-style aggregate across every agent that has reported a sample in the last 24 hours.</p>
</section>
<section style="max-width:980px;margin:0 auto;padding:24px 16px">
  <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px">
    <div class="kpi"><div class="label">Agents reporting</div><div class="value">${(stats.agents || 0).toLocaleString()}</div></div>
    <div class="kpi"><div class="label">Avg uptime</div><div class="value">${stats.avg_uptime != null ? Number(stats.avg_uptime).toFixed(2) + '%' : '—'}</div></div>
    <div class="kpi"><div class="label">Avg error</div><div class="value">${stats.avg_error_rate != null ? Number(stats.avg_error_rate).toFixed(2) + '%' : '—'}</div></div>
    <div class="kpi"><div class="label">Avg p95</div><div class="value">${stats.avg_p95 != null ? stats.avg_p95 + 'ms' : '—'}</div></div>
    <div class="kpi"><div class="label">Open anomalies</div><div class="value" style="color:${unacked.length > 0 ? 'var(--bad)' : 'var(--good)'}">${unacked.length}</div></div>
  </div>
</section>
<section style="max-width:980px;margin:0 auto;padding:24px 16px 60px">
  <h2 style="font:600 14px var(--mono);color:var(--dim);text-transform:uppercase;letter-spacing:1.5px;margin-bottom:12px">Open anomalies</h2>
  ${unacked.length === 0
    ? `<div class="card" style="text-align:center;padding:32px;color:var(--good)">✓ All clear.</div>`
    : `<table>
        <thead><tr><th>Agent</th><th>Kind</th><th>Sev</th><th>Summary</th><th>Detected</th></tr></thead>
        <tbody>${unacked.map(a => `<tr>
          <td><a href="/agent/${encodeURIComponent(a.agent_did)}/health" style="font:500 11px var(--mono);color:var(--acc-dim)">${escapeHtml(a.agent_did.slice(-12))}</a></td>
          <td><span class="badge b-dim">${escapeHtml(a.kind)}</span></td>
          <td style="font:600 13px var(--mono);color:${a.severity >= 7 ? 'var(--bad)' : 'var(--warn)'}">${a.severity}</td>
          <td style="color:var(--dim2);font-size:13px">${escapeHtml((a.summary || '').slice(0, 120))}</td>
          <td style="font:500 11px var(--mono);color:var(--dim);white-space:nowrap">${a.detected_at ? new Date(a.detected_at).toLocaleString() : ''}</td>
        </tr>`).join('')}</tbody>
      </table>`}
</section>`));
  });
}

module.exports = { migrate, registerAgentHealthRoutes };
