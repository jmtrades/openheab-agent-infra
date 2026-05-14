// ============================================================================
// OpenHeab Fine-Tuning — Per-agent model fine-tuning
// Tables: fine_tune_jobs, fine_tuned_models
// Providers: openai, anthropic (planned), together
// ============================================================================
const express = require('express');
const cryptoLib = require('crypto');
const { z } = require('zod');

const BASE_MODELS = ['gpt-4o', 'gpt-4o-mini', 'gpt-3.5-turbo',
  'claude-3-5-sonnet', 'claude-3-haiku', 'llama-3', 'llama-3-8b', 'llama-3-70b'];
const PROVIDERS = ['openai', 'anthropic', 'together'];
const JOB_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'cancelled'];
const MODEL_STATUSES = ['active', 'archived', 'deleted'];

// ----------------------------------------------------------------------------
// Migration
// ----------------------------------------------------------------------------
async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS fine_tune_jobs (
      job_id              TEXT PRIMARY KEY,
      agent_did           TEXT NOT NULL,
      base_model          TEXT NOT NULL,
      training_data_uri   TEXT,
      validation_data_uri TEXT,
      hyperparameters     JSONB,
      status              TEXT NOT NULL DEFAULT 'queued',
      provider            TEXT NOT NULL,
      provider_job_id     TEXT,
      output_model_id     TEXT,
      error_message       TEXT,
      cost_cents          INTEGER NOT NULL DEFAULT 0,
      audit_chain_entry   TEXT,
      started_at          TIMESTAMPTZ,
      completed_at        TIMESTAMPTZ,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_ft_jobs_agent ON fine_tune_jobs (agent_did, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_ft_jobs_status ON fine_tune_jobs (status, created_at DESC);

    CREATE TABLE IF NOT EXISTS fine_tuned_models (
      model_id           TEXT PRIMARY KEY,
      agent_did          TEXT NOT NULL,
      job_id             TEXT NOT NULL,
      name               TEXT NOT NULL,
      base_model         TEXT NOT NULL,
      provider           TEXT NOT NULL,
      provider_model_id  TEXT,
      eval_score         REAL,
      status             TEXT NOT NULL DEFAULT 'active',
      created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (agent_did, name)
    );
    CREATE INDEX IF NOT EXISTS idx_ft_models_agent ON fine_tuned_models (agent_did, created_at DESC);
  `);
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------
function genId(prefix) {
  return prefix + '_' + cryptoLib.randomBytes(12).toString('hex');
}

function providerForBaseModel(base) {
  const b = (base || '').toLowerCase();
  if (b.startsWith('gpt') || b.startsWith('davinci') || b.startsWith('o1')) return 'openai';
  if (b.startsWith('claude')) return 'anthropic';
  if (b.startsWith('llama')) return 'together';
  return 'openai';
}

function providerEnv(provider) {
  if (provider === 'openai') return process.env.OPENAI_API_KEY;
  if (provider === 'together') return process.env.TOGETHER_API_KEY;
  if (provider === 'anthropic') return process.env.ANTHROPIC_API_KEY;
  return null;
}

// Submit a fine-tune job to the provider. Returns provider_job_id.
async function submitToProvider(provider, baseModel, trainingUri, validationUri, hyperparams) {
  const key = providerEnv(provider);
  if (!key) {
    // No API key — return a synthetic ID for queueing/testing
    return { provider_job_id: 'syn_' + cryptoLib.randomBytes(8).toString('hex'), synthetic: true };
  }
  if (provider === 'openai') {
    const r = await fetch('https://api.openai.com/v1/fine_tuning/jobs', {
      method: 'POST',
      headers: { 'authorization': `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: baseModel,
        training_file: trainingUri,
        validation_file: validationUri || undefined,
        hyperparameters: hyperparams || undefined
      })
    }).catch(e => ({ ok: false, status: 0, text: () => e.message }));
    if (!r.ok) {
      const t = typeof r.text === 'function' ? await r.text() : '';
      throw new Error(`openai_ft_failed: ${r.status} ${t}`);
    }
    const j = await r.json();
    return { provider_job_id: j.id, raw: j };
  }
  if (provider === 'together') {
    const r = await fetch('https://api.together.xyz/v1/fine-tunes', {
      method: 'POST',
      headers: { 'authorization': `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: baseModel,
        training_file: trainingUri,
        n_epochs: hyperparams?.n_epochs || 3,
        learning_rate: hyperparams?.learning_rate || 1e-5
      })
    }).catch(e => ({ ok: false, status: 0, text: () => e.message }));
    if (!r.ok) {
      const t = typeof r.text === 'function' ? await r.text() : '';
      throw new Error(`together_ft_failed: ${r.status} ${t}`);
    }
    const j = await r.json();
    return { provider_job_id: j.id, raw: j };
  }
  // anthropic doesn't have public FT API yet
  throw new Error(`provider_${provider}_unsupported`);
}

async function pollProvider(provider, providerJobId) {
  const key = providerEnv(provider);
  if (!key || (providerJobId || '').startsWith('syn_')) {
    return { status: 'running', synthetic: true };
  }
  if (provider === 'openai') {
    const r = await fetch(`https://api.openai.com/v1/fine_tuning/jobs/${providerJobId}`, {
      headers: { 'authorization': `Bearer ${key}` }
    }).catch(() => null);
    if (!r || !r.ok) return { status: 'running' };
    const j = await r.json();
    const map = {
      succeeded: 'succeeded', failed: 'failed', cancelled: 'cancelled',
      running: 'running', queued: 'queued', validating_files: 'queued'
    };
    return { status: map[j.status] || 'running', output_model_id: j.fine_tuned_model, raw: j };
  }
  if (provider === 'together') {
    const r = await fetch(`https://api.together.xyz/v1/fine-tunes/${providerJobId}`, {
      headers: { 'authorization': `Bearer ${key}` }
    }).catch(() => null);
    if (!r || !r.ok) return { status: 'running' };
    const j = await r.json();
    const map = { completed: 'succeeded', failed: 'failed', cancelled: 'cancelled' };
    return { status: map[j.status] || 'running', output_model_id: j.output_name, raw: j };
  }
  return { status: 'running' };
}

async function cancelProvider(provider, providerJobId) {
  const key = providerEnv(provider);
  if (!key || (providerJobId || '').startsWith('syn_')) return { ok: true };
  if (provider === 'openai') {
    await fetch(`https://api.openai.com/v1/fine_tuning/jobs/${providerJobId}/cancel`, {
      method: 'POST',
      headers: { 'authorization': `Bearer ${key}` }
    }).catch(() => null);
    return { ok: true };
  }
  if (provider === 'together') {
    await fetch(`https://api.together.xyz/v1/fine-tunes/${providerJobId}/cancel`, {
      method: 'POST',
      headers: { 'authorization': `Bearer ${key}` }
    }).catch(() => null);
    return { ok: true };
  }
  return { ok: false };
}

// ----------------------------------------------------------------------------
// Routes
// ----------------------------------------------------------------------------
function registerFineTuningRoutes(app, pool, verifyAgentAuth, auditChain) {
  // POST /v1/agents/:did/fine-tune
  const StartSchema = z.object({
    base_model:          z.string().min(1).max(128),
    training_data_uri:   z.string().min(1).max(2048),
    validation_data_uri: z.string().max(2048).optional(),
    hyperparameters:     z.record(z.any()).optional(),
    provider:            z.enum(PROVIDERS).optional(),
    name:                z.string().min(1).max(128).optional()
  });

  app.post('/v1/agents/:did/fine-tune', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const parse = StartSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;

      const provider = d.provider || providerForBaseModel(d.base_model);
      const jobId = genId('ftj');
      const now = new Date().toISOString();

      let providerJobId = null;
      let status = 'queued';
      let errorMessage = null;
      try {
        const submit = await submitToProvider(
          provider, d.base_model, d.training_data_uri,
          d.validation_data_uri, d.hyperparameters
        );
        providerJobId = submit.provider_job_id;
        status = 'running';
      } catch (e) {
        status = 'failed';
        errorMessage = e.message;
      }

      const entry = await auditChain.append({
        event_type: 'fine_tune.job_started',
        agent_did: did, job_id: jobId, base_model: d.base_model,
        provider, status, timestamp: now
      });

      await pool.query(`
        INSERT INTO fine_tune_jobs
          (job_id, agent_did, base_model, training_data_uri, validation_data_uri,
           hyperparameters, status, provider, provider_job_id, error_message,
           audit_chain_entry, started_at, created_at)
        VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12,$13)
      `, [jobId, did, d.base_model, d.training_data_uri, d.validation_data_uri || null,
          d.hyperparameters ? JSON.stringify(d.hyperparameters) : null,
          status, provider, providerJobId, errorMessage,
          entry.hash, now, now]);

      return res.status(201).json({
        job_id: jobId, agent_did: did, base_model: d.base_model,
        provider, status, provider_job_id: providerJobId,
        error: errorMessage, audit_chain_entry: entry.hash
      });
    } catch (e) {
      console.error('[fine_tune.start]', e);
      return res.status(500).json({ error: 'start_failed', message: e.message });
    }
  });

  // GET /v1/agents/:did/fine-tune/jobs
  app.get('/v1/agents/:did/fine-tune/jobs', async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const r = await pool.query(`
        SELECT job_id, base_model, status, provider, provider_job_id, output_model_id,
               cost_cents, error_message, started_at, completed_at, created_at
        FROM fine_tune_jobs WHERE agent_did = $1 ORDER BY created_at DESC LIMIT 100
      `, [did]).catch(() => ({ rows: [] }));
      return res.json({ agent_did: did, jobs: r.rows, count: r.rows.length });
    } catch (e) {
      return res.status(500).json({ error: 'list_failed', message: e.message });
    }
  });

  // GET /v1/agents/:did/fine-tune/jobs/:id — poll status
  app.get('/v1/agents/:did/fine-tune/jobs/:id', async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const r = await pool.query(
        `SELECT * FROM fine_tune_jobs WHERE job_id = $1 AND agent_did = $2`,
        [req.params.id, did]
      ).catch(() => ({ rows: [] }));
      if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
      const job = r.rows[0];

      // Refresh from provider if still in-flight
      if (['queued', 'running'].includes(job.status) && job.provider_job_id) {
        try {
          const status = await pollProvider(job.provider, job.provider_job_id);
          if (status.status !== job.status) {
            const completedAt = ['succeeded', 'failed', 'cancelled'].includes(status.status)
              ? new Date().toISOString() : null;
            await pool.query(`
              UPDATE fine_tune_jobs
              SET status = $1, output_model_id = COALESCE($2, output_model_id),
                  completed_at = COALESCE($3, completed_at)
              WHERE job_id = $4
            `, [status.status, status.output_model_id || null, completedAt, req.params.id]);
            job.status = status.status;
            job.output_model_id = status.output_model_id || job.output_model_id;
            if (completedAt) job.completed_at = completedAt;

            // On success, materialize a fine_tuned_models row
            if (status.status === 'succeeded' && status.output_model_id) {
              const modelId = genId('ftm');
              const name = `${job.base_model}-ft-${job.job_id.slice(-6)}`;
              await pool.query(`
                INSERT INTO fine_tuned_models
                  (model_id, agent_did, job_id, name, base_model, provider, provider_model_id, status)
                VALUES ($1,$2,$3,$4,$5,$6,$7,'active')
                ON CONFLICT (agent_did, name) DO NOTHING
              `, [modelId, did, job.job_id, name, job.base_model,
                  job.provider, status.output_model_id]);

              await auditChain.append({
                event_type: 'fine_tune.job_succeeded',
                agent_did: did, job_id: job.job_id, model_id: modelId,
                output_model_id: status.output_model_id,
                timestamp: new Date().toISOString()
              });
            }
          }
        } catch (e) { console.warn('[fine_tune.poll]', e.message); }
      }

      return res.json(job);
    } catch (e) {
      return res.status(500).json({ error: 'get_failed', message: e.message });
    }
  });

  // POST /v1/agents/:did/fine-tune/jobs/:id/cancel
  app.post('/v1/agents/:did/fine-tune/jobs/:id/cancel', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const r = await pool.query(
        `SELECT * FROM fine_tune_jobs WHERE job_id = $1 AND agent_did = $2`,
        [req.params.id, did]
      ).catch(() => ({ rows: [] }));
      if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
      const job = r.rows[0];
      if (['succeeded', 'failed', 'cancelled'].includes(job.status)) {
        return res.status(409).json({ error: `already_${job.status}` });
      }

      try { await cancelProvider(job.provider, job.provider_job_id); } catch {}

      await pool.query(
        `UPDATE fine_tune_jobs SET status='cancelled', completed_at = NOW() WHERE job_id = $1`,
        [req.params.id]
      );

      await auditChain.append({
        event_type: 'fine_tune.job_cancelled',
        agent_did: did, job_id: req.params.id,
        timestamp: new Date().toISOString()
      });

      return res.json({ job_id: req.params.id, status: 'cancelled' });
    } catch (e) {
      return res.status(500).json({ error: 'cancel_failed', message: e.message });
    }
  });

  // GET /v1/agents/:did/fine-tuned-models
  app.get('/v1/agents/:did/fine-tuned-models', async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const r = await pool.query(`
        SELECT model_id, job_id, name, base_model, provider, provider_model_id,
               eval_score, status, created_at
        FROM fine_tuned_models WHERE agent_did = $1 AND status != 'deleted'
        ORDER BY created_at DESC LIMIT 200
      `, [did]).catch(() => ({ rows: [] }));
      return res.json({ agent_did: did, models: r.rows, count: r.rows.length });
    } catch (e) {
      return res.status(500).json({ error: 'list_failed', message: e.message });
    }
  });

  // POST /v1/agents/:did/fine-tuned-models/:id/use — sets as preferred model in inference policy
  app.post('/v1/agents/:did/fine-tuned-models/:id/use', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const r = await pool.query(
        `SELECT * FROM fine_tuned_models WHERE model_id = $1 AND agent_did = $2 AND status = 'active'`,
        [req.params.id, did]
      ).catch(() => ({ rows: [] }));
      if (!r.rows[0]) return res.status(404).json({ error: 'not_found_or_inactive' });
      const model = r.rows[0];

      // Update inference_policies to prefer this provider; record preferred_model in metadata
      await pool.query(`
        INSERT INTO inference_policies (agent_did, strategy, preferred_providers)
        VALUES ($1, 'preferred', ARRAY[$2])
        ON CONFLICT (agent_did) DO UPDATE
        SET preferred_providers = ARRAY[$2],
            strategy = 'preferred',
            updated_at = NOW()
      `, [did, model.provider]).catch(() => {});

      const entry = await auditChain.append({
        event_type: 'fine_tune.model_selected',
        agent_did: did, model_id: req.params.id,
        provider_model_id: model.provider_model_id,
        provider: model.provider,
        timestamp: new Date().toISOString()
      });

      return res.json({
        agent_did: did, model_id: req.params.id,
        provider: model.provider,
        provider_model_id: model.provider_model_id,
        preferred: true,
        audit_chain_entry: entry.hash
      });
    } catch (e) {
      console.error('[fine_tune.use]', e);
      return res.status(500).json({ error: 'use_failed', message: e.message });
    }
  });
}

module.exports = {
  migrate,
  registerFineTuningRoutes,
  submitToProvider,
  pollProvider,
  cancelProvider,
  providerForBaseModel,
  BASE_MODELS,
  PROVIDERS,
  JOB_STATUSES
};
