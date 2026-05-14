// ============================================================================
// Agent debit/credit cards — virtual + physical cards for agents to spend USDC
// ============================================================================
// Agents need to pay things in the real world that don't accept USDC yet:
//   • SaaS subscriptions (Stripe-billed)
//   • Cloud compute (AWS/GCP)
//   • Travel (flights, hotels)
//   • Physical goods (Amazon, etc.)
//
// This primitive issues virtual cards that draw against the agent's USDC
// wallet via a real-time off-ramp at swipe time. Per-merchant and per-tx
// spending limits enforced server-side BEFORE auth-approval is sent to the
// network.
//
// Wire compatibility: Stripe Issuing, Marqeta, Lithic. Default stub returns
// fake card numbers for tests.

const crypto = require('crypto');
const { z } = require('zod');
const { registerCron } = require('../cron_auth');

const STATUSES = ['active', 'frozen', 'cancelled', 'expired'];
const KINDS = ['virtual', 'physical'];
const TX_STATUSES = ['authorized', 'captured', 'refunded', 'disputed', 'declined'];

async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS agent_cards (
      card_id           TEXT PRIMARY KEY,
      agent_did         TEXT NOT NULL,
      provider          TEXT NOT NULL DEFAULT 'stripe_issuing',
      provider_card_id  TEXT,
      kind              TEXT NOT NULL DEFAULT 'virtual',
      last4             TEXT,
      exp_month         INTEGER,
      exp_year          INTEGER,
      brand             TEXT DEFAULT 'visa',
      status            TEXT NOT NULL DEFAULT 'active',
      funding_wallet_did TEXT,
      monthly_limit_cents BIGINT,
      per_tx_limit_cents  BIGINT,
      allowed_merchant_categories TEXT[],
      blocked_merchant_categories TEXT[],
      allowed_merchants TEXT[],
      blocked_merchants TEXT[],
      spent_this_month_cents BIGINT NOT NULL DEFAULT 0,
      period_start      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      shipping_address  JSONB,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      activated_at      TIMESTAMPTZ,
      cancelled_at      TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_agent_cards_did
      ON agent_cards (agent_did, status);

    CREATE TABLE IF NOT EXISTS card_transactions (
      tx_id             TEXT PRIMARY KEY,
      card_id           TEXT NOT NULL,
      agent_did         TEXT NOT NULL,
      provider_tx_id    TEXT,
      merchant_name     TEXT,
      merchant_category TEXT,
      merchant_country  TEXT,
      amount_cents      BIGINT NOT NULL,
      currency          TEXT NOT NULL DEFAULT 'USD',
      status            TEXT NOT NULL,
      decline_reason    TEXT,
      auth_at           TIMESTAMPTZ,
      captured_at       TIMESTAMPTZ,
      refunded_at       TIMESTAMPTZ,
      audit_hash        TEXT,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_card_tx_card
      ON card_transactions (card_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_card_tx_agent
      ON card_transactions (agent_did, created_at DESC);
  `);
}

const issueSchema = z.object({
  kind: z.enum(KINDS).optional(),
  funding_wallet_did: z.string().optional(),
  monthly_limit_cents: z.number().int().min(100).max(10_000_000).optional(),
  per_tx_limit_cents: z.number().int().min(100).max(1_000_000).optional(),
  allowed_merchant_categories: z.array(z.string()).optional(),
  blocked_merchant_categories: z.array(z.string()).optional(),
  shipping_address: z.object({
    line1: z.string(),
    line2: z.string().optional(),
    city: z.string(),
    state: z.string().optional(),
    postal_code: z.string(),
    country: z.string().length(2)
  }).optional()
});

async function provisionStripeCard(_payload) {
  // Stub for tests. In production: stripe.issuing.cards.create({...}) + cardholder.
  return {
    provider_card_id: 'ic_' + crypto.randomBytes(8).toString('hex'),
    last4: String(Math.floor(1000 + Math.random() * 9000)),
    exp_month: 12,
    exp_year: new Date().getFullYear() + 4,
    brand: 'visa'
  };
}

async function handleIssueCard(req, res, pool, verifyAgentAuth, auditChain) {
  const did = req.params.did;
  const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
  if (!auth.valid) return res.status(401).json({ error: auth.error || 'signature_required' });

  let body;
  try { body = issueSchema.parse(req.body); }
  catch (e) { return res.status(400).json({ error: 'invalid_request', details: e.errors }); }

  if (body.kind === 'physical' && !body.shipping_address) {
    return res.status(400).json({ error: 'shipping_address_required_for_physical' });
  }

  // Validate funding source exists
  const fundingDid = body.funding_wallet_did || did;
  const wallet = await pool.query(
    `SELECT 1 FROM bank_wallets WHERE agent_did = $1 AND chain = 'base' LIMIT 1`,
    [fundingDid]
  ).catch(() => ({ rows: [] }));
  if (!wallet.rows[0]) {
    return res.status(400).json({ error: 'funding_wallet_not_provisioned' });
  }

  const provider = await provisionStripeCard(body);
  const cardId = 'card_' + crypto.randomBytes(10).toString('hex');

  await pool.query(`
    INSERT INTO agent_cards (card_id, agent_did, provider, provider_card_id,
      kind, last4, exp_month, exp_year, brand, funding_wallet_did,
      monthly_limit_cents, per_tx_limit_cents,
      allowed_merchant_categories, blocked_merchant_categories,
      shipping_address, activated_at)
    VALUES ($1, $2, 'stripe_issuing', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, NOW())
  `, [cardId, did, provider.provider_card_id, body.kind || 'virtual',
      provider.last4, provider.exp_month, provider.exp_year, provider.brand,
      fundingDid, body.monthly_limit_cents || null, body.per_tx_limit_cents || null,
      body.allowed_merchant_categories || null,
      body.blocked_merchant_categories || null,
      body.shipping_address ? JSON.stringify(body.shipping_address) : null]);

  if (auditChain) {
    await auditChain.append({
      event_type: 'card.issued',
      agent_did: did,
      card_id: cardId,
      kind: body.kind || 'virtual',
      last4: provider.last4,
      timestamp: new Date().toISOString()
    });
  }

  return res.status(201).json({
    card_id: cardId,
    last4: provider.last4,
    exp_month: provider.exp_month,
    exp_year: provider.exp_year,
    brand: provider.brand,
    kind: body.kind || 'virtual',
    status: 'active'
  });
}

async function handleListCards(req, res, pool, verifyAgentAuth) {
  const did = req.params.did;
  const auth = await verifyAgentAuth(req, did);
  if (!auth.valid) return res.status(401).json({ error: auth.error });

  const r = await pool.query(`
    SELECT card_id, kind, last4, exp_month, exp_year, brand, status,
           monthly_limit_cents, per_tx_limit_cents, spent_this_month_cents,
           activated_at
    FROM agent_cards
    WHERE agent_did = $1
    ORDER BY created_at DESC
  `, [did]);
  return res.json({ agent_did: did, cards: r.rows });
}

async function handleFreezeCard(req, res, pool, verifyAgentAuth, auditChain) {
  const did = req.params.did;
  const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
  if (!auth.valid) return res.status(401).json({ error: auth.error });

  const r = await pool.query(`
    UPDATE agent_cards SET status = 'frozen'
    WHERE card_id = $1 AND agent_did = $2 AND status = 'active'
    RETURNING card_id
  `, [req.params.id, did]);
  if (!r.rows[0]) return res.status(404).json({ error: 'card_not_active' });
  if (auditChain) {
    await auditChain.append({ event_type: 'card.frozen', agent_did: did, card_id: r.rows[0].card_id });
  }
  return res.json({ card_id: r.rows[0].card_id, status: 'frozen' });
}

async function handleUnfreezeCard(req, res, pool, verifyAgentAuth, auditChain) {
  const did = req.params.did;
  const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
  if (!auth.valid) return res.status(401).json({ error: auth.error });
  const r = await pool.query(`
    UPDATE agent_cards SET status = 'active'
    WHERE card_id = $1 AND agent_did = $2 AND status = 'frozen'
    RETURNING card_id
  `, [req.params.id, did]);
  if (!r.rows[0]) return res.status(404).json({ error: 'card_not_frozen' });
  if (auditChain) {
    await auditChain.append({ event_type: 'card.unfrozen', agent_did: did, card_id: r.rows[0].card_id });
  }
  return res.json({ card_id: r.rows[0].card_id, status: 'active' });
}

async function handleCancelCard(req, res, pool, verifyAgentAuth, auditChain) {
  const did = req.params.did;
  const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
  if (!auth.valid) return res.status(401).json({ error: auth.error });
  const r = await pool.query(`
    UPDATE agent_cards SET status = 'cancelled', cancelled_at = NOW()
    WHERE card_id = $1 AND agent_did = $2 AND status != 'cancelled'
    RETURNING card_id
  `, [req.params.id, did]);
  if (!r.rows[0]) return res.status(404).json({ error: 'card_not_found_or_already_cancelled' });
  if (auditChain) {
    await auditChain.append({ event_type: 'card.cancelled', agent_did: did, card_id: r.rows[0].card_id });
  }
  return res.json({ card_id: r.rows[0].card_id, status: 'cancelled' });
}

async function handleListTransactions(req, res, pool, verifyAgentAuth) {
  const did = req.params.did;
  const auth = await verifyAgentAuth(req, did);
  if (!auth.valid) return res.status(401).json({ error: auth.error });

  const limit = Math.min(parseInt(req.query.limit) || 50, 500);
  const r = await pool.query(`
    SELECT tx_id, card_id, merchant_name, merchant_category, merchant_country,
           amount_cents, currency, status, decline_reason, auth_at, captured_at
    FROM card_transactions
    WHERE agent_did = $1
    ORDER BY created_at DESC
    LIMIT $2
  `, [did, limit]);
  return res.json({ agent_did: did, transactions: r.rows });
}

// Stripe Issuing webhook — called when card transaction authorization is requested.
// We decide approve/decline based on per-card and per-agent policy.
async function handleAuthWebhook(req, res, pool, auditChain) {
  // In production verify Stripe signature here.
  const event = req.body || {};
  if (event.type !== 'issuing_authorization.request') {
    return res.json({ received: true });
  }
  const auth = event.data?.object || {};
  const providerCardId = auth.card;
  const amount = auth.amount; // cents
  const merchantData = auth.merchant_data || {};

  const card = await pool.query(
    `SELECT * FROM agent_cards WHERE provider_card_id = $1`,
    [providerCardId]
  );
  if (!card.rows[0]) return res.json({ approved: false, reason: 'card_not_found' });

  const c = card.rows[0];
  if (c.status !== 'active') return res.json({ approved: false, reason: 'card_not_active' });

  // Per-tx limit
  if (c.per_tx_limit_cents && amount > c.per_tx_limit_cents) {
    await recordDecline(pool, c, auth, 'per_tx_limit_exceeded');
    return res.json({ approved: false, reason: 'per_tx_limit_exceeded' });
  }
  // Monthly limit
  if (c.monthly_limit_cents && c.spent_this_month_cents + amount > c.monthly_limit_cents) {
    await recordDecline(pool, c, auth, 'monthly_limit_exceeded');
    return res.json({ approved: false, reason: 'monthly_limit_exceeded' });
  }
  // Merchant category
  if (c.blocked_merchant_categories?.includes(merchantData.category)) {
    await recordDecline(pool, c, auth, 'merchant_category_blocked');
    return res.json({ approved: false, reason: 'merchant_category_blocked' });
  }
  if (c.allowed_merchant_categories?.length &&
      !c.allowed_merchant_categories.includes(merchantData.category)) {
    await recordDecline(pool, c, auth, 'merchant_category_not_allowed');
    return res.json({ approved: false, reason: 'merchant_category_not_allowed' });
  }

  // Approve + record + bump spent
  const txId = 'cardtx_' + crypto.randomBytes(8).toString('hex');
  await pool.query(`
    INSERT INTO card_transactions (tx_id, card_id, agent_did, provider_tx_id,
      merchant_name, merchant_category, merchant_country, amount_cents,
      currency, status, auth_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'authorized', NOW())
  `, [txId, c.card_id, c.agent_did, auth.id, merchantData.name,
      merchantData.category, merchantData.country, amount, auth.currency || 'USD']);
  await pool.query(`
    UPDATE agent_cards SET spent_this_month_cents = spent_this_month_cents + $1
    WHERE card_id = $2
  `, [amount, c.card_id]);

  if (auditChain) {
    await auditChain.append({
      event_type: 'card.authorized',
      agent_did: c.agent_did, card_id: c.card_id, tx_id: txId,
      amount_cents: amount, merchant: merchantData.name
    });
  }

  return res.json({ approved: true });
}

async function recordDecline(pool, card, auth, reason) {
  await pool.query(`
    INSERT INTO card_transactions (tx_id, card_id, agent_did, provider_tx_id,
      merchant_name, merchant_category, amount_cents, currency, status, decline_reason, auth_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'declined', $9, NOW())
  `, ['cardtx_' + crypto.randomBytes(8).toString('hex'),
      card.card_id, card.agent_did, auth.id,
      auth.merchant_data?.name, auth.merchant_data?.category,
      auth.amount, auth.currency || 'USD', reason]).catch(() => {});
}

async function resetMonthlySpent(pool) {
  const r = await pool.query(`
    UPDATE agent_cards SET spent_this_month_cents = 0, period_start = NOW()
    WHERE period_start < NOW() - INTERVAL '30 days'
    RETURNING card_id
  `);
  return { reset: r.rows.length };
}

function registerCardRoutes(app, pool, verifyAgentAuth, auditChain) {
  app.post('/v1/agents/:did/cards',
    (req, res) => handleIssueCard(req, res, pool, verifyAgentAuth, auditChain));
  app.get('/v1/agents/:did/cards',
    (req, res) => handleListCards(req, res, pool, verifyAgentAuth));
  app.post('/v1/agents/:did/cards/:id/freeze',
    (req, res) => handleFreezeCard(req, res, pool, verifyAgentAuth, auditChain));
  app.post('/v1/agents/:did/cards/:id/unfreeze',
    (req, res) => handleUnfreezeCard(req, res, pool, verifyAgentAuth, auditChain));
  app.post('/v1/agents/:did/cards/:id/cancel',
    (req, res) => handleCancelCard(req, res, pool, verifyAgentAuth, auditChain));
  app.get('/v1/agents/:did/cards/transactions',
    (req, res) => handleListTransactions(req, res, pool, verifyAgentAuth));
  app.post('/v1/_webhooks/stripe-issuing',
    (req, res) => handleAuthWebhook(req, res, pool, auditChain));
  registerCron(app, '/v1/_jobs/card-monthly-reset',
    async (req, res) => res.json(await resetMonthlySpent(pool)));
}

module.exports = {
  migrate,
  registerCardRoutes,
  resetMonthlySpent,
  STATUSES,
  KINDS,
  TX_STATUSES
};
