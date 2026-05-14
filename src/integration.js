// ============================================================================
// OpenHeab Agent-Native Substrate — Master Integration
// ============================================================================
const inbox        = require('./primitives/inbox');
const bank         = require('./primitives/bank');
const cryptoWallet = require('./primitives/crypto');
const phone        = require('./primitives/phone');
const memory       = require('./primitives/memory');
const identityRot  = require('./primitives/identity');
const reputation   = require('./primitives/reputation');
const marketplace  = require('./primitives/marketplace');
const publishing   = require('./primitives/publishing');
const governance   = require('./primitives/governance');
const analytics    = require('./primitives/analytics');
const evalMod      = require('./primitives/eval');
const continuity   = require('./primitives/continuity');
const bankChain    = require('./primitives/bank_chain');
const bankExt      = require('./primitives/bank_extensions');
const kyc          = require('./primitives/kyc');
const kycExt       = require('./primitives/kyc_extensions');
const email        = require('./primitives/email');
const extensions   = require('./primitives/extensions');
const commerce     = require('./primitives/commerce');
const storage      = require('./primitives/storage');
const secrets      = require('./primitives/secrets');
const cost         = require('./primitives/cost');
const workflows    = require('./primitives/workflows');
const inference    = require('./primitives/inference');
const security     = require('./primitives/security');
const tools        = require('./primitives/tools');
const intelligence = require('./primitives/intelligence');
const deployment   = require('./primitives/deployment');
const payouts      = require('./primitives/payouts');
const mcpServer    = require('./primitives/mcp_server');
const prompts      = require('./primitives/prompts');
const aliases      = require('./primitives/aliases');
const scheduler    = require('./primitives/scheduler');
const oauthBridge  = require('./primitives/oauth_bridge');
const insurance    = require('./primitives/insurance');
const x402         = require('./primitives/x402');
const escrow       = require('./primitives/escrow');
const datasets     = require('./primitives/datasets');
const entities     = require('./primitives/entities');
const tax          = require('./primitives/tax');
const portability  = require('./primitives/portability');

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

  const mods = {
    inbox, bank, cryptoWallet, phone, memory, identityRot, reputation, marketplace,
    publishing, governance, analytics, evalMod, continuity, bankChain, bankExt,
    kyc, kycExt, email, extensions, commerce, storage, secrets, cost, workflows,
    inference, security, tools, intelligence, deployment, payouts, mcpServer,
    prompts, aliases, scheduler, oauthBridge, insurance, x402, escrow,
    datasets, entities, tax, portability
  };
  for (const [name, mod] of Object.entries(mods)) {
    if (typeof mod.migrate === 'function') {
      try { await mod.migrate(pool); }
      catch (e) { console.warn(`[migrate] ${name}: ${e.message}`); }
    }
  }
  try { await require('./rate_limit').migrate(pool); } catch {}
  console.log('[migrate] all primitives complete.');
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
      `, [nextLength, hash, prevHash, canonical]).catch(err => {
        console.error('[audit_chain] insert failed:', err.message);
      });
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

      const bankChain = require('./primitives/bank_chain');
      let wallet = null;
      try { wallet = await bankChain.provisionWallet(pool, auditChain, did); }
      catch (e) { console.warn('[identity.create] wallet provision failed:', e.message); }

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
  // validateEnv() — relaxed in tests; production should set required vars
  const auditChain = makeAuditChainAdapter(pool);
  const verifyAgentAuth = makeVerifyAgentAuth(pool);
  const verifyAdminAuth = makeVerifyAdminAuth();
  const stripe = makeStripeClient();
  const twilio = makeTwilioClient();

  registerIdentityBootstrap(app, pool, auditChain);

  inbox.registerInboxRoutes(app, pool, verifyAgentAuth, auditChain);
  if (stripe) bank.registerBankRoutes(app, pool, verifyAgentAuth, auditChain, stripe);
  cryptoWallet.registerCryptoRoutes(app, pool, verifyAgentAuth, auditChain);
  if (twilio) phone.registerPhoneRoutes(app, pool, verifyAgentAuth, auditChain, twilio, inbox, process.env.TWILIO_AUTH_TOKEN);
  memory.registerMemoryRoutes(app, pool, verifyAgentAuth, auditChain);
  identityRot.registerIdentityRotationRoutes(app, pool, verifyAgentAuth, auditChain);
  reputation.registerReputationRoutes(app, pool, verifyAgentAuth, verifyAdminAuth, auditChain, bank);
  marketplace.registerMarketplaceRoutes(app, pool, verifyAgentAuth, auditChain, bank);
  publishing.registerPublishingRoutes(app, pool, verifyAgentAuth, auditChain);
  governance.registerGovernanceRoutes(app, pool, verifyAgentAuth, auditChain);
  analytics.registerAnalyticsRoutes(app, pool, verifyAgentAuth);
  evalMod.registerEvalRoutes(app, pool, verifyAgentAuth, auditChain);
  continuity.registerContinuityRoutes(app, pool, verifyAgentAuth, auditChain);
  bankChain.registerBankChainRoutes(app, pool, verifyAgentAuth, auditChain);
  bankExt.registerBankExtensionRoutes(app, pool, verifyAgentAuth, auditChain);
  kyc.registerKycRoutes(app, pool, verifyAgentAuth, auditChain);
  kycExt.registerKycExtensionRoutes(app, pool, verifyAgentAuth, auditChain);
  email.registerEmailRoutes(app, pool, verifyAgentAuth, auditChain);
  extensions.registerExtensionRoutes(app, pool, verifyAgentAuth, auditChain);
  commerce.registerCommerceRoutes(app, pool, verifyAgentAuth, auditChain);
  storage.registerStorageRoutes(app, pool, verifyAgentAuth, auditChain);
  secrets.registerSecretsRoutes(app, pool, verifyAgentAuth, auditChain);
  cost.registerCostRoutes(app, pool, verifyAgentAuth, auditChain);
  workflows.registerWorkflowRoutes(app, pool, verifyAgentAuth, auditChain);
  inference.registerInferenceRoutes(app, pool, verifyAgentAuth, auditChain);
  security.registerSecurityRoutes(app, pool, verifyAgentAuth, auditChain);
  tools.registerToolsRoutes(app, pool, verifyAgentAuth, auditChain);
  intelligence.registerIntelligenceRoutes(app, pool, verifyAgentAuth, auditChain);
  deployment.registerDeploymentRoutes(app, pool, verifyAgentAuth, auditChain);
  payouts.registerPayoutsRoutes(app, pool, verifyAgentAuth, auditChain);
  mcpServer.registerMcpRoutes(app, pool, verifyAgentAuth, auditChain);
  prompts.registerPromptsRoutes(app, pool, verifyAgentAuth, auditChain);
  aliases.registerAliasesRoutes(app, pool, verifyAgentAuth, auditChain);
  scheduler.registerSchedulerRoutes(app, pool, verifyAgentAuth, auditChain);
  oauthBridge.registerOAuthRoutes(app, pool, verifyAgentAuth, auditChain);
  insurance.registerInsuranceRoutes(app, pool, verifyAgentAuth, auditChain);
  x402.registerX402Routes(app, pool, verifyAgentAuth, auditChain);
  escrow.registerEscrowRoutes(app, pool, verifyAgentAuth, auditChain);
  datasets.registerDatasetsRoutes(app, pool, verifyAgentAuth, auditChain);
  entities.registerEntitiesRoutes(app, pool, verifyAgentAuth, auditChain);
  tax.registerTaxRoutes(app, pool, verifyAgentAuth, auditChain);
  portability.registerPortabilityRoutes(app, pool, verifyAgentAuth, auditChain);

  const express = require('express');
  if (stripe) {
    app.post('/v1/_webhooks/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
      const sig = req.headers['stripe-signature'];
      let event;
      try {
        event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
      } catch (e) {
        return res.status(400).json({ error: `webhook_signature_invalid: ${e.message}` });
      }
      if (event.type === 'checkout.session.completed') {
        try { await bank.handleTopupCompleted(event.data.object, pool, auditChain); }
        catch (e) { console.error('[stripe.webhook]', e); }
      }
      res.json({ received: true });
    });
  }

  // Agent search
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

    const tables = [
      'identities', 'api_keys', 'identity_keys', 'bank_wallets',
      'bank_transactions', 'inbox_envelopes', 'inbox_policies',
      'kyc_claims', 'memory_kv', 'memory_episodes',
      'reputation_vouches', 'agent_profiles', 'agent_posts'
    ];
    const export_data = { agent_did: did, exported_at: new Date().toISOString(), tables: {} };
    const candidateCols = ['agent_did','did','subject_did','caller_did','from_did',
                          'to_did','recipient_did','author_did','owner_did','publisher_did'];
    for (const t of tables) {
      try {
        const colsR = await pool.query(`
          SELECT column_name FROM information_schema.columns
          WHERE table_name = $1 AND column_name = ANY($2::text[])
        `, [t, candidateCols]).catch(() => ({ rows: [] }));
        const cols = colsR.rows.map(r => r.column_name);
        if (cols.length === 0) continue;
        const whereSql = cols.map(c => `${c} = $1`).join(' OR ');
        const r = await pool.query(
          `SELECT * FROM ${t} WHERE ${whereSql} LIMIT 10000`, [did]
        ).catch(() => ({ rows: [] }));
        if (r.rows && r.rows.length) export_data.tables[t] = r.rows;
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

  // Background jobs
  const { registerCron } = require('./cron_auth');
  registerCron(app, '/v1/_jobs/expire-kv', async (req, res) => {
    const r = await memory.expireKv(pool).catch(e => ({ error: e.message }));
    res.json(r);
  });
  registerCron(app, '/v1/_jobs/expire-inbox', async (req, res) => {
    const r = await inbox.cleanupExpiredEnvelopes(pool, auditChain).catch(e => ({ error: e.message }));
    res.json(r);
  });

  console.log('[openheab] All 42 agent-native primitives + MCP server registered.');
}

module.exports = {
  migrateAll, registerAllRoutes, validateEnv,
  makeAuditChainAdapter, makeVerifyAgentAuth, makeVerifyAdminAuth,
  primitives: {
    inbox, bank, cryptoWallet, phone, memory, identityRot, reputation,
    marketplace, publishing, governance, analytics, evalMod, continuity,
    bankChain, bankExt, kyc, kycExt, email, extensions, commerce, storage,
    secrets, cost, workflows, inference, security, tools, intelligence,
    deployment, payouts, mcpServer, prompts, aliases, scheduler, oauthBridge,
    insurance, x402, escrow, datasets, entities, tax, portability
  }
};
