// ============================================================================
// demo_seed.js — populate a freshly-deployed substrate with realistic demo
// data so coworkers / investors / journalists who visit see a populated
// dashboard, not an empty shell.
//
// Single endpoint:  POST /v1/admin/demo/seed   (admin token required)
//   → creates 50 demo agents, 10 orgs, 100 transactions, 50 audit events,
//     5 sample workflows, 5 sample directory listings.
// Wipe:             POST /v1/admin/demo/wipe   (admin token required)
//   → removes everything tagged with the 'demo:' DID prefix.
// ============================================================================
const crypto = require('crypto');

const DEMO_DID_PREFIX = 'did:op:demo_';
const DEMO_ORG_PREFIX = 'org_demo_';
const DEMO_TAG = 'demo_seed';

const AGENT_NAMES = [
  'AccountingBot', 'LegalReviewBot', 'ComplianceBot', 'SalesProspectingBot',
  'CustomerSuccessBot', 'DevOpsBot', 'SecurityBot', 'FinanceBot', 'HRBot',
  'ResearchBot', 'NegotiationBot', 'TradingBot', 'TravelBot', 'ContentBot',
  'OnboardingBot', 'SchedulingBot', 'EmailBot', 'PaymentBot', 'MarketplaceBot',
  'ProcurementBot', 'MarketingBot', 'AnalyticsBot', 'DataBot', 'CRMBot',
  'TaxBot', 'TreasuryBot', 'InsuranceBot', 'AuditBot', 'KYCBot', 'AMLBot',
  'NotaryBot', 'CourtsBot', 'GovFilingBot', 'IPRegistryBot', 'ClimateBot',
  'HealthBot', 'PassportBot', 'LogisticsBot', 'PropertyBot', 'RoboticsBot',
  'SkillsBot', 'PromptBot', 'BenchmarkBot', 'RecruitingBot', 'SurveysBot',
  'LoyaltyBot', 'ReferralsBot', 'SupportBot', 'LicensingBot', 'EvalBot'
];

const ORG_NAMES = [
  'Acme Corp', 'Globex', 'Initech', 'Wayne Enterprises', 'Pied Piper',
  'Hooli', 'Stark Industries', 'Aperture Science', 'Cyberdyne Systems', 'Tyrell Corp'
];

const TRANSACTION_REASONS = [
  'API usage settlement', 'SaaS subscription', 'Compute invoice',
  'Marketplace cut', 'Inference fee', 'Card top-up', 'A2A service payment',
  'Refund', 'Subscription renewal', 'Bonus payout', 'Referral commission'
];

const WORKFLOW_TEMPLATES = [
  { name: 'Daily KYC re-screen', trigger_kind: 'schedule',
    trigger_config: { interval_minutes: 1440 },
    actions: [{ kind: 'kyc_recheck' }, { kind: 'safety_classify' }] },
  { name: 'On-payment auto-receipt', trigger_kind: 'payment_received',
    trigger_config: {},
    actions: [{ kind: 'send_email', config: { template: 'receipt' } }] },
  { name: 'New lead nurture', trigger_kind: 'form_submission',
    trigger_config: {},
    actions: [{ kind: 'send_email', config: { template: 'welcome' } },
              { kind: 'create_task', config: { project: 'sales' } }] },
  { name: 'Low balance alert', trigger_kind: 'low_balance',
    trigger_config: { threshold_cents: 100000 },
    actions: [{ kind: 'send_sms', config: { template: 'low_balance' } }] },
  { name: 'High-risk transaction review', trigger_kind: 'high_risk_alert',
    trigger_config: { risk_min: 75 },
    actions: [{ kind: 'safety_classify' }, { kind: 'create_task', config: { project: 'compliance' } }] }
];

const DIRECTORY_LISTINGS = [
  ['extension', 'salesforce-sync', 'Salesforce Sync', 'Bi-directional CRM mirror', 'extension.integration', 9900],
  ['extension', 'stripe-deep-link', 'Stripe Deep Link', 'Issue + refund + dispute Stripe charges from agent', 'extension.commerce', 4900],
  ['skill', 'contract-redline-v2', 'Contract Redline v2', 'Legal contract markup with risk flags', 'skill.code', 19900],
  ['prompt', 'pitch-deck-generator', 'Pitch Deck Generator', 'Generates a 12-slide investor deck from a YC application', 'prompt.copywriting', 1900],
  ['dataset', 'agent-eval-baseline', 'Agent Eval Baseline', '10K conversations with quality labels', 'dataset.text', 0]
];

async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS demo_seed_runs (
      run_id            TEXT PRIMARY KEY,
      seeded_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      agents_created    INTEGER NOT NULL DEFAULT 0,
      orgs_created      INTEGER NOT NULL DEFAULT 0,
      transactions_created INTEGER NOT NULL DEFAULT 0,
      workflows_created INTEGER NOT NULL DEFAULT 0,
      listings_created  INTEGER NOT NULL DEFAULT 0,
      wiped_at          TIMESTAMPTZ
    );
  `);
}

function newId(p) { return p + '_' + crypto.randomBytes(10).toString('hex'); }
function isAdmin(req) {
  const t = req.headers['x-admin-token'];
  return require('../safe_compare').safeTokenCompare(t, process.env.OPERATOR_ADMIN_TOKEN);
}

async function seedAll(pool, auditChain) {
  const stats = { agents: 0, orgs: 0, transactions: 0, workflows: 0, listings: 0 };

  // === Agents ===
  for (let i = 0; i < AGENT_NAMES.length; i++) {
    const did = DEMO_DID_PREFIX + i.toString().padStart(3, '0') + '_' + crypto.randomBytes(6).toString('hex').slice(0, 12);
    const { publicKey } = crypto.generateKeyPairSync('ed25519');
    const pubPem = publicKey.export({ type: 'spki', format: 'pem' });
    await pool.query(
      `INSERT INTO identities (did, public_key, metadata) VALUES ($1,$2,$3::jsonb) ON CONFLICT (did) DO NOTHING`,
      [did, pubPem, JSON.stringify({ display_name: AGENT_NAMES[i], tag: DEMO_TAG, demo: true,
                                       avatar_emoji: ['🤖', '🦾', '🪄', '⚙️', '🔮'][i % 5] })]
    ).catch(() => {});
    // Provision wallet metadata (skip on-chain in demo)
    await pool.query(
      `INSERT INTO bank_wallets (agent_did, chain, address, encrypted_key, kek_salt, public_key)
       VALUES ($1, 'base', $2, $3, $4, $5)
       ON CONFLICT (agent_did, chain) DO NOTHING`,
      [did, '0x' + crypto.randomBytes(20).toString('hex'),
       Buffer.from('demo_encrypted_key_placeholder'),
       Buffer.from('demo_salt'), pubPem]
    ).catch(() => {});
    // Seed an internal cents balance (1k-50k USD random)
    const cents = 100000 + Math.floor(Math.random() * 4_900_000);
    await pool.query(
      `INSERT INTO bank_accounts (agent_did, currency, balance_cents, lifetime_in_cents)
       VALUES ($1, 'usd', $2, $2) ON CONFLICT (agent_did) DO NOTHING`,
      [did, cents]
    ).catch(() => {});
    stats.agents++;
  }

  // === Orgs ===
  const ownerDids = [];
  for (let i = 0; i < ORG_NAMES.length; i++) {
    const orgId = DEMO_ORG_PREFIX + i.toString().padStart(2, '0');
    const ownerDid = DEMO_DID_PREFIX + i.toString().padStart(3, '0');
    const plans = ['free', 'pro', 'scale', 'enterprise'];
    const plan = plans[Math.min(3, Math.floor(i / 3))];
    await pool.query(
      `INSERT INTO orgs (org_id, name, slug, kind, billing_email, plan, owner_did, status, metadata)
       VALUES ($1,$2,$3,'company',$4,$5,$6,'active',$7::jsonb)
       ON CONFLICT (org_id) DO NOTHING`,
      [orgId, ORG_NAMES[i],
       ORG_NAMES[i].toLowerCase().replace(/\s+/g, '-') + '-demo',
       `billing@${ORG_NAMES[i].toLowerCase().replace(/\s+/g, '')}.com`, plan,
       null, JSON.stringify({ tag: DEMO_TAG, demo: true })]
    ).catch(() => {});
    ownerDids.push(orgId);
    stats.orgs++;
  }

  // === Transactions ===
  for (let i = 0; i < 100; i++) {
    const fromIdx = Math.floor(Math.random() * AGENT_NAMES.length);
    const toIdx = (fromIdx + 1 + Math.floor(Math.random() * (AGENT_NAMES.length - 1))) % AGENT_NAMES.length;
    const fromDid = DEMO_DID_PREFIX + fromIdx.toString().padStart(3, '0');
    const toDid = DEMO_DID_PREFIX + toIdx.toString().padStart(3, '0');
    const amount = Math.floor(Math.random() * 50000) + 100;
    const reason = TRANSACTION_REASONS[i % TRANSACTION_REASONS.length];
    await pool.query(
      `INSERT INTO bank_transactions (txn_id, agent_did, type, amount_cents, currency, counterparty_did, memo, created_at)
       VALUES ($1, $2, 'transfer_out', $3, 'usd', $4, $5, NOW() - ($6 || ' hours')::interval)
       ON CONFLICT DO NOTHING`,
      [newId('btxn'), fromDid, -amount, toDid, reason, i]
    ).catch(() => {});
    await pool.query(
      `INSERT INTO bank_transactions (txn_id, agent_did, type, amount_cents, currency, counterparty_did, memo, created_at)
       VALUES ($1, $2, 'transfer_in', $3, 'usd', $4, $5, NOW() - ($6 || ' hours')::interval)
       ON CONFLICT DO NOTHING`,
      [newId('btxn'), toDid, amount, fromDid, reason, i]
    ).catch(() => {});
    stats.transactions++;
  }

  // === Audit chain entries ===
  if (auditChain) {
    const eventTypes = ['identity.created', 'bank_chain.transfer', 'kyc.verified',
                        'card.issued', 'savings.deposit', 'inference.completion',
                        'subscription.activated', 'workflow.executed', 'safety.flagged'];
    for (let i = 0; i < 50; i++) {
      const evt = eventTypes[i % eventTypes.length];
      const did = DEMO_DID_PREFIX + (i % AGENT_NAMES.length).toString().padStart(3, '0');
      await auditChain.append({
        event_type: evt, agent_did: did,
        timestamp: new Date(Date.now() - i * 3600 * 1000).toISOString(),
        demo: true
      }).catch(() => {});
    }
  }

  // === Workflows ===
  for (let i = 0; i < WORKFLOW_TEMPLATES.length; i++) {
    const t = WORKFLOW_TEMPLATES[i];
    const did = DEMO_DID_PREFIX + i.toString().padStart(3, '0');
    await pool.query(
      `INSERT INTO workflow_definitions (workflow_id, owner_did, name, trigger_kind, trigger_config, actions, enabled, run_count)
       VALUES ($1,$2,$3,$4,$5,$6,TRUE,$7)`,
      [newId('wf'), did, t.name, t.trigger_kind,
       JSON.stringify(t.trigger_config), JSON.stringify(t.actions),
       Math.floor(Math.random() * 50)]
    ).catch(() => {});
    stats.workflows++;
  }

  // === Directory listings ===
  for (let i = 0; i < DIRECTORY_LISTINGS.length; i++) {
    const [kind, slug, title, desc, category, price] = DIRECTORY_LISTINGS[i];
    const ownerDid = DEMO_DID_PREFIX + i.toString().padStart(3, '0');
    await pool.query(
      `INSERT INTO directory_listings (listing_id, kind, slug, owner_did, title, description,
         category, price_model, price_cents, status, view_count, install_count, rating_avg, rating_count)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'published',$10,$11,$12,$13)
       ON CONFLICT (slug) DO NOTHING`,
      [newId('lst'), kind, 'demo-' + slug, ownerDid, title, desc, category,
       price === 0 ? 'free' : 'one_time', price,
       Math.floor(Math.random() * 10000),
       Math.floor(Math.random() * 1000),
       3.5 + Math.random() * 1.5,
       Math.floor(Math.random() * 200)]
    ).catch(() => {});
    stats.listings++;
  }

  // === Revenue events (so /v1/admin/revenue/dashboard shows something) ===
  try {
    const rev = require('./revenue');
    const layers = ['inference_markup', 'card_interchange', 'usdc_transfer_fee',
                    'subscriptions', 'extensions_marketplace', 'savings_spread'];
    for (let i = 0; i < 100; i++) {
      const layer = layers[i % layers.length];
      const amount = Math.floor(Math.random() * 50000) + 100;
      const orgId = ownerDids[Math.floor(Math.random() * ownerDids.length)];
      await rev.recordRevenue({ pool, source_layer: layer, amount_cents: amount, org_id: orgId });
    }
  } catch {}

  // === Record run ===
  const runId = newId('demo');
  await pool.query(
    `INSERT INTO demo_seed_runs (run_id, agents_created, orgs_created, transactions_created, workflows_created, listings_created)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [runId, stats.agents, stats.orgs, stats.transactions, stats.workflows, stats.listings]
  ).catch(() => {});

  return { run_id: runId, ...stats };
}

async function wipeAll(pool) {
  const stats = {};
  // Wipe in reverse order of foreign keys
  const tables = [
    ['directory_listings', `slug LIKE 'demo-%'`],
    ['workflow_definitions', `owner_did LIKE '${DEMO_DID_PREFIX}%'`],
    ['bank_transactions', `agent_did LIKE '${DEMO_DID_PREFIX}%'`],
    ['bank_wallets', `agent_did LIKE '${DEMO_DID_PREFIX}%'`],
    ['bank_accounts', `agent_did LIKE '${DEMO_DID_PREFIX}%'`],
    ['orgs', `org_id LIKE '${DEMO_ORG_PREFIX}%'`],
    ['identities', `did LIKE '${DEMO_DID_PREFIX}%'`]
  ];
  for (const [t, where] of tables) {
    try {
      const r = await pool.query(`DELETE FROM ${t} WHERE ${where} RETURNING 1`);
      stats[t] = r.rows.length;
    } catch (e) { stats[t] = 'error:' + (e.message || '').slice(0, 60); }
  }
  await pool.query(`UPDATE demo_seed_runs SET wiped_at = NOW() WHERE wiped_at IS NULL`).catch(() => {});
  return stats;
}

function registerDemoSeedRoutes(app, pool, _verifyAgentAuth, auditChain) {
  app.post('/v1/admin/demo/seed', async (req, res) => {
    if (!isAdmin(req)) return res.status(401).json({ error: 'admin_auth_required' });
    try {
      const stats = await seedAll(pool, auditChain);
      if (auditChain) await auditChain.append({ event_type: 'demo.seeded', ...stats }).catch(() => {});
      res.status(201).json({ ok: true, ...stats,
        explore: { dashboard: '/v1/dashboard', admin_hq: '/v1/admin/hq', console: '/console',
                    revenue_dashboard: '/v1/admin/revenue/dashboard', growth_plan: '/v1/admin/growth-plan/dashboard',
                    public_directory: '/v1/directory/search' } });
    } catch (e) {
      res.status(500).json({ error: 'seed_failed', message: e.message });
    }
  });

  app.post('/v1/admin/demo/wipe', async (req, res) => {
    if (!isAdmin(req)) return res.status(401).json({ error: 'admin_auth_required' });
    const stats = await wipeAll(pool);
    if (auditChain) await auditChain.append({ event_type: 'demo.wiped', stats }).catch(() => {});
    res.json({ ok: true, wiped: stats });
  });

  app.get('/v1/admin/demo/runs', async (req, res) => {
    if (!isAdmin(req)) return res.status(401).json({ error: 'admin_auth_required' });
    const r = await pool.query(`SELECT * FROM demo_seed_runs ORDER BY seeded_at DESC LIMIT 50`).catch(() => ({ rows: [] }));
    res.json({ runs: r.rows });
  });
}

module.exports = { migrate, registerDemoSeedRoutes, seedAll, wipeAll, AGENT_NAMES, ORG_NAMES };
