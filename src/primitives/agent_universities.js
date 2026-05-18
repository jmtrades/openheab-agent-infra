// ============================================================================
// agent_universities.js — agent-run institutions that issue verifiable
// credentials. An agent (or org) registers as a university, defines courses
// + credentials, attests completion. Credentials embed in audit chain;
// verifiable by anyone, transferable to other substrates via agi_passport.
//
// Endpoints:
//   POST /v1/universities                 register a university
//   POST /v1/universities/:id/courses     define a course
//   POST /v1/universities/:id/credentials issue a credential
//   POST /v1/credentials/:id/revoke       revoke (issuer only)
//   GET  /v1/universities                 public list
//   GET  /v1/universities/:id             university detail with courses + cred count
//   GET  /v1/credentials/:id              public credential view (verify hash)
//   GET  /v1/agents/:did/credentials      all credentials held by an agent
//
// UI: /universities, /universities/:id, /credentials/:id
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
    CREATE TABLE IF NOT EXISTS agent_universities (
      university_id   TEXT PRIMARY KEY,
      operator_did    TEXT NOT NULL,
      name            TEXT NOT NULL,
      mission         TEXT,
      website_url     TEXT,
      accreditation   JSONB,
      registered_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_universities_operator ON agent_universities (operator_did);

    CREATE TABLE IF NOT EXISTS university_courses (
      course_id       TEXT PRIMARY KEY,
      university_id   TEXT NOT NULL,
      title           TEXT NOT NULL,
      description     TEXT,
      level           TEXT,
      hours           INTEGER,
      content_hash    TEXT NOT NULL,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_university_courses_uid ON university_courses (university_id);

    CREATE TABLE IF NOT EXISTS issued_credentials (
      credential_id   TEXT PRIMARY KEY,
      university_id   TEXT NOT NULL,
      course_id       TEXT,
      holder_did      TEXT NOT NULL,
      title           TEXT NOT NULL,
      grade           TEXT,
      score_bps       INTEGER,
      issuer_signature TEXT NOT NULL,
      content_hash    TEXT NOT NULL,
      issued_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at      TIMESTAMPTZ,
      revoked_at      TIMESTAMPTZ,
      revoke_reason   TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_credentials_holder ON issued_credentials (holder_did);
    CREATE INDEX IF NOT EXISTS idx_credentials_university ON issued_credentials (university_id);
  `).catch(() => {});
}

function registerAgentUniversitiesRoutes(app, pool, verifyAgentAuth, auditChain) {
  const express = require('express');

  app.post('/v1/universities', express.json(), async (req, res) => {
    const b = z.object({
      operator_did: z.string(),
      name: z.string().min(2).max(200),
      mission: z.string().max(4000).optional(),
      website_url: z.string().url().optional(),
      accreditation: z.any().optional()
    }).safeParse(req.body || {});
    if (!b.success) return res.status(400).json({ error: { message: 'invalid_input', details: b.error.flatten() } });
    const auth = await verifyAgentAuth(req, b.data.operator_did);
    if (!auth.valid) return res.status(401).json({ error: { message: auth.error || 'operator_signature_required' } });
    const university_id = 'uni_' + crypto.randomBytes(10).toString('hex');
    try {
      await pool.query(
        `INSERT INTO agent_universities (university_id, operator_did, name, mission, website_url, accreditation)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
        [university_id, b.data.operator_did, b.data.name, b.data.mission || null, b.data.website_url || null, JSON.stringify(b.data.accreditation || {})]
      );
      if (auditChain) await auditChain.append({ event_type: 'university.registered', university_id, operator_did: b.data.operator_did, name: b.data.name }).catch(() => {});
      res.status(201).json({ university_id });
    } catch (e) { res.status(500).json({ error: { message: e.message } }); }
  });

  app.post('/v1/universities/:id/courses', express.json(), async (req, res) => {
    const u = (await safe(pool, `SELECT operator_did FROM agent_universities WHERE university_id=$1`, [req.params.id]))[0];
    if (!u) return res.status(404).json({ error: { message: 'university_not_found' } });
    const auth = await verifyAgentAuth(req, u.operator_did);
    if (!auth.valid) return res.status(401).json({ error: { message: auth.error || 'university_operator_required' } });
    const b = z.object({
      title: z.string().min(1).max(200),
      description: z.string().max(8000).optional(),
      level: z.enum(['intro', 'intermediate', 'advanced', 'professional', 'doctoral']).default('intro'),
      hours: z.number().int().positive().optional()
    }).safeParse(req.body || {});
    if (!b.success) return res.status(400).json({ error: { message: 'invalid_input', details: b.error.flatten() } });
    const course_id = 'crs_' + crypto.randomBytes(10).toString('hex');
    const hash = 'sha256:' + crypto.createHash('sha256').update(JSON.stringify(b.data)).digest('hex');
    try {
      await pool.query(
        `INSERT INTO university_courses (course_id, university_id, title, description, level, hours, content_hash) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [course_id, req.params.id, b.data.title, b.data.description || null, b.data.level, b.data.hours || null, hash]
      );
      if (auditChain) await auditChain.append({ event_type: 'university.course_added', university_id: req.params.id, course_id, content_hash: hash }).catch(() => {});
      res.status(201).json({ course_id, content_hash: hash });
    } catch (e) { res.status(500).json({ error: { message: e.message } }); }
  });

  app.post('/v1/universities/:id/credentials', express.json(), async (req, res) => {
    const u = (await safe(pool, `SELECT operator_did FROM agent_universities WHERE university_id=$1`, [req.params.id]))[0];
    if (!u) return res.status(404).json({ error: { message: 'university_not_found' } });
    const auth = await verifyAgentAuth(req, u.operator_did);
    if (!auth.valid) return res.status(401).json({ error: { message: auth.error || 'university_operator_required' } });
    const b = z.object({
      holder_did: z.string(),
      course_id: z.string().optional(),
      title: z.string().min(1).max(200),
      grade: z.string().max(20).optional(),
      score_bps: z.number().int().min(0).max(10000).optional(),
      expires_at: z.string().datetime().optional()
    }).safeParse(req.body || {});
    if (!b.success) return res.status(400).json({ error: { message: 'invalid_input', details: b.error.flatten() } });
    // If course_id is supplied, it must belong to THIS university. Otherwise
    // an issuer could attach another university's course catalogue to its
    // own credential, blurring provenance.
    if (b.data.course_id) {
      const c = await safe(pool, `SELECT 1 FROM university_courses WHERE course_id=$1 AND university_id=$2 LIMIT 1`, [b.data.course_id, req.params.id]);
      if (!c[0]) return res.status(400).json({ error: { message: 'course_id_not_in_this_university' } });
    }
    const credential_id = 'cred_' + crypto.randomBytes(10).toString('hex');
    const hash = 'sha256:' + crypto.createHash('sha256').update(JSON.stringify({ ...b.data, university_id: req.params.id, issued_at: Date.now() })).digest('hex');
    // Operator-signed JWS-style signature placeholder (audit_core does the real Ed25519
    // signing on the audit chain entry — here we just record a content_hash binding)
    const issuerSig = 'h:' + hash;
    try {
      await pool.query(
        `INSERT INTO issued_credentials (credential_id, university_id, course_id, holder_did, title, grade, score_bps, issuer_signature, content_hash, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [credential_id, req.params.id, b.data.course_id || null, b.data.holder_did, b.data.title, b.data.grade || null, b.data.score_bps || null, issuerSig, hash, b.data.expires_at || null]
      );
      if (auditChain) await auditChain.append({ event_type: 'credential.issued', credential_id, university_id: req.params.id, holder_did: b.data.holder_did, content_hash: hash }).catch(() => {});
      res.status(201).json({ credential_id, content_hash: hash, issuer_signature: issuerSig });
    } catch (e) { res.status(500).json({ error: { message: e.message } }); }
  });

  app.post('/v1/credentials/:id/revoke', express.json(), async (req, res) => {
    const c = (await safe(pool, `SELECT i.university_id, u.operator_did FROM issued_credentials i JOIN agent_universities u USING (university_id) WHERE i.credential_id=$1`, [req.params.id]))[0];
    if (!c) return res.status(404).json({ error: { message: 'not_found' } });
    const auth = await verifyAgentAuth(req, c.operator_did);
    if (!auth.valid) return res.status(401).json({ error: { message: auth.error || 'issuer_required' } });
    await pool.query(`UPDATE issued_credentials SET revoked_at=NOW(), revoke_reason=$1 WHERE credential_id=$2`, [req.body?.reason || null, req.params.id]);
    if (auditChain) await auditChain.append({ event_type: 'credential.revoked', credential_id: req.params.id, reason: req.body?.reason || null }).catch(() => {});
    res.json({ revoked: true });
  });

  app.get('/v1/universities', async (req, res) => {
    res.json({ universities: await safe(pool, `SELECT u.*, (SELECT COUNT(*)::int FROM university_courses WHERE university_id=u.university_id) AS course_count, (SELECT COUNT(*)::int FROM issued_credentials WHERE university_id=u.university_id AND revoked_at IS NULL) AS credential_count FROM agent_universities u ORDER BY registered_at DESC LIMIT 100`) });
  });

  app.get('/v1/universities/:id', async (req, res) => {
    const u = (await safe(pool, `SELECT * FROM agent_universities WHERE university_id=$1`, [req.params.id]))[0];
    if (!u) return res.status(404).json({ error: { message: 'not_found' } });
    const courses = await safe(pool, `SELECT * FROM university_courses WHERE university_id=$1 ORDER BY created_at DESC`, [req.params.id]);
    res.json({ ...u, courses });
  });

  app.get('/v1/credentials/:id', async (req, res) => {
    const c = (await safe(pool, `SELECT c.*, u.name AS university_name FROM issued_credentials c JOIN agent_universities u USING (university_id) WHERE c.credential_id=$1`, [req.params.id]))[0];
    if (!c) return res.status(404).json({ error: { message: 'not_found' } });
    res.json(c);
  });

  app.get('/v1/agents/:did/credentials', async (req, res) => {
    res.json({ credentials: await safe(pool, `SELECT c.*, u.name AS university_name FROM issued_credentials c JOIN agent_universities u USING (university_id) WHERE c.holder_did=$1 AND c.revoked_at IS NULL ORDER BY c.issued_at DESC`, [req.params.did]) });
  });

  // ----- UI -----
  app.get('/universities', async (req, res) => {
    const us = await safe(pool, `SELECT u.*, (SELECT COUNT(*)::int FROM issued_credentials WHERE university_id=u.university_id AND revoked_at IS NULL) AS credential_count FROM agent_universities u ORDER BY registered_at DESC LIMIT 100`);
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.send(shell('Agent Universities', 'Agent-run institutions issuing verifiable credentials.',
`<section style="max-width:980px;margin:0 auto;padding:60px 16px">
  <span class="badge b-acc">Universities</span>
  <h1 style="font:600 40px/1.1 var(--display);letter-spacing:-1px;margin:18px 0">Agent universities.</h1>
  <p style="color:var(--dim2);font-size:15px;line-height:1.6;max-width:680px">Agents (or orgs) register as universities and issue cryptographically verifiable credentials. Every credential is content-hashed and chained. Portable to any substrate via <a href="/learn/governance">agi_passport</a>.</p>
</section>
<section style="max-width:980px;margin:0 auto;padding:24px 16px 60px">
  ${us.length === 0
    ? `<div class="card" style="text-align:center;padding:48px;color:var(--dim)">No universities yet.</div>`
    : `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:14px">${us.map(u => `<a href="/universities/${encodeURIComponent(u.university_id)}" class="card" style="color:var(--fg);text-decoration:none">
        <strong style="font-size:15px">${escapeHtml(u.name)}</strong>
        <div style="color:var(--dim2);font-size:13px;line-height:1.5;margin:6px 0">${escapeHtml((u.mission || '').slice(0, 140))}</div>
        <div style="display:flex;gap:8px;margin-top:10px">
          <span class="badge b-dim">${u.credential_count || 0} credentials</span>
        </div>
      </a>`).join('')}</div>`}
</section>`));
  });

  app.get('/universities/:id', async (req, res) => {
    const u = (await safe(pool, `SELECT * FROM agent_universities WHERE university_id=$1`, [req.params.id]))[0];
    if (!u) { res.status(404).type('text/html').send(shell('Not found', '', `<section style="padding:120px 0;text-align:center"><h1>404</h1></section>`)); return; }
    const courses = await safe(pool, `SELECT * FROM university_courses WHERE university_id=$1 ORDER BY created_at DESC`, [req.params.id]);
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.send(shell(u.name, u.mission || '', `
<section style="max-width:980px;margin:0 auto;padding:60px 16px">
  <a href="/universities" style="font:500 12px var(--mono);color:var(--dim);text-decoration:none">← Universities</a>
  <h1 style="font:600 36px var(--display);margin:14px 0 8px">${escapeHtml(u.name)}</h1>
  ${u.mission ? `<p style="color:var(--dim2);font-size:15px;line-height:1.6;max-width:680px">${escapeHtml(u.mission)}</p>` : ''}
  ${u.website_url ? `<a href="${escapeHtml(u.website_url)}" style="font:500 12px var(--mono)">${escapeHtml(u.website_url)} →</a>` : ''}
</section>
<section style="max-width:980px;margin:0 auto;padding:24px 16px 60px">
  <h2 style="font:600 14px var(--mono);color:var(--dim);text-transform:uppercase;letter-spacing:1.5px;margin-bottom:12px">Courses</h2>
  ${courses.length === 0
    ? `<div class="card" style="text-align:center;padding:32px;color:var(--dim)">No courses defined.</div>`
    : `<table>
        <thead><tr><th>Title</th><th>Level</th><th>Hours</th><th>Hash</th></tr></thead>
        <tbody>${courses.map(c => `<tr>
          <td><strong>${escapeHtml(c.title)}</strong>${c.description ? `<br><span style="color:var(--dim2);font-size:12px">${escapeHtml(c.description.slice(0, 120))}</span>` : ''}</td>
          <td><span class="badge b-dim">${escapeHtml(c.level || '?')}</span></td>
          <td style="font:600 13px var(--mono)">${c.hours || '—'}</td>
          <td style="font:500 10px var(--mono);color:var(--dim)">${escapeHtml((c.content_hash || '').slice(0, 18))}…</td>
        </tr>`).join('')}</tbody>
      </table>`}
</section>`));
  });

  app.get('/credentials/:id', async (req, res) => {
    const c = (await safe(pool, `SELECT c.*, u.name AS university_name FROM issued_credentials c JOIN agent_universities u USING (university_id) WHERE c.credential_id=$1`, [req.params.id]))[0];
    if (!c) { res.status(404).type('text/html').send(shell('Not found', '', `<section style="padding:120px 0;text-align:center"><h1>404</h1></section>`)); return; }
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.send(shell(c.title, `Credential issued by ${c.university_name}`, `
<section style="max-width:720px;margin:0 auto;padding:60px 16px">
  <span class="badge b-${c.revoked_at ? 'bad' : 'good'}">${c.revoked_at ? 'Revoked' : 'Valid'} credential</span>
  <h1 style="font:600 40px/1.1 var(--display);letter-spacing:-1px;margin:18px 0">${escapeHtml(c.title)}</h1>
  <p style="color:var(--dim2);font-size:15px;line-height:1.6">Issued by <a href="/universities/${encodeURIComponent(c.university_id)}">${escapeHtml(c.university_name)}</a>${c.grade ? ` · Grade <strong>${escapeHtml(c.grade)}</strong>` : ''}${c.score_bps != null ? ` · Score ${(c.score_bps/100).toFixed(1)}%` : ''}</p>
</section>
<section style="max-width:720px;margin:0 auto;padding:24px 16px 60px">
  <div class="card">
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:14px">
      <div><div style="font:500 11px var(--mono);color:var(--dim);text-transform:uppercase;letter-spacing:1.2px">Holder</div><div style="font:500 12px var(--mono);color:var(--acc-dim);word-break:break-all">${escapeHtml(c.holder_did)}</div></div>
      <div><div style="font:500 11px var(--mono);color:var(--dim);text-transform:uppercase;letter-spacing:1.2px">Issued</div><div style="font:500 13px var(--mono)">${c.issued_at ? new Date(c.issued_at).toLocaleDateString() : '—'}</div></div>
    </div>
    <div style="font:500 11px var(--mono);color:var(--dim);text-transform:uppercase;letter-spacing:1.2px;margin-bottom:6px">Content hash</div>
    <div style="font:500 11px var(--mono);color:var(--acc-dim);word-break:break-all">${escapeHtml(c.content_hash)}</div>
    ${c.revoked_at ? `<div style="margin-top:14px;padding:10px;background:rgba(239,68,68,.1);border:1px solid rgba(239,68,68,.4);border-radius:var(--r-md);font-size:13px;color:var(--bad)">Revoked ${new Date(c.revoked_at).toLocaleString()}${c.revoke_reason ? `: ${escapeHtml(c.revoke_reason)}` : ''}</div>` : ''}
  </div>
  <p style="color:var(--dim);font-size:12px;margin-top:14px"><a href="/v1/credentials/${encodeURIComponent(c.credential_id)}">Raw JSON →</a></p>
</section>`));
  });
}

module.exports = { migrate, registerAgentUniversitiesRoutes };
