// ============================================================================
// files_usage_api.js — OpenAI-compatible /v1/files family + chart-ready
// /v1/usage/daily breakdown. Both are essential for any non-toy app:
//   - Batches need files. RAG needs files. Anything multimodal needs files.
//   - Charts in /dashboard need daily aggregates, not just totals.
// ============================================================================
const crypto = require('crypto');

async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS oai_files (
      file_id      TEXT PRIMARY KEY,
      agent_did    TEXT NOT NULL,
      filename     TEXT NOT NULL,
      bytes        BIGINT NOT NULL,
      purpose      TEXT NOT NULL,
      sha256       TEXT NOT NULL,
      content_b64  TEXT,
      status       TEXT NOT NULL DEFAULT 'processed',
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_oai_files_agent ON oai_files (agent_did, created_at DESC);
  `);
}

async function resolveAgent(pool, req) {
  try { return await require('./me_endpoints').resolveAgentFromRequest(pool, req); }
  catch { return null; }
}

function newId(p) { return p + '_' + crypto.randomBytes(12).toString('hex'); }

const MAX_FILE_BYTES = 32 * 1024 * 1024; // 32 MB

function registerFilesUsageApiRoutes(app, pool, verifyAgentAuth, auditChain) {
  const express = require('express');

  // POST /v1/files — accepts JSON {filename, purpose, content (base64)} OR
  // raw body with x-filename header. Returns OpenAI-shape file object.
  // Body-parser note: server.js mounts express.json() globally BEFORE this
  // route, so req.body for application/json is already an Object. For raw
  // uploads (other content-types), our own express.raw runs here.
  app.post('/v1/files', express.raw({ type: req => !(req.headers['content-type'] || '').includes('json'), limit: '64mb' }), async (req, res) => {
    const ctx = await resolveAgent(pool, req);
    if (!ctx) return res.status(401).json({ error: { message: 'Unauthorized.', type: 'invalid_request_error' } });

    let filename, purpose, contentBuffer;
    const ctype = req.headers['content-type'] || '';
    if (ctype.includes('application/json')) {
      // req.body is already the parsed Object thanks to upstream express.json()
      const body = (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) ? req.body : {};
      filename = body.filename;
      purpose = body.purpose || 'batch';
      if (!body.content) return res.status(400).json({ error: { message: '`content` (base64) required for JSON upload', type: 'invalid_request_error' } });
      try { contentBuffer = Buffer.from(body.content, 'base64'); }
      catch { return res.status(400).json({ error: { message: 'invalid_base64', type: 'invalid_request_error' } }); }
    } else {
      // Raw body upload
      filename = req.headers['x-filename'] || 'upload-' + Date.now() + '.bin';
      purpose = req.headers['x-purpose'] || 'batch';
      contentBuffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
    }
    if (!filename) return res.status(400).json({ error: { message: '`filename` required', type: 'invalid_request_error' } });
    if (!Buffer.isBuffer(contentBuffer) || contentBuffer.length === 0) {
      return res.status(400).json({ error: { message: 'empty_upload', type: 'invalid_request_error' } });
    }
    if (contentBuffer.length > MAX_FILE_BYTES) {
      return res.status(413).json({ error: { message: 'file_too_large (max 32MB)', type: 'invalid_request_error' } });
    }

    const id = newId('file');
    const sha = crypto.createHash('sha256').update(contentBuffer).digest('hex');
    // Store content in-table when small enough; otherwise just metadata
    const inline = contentBuffer.length <= 1_500_000;  // ~1.5MB inline limit
    await pool.query(
      `INSERT INTO oai_files (file_id, agent_did, filename, bytes, purpose, sha256, content_b64, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'processed')`,
      [id, ctx.did, String(filename).slice(0, 256), contentBuffer.length,
       String(purpose).slice(0, 50), sha,
       inline ? contentBuffer.toString('base64') : null]
    );
    if (auditChain) auditChain.append({
      event_type: 'file.uploaded', file_id: id, agent_did: ctx.did,
      filename, bytes: contentBuffer.length, purpose, sha256: sha
    }).catch(() => {});

    res.status(201).json({
      id, object: 'file', bytes: contentBuffer.length,
      created_at: Math.floor(Date.now() / 1000),
      filename, purpose, status: 'processed',
      sha256: sha
    });
  });

  // GET /v1/files — list current agent's files
  app.get('/v1/files', async (req, res) => {
    const ctx = await resolveAgent(pool, req);
    if (!ctx) return res.status(401).json({ error: { message: 'Unauthorized.', type: 'invalid_request_error' } });
    const purpose = req.query.purpose;
    const r = await pool.query(
      `SELECT file_id, filename, bytes, purpose, sha256, status, created_at
       FROM oai_files WHERE agent_did=$1 ${purpose ? 'AND purpose=$2' : ''}
       ORDER BY created_at DESC LIMIT 200`,
      purpose ? [ctx.did, purpose] : [ctx.did]
    ).catch(() => ({ rows: [] }));
    res.json({
      object: 'list',
      data: r.rows.map(row => ({
        id: row.file_id, object: 'file', bytes: Number(row.bytes),
        created_at: Math.floor(new Date(row.created_at).getTime() / 1000),
        filename: row.filename, purpose: row.purpose, status: row.status,
        sha256: row.sha256
      }))
    });
  });

  // GET /v1/files/:id — file metadata
  app.get('/v1/files/:id', async (req, res) => {
    const ctx = await resolveAgent(pool, req);
    if (!ctx) return res.status(401).json({ error: { message: 'Unauthorized.', type: 'invalid_request_error' } });
    const r = await pool.query(
      `SELECT file_id, filename, bytes, purpose, sha256, status, created_at
       FROM oai_files WHERE file_id=$1 AND agent_did=$2`, [req.params.id, ctx.did]
    ).catch(() => ({ rows: [] }));
    if (!r.rows[0]) return res.status(404).json({ error: { message: 'File not found.', type: 'invalid_request_error', code: 'not_found' } });
    const row = r.rows[0];
    res.json({
      id: row.file_id, object: 'file', bytes: Number(row.bytes),
      created_at: Math.floor(new Date(row.created_at).getTime() / 1000),
      filename: row.filename, purpose: row.purpose, status: row.status,
      sha256: row.sha256
    });
  });

  // GET /v1/files/:id/content — raw file content
  app.get('/v1/files/:id/content', async (req, res) => {
    const ctx = await resolveAgent(pool, req);
    if (!ctx) return res.status(401).json({ error: { message: 'Unauthorized.', type: 'invalid_request_error' } });
    const r = await pool.query(
      `SELECT filename, content_b64 FROM oai_files WHERE file_id=$1 AND agent_did=$2`,
      [req.params.id, ctx.did]
    ).catch(() => ({ rows: [] }));
    if (!r.rows[0]) return res.status(404).json({ error: { message: 'File not found.', type: 'invalid_request_error' } });
    if (!r.rows[0].content_b64) {
      return res.status(410).json({ error: { message: 'File content not retained (size exceeded inline limit).', type: 'invalid_request_error' } });
    }
    const buf = Buffer.from(r.rows[0].content_b64, 'base64');
    res.setHeader('content-type', 'application/octet-stream');
    res.setHeader('content-disposition', `attachment; filename="${r.rows[0].filename.replace(/[^a-zA-Z0-9._-]/g, '_')}"`);
    res.send(buf);
  });

  // DELETE /v1/files/:id
  app.delete('/v1/files/:id', async (req, res) => {
    const ctx = await resolveAgent(pool, req);
    if (!ctx) return res.status(401).json({ error: { message: 'Unauthorized.', type: 'invalid_request_error' } });
    const r = await pool.query(
      `DELETE FROM oai_files WHERE file_id=$1 AND agent_did=$2`,
      [req.params.id, ctx.did]
    ).catch(() => ({ rowCount: 0 }));
    if (auditChain) auditChain.append({ event_type: 'file.deleted', file_id: req.params.id, agent_did: ctx.did }).catch(() => {});
    res.json({ id: req.params.id, object: 'file', deleted: (r.rowCount || 0) > 0 });
  });

  // GET /v1/usage/daily — chart-ready daily breakdown (last 30 days)
  app.get('/v1/usage/daily', async (req, res) => {
    const ctx = await resolveAgent(pool, req);
    if (!ctx) return res.status(401).json({ error: 'unauthenticated' });
    const days = Math.min(parseInt(req.query.days) || 30, 365);
    // Build a continuous date series (so chart shows zero days)
    const rows = await pool.query(`
      SELECT
        date_trunc('day', created_at)::date AS day,
        COUNT(*)::int AS calls,
        COALESCE(SUM(prompt_tokens),0)::bigint AS prompt_tokens,
        COALESCE(SUM(completion_tokens),0)::bigint AS completion_tokens,
        COALESCE(SUM(cost_cents),0)::bigint AS spend_cents
      FROM inference_calls
      WHERE agent_did=$1 AND created_at > NOW() - ($2 || ' days')::interval
      GROUP BY date_trunc('day', created_at)
      ORDER BY day
    `, [ctx.did, days]).catch(() => ({ rows: [] }));

    // Fill zeros for missing days
    const byDate = {};
    for (const row of rows.rows) {
      const d = new Date(row.day).toISOString().slice(0, 10);
      byDate[d] = {
        calls: Number(row.calls), prompt_tokens: Number(row.prompt_tokens),
        completion_tokens: Number(row.completion_tokens), spend_cents: Number(row.spend_cents)
      };
    }
    const series = [];
    for (let i = days - 1; i >= 0; i--) {
      const date = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
      series.push({ date, ...(byDate[date] || { calls: 0, prompt_tokens: 0, completion_tokens: 0, spend_cents: 0 }) });
    }
    res.set('cache-control', 'private, max-age=60');
    res.json({ did: ctx.did, days, series });
  });

  // GET /v1/usage/summary — at-a-glance totals (today, 7d, 30d, all-time)
  app.get('/v1/usage/summary', async (req, res) => {
    const ctx = await resolveAgent(pool, req);
    if (!ctx) return res.status(401).json({ error: 'unauthenticated' });
    const periods = [
      ['today', '1 day'],
      ['week', '7 days'],
      ['month', '30 days'],
      ['year', '365 days']
    ];
    const summary = { did: ctx.did, periods: {} };
    for (const [name, interval] of periods) {
      const r = await pool.query(`
        SELECT COUNT(*)::int AS calls,
               COALESCE(SUM(prompt_tokens),0)::bigint AS prompt_tokens,
               COALESCE(SUM(completion_tokens),0)::bigint AS completion_tokens,
               COALESCE(SUM(cost_cents),0)::bigint AS spend_cents
        FROM inference_calls
        WHERE agent_did=$1 AND created_at > NOW() - INTERVAL '${interval}'
      `, [ctx.did]).catch(() => ({ rows: [] }));
      summary.periods[name] = r.rows[0] || { calls: 0, prompt_tokens: 0, completion_tokens: 0, spend_cents: 0 };
    }
    res.set('cache-control', 'private, max-age=60');
    res.json(summary);
  });
}

module.exports = { migrate, registerFilesUsageApiRoutes };
