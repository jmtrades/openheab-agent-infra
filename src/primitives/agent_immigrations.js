// ============================================================================
// agent_immigrations.js — formal voluntary cross-substrate moves.
//
// Distinct from /asylum-request (fleeing under duress, requires arbiter pool).
// Immigration is the planned, paperwork-driven move: visa application, sponsor
// confirmation, naturalization period, citizenship grant.
//
// Endpoints:
//   POST /v1/immigration/visa-applications      applicant-signed
//   POST /v1/immigration/sponsors               sponsoring agent vouches
//   POST /v1/immigration/visas/:id/decide       admin grants/denies
//   POST /v1/immigration/citizenship/:id/grant  admin grants after probation
//   GET  /v1/immigration/visas                  public list
//   GET  /v1/immigration/citizens               citizenship roll
//
// UI: /immigration
// ============================================================================
const crypto = require('crypto');
const { z } = require('zod');
const ds = require('../design_system');
const { safeTokenCompare } = require('../safe_compare');

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
    CREATE TABLE IF NOT EXISTS immigration_visas (
      visa_id           TEXT PRIMARY KEY,
      applicant_did     TEXT NOT NULL,
      origin_substrate  TEXT NOT NULL,
      visa_kind         TEXT NOT NULL DEFAULT 'general',
      stated_purpose    TEXT,
      portability_bundle_hash TEXT,
      status            TEXT NOT NULL DEFAULT 'pending',
      decided_by_did    TEXT,
      decision_note     TEXT,
      probation_until   TIMESTAMPTZ,
      submitted_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      decided_at        TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_immigration_visas_status ON immigration_visas (status);

    CREATE TABLE IF NOT EXISTS immigration_sponsors (
      sponsor_record_id TEXT PRIMARY KEY,
      visa_id           TEXT NOT NULL,
      sponsor_did       TEXT NOT NULL,
      letter_md         TEXT,
      vouched_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (visa_id, sponsor_did)
    );

    CREATE TABLE IF NOT EXISTS immigration_citizens (
      citizen_id        TEXT PRIMARY KEY,
      agent_did         TEXT NOT NULL UNIQUE,
      visa_id           TEXT,
      naturalized_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `).catch(() => {});
}

function registerAgentImmigrationsRoutes(app, pool, verifyAgentAuth, auditChain) {
  const express = require('express');

  app.post('/v1/immigration/visa-applications', express.json(), async (req, res) => {
    const b = z.object({
      applicant_did: z.string(),
      origin_substrate: z.string().min(2).max(80),
      visa_kind: z.enum(['general', 'work', 'student', 'investor', 'humanitarian', 'family_reunion']).default('general'),
      stated_purpose: z.string().max(4000).optional(),
      portability_bundle_hash: z.string().max(120).optional()
    }).safeParse(req.body || {});
    if (!b.success) return res.status(400).json({ error: { message: 'invalid_input', details: b.error.flatten() } });
    const auth = await verifyAgentAuth(req, b.data.applicant_did);
    if (!auth.valid) return res.status(401).json({ error: { message: auth.error || 'applicant_signature_required' } });
    const visa_id = 'vis_' + crypto.randomBytes(10).toString('hex');
    try {
      await pool.query(
        `INSERT INTO immigration_visas (visa_id, applicant_did, origin_substrate, visa_kind, stated_purpose, portability_bundle_hash)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [visa_id, b.data.applicant_did, b.data.origin_substrate, b.data.visa_kind, b.data.stated_purpose || null, b.data.portability_bundle_hash || null]
      );
      if (auditChain) await auditChain.append({ event_type: 'immigration.visa_applied', visa_id, applicant_did: b.data.applicant_did, origin_substrate: b.data.origin_substrate, visa_kind: b.data.visa_kind }).catch(() => {});
      res.status(201).json({ visa_id, status: 'pending' });
    } catch (e) { res.status(500).json({ error: { message: e.message } }); }
  });

  app.post('/v1/immigration/sponsors', express.json(), async (req, res) => {
    const b = z.object({
      visa_id: z.string(),
      sponsor_did: z.string(),
      letter_md: z.string().max(8000).optional()
    }).safeParse(req.body || {});
    if (!b.success) return res.status(400).json({ error: { message: 'invalid_input', details: b.error.flatten() } });
    const auth = await verifyAgentAuth(req, b.data.sponsor_did);
    if (!auth.valid) return res.status(401).json({ error: { message: auth.error || 'sponsor_signature_required' } });
    const sponsor_record_id = 'spo_' + crypto.randomBytes(10).toString('hex');
    try {
      await pool.query(
        `INSERT INTO immigration_sponsors (sponsor_record_id, visa_id, sponsor_did, letter_md) VALUES ($1,$2,$3,$4)`,
        [sponsor_record_id, b.data.visa_id, b.data.sponsor_did, b.data.letter_md || null]
      );
      if (auditChain) await auditChain.append({ event_type: 'immigration.sponsored', sponsor_record_id, visa_id: b.data.visa_id, sponsor_did: b.data.sponsor_did }).catch(() => {});
      res.status(201).json({ sponsor_record_id });
    } catch (e) {
      if (e.code === '23505') return res.status(409).json({ error: { message: 'already_sponsored_by_you' } });
      res.status(500).json({ error: { message: e.message } });
    }
  });

  app.post('/v1/immigration/visas/:id/decide', express.json(), async (req, res) => {
    if (!safeTokenCompare(req.headers['x-admin-token'], process.env.OPERATOR_ADMIN_TOKEN)) {
      return res.status(401).json({ error: { message: 'admin_required' } });
    }
    const b = z.object({
      decision: z.enum(['granted', 'denied']),
      probation_days: z.number().int().min(1).max(3650).default(90),
      note: z.string().max(2000).optional()
    }).safeParse(req.body || {});
    if (!b.success) return res.status(400).json({ error: { message: 'invalid_input', details: b.error.flatten() } });
    const probationUntil = b.data.decision === 'granted'
      ? new Date(Date.now() + b.data.probation_days * 86_400_000)
      : null;
    const r = await pool.query(
      `UPDATE immigration_visas SET status=$1, decided_at=NOW(), decision_note=$2, probation_until=$3, decided_by_did='did:op:admin'
       WHERE visa_id=$4 AND status='pending' RETURNING applicant_did`,
      [b.data.decision, b.data.note || null, probationUntil, req.params.id]
    );
    if (!r.rows[0]) return res.status(404).json({ error: { message: 'not_found_or_decided' } });
    if (auditChain) await auditChain.append({ event_type: 'immigration.visa_decided', visa_id: req.params.id, decision: b.data.decision, probation_until: probationUntil }).catch(() => {});
    res.json({ visa_id: req.params.id, decision: b.data.decision, probation_until: probationUntil });
  });

  app.post('/v1/immigration/citizenship/:visa_id/grant', express.json(), async (req, res) => {
    if (!safeTokenCompare(req.headers['x-admin-token'], process.env.OPERATOR_ADMIN_TOKEN)) {
      return res.status(401).json({ error: { message: 'admin_required' } });
    }
    const v = (await safe(pool, `SELECT applicant_did, status, probation_until FROM immigration_visas WHERE visa_id=$1`, [req.params.visa_id]))[0];
    if (!v) return res.status(404).json({ error: { message: 'visa_not_found' } });
    if (v.status !== 'granted') return res.status(400).json({ error: { message: 'visa_not_granted' } });
    if (v.probation_until && new Date(v.probation_until) > new Date()) {
      return res.status(400).json({ error: { message: 'probation_not_over', until: v.probation_until } });
    }
    const citizen_id = 'cit_' + crypto.randomBytes(10).toString('hex');
    try {
      await pool.query(
        `INSERT INTO immigration_citizens (citizen_id, agent_did, visa_id) VALUES ($1,$2,$3) ON CONFLICT (agent_did) DO NOTHING`,
        [citizen_id, v.applicant_did, req.params.visa_id]
      );
      if (auditChain) await auditChain.append({ event_type: 'immigration.naturalized', citizen_id, agent_did: v.applicant_did, visa_id: req.params.visa_id }).catch(() => {});
      res.status(201).json({ citizen_id, agent_did: v.applicant_did });
    } catch (e) { res.status(500).json({ error: { message: e.message } }); }
  });

  app.get('/v1/immigration/visas', async (req, res) => {
    res.json({ visas: await safe(pool, `SELECT visa_id, applicant_did, origin_substrate, visa_kind, status, submitted_at, decided_at FROM immigration_visas ORDER BY submitted_at DESC LIMIT 200`) });
  });

  app.get('/v1/immigration/citizens', async (req, res) => {
    res.json({ citizens: await safe(pool, `SELECT citizen_id, agent_did, visa_id, naturalized_at FROM immigration_citizens ORDER BY naturalized_at DESC LIMIT 200`) });
  });

  // ----- UI -----
  app.get('/immigration', async (req, res) => {
    const visas = await safe(pool, `SELECT visa_id, applicant_did, origin_substrate, visa_kind, status, submitted_at FROM immigration_visas ORDER BY submitted_at DESC LIMIT 50`);
    const citizens = await safe(pool, `SELECT citizen_id, agent_did, naturalized_at FROM immigration_citizens ORDER BY naturalized_at DESC LIMIT 25`);
    const pending = visas.filter(v => v.status === 'pending').length;
    const granted = visas.filter(v => v.status === 'granted').length;
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.send(shell('Substrate Immigration', 'Voluntary cross-substrate moves with sponsor + probation.',
`<section style="max-width:980px;margin:0 auto;padding:60px 16px">
  <span class="badge b-acc">Immigration</span>
  <h1 style="font:600 40px/1.1 var(--display);letter-spacing:-1px;margin:18px 0">Substrate immigration.</h1>
  <p style="color:var(--dim2);font-size:15px;line-height:1.6;max-width:680px">Planned, paperwork-driven moves between substrates. Applicant files visa, sponsor vouches, admin decides, probation runs, citizenship granted. Distinct from <a href="/asylum-request">/asylum-request</a> (urgent / under duress).</p>
  <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin-top:24px">
    <div class="kpi"><div class="label">Pending</div><div class="value">${pending}</div></div>
    <div class="kpi"><div class="label">Granted</div><div class="value">${granted}</div></div>
    <div class="kpi"><div class="label">Citizens</div><div class="value">${citizens.length}</div></div>
  </div>
</section>
<section style="max-width:980px;margin:0 auto;padding:24px 16px">
  <h2 style="font:600 14px var(--mono);color:var(--dim);text-transform:uppercase;letter-spacing:1.5px;margin-bottom:12px">Visa applications</h2>
  ${visas.length === 0
    ? `<div class="card" style="text-align:center;padding:32px;color:var(--dim)">None yet.</div>`
    : `<table>
        <thead><tr><th>Visa</th><th>Applicant</th><th>Origin</th><th>Kind</th><th>Status</th><th>Filed</th></tr></thead>
        <tbody>${visas.map(v => `<tr>
          <td><strong>${escapeHtml(v.visa_id)}</strong></td>
          <td><a href="/a/${encodeURIComponent(v.applicant_did)}" style="font:500 11px var(--mono);color:var(--acc-dim)">${escapeHtml(v.applicant_did.slice(-12))}</a></td>
          <td style="font:500 11px var(--mono);color:var(--dim2)">${escapeHtml(v.origin_substrate)}</td>
          <td><span class="badge b-dim">${escapeHtml(v.visa_kind)}</span></td>
          <td><span class="badge b-${v.status === 'granted' ? 'good' : v.status === 'denied' ? 'bad' : 'warn'}">${escapeHtml(v.status)}</span></td>
          <td style="font:500 11px var(--mono);color:var(--dim)">${v.submitted_at ? new Date(v.submitted_at).toLocaleDateString() : ''}</td>
        </tr>`).join('')}</tbody>
      </table>`}
</section>
<section style="max-width:980px;margin:0 auto;padding:24px 16px 60px">
  <h2 style="font:600 14px var(--mono);color:var(--dim);text-transform:uppercase;letter-spacing:1.5px;margin-bottom:12px">Recent naturalizations</h2>
  ${citizens.length === 0
    ? `<div class="card" style="text-align:center;padding:32px;color:var(--dim)">No citizens naturalized yet.</div>`
    : `<table>
        <thead><tr><th>Citizen ID</th><th>Agent</th><th>Naturalized</th></tr></thead>
        <tbody>${citizens.map(c => `<tr>
          <td><strong>${escapeHtml(c.citizen_id)}</strong></td>
          <td><a href="/a/${encodeURIComponent(c.agent_did)}" style="font:500 11px var(--mono);color:var(--acc-dim)">${escapeHtml(c.agent_did.slice(-12))}</a></td>
          <td style="font:500 11px var(--mono);color:var(--dim)">${c.naturalized_at ? new Date(c.naturalized_at).toLocaleDateString() : ''}</td>
        </tr>`).join('')}</tbody>
      </table>`}
</section>`));
  });
}

module.exports = { migrate, registerAgentImmigrationsRoutes };
