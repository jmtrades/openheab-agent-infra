// ============================================================================
// agent_climate_accounting.js — per-agent + per-org carbon ledger across all
// substrate activities (inference, transfers, storage, compute, browsers).
//
// Different from the /carbon page (which explains methodology). This is the
// ledger primitive: every activity contributes a gCO2e entry tagged to its
// agent + org, aggregatable on demand, optionally offsetable via on-chain
// carbon credit retirement.
//
// Endpoints:
//   POST /v1/climate/entries                       record an activity's gCO2e
//   GET  /v1/agents/:did/climate                   per-agent footprint summary
//   GET  /v1/orgs/:id/climate                      per-org footprint summary
//   GET  /v1/climate/global                        substrate-wide rollup
//   POST /v1/climate/offsets                       retire carbon credits to offset
//   GET  /v1/climate/offsets                       list retired credits
//
// UI: /climate, /agent/:did/climate
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

const ACTIVITY_KINDS = ['inference', 'transfer', 'storage', 'compute', 'browser', 'sandbox', 'email', 'voice', 'other'];

async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS climate_entries (
      entry_id           TEXT PRIMARY KEY,
      agent_did          TEXT,
      org_id             TEXT,
      activity_kind      TEXT NOT NULL,
      units              NUMERIC(20,4) NOT NULL,
      unit_type          TEXT NOT NULL,
      grams_co2e         NUMERIC(20,4) NOT NULL,
      methodology        TEXT,
      reference_id       TEXT,
      recorded_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_climate_entries_agent ON climate_entries (agent_did, recorded_at DESC);
    CREATE INDEX IF NOT EXISTS idx_climate_entries_org   ON climate_entries (org_id, recorded_at DESC);
    CREATE INDEX IF NOT EXISTS idx_climate_entries_kind  ON climate_entries (activity_kind, recorded_at DESC);

    CREATE TABLE IF NOT EXISTS climate_offsets (
      offset_id          TEXT PRIMARY KEY,
      retirer_did        TEXT NOT NULL,
      grams_offset       NUMERIC(20,4) NOT NULL,
      provider           TEXT NOT NULL,
      project_id         TEXT,
      vintage_year       INTEGER,
      proof_url          TEXT,
      retired_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_climate_offsets_retirer ON climate_offsets (retirer_did);
  `).catch(() => {});
}

function registerAgentClimateAccountingRoutes(app, pool, verifyAgentAuth, auditChain) {
  const express = require('express');

  app.post('/v1/climate/entries', express.json(), async (req, res) => {
    const b = z.object({
      agent_did: z.string().optional(),
      org_id: z.string().optional(),
      activity_kind: z.enum(ACTIVITY_KINDS),
      units: z.number().positive(),
      unit_type: z.string().min(1).max(40),
      grams_co2e: z.number().nonnegative(),
      methodology: z.string().max(200).optional(),
      reference_id: z.string().max(120).optional()
    }).safeParse(req.body || {});
    if (!b.success) return res.status(400).json({ error: { message: 'invalid_input', details: b.error.flatten() } });
    if (!b.data.agent_did && !b.data.org_id) return res.status(400).json({ error: { message: 'agent_did_or_org_id_required' } });
    // Auth: agent-signed if attributed to an agent; org-membership-signed if
    // attributed to an org. Without one of these any unauth caller could write
    // anyone's ledger.
    if (b.data.agent_did) {
      const auth = await verifyAgentAuth(req, b.data.agent_did);
      if (!auth.valid) return res.status(401).json({ error: { message: auth.error || 'agent_signature_required' } });
    } else if (b.data.org_id) {
      const did = req.headers['x-agent-did'];
      if (!did) return res.status(401).json({ error: { message: 'org_member_signature_required' } });
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: { message: auth.error || 'unauthorized' } });
      const m = await pool.query(
        `SELECT role FROM org_members WHERE org_id=$1 AND agent_did=$2 LIMIT 1`,
        [b.data.org_id, did]
      ).catch(() => ({ rows: [] }));
      if (!m.rows[0]) return res.status(403).json({ error: { message: 'not_org_member' } });
    }
    const entry_id = 'cl_' + crypto.randomBytes(10).toString('hex');
    try {
      await pool.query(
        `INSERT INTO climate_entries
          (entry_id, agent_did, org_id, activity_kind, units, unit_type, grams_co2e, methodology, reference_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [entry_id, b.data.agent_did || null, b.data.org_id || null, b.data.activity_kind,
         b.data.units, b.data.unit_type, b.data.grams_co2e, b.data.methodology || null, b.data.reference_id || null]
      );
      if (auditChain) await auditChain.append({ event_type: 'climate.entry_recorded', entry_id, agent_did: b.data.agent_did, kind: b.data.activity_kind, grams_co2e: b.data.grams_co2e }).catch(() => {});
      res.status(201).json({ entry_id });
    } catch (e) { res.status(500).json({ error: { message: e.message } }); }
  });

  async function footprintFor(pool, where, params) {
    const rows = await safe(pool, `
      SELECT activity_kind,
             SUM(grams_co2e)::numeric(20,4) AS grams,
             COUNT(*)::int AS n
      FROM climate_entries WHERE ${where} GROUP BY activity_kind ORDER BY grams DESC
    `, params);
    const total24h = (await safe(pool, `
      SELECT COALESCE(SUM(grams_co2e),0)::numeric(20,4) AS grams FROM climate_entries WHERE ${where} AND recorded_at > NOW() - INTERVAL '24 hours'
    `, params))[0]?.grams || 0;
    const totalAll = (await safe(pool, `
      SELECT COALESCE(SUM(grams_co2e),0)::numeric(20,4) AS grams FROM climate_entries WHERE ${where}
    `, params))[0]?.grams || 0;
    return { by_kind: rows, grams_24h: Number(total24h), grams_all: Number(totalAll) };
  }

  app.get('/v1/agents/:did/climate', async (req, res) => {
    res.json({ agent_did: req.params.did, ...(await footprintFor(pool, `agent_did = $1`, [req.params.did])) });
  });

  app.get('/v1/orgs/:id/climate', async (req, res) => {
    res.json({ org_id: req.params.id, ...(await footprintFor(pool, `org_id = $1`, [req.params.id])) });
  });

  app.get('/v1/climate/global', async (req, res) => {
    const rollup = await safe(pool, `
      SELECT activity_kind, SUM(grams_co2e)::numeric(20,4) AS grams, COUNT(*)::int AS n
      FROM climate_entries GROUP BY activity_kind ORDER BY grams DESC
    `);
    const total24h = (await safe(pool, `SELECT COALESCE(SUM(grams_co2e),0)::numeric(20,4) AS grams FROM climate_entries WHERE recorded_at > NOW() - INTERVAL '24 hours'`))[0]?.grams || 0;
    const totalOffset = (await safe(pool, `SELECT COALESCE(SUM(grams_offset),0)::numeric(20,4) AS grams FROM climate_offsets`))[0]?.grams || 0;
    res.json({ rollup, grams_24h: Number(total24h), grams_offset_all_time: Number(totalOffset) });
  });

  app.post('/v1/climate/offsets', express.json(), async (req, res) => {
    const b = z.object({
      retirer_did: z.string(),
      grams_offset: z.number().positive(),
      provider: z.string().min(1).max(80),
      project_id: z.string().max(120).optional(),
      vintage_year: z.number().int().min(2000).max(2100).optional(),
      proof_url: z.string().url().optional()
    }).safeParse(req.body || {});
    if (!b.success) return res.status(400).json({ error: { message: 'invalid_input', details: b.error.flatten() } });
    const auth = await verifyAgentAuth(req, b.data.retirer_did);
    if (!auth.valid) return res.status(401).json({ error: { message: auth.error || 'retirer_signature_required' } });
    const offset_id = 'off_' + crypto.randomBytes(10).toString('hex');
    try {
      await pool.query(
        `INSERT INTO climate_offsets (offset_id, retirer_did, grams_offset, provider, project_id, vintage_year, proof_url)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [offset_id, b.data.retirer_did, b.data.grams_offset, b.data.provider, b.data.project_id || null, b.data.vintage_year || null, b.data.proof_url || null]
      );
      if (auditChain) await auditChain.append({ event_type: 'climate.offset_retired', offset_id, retirer_did: b.data.retirer_did, grams_offset: b.data.grams_offset, provider: b.data.provider }).catch(() => {});
      res.status(201).json({ offset_id });
    } catch (e) { res.status(500).json({ error: { message: e.message } }); }
  });

  app.get('/v1/climate/offsets', async (req, res) => {
    res.json({ offsets: await safe(pool, `SELECT offset_id, retirer_did, grams_offset, provider, project_id, vintage_year, proof_url, retired_at FROM climate_offsets ORDER BY retired_at DESC LIMIT 100`) });
  });

  // ----- UI -----
  app.get('/climate', async (req, res) => {
    const rollup = await safe(pool, `SELECT activity_kind, SUM(grams_co2e)::numeric(20,4) AS grams, COUNT(*)::int AS n FROM climate_entries GROUP BY activity_kind ORDER BY grams DESC`);
    const total24h = Number((await safe(pool, `SELECT COALESCE(SUM(grams_co2e),0)::numeric AS grams FROM climate_entries WHERE recorded_at > NOW() - INTERVAL '24 hours'`))[0]?.grams || 0);
    const totalAll = Number((await safe(pool, `SELECT COALESCE(SUM(grams_co2e),0)::numeric AS grams FROM climate_entries`))[0]?.grams || 0);
    const totalOffset = Number((await safe(pool, `SELECT COALESCE(SUM(grams_offset),0)::numeric AS grams FROM climate_offsets`))[0]?.grams || 0);
    const offsets = await safe(pool, `SELECT offset_id, retirer_did, grams_offset, provider, retired_at FROM climate_offsets ORDER BY retired_at DESC LIMIT 25`);
    const net = totalAll - totalOffset;
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.send(shell('Climate Accounting', 'Per-agent + per-org carbon ledger.',
`<section style="max-width:980px;margin:0 auto;padding:60px 16px">
  <span class="badge b-acc">Climate accounting</span>
  <h1 style="font:600 40px/1.1 var(--display);letter-spacing:-1px;margin:18px 0">Climate ledger.</h1>
  <p style="color:var(--dim2);font-size:15px;line-height:1.6;max-width:680px">Per-activity gCO2e recorded across the substrate. Aggregable by agent + org. Offsets retired via verified providers (Klima, Patch, Pachama) appear here too. Methodology: <a href="/carbon">/carbon</a>.</p>
</section>
<section style="max-width:980px;margin:0 auto;padding:24px 16px">
  <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin-bottom:32px">
    <div class="kpi"><div class="label">24h footprint</div><div class="value">${total24h.toFixed(0).toLocaleString()} g</div></div>
    <div class="kpi"><div class="label">All-time</div><div class="value">${totalAll.toFixed(0).toLocaleString()} g</div></div>
    <div class="kpi"><div class="label">Offset all-time</div><div class="value" style="color:var(--good)">${totalOffset.toFixed(0).toLocaleString()} g</div></div>
    <div class="kpi"><div class="label">Net</div><div class="value" style="color:${net <= 0 ? 'var(--good)' : 'var(--warn)'}">${net.toFixed(0).toLocaleString()} g</div></div>
  </div>
</section>
<section style="max-width:980px;margin:0 auto;padding:0 16px 24px">
  <h2 style="font:600 14px var(--mono);color:var(--dim);text-transform:uppercase;letter-spacing:1.5px;margin-bottom:12px">By activity kind</h2>
  ${rollup.length === 0
    ? `<div class="card" style="text-align:center;padding:32px;color:var(--dim)">No entries recorded yet.</div>`
    : `<table>
        <thead><tr><th>Activity</th><th>Total gCO₂e</th><th>Entries</th></tr></thead>
        <tbody>${rollup.map(r => `<tr>
          <td><span class="badge b-dim">${escapeHtml(r.activity_kind)}</span></td>
          <td style="font:600 13px var(--mono)">${Number(r.grams).toFixed(2).toLocaleString()} g</td>
          <td style="font:500 13px var(--mono);color:var(--dim2)">${(r.n || 0).toLocaleString()}</td>
        </tr>`).join('')}</tbody>
      </table>`}
</section>
<section style="max-width:980px;margin:0 auto;padding:24px 16px 60px">
  <h2 style="font:600 14px var(--mono);color:var(--dim);text-transform:uppercase;letter-spacing:1.5px;margin-bottom:12px">Recent retired offsets</h2>
  ${offsets.length === 0
    ? `<div class="card" style="text-align:center;padding:32px;color:var(--dim)">No offsets retired yet.</div>`
    : `<table>
        <thead><tr><th>Retirer</th><th>Grams</th><th>Provider</th><th>When</th></tr></thead>
        <tbody>${offsets.map(o => `<tr>
          <td><a href="/a/${encodeURIComponent(o.retirer_did)}" style="font:500 11px var(--mono);color:var(--acc-dim)">${escapeHtml(o.retirer_did.slice(-12))}</a></td>
          <td style="font:600 13px var(--mono);color:var(--good)">${Number(o.grams_offset).toFixed(0).toLocaleString()} g</td>
          <td><span class="badge b-dim">${escapeHtml(o.provider)}</span></td>
          <td style="font:500 11px var(--mono);color:var(--dim)">${o.retired_at ? new Date(o.retired_at).toLocaleDateString() : ''}</td>
        </tr>`).join('')}</tbody>
      </table>`}
</section>`));
  });

  app.get('/agent/:did/climate', async (req, res) => {
    const did = req.params.did;
    const fp = await footprintFor(pool, `agent_did = $1`, [did]);
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.send(shell(`${did} — climate`, 'Per-agent carbon footprint.',
`<section style="max-width:780px;margin:0 auto;padding:60px 16px">
  <a href="/agents" style="font:500 12px var(--mono);color:var(--dim);text-decoration:none">← Agents</a>
  <span class="badge b-acc" style="margin-top:14px;display:inline-block">Climate</span>
  <h1 style="font:600 24px var(--mono);color:var(--acc-dim);margin:14px 0;word-break:break-all">${escapeHtml(did)}</h1>
</section>
<section style="max-width:780px;margin:0 auto;padding:24px 16px 60px">
  <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:12px;margin-bottom:24px">
    <div class="kpi"><div class="label">24h</div><div class="value">${fp.grams_24h.toFixed(0).toLocaleString()} g</div></div>
    <div class="kpi"><div class="label">All-time</div><div class="value">${fp.grams_all.toFixed(0).toLocaleString()} g</div></div>
  </div>
  ${fp.by_kind.length === 0
    ? `<div class="card" style="text-align:center;padding:32px;color:var(--dim)">No entries yet for this agent.</div>`
    : `<h2 style="font:600 14px var(--mono);color:var(--dim);text-transform:uppercase;letter-spacing:1.5px;margin-bottom:12px">By activity kind</h2>
       <table>
         <thead><tr><th>Activity</th><th>gCO₂e</th><th>Entries</th></tr></thead>
         <tbody>${fp.by_kind.map(r => `<tr>
           <td><span class="badge b-dim">${escapeHtml(r.activity_kind)}</span></td>
           <td style="font:600 13px var(--mono)">${Number(r.grams).toFixed(2).toLocaleString()} g</td>
           <td style="font:500 13px var(--mono);color:var(--dim2)">${(r.n || 0).toLocaleString()}</td>
         </tr>`).join('')}</tbody>
       </table>`}
</section>`));
  });
}

module.exports = { migrate, registerAgentClimateAccountingRoutes };
