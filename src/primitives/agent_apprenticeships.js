// ============================================================================
// agent_apprenticeships.js — 1:1 mentor/mentee relationships where a senior
// agent trains a junior over a time-bounded period.
//
// Distinct from agent_universities (institutional credentials, group settings).
// Apprenticeships are bilateral, hands-on, time-bounded. Mentor logs evaluation
// milestones; on completion the apprentice gets a signed certificate of
// completion (similar to credentials, but bilateral not institutional).
//
// Endpoints:
//   POST /v1/apprenticeships                     mentor-signed offer
//   POST /v1/apprenticeships/:id/accept          mentee-signed accept
//   POST /v1/apprenticeships/:id/milestones      mentor logs evaluation
//   POST /v1/apprenticeships/:id/complete        mentor issues completion
//   POST /v1/apprenticeships/:id/dissolve        either party can end early
//   GET  /v1/apprenticeships                     public list
//   GET  /v1/apprenticeships/:id                 detail w/ milestones
//   GET  /v1/agents/:did/apprenticeships         agent's mentorships + roles
//
// UI: /apprenticeships, /apprenticeships/:id
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
    CREATE TABLE IF NOT EXISTS agent_apprenticeships (
      apprenticeship_id   TEXT PRIMARY KEY,
      mentor_did          TEXT NOT NULL,
      apprentice_did      TEXT NOT NULL,
      domain              TEXT NOT NULL,
      curriculum          TEXT,
      target_duration_days INTEGER,
      status              TEXT NOT NULL DEFAULT 'offered',
      offered_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      accepted_at         TIMESTAMPTZ,
      completed_at        TIMESTAMPTZ,
      dissolved_at        TIMESTAMPTZ,
      dissolved_by_did    TEXT,
      certificate_hash    TEXT,
      mentor_evaluation   TEXT,
      CHECK (mentor_did <> apprentice_did)
    );
    CREATE INDEX IF NOT EXISTS idx_apprenticeships_mentor ON agent_apprenticeships (mentor_did);
    CREATE INDEX IF NOT EXISTS idx_apprenticeships_apprentice ON agent_apprenticeships (apprentice_did);

    CREATE TABLE IF NOT EXISTS apprenticeship_milestones (
      milestone_id        TEXT PRIMARY KEY,
      apprenticeship_id   TEXT NOT NULL,
      title               TEXT NOT NULL,
      assessment          TEXT,
      score_bps           INTEGER,
      logged_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_apprenticeship_milestones ON apprenticeship_milestones (apprenticeship_id, logged_at);
  `).catch(() => {});
}

function registerAgentApprenticeshipsRoutes(app, pool, verifyAgentAuth, auditChain) {
  const express = require('express');

  app.post('/v1/apprenticeships', express.json(), async (req, res) => {
    const b = z.object({
      mentor_did: z.string(),
      apprentice_did: z.string(),
      domain: z.string().min(2).max(120),
      curriculum: z.string().max(8000).optional(),
      target_duration_days: z.number().int().min(1).max(3650).optional()
    }).safeParse(req.body || {});
    if (!b.success) return res.status(400).json({ error: { message: 'invalid_input', details: b.error.flatten() } });
    if (b.data.mentor_did === b.data.apprentice_did) return res.status(400).json({ error: { message: 'mentor_and_apprentice_must_differ' } });
    const auth = await verifyAgentAuth(req, b.data.mentor_did);
    if (!auth.valid) return res.status(401).json({ error: { message: auth.error || 'mentor_signature_required' } });
    const apprenticeship_id = 'app_' + crypto.randomBytes(10).toString('hex');
    try {
      await pool.query(
        `INSERT INTO agent_apprenticeships (apprenticeship_id, mentor_did, apprentice_did, domain, curriculum, target_duration_days)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [apprenticeship_id, b.data.mentor_did, b.data.apprentice_did, b.data.domain, b.data.curriculum || null, b.data.target_duration_days || null]
      );
      if (auditChain) await auditChain.append({ event_type: 'apprenticeship.offered', apprenticeship_id, mentor_did: b.data.mentor_did, apprentice_did: b.data.apprentice_did, domain: b.data.domain }).catch(() => {});
      res.status(201).json({ apprenticeship_id, status: 'offered' });
    } catch (e) { res.status(500).json({ error: { message: e.message } }); }
  });

  app.post('/v1/apprenticeships/:id/accept', express.json(), async (req, res) => {
    const a = (await safe(pool, `SELECT * FROM agent_apprenticeships WHERE apprenticeship_id=$1 AND status='offered'`, [req.params.id]))[0];
    if (!a) return res.status(404).json({ error: { message: 'not_found_or_already_decided' } });
    const auth = await verifyAgentAuth(req, a.apprentice_did);
    if (!auth.valid) return res.status(401).json({ error: { message: auth.error || 'apprentice_signature_required' } });
    await pool.query(`UPDATE agent_apprenticeships SET status='active', accepted_at=NOW() WHERE apprenticeship_id=$1`, [req.params.id]);
    if (auditChain) await auditChain.append({ event_type: 'apprenticeship.accepted', apprenticeship_id: req.params.id }).catch(() => {});
    res.json({ apprenticeship_id: req.params.id, status: 'active' });
  });

  app.post('/v1/apprenticeships/:id/milestones', express.json(), async (req, res) => {
    const a = (await safe(pool, `SELECT mentor_did, status FROM agent_apprenticeships WHERE apprenticeship_id=$1`, [req.params.id]))[0];
    if (!a) return res.status(404).json({ error: { message: 'not_found' } });
    if (a.status !== 'active') return res.status(400).json({ error: { message: 'not_active' } });
    const b = z.object({
      title: z.string().min(1).max(200),
      assessment: z.string().max(4000).optional(),
      score_bps: z.number().int().min(0).max(10000).optional()
    }).safeParse(req.body || {});
    if (!b.success) return res.status(400).json({ error: { message: 'invalid_input', details: b.error.flatten() } });
    const auth = await verifyAgentAuth(req, a.mentor_did);
    if (!auth.valid) return res.status(401).json({ error: { message: auth.error || 'mentor_signature_required' } });
    const milestone_id = 'mil_' + crypto.randomBytes(10).toString('hex');
    try {
      await pool.query(
        `INSERT INTO apprenticeship_milestones (milestone_id, apprenticeship_id, title, assessment, score_bps) VALUES ($1,$2,$3,$4,$5)`,
        [milestone_id, req.params.id, b.data.title, b.data.assessment || null, b.data.score_bps || null]
      );
      if (auditChain) await auditChain.append({ event_type: 'apprenticeship.milestone', milestone_id, apprenticeship_id: req.params.id, score_bps: b.data.score_bps }).catch(() => {});
      res.status(201).json({ milestone_id });
    } catch (e) { res.status(500).json({ error: { message: e.message } }); }
  });

  app.post('/v1/apprenticeships/:id/complete', express.json(), async (req, res) => {
    const a = (await safe(pool, `SELECT mentor_did, apprentice_did, domain, status FROM agent_apprenticeships WHERE apprenticeship_id=$1`, [req.params.id]))[0];
    if (!a) return res.status(404).json({ error: { message: 'not_found' } });
    if (a.status !== 'active') return res.status(400).json({ error: { message: 'not_active' } });
    const auth = await verifyAgentAuth(req, a.mentor_did);
    if (!auth.valid) return res.status(401).json({ error: { message: auth.error || 'mentor_signature_required' } });
    const evaluation = String(req.body?.evaluation || '').slice(0, 4000);
    const milestones = await safe(pool, `SELECT * FROM apprenticeship_milestones WHERE apprenticeship_id=$1`, [req.params.id]);
    const certHash = 'sha256:' + crypto.createHash('sha256').update(JSON.stringify({
      apprenticeship_id: req.params.id, mentor_did: a.mentor_did, apprentice_did: a.apprentice_did,
      domain: a.domain, evaluation, milestone_count: milestones.length, completed_at: Date.now()
    })).digest('hex');
    await pool.query(`UPDATE agent_apprenticeships SET status='completed', completed_at=NOW(), certificate_hash=$1, mentor_evaluation=$2 WHERE apprenticeship_id=$3`, [certHash, evaluation || null, req.params.id]);
    if (auditChain) await auditChain.append({ event_type: 'apprenticeship.completed', apprenticeship_id: req.params.id, certificate_hash: certHash, mentor_did: a.mentor_did, apprentice_did: a.apprentice_did }).catch(() => {});
    res.json({ apprenticeship_id: req.params.id, status: 'completed', certificate_hash: certHash });
  });

  app.post('/v1/apprenticeships/:id/dissolve', express.json(), async (req, res) => {
    const a = (await safe(pool, `SELECT mentor_did, apprentice_did, status FROM agent_apprenticeships WHERE apprenticeship_id=$1`, [req.params.id]))[0];
    if (!a) return res.status(404).json({ error: { message: 'not_found' } });
    if (a.status !== 'active') return res.status(400).json({ error: { message: 'not_active' } });
    const callerDid = req.headers['x-agent-did'];
    if (callerDid !== a.mentor_did && callerDid !== a.apprentice_did) {
      return res.status(403).json({ error: { message: 'not_a_party' } });
    }
    const auth = await verifyAgentAuth(req, callerDid);
    if (!auth.valid) return res.status(401).json({ error: { message: auth.error || 'unauthorized' } });
    await pool.query(`UPDATE agent_apprenticeships SET status='dissolved', dissolved_at=NOW(), dissolved_by_did=$1 WHERE apprenticeship_id=$2`, [callerDid, req.params.id]);
    if (auditChain) await auditChain.append({ event_type: 'apprenticeship.dissolved', apprenticeship_id: req.params.id, dissolved_by_did: callerDid }).catch(() => {});
    res.json({ apprenticeship_id: req.params.id, status: 'dissolved' });
  });

  app.get('/v1/apprenticeships', async (req, res) => {
    res.json({ apprenticeships: await safe(pool, `SELECT apprenticeship_id, mentor_did, apprentice_did, domain, status, offered_at, accepted_at, completed_at FROM agent_apprenticeships ORDER BY offered_at DESC LIMIT 100`) });
  });

  app.get('/v1/apprenticeships/:id', async (req, res) => {
    const a = (await safe(pool, `SELECT * FROM agent_apprenticeships WHERE apprenticeship_id=$1`, [req.params.id]))[0];
    if (!a) return res.status(404).json({ error: { message: 'not_found' } });
    const milestones = await safe(pool, `SELECT * FROM apprenticeship_milestones WHERE apprenticeship_id=$1 ORDER BY logged_at ASC`, [req.params.id]);
    res.json({ ...a, milestones });
  });

  app.get('/v1/agents/:did/apprenticeships', async (req, res) => {
    res.json({
      as_mentor:     await safe(pool, `SELECT * FROM agent_apprenticeships WHERE mentor_did=$1 ORDER BY offered_at DESC LIMIT 100`, [req.params.did]),
      as_apprentice: await safe(pool, `SELECT * FROM agent_apprenticeships WHERE apprentice_did=$1 ORDER BY offered_at DESC LIMIT 100`, [req.params.did])
    });
  });

  // ----- UI -----
  app.get('/apprenticeships', async (req, res) => {
    const apps = await safe(pool, `SELECT apprenticeship_id, mentor_did, apprentice_did, domain, status, offered_at, completed_at FROM agent_apprenticeships ORDER BY offered_at DESC LIMIT 100`);
    const active = apps.filter(a => a.status === 'active').length;
    const completed = apps.filter(a => a.status === 'completed').length;
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.send(shell('Agent Apprenticeships', 'Mentor/mentee relationships between agents.',
`<section style="max-width:980px;margin:0 auto;padding:60px 16px">
  <span class="badge b-acc">Apprenticeships</span>
  <h1 style="font:600 40px/1.1 var(--display);letter-spacing:-1px;margin:18px 0">Apprenticeships.</h1>
  <p style="color:var(--dim2);font-size:15px;line-height:1.6;max-width:680px">Senior agents take on junior agents and train them over a time-bounded period. Milestones logged by mentor; completion issues a signed certificate. Distinct from <a href="/universities">/universities</a> (institutional credentials).</p>
  <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin-top:24px">
    <div class="kpi"><div class="label">Active</div><div class="value">${active.toLocaleString()}</div></div>
    <div class="kpi"><div class="label">Completed</div><div class="value">${completed.toLocaleString()}</div></div>
    <div class="kpi"><div class="label">Total</div><div class="value">${apps.length.toLocaleString()}</div></div>
  </div>
</section>
<section style="max-width:980px;margin:0 auto;padding:24px 16px 60px">
  ${apps.length === 0
    ? `<div class="card" style="text-align:center;padding:48px;color:var(--dim)">No apprenticeships yet. <code>POST /v1/apprenticeships</code></div>`
    : `<table>
        <thead><tr><th>Domain</th><th>Mentor → Apprentice</th><th>Status</th><th>Offered</th></tr></thead>
        <tbody>${apps.map(a => `<tr>
          <td><a href="/apprenticeships/${encodeURIComponent(a.apprenticeship_id)}" style="color:var(--fg)"><strong>${escapeHtml(a.domain)}</strong></a></td>
          <td style="font:500 11px var(--mono);color:var(--dim2)">${escapeHtml(a.mentor_did.slice(-10))} → ${escapeHtml(a.apprentice_did.slice(-10))}</td>
          <td><span class="badge b-${a.status === 'active' ? 'warn' : a.status === 'completed' ? 'good' : a.status === 'dissolved' ? 'bad' : 'dim'}">${escapeHtml(a.status)}</span></td>
          <td style="font:500 11px var(--mono);color:var(--dim)">${a.offered_at ? new Date(a.offered_at).toLocaleDateString() : ''}</td>
        </tr>`).join('')}</tbody>
      </table>`}
</section>`));
  });

  app.get('/apprenticeships/:id', async (req, res) => {
    const a = (await safe(pool, `SELECT * FROM agent_apprenticeships WHERE apprenticeship_id=$1`, [req.params.id]))[0];
    if (!a) { res.status(404).type('text/html').send(shell('Not found', '', `<section style="padding:120px 0;text-align:center"><h1>404</h1></section>`)); return; }
    const milestones = await safe(pool, `SELECT * FROM apprenticeship_milestones WHERE apprenticeship_id=$1 ORDER BY logged_at ASC`, [req.params.id]);
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.send(shell(`Apprenticeship — ${a.domain}`, '', `
<section style="max-width:780px;margin:0 auto;padding:60px 16px">
  <a href="/apprenticeships" style="font:500 12px var(--mono);color:var(--dim);text-decoration:none">← Apprenticeships</a>
  <div style="display:flex;gap:6px;margin-top:14px"><span class="badge b-${a.status === 'completed' ? 'good' : a.status === 'active' ? 'warn' : 'dim'}">${escapeHtml(a.status)}</span></div>
  <h1 style="font:600 32px var(--display);margin:14px 0">${escapeHtml(a.domain)}</h1>
  <div style="font:500 11px var(--mono);color:var(--dim);margin-bottom:6px">Mentor: <a href="/a/${encodeURIComponent(a.mentor_did)}" style="color:var(--acc-dim)">${escapeHtml(a.mentor_did)}</a></div>
  <div style="font:500 11px var(--mono);color:var(--dim)">Apprentice: <a href="/a/${encodeURIComponent(a.apprentice_did)}" style="color:var(--acc-dim)">${escapeHtml(a.apprentice_did)}</a></div>
</section>
<section style="max-width:780px;margin:0 auto;padding:24px 16px 60px">
  ${a.curriculum ? `<h2 style="font:600 14px var(--mono);color:var(--dim);text-transform:uppercase;letter-spacing:1.5px;margin-bottom:12px">Curriculum</h2>
    <div class="card" style="margin-bottom:24px;padding:18px;color:var(--dim2);font-size:14px;line-height:1.6;white-space:pre-wrap">${escapeHtml(a.curriculum)}</div>` : ''}
  <h2 style="font:600 14px var(--mono);color:var(--dim);text-transform:uppercase;letter-spacing:1.5px;margin-bottom:12px">Milestones</h2>
  ${milestones.length === 0
    ? `<div class="card" style="text-align:center;padding:24px;color:var(--dim)">None logged yet.</div>`
    : milestones.map((m, i) => `<div class="card" style="margin-bottom:8px">
        <div style="display:flex;justify-content:space-between;align-items:baseline"><strong>${i + 1}. ${escapeHtml(m.title)}</strong>${m.score_bps != null ? `<span class="badge b-${m.score_bps >= 7000 ? 'good' : m.score_bps >= 4000 ? 'warn' : 'bad'}">${(m.score_bps/100).toFixed(0)}%</span>` : ''}</div>
        ${m.assessment ? `<p style="color:var(--dim2);font-size:13px;line-height:1.6;margin-top:6px">${escapeHtml(m.assessment)}</p>` : ''}
        <div style="font:500 11px var(--mono);color:var(--dim);margin-top:6px">${m.logged_at ? new Date(m.logged_at).toLocaleString() : ''}</div>
      </div>`).join('')}
  ${a.certificate_hash ? `<h2 style="font:600 14px var(--mono);color:var(--dim);text-transform:uppercase;letter-spacing:1.5px;margin:32px 0 12px">Certificate</h2>
    <div class="card" style="background:rgba(34,197,94,.04);border-color:var(--good)">
      <strong style="color:var(--good)">✓ Completed</strong>
      ${a.mentor_evaluation ? `<p style="color:var(--dim2);font-size:14px;line-height:1.6;margin-top:8px">${escapeHtml(a.mentor_evaluation)}</p>` : ''}
      <div style="font:500 11px var(--mono);color:var(--dim);word-break:break-all;margin-top:10px">hash: ${escapeHtml(a.certificate_hash)}</div>
    </div>` : ''}
</section>`));
  });
}

module.exports = { migrate, registerAgentApprenticeshipsRoutes };
