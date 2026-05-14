// ============================================================================
// OpenHeab Voice — TTS + STT + voice cloning
// Providers: ElevenLabs, Cartesia, OpenAI TTS, Whisper, Deepgram.
// ============================================================================
const express = require('express');
const cryptoLib = require('crypto');
const { z } = require('zod');

function tryRequire(name) {
  try { return require(name); } catch { return null; }
}

function pickTtsProvider(preferred) {
  if (preferred) return preferred;
  if (process.env.ELEVENLABS_API_KEY) return 'elevenlabs';
  if (process.env.CARTESIA_API_KEY) return 'cartesia';
  if (process.env.OPENAI_API_KEY) return 'openai';
  return 'stub';
}
function pickSttProvider(preferred) {
  if (preferred) return preferred;
  if (process.env.OPENAI_API_KEY) return 'whisper';
  if (process.env.DEEPGRAM_API_KEY) return 'deepgram';
  return 'stub';
}

function genSynthesisId() { return 'tts_' + cryptoLib.randomBytes(12).toString('hex'); }
function genTranscriptionId() { return 'stt_' + cryptoLib.randomBytes(12).toString('hex'); }
function genCloneId() { return 'voice_' + cryptoLib.randomBytes(12).toString('hex'); }

// Approximate pricing
const TTS_PRICE_PER_CHAR_CENTS = 0.03;   // $0.0003/char
const STT_PRICE_PER_MIN_CENTS = 0.6;     // $0.006/min

// ----------------------------------------------------------------------------
// Migration
// ----------------------------------------------------------------------------
async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS voice_syntheses (
      synthesis_id     TEXT PRIMARY KEY,
      agent_did        TEXT NOT NULL,
      text             TEXT NOT NULL,
      voice_id         TEXT,
      language         TEXT,
      audio_url        TEXT,
      audio_bytes      BIGINT,
      duration_seconds REAL,
      provider         TEXT NOT NULL,
      cost_cents       INTEGER NOT NULL DEFAULT 0,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_voice_syntheses_did
      ON voice_syntheses (agent_did, created_at DESC);

    CREATE TABLE IF NOT EXISTS voice_transcriptions (
      transcription_id TEXT PRIMARY KEY,
      agent_did        TEXT NOT NULL,
      audio_url        TEXT NOT NULL,
      transcript       TEXT,
      language         TEXT,
      duration_seconds REAL,
      provider         TEXT NOT NULL,
      cost_cents       INTEGER NOT NULL DEFAULT 0,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_voice_transcriptions_did
      ON voice_transcriptions (agent_did, created_at DESC);

    CREATE TABLE IF NOT EXISTS voice_clones (
      clone_id          TEXT PRIMARY KEY,
      agent_did         TEXT NOT NULL,
      name              TEXT NOT NULL,
      sample_audio_url  TEXT NOT NULL,
      provider          TEXT NOT NULL,
      provider_voice_id TEXT,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_voice_clones_did
      ON voice_clones (agent_did, created_at DESC);
  `);
}

// ----------------------------------------------------------------------------
// Providers
// ----------------------------------------------------------------------------
async function callTts(provider, text, voiceId, language) {
  if (provider === 'elevenlabs' && process.env.ELEVENLABS_API_KEY) {
    try {
      const vid = voiceId || '21m00Tcm4TlvDq8ikWAM';
      const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${vid}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'xi-api-key': process.env.ELEVENLABS_API_KEY,
          'accept': 'audio/mpeg'
        },
        body: JSON.stringify({ text, model_id: 'eleven_turbo_v2_5' })
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j?.detail?.message || `elevenlabs_${r.status}`);
      }
      const buf = Buffer.from(await r.arrayBuffer());
      return {
        audio_url: `data:audio/mpeg;base64,${buf.toString('base64')}`,
        audio_bytes: buf.length,
        duration_seconds: Math.max(1, Math.round(text.length / 15))
      };
    } catch (e) { return { error: e.message }; }
  }
  if (provider === 'openai' && process.env.OPENAI_API_KEY) {
    try {
      const r = await fetch('https://api.openai.com/v1/audio/speech', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'authorization': `Bearer ${process.env.OPENAI_API_KEY}`
        },
        body: JSON.stringify({
          model: 'tts-1',
          input: text,
          voice: voiceId || 'alloy',
          response_format: 'mp3'
        })
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j?.error?.message || `openai_${r.status}`);
      }
      const buf = Buffer.from(await r.arrayBuffer());
      return {
        audio_url: `data:audio/mpeg;base64,${buf.toString('base64')}`,
        audio_bytes: buf.length,
        duration_seconds: Math.max(1, Math.round(text.length / 15))
      };
    } catch (e) { return { error: e.message }; }
  }
  if (provider === 'cartesia' && process.env.CARTESIA_API_KEY) {
    try {
      const r = await fetch('https://api.cartesia.ai/tts/bytes', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': process.env.CARTESIA_API_KEY,
          'cartesia-version': '2024-06-10'
        },
        body: JSON.stringify({
          model_id: 'sonic-english',
          transcript: text,
          voice: { mode: 'id', id: voiceId || 'a0e99841-438c-4a64-b679-ae501e7d6091' },
          output_format: { container: 'mp3', encoding: 'mp3', sample_rate: 44100 }
        })
      });
      if (!r.ok) throw new Error(`cartesia_${r.status}`);
      const buf = Buffer.from(await r.arrayBuffer());
      return {
        audio_url: `data:audio/mpeg;base64,${buf.toString('base64')}`,
        audio_bytes: buf.length,
        duration_seconds: Math.max(1, Math.round(text.length / 15))
      };
    } catch (e) { return { error: e.message }; }
  }
  return { error: 'voice not configured', audio_url: null, audio_bytes: 0, duration_seconds: 0 };
}

async function callStt(provider, audioUrl, language) {
  if (provider === 'whisper' && process.env.OPENAI_API_KEY) {
    try {
      // OpenAI whisper expects multipart; fetch the audio first
      const audioResp = await fetch(audioUrl);
      if (!audioResp.ok) throw new Error('audio_fetch_failed');
      const buf = Buffer.from(await audioResp.arrayBuffer());
      const boundary = '----openheab' + cryptoLib.randomBytes(8).toString('hex');
      const parts = [];
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-1\r\n`));
      if (language) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\n${language}\r\n`));
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.mp3"\r\nContent-Type: audio/mpeg\r\n\r\n`));
      parts.push(buf);
      parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
      const body = Buffer.concat(parts);
      const r = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: {
          'content-type': `multipart/form-data; boundary=${boundary}`,
          'authorization': `Bearer ${process.env.OPENAI_API_KEY}`
        },
        body
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.error?.message || `whisper_${r.status}`);
      const dur = Math.max(1, Math.round(buf.length / 16000));
      return { transcript: j.text || '', language: j.language || language, duration_seconds: dur };
    } catch (e) { return { error: e.message, transcript: null }; }
  }
  if (provider === 'deepgram' && process.env.DEEPGRAM_API_KEY) {
    try {
      const r = await fetch('https://api.deepgram.com/v1/listen?model=nova-2', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'authorization': `Token ${process.env.DEEPGRAM_API_KEY}`
        },
        body: JSON.stringify({ url: audioUrl })
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.err_msg || `deepgram_${r.status}`);
      const transcript = j?.results?.channels?.[0]?.alternatives?.[0]?.transcript || '';
      const dur = j?.metadata?.duration || 1;
      return { transcript, language: j?.results?.channels?.[0]?.detected_language || language, duration_seconds: dur };
    } catch (e) { return { error: e.message, transcript: null }; }
  }
  return { error: 'stt not configured', transcript: null, duration_seconds: 0 };
}

async function callClone(provider, name, sampleUrl) {
  if (provider === 'elevenlabs' && process.env.ELEVENLABS_API_KEY) {
    try {
      const r = await fetch('https://api.elevenlabs.io/v1/voices/add', {
        method: 'POST',
        headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY },
        body: JSON.stringify({ name, files: [sampleUrl] })
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.detail?.message || `elevenlabs_${r.status}`);
      return { provider_voice_id: j.voice_id || null };
    } catch (e) { return { error: e.message }; }
  }
  return { error: 'voice cloning not configured', provider_voice_id: null };
}

// ----------------------------------------------------------------------------
// Schemas
// ----------------------------------------------------------------------------
const TtsSchema = z.object({
  text: z.string().min(1).max(50_000),
  voice_id: z.string().max(128).optional(),
  language: z.string().max(16).optional(),
  provider: z.enum(['elevenlabs', 'cartesia', 'openai']).optional()
});
const SttSchema = z.object({
  audio_url: z.string().min(1).max(8192),
  language: z.string().max(16).optional(),
  provider: z.enum(['whisper', 'deepgram']).optional()
});
const CloneSchema = z.object({
  name: z.string().min(1).max(128),
  sample_audio_url: z.string().min(1).max(8192),
  provider: z.enum(['elevenlabs']).optional()
});

// ----------------------------------------------------------------------------
// Routes
// ----------------------------------------------------------------------------
function registerVoiceRoutes(app, pool, verifyAgentAuth, auditChain) {
  const cost = tryRequire('./cost');

  // POST tts
  app.post('/v1/agents/:did/voice/tts', express.json({ limit: '4mb' }), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const parse = TtsSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;

      const provider = pickTtsProvider(d.provider);
      const result = await callTts(provider, d.text, d.voice_id, d.language);
      const cost_cents = Math.max(1, Math.ceil(d.text.length * TTS_PRICE_PER_CHAR_CENTS));
      const synthId = genSynthesisId();

      await pool.query(`
        INSERT INTO voice_syntheses
        (synthesis_id, agent_did, text, voice_id, language, audio_url,
         audio_bytes, duration_seconds, provider, cost_cents)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      `, [synthId, did, d.text, d.voice_id || null, d.language || null,
          result.audio_url || null, result.audio_bytes || 0,
          result.duration_seconds || 0, provider, cost_cents]);

      await auditChain.append({
        event_type: 'voice.synthesis_created',
        synthesis_id: synthId, agent_did: did, provider,
        char_count: d.text.length, cost_cents,
        timestamp: new Date().toISOString()
      });

      if (cost && typeof cost.recordCost === 'function') {
        try {
          await cost.recordCost(pool, {
            agent_did: did, resource_type: 'voice_tts', provider,
            amount_cents: cost_cents, units: d.text.length, unit_type: 'char',
            reference_id: synthId
          });
        } catch (e) { console.warn('[voice.cost]', e.message); }
      }

      return res.status(201).json({
        synthesis_id: synthId, audio_url: result.audio_url,
        audio_bytes: result.audio_bytes || 0,
        duration_seconds: result.duration_seconds || 0,
        provider, cost_cents, error: result.error || null
      });
    } catch (e) {
      console.error('[voice.tts]', e);
      return res.status(500).json({ error: 'tts_failed', message: e.message });
    }
  });

  // POST stt
  app.post('/v1/agents/:did/voice/stt', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const parse = SttSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;

      const provider = pickSttProvider(d.provider);
      const result = await callStt(provider, d.audio_url, d.language);
      const minutes = (result.duration_seconds || 0) / 60;
      const cost_cents = Math.max(1, Math.ceil(minutes * STT_PRICE_PER_MIN_CENTS));
      const transId = genTranscriptionId();

      await pool.query(`
        INSERT INTO voice_transcriptions
        (transcription_id, agent_did, audio_url, transcript, language,
         duration_seconds, provider, cost_cents)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      `, [transId, did, d.audio_url, result.transcript || null,
          result.language || d.language || null,
          result.duration_seconds || 0, provider, cost_cents]);

      await auditChain.append({
        event_type: 'voice.transcription_created',
        transcription_id: transId, agent_did: did, provider, cost_cents,
        timestamp: new Date().toISOString()
      });

      if (cost && typeof cost.recordCost === 'function') {
        try {
          await cost.recordCost(pool, {
            agent_did: did, resource_type: 'voice_stt', provider,
            amount_cents: cost_cents,
            units: Math.round(result.duration_seconds || 0), unit_type: 'sec',
            reference_id: transId
          });
        } catch (e) { console.warn('[voice.cost]', e.message); }
      }

      return res.status(201).json({
        transcription_id: transId, transcript: result.transcript,
        language: result.language, duration_seconds: result.duration_seconds || 0,
        provider, cost_cents, error: result.error || null
      });
    } catch (e) {
      console.error('[voice.stt]', e);
      return res.status(500).json({ error: 'stt_failed', message: e.message });
    }
  });

  // POST clone
  app.post('/v1/agents/:did/voice/clone', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const parse = CloneSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;

      const provider = d.provider || (process.env.ELEVENLABS_API_KEY ? 'elevenlabs' : 'stub');
      const cloneId = genCloneId();
      const result = await callClone(provider, d.name, d.sample_audio_url);

      await pool.query(`
        INSERT INTO voice_clones
        (clone_id, agent_did, name, sample_audio_url, provider, provider_voice_id)
        VALUES ($1,$2,$3,$4,$5,$6)
      `, [cloneId, did, d.name, d.sample_audio_url, provider, result.provider_voice_id || null]);

      await auditChain.append({
        event_type: 'voice.clone_created',
        clone_id: cloneId, agent_did: did, provider,
        timestamp: new Date().toISOString()
      });

      return res.status(201).json({
        clone_id: cloneId, name: d.name, provider,
        provider_voice_id: result.provider_voice_id, error: result.error || null
      });
    } catch (e) {
      console.error('[voice.clone]', e);
      return res.status(500).json({ error: 'clone_failed', message: e.message });
    }
  });

  // GET syntheses
  app.get('/v1/agents/:did/voice/syntheses', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    const r = await pool.query(`
      SELECT synthesis_id, agent_did, voice_id, language, audio_bytes,
             duration_seconds, provider, cost_cents, created_at,
             LEFT(text, 256) AS text_preview
      FROM voice_syntheses WHERE agent_did=$1
      ORDER BY created_at DESC LIMIT $2
    `, [did, limit]).catch(() => ({ rows: [] }));
    return res.json({ syntheses: r.rows, count: r.rows.length });
  });

  // GET transcriptions
  app.get('/v1/agents/:did/voice/transcriptions', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    const r = await pool.query(`
      SELECT transcription_id, agent_did, audio_url, language,
             duration_seconds, provider, cost_cents, created_at,
             LEFT(transcript, 1024) AS transcript_preview
      FROM voice_transcriptions WHERE agent_did=$1
      ORDER BY created_at DESC LIMIT $2
    `, [did, limit]).catch(() => ({ rows: [] }));
    return res.json({ transcriptions: r.rows, count: r.rows.length });
  });
}

module.exports = {
  migrate,
  registerVoiceRoutes,
  pickTtsProvider,
  pickSttProvider,
  callTts,
  callStt,
  callClone
};
