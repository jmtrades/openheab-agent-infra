// ============================================================================
// OpenHeab Translate — Multi-language translation + glossaries + detection
// Providers: deepl / google / openai
// ============================================================================
const express = require('express');
const cryptoLib = require('crypto');
const { z } = require('zod');

const SUPPORTED_LANGUAGES = {
  en: 'English',     es: 'Spanish',     fr: 'French',      de: 'German',
  it: 'Italian',     pt: 'Portuguese',  nl: 'Dutch',       ru: 'Russian',
  zh: 'Chinese',     ja: 'Japanese',    ko: 'Korean',      ar: 'Arabic',
  hi: 'Hindi',       bn: 'Bengali',     pa: 'Punjabi',     ur: 'Urdu',
  tr: 'Turkish',     pl: 'Polish',      uk: 'Ukrainian',   cs: 'Czech',
  sv: 'Swedish',     no: 'Norwegian',   da: 'Danish',      fi: 'Finnish',
  el: 'Greek',       he: 'Hebrew',      th: 'Thai',        vi: 'Vietnamese',
  id: 'Indonesian',  ms: 'Malay',       fil: 'Filipino',   ro: 'Romanian',
  hu: 'Hungarian',   bg: 'Bulgarian',   sk: 'Slovak',      sl: 'Slovenian',
  hr: 'Croatian',    sr: 'Serbian',     lt: 'Lithuanian',  lv: 'Latvian',
  et: 'Estonian',    fa: 'Persian',     sw: 'Swahili',     af: 'Afrikaans',
  is: 'Icelandic',   ga: 'Irish',       cy: 'Welsh',       eu: 'Basque',
  ca: 'Catalan',     gl: 'Galician',    mt: 'Maltese',     mk: 'Macedonian',
  sq: 'Albanian',    bs: 'Bosnian',     am: 'Amharic',     ta: 'Tamil',
  te: 'Telugu',      ml: 'Malayalam',   kn: 'Kannada',     mr: 'Marathi',
  gu: 'Gujarati'
};

const TRANSLATE_COST_CENTS = parseInt(process.env.TRANSLATE_COST_CENTS || '1');
const DETECT_COST_CENTS = parseInt(process.env.TRANSLATE_DETECT_COST_CENTS || '1');

// ----------------------------------------------------------------------------
// Migration
// ----------------------------------------------------------------------------
async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS translations (
      translation_id   TEXT PRIMARY KEY,
      agent_did        TEXT,
      source_text      TEXT NOT NULL,
      source_lang      TEXT,
      target_lang      TEXT NOT NULL,
      translated_text  TEXT,
      provider         TEXT,
      glossary_id      TEXT,
      cost_cents       INTEGER NOT NULL DEFAULT 0,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_translations_agent ON translations (agent_did, created_at DESC);

    CREATE TABLE IF NOT EXISTS glossaries (
      glossary_id   TEXT PRIMARY KEY,
      agent_did     TEXT NOT NULL,
      name          TEXT NOT NULL,
      source_lang   TEXT NOT NULL,
      target_lang   TEXT NOT NULL,
      entries       JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_glossaries_agent ON glossaries (agent_did);

    CREATE TABLE IF NOT EXISTS language_detections (
      detection_id   TEXT PRIMARY KEY,
      agent_did      TEXT,
      sample_text    TEXT,
      detected_lang  TEXT,
      confidence     REAL,
      provider       TEXT,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `).catch(() => {});
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------
function genId(prefix) {
  return `${prefix}_${cryptoLib.randomBytes(12).toString('hex')}`;
}

function chooseProvider(requested) {
  if (requested === 'deepl' && process.env.DEEPL_API_KEY) return 'deepl';
  if (requested === 'google' && process.env.GOOGLE_API_KEY) return 'google';
  if (requested === 'openai' && process.env.OPENAI_API_KEY) return 'openai';
  if (process.env.DEEPL_API_KEY) return 'deepl';
  if (process.env.GOOGLE_API_KEY) return 'google';
  if (process.env.OPENAI_API_KEY) return 'openai';
  return null;
}

async function translateText(text, targetLang, sourceLang, requestedProvider, glossaryEntries) {
  if (!text) return { translated_text: '', provider: null };
  const provider = chooseProvider(requestedProvider);
  if (!provider) {
    return { translated_text: text, provider: 'no_provider', note: 'no translation provider configured; returning original text' };
  }

  // Apply glossary by prepending instructions for OpenAI; substitution post-hoc for others
  if (provider === 'deepl') {
    const params = new URLSearchParams({
      auth_key: process.env.DEEPL_API_KEY,
      text, target_lang: (targetLang || '').toUpperCase()
    });
    if (sourceLang) params.set('source_lang', sourceLang.toUpperCase());
    const url = (process.env.DEEPL_API_BASE || 'https://api-free.deepl.com/v2/translate');
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: params.toString()
    }).then(x => x.json()).catch(() => null);
    const out = r?.translations?.[0]?.text;
    if (!out) return { translated_text: text, provider, error: 'deepl_failed' };
    return { translated_text: applyGlossaryPost(out, glossaryEntries), provider };
  }
  if (provider === 'google') {
    const url = `https://translation.googleapis.com/language/translate/v2?key=${process.env.GOOGLE_API_KEY}`;
    const body = { q: text, target: targetLang };
    if (sourceLang) body.source = sourceLang;
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    }).then(x => x.json()).catch(() => null);
    const out = r?.data?.translations?.[0]?.translatedText;
    if (!out) return { translated_text: text, provider, error: 'google_failed' };
    return { translated_text: applyGlossaryPost(out, glossaryEntries), provider };
  }
  if (provider === 'openai') {
    const sysParts = [
      `You are a translator. Translate the user message into ${SUPPORTED_LANGUAGES[targetLang] || targetLang}.`,
      sourceLang ? `Source language is ${SUPPORTED_LANGUAGES[sourceLang] || sourceLang}.` : '',
      'Reply with ONLY the translated text, no explanations.'
    ];
    if (glossaryEntries && glossaryEntries.length) {
      sysParts.push('Use the following glossary strictly:\n' +
        glossaryEntries.map(e => `- "${e.source}" -> "${e.target}"`).join('\n'));
    }
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: process.env.TRANSLATE_OPENAI_MODEL || 'gpt-4o-mini',
        messages: [
          { role: 'system', content: sysParts.filter(Boolean).join(' ') },
          { role: 'user', content: text }
        ],
        temperature: 0.0
      })
    }).then(x => x.json()).catch(() => null);
    const out = r?.choices?.[0]?.message?.content;
    if (!out) return { translated_text: text, provider, error: 'openai_failed' };
    return { translated_text: out.trim(), provider };
  }
  return { translated_text: text, provider: 'unknown' };
}

function applyGlossaryPost(text, entries) {
  if (!entries || !entries.length) return text;
  let out = text;
  for (const e of entries) {
    if (!e || !e.source || !e.target) continue;
    out = out.split(e.source).join(e.target);
  }
  return out;
}

async function detectLanguage(text, requestedProvider) {
  // Heuristic detection by script + provider hint
  const sample = (text || '').slice(0, 2000);
  if (!sample) return { detected_lang: 'en', confidence: 0.0, provider: 'heuristic' };

  const provider = chooseProvider(requestedProvider);
  if (provider === 'google' && process.env.GOOGLE_API_KEY) {
    const url = `https://translation.googleapis.com/language/translate/v2/detect?key=${process.env.GOOGLE_API_KEY}`;
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ q: sample })
    }).then(x => x.json()).catch(() => null);
    const d = r?.data?.detections?.[0]?.[0];
    if (d?.language) return { detected_lang: d.language, confidence: d.confidence || 0.9, provider: 'google' };
  }
  if (provider === 'openai' && process.env.OPENAI_API_KEY) {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: process.env.TRANSLATE_OPENAI_MODEL || 'gpt-4o-mini',
        messages: [
          { role: 'system', content: 'You detect languages. Reply ONLY with ISO 639-1 lowercase code (e.g. "en", "es", "zh").' },
          { role: 'user', content: sample }
        ],
        temperature: 0.0
      })
    }).then(x => x.json()).catch(() => null);
    const code = r?.choices?.[0]?.message?.content?.trim().toLowerCase().slice(0, 3);
    if (code && SUPPORTED_LANGUAGES[code]) {
      return { detected_lang: code, confidence: 0.85, provider: 'openai' };
    }
  }

  // Script heuristic
  const re = {
    zh: /[一-鿿]/, ja: /[぀-ヿ]/, ko: /[가-힯]/,
    ar: /[؀-ۿ]/, he: /[֐-׿]/, th: /[฀-๿]/,
    hi: /[ऀ-ॿ]/, ru: /[Ѐ-ӿ]/, el: /[Ͱ-Ͽ]/
  };
  for (const [code, rgx] of Object.entries(re)) {
    if (rgx.test(sample)) return { detected_lang: code, confidence: 0.7, provider: 'heuristic' };
  }
  // Try to detect Romance / Germanic by stopwords
  const stop = {
    es: ['el ', 'la ', 'que ', 'de ', 'y ', 'es '],
    fr: ['le ', 'la ', 'que ', 'de ', 'et ', 'est '],
    de: ['der ', 'die ', 'und ', 'ist ', 'das '],
    it: ['il ', 'la ', 'che ', 'di ', 'e '],
    pt: ['o ', 'a ', 'que ', 'de ', 'e '],
    nl: ['de ', 'het ', 'een ', 'en ']
  };
  const lower = ' ' + sample.toLowerCase() + ' ';
  let best = { code: 'en', score: 0 };
  for (const [code, words] of Object.entries(stop)) {
    const score = words.filter(w => lower.includes(' ' + w)).length;
    if (score > best.score) best = { code, score };
  }
  return {
    detected_lang: best.score >= 2 ? best.code : 'en',
    confidence: best.score >= 2 ? 0.6 : 0.4,
    provider: 'heuristic'
  };
}

async function tryRecordCost(pool, did, amount, kind) {
  if (!did) return;
  try {
    const cost = require('./cost');
    if (cost && typeof cost.recordCost === 'function') {
      await cost.recordCost(pool, {
        agent_did: did, resource_type: 'translate', provider: kind, amount_cents: amount
      });
    }
  } catch {}
}

// ----------------------------------------------------------------------------
// Routes
// ----------------------------------------------------------------------------
function registerTranslateRoutes(app, pool, verifyAgentAuth, auditChain) {
  // POST /v1/translate
  const TSchema = z.object({
    text: z.string().min(1).max(50000),
    target_lang: z.string().min(2).max(8),
    source_lang: z.string().min(2).max(8).optional(),
    provider: z.enum(['deepl', 'google', 'openai']).optional(),
    glossary_id: z.string().optional(),
    agent_did: z.string().optional()
  });
  app.post('/v1/translate', express.json({ limit: '1mb' }), async (req, res) => {
    try {
      const parse = TSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;
      if (!SUPPORTED_LANGUAGES[d.target_lang]) {
        return res.status(400).json({ error: 'unsupported_target_lang' });
      }
      let glossaryEntries = null;
      if (d.glossary_id) {
        const gR = await pool.query(`SELECT entries FROM glossaries WHERE glossary_id = $1`, [d.glossary_id])
          .catch(() => ({ rows: [] }));
        glossaryEntries = gR.rows[0]?.entries || null;
      }
      const result = await translateText(d.text, d.target_lang, d.source_lang, d.provider, glossaryEntries);
      const translationId = genId('tr');
      await pool.query(
        `INSERT INTO translations
         (translation_id, agent_did, source_text, source_lang, target_lang,
          translated_text, provider, glossary_id, cost_cents)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [translationId, d.agent_did || null, d.text, d.source_lang || null, d.target_lang,
         result.translated_text, result.provider, d.glossary_id || null, TRANSLATE_COST_CENTS]
      ).catch(() => {});
      await tryRecordCost(pool, d.agent_did, TRANSLATE_COST_CENTS, result.provider);
      return res.json({
        translation_id: translationId,
        source_text: d.text, source_lang: d.source_lang,
        target_lang: d.target_lang, translated_text: result.translated_text,
        provider: result.provider, glossary_id: d.glossary_id || null
      });
    } catch (e) {
      console.error('[translate]', e);
      return res.status(500).json({ error: 'translate_failed', message: e.message });
    }
  });

  // POST /v1/translate/detect-language
  const DSchema = z.object({
    text: z.string().min(1).max(50000),
    provider: z.enum(['deepl', 'google', 'openai']).optional(),
    agent_did: z.string().optional()
  });
  app.post('/v1/translate/detect-language', express.json({ limit: '1mb' }), async (req, res) => {
    try {
      const parse = DSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;
      const result = await detectLanguage(d.text, d.provider);
      const detectionId = genId('det');
      await pool.query(
        `INSERT INTO language_detections
         (detection_id, agent_did, sample_text, detected_lang, confidence, provider)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [detectionId, d.agent_did || null, d.text.slice(0, 2000),
         result.detected_lang, result.confidence, result.provider]
      ).catch(() => {});
      await tryRecordCost(pool, d.agent_did, DETECT_COST_CENTS, result.provider);
      return res.json({
        detection_id: detectionId,
        detected_lang: result.detected_lang,
        language_name: SUPPORTED_LANGUAGES[result.detected_lang] || null,
        confidence: result.confidence, provider: result.provider
      });
    } catch (e) {
      console.error('[translate.detect]', e);
      return res.status(500).json({ error: 'detect_failed', message: e.message });
    }
  });

  // POST /v1/translate/batch
  const BSchema = z.object({
    texts: z.array(z.string().min(1).max(50000)).min(1).max(100),
    target_lang: z.string().min(2).max(8),
    source_lang: z.string().min(2).max(8).optional(),
    provider: z.enum(['deepl', 'google', 'openai']).optional(),
    glossary_id: z.string().optional(),
    agent_did: z.string().optional()
  });
  app.post('/v1/translate/batch', express.json({ limit: '5mb' }), async (req, res) => {
    try {
      const parse = BSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;
      if (!SUPPORTED_LANGUAGES[d.target_lang]) {
        return res.status(400).json({ error: 'unsupported_target_lang' });
      }
      let glossaryEntries = null;
      if (d.glossary_id) {
        const gR = await pool.query(`SELECT entries FROM glossaries WHERE glossary_id = $1`, [d.glossary_id])
          .catch(() => ({ rows: [] }));
        glossaryEntries = gR.rows[0]?.entries || null;
      }
      const results = [];
      for (const t of d.texts) {
        const r = await translateText(t, d.target_lang, d.source_lang, d.provider, glossaryEntries);
        results.push(r.translated_text);
      }
      await tryRecordCost(pool, d.agent_did, TRANSLATE_COST_CENTS * d.texts.length, 'batch');
      return res.json({
        target_lang: d.target_lang, source_lang: d.source_lang || null,
        count: results.length, translations: results
      });
    } catch (e) {
      console.error('[translate.batch]', e);
      return res.status(500).json({ error: 'batch_failed', message: e.message });
    }
  });

  // POST /v1/agents/:did/translate/glossaries
  const GSchema = z.object({
    name: z.string().min(1).max(256),
    source_lang: z.string().min(2).max(8),
    target_lang: z.string().min(2).max(8),
    entries: z.array(z.object({
      source: z.string().min(1).max(256),
      target: z.string().min(1).max(256),
      notes: z.string().optional()
    })).max(10000)
  });
  app.post('/v1/agents/:did/translate/glossaries', express.json({ limit: '5mb' }), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const parse = GSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;
      const glossaryId = genId('gloss');
      await pool.query(
        `INSERT INTO glossaries (glossary_id, agent_did, name, source_lang, target_lang, entries)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
        [glossaryId, did, d.name, d.source_lang, d.target_lang, JSON.stringify(d.entries)]
      );
      await auditChain.append({
        event_type: 'translate.glossary_created',
        glossary_id: glossaryId, agent_did: did,
        entries: d.entries.length, timestamp: new Date().toISOString()
      });
      return res.status(201).json({
        glossary_id: glossaryId, agent_did: did, name: d.name,
        source_lang: d.source_lang, target_lang: d.target_lang,
        entry_count: d.entries.length
      });
    } catch (e) {
      console.error('[translate.glossary.create]', e);
      return res.status(500).json({ error: 'glossary_create_failed', message: e.message });
    }
  });

  // GET /v1/translate/languages
  app.get('/v1/translate/languages', async (req, res) => {
    return res.json({
      languages: Object.entries(SUPPORTED_LANGUAGES).map(([code, name]) => ({ code, name })),
      count: Object.keys(SUPPORTED_LANGUAGES).length
    });
  });
}

module.exports = {
  migrate,
  registerTranslateRoutes,
  translateText,
  detectLanguage,
  SUPPORTED_LANGUAGES
};
