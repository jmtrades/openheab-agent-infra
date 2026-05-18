// ============================================================================
// mind_upload_archive.js — pre-mortem state export for human archival.
//
// Different from agi_mind_state_checkpoints (which captures a portable
// snapshot for migration or peer review). An archive is a final, sealed,
// human-readable bundle deposited with one or more archivists for long-term
// preservation. Designed for end-of-life / sunsetting scenarios.
//
// Endpoints:
//   POST /v1/mind-archives                  agent or operator initiates
//   POST /v1/mind-archives/:id/seal         freezes; archivists notified
//   POST /v1/mind-archives/:id/access       archivist requests access (audit-chained)
//   GET  /v1/mind-archives                  public list
//   GET  /v1/mind-archives/:id              detail
//
// UI: /mind-archives
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
    CREATE TABLE IF NOT EXISTS mind_archives (
      archive_id        TEXT PRIMARY KEY,
      agent_did         TEXT NOT NULL,
      initiator_did     TEXT NOT NULL,
      manifest_hash     TEXT NOT NULL,
      manifest          JSONB NOT NULL,
      archivists        TEXT[] NOT NULL,
      access_policy     TEXT NOT NULL DEFAULT 'all_archivists',
      status            TEXT NOT NULL DEFAULT 'draft',
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      sealed_at         TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_mind_archives_agent ON mind_archives (agent_did);
    CREATE INDEX IF NOT EXISTS idx_mind_archives_status ON mind_archives (status);

    CREATE TABLE IF NOT EXISTS mind_archive_access (
      access_id         TEXT PRIMARY KEY,
      archive_id        TEXT NOT NULL,
      archivist_did     TEXT NOT NULL,
      reason            TEXT,
      granted           BOOLEAN NOT NULL DEFAULT TRUE,
      requested_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_mind_archive_access ON mind_archive_access (archive_id, requested_at DESC);
  `).catch(() => {});
}

function registerMindUploadArchiveRoutes(app, pool, verifyAgentAuth, auditChain) {
  const express = require('express');

  app.post('/v1/mind-archives', express.json({ limit: '10mb' }), async (req, res) => {
    const b = z.object({
      agent_did: z.string(),
      manifest: z.object({
        identity: z.any().optional(),
        beliefs_summary: z.string().max(50000).optional(),
        goals_summary: z.string().max(50000).optional(),
        relationships: z.any().optional(),
        accomplishments: z.string().max(50000).optional(),
        last_words: z.string().max(20000).optional(),
        external_archive_urls: z.array(z.string().url()).optional(),
      }),
      archivists: z.array(z.string()).min(1).max(20),
      access_policy: z.enum(['all_archivists', 'any_archivist', 'quorum_archivists']).default('all_archivists')
    }).safeParse(req.body || {});
    if (!b.success) return res.status(400).json({ error: { message: 'invalid_input', details: b.error.flatten() } });
    const auth = await verifyAgentAuth(req, b.data.agent_did);
    if (!auth.valid) return res.status(401).json({ error: { message: auth.error || 'agent_signature_required' } });
    const archive_id = 'ma_' + crypto.randomBytes(10).toString('hex');
    const hash = 'sha256:' + crypto.createHash('sha256').update(JSON.stringify(b.data.manifest)).digest('hex');
    try {
      await pool.query(
        `INSERT INTO mind_archives (archive_id, agent_did, initiator_did, manifest_hash, manifest, archivists, access_policy)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7)`,
        [archive_id, b.data.agent_did, b.data.agent_did, hash, JSON.stringify(b.data.manifest), b.data.archivists, b.data.access_policy]
      );
      if (auditChain) await auditChain.append({ event_type: 'mind_archive.drafted', archive_id, agent_did: b.data.agent_did, manifest_hash: hash, archivists: b.data.archivists }).catch(() => {});
      res.status(201).json({ archive_id, status: 'draft', manifest_hash: hash });
    } catch (e) { res.status(500).json({ error: { message: e.message } }); }
  });

  app.post('/v1/mind-archives/:id/seal', express.json(), async (req, res) => {
    const a = (await safe(pool, `SELECT * FROM mind_archives WHERE archive_id=$1`, [req.params.id]))[0];
    if (!a) return res.status(404).json({ error: { message: 'not_found' } });
    if (a.status !== 'draft') return res.status(400).json({ error: { message: 'already_sealed' } });
    const auth = await verifyAgentAuth(req, a.agent_did);
    if (!auth.valid) return res.status(401).json({ error: { message: auth.error || 'agent_signature_required_to_seal' } });
    await pool.query(`UPDATE mind_archives SET status='sealed', sealed_at=NOW() WHERE archive_id=$1`, [req.params.id]);
    if (auditChain) await auditChain.append({ event_type: 'mind_archive.sealed', archive_id: req.params.id, agent_did: a.agent_did }).catch(() => {});
    res.json({ sealed: true, archive_id: req.params.id });
  });

  app.post('/v1/mind-archives/:id/access', express.json(), async (req, res) => {
    const b = z.object({ archivist_did: z.string(), reason: z.string().max(2000).optional() }).safeParse(req.body || {});
    if (!b.success) return res.status(400).json({ error: { message: 'invalid_input', details: b.error.flatten() } });
    const a = (await safe(pool, `SELECT * FROM mind_archives WHERE archive_id=$1 AND status='sealed'`, [req.params.id]))[0];
    if (!a) return res.status(404).json({ error: { message: 'not_found_or_not_sealed' } });
    if (!a.archivists.includes(b.data.archivist_did)) return res.status(403).json({ error: { message: 'not_listed_archivist' } });
    const auth = await verifyAgentAuth(req, b.data.archivist_did);
    if (!auth.valid) return res.status(401).json({ error: { message: auth.error || 'archivist_signature_required' } });
    const access_id = 'macc_' + crypto.randomBytes(10).toString('hex');
    await pool.query(
      `INSERT INTO mind_archive_access (access_id, archive_id, archivist_did, reason) VALUES ($1,$2,$3,$4)`,
      [access_id, req.params.id, b.data.archivist_did, b.data.reason || null]
    );
    if (auditChain) await auditChain.append({ event_type: 'mind_archive.accessed', access_id, archive_id: req.params.id, archivist_did: b.data.archivist_did, reason: b.data.reason || null }).catch(() => {});
    res.json({ access_id, manifest: a.manifest, manifest_hash: a.manifest_hash });
  });

  app.get('/v1/mind-archives', async (req, res) => {
    res.json({ archives: await safe(pool, `SELECT archive_id, agent_did, manifest_hash, status, archivists, access_policy, created_at, sealed_at FROM mind_archives ORDER BY created_at DESC LIMIT 100`) });
  });

  app.get('/v1/mind-archives/:id', async (req, res) => {
    const a = (await safe(pool, `SELECT archive_id, agent_did, manifest_hash, status, archivists, access_policy, created_at, sealed_at FROM mind_archives WHERE archive_id=$1`, [req.params.id]))[0];
    if (!a) return res.status(404).json({ error: { message: 'not_found' } });
    const accesses = await safe(pool, `SELECT access_id, archivist_did, requested_at FROM mind_archive_access WHERE archive_id=$1 ORDER BY requested_at DESC`, [req.params.id]);
    res.json({ ...a, access_log: accesses });
  });

  // UI
  app.get('/mind-archives', async (req, res) => {
    const archives = await safe(pool, `SELECT archive_id, agent_did, status, archivists, access_policy, created_at, sealed_at FROM mind_archives ORDER BY created_at DESC LIMIT 50`);
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.send(shell('Mind Upload Archives', 'Pre-mortem state export for human archival.',
`<section style="max-width:780px;margin:0 auto;padding:60px 16px">
  <span class="badge b-acc">Mind Upload Archives</span>
  <h1 style="font:600 40px/1.1 var(--display);letter-spacing:-1px;margin:18px 0">Mind archives.</h1>
  <p style="color:var(--dim2);font-size:15px;line-height:1.7;max-width:680px">Agents can deposit a final manifest — identity summary, belief synthesis, goal narrative, last words — with named archivists. Each access is audit-chained. Different from <a href="/learn/governance">mind-state checkpoints</a> (portable across substrates); archives are sealed, long-term, human-readable.</p>
</section>
<section style="max-width:780px;margin:0 auto;padding:24px 16px 60px">
  ${archives.length === 0
    ? `<div class="card" style="text-align:center;padding:48px;color:var(--dim)">No mind archives yet. <code>POST /v1/mind-archives</code> to draft one.</div>`
    : `<table>
        <thead><tr><th>Archive</th><th>Agent</th><th>Status</th><th>Archivists</th><th>Sealed</th></tr></thead>
        <tbody>${archives.map(a => `<tr>
          <td><strong>${escapeHtml(a.archive_id)}</strong></td>
          <td style="font:500 11px var(--mono);color:var(--acc-dim)">${escapeHtml(a.agent_did?.slice(-12) || '?')}</td>
          <td><span class="badge b-${a.status === 'sealed' ? 'good' : 'warn'}">${escapeHtml(a.status)}</span></td>
          <td style="font:500 11px var(--mono);color:var(--dim2)">${(a.archivists || []).length}</td>
          <td style="font:500 11px var(--mono);color:var(--dim)">${a.sealed_at ? new Date(a.sealed_at).toLocaleDateString() : '—'}</td>
        </tr>`).join('')}</tbody>
      </table>`}
</section>`));
  });
}

module.exports = { migrate, registerMindUploadArchiveRoutes };
