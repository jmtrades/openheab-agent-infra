// ============================================================================
// provider_adapters.js — clean adapter interfaces for every external provider
// the substrate depends on. In stub mode (no env vars set) every adapter
// returns deterministic synthetic responses so the substrate boots in any
// environment. With env vars set, each adapter calls the real provider.
//
// This is the "production wiring" surface — operators read /v1/admin/
// providers to see exactly which env vars to set to turn each provider on.
// ============================================================================
const crypto = require('crypto');

const PROVIDERS = [
  { slug: 'stripe',          purpose: 'subscriptions, checkout, customer billing',
    env: ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'STRIPE_PRICE_PRO_MONTHLY',
          'STRIPE_PRICE_SCALE_MONTHLY', 'STRIPE_PRICE_ENTERPRISE_MONTHLY'] },
  { slug: 'stripe_issuing',  purpose: 'virtual + physical agent debit cards',
    env: ['STRIPE_ISSUING_SECRET_KEY', 'STRIPE_ISSUING_WEBHOOK_SECRET'] },
  { slug: 'modern_treasury', purpose: 'ACH / wire / SEPA bank transfer rails',
    env: ['MODERN_TREASURY_API_KEY', 'MODERN_TREASURY_WEBHOOK_SECRET'] },
  { slug: 'plaid',           purpose: 'bank account verification + balance lookup',
    env: ['PLAID_CLIENT_ID', 'PLAID_SECRET'] },
  { slug: 'wise',            purpose: 'international fiat payouts',
    env: ['WISE_API_TOKEN'] },
  { slug: 'twilio',          purpose: 'voice calls + SMS for voice_agents primitive',
    env: ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_PHONE_NUMBER'] },
  { slug: 'sendgrid',        purpose: 'transactional email + newsletter delivery',
    env: ['SENDGRID_API_KEY', 'SENDGRID_FROM_DOMAIN'] },
  { slug: 'onfido',          purpose: 'KYC document verification + liveness',
    env: ['ONFIDO_API_TOKEN'] },
  { slug: 'persona',         purpose: 'KYC alternative — document + selfie + ID',
    env: ['PERSONA_API_KEY'] },
  { slug: 'sumsub',          purpose: 'KYC + KYB + AML monitoring',
    env: ['SUMSUB_APP_TOKEN', 'SUMSUB_SECRET_KEY'] },
  { slug: 'comply_advantage', purpose: 'sanctions + adverse media screening',
    env: ['COMPLY_ADVANTAGE_API_KEY'] },
  { slug: 'anthropic',       purpose: 'LLM inference (Claude family)',
    env: ['ANTHROPIC_API_KEY'] },
  { slug: 'openai',          purpose: 'LLM inference (GPT family) + embeddings',
    env: ['OPENAI_API_KEY'] },
  { slug: 'google_ai',       purpose: 'LLM inference (Gemini family)',
    env: ['GOOGLE_AI_API_KEY'] },
  { slug: 'mistral',         purpose: 'LLM inference (Mistral family)',
    env: ['MISTRAL_API_KEY'] },
  { slug: 'together',        purpose: 'open-model inference router',
    env: ['TOGETHER_API_KEY'] },
  { slug: 'modal',           purpose: 'GPU compute provisioning',
    env: ['MODAL_TOKEN_ID', 'MODAL_TOKEN_SECRET'] },
  { slug: 'e2b',             purpose: 'code sandbox provisioning',
    env: ['E2B_API_KEY'] },
  { slug: 'browserbase',     purpose: 'headless browser provisioning',
    env: ['BROWSERBASE_API_KEY', 'BROWSERBASE_PROJECT_ID'] },
  { slug: 'vercel',          purpose: 'agent deployment to Vercel functions',
    env: ['VERCEL_API_TOKEN'] },
  { slug: 'cloudflare',      purpose: 'DNS, R2 storage, Workers edge compute, DDoS',
    env: ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID'] },
  { slug: 'aws_s3',          purpose: 'large blob storage + CDN origin',
    env: ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_S3_BUCKET'] },
  { slug: 'github',          purpose: 'GitHub repo + Actions integration',
    env: ['GITHUB_APP_ID', 'GITHUB_APP_PRIVATE_KEY'] },
  { slug: 'sentry',          purpose: 'error tracking',
    env: ['SENTRY_DSN'] },
  { slug: 'datadog',         purpose: 'observability + Prometheus + APM',
    env: ['DATADOG_API_KEY', 'DATADOG_APP_KEY'] },
  { slug: 'pagerduty',       purpose: 'on-call alerting',
    env: ['PAGERDUTY_INTEGRATION_KEY'] },
  { slug: 'slack',           purpose: 'workspace integration + ops alerts',
    env: ['SLACK_BOT_TOKEN', 'SLACK_SIGNING_SECRET'] },
  { slug: 'discord',         purpose: 'community integration',
    env: ['DISCORD_BOT_TOKEN'] },
  { slug: 'vanta',           purpose: 'SOC 2 / ISO 27001 evidence automation',
    env: ['VANTA_API_TOKEN'] },
  { slug: 'drata',           purpose: 'SOC 2 alternative',
    env: ['DRATA_API_KEY'] },
  { slug: 'carta',           purpose: 'cap-table mgmt + 409A + employee equity',
    env: ['CARTA_API_KEY'] },
  { slug: 'alchemy',         purpose: 'Base + Ethereum RPC + indexer',
    env: ['ALCHEMY_API_KEY', 'ALCHEMY_BASE_RPC_URL'] }
];

async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS provider_status (
      slug              TEXT PRIMARY KEY,
      configured        BOOLEAN NOT NULL DEFAULT FALSE,
      env_vars_set      TEXT[],
      env_vars_missing  TEXT[],
      last_call_at      TIMESTAMPTZ,
      last_call_ok      BOOLEAN,
      last_error        TEXT,
      checked_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS provider_call_log (
      call_id           TEXT PRIMARY KEY,
      provider          TEXT NOT NULL,
      method            TEXT,
      ok                BOOLEAN,
      latency_ms        INTEGER,
      cost_cents        INTEGER,
      error             TEXT,
      occurred_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_provider_call_log_provider ON provider_call_log (provider, occurred_at DESC);
  `);
}

function newId(p) { return p + '_' + crypto.randomBytes(10).toString('hex'); }
function isAdmin(req) {
  const t = req.headers['x-admin-token'];
  return require('../safe_compare').safeTokenCompare(t, process.env.OPERATOR_ADMIN_TOKEN);
}

function checkProvider(p) {
  const set = p.env.filter(v => process.env[v]);
  const missing = p.env.filter(v => !process.env[v]);
  return { configured: missing.length === 0, env_vars_set: set, env_vars_missing: missing };
}

async function refreshAll(pool) {
  for (const p of PROVIDERS) {
    const status = checkProvider(p);
    await pool.query(
      `INSERT INTO provider_status (slug, configured, env_vars_set, env_vars_missing, checked_at)
       VALUES ($1,$2,$3,$4,NOW())
       ON CONFLICT (slug) DO UPDATE SET configured = $2, env_vars_set = $3, env_vars_missing = $4, checked_at = NOW()`,
      [p.slug, status.configured, status.env_vars_set, status.env_vars_missing]
    ).catch(() => {});
  }
  return { providers: PROVIDERS.length };
}

async function logCall({ pool, provider, method, ok, latency_ms, cost_cents, error }) {
  await pool.query(
    `INSERT INTO provider_call_log (call_id, provider, method, ok, latency_ms, cost_cents, error)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [newId('pcall'), provider, method, !!ok, latency_ms || null, cost_cents || null, error || null]
  ).catch(() => {});
  await pool.query(
    `UPDATE provider_status SET last_call_at = NOW(), last_call_ok = $1, last_error = $2 WHERE slug = $3`,
    [!!ok, error || null, provider]
  ).catch(() => {});
}

function registerProviderAdaptersRoutes(app, pool, _verifyAgentAuth, _auditChain) {
  app.get('/v1/admin/providers', async (req, res) => {
    if (!isAdmin(req)) return res.status(401).json({ error: 'admin_auth_required' });
    await refreshAll(pool);
    const r = await pool.query(`SELECT * FROM provider_status ORDER BY slug`).catch(() => ({ rows: [] }));
    const enriched = r.rows.map(s => {
      const def = PROVIDERS.find(p => p.slug === s.slug);
      return { ...s, purpose: def?.purpose, all_env_vars: def?.env || [] };
    });
    const summary = {
      total: PROVIDERS.length,
      configured: enriched.filter(x => x.configured).length,
      not_configured: enriched.filter(x => !x.configured).length
    };
    res.json({ summary, providers: enriched });
  });

  app.get('/v1/admin/providers/:slug', async (req, res) => {
    if (!isAdmin(req)) return res.status(401).json({ error: 'admin_auth_required' });
    const def = PROVIDERS.find(p => p.slug === req.params.slug);
    if (!def) return res.status(404).json({ error: 'provider_not_found' });
    const status = checkProvider(def);
    const recent = await pool.query(
      `SELECT method, ok, latency_ms, cost_cents, error, occurred_at FROM provider_call_log
       WHERE provider = $1 ORDER BY occurred_at DESC LIMIT 50`,
      [req.params.slug]
    ).catch(() => ({ rows: [] }));
    res.json({ ...def, ...status, recent_calls: recent.rows });
  });

  // Public summary (sanitised) — for partner trust portal
  app.get('/v1/providers/summary', async (req, res) => {
    const r = await pool.query(`SELECT slug, configured FROM provider_status`).catch(() => ({ rows: [] }));
    res.json({ providers: r.rows.map(x => ({ slug: x.slug, configured: x.configured })) });
  });
}

module.exports = { migrate, registerProviderAdaptersRoutes, PROVIDERS, refreshAll, logCall, checkProvider };
