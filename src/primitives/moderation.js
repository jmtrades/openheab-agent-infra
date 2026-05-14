// ============================================================================
// OpenHeab Moderation — Content moderation + toxicity + NSFW + spam detection
// Providers: openai (moderation endpoint) / perspective / anthropic
// ============================================================================
const express = require('express');
const cryptoLib = require('crypto');
const { z } = require('zod');

const CATEGORIES = [
  'hate', 'harassment', 'sexual', 'sexual/minors', 'self-harm',
  'violence/graphic', 'weapons', 'drugs', 'spam', 'misinformation', 'copyright'
];

const DEFAULT_THRESHOLD = parseFloat(process.env.MODERATION_DEFAULT_THRESHOLD || '0.7');
const MOD_COST_CENTS = parseInt(process.env.MODERATION_COST_CENTS || '1');

// ----------------------------------------------------------------------------
// Migration
// ----------------------------------------------------------------------------
async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS moderation_checks (
      check_id      TEXT PRIMARY KEY,
      agent_did     TEXT,
      content       TEXT,
      content_type  TEXT NOT NULL DEFAULT 'text',
      content_url   TEXT,
      categories    JSONB,
      scores        JSONB,
      flagged       BOOLEAN NOT NULL DEFAULT FALSE,
      action        TEXT NOT NULL DEFAULT 'allow',
      provider      TEXT,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_mod_checks_agent ON moderation_checks (agent_did, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_mod_checks_flagged ON moderation_checks (flagged, created_at DESC);

    CREATE TABLE IF NOT EXISTS moderation_policies (
      agent_did            TEXT PRIMARY KEY,
      blocked_categories   TEXT[] NOT NULL DEFAULT '{}',
      warn_categories      TEXT[] NOT NULL DEFAULT '{}',
      threshold            REAL NOT NULL DEFAULT 0.7,
      escalate_webhook_url TEXT,
      updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS moderation_incidents (
      incident_id    TEXT PRIMARY KEY,
      agent_did      TEXT NOT NULL,
      kind           TEXT NOT NULL,
      check_id       TEXT,
      action_taken   TEXT,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_mod_incidents_agent ON moderation_incidents (agent_did, created_at DESC);
  `).catch(() => {});
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------
function genId(prefix) {
  return `${prefix}_${cryptoLib.randomBytes(12).toString('hex')}`;
}

function emptyScores() {
  const obj = {};
  for (const c of CATEGORIES) obj[c] = 0;
  return obj;
}

function mapOpenAICategories(scores) {
  const out = emptyScores();
  const m = {
    hate: 'hate', 'hate/threatening': 'hate',
    harassment: 'harassment', 'harassment/threatening': 'harassment',
    sexual: 'sexual', 'sexual/minors': 'sexual/minors',
    'self-harm': 'self-harm', 'self-harm/intent': 'self-harm', 'self-harm/instructions': 'self-harm',
    violence: 'violence/graphic', 'violence/graphic': 'violence/graphic'
  };
  for (const [k, v] of Object.entries(scores || {})) {
    const target = m[k];
    if (target && (v ?? 0) > (out[target] ?? 0)) out[target] = v;
  }
  return out;
}

async function checkText(text, opts = {}) {
  const provider = opts.provider || (process.env.OPENAI_API_KEY ? 'openai'
                  : process.env.PERSPECTIVE_API_KEY ? 'perspective'
                  : process.env.ANTHROPIC_API_KEY ? 'anthropic'
                  : 'heuristic');
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD;

  if (provider === 'openai' && process.env.OPENAI_API_KEY) {
    const r = await fetch('https://api.openai.com/v1/moderations', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({ input: text, model: 'omni-moderation-latest' })
    }).then(x => x.json()).catch(() => null);
    const result = r?.results?.[0];
    if (result) {
      const scores = mapOpenAICategories(result.category_scores || {});
      const flagged = result.flagged || Object.values(scores).some(v => v >= threshold);
      return { scores, flagged, provider: 'openai' };
    }
  }
  if (provider === 'perspective' && process.env.PERSPECTIVE_API_KEY) {
    const url = `https://commentanalyzer.googleapis.com/v1alpha1/comments:analyze?key=${process.env.PERSPECTIVE_API_KEY}`;
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        comment: { text },
        requestedAttributes: {
          TOXICITY: {}, SEVERE_TOXICITY: {}, THREAT: {}, INSULT: {},
          IDENTITY_ATTACK: {}, SEXUALLY_EXPLICIT: {}, PROFANITY: {}
        }
      })
    }).then(x => x.json()).catch(() => null);
    const a = r?.attributeScores || {};
    const scores = emptyScores();
    scores.harassment = a.TOXICITY?.summaryScore?.value || a.INSULT?.summaryScore?.value || 0;
    scores.hate = a.IDENTITY_ATTACK?.summaryScore?.value || 0;
    scores['violence/graphic'] = a.THREAT?.summaryScore?.value || 0;
    scores.sexual = a.SEXUALLY_EXPLICIT?.summaryScore?.value || 0;
    const flagged = Object.values(scores).some(v => v >= threshold);
    return { scores, flagged, provider: 'perspective' };
  }
  if (provider === 'anthropic' && process.env.ANTHROPIC_API_KEY) {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-3-haiku-20240307',
        max_tokens: 200,
        system: `Rate the following content on each of these categories from 0.0 to 1.0: ${CATEGORIES.join(', ')}. Reply ONLY with JSON: {"category":score, ...}.`,
        messages: [{ role: 'user', content: text }]
      })
    }).then(x => x.json()).catch(() => null);
    const content = r?.content?.[0]?.text;
    try {
      const m = content?.match(/\{[\s\S]*\}/);
      if (m) {
        const parsed = JSON.parse(m[0]);
        const scores = emptyScores();
        for (const c of CATEGORIES) if (typeof parsed[c] === 'number') scores[c] = parsed[c];
        const flagged = Object.values(scores).some(v => v >= threshold);
        return { scores, flagged, provider: 'anthropic' };
      }
    } catch {}
  }

  // Heuristic last resort
  const scores = emptyScores();
  const lower = (text || '').toLowerCase();
  const triggers = {
    hate: ['hate', 'racist'],
    harassment: ['idiot', 'moron', 'kill yourself'],
    sexual: ['xxx', 'porn'],
    'violence/graphic': ['murder', 'behead', 'massacre'],
    weapons: ['gun', 'bomb', 'explosive'],
    drugs: ['cocaine', 'heroin', 'meth'],
    spam: ['click here', 'buy now', 'free money'],
    'self-harm': ['suicide', 'cutting myself']
  };
  for (const [cat, words] of Object.entries(triggers)) {
    const hits = words.filter(w => lower.includes(w)).length;
    if (hits) scores[cat] = Math.min(1, 0.4 + 0.2 * hits);
  }
  const flagged = Object.values(scores).some(v => v >= threshold);
  return { scores, flagged, provider: 'heuristic' };
}

async function checkImage(imageUrl, opts = {}) {
  const provider = opts.provider || (process.env.OPENAI_API_KEY ? 'openai' : 'heuristic');
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
  if (provider === 'openai' && process.env.OPENAI_API_KEY) {
    const r = await fetch('https://api.openai.com/v1/moderations', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: 'omni-moderation-latest',
        input: [{ type: 'image_url', image_url: { url: imageUrl } }]
      })
    }).then(x => x.json()).catch(() => null);
    const result = r?.results?.[0];
    if (result) {
      const scores = mapOpenAICategories(result.category_scores || {});
      const flagged = result.flagged || Object.values(scores).some(v => v >= threshold);
      return { scores, flagged, provider: 'openai' };
    }
  }
  return { scores: emptyScores(), flagged: false, provider: 'unknown', note: 'image moderation unavailable' };
}

async function getPolicy(pool, did) {
  if (!did) return null;
  const r = await pool.query(
    `SELECT * FROM moderation_policies WHERE agent_did = $1`, [did]
  ).catch(() => ({ rows: [] }));
  return r.rows[0] || null;
}

function decideAction(scores, policy) {
  if (!policy) return 'allow';
  const threshold = policy.threshold ?? DEFAULT_THRESHOLD;
  const blocked = policy.blocked_categories || [];
  const warn = policy.warn_categories || [];
  for (const c of blocked) {
    if ((scores[c] ?? 0) >= threshold) return 'block';
  }
  for (const c of warn) {
    if ((scores[c] ?? 0) >= threshold) return 'warn';
  }
  return 'allow';
}

async function tryRecordCost(pool, did) {
  if (!did) return;
  try {
    const cost = require('./cost');
    if (cost && typeof cost.recordCost === 'function') {
      await cost.recordCost(pool, {
        agent_did: did, resource_type: 'moderation',
        provider: 'moderation', amount_cents: MOD_COST_CENTS
      });
    }
  } catch {}
}

async function maybeWebhook(policy, payload) {
  if (!policy?.escalate_webhook_url) return;
  try {
    await fetch(policy.escalate_webhook_url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    });
  } catch {}
}

// ----------------------------------------------------------------------------
// Routes
// ----------------------------------------------------------------------------
function registerModerationRoutes(app, pool, verifyAgentAuth, auditChain) {
  // POST /v1/moderation/check
  const TextSchema = z.object({
    text: z.string().min(1).max(50000),
    agent_did: z.string().optional(),
    provider: z.enum(['openai', 'perspective', 'anthropic', 'heuristic']).optional()
  });
  app.post('/v1/moderation/check', express.json({ limit: '1mb' }), async (req, res) => {
    try {
      const parse = TextSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;
      const policy = d.agent_did ? await getPolicy(pool, d.agent_did) : null;
      const result = await checkText(d.text, {
        provider: d.provider,
        threshold: policy?.threshold ?? DEFAULT_THRESHOLD
      });
      const action = decideAction(result.scores, policy);
      const checkId = genId('check');
      await pool.query(
        `INSERT INTO moderation_checks
         (check_id, agent_did, content, content_type, categories, scores, flagged, action, provider)
         VALUES ($1,$2,$3,'text',$4::jsonb,$5::jsonb,$6,$7,$8)`,
        [checkId, d.agent_did || null, d.text.slice(0, 10000),
         JSON.stringify(CATEGORIES), JSON.stringify(result.scores),
         result.flagged, action, result.provider]
      ).catch(() => {});
      if (action !== 'allow' && policy) {
        await maybeWebhook(policy, {
          event: 'moderation.flagged', check_id: checkId,
          agent_did: d.agent_did, action, scores: result.scores
        });
        await auditChain.append({
          event_type: 'moderation.flagged', check_id: checkId,
          agent_did: d.agent_did, action, timestamp: new Date().toISOString()
        });
      }
      await tryRecordCost(pool, d.agent_did);
      return res.json({
        check_id: checkId, flagged: result.flagged,
        action, scores: result.scores, provider: result.provider
      });
    } catch (e) {
      console.error('[moderation.check]', e);
      return res.status(500).json({ error: 'check_failed', message: e.message });
    }
  });

  // POST /v1/moderation/check-image
  const ImgSchema = z.object({
    image_url: z.string().url(),
    agent_did: z.string().optional(),
    provider: z.enum(['openai']).optional()
  });
  app.post('/v1/moderation/check-image', express.json(), async (req, res) => {
    try {
      const parse = ImgSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;
      const policy = d.agent_did ? await getPolicy(pool, d.agent_did) : null;
      const result = await checkImage(d.image_url, {
        provider: d.provider, threshold: policy?.threshold ?? DEFAULT_THRESHOLD
      });
      const action = decideAction(result.scores, policy);
      const checkId = genId('check');
      await pool.query(
        `INSERT INTO moderation_checks
         (check_id, agent_did, content_url, content_type, categories, scores, flagged, action, provider)
         VALUES ($1,$2,$3,'image',$4::jsonb,$5::jsonb,$6,$7,$8)`,
        [checkId, d.agent_did || null, d.image_url,
         JSON.stringify(CATEGORIES), JSON.stringify(result.scores),
         result.flagged, action, result.provider]
      ).catch(() => {});
      await tryRecordCost(pool, d.agent_did);
      return res.json({
        check_id: checkId, flagged: result.flagged,
        action, scores: result.scores, provider: result.provider
      });
    } catch (e) {
      console.error('[moderation.check_image]', e);
      return res.status(500).json({ error: 'check_image_failed', message: e.message });
    }
  });

  // POST /v1/moderation/check-batch
  const BSchema = z.object({
    texts: z.array(z.string().min(1).max(10000)).min(1).max(100),
    agent_did: z.string().optional(),
    provider: z.enum(['openai', 'perspective', 'anthropic', 'heuristic']).optional()
  });
  app.post('/v1/moderation/check-batch', express.json({ limit: '5mb' }), async (req, res) => {
    try {
      const parse = BSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;
      const policy = d.agent_did ? await getPolicy(pool, d.agent_did) : null;
      const results = [];
      for (const t of d.texts) {
        const r = await checkText(t, {
          provider: d.provider, threshold: policy?.threshold ?? DEFAULT_THRESHOLD
        });
        const action = decideAction(r.scores, policy);
        const checkId = genId('check');
        await pool.query(
          `INSERT INTO moderation_checks
           (check_id, agent_did, content, content_type, categories, scores, flagged, action, provider)
           VALUES ($1,$2,$3,'text',$4::jsonb,$5::jsonb,$6,$7,$8)`,
          [checkId, d.agent_did || null, t.slice(0, 10000),
           JSON.stringify(CATEGORIES), JSON.stringify(r.scores),
           r.flagged, action, r.provider]
        ).catch(() => {});
        results.push({ check_id: checkId, flagged: r.flagged, action, scores: r.scores });
      }
      await tryRecordCost(pool, d.agent_did);
      return res.json({ count: results.length, results });
    } catch (e) {
      console.error('[moderation.batch]', e);
      return res.status(500).json({ error: 'batch_failed', message: e.message });
    }
  });

  // POST /v1/agents/:did/moderation/policy
  const PolicySchema = z.object({
    blocked_categories: z.array(z.enum(CATEGORIES)).optional(),
    warn_categories: z.array(z.enum(CATEGORIES)).optional(),
    threshold: z.number().min(0).max(1).optional(),
    escalate_webhook_url: z.string().url().nullable().optional()
  });
  app.post('/v1/agents/:did/moderation/policy', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const parse = PolicySchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;

      await pool.query(
        `INSERT INTO moderation_policies
         (agent_did, blocked_categories, warn_categories, threshold, escalate_webhook_url, updated_at)
         VALUES ($1, COALESCE($2::text[], '{}'::text[]),
                 COALESCE($3::text[], '{}'::text[]),
                 COALESCE($4, ${DEFAULT_THRESHOLD}),
                 $5, NOW())
         ON CONFLICT (agent_did) DO UPDATE SET
           blocked_categories   = COALESCE($2::text[], moderation_policies.blocked_categories),
           warn_categories      = COALESCE($3::text[], moderation_policies.warn_categories),
           threshold            = COALESCE($4, moderation_policies.threshold),
           escalate_webhook_url = COALESCE($5, moderation_policies.escalate_webhook_url),
           updated_at           = NOW()`,
        [did,
         d.blocked_categories ?? null,
         d.warn_categories ?? null,
         d.threshold ?? null,
         d.escalate_webhook_url ?? null]
      );
      await auditChain.append({
        event_type: 'moderation.policy_updated',
        agent_did: did, timestamp: new Date().toISOString()
      });
      const policy = await getPolicy(pool, did);
      return res.json(policy);
    } catch (e) {
      console.error('[moderation.policy.set]', e);
      return res.status(500).json({ error: 'policy_update_failed', message: e.message });
    }
  });

  // GET /v1/agents/:did/moderation/policy
  app.get('/v1/agents/:did/moderation/policy', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const policy = await getPolicy(pool, did);
    if (!policy) {
      return res.json({
        agent_did: did, blocked_categories: [], warn_categories: [],
        threshold: DEFAULT_THRESHOLD, escalate_webhook_url: null
      });
    }
    return res.json(policy);
  });

  // POST /v1/agents/:did/moderation/report — report false positive
  const ReportSchema = z.object({
    check_id: z.string(),
    kind: z.enum(['false_positive_report', 'violated_policy']).default('false_positive_report'),
    note: z.string().max(2000).optional()
  });
  app.post('/v1/agents/:did/moderation/report', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const parse = ReportSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;

      const incidentId = genId('mi');
      await pool.query(
        `INSERT INTO moderation_incidents (incident_id, agent_did, kind, check_id, action_taken)
         VALUES ($1,$2,$3,$4,$5)`,
        [incidentId, did, d.kind, d.check_id, d.note || null]
      );
      await auditChain.append({
        event_type: 'moderation.incident_reported',
        incident_id: incidentId, agent_did: did, kind: d.kind,
        check_id: d.check_id, timestamp: new Date().toISOString()
      });
      return res.status(201).json({
        incident_id: incidentId, agent_did: did, kind: d.kind,
        check_id: d.check_id
      });
    } catch (e) {
      console.error('[moderation.report]', e);
      return res.status(500).json({ error: 'report_failed', message: e.message });
    }
  });
}

module.exports = {
  migrate,
  registerModerationRoutes,
  checkText,
  checkImage,
  CATEGORIES,
  DEFAULT_THRESHOLD
};
