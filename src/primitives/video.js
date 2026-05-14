// ============================================================================
// OpenHeab Video — Generation + processing + analysis
// Providers: Runway, Luma, Sora (fallback stub for tests).
// ============================================================================
const express = require('express');
const cryptoLib = require('crypto');
const { z } = require('zod');

function tryRequire(name) {
  try { return require(name); } catch { return null; }
}

function genGenerationId() { return 'vid_' + cryptoLib.randomBytes(12).toString('hex'); }
function genTranscodingId() { return 'vtr_' + cryptoLib.randomBytes(12).toString('hex'); }
function genAnalysisId() { return 'vana_' + cryptoLib.randomBytes(12).toString('hex'); }

// Rough cost per second of generated video, in cents
const VIDEO_GEN_PER_SEC_CENTS = 50;
const VIDEO_ANALYSIS_CENTS = 5;
const VIDEO_TRANSCODE_CENTS = 2;

function pickVideoProvider(model) {
  const m = (model || '').toLowerCase();
  if (m.includes('runway')) return { provider: 'runway', env: 'RUNWAY_API_KEY' };
  if (m.includes('sora')) return { provider: 'sora', env: 'OPENAI_API_KEY' };
  if (m.includes('luma')) return { provider: 'luma', env: 'LUMA_API_KEY' };
  if (process.env.RUNWAY_API_KEY) return { provider: 'runway', env: 'RUNWAY_API_KEY' };
  if (process.env.LUMA_API_KEY) return { provider: 'luma', env: 'LUMA_API_KEY' };
  return { provider: 'stub', env: null };
}

// ----------------------------------------------------------------------------
// Migration
// ----------------------------------------------------------------------------
async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS video_generations (
      generation_id    TEXT PRIMARY KEY,
      agent_did        TEXT NOT NULL,
      prompt           TEXT NOT NULL,
      duration_seconds INTEGER NOT NULL DEFAULT 4,
      resolution       TEXT,
      model            TEXT,
      provider         TEXT,
      provider_ref     TEXT,
      video_url        TEXT,
      cost_cents       INTEGER NOT NULL DEFAULT 0,
      status           TEXT NOT NULL DEFAULT 'pending',
      error            TEXT,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at     TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_video_generations_did
      ON video_generations (agent_did, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_video_generations_status
      ON video_generations (status, created_at DESC);

    CREATE TABLE IF NOT EXISTS video_transcoding (
      transcoding_id  TEXT PRIMARY KEY,
      agent_did       TEXT NOT NULL,
      source_url      TEXT NOT NULL,
      target_format   TEXT NOT NULL,
      target_url      TEXT,
      status          TEXT NOT NULL DEFAULT 'pending',
      cost_cents      INTEGER NOT NULL DEFAULT 0,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at    TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_video_transcoding_did
      ON video_transcoding (agent_did, created_at DESC);

    CREATE TABLE IF NOT EXISTS video_analyses (
      analysis_id TEXT PRIMARY KEY,
      agent_did   TEXT NOT NULL,
      video_url   TEXT NOT NULL,
      kind        TEXT NOT NULL,
      result      JSONB,
      cost_cents  INTEGER NOT NULL DEFAULT 0,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_video_analyses_did
      ON video_analyses (agent_did, created_at DESC);
  `);
}

// ----------------------------------------------------------------------------
// Providers
// ----------------------------------------------------------------------------
async function callVideoGen(provider, prompt, opts) {
  const { duration_seconds = 4, resolution = '1280x720' } = opts || {};
  if (provider === 'runway' && process.env.RUNWAY_API_KEY) {
    try {
      const r = await fetch('https://api.dev.runwayml.com/v1/image_to_video', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'authorization': `Bearer ${process.env.RUNWAY_API_KEY}`,
          'x-runway-version': '2024-11-06'
        },
        body: JSON.stringify({
          promptText: prompt,
          model: 'gen3a_turbo',
          duration: duration_seconds,
          ratio: resolution
        })
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.error || `runway_${r.status}`);
      return { provider_ref: j.id || null, status: 'processing', video_url: null };
    } catch (e) { return { error: e.message, status: 'failed' }; }
  }
  if (provider === 'luma' && process.env.LUMA_API_KEY) {
    try {
      const r = await fetch('https://api.lumalabs.ai/dream-machine/v1/generations', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'authorization': `Bearer ${process.env.LUMA_API_KEY}`
        },
        body: JSON.stringify({ prompt, aspect_ratio: '16:9' })
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.detail || `luma_${r.status}`);
      return { provider_ref: j.id || null, status: 'processing', video_url: null };
    } catch (e) { return { error: e.message, status: 'failed' }; }
  }
  return { error: 'video not configured', status: 'failed', video_url: null };
}

async function callVideoStatus(provider, providerRef) {
  if (provider === 'runway' && process.env.RUNWAY_API_KEY && providerRef) {
    try {
      const r = await fetch(`https://api.dev.runwayml.com/v1/tasks/${providerRef}`, {
        headers: {
          'authorization': `Bearer ${process.env.RUNWAY_API_KEY}`,
          'x-runway-version': '2024-11-06'
        }
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.error || `runway_${r.status}`);
      const status = j?.status === 'SUCCEEDED' ? 'complete' :
                     j?.status === 'FAILED' ? 'failed' : 'processing';
      return { status, video_url: j?.output?.[0] || null };
    } catch (e) { return { error: e.message }; }
  }
  if (provider === 'luma' && process.env.LUMA_API_KEY && providerRef) {
    try {
      const r = await fetch(`https://api.lumalabs.ai/dream-machine/v1/generations/${providerRef}`, {
        headers: { 'authorization': `Bearer ${process.env.LUMA_API_KEY}` }
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.detail || `luma_${r.status}`);
      const status = j?.state === 'completed' ? 'complete' :
                     j?.state === 'failed' ? 'failed' : 'processing';
      return { status, video_url: j?.assets?.video || null };
    } catch (e) { return { error: e.message }; }
  }
  return { status: 'processing', video_url: null };
}

// ----------------------------------------------------------------------------
// Schemas
// ----------------------------------------------------------------------------
const GenSchema = z.object({
  prompt: z.string().min(1).max(8192),
  duration_seconds: z.number().int().min(1).max(60).optional(),
  resolution: z.string().max(32).optional(),
  model: z.enum(['runway', 'sora', 'luma']).optional()
});
const AnalyzeSchema = z.object({
  video_url: z.string().min(1).max(8192),
  kind: z.enum(['transcript', 'summary', 'scene-detection'])
});
const TranscodeSchema = z.object({
  source_url: z.string().min(1).max(8192),
  target_format: z.string().min(1).max(32)
});

// ----------------------------------------------------------------------------
// Routes
// ----------------------------------------------------------------------------
function registerVideoRoutes(app, pool, verifyAgentAuth, auditChain) {
  const cost = tryRequire('./cost');

  function chargeCost(did, provider, cents, refId, resourceType) {
    if (!cost || typeof cost.recordCost !== 'function') return;
    cost.recordCost(pool, {
      agent_did: did, resource_type: resourceType, provider,
      amount_cents: cents, reference_id: refId
    }).catch(e => console.warn('[video.cost]', e.message));
  }

  // POST generate
  app.post('/v1/agents/:did/video/generate', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const parse = GenSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;

      const sel = pickVideoProvider(d.model);
      const dur = d.duration_seconds || 4;
      const out = await callVideoGen(sel.provider, d.prompt, {
        duration_seconds: dur, resolution: d.resolution
      });
      const costCents = VIDEO_GEN_PER_SEC_CENTS * dur;
      const genId = genGenerationId();
      const status = out.status || (out.error ? 'failed' : 'pending');

      await pool.query(`
        INSERT INTO video_generations
        (generation_id, agent_did, prompt, duration_seconds, resolution,
         model, provider, provider_ref, video_url, cost_cents, status, error)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      `, [genId, did, d.prompt, dur, d.resolution || null,
          d.model || sel.provider, sel.provider, out.provider_ref || null,
          out.video_url || null, costCents, status, out.error || null]);

      await auditChain.append({
        event_type: 'video.generation_started',
        generation_id: genId, agent_did: did,
        provider: sel.provider, model: d.model, status,
        cost_cents: costCents,
        timestamp: new Date().toISOString()
      });

      chargeCost(did, sel.provider, costCents, genId, 'video_generation');

      return res.status(201).json({
        generation_id: genId, status, provider: sel.provider,
        video_url: out.video_url || null, cost_cents: costCents,
        error: out.error || null
      });
    } catch (e) {
      console.error('[video.generate]', e);
      return res.status(500).json({ error: 'generate_failed', message: e.message });
    }
  });

  // GET status poll
  app.get('/v1/agents/:did/video/generations/:id', async (req, res) => {
    try {
      const did = req.params.did;
      const genId = req.params.id;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const r = await pool.query(`
        SELECT generation_id, agent_did, prompt, duration_seconds, resolution,
               model, provider, provider_ref, video_url, cost_cents, status,
               error, created_at, completed_at
        FROM video_generations WHERE generation_id=$1 AND agent_did=$2
      `, [genId, did]).catch(() => ({ rows: [] }));
      if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });

      const row = r.rows[0];
      if (row.status === 'pending' || row.status === 'processing') {
        const upd = await callVideoStatus(row.provider, row.provider_ref);
        if (upd.status && upd.status !== row.status) {
          await pool.query(`
            UPDATE video_generations
            SET status=$2, video_url=COALESCE($3, video_url),
                completed_at=CASE WHEN $2 IN ('complete','failed') THEN NOW() ELSE completed_at END
            WHERE generation_id=$1
          `, [genId, upd.status, upd.video_url || null]);
          row.status = upd.status;
          row.video_url = upd.video_url || row.video_url;
          if (upd.status === 'complete' || upd.status === 'failed') {
            row.completed_at = new Date().toISOString();
            await auditChain.append({
              event_type: 'video.generation_' + upd.status,
              generation_id: genId, agent_did: did,
              timestamp: new Date().toISOString()
            });
          }
        }
      }
      return res.json(row);
    } catch (e) {
      console.error('[video.status]', e);
      return res.status(500).json({ error: 'status_failed', message: e.message });
    }
  });

  // POST analyze
  app.post('/v1/agents/:did/video/analyze', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const parse = AnalyzeSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;

      const result = { kind: d.kind, note: 'video analysis not configured', text: '' };
      const analysisId = genAnalysisId();
      const provider = process.env.OPENAI_API_KEY ? 'openai' : 'stub';

      await pool.query(`
        INSERT INTO video_analyses
        (analysis_id, agent_did, video_url, kind, result, cost_cents)
        VALUES ($1,$2,$3,$4,$5::jsonb,$6)
      `, [analysisId, did, d.video_url, d.kind, JSON.stringify(result), VIDEO_ANALYSIS_CENTS]);

      await auditChain.append({
        event_type: 'video.analysis_completed',
        analysis_id: analysisId, agent_did: did, kind: d.kind,
        cost_cents: VIDEO_ANALYSIS_CENTS,
        timestamp: new Date().toISOString()
      });

      chargeCost(did, provider, VIDEO_ANALYSIS_CENTS, analysisId, 'video_analysis');

      return res.status(201).json({
        analysis_id: analysisId, kind: d.kind, result,
        provider, cost_cents: VIDEO_ANALYSIS_CENTS
      });
    } catch (e) {
      console.error('[video.analyze]', e);
      return res.status(500).json({ error: 'analyze_failed', message: e.message });
    }
  });

  // POST transcode
  app.post('/v1/agents/:did/video/transcode', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const parse = TranscodeSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;

      const transcodingId = genTranscodingId();
      // Stub transcode: store request, mark pending — workers can poll
      await pool.query(`
        INSERT INTO video_transcoding
        (transcoding_id, agent_did, source_url, target_format, target_url, status, cost_cents)
        VALUES ($1,$2,$3,$4,$5,'pending',$6)
      `, [transcodingId, did, d.source_url, d.target_format, null, VIDEO_TRANSCODE_CENTS]);

      await auditChain.append({
        event_type: 'video.transcode_requested',
        transcoding_id: transcodingId, agent_did: did,
        target_format: d.target_format,
        cost_cents: VIDEO_TRANSCODE_CENTS,
        timestamp: new Date().toISOString()
      });

      chargeCost(did, 'stub', VIDEO_TRANSCODE_CENTS, transcodingId, 'video_transcode');

      return res.status(201).json({
        transcoding_id: transcodingId, status: 'pending',
        source_url: d.source_url, target_format: d.target_format,
        cost_cents: VIDEO_TRANSCODE_CENTS
      });
    } catch (e) {
      console.error('[video.transcode]', e);
      return res.status(500).json({ error: 'transcode_failed', message: e.message });
    }
  });

  // GET generations
  app.get('/v1/agents/:did/video/generations', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    const r = await pool.query(`
      SELECT generation_id, agent_did, model, provider, duration_seconds,
             resolution, video_url, cost_cents, status, created_at, completed_at,
             LEFT(prompt, 1024) AS prompt_preview
      FROM video_generations WHERE agent_did=$1
      ORDER BY created_at DESC LIMIT $2
    `, [did, limit]).catch(() => ({ rows: [] }));
    return res.json({ generations: r.rows, count: r.rows.length });
  });
}

module.exports = {
  migrate,
  registerVideoRoutes,
  pickVideoProvider,
  callVideoGen,
  callVideoStatus
};
