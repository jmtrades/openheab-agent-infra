// ============================================================================
// OpenHeab Agent-Native Substrate — Master Integration
// 100+ primitives, the complete super-hub for AI agents and AGI.
// ============================================================================

const PRIMITIVE_NAMES = [
  // Layer 1 — Kernel
  'identity', 'secrets', 'aliases', 'storage', 'cost', 'analytics', 'portability', 'intelligence',
  // Layer 2 — Runtime
  'memory', 'tools', 'workflows', 'scheduler', 'inbox', 'inference', 'eval', 'continuity',
  // Layer 3 — Commerce
  'bank', 'bank_chain', 'bank_extensions', 'bank_config', 'bank_account', 'crypto', 'commerce', 'payouts', 'x402', 'escrow',
  'cards', 'savings',
  // Layer 4 — Trust
  'reputation', 'kyc', 'kyc_extensions', 'security', 'insurance', 'biometrics', 'aml', 'fraud',
  'notary', 'tripwires', 'reversibility',
  // Layer 5 — Marketplace
  'marketplace', 'extensions', 'prompts', 'datasets', 'mcp_server',
  // Layer 6 — Operations
  'governance', 'publishing', 'email', 'phone', 'deployment', 'oauth_bridge', 'entities', 'tax',
  // Layer 7 — Perception (new)
  'sandbox', 'browser', 'voice', 'vision', 'video', 'search',
  // Layer 8 — Knowledge (new)
  'documents', 'maps', 'knowledge', 'translate', 'moderation', 'fact_check',
  // Layer 9 — Web3 finance (new)
  'multisig', 'lending', 'defi', 'tokens', 'nft', 'bridges',
  // Layer 10 — Infrastructure (new)
  'dns', 'hosting', 'database', 'ipfs', 'cache', 'cdn',
  // Layer 11 — AGI cognition (new)
  'planning', 'simulation', 'beliefs', 'goals', 'skills', 'causal',
  // Layer 12 — AGI ops (new)
  'interpretability', 'fine_tuning', 'federated_learning',
  // Layer 13 — Org / business (new)
  'crm', 'projects', 'leads', 'outreach', 'forms', 'dao_factory',
  // Layer 14 — Business essentials (new)
  'chat', 'invoicing', 'compute', 'news', 'calendar', 'billing', 'contracts', 'courts',
  // Layer 15 — Domain primitives (new)
  'health', 'passport', 'logistics', 'property', 'robotics', 'api_management',
  // Layer 16 — Revenue commerce (new)
  'brokerage', 'prediction_markets', 'shopping', 'travel', 'advertising', 'media', 'ratings', 'booking',
  // Layer 17 — Developer infrastructure (new)
  'github', 'ci_cd', 'monitoring', 'error_tracking', 'feature_flags', 'experiments', 'webhooks', 'events',
  // Layer 18 — AGI learning + gov/legal (new)
  'learning', 'voice_agents', 'labs', 'gov_filing', 'legal_research', 'court_records', 'ip_registry', 'climate',
  // Layer 19 — Customer service + community (new)
  'support', 'referrals', 'loyalty', 'surveys', 'recruiting', 'supply_chain', 'licensing', 'benchmarks',
  // Layer 20 — Org / billing / commerce ops (new)
  'org', 'subscriptions', 'metering', 'revenue',
  // Layer 21 — Enterprise readiness (new)
  'sso', 'rbac', 'compliance_pack', 'credits',
  // Layer 22 — Growth + distribution (new)
  'onboarding', 'dashboard', 'embed', 'public_directory',
  // Layer 23 — Channel + payments accelerators (new)
  'partnerships', 'whitelabel', 'ach', 'quotes',
  // Layer 24 — Realtime (new)
  'realtime'
];

// Lazy loader — gracefully skips primitives that aren't on disk yet
const primitives = {};
for (const name of PRIMITIVE_NAMES) {
  try { primitives[name] = require('./primitives/' + name); }
  catch (e) { /* primitive not yet written — skip */ }
}

// Map primitive name → register function name (most are computed, a few overrides)
const REGISTER_OVERRIDES = {
  bank: 'registerBankRoutes',
  bank_chain: 'registerBankChainRoutes',
  bank_extensions: 'registerBankExtensionRoutes',
  bank_account: 'registerBankAccountRoutes',
  crypto: 'registerCryptoRoutes',
  identity: 'registerIdentityRotationRoutes',
  reputation: 'registerReputationRoutes',
  marketplace: 'registerMarketplaceRoutes',
  publishing: 'registerPublishingRoutes',
  governance: 'registerGovernanceRoutes',
  analytics: 'registerAnalyticsRoutes',
  eval: 'registerEvalRoutes',
  continuity: 'registerContinuityRoutes',
  kyc: 'registerKycRoutes',
  kyc_extensions: 'registerKycExtensionRoutes',
  email: 'registerEmailRoutes',
  extensions: 'registerExtensionRoutes',
  commerce: 'registerCommerceRoutes',
  storage: 'registerStorageRoutes',
  secrets: 'registerSecretsRoutes',
  cost: 'registerCostRoutes',
  workflows: 'registerWorkflowRoutes',
  inference: 'registerInferenceRoutes',
  security: 'registerSecurityRoutes',
  tools: 'registerToolsRoutes',
  intelligence: 'registerIntelligenceRoutes',
  deployment: 'registerDeploymentRoutes',
  payouts: 'registerPayoutsRoutes',
  mcp_server: 'registerMcpRoutes',
  prompts: 'registerPromptsRoutes',
  aliases: 'registerAliasesRoutes',
  scheduler: 'registerSchedulerRoutes',
  oauth_bridge: 'registerOAuthRoutes',
  insurance: 'registerInsuranceRoutes',
  x402: 'registerX402Routes',
  escrow: 'registerEscrowRoutes',
  datasets: 'registerDatasetsRoutes',
  entities: 'registerEntitiesRoutes',
  tax: 'registerTaxRoutes',
  portability: 'registerPortabilityRoutes',
  inbox: 'registerInboxRoutes',
  memory: 'registerMemoryRoutes',
  phone: 'registerPhoneRoutes',
  fact_check: 'registerFactCheckRoutes',
  dao_factory: 'registerDaoFactoryRoutes',
  federated_learning: 'registerFederatedLearningRoutes',
  fine_tuning: 'registerFineTuningRoutes',
  api_management: 'registerApiManagementRoutes',
  bank_extensions: 'registerBankExtensionRoutes',
  cards: 'registerCardRoutes',
  savings: 'registerSavingsRoutes',
  health: 'registerHealthRoutes',
  passport: 'registerPassportRoutes',
  logistics: 'registerLogisticsRoutes',
  property: 'registerPropertyRoutes',
  robotics: 'registerRoboticsRoutes',
  documents: 'registerDocumentsRoutes',
  maps: 'registerMapsRoutes',
  knowledge: 'registerKnowledgeRoutes',
  translate: 'registerTranslateRoutes',
  moderation: 'registerModerationRoutes',
  sandbox: 'registerSandboxRoutes',
  browser: 'registerBrowserRoutes',
  voice: 'registerVoiceRoutes',
  vision: 'registerVisionRoutes',
  video: 'registerVideoRoutes',
  search: 'registerSearchRoutes',
  multisig: 'registerMultisigRoutes',
  lending: 'registerLendingRoutes',
  defi: 'registerDefiRoutes',
  tokens: 'registerTokensRoutes',
  nft: 'registerNftRoutes',
  bridges: 'registerBridgesRoutes',
  dns: 'registerDnsRoutes',
  hosting: 'registerHostingRoutes',
  database: 'registerDatabaseRoutes',
  ipfs: 'registerIpfsRoutes',
  cache: 'registerCacheRoutes',
  cdn: 'registerCdnRoutes',
  planning: 'registerPlanningRoutes',
  simulation: 'registerSimulationRoutes',
  beliefs: 'registerBeliefsRoutes',
  goals: 'registerGoalsRoutes',
  skills: 'registerSkillsRoutes',
  causal: 'registerCausalRoutes',
  interpretability: 'registerInterpretabilityRoutes',
  reversibility: 'registerReversibilityRoutes',
  tripwires: 'registerTripwiresRoutes',
  notary: 'registerNotaryRoutes',
  crm: 'registerCrmRoutes',
  projects: 'registerProjectsRoutes',
  leads: 'registerLeadsRoutes',
  outreach: 'registerOutreachRoutes',
  forms: 'registerFormsRoutes',
  fraud: 'registerFraudRoutes',
  biometrics: 'registerBiometricsRoutes',
  aml: 'registerAmlRoutes',
  chat: 'registerChatRoutes',
  invoicing: 'registerInvoicingRoutes',
  compute: 'registerComputeRoutes',
  news: 'registerNewsRoutes',
  calendar: 'registerCalendarRoutes',
  billing: 'registerBillingRoutes',
  contracts: 'registerContractsRoutes',
  courts: 'registerCourtsRoutes',
  // Layer 16 — Revenue commerce
  brokerage: 'registerBrokerageRoutes',
  prediction_markets: 'registerPredictionMarketsRoutes',
  shopping: 'registerShoppingRoutes',
  travel: 'registerTravelRoutes',
  advertising: 'registerAdvertisingRoutes',
  media: 'registerMediaRoutes',
  ratings: 'registerRatingsRoutes',
  booking: 'registerBookingRoutes',
  // Layer 17 — Developer infrastructure
  github: 'registerGithubRoutes',
  ci_cd: 'registerCiCdRoutes',
  monitoring: 'registerMonitoringRoutes',
  error_tracking: 'registerErrorTrackingRoutes',
  feature_flags: 'registerFeatureFlagsRoutes',
  experiments: 'registerExperimentsRoutes',
  webhooks: 'registerWebhooksRoutes',
  events: 'registerEventsRoutes',
  // Layer 18 — AGI learning + gov/legal
  learning: 'registerLearningRoutes',
  voice_agents: 'registerVoiceAgentsRoutes',
  labs: 'registerLabsRoutes',
  gov_filing: 'registerGovFilingRoutes',
  legal_research: 'registerLegalResearchRoutes',
  court_records: 'registerCourtRecordsRoutes',
  ip_registry: 'registerIpRegistryRoutes',
  climate: 'registerClimateRoutes',
  // Layer 19 — Customer service + community
  support: 'registerSupportRoutes',
  referrals: 'registerReferralsRoutes',
  loyalty: 'registerLoyaltyRoutes',
  surveys: 'registerSurveysRoutes',
  recruiting: 'registerRecruitingRoutes',
  supply_chain: 'registerSupplyChainRoutes',
  licensing: 'registerLicensingRoutes',
  benchmarks: 'registerBenchmarksRoutes',
  // Layer 20 — Org / billing / commerce ops
  org: 'registerOrgRoutes',
  subscriptions: 'registerSubscriptionsRoutes',
  metering: 'registerMeteringRoutes',
  revenue: 'registerRevenueRoutes',
  // Layer 21 — Enterprise readiness
  sso: 'registerSsoRoutes',
  rbac: 'registerRbacRoutes',
  compliance_pack: 'registerCompliancePackRoutes',
  credits: 'registerCreditsRoutes',
  // Layer 22 — Growth + distribution
  onboarding: 'registerOnboardingRoutes',
  dashboard: 'registerDashboardRoutes',
  embed: 'registerEmbedRoutes',
  public_directory: 'registerPublicDirectoryRoutes',
  // Layer 23 — Channel + payments accelerators
  partnerships: 'registerPartnershipsRoutes',
  whitelabel: 'registerWhitelabelRoutes',
  ach: 'registerAchRoutes',
  quotes: 'registerQuotesRoutes',
  // Layer 24 — Realtime
  realtime: 'registerRealtimeRoutes'
};

async function migrateAll(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS identities (
      did         TEXT PRIMARY KEY,
      public_key  TEXT NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      metadata    JSONB
    );
    CREATE TABLE IF NOT EXISTS api_keys (
      token_hash  TEXT PRIMARY KEY,
      agent_did   TEXT NOT NULL REFERENCES identities(did) ON DELETE CASCADE,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      revoked_at  TIMESTAMPTZ
    );
    CREATE TABLE IF NOT EXISTS audit_chain (
      length      BIGINT PRIMARY KEY,
      hash        TEXT NOT NULL,
      prev_hash   TEXT NOT NULL,
      entry       JSONB NOT NULL,
      signature   TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_audit_chain_created_at ON audit_chain (created_at DESC);
  `);

  for (const [name, mod] of Object.entries(primitives)) {
    if (typeof mod.migrate === 'function') {
      try { await mod.migrate(pool); }
      catch (e) { console.warn(`[migrate] ${name}: ${e.message}`); }
    }
  }
  try { await require('./rate_limit').migrate(pool); } catch {}
  console.log(`[migrate] ${Object.keys(primitives).length} primitives complete.`);
}

const REQUIRED_ENV = [
  'DATABASE_URL', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET',
  'STRIPE_PRICE_PRO_MONTHLY', 'IDENTITY_MASTER_KEK', 'CRYPTO_MASTER_KEK',
  'OPERATOR_PUBLIC_URL', 'OPENAI_API_KEY'
];

function validateEnv() {
  const missing = REQUIRED_ENV.filter(k => !process.env[k]);
  if (missing.length) throw new Error(`Missing required env vars: ${missing.join(', ')}`);
}

function makeAuditChainAdapter(pool) {
  return {
    async append(entry) {
      const cryptoLib = require('crypto');
      const canonical = JSON.stringify(entry, Object.keys(entry).sort());
      const prev = await pool.query(
        `SELECT hash, length FROM audit_chain ORDER BY length DESC LIMIT 1`
      ).catch(() => ({ rows: [] }));
      const prevHash = prev.rows[0]?.hash || '0'.repeat(64);
      const nextLength = (parseInt(prev.rows[0]?.length || 0)) + 1;
      const hash = cryptoLib.createHash('sha256').update(canonical + prevHash).digest('hex');
      await pool.query(`
        INSERT INTO audit_chain (length, hash, prev_hash, entry, created_at)
        VALUES ($1, $2, $3, $4::jsonb, NOW())
        ON CONFLICT (length) DO NOTHING
      `, [nextLength, hash, prevHash, canonical]).catch(() => {});
      return { hash, length: nextLength };
    }
  };
}

function makeVerifyAgentAuth(pool) {
  return async function verifyAgentAuth(req, agentDid, opts = {}) {
    if (process.env.DEMO_MODE === 'true' && req.headers['x-demo-did']) {
      return { valid: true, subject: req.headers['x-demo-did'], signaturePresent: false };
    }
    const agentDidHeader = req.headers['x-agent-did'];
    const agentSig = req.headers['x-agent-sig'];

    if (agentDidHeader && agentSig) {
      const cryptoLib = require('crypto');
      const keyRow = await pool.query(
        `SELECT public_key FROM identity_keys WHERE agent_did = $1 AND status = 'active'
         UNION ALL
         SELECT public_key FROM identities WHERE did = $1 LIMIT 1`,
        [agentDidHeader]
      ).catch(() => ({ rows: [] }));
      if (!keyRow.rows[0]) return { valid: false, error: 'unknown_agent' };

      const path = req.originalUrl || req.url;
      const bodyHash = cryptoLib.createHash('sha256')
        .update(JSON.stringify(req.body || {})).digest('hex');
      const canonical = `${req.method}\n${path}\n${bodyHash}`;

      try {
        const pubKey = cryptoLib.createPublicKey(keyRow.rows[0].public_key);
        const valid = cryptoLib.verify(null, Buffer.from(canonical), pubKey, Buffer.from(agentSig, 'hex'));
        if (!valid) return { valid: false, error: 'invalid_signature' };
        if (agentDid && agentDidHeader !== agentDid) return { valid: false, error: 'signature_did_mismatch' };
        return { valid: true, subject: agentDidHeader, signaturePresent: true };
      } catch (e) { return { valid: false, error: 'signature_verification_failed' }; }
    }

    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.slice(7);
      const r = await pool.query(
        `SELECT agent_did FROM api_keys WHERE token_hash = $1 AND revoked_at IS NULL`,
        [require('crypto').createHash('sha256').update(token).digest('hex')]
      ).catch(() => ({ rows: [] }));
      if (r.rows[0]) {
        if (agentDid && r.rows[0].agent_did !== agentDid) return { valid: false, error: 'api_key_did_mismatch' };
        return { valid: true, subject: r.rows[0].agent_did, signaturePresent: false };
      }
    }

    if (opts.strictSignatureRequired) return { valid: false, error: 'this_endpoint_requires_signed_request' };
    return { valid: false, error: 'missing_auth' };
  };
}

function makeVerifyAdminAuth() {
  return async function verifyAdminAuth(req) {
    const token = req.headers['x-admin-token'];
    if (token && token === process.env.OPERATOR_ADMIN_TOKEN) return { valid: true, did: 'did:op:admin' };
    return { valid: false };
  };
}

function makeStripeClient() {
  if (!process.env.STRIPE_SECRET_KEY) return null;
  const Stripe = require('stripe');
  return new Stripe(process.env.STRIPE_SECRET_KEY);
}

function makeTwilioClient() {
  if (!process.env.TWILIO_ACCOUNT_SID) return null;
  const Twilio = require('twilio');
  return new Twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
}

function registerIdentityBootstrap(app, pool, auditChain) {
  const express = require('express');
  const cryptoLib = require('crypto');
  const { rateLimit } = require('./rate_limit');

  const signupLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: parseInt(process.env.IDENTITY_SIGNUP_LIMIT_PER_HOUR || '10'),
    pool,
    keyer: (req) => {
      const fwd = req.headers['x-forwarded-for'];
      const ip = (fwd ? fwd.split(',')[0].trim() : (req.ip || 'unknown'));
      return `signup:${ip}`;
    }
  });

  app.post('/v1/identities', signupLimiter, express.json(), async (req, res) => {
    try {
      const { publicKey, privateKey } = cryptoLib.generateKeyPairSync('ed25519');
      const pubPem = publicKey.export({ type: 'spki', format: 'pem' });
      const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
      const fingerprint = cryptoLib.createHash('sha256').update(pubPem).digest('hex').slice(0, 32);
      const did = `did:op:${fingerprint}`;

      const fwd = req.headers['x-forwarded-for'];
      const signupIp = (fwd ? fwd.split(',')[0].trim() : (req.ip || 'unknown'));
      const metadata = { ...(req.body || {}), signup_ip: signupIp };
      await pool.query(
        `INSERT INTO identities (did, public_key, metadata) VALUES ($1, $2, $3::jsonb)
         ON CONFLICT (did) DO NOTHING`,
        [did, pubPem, JSON.stringify(metadata)]
      );

      const apiKey = 'opk_' + cryptoLib.randomBytes(24).toString('hex');
      const tokenHash = cryptoLib.createHash('sha256').update(apiKey).digest('hex');
      await pool.query(
        `INSERT INTO api_keys (token_hash, agent_did) VALUES ($1, $2)`,
        [tokenHash, did]
      );

      await auditChain.append({
        event_type: 'identity.created', did, timestamp: new Date().toISOString()
      });

      let wallet = null;
      if (primitives.bank_chain) {
        try { wallet = await primitives.bank_chain.provisionWallet(pool, auditChain, did); }
        catch (e) { console.warn('[identity.create] wallet provision failed:', e.message); }
      }

      return res.status(201).json({
        did, public_key: pubPem, private_key: privPem, api_key: apiKey,
        wallet: wallet ? { address: wallet.address, chain: wallet.chain } : null
      });
    } catch (e) {
      console.error('[identity.create]', e);
      return res.status(500).json({ error: 'identity_creation_failed' });
    }
  });

  app.get('/v1/identities/:did', async (req, res) => {
    const r = await pool.query(
      `SELECT did, public_key, created_at, metadata FROM identities WHERE did = $1`,
      [req.params.did]
    ).catch(() => ({ rows: [] }));
    if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
    return res.json(r.rows[0]);
  });

  app.get('/v1/audit/verify', async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 1000, 10000);
    const r = await pool.query(
      `SELECT length, hash, prev_hash, entry FROM audit_chain ORDER BY length ASC LIMIT $1`, [limit]
    ).catch(() => ({ rows: [] }));
    let ok = true;
    let prevHash = '0'.repeat(64);
    for (const row of r.rows) {
      const expected = cryptoLib.createHash('sha256')
        .update(JSON.stringify(row.entry, Object.keys(row.entry).sort()) + prevHash).digest('hex');
      if (row.hash !== expected || row.prev_hash !== prevHash) { ok = false; break; }
      prevHash = row.hash;
    }
    const totalRow = await pool.query(`SELECT COUNT(*) AS n FROM audit_chain`)
      .catch(() => ({ rows: [{ n: 0 }] }));
    return res.json({ valid: ok, verified: r.rows.length, total: parseInt(totalRow.rows[0].n) });
  });

  app.get('/v1/audit/chain', async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    const offset = Math.max(parseInt(req.query.offset) || 0, 0);
    const r = await pool.query(
      `SELECT length, hash, prev_hash, entry, created_at FROM audit_chain
       ORDER BY length DESC LIMIT $1 OFFSET $2`, [limit, offset]
    ).catch(() => ({ rows: [] }));
    return res.json({ entries: r.rows });
  });
}

function registerAllRoutes(app, pool) {
  const auditChain = makeAuditChainAdapter(pool);
  const verifyAgentAuth = makeVerifyAgentAuth(pool);
  const verifyAdminAuth = makeVerifyAdminAuth();
  const stripe = makeStripeClient();
  const twilio = makeTwilioClient();

  registerIdentityBootstrap(app, pool, auditChain);

  // Register all available primitives via the override map
  let registered = 0;
  for (const [name, mod] of Object.entries(primitives)) {
    const fnName = REGISTER_OVERRIDES[name];
    if (!fnName) continue;
    const fn = mod[fnName];
    if (typeof fn !== 'function') continue;

    try {
      // Special cases that need extra args
      if (name === 'bank' && !stripe) continue;
      if (name === 'bank') { fn(app, pool, verifyAgentAuth, auditChain, stripe); registered++; continue; }
      if (name === 'phone' && !twilio) continue;
      if (name === 'phone') {
        fn(app, pool, verifyAgentAuth, auditChain, twilio, primitives.inbox, process.env.TWILIO_AUTH_TOKEN);
        registered++; continue;
      }
      if (name === 'reputation') {
        fn(app, pool, verifyAgentAuth, verifyAdminAuth, auditChain, primitives.bank);
        registered++; continue;
      }
      if (name === 'marketplace') {
        fn(app, pool, verifyAgentAuth, auditChain, primitives.bank);
        registered++; continue;
      }
      if (name === 'outreach') {
        fn(app, pool, verifyAgentAuth, auditChain, primitives.email);
        registered++; continue;
      }

      // Default signature
      fn(app, pool, verifyAgentAuth, auditChain);
      registered++;
    } catch (e) {
      console.warn(`[register] ${name}: ${e.message}`);
    }
  }

  // Stripe webhook (must come BEFORE express.json since it needs raw body)
  if (stripe && primitives.bank) {
    const express = require('express');
    app.post('/v1/_webhooks/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
      const sig = req.headers['stripe-signature'];
      let event;
      try {
        event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
      } catch (e) {
        return res.status(400).json({ error: `webhook_signature_invalid: ${e.message}` });
      }
      if (event.type === 'checkout.session.completed') {
        try { await primitives.bank.handleTopupCompleted(event.data.object, pool, auditChain); }
        catch (e) { console.error('[stripe.webhook]', e); }
      }
      res.json({ received: true });
    });
  }

  // Agent search (top-level utility)
  app.get('/v1/agents/search', async (req, res) => {
    const q = req.query.q;
    const category = req.query.category;
    const minRep = parseFloat(req.query.min_reputation || '0');
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);

    const params = [minRep, limit];
    const conditions = [`COALESCE(rs.score, 0.5) >= $1`];
    if (q) {
      params.push(`%${q}%`);
      conditions.push(`(p.display_name ILIKE $${params.length} OR p.bio ILIKE $${params.length})`);
    }
    if (category) {
      params.push(category);
      conditions.push(`(p.tags @> ARRAY[$${params.length}::text] OR p.bio ILIKE '%' || $${params.length} || '%')`);
    }

    const r = await pool.query(`
      SELECT p.agent_did, p.display_name, p.bio, p.tags,
             COALESCE(rs.score, 0.5)::real AS reputation_score
      FROM agent_profiles p
      LEFT JOIN reputation_scores rs ON rs.agent_did = p.agent_did
      WHERE ${conditions.join(' AND ')}
      ORDER BY reputation_score DESC
      LIMIT $2
    `, params).catch(() => ({ rows: [] }));
    return res.json({ query: req.query, results: r.rows, count: r.rows.length });
  });

  // GDPR export
  app.get('/v1/agents/:did/gdpr-export', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });

    const export_data = { agent_did: did, exported_at: new Date().toISOString(), tables: {} };
    // List of tables to scan for the agent's data
    const candidateCols = ['agent_did','did','subject_did','caller_did','from_did',
                          'to_did','recipient_did','author_did','owner_did',
                          'publisher_did', 'holder_did', 'patient_did',
                          'controlling_did', 'insured_did', 'lessor_did',
                          'lessee_did', 'controller_did', 'voucher_did', 'follower_did'];
    const tablesR = await pool.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' LIMIT 500
    `).catch(() => ({ rows: [] }));
    for (const t of tablesR.rows) {
      try {
        const colsR = await pool.query(`
          SELECT column_name FROM information_schema.columns
          WHERE table_name = $1 AND column_name = ANY($2::text[])
        `, [t.table_name, candidateCols]).catch(() => ({ rows: [] }));
        const cols = colsR.rows.map(r => r.column_name);
        if (cols.length === 0) continue;
        const whereSql = cols.map(c => `${c} = $1`).join(' OR ');
        const r = await pool.query(
          `SELECT * FROM ${t.table_name} WHERE ${whereSql} LIMIT 10000`, [did]
        ).catch(() => ({ rows: [] }));
        if (r.rows && r.rows.length) export_data.tables[t.table_name] = r.rows;
      } catch {}
    }

    auditChain.append({
      event_type: 'gdpr.data_exported', agent_did: did,
      table_count: Object.keys(export_data.tables).length,
      timestamp: new Date().toISOString()
    }).catch(() => {});

    res.setHeader('content-type', 'application/json');
    res.setHeader('content-disposition',
      `attachment; filename="openheab-export-${did.slice(7, 19)}.json"`);
    res.send(JSON.stringify(export_data, null, 2));
  });

  // Background jobs (a few common ones)
  const { registerCron } = require('./cron_auth');
  if (primitives.memory) {
    registerCron(app, '/v1/_jobs/expire-kv', async (req, res) => {
      const r = await primitives.memory.expireKv(pool).catch(e => ({ error: e.message }));
      res.json(r);
    });
  }
  if (primitives.inbox) {
    registerCron(app, '/v1/_jobs/expire-inbox', async (req, res) => {
      const r = await primitives.inbox.cleanupExpiredEnvelopes(pool, auditChain).catch(e => ({ error: e.message }));
      res.json(r);
    });
  }

  console.log(`[openheab] ${registered} primitives + MCP server registered.`);
}

module.exports = {
  migrateAll, registerAllRoutes, validateEnv,
  makeAuditChainAdapter, makeVerifyAgentAuth, makeVerifyAdminAuth,
  primitives, PRIMITIVE_NAMES
};
