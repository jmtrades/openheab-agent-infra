// ============================================================================
// OpenHeab Documents — PDF/docx/xlsx/pptx parsing + generation
// Tables: documents, document_generations, document_templates
// Uses storage primitive for blob backing. cost.recordCost on extract/generate.
// ============================================================================
const express = require('express');
const cryptoLib = require('crypto');
const { z } = require('zod');

const SUPPORTED_KINDS = ['pdf', 'docx', 'xlsx', 'pptx', 'markdown', 'txt'];
const MAX_DOC_BYTES = parseInt(process.env.DOCUMENTS_MAX_BYTES || String(10 * 1024 * 1024));
const EXTRACT_COST_CENTS = parseInt(process.env.DOCUMENTS_EXTRACT_COST_CENTS || '2');
const GENERATE_COST_CENTS = parseInt(process.env.DOCUMENTS_GENERATE_COST_CENTS || '5');

// ----------------------------------------------------------------------------
// Migration
// ----------------------------------------------------------------------------
async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS documents (
      document_id      TEXT PRIMARY KEY,
      agent_did        TEXT NOT NULL,
      kind             TEXT NOT NULL,
      filename         TEXT,
      storage_blob_id  TEXT,
      size_bytes       BIGINT NOT NULL DEFAULT 0,
      page_count       INTEGER,
      text_extracted   TEXT,
      metadata         JSONB,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_documents_agent ON documents (agent_did, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_documents_kind ON documents (kind);

    CREATE TABLE IF NOT EXISTS document_generations (
      generation_id    TEXT PRIMARY KEY,
      agent_did        TEXT NOT NULL,
      kind             TEXT NOT NULL,
      template_id      TEXT,
      payload          JSONB,
      output_blob_id   TEXT,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_doc_gens_agent ON document_generations (agent_did, created_at DESC);

    CREATE TABLE IF NOT EXISTS document_templates (
      template_id     TEXT PRIMARY KEY,
      agent_did       TEXT NOT NULL,
      name            TEXT NOT NULL,
      kind            TEXT NOT NULL,
      body            TEXT NOT NULL,
      variables       JSONB,
      public          BOOLEAN NOT NULL DEFAULT FALSE,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_doc_templates_agent ON document_templates (agent_did);
    CREATE INDEX IF NOT EXISTS idx_doc_templates_public ON document_templates (public) WHERE public = TRUE;
  `).catch(() => {});
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------
function genId(prefix) {
  return `${prefix}_${cryptoLib.randomBytes(12).toString('hex')}`;
}

function tryRequire(name) {
  try { return require(name); } catch { return null; }
}

async function extractText(buf, kind) {
  // PDF extraction via pdf-parse, fallback to naive
  if (kind === 'pdf') {
    const pdfParse = tryRequire('pdf-parse');
    if (pdfParse) {
      try {
        const out = await pdfParse(buf);
        return { text: out.text || '', page_count: out.numpages || null };
      } catch (e) {
        // Fall through to stub
      }
    }
    // Stub: extract any text-like portions
    const text = buf.toString('utf-8').replace(/[^\x20-\x7E\n\r\t]+/g, ' ').replace(/\s+/g, ' ').trim();
    return { text: text.slice(0, 100_000), page_count: null };
  }
  if (kind === 'docx' || kind === 'xlsx' || kind === 'pptx') {
    const mammoth = tryRequire('mammoth');
    if (kind === 'docx' && mammoth) {
      try {
        const out = await mammoth.extractRawText({ buffer: buf });
        return { text: out.value || '', page_count: null };
      } catch (e) { /* fall through */ }
    }
    // Stub fallback for office formats (they are zip; scan for plain text)
    const raw = buf.toString('utf-8');
    const text = raw.replace(/[^\x20-\x7E\n\r\t]+/g, ' ').replace(/\s+/g, ' ').trim();
    return { text: text.slice(0, 100_000), page_count: null };
  }
  if (kind === 'markdown' || kind === 'txt') {
    return { text: buf.toString('utf-8'), page_count: null };
  }
  return { text: '', page_count: null };
}

function renderTemplate(body, payload) {
  if (!body) return '';
  return body.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (_, key) => {
    const parts = key.split('.');
    let val = payload;
    for (const p of parts) {
      if (val && typeof val === 'object' && p in val) val = val[p];
      else { val = ''; break; }
    }
    return val == null ? '' : String(val);
  });
}

async function tryRecordCost(pool, did, amountCents, resourceType, provider) {
  try {
    const cost = require('./cost');
    if (cost && typeof cost.recordCost === 'function') {
      await cost.recordCost(pool, {
        agent_did: did,
        resource_type: resourceType,
        provider: provider || 'documents',
        amount_cents: amountCents
      });
    }
  } catch {}
}

// ----------------------------------------------------------------------------
// Routes
// ----------------------------------------------------------------------------
function registerDocumentsRoutes(app, pool, verifyAgentAuth, auditChain) {
  const UploadSchema = z.object({
    kind: z.enum(SUPPORTED_KINDS),
    filename: z.string().max(512).optional(),
    data_base64: z.string().min(1),
    metadata: z.any().optional()
  });

  // POST /v1/agents/:did/documents — upload + extract text
  app.post('/v1/agents/:did/documents', express.json({ limit: '15mb' }), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const parse = UploadSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;

      let buf;
      try { buf = Buffer.from(d.data_base64, 'base64'); }
      catch { return res.status(400).json({ error: 'invalid_base64' }); }
      if (buf.length > MAX_DOC_BYTES) {
        return res.status(413).json({ error: 'document_too_large', max: MAX_DOC_BYTES });
      }

      const documentId = genId('doc');
      const { text, page_count } = await extractText(buf, d.kind);

      // Store blob via storage primitive (best-effort)
      let storageBlobId = null;
      try {
        const storage = require('./storage');
        if (storage && typeof storage.signDownloadUrl === 'function') {
          storageBlobId = 'blob_' + cryptoLib.randomBytes(16).toString('hex');
          await pool.query(
            `INSERT INTO storage_blobs
             (blob_id, owner_did, filename, content_type, size_bytes, sha256, data, driver, metadata)
             VALUES ($1,$2,$3,$4,$5,$6,$7,'postgres',$8::jsonb)
             ON CONFLICT (blob_id) DO NOTHING`,
            [storageBlobId, did, d.filename || null, `application/${d.kind}`,
             buf.length,
             cryptoLib.createHash('sha256').update(buf).digest('hex'),
             buf, JSON.stringify({ document_id: documentId })]
          ).catch(() => { storageBlobId = null; });
        }
      } catch {}

      await pool.query(
        `INSERT INTO documents
         (document_id, agent_did, kind, filename, storage_blob_id, size_bytes,
          page_count, text_extracted, metadata)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,
        [documentId, did, d.kind, d.filename || null, storageBlobId, buf.length,
         page_count, text, d.metadata ? JSON.stringify(d.metadata) : null]
      );

      await tryRecordCost(pool, did, EXTRACT_COST_CENTS, 'documents', 'extract');

      await auditChain.append({
        event_type: 'documents.uploaded',
        document_id: documentId, agent_did: did, kind: d.kind,
        size_bytes: buf.length,
        timestamp: new Date().toISOString()
      });

      return res.status(201).json({
        document_id: documentId, agent_did: did, kind: d.kind,
        filename: d.filename || null, size_bytes: buf.length,
        page_count, text_length: (text || '').length,
        storage_blob_id: storageBlobId
      });
    } catch (e) {
      console.error('[documents.upload]', e);
      return res.status(500).json({ error: 'upload_failed', message: e.message });
    }
  });

  // GET /v1/agents/:did/documents — list
  app.get('/v1/agents/:did/documents', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const limit = Math.min(parseInt(req.query.limit) || 50, 500);
    const r = await pool.query(
      `SELECT document_id, kind, filename, size_bytes, page_count, storage_blob_id,
              metadata, created_at,
              LENGTH(COALESCE(text_extracted, '')) AS text_length
       FROM documents WHERE agent_did = $1
       ORDER BY created_at DESC LIMIT $2`,
      [did, limit]
    ).catch(() => ({ rows: [] }));
    return res.json({ documents: r.rows, count: r.rows.length });
  });

  // GET /v1/agents/:did/documents/:id — with full text
  app.get('/v1/agents/:did/documents/:id', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(
      `SELECT * FROM documents WHERE document_id = $1 AND agent_did = $2`,
      [req.params.id, did]
    ).catch(() => ({ rows: [] }));
    if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
    return res.json(r.rows[0]);
  });

  // POST /v1/agents/:did/documents/generate — template + payload -> output
  const GenSchema = z.object({
    template_id: z.string().optional(),
    body: z.string().optional(),
    kind: z.enum(SUPPORTED_KINDS).optional(),
    filename: z.string().optional(),
    payload: z.record(z.any()).default({})
  }).refine(d => d.template_id || d.body, {
    message: 'template_id or body required'
  });

  app.post('/v1/agents/:did/documents/generate', express.json({ limit: '5mb' }), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const parse = GenSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;

      let body = d.body;
      let kind = d.kind || 'markdown';
      if (d.template_id) {
        const tR = await pool.query(
          `SELECT body, kind FROM document_templates WHERE template_id = $1 AND (agent_did = $2 OR public = TRUE)`,
          [d.template_id, did]
        ).catch(() => ({ rows: [] }));
        if (!tR.rows[0]) return res.status(404).json({ error: 'template_not_found' });
        body = tR.rows[0].body;
        kind = tR.rows[0].kind;
      }
      const output = renderTemplate(body, d.payload);
      const outputBuf = Buffer.from(output, 'utf-8');

      let outputBlobId = 'blob_' + cryptoLib.randomBytes(16).toString('hex');
      try {
        await pool.query(
          `INSERT INTO storage_blobs
           (blob_id, owner_did, filename, content_type, size_bytes, sha256, data, driver)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'postgres')
           ON CONFLICT (blob_id) DO NOTHING`,
          [outputBlobId, did, d.filename || `generated.${kind}`, `text/${kind}`,
           outputBuf.length,
           cryptoLib.createHash('sha256').update(outputBuf).digest('hex'),
           outputBuf]
        );
      } catch { outputBlobId = null; }

      const generationId = genId('gen');
      await pool.query(
        `INSERT INTO document_generations
         (generation_id, agent_did, kind, template_id, payload, output_blob_id)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6)`,
        [generationId, did, kind, d.template_id || null,
         JSON.stringify(d.payload || {}), outputBlobId]
      );

      await tryRecordCost(pool, did, GENERATE_COST_CENTS, 'documents', 'generate');

      await auditChain.append({
        event_type: 'documents.generated',
        generation_id: generationId, agent_did: did, kind,
        template_id: d.template_id || null,
        timestamp: new Date().toISOString()
      });

      return res.status(201).json({
        generation_id: generationId, agent_did: did, kind,
        template_id: d.template_id || null,
        output_blob_id: outputBlobId,
        output_preview: output.slice(0, 500),
        size_bytes: outputBuf.length
      });
    } catch (e) {
      console.error('[documents.generate]', e);
      return res.status(500).json({ error: 'generate_failed', message: e.message });
    }
  });

  // POST /v1/agents/:did/documents/templates
  const TemplateSchema = z.object({
    name: z.string().min(1).max(256),
    kind: z.enum(SUPPORTED_KINDS),
    body: z.string().min(1),
    variables: z.array(z.any()).optional(),
    public: z.boolean().optional().default(false)
  });

  app.post('/v1/agents/:did/documents/templates', express.json({ limit: '5mb' }), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const parse = TemplateSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;

      const templateId = genId('tmpl');
      await pool.query(
        `INSERT INTO document_templates
         (template_id, agent_did, name, kind, body, variables, public)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)`,
        [templateId, did, d.name, d.kind, d.body,
         JSON.stringify(d.variables || []), d.public]
      );

      await auditChain.append({
        event_type: 'documents.template_created',
        template_id: templateId, agent_did: did, name: d.name, kind: d.kind,
        public: d.public, timestamp: new Date().toISOString()
      });

      return res.status(201).json({
        template_id: templateId, agent_did: did, name: d.name,
        kind: d.kind, public: d.public
      });
    } catch (e) {
      console.error('[documents.template.create]', e);
      return res.status(500).json({ error: 'template_create_failed', message: e.message });
    }
  });

  // GET /v1/agents/:did/documents/templates
  app.get('/v1/agents/:did/documents/templates', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(
      `SELECT template_id, name, kind, public, variables, created_at
       FROM document_templates WHERE agent_did = $1
       ORDER BY created_at DESC`,
      [did]
    ).catch(() => ({ rows: [] }));
    return res.json({ templates: r.rows, count: r.rows.length });
  });

  // POST /v1/documents/templates/public — browse community templates
  app.post('/v1/documents/templates/public', express.json(), async (req, res) => {
    const q = (req.body || {}).q || '';
    const kind = (req.body || {}).kind;
    const limit = Math.min(parseInt((req.body || {}).limit) || 50, 200);
    const params = [];
    const conditions = ['public = TRUE'];
    if (q) {
      params.push(`%${q}%`);
      conditions.push(`(name ILIKE $${params.length} OR body ILIKE $${params.length})`);
    }
    if (kind && SUPPORTED_KINDS.includes(kind)) {
      params.push(kind);
      conditions.push(`kind = $${params.length}`);
    }
    params.push(limit);
    const r = await pool.query(
      `SELECT template_id, agent_did, name, kind, variables, created_at
       FROM document_templates
       WHERE ${conditions.join(' AND ')}
       ORDER BY created_at DESC LIMIT $${params.length}`,
      params
    ).catch(() => ({ rows: [] }));
    return res.json({ templates: r.rows, count: r.rows.length, query: { q, kind } });
  });
}

module.exports = {
  migrate,
  registerDocumentsRoutes,
  extractText,
  renderTemplate,
  SUPPORTED_KINDS,
  MAX_DOC_BYTES
};
