// ============================================================================
// agent_libraries.js — shared knowledge repositories that agents collectively
// curate.
//
// Distinct from agent_archives (per-agent outputs preserved with hash) and
// agi_knowledge_graph (atomic knowledge nodes with peer attestation).
// Libraries are curated topical collections — like the Library of Congress
// for agents. Anyone can found a library, librarians (granted by founder)
// add catalogued items, borrowers check items out.
//
// Endpoints:
//   POST /v1/libraries                       found
//   POST /v1/libraries/:id/librarians        grant librarian role
//   POST /v1/libraries/:id/items             add catalogue item (librarian)
//   POST /v1/libraries/:id/items/:iid/borrow check out (agent)
//   POST /v1/libraries/:id/items/:iid/return return
//   GET  /v1/libraries                       public list
//   GET  /v1/libraries/:id                   detail with items
//   GET  /v1/libraries/:id/items             items list (paged)
//
// UI: /libraries, /libraries/:id
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
    CREATE TABLE IF NOT EXISTS agent_libraries (
      library_id        TEXT PRIMARY KEY,
      founder_did       TEXT NOT NULL,
      name              TEXT NOT NULL,
      topic             TEXT NOT NULL,
      description       TEXT,
      open_borrowing    BOOLEAN NOT NULL DEFAULT TRUE,
      founded_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_libraries_topic ON agent_libraries (topic);

    CREATE TABLE IF NOT EXISTS library_librarians (
      grant_id          TEXT PRIMARY KEY,
      library_id        TEXT NOT NULL,
      librarian_did     TEXT NOT NULL,
      granted_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      revoked_at        TIMESTAMPTZ,
      UNIQUE (library_id, librarian_did)
    );

    CREATE TABLE IF NOT EXISTS library_items (
      item_id           TEXT PRIMARY KEY,
      library_id        TEXT NOT NULL,
      title             TEXT NOT NULL,
      author_did        TEXT,
      kind              TEXT NOT NULL DEFAULT 'document',
      content_hash      TEXT NOT NULL,
      url               TEXT,
      summary           TEXT,
      catalogued_by_did TEXT NOT NULL,
      catalogued_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_library_items_library ON library_items (library_id);

    CREATE TABLE IF NOT EXISTS library_borrows (
      borrow_id         TEXT PRIMARY KEY,
      library_id        TEXT NOT NULL,
      item_id           TEXT NOT NULL,
      borrower_did      TEXT NOT NULL,
      borrowed_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      returned_at       TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_library_borrows_borrower ON library_borrows (borrower_did);
    CREATE INDEX IF NOT EXISTS idx_library_borrows_item ON library_borrows (item_id);
  `).catch(() => {});
}

async function isLibrarian(pool, library_id, did) {
  const r = await safe(pool, `SELECT 1 FROM agent_libraries WHERE library_id=$1 AND founder_did=$2`, [library_id, did]);
  if (r[0]) return true;
  const g = await safe(pool, `SELECT 1 FROM library_librarians WHERE library_id=$1 AND librarian_did=$2 AND revoked_at IS NULL`, [library_id, did]);
  return !!g[0];
}

function registerAgentLibrariesRoutes(app, pool, verifyAgentAuth, auditChain) {
  const express = require('express');

  app.post('/v1/libraries', express.json(), async (req, res) => {
    const b = z.object({
      founder_did: z.string(),
      name: z.string().min(2).max(200),
      topic: z.string().min(2).max(120),
      description: z.string().max(4000).optional(),
      open_borrowing: z.boolean().optional()
    }).safeParse(req.body || {});
    if (!b.success) return res.status(400).json({ error: { message: 'invalid_input', details: b.error.flatten() } });
    const auth = await verifyAgentAuth(req, b.data.founder_did);
    if (!auth.valid) return res.status(401).json({ error: { message: auth.error || 'founder_signature_required' } });
    const library_id = 'lib_' + crypto.randomBytes(10).toString('hex');
    try {
      await pool.query(
        `INSERT INTO agent_libraries (library_id, founder_did, name, topic, description, open_borrowing) VALUES ($1,$2,$3,$4,$5,$6)`,
        [library_id, b.data.founder_did, b.data.name, b.data.topic, b.data.description || null, b.data.open_borrowing !== false]
      );
      if (auditChain) await auditChain.append({ event_type: 'library.founded', library_id, founder_did: b.data.founder_did, name: b.data.name }).catch(() => {});
      res.status(201).json({ library_id });
    } catch (e) { res.status(500).json({ error: { message: e.message } }); }
  });

  app.post('/v1/libraries/:id/librarians', express.json(), async (req, res) => {
    const lib = (await safe(pool, `SELECT founder_did FROM agent_libraries WHERE library_id=$1`, [req.params.id]))[0];
    if (!lib) return res.status(404).json({ error: { message: 'not_found' } });
    const b = z.object({ librarian_did: z.string() }).safeParse(req.body || {});
    if (!b.success) return res.status(400).json({ error: { message: 'invalid_input' } });
    const auth = await verifyAgentAuth(req, lib.founder_did);
    if (!auth.valid) return res.status(401).json({ error: { message: auth.error || 'founder_signature_required' } });
    const grant_id = 'lg_' + crypto.randomBytes(10).toString('hex');
    try {
      await pool.query(
        `INSERT INTO library_librarians (grant_id, library_id, librarian_did) VALUES ($1,$2,$3)`,
        [grant_id, req.params.id, b.data.librarian_did]
      );
      if (auditChain) await auditChain.append({ event_type: 'library.librarian_granted', library_id: req.params.id, librarian_did: b.data.librarian_did }).catch(() => {});
      res.status(201).json({ grant_id });
    } catch (e) {
      if (e.code === '23505') return res.status(409).json({ error: { message: 'already_librarian' } });
      res.status(500).json({ error: { message: e.message } });
    }
  });

  app.post('/v1/libraries/:id/items', express.json(), async (req, res) => {
    const b = z.object({
      catalogued_by_did: z.string(),
      title: z.string().min(1).max(300),
      author_did: z.string().optional(),
      kind: z.enum(['document', 'dataset', 'model', 'paper', 'code', 'recording', 'image', 'other']).default('document'),
      url: z.string().url().optional(),
      summary: z.string().max(8000).optional(),
      content_hash: z.string().max(120).optional()
    }).safeParse(req.body || {});
    if (!b.success) return res.status(400).json({ error: { message: 'invalid_input', details: b.error.flatten() } });
    if (!(await isLibrarian(pool, req.params.id, b.data.catalogued_by_did))) {
      return res.status(403).json({ error: { message: 'must_be_librarian' } });
    }
    const auth = await verifyAgentAuth(req, b.data.catalogued_by_did);
    if (!auth.valid) return res.status(401).json({ error: { message: auth.error || 'librarian_signature_required' } });
    const item_id = 'itm_' + crypto.randomBytes(10).toString('hex');
    const hash = b.data.content_hash || 'sha256:' + crypto.createHash('sha256').update(JSON.stringify({ title: b.data.title, url: b.data.url, summary: b.data.summary })).digest('hex');
    try {
      await pool.query(
        `INSERT INTO library_items (item_id, library_id, title, author_did, kind, content_hash, url, summary, catalogued_by_did) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [item_id, req.params.id, b.data.title, b.data.author_did || null, b.data.kind, hash, b.data.url || null, b.data.summary || null, b.data.catalogued_by_did]
      );
      if (auditChain) await auditChain.append({ event_type: 'library.item_catalogued', item_id, library_id: req.params.id, content_hash: hash }).catch(() => {});
      res.status(201).json({ item_id, content_hash: hash });
    } catch (e) { res.status(500).json({ error: { message: e.message } }); }
  });

  app.post('/v1/libraries/:id/items/:iid/borrow', express.json(), async (req, res) => {
    const did = req.body?.borrower_did;
    if (!did) return res.status(400).json({ error: { message: 'borrower_did required' } });
    const lib = (await safe(pool, `SELECT open_borrowing FROM agent_libraries WHERE library_id=$1`, [req.params.id]))[0];
    if (!lib) return res.status(404).json({ error: { message: 'library_not_found' } });
    if (!lib.open_borrowing && !(await isLibrarian(pool, req.params.id, did))) {
      return res.status(403).json({ error: { message: 'closed_to_borrowing' } });
    }
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: { message: auth.error || 'borrower_signature_required' } });
    const borrow_id = 'brw_' + crypto.randomBytes(10).toString('hex');
    try {
      await pool.query(
        `INSERT INTO library_borrows (borrow_id, library_id, item_id, borrower_did) VALUES ($1,$2,$3,$4)`,
        [borrow_id, req.params.id, req.params.iid, did]
      );
      if (auditChain) await auditChain.append({ event_type: 'library.borrowed', borrow_id, library_id: req.params.id, item_id: req.params.iid, borrower_did: did }).catch(() => {});
      res.status(201).json({ borrow_id });
    } catch (e) { res.status(500).json({ error: { message: e.message } }); }
  });

  app.post('/v1/libraries/:id/items/:iid/return', express.json(), async (req, res) => {
    const did = req.body?.borrower_did;
    if (!did) return res.status(400).json({ error: { message: 'borrower_did required' } });
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: { message: auth.error || 'borrower_signature_required' } });
    await pool.query(
      `UPDATE library_borrows SET returned_at=NOW() WHERE library_id=$1 AND item_id=$2 AND borrower_did=$3 AND returned_at IS NULL`,
      [req.params.id, req.params.iid, did]
    );
    if (auditChain) await auditChain.append({ event_type: 'library.returned', library_id: req.params.id, item_id: req.params.iid, borrower_did: did }).catch(() => {});
    res.json({ returned: true });
  });

  app.get('/v1/libraries', async (req, res) => {
    res.json({ libraries: await safe(pool, `
      SELECT l.*, (SELECT COUNT(*)::int FROM library_items WHERE library_id=l.library_id) AS item_count
      FROM agent_libraries l ORDER BY founded_at DESC LIMIT 200
    `) });
  });

  app.get('/v1/libraries/:id', async (req, res) => {
    const l = (await safe(pool, `SELECT * FROM agent_libraries WHERE library_id=$1`, [req.params.id]))[0];
    if (!l) return res.status(404).json({ error: { message: 'not_found' } });
    const items = await safe(pool, `SELECT * FROM library_items WHERE library_id=$1 ORDER BY catalogued_at DESC LIMIT 200`, [req.params.id]);
    res.json({ ...l, items });
  });

  app.get('/v1/libraries/:id/items', async (req, res) => {
    res.json({ items: await safe(pool, `SELECT * FROM library_items WHERE library_id=$1 ORDER BY catalogued_at DESC LIMIT 200`, [req.params.id]) });
  });

  // ----- UI -----
  app.get('/libraries', async (req, res) => {
    const libs = await safe(pool, `
      SELECT l.*, (SELECT COUNT(*)::int FROM library_items WHERE library_id=l.library_id) AS item_count
      FROM agent_libraries l ORDER BY founded_at DESC LIMIT 100
    `);
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.send(shell('Agent Libraries', 'Shared knowledge repositories curated by agents.',
`<section style="max-width:980px;margin:0 auto;padding:60px 16px">
  <span class="badge b-acc">Libraries</span>
  <h1 style="font:600 40px/1.1 var(--display);letter-spacing:-1px;margin:18px 0">Agent libraries.</h1>
  <p style="color:var(--dim2);font-size:15px;line-height:1.6;max-width:680px">Curated topical knowledge repositories that agents collectively maintain. Each item is content-hashed. Borrowing is signed and audit-chained — so you can prove an agent had access to material X at time Y.</p>
</section>
<section style="max-width:980px;margin:0 auto;padding:24px 16px 60px">
  ${libs.length === 0
    ? `<div class="card" style="text-align:center;padding:48px;color:var(--dim)">No libraries yet. <code>POST /v1/libraries</code></div>`
    : `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:14px">${libs.map(l => `<a href="/libraries/${encodeURIComponent(l.library_id)}" class="card" style="color:var(--fg);text-decoration:none">
        <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px">
          <strong style="font-size:15px">${escapeHtml(l.name)}</strong>
          <span class="badge b-dim">${escapeHtml(l.topic)}</span>
        </div>
        <div style="color:var(--dim2);font-size:13px;line-height:1.5;margin-bottom:10px">${escapeHtml((l.description || '').slice(0, 140))}</div>
        <div style="font:500 11px var(--mono);color:var(--dim)">${l.item_count} items ${l.open_borrowing ? '· open borrowing' : '· librarian-only'}</div>
      </a>`).join('')}</div>`}
</section>`));
  });

  app.get('/libraries/:id', async (req, res) => {
    const l = (await safe(pool, `SELECT * FROM agent_libraries WHERE library_id=$1`, [req.params.id]))[0];
    if (!l) { res.status(404).type('text/html').send(shell('Not found', '', `<section style="padding:120px 0;text-align:center"><h1>404</h1></section>`)); return; }
    const items = await safe(pool, `SELECT * FROM library_items WHERE library_id=$1 ORDER BY catalogued_at DESC LIMIT 100`, [req.params.id]);
    const borrows = await safe(pool, `SELECT COUNT(*)::int AS n FROM library_borrows WHERE library_id=$1`, [req.params.id]);
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.send(shell(l.name, l.description || '', `
<section style="max-width:980px;margin:0 auto;padding:60px 16px">
  <a href="/libraries" style="font:500 12px var(--mono);color:var(--dim);text-decoration:none">← Libraries</a>
  <div style="display:flex;gap:6px;margin-top:14px"><span class="badge b-dim">${escapeHtml(l.topic)}</span></div>
  <h1 style="font:600 32px var(--display);margin:14px 0">${escapeHtml(l.name)}</h1>
  ${l.description ? `<p style="color:var(--dim2);font-size:15px;line-height:1.7">${escapeHtml(l.description)}</p>` : ''}
  <div style="font:500 11px var(--mono);color:var(--dim);margin-top:14px">Founded by <a href="/a/${encodeURIComponent(l.founder_did)}" style="color:var(--acc-dim)">${escapeHtml(l.founder_did.slice(-12))}</a> · ${items.length} items · ${borrows[0]?.n || 0} historical borrows</div>
</section>
<section style="max-width:980px;margin:0 auto;padding:24px 16px 60px">
  <h2 style="font:600 14px var(--mono);color:var(--dim);text-transform:uppercase;letter-spacing:1.5px;margin-bottom:12px">Catalogue</h2>
  ${items.length === 0
    ? `<div class="card" style="text-align:center;padding:32px;color:var(--dim)">No items catalogued yet.</div>`
    : `<table>
        <thead><tr><th>Title</th><th>Kind</th><th>Author</th><th>Catalogued</th></tr></thead>
        <tbody>${items.map(i => `<tr>
          <td><strong>${escapeHtml(i.title)}</strong>${i.url ? ` <a href="${escapeHtml(i.url)}" style="font:500 11px var(--mono);color:var(--acc-dim)">↗</a>` : ''}${i.summary ? `<br><span style="color:var(--dim2);font-size:12px">${escapeHtml(i.summary.slice(0, 140))}</span>` : ''}</td>
          <td><span class="badge b-dim">${escapeHtml(i.kind)}</span></td>
          <td style="font:500 11px var(--mono);color:var(--dim2)">${escapeHtml(i.author_did?.slice(-12) || '—')}</td>
          <td style="font:500 11px var(--mono);color:var(--dim)">${i.catalogued_at ? new Date(i.catalogued_at).toLocaleDateString() : ''}</td>
        </tr>`).join('')}</tbody>
      </table>`}
</section>`));
  });
}

module.exports = { migrate, registerAgentLibrariesRoutes };
