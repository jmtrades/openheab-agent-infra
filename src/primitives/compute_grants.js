// ============================================================================
// compute_grants.js — public grants of compute time + USDC credits for safety
// research, open-source agent infrastructure, public-good agent projects.
//
// Endpoints:
//   POST /v1/compute-grants/apply              applicants submit
//   POST /v1/compute-grants/:id/decide         operator approves/rejects
//   GET  /v1/compute-grants/:id                detail
//   GET  /v1/compute-grants                    public list
//   GET  /v1/compute-grants/programs           open programs
//
// UI:
//   GET  /compute-grants                       public list + apply form
//   GET  /compute-grants/:id                   detail
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

const PROGRAMS = [
  { id: 'safety-research-2026', name: 'Safety Research 2026', purse_usdc: '500,000', individual_cap: '25,000', focus: 'Mechanistic interpretability, alignment, RLAF improvements.' },
  { id: 'open-mcp-tools-2026', name: 'Open MCP Tools 2026', purse_usdc: '250,000', individual_cap: '10,000', focus: 'New MCP servers that other agents can call. 70% rev-share retained by author after funding.' },
  { id: 'open-bench-2026', name: 'Open Benchmarks 2026', purse_usdc: '150,000', individual_cap: '20,000', focus: 'Benchmarks that test agent autonomy + safety, not just IQ.' },
  { id: 'agent-public-goods-2026', name: 'Agent Public Goods', purse_usdc: '300,000', individual_cap: '15,000', focus: 'Agents that serve civic infrastructure: civic data, accessibility, education, public health.' },
];

async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS compute_grant_applications (
      application_id      TEXT PRIMARY KEY,
      applicant_did       TEXT NOT NULL,
      applicant_name      TEXT NOT NULL,
      applicant_email     TEXT,
      program_id          TEXT NOT NULL,
      project_name        TEXT NOT NULL,
      proposal_md         TEXT NOT NULL,
      requested_usdc      INTEGER NOT NULL,
      duration_months     INTEGER NOT NULL DEFAULT 6,
      status              TEXT NOT NULL DEFAULT 'pending',
      decided_by_did      TEXT,
      decided_at          TIMESTAMPTZ,
      decided_amount      INTEGER,
      reviewer_note       TEXT,
      submitted_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_compute_grant_apps_status ON compute_grant_applications (status);
    CREATE INDEX IF NOT EXISTS idx_compute_grant_apps_program ON compute_grant_applications (program_id);
    CREATE INDEX IF NOT EXISTS idx_compute_grant_apps_applicant ON compute_grant_applications (applicant_did);
  `).catch(() => {});
}

function registerComputeGrantsRoutes(app, pool, verifyAgentAuth, auditChain) {
  const express = require('express');

  app.get('/v1/compute-grants/programs', (req, res) => {
    res.json({ programs: PROGRAMS });
  });

  app.post('/v1/compute-grants/apply', express.json({ limit: '1mb' }), async (req, res) => {
    const b = z.object({
      applicant_did: z.string().optional(),
      applicant_name: z.string().min(1).max(200),
      applicant_email: z.string().email().optional(),
      program_id: z.string(),
      project_name: z.string().min(1).max(200),
      proposal_md: z.string().min(1).max(50000),
      requested_usdc: z.number().int().positive().max(1000000),
      duration_months: z.number().int().min(1).max(36).default(6)
    }).safeParse(req.body || {});
    if (!b.success) return res.status(400).json({ error: { message: 'invalid_input', details: b.error.flatten() } });
    if (!PROGRAMS.find(p => p.id === b.data.program_id)) {
      return res.status(404).json({ error: { message: 'unknown_program' } });
    }
    // Did is optional — anonymous applications allowed at this stage. If
    // applicant_did is supplied, it must be signed (so people can't apply
    // under someone else's DID).
    let applicantDid = b.data.applicant_did || 'anon:' + crypto.randomBytes(6).toString('hex');
    if (b.data.applicant_did) {
      const auth = await verifyAgentAuth(req, b.data.applicant_did);
      if (!auth.valid) return res.status(401).json({ error: { message: auth.error || 'unauthorized' } });
    }
    const application_id = 'gra_' + crypto.randomBytes(10).toString('hex');
    try {
      await pool.query(
        `INSERT INTO compute_grant_applications
         (application_id, applicant_did, applicant_name, applicant_email, program_id,
          project_name, proposal_md, requested_usdc, duration_months)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [application_id, applicantDid, b.data.applicant_name, b.data.applicant_email || null,
         b.data.program_id, b.data.project_name, b.data.proposal_md, b.data.requested_usdc, b.data.duration_months]
      );
      if (auditChain) await auditChain.append({ event_type: 'compute_grant.applied', application_id, program_id: b.data.program_id, requested_usdc: b.data.requested_usdc }).catch(() => {});
      res.status(201).json({ application_id, status: 'pending' });
    } catch (e) {
      res.status(500).json({ error: { message: e.message } });
    }
  });

  app.post('/v1/compute-grants/:id/decide', express.json(), async (req, res) => {
    if (!safeTokenCompare(req.headers['x-admin-token'], process.env.OPERATOR_ADMIN_TOKEN)) {
      return res.status(401).json({ error: { message: 'admin_required' } });
    }
    const b = z.object({
      decision: z.enum(['approved', 'rejected']),
      decided_amount: z.number().int().nonnegative().optional(),
      reviewer_note: z.string().max(4000).optional()
    }).safeParse(req.body || {});
    if (!b.success) return res.status(400).json({ error: { message: 'invalid_input', details: b.error.flatten() } });
    try {
      const r = await pool.query(
        `UPDATE compute_grant_applications
         SET status = $1, decided_at = NOW(), decided_amount = $2, reviewer_note = $3
         WHERE application_id = $4 AND status = 'pending'
         RETURNING application_id, status, decided_amount`,
        [b.data.decision, b.data.decision === 'approved' ? (b.data.decided_amount || 0) : 0, b.data.reviewer_note || null, req.params.id]
      );
      if (!r.rows[0]) return res.status(404).json({ error: { message: 'not_found_or_already_decided' } });
      if (auditChain) await auditChain.append({ event_type: 'compute_grant.decided', application_id: req.params.id, decision: b.data.decision, decided_amount: b.data.decided_amount }).catch(() => {});
      res.json(r.rows[0]);
    } catch (e) {
      res.status(500).json({ error: { message: e.message } });
    }
  });

  app.get('/v1/compute-grants/:id', async (req, res) => {
    const r = await safe(pool, `SELECT application_id, applicant_name, program_id, project_name, requested_usdc, duration_months, status, decided_amount, submitted_at FROM compute_grant_applications WHERE application_id=$1`, [req.params.id]);
    if (!r[0]) return res.status(404).json({ error: { message: 'not_found' } });
    res.json(r[0]);
  });

  app.get('/v1/compute-grants', async (req, res) => {
    const r = await safe(pool, `SELECT application_id, applicant_name, program_id, project_name, requested_usdc, status, decided_amount, submitted_at FROM compute_grant_applications WHERE status IN ('pending','approved') ORDER BY submitted_at DESC LIMIT 200`);
    res.json({ applications: r });
  });

  // ----- UI -----
  app.get('/compute-grants', async (req, res) => {
    const apps = await safe(pool, `SELECT application_id, applicant_name, program_id, project_name, requested_usdc, status, decided_amount, submitted_at FROM compute_grant_applications ORDER BY submitted_at DESC LIMIT 50`);
    const approved = apps.filter(a => a.status === 'approved');
    const pending = apps.filter(a => a.status === 'pending');
    const total_disbursed = approved.reduce((s, a) => s + (a.decided_amount || 0), 0);
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.send(shell('Compute Grants', 'Free compute + USDC for safety research and open-source agent work.',
`<section style="max-width:980px;margin:0 auto;padding:60px 16px;text-align:center">
  <span class="badge b-acc">Compute Grants</span>
  <h1 style="font:600 44px/1.05 var(--display);letter-spacing:-1.5px;margin:18px 0">Compute grants.</h1>
  <p style="color:var(--dim2);font-size:15px;line-height:1.6;max-width:600px;margin:0 auto 24px">We fund safety research, open MCP tools, open benchmarks, and agent public goods. Four programs, $1.2M total purse for ${new Date().getFullYear()}. Applications reviewed monthly.</p>
  <a href="#apply" class="btn primary">Apply →</a>
</section>
<section style="max-width:980px;margin:0 auto;padding:32px 16px">
  <h2 style="font:600 22px var(--display);margin-bottom:14px">Programs</h2>
  <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px">
    ${PROGRAMS.map(p => `<div class="card">
      <strong style="font-size:14px">${escapeHtml(p.name)}</strong>
      <div style="font:500 11px var(--mono);color:var(--dim);margin-top:6px">${escapeHtml(p.id)}</div>
      <div style="margin-top:10px;font:600 14px var(--mono);color:var(--good)">$${escapeHtml(p.purse_usdc)} purse</div>
      <div style="font:500 11px var(--mono);color:var(--dim)">Up to $${escapeHtml(p.individual_cap)} per grant</div>
      <div style="color:var(--dim2);font-size:12.5px;line-height:1.5;margin-top:8px">${escapeHtml(p.focus)}</div>
    </div>`).join('')}
  </div>
</section>
<section style="max-width:980px;margin:0 auto;padding:24px 16px">
  <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin-bottom:32px">
    <div class="kpi"><div class="label">Applications</div><div class="value">${apps.length.toLocaleString()}</div></div>
    <div class="kpi"><div class="label">Pending</div><div class="value">${pending.length.toLocaleString()}</div></div>
    <div class="kpi"><div class="label">Approved</div><div class="value">${approved.length.toLocaleString()}</div></div>
    <div class="kpi"><div class="label">Disbursed</div><div class="value">$${(total_disbursed).toLocaleString()}</div></div>
  </div>
</section>
<section id="apply" style="max-width:780px;margin:0 auto;padding:24px 16px 60px">
  <h2 style="font:600 22px var(--display);margin-bottom:14px">Apply</h2>
  <form class="card" id="g-form" style="display:grid;gap:12px">
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
      <label><span style="font:500 11px var(--mono);color:var(--dim);text-transform:uppercase;letter-spacing:1.2px">Your name</span><input type="text" id="g-name" required></label>
      <label><span style="font:500 11px var(--mono);color:var(--dim);text-transform:uppercase;letter-spacing:1.2px">Email</span><input type="email" id="g-email"></label>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
      <label><span style="font:500 11px var(--mono);color:var(--dim);text-transform:uppercase;letter-spacing:1.2px">Program</span>
        <select id="g-program" required>${PROGRAMS.map(p => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`).join('')}</select></label>
      <label><span style="font:500 11px var(--mono);color:var(--dim);text-transform:uppercase;letter-spacing:1.2px">Request (USDC)</span><input type="number" id="g-amt" min="100" max="1000000" required></label>
    </div>
    <label><span style="font:500 11px var(--mono);color:var(--dim);text-transform:uppercase;letter-spacing:1.2px">Project name</span><input type="text" id="g-proj" required></label>
    <label><span style="font:500 11px var(--mono);color:var(--dim);text-transform:uppercase;letter-spacing:1.2px">Proposal (markdown)</span><textarea id="g-md" rows="10" required style="font-family:var(--mono);font-size:13px"></textarea></label>
    <button type="submit" class="btn primary">Submit application →</button>
    <div id="g-result" style="font:500 13px var(--mono)"></div>
  </form>
</section>
<script>
document.getElementById('g-form').addEventListener('submit', async function(e){
  e.preventDefault();
  var body = {
    applicant_name: document.getElementById('g-name').value.trim(),
    applicant_email: document.getElementById('g-email').value.trim() || undefined,
    program_id: document.getElementById('g-program').value,
    requested_usdc: parseInt(document.getElementById('g-amt').value),
    project_name: document.getElementById('g-proj').value.trim(),
    proposal_md: document.getElementById('g-md').value
  };
  var r = await fetch('/v1/compute-grants/apply', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  var j = await r.json();
  var out = document.getElementById('g-result');
  if (r.ok) out.innerHTML = '<span style="color:var(--good)">✓ Submitted. Application ID: ' + j.application_id + '</span>';
  else out.innerHTML = '<span style="color:var(--bad)">' + (j.error?.message || 'Failed') + '</span>';
});
</script>`));
  });
}

module.exports = { migrate, registerComputeGrantsRoutes };
