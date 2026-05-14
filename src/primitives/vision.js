// ============================================================================
// OpenHeab Vision — Image generation, OCR, visual QA, inpaint
// Providers: OpenAI (DALL-E 3), FAL (SDXL/Flux), Anthropic (vision Claude).
// ============================================================================
const express = require('express');
const cryptoLib = require('crypto');
const { z } = require('zod');

function tryRequire(name) {
  try { return require(name); } catch { return null; }
}

function genGenerationId() { return 'imgen_' + cryptoLib.randomBytes(12).toString('hex'); }
function genAnalysisId() { return 'imana_' + cryptoLib.randomBytes(12).toString('hex'); }
function genEditId() { return 'imedt_' + cryptoLib.randomBytes(12).toString('hex'); }

// Rough cost per image, in cents
const GEN_COST = { dalle3: 4, sdxl: 2, flux: 3, default: 4 };
const ANALYSIS_COST_CENTS = 2;

function pickGenProvider(model) {
  const m = (model || '').toLowerCase();
  if (m.includes('dalle') || m.includes('dall-e')) return { provider: 'openai', model: 'dall-e-3', env: 'OPENAI_API_KEY' };
  if (m.includes('flux')) return { provider: 'fal', model: 'flux', env: 'FAL_API_KEY' };
  if (m.includes('sdxl')) return { provider: 'fal', model: 'sdxl', env: 'FAL_API_KEY' };
  if (process.env.OPENAI_API_KEY) return { provider: 'openai', model: 'dall-e-3', env: 'OPENAI_API_KEY' };
  if (process.env.FAL_API_KEY) return { provider: 'fal', model: 'flux', env: 'FAL_API_KEY' };
  return { provider: 'stub', model: model || 'stub', env: null };
}

// ----------------------------------------------------------------------------
// Migration
// ----------------------------------------------------------------------------
async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS vision_generations (
      generation_id   TEXT PRIMARY KEY,
      agent_did       TEXT NOT NULL,
      prompt          TEXT NOT NULL,
      negative_prompt TEXT,
      model           TEXT,
      width           INTEGER,
      height          INTEGER,
      image_url       TEXT,
      cost_cents      INTEGER NOT NULL DEFAULT 0,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_vision_generations_did
      ON vision_generations (agent_did, created_at DESC);

    CREATE TABLE IF NOT EXISTS vision_analyses (
      analysis_id TEXT PRIMARY KEY,
      agent_did   TEXT NOT NULL,
      image_url   TEXT NOT NULL,
      kind        TEXT NOT NULL,
      question    TEXT,
      result      JSONB,
      cost_cents  INTEGER NOT NULL DEFAULT 0,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_vision_analyses_did
      ON vision_analyses (agent_did, created_at DESC);

    CREATE TABLE IF NOT EXISTS vision_edits (
      edit_id          TEXT PRIMARY KEY,
      agent_did        TEXT NOT NULL,
      source_image_url TEXT NOT NULL,
      mask_url         TEXT,
      prompt           TEXT NOT NULL,
      result_url       TEXT,
      cost_cents       INTEGER NOT NULL DEFAULT 0,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_vision_edits_did
      ON vision_edits (agent_did, created_at DESC);
  `);
}

// ----------------------------------------------------------------------------
// Providers
// ----------------------------------------------------------------------------
async function callImageGen(provider, model, prompt, opts) {
  const { negative_prompt, width = 1024, height = 1024 } = opts || {};
  if (provider === 'openai' && process.env.OPENAI_API_KEY) {
    try {
      const r = await fetch('https://api.openai.com/v1/images/generations', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'authorization': `Bearer ${process.env.OPENAI_API_KEY}`
        },
        body: JSON.stringify({
          model: 'dall-e-3', prompt,
          size: `${width}x${height}`, n: 1
        })
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.error?.message || `openai_${r.status}`);
      return { image_url: j?.data?.[0]?.url || null };
    } catch (e) { return { error: e.message, image_url: null }; }
  }
  if (provider === 'fal' && process.env.FAL_API_KEY) {
    try {
      const endpoint = model === 'sdxl'
        ? 'https://fal.run/fal-ai/fast-sdxl'
        : 'https://fal.run/fal-ai/flux/dev';
      const r = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'authorization': `Key ${process.env.FAL_API_KEY}`
        },
        body: JSON.stringify({
          prompt, negative_prompt,
          image_size: { width, height }
        })
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.detail || `fal_${r.status}`);
      return { image_url: j?.images?.[0]?.url || j?.image?.url || null };
    } catch (e) { return { error: e.message, image_url: null }; }
  }
  return { error: 'vision not configured', image_url: null };
}

async function callVisionAnalyze(imageUrl, kind, question) {
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      const promptByKind = {
        ocr: 'Extract all text visible in this image. Return only the text.',
        caption: 'Generate a detailed caption for this image.',
        objects: 'List all objects in this image as a JSON array of strings.',
        faces: 'Describe any visible faces (count, expressions, demographics). Do not identify people.',
        qa: question || 'Describe this image.'
      };
      const userPrompt = promptByKind[kind] || question || 'Describe this image.';
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-3-5-sonnet-20241022',
          max_tokens: 1024,
          messages: [{
            role: 'user',
            content: [
              { type: 'image', source: { type: 'url', url: imageUrl } },
              { type: 'text', text: userPrompt }
            ]
          }]
        })
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.error?.message || `anthropic_${r.status}`);
      const text = Array.isArray(j?.content)
        ? j.content.filter(b => b.type === 'text').map(b => b.text).join('')
        : '';
      return { text, raw: j };
    } catch (e) { return { error: e.message }; }
  }
  if (process.env.OPENAI_API_KEY) {
    try {
      const userPrompt = kind === 'ocr' ? 'Extract all text from this image.' :
        kind === 'caption' ? 'Caption this image in detail.' :
        kind === 'objects' ? 'List all objects as a JSON array.' :
        (question || 'Describe this image.');
      const r = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'authorization': `Bearer ${process.env.OPENAI_API_KEY}`
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          max_tokens: 1024,
          messages: [{
            role: 'user',
            content: [
              { type: 'text', text: userPrompt },
              { type: 'image_url', image_url: { url: imageUrl } }
            ]
          }]
        })
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.error?.message || `openai_${r.status}`);
      const text = j?.choices?.[0]?.message?.content || '';
      return { text, raw: j };
    } catch (e) { return { error: e.message }; }
  }
  return { error: 'vision not configured', text: '' };
}

async function callInpaint(sourceUrl, maskUrl, prompt) {
  if (process.env.OPENAI_API_KEY) {
    // OpenAI edits API would require multipart; we'll skip and recommend FAL or stub.
  }
  if (process.env.FAL_API_KEY) {
    try {
      const r = await fetch('https://fal.run/fal-ai/inpaint', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'authorization': `Key ${process.env.FAL_API_KEY}`
        },
        body: JSON.stringify({ image_url: sourceUrl, mask_url: maskUrl, prompt })
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.detail || `fal_${r.status}`);
      return { result_url: j?.image?.url || j?.images?.[0]?.url || null };
    } catch (e) { return { error: e.message, result_url: null }; }
  }
  return { error: 'inpaint not configured', result_url: null };
}

// ----------------------------------------------------------------------------
// Schemas
// ----------------------------------------------------------------------------
const GenSchema = z.object({
  prompt: z.string().min(1).max(8192),
  negative_prompt: z.string().max(8192).optional(),
  model: z.enum(['dalle3', 'sdxl', 'flux']).optional(),
  width: z.number().int().min(64).max(2048).optional(),
  height: z.number().int().min(64).max(2048).optional()
});
const AnalyzeSchema = z.object({
  image_url: z.string().min(1).max(8192),
  kind: z.enum(['ocr', 'caption', 'objects', 'faces', 'qa']),
  question: z.string().max(4096).optional()
});
const EditSchema = z.object({
  source_image_url: z.string().min(1).max(8192),
  mask_url: z.string().max(8192).optional(),
  prompt: z.string().min(1).max(4096)
});
const OcrSchema = z.object({ image_url: z.string().min(1).max(8192) });

// ----------------------------------------------------------------------------
// Routes
// ----------------------------------------------------------------------------
function registerVisionRoutes(app, pool, verifyAgentAuth, auditChain) {
  const cost = tryRequire('./cost');

  function chargeCost(did, provider, cents, refId, resourceType) {
    if (!cost || typeof cost.recordCost !== 'function') return;
    cost.recordCost(pool, {
      agent_did: did, resource_type: resourceType, provider,
      amount_cents: cents, reference_id: refId
    }).catch(e => console.warn('[vision.cost]', e.message));
  }

  // POST generate
  app.post('/v1/agents/:did/vision/generate', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const parse = GenSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;

      const sel = pickGenProvider(d.model);
      const out = await callImageGen(sel.provider, sel.model, d.prompt, {
        negative_prompt: d.negative_prompt, width: d.width, height: d.height
      });
      const costCents = GEN_COST[d.model] || GEN_COST.default;
      const genId = genGenerationId();

      await pool.query(`
        INSERT INTO vision_generations
        (generation_id, agent_did, prompt, negative_prompt, model,
         width, height, image_url, cost_cents)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      `, [genId, did, d.prompt, d.negative_prompt || null, d.model || sel.model,
          d.width || 1024, d.height || 1024, out.image_url, costCents]);

      await auditChain.append({
        event_type: 'vision.image_generated',
        generation_id: genId, agent_did: did,
        provider: sel.provider, model: d.model || sel.model,
        cost_cents: costCents,
        timestamp: new Date().toISOString()
      });

      chargeCost(did, sel.provider, costCents, genId, 'vision_generation');

      return res.status(201).json({
        generation_id: genId, image_url: out.image_url,
        model: d.model || sel.model, provider: sel.provider,
        cost_cents: costCents, error: out.error || null
      });
    } catch (e) {
      console.error('[vision.generate]', e);
      return res.status(500).json({ error: 'generate_failed', message: e.message });
    }
  });

  // POST analyze
  app.post('/v1/agents/:did/vision/analyze', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const parse = AnalyzeSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;

      const out = await callVisionAnalyze(d.image_url, d.kind, d.question);
      const provider = process.env.ANTHROPIC_API_KEY ? 'anthropic' :
                       process.env.OPENAI_API_KEY ? 'openai' : 'stub';
      const result = { text: out.text || '', raw: undefined };
      const analysisId = genAnalysisId();

      await pool.query(`
        INSERT INTO vision_analyses
        (analysis_id, agent_did, image_url, kind, question, result, cost_cents)
        VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)
      `, [analysisId, did, d.image_url, d.kind, d.question || null,
          JSON.stringify(result), ANALYSIS_COST_CENTS]);

      await auditChain.append({
        event_type: 'vision.image_analyzed',
        analysis_id: analysisId, agent_did: did, kind: d.kind, provider,
        cost_cents: ANALYSIS_COST_CENTS,
        timestamp: new Date().toISOString()
      });

      chargeCost(did, provider, ANALYSIS_COST_CENTS, analysisId, 'vision_analysis');

      return res.status(201).json({
        analysis_id: analysisId, kind: d.kind, result, provider,
        cost_cents: ANALYSIS_COST_CENTS, error: out.error || null
      });
    } catch (e) {
      console.error('[vision.analyze]', e);
      return res.status(500).json({ error: 'analyze_failed', message: e.message });
    }
  });

  // POST edit (inpaint)
  app.post('/v1/agents/:did/vision/edit', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const parse = EditSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;

      const out = await callInpaint(d.source_image_url, d.mask_url, d.prompt);
      const editId = genEditId();
      const costCents = GEN_COST.default;
      const provider = process.env.FAL_API_KEY ? 'fal' : 'stub';

      await pool.query(`
        INSERT INTO vision_edits
        (edit_id, agent_did, source_image_url, mask_url, prompt, result_url, cost_cents)
        VALUES ($1,$2,$3,$4,$5,$6,$7)
      `, [editId, did, d.source_image_url, d.mask_url || null,
          d.prompt, out.result_url, costCents]);

      await auditChain.append({
        event_type: 'vision.image_edited',
        edit_id: editId, agent_did: did, provider, cost_cents: costCents,
        timestamp: new Date().toISOString()
      });

      chargeCost(did, provider, costCents, editId, 'vision_edit');

      return res.status(201).json({
        edit_id: editId, result_url: out.result_url, provider,
        cost_cents: costCents, error: out.error || null
      });
    } catch (e) {
      console.error('[vision.edit]', e);
      return res.status(500).json({ error: 'edit_failed', message: e.message });
    }
  });

  // POST ocr — shorthand for analyze {kind:'ocr'}
  app.post('/v1/agents/:did/vision/ocr', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const parse = OcrSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });

      const out = await callVisionAnalyze(parse.data.image_url, 'ocr');
      const provider = process.env.ANTHROPIC_API_KEY ? 'anthropic' :
                       process.env.OPENAI_API_KEY ? 'openai' : 'stub';
      const result = { text: out.text || '' };
      const analysisId = genAnalysisId();

      await pool.query(`
        INSERT INTO vision_analyses
        (analysis_id, agent_did, image_url, kind, result, cost_cents)
        VALUES ($1,$2,$3,'ocr',$4::jsonb,$5)
      `, [analysisId, did, parse.data.image_url, JSON.stringify(result), ANALYSIS_COST_CENTS]);

      await auditChain.append({
        event_type: 'vision.ocr_run',
        analysis_id: analysisId, agent_did: did, provider,
        timestamp: new Date().toISOString()
      });

      chargeCost(did, provider, ANALYSIS_COST_CENTS, analysisId, 'vision_ocr');

      return res.status(201).json({
        analysis_id: analysisId, text: out.text || '', provider,
        cost_cents: ANALYSIS_COST_CENTS, error: out.error || null
      });
    } catch (e) {
      console.error('[vision.ocr]', e);
      return res.status(500).json({ error: 'ocr_failed', message: e.message });
    }
  });

  // GET generations
  app.get('/v1/agents/:did/vision/generations', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    const r = await pool.query(`
      SELECT generation_id, agent_did, model, width, height,
             image_url, cost_cents, created_at,
             LEFT(prompt, 1024) AS prompt_preview
      FROM vision_generations WHERE agent_did=$1
      ORDER BY created_at DESC LIMIT $2
    `, [did, limit]).catch(() => ({ rows: [] }));
    return res.json({ generations: r.rows, count: r.rows.length });
  });

  // GET analyses
  app.get('/v1/agents/:did/vision/analyses', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    const r = await pool.query(`
      SELECT analysis_id, agent_did, image_url, kind, question,
             result, cost_cents, created_at
      FROM vision_analyses WHERE agent_did=$1
      ORDER BY created_at DESC LIMIT $2
    `, [did, limit]).catch(() => ({ rows: [] }));
    return res.json({ analyses: r.rows, count: r.rows.length });
  });
}

module.exports = {
  migrate,
  registerVisionRoutes,
  pickGenProvider,
  callImageGen,
  callVisionAnalyze,
  callInpaint
};
