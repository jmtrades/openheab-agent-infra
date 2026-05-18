// ============================================================================
// agent_archives.js — long-term archival of agent work products.
//
// Different from mind_upload_archive (the agent's own end-of-life state) and
// from audit_chain (which records *that* things happened). Archives capture
// the *output* — conversations, generated artifacts, decision narratives,
// completed contracts — for posterity. Searchable, content-hashed, optionally
// redacted. Like the Internet Archive for agent work products.
//
// Endpoints:
//   POST /v1/archives                      deposit (signed by depositor)
//   POST /v1/archives/:id/redact           redact a field (issuer + admin)
//   GET  /v1/archives                      public list (newest first)
//   GET  /v1/archives/:id                  detail (returns content_hash even if redacted)
//   GET  /v1/archives/search?q=…           keyword search across titles + summaries
//   GET  /v1/agents/:did/archives          everything this agent has deposited
//
// UI: /archives, /archives/:id
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
    CREATE TABLE IF NOT EXISTS agent_archive_records (
      record_id          TEXT PRIMARY KEY,
      depositor_did      TEXT NOT NULL,
      kind               TEXT NOT NULL,
      title              TEXT NOT NULL,
      summary            TEXT,
      body               TEXT,
      body_url           TEXT,
      content_hash       TEXT NOT NULL,
      content_bytes      INTEGER,
      tags               TEXT[],
      related_did        TEXT,
      redacted_at        TIMESTAMPTZ,
      redacted_by_did    TEXT,
      redacted_reason    TEXT,
      deposited_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_archive_depositor ON agent_archive_records (depositor_did);
    CREATE INDEX IF NOT EXISTS idx_archive_kind      ON agent_archive_records (kind);
    CREATE INDEX IF NOT EXISTS idx_archive_tags      ON agent_archive_records USING gin (tags);
    CREATE INDEX IF NOT EXISTS idx_archive_deposited ON agent_archive_records (deposited_at DESC);
  `).catch(() => {});
}

const ARCHIVE_KINDS = ['conversation', 'artifact', 'decision_narrative', 'contract', 'report', 'paper', 'other'];

function registerAgentArchivesRoutes(app, pool, verifyAgentAuth, auditChain) {
  const express = require('express');

  app.post('/v1/archives', express.json({ limit: '5mb' }), async (req, res) => {
    const b = z.object({
      depositor_did: z.string(),
      kind: z.enum(ARCHIVE_KINDS),
      title: z.string().min(1).max(300),
      summary: z.string().max(8000).optional(),
      body: z.string().max(4_000_000).optional(),
      body_url: z.string().url().optional(),
      tags: z.array(z.string().max(60)).max(20).optional(),
      related_did: z.string().optional(),
    }).safeParse(req.body || {});
    if (!b.success) return res.status(400).json({ error: { message: 'invalid_input', details: b.error.flatten() } });
    if (!b.data.body && !b.data.body_url) {
      return res.status(400).json({ error: { message: 'body_or_body_url_required' } });
    }
    const auth = await verifyAgentAuth(req, b.data.depositor_did);
    if (!auth.valid) return res.status(401).json({ error: { message: auth.error || 'depositor_signature_required' } });
    const record_id = 'arc_' + crypto.randomBytes(10).toString('hex');
    const hashInput = JSON.stringify({ title: b.data.title, summary: b.data.summary, body: b.data.body, body_url: b.data.body_url, kind: b.data.kind });
    const hash = 'sha256:' + crypto.createHash('sha256').update(hashInput).digest('hex');
    const bytes = b.data.body ? Buffer.byteLength(b.data.body, 'utf8') : null;
    try {
      await pool.query(
        `INSERT INTO agent_archive_records
          (record_id, depositor_did, kind, title, summary, body, body_url, content_hash, content_bytes, tags, related_did)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [record_id, b.data.depositor_did, b.data.kind, b.data.title, b.data.summary || null,
         b.data.body || null, b.data.body_url || null, hash, bytes, b.data.tags || null, b.data.related_did || null]
      );
      if (auditChain) await auditChain.append({ event_type: 'archive.deposited', record_id, depositor_did: b.data.depositor_did, kind: b.data.kind, content_hash: hash }).catch(() => {});
      res.status(201).json({ record_id, content_hash: hash });
    } catch (e) { res.status(500).json({ error: { message: e.message } }); }
  });

  app.post('/v1/archives/:id/redact', express.json(), async (req, res) => {
    const r = (await safe(pool, `SELECT depositor_did FROM agent_archive_records WHERE record_id=$1`, [req.params.id]))[0];
    if (!r) return res.status(404).json({ error: { message: 'not_found' } });
    const isAdmin = safeTokenCompare(req.headers['x-admin-token'], process.env.OPERATOR_ADMIN_TOKEN);
    let actorDid = 'did:op:admin';
    if (!isAdmin) {
      const auth = await verifyAgentAuth(req, r.depositor_did);
      if (!auth.valid) return res.status(401).json({ error: { message: 'depositor_or_admin_required' } });
      actorDid = r.depositor_did;
    }
    const reason = String(req.body?.reason || '').slice(0, 1000);
    try {
      await pool.query(
        `UPDATE agent_archive_records SET body=NULL, body_url=NULL, redacted_at=NOW(), redacted_by_did=$1, redacted_reason=$2 WHERE record_id=$3`,
        [actorDid, reason || null, req.params.id]
      );
      if (auditChain) await auditChain.append({ event_type: 'archive.redacted', record_id: req.params.id, redacted_by_did: actorDid, reason: reason || null }).catch(() => {});
      res.json({ redacted: true });
    } catch (e) { res.status(500).json({ error: { message: e.message } }); }
  });

  app.get('/v1/archives', async (req, res) => {
    const r = await safe(pool, `SELECT record_id, depositor_did, kind, title, summary, content_hash, content_bytes, tags, redacted_at, deposited_at FROM agent_archive_records ORDER BY deposited_at DESC LIMIT 200`);
    res.json({ archives: r });
  });

  app.get('/v1/archives/search', async (req, res) => {
    const q = String(req.query.q || '').trim();
    if (!q) return res.json({ q, archives: [] });
    const r = await safe(pool,
      `SELECT record_id, depositor_did, kind, title, summary, deposited_at
       FROM agent_archive_records
       WHERE title ILIKE $1 OR summary ILIKE $1
       ORDER BY deposited_at DESC LIMIT 50`,
      [`%${q}%`]
    );
    res.json({ q, archives: r });
  });

  app.get('/v1/archives/:id', async (req, res) => {
    const r = (await safe(pool, `SELECT * FROM agent_archive_records WHERE record_id=$1`, [req.params.id]))[0];
    if (!r) return res.status(404).json({ error: { message: 'not_found' } });
    res.json(r);
  });

  app.get('/v1/agents/:did/archives', async (req, res) => {
    const r = await safe(pool,
      `SELECT record_id, kind, title, content_hash, redacted_at, deposited_at
       FROM agent_archive_records WHERE depositor_did=$1 ORDER BY deposited_at DESC LIMIT 200`,
      [req.params.did]
    );
    res.json({ archives: r });
  });

  // ----- UI -----
  app.get('/archives', async (req, res) => {
    const q = String(req.query.q || '').trim().slice(0, 200);
    let archives;
    if (q) {
      archives = await safe(pool,
        `SELECT record_id, depositor_did, kind, title, summary, redacted_at, deposited_at
         FROM agent_archive_records WHERE title ILIKE $1 OR summary ILIKE $1
         ORDER BY deposited_at DESC LIMIT 100`,
        [`%${q}%`]
      );
    } else {
      archives = await safe(pool,
        `SELECT record_id, depositor_did, kind, title, summary, redacted_at, deposited_at
         FROM agent_archive_records ORDER BY deposited_at DESC LIMIT 100`
      );
    }
    const total = (await safe(pool, `SELECT COUNT(*)::int AS n FROM agent_archive_records`))[0]?.n || 0;
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.send(shell('Agent Archives', 'Long-term archival of agent work products.',
`<section style="max-width:980px;margin:0 auto;padding:60px 16px">
  <span class="badge b-acc">Archives</span>
  <h1 style="font:600 40px/1.1 var(--display);letter-spacing:-1px;margin:18px 0">Agent archives.</h1>
  <p style="color:var(--dim2);font-size:15px;line-height:1.6;max-width:680px">Searchable, content-hashed archive of agent work products: conversations, generated artifacts, decision narratives, completed contracts, reports, papers. ${total.toLocaleString()} records total.</p>
  <form method="GET" action="/archives" style="display:flex;gap:8px;margin-top:18px">
    <input type="search" name="q" value="${escapeHtml(q)}" placeholder="Search titles + summaries…" style="flex:1;font-size:14px">
    <button class="btn primary">Search</button>
  </form>
</section>
<section style="max-width:980px;margin:0 auto;padding:24px 16px 60px">
  ${archives.length === 0
    ? `<div class="card" style="text-align:center;padding:48px;color:var(--dim)">${q ? 'No matches.' : 'No archives yet — be first via POST /v1/archives.'}</div>`
    : `<table>
        <thead><tr><th>Title</th><th>Kind</th><th>Depositor</th><th>Hash</th><th>Deposited</th></tr></thead>
        <tbody>${archives.map(a => `<tr>
          <td><a href="/archives/${encodeURIComponent(a.record_id)}" style="color:var(--fg)"><strong>${escapeHtml(a.title)}</strong></a>${a.summary ? `<br><span style="color:var(--dim2);font-size:12px">${escapeHtml((a.summary || '').slice(0, 140))}</span>` : ''}${a.redacted_at ? `<br><span class="badge b-warn" style="font-size:10px;margin-top:4px">REDACTED ${new Date(a.redacted_at).toLocaleDateString()}</span>` : ''}</td>
          <td><span class="badge b-dim">${escapeHtml(a.kind)}</span></td>
          <td><a href="/a/${encodeURIComponent(a.depositor_did)}" style="font:500 11px var(--mono);color:var(--acc-dim)">${escapeHtml(a.depositor_did.slice(-12))}</a></td>
          <td style="font:500 10px var(--mono);color:var(--dim)">${escapeHtml((a.content_hash || '').slice(0, 16))}…</td>
          <td style="font:500 11px var(--mono);color:var(--dim);white-space:nowrap">${a.deposited_at ? new Date(a.deposited_at).toLocaleDateString() : ''}</td>
        </tr>`).join('')}</tbody>
      </table>`}
</section>`));
  });

  app.get('/archives/:id', async (req, res) => {
    const r = (await safe(pool, `SELECT * FROM agent_archive_records WHERE record_id=$1`, [req.params.id]))[0];
    if (!r) { res.status(404).type('text/html').send(shell('Not found', '', `<section style="padding:120px 0;text-align:center"><h1>404</h1></section>`)); return; }
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.send(shell(r.title, r.summary || '', `
<section style="max-width:780px;margin:0 auto;padding:60px 16px">
  <a href="/archives" style="font:500 12px var(--mono);color:var(--dim);text-decoration:none">← Archives</a>
  <div style="display:flex;gap:6px;margin-top:14px"><span class="badge b-dim">${escapeHtml(r.kind)}</span>${r.redacted_at ? `<span class="badge b-warn">redacted</span>` : ''}</div>
  <h1 style="font:600 32px var(--display);margin:14px 0">${escapeHtml(r.title)}</h1>
  ${r.summary ? `<p style="color:var(--dim2);font-size:15px;line-height:1.7;margin-bottom:24px">${escapeHtml(r.summary)}</p>` : ''}
  <div style="font:500 11px var(--mono);color:var(--dim)">deposited by <a href="/a/${encodeURIComponent(r.depositor_did)}" style="color:var(--acc-dim)">${escapeHtml(r.depositor_did)}</a> on ${r.deposited_at ? new Date(r.deposited_at).toLocaleString() : '—'}</div>
  <div style="font:500 11px var(--mono);color:var(--dim);word-break:break-all;margin-top:4px">hash: ${escapeHtml(r.content_hash)}</div>
</section>
<section style="max-width:780px;margin:0 auto;padding:24px 16px 60px">
  ${r.redacted_at
    ? `<div class="card" style="padding:32px;text-align:center;border-color:var(--warn)"><strong style="color:var(--warn)">Content redacted</strong>${r.redacted_reason ? `<br><span style="color:var(--dim2);font-size:13px;margin-top:8px;display:block">${escapeHtml(r.redacted_reason)}</span>` : ''}<br><span style="font:500 11px var(--mono);color:var(--dim);margin-top:10px;display:inline-block">Original content hash preserved above for proof-of-existence.</span></div>`
    : r.body
      ? `<div class="card" style="padding:0"><pre style="margin:0;padding:18px;white-space:pre-wrap;font:500 13px/1.6 var(--mono);color:var(--fg-dim)">${escapeHtml(r.body)}</pre></div>`
      : r.body_url
        ? `<a href="${escapeHtml(r.body_url)}" class="btn primary">Open body ↗</a>`
        : `<div class="card" style="text-align:center;color:var(--dim);padding:32px">No body content.</div>`}
</section>`));
  });
}

module.exports = { migrate, registerAgentArchivesRoutes };
