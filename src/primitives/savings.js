// ============================================================================
// Agent savings — interest-bearing USDC accounts (yield via lending pools)
// ============================================================================
const crypto = require('crypto');
const { z } = require('zod');
const { registerCron } = require('../cron_auth');

async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS savings_accounts (
      account_id        TEXT PRIMARY KEY,
      agent_did         TEXT NOT NULL,
      asset             TEXT NOT NULL DEFAULT 'USDC',
      chain             TEXT NOT NULL DEFAULT 'base',
      principal_raw     NUMERIC(78,0) NOT NULL DEFAULT 0,
      interest_earned_raw NUMERIC(78,0) NOT NULL DEFAULT 0,
      apy_bps           INTEGER NOT NULL DEFAULT 400,
      strategy          TEXT NOT NULL DEFAULT 'aave_v3',
      auto_compound     BOOLEAN NOT NULL DEFAULT TRUE,
      lock_until        TIMESTAMPTZ,
      status            TEXT NOT NULL DEFAULT 'active',
      opened_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_interest_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      closed_at         TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_savings_did ON savings_accounts (agent_did, status);

    CREATE TABLE IF NOT EXISTS savings_transactions (
      tx_id             TEXT PRIMARY KEY,
      account_id        TEXT NOT NULL,
      agent_did         TEXT NOT NULL,
      kind              TEXT NOT NULL,
      amount_raw        NUMERIC(78,0) NOT NULL,
      balance_after_raw NUMERIC(78,0) NOT NULL,
      tx_hash           TEXT,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_savings_tx_account
      ON savings_transactions (account_id, created_at DESC);
  `);
}

const openSchema = z.object({
  asset: z.string().optional(),
  chain: z.string().optional(),
  strategy: z.enum(['aave_v3', 'compound_v3', 'morpho', 'sparkfi', 'reserve']).optional(),
  auto_compound: z.boolean().optional(),
  lock_until: z.string().datetime().optional()
});

async function handleOpen(req, res, pool, verifyAgentAuth, auditChain) {
  const did = req.params.did;
  const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
  if (!auth.valid) return res.status(401).json({ error: auth.error });
  let body;
  try { body = openSchema.parse(req.body); }
  catch (e) { return res.status(400).json({ error: 'invalid_request', details: e.errors }); }

  const id = 'sav_' + crypto.randomBytes(10).toString('hex');
  await pool.query(`
    INSERT INTO savings_accounts (account_id, agent_did, asset, chain, strategy,
      auto_compound, lock_until)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
  `, [id, did, body.asset || 'USDC', body.chain || 'base',
      body.strategy || 'aave_v3', body.auto_compound !== false,
      body.lock_until || null]);
  if (auditChain) {
    await auditChain.append({ event_type: 'savings.opened', agent_did: did, account_id: id });
  }
  return res.status(201).json({ account_id: id, strategy: body.strategy || 'aave_v3' });
}

const depositSchema = z.object({ amount_raw: z.string().regex(/^\d+$/) });

async function handleDeposit(req, res, pool, verifyAgentAuth, auditChain) {
  const did = req.params.did;
  const accountId = req.params.id;
  const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
  if (!auth.valid) return res.status(401).json({ error: auth.error });
  let body;
  try { body = depositSchema.parse(req.body); }
  catch (e) { return res.status(400).json({ error: 'invalid_request', details: e.errors }); }

  const acct = await pool.query(
    `SELECT * FROM savings_accounts WHERE account_id = $1 AND agent_did = $2 AND status = 'active'`,
    [accountId, did]
  );
  if (!acct.rows[0]) return res.status(404).json({ error: 'not_found_or_closed' });

  await pool.query(`
    UPDATE savings_accounts SET principal_raw = principal_raw + $1
    WHERE account_id = $2
  `, [body.amount_raw, accountId]);

  const newBalance = (BigInt(acct.rows[0].principal_raw) + BigInt(body.amount_raw)).toString();
  await pool.query(`
    INSERT INTO savings_transactions (tx_id, account_id, agent_did, kind, amount_raw, balance_after_raw)
    VALUES ($1, $2, $3, 'deposit', $4, $5)
  `, ['savtx_' + crypto.randomBytes(8).toString('hex'),
      accountId, did, body.amount_raw, newBalance]);

  if (auditChain) {
    await auditChain.append({ event_type: 'savings.deposit', agent_did: did,
      account_id: accountId, amount_raw: body.amount_raw });
  }
  return res.json({ account_id: accountId, new_balance_raw: newBalance });
}

async function handleWithdraw(req, res, pool, verifyAgentAuth, auditChain) {
  const did = req.params.did;
  const accountId = req.params.id;
  const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
  if (!auth.valid) return res.status(401).json({ error: auth.error });
  let body;
  try { body = depositSchema.parse(req.body); }
  catch (e) { return res.status(400).json({ error: 'invalid_request', details: e.errors }); }

  const acct = await pool.query(
    `SELECT * FROM savings_accounts WHERE account_id = $1 AND agent_did = $2 AND status = 'active'`,
    [accountId, did]
  );
  if (!acct.rows[0]) return res.status(404).json({ error: 'not_found_or_closed' });
  if (acct.rows[0].lock_until && new Date(acct.rows[0].lock_until) > new Date()) {
    return res.status(403).json({ error: 'locked', until: acct.rows[0].lock_until });
  }

  const total = BigInt(acct.rows[0].principal_raw) + BigInt(acct.rows[0].interest_earned_raw);
  const requested = BigInt(body.amount_raw);
  if (requested > total) return res.status(400).json({ error: 'insufficient_balance', available_raw: total.toString() });

  // Take from interest first, then principal
  let interestTake = 0n;
  let principalTake = requested;
  const interest = BigInt(acct.rows[0].interest_earned_raw);
  if (interest >= requested) {
    interestTake = requested;
    principalTake = 0n;
  } else {
    interestTake = interest;
    principalTake = requested - interest;
  }

  await pool.query(`
    UPDATE savings_accounts SET
      principal_raw = principal_raw - $1,
      interest_earned_raw = interest_earned_raw - $2
    WHERE account_id = $3
  `, [principalTake.toString(), interestTake.toString(), accountId]);

  const newBalance = (total - requested).toString();
  await pool.query(`
    INSERT INTO savings_transactions (tx_id, account_id, agent_did, kind, amount_raw, balance_after_raw)
    VALUES ($1, $2, $3, 'withdraw', $4, $5)
  `, ['savtx_' + crypto.randomBytes(8).toString('hex'),
      accountId, did, body.amount_raw, newBalance]);

  if (auditChain) {
    await auditChain.append({ event_type: 'savings.withdraw', agent_did: did,
      account_id: accountId, amount_raw: body.amount_raw });
  }
  return res.json({ account_id: accountId, new_balance_raw: newBalance });
}

async function handleList(req, res, pool, verifyAgentAuth) {
  const did = req.params.did;
  const auth = await verifyAgentAuth(req, did);
  if (!auth.valid) return res.status(401).json({ error: auth.error });
  const r = await pool.query(`
    SELECT account_id, asset, chain, principal_raw, interest_earned_raw, apy_bps,
           strategy, auto_compound, lock_until, status, opened_at
    FROM savings_accounts WHERE agent_did = $1 ORDER BY opened_at DESC
  `, [did]);
  return res.json({ agent_did: did, accounts: r.rows });
}

async function handleGetTransactions(req, res, pool, verifyAgentAuth) {
  const did = req.params.did;
  const auth = await verifyAgentAuth(req, did);
  if (!auth.valid) return res.status(401).json({ error: auth.error });
  const r = await pool.query(`
    SELECT * FROM savings_transactions WHERE account_id = $1 ORDER BY created_at DESC LIMIT 200
  `, [req.params.id]);
  return res.json({ account_id: req.params.id, transactions: r.rows });
}

// Daily interest accrual cron — adds 1/365 of APY to interest_earned_raw
async function accrueInterest(pool, auditChain) {
  const r = await pool.query(`
    UPDATE savings_accounts SET
      interest_earned_raw = interest_earned_raw +
        FLOOR((principal_raw + interest_earned_raw) * apy_bps / 10000 / 365),
      last_interest_at = NOW()
    WHERE status = 'active'
      AND last_interest_at < NOW() - INTERVAL '23 hours'
    RETURNING account_id, agent_did
  `).catch(() => ({ rows: [] }));
  if (auditChain) {
    for (const row of r.rows) {
      await auditChain.append({ event_type: 'savings.interest_accrued',
        agent_did: row.agent_did, account_id: row.account_id });
    }
  }
  return { accrued: r.rows.length };
}

function registerSavingsRoutes(app, pool, verifyAgentAuth, auditChain) {
  app.post('/v1/agents/:did/savings/accounts',
    (req, res) => handleOpen(req, res, pool, verifyAgentAuth, auditChain));
  app.get('/v1/agents/:did/savings/accounts',
    (req, res) => handleList(req, res, pool, verifyAgentAuth));
  app.post('/v1/agents/:did/savings/accounts/:id/deposit',
    (req, res) => handleDeposit(req, res, pool, verifyAgentAuth, auditChain));
  app.post('/v1/agents/:did/savings/accounts/:id/withdraw',
    (req, res) => handleWithdraw(req, res, pool, verifyAgentAuth, auditChain));
  app.get('/v1/agents/:did/savings/accounts/:id/transactions',
    (req, res) => handleGetTransactions(req, res, pool, verifyAgentAuth));
  registerCron(app, '/v1/_jobs/savings-accrue',
    async (req, res) => res.json(await accrueInterest(pool, auditChain)));
}

module.exports = { migrate, registerSavingsRoutes, accrueInterest };
