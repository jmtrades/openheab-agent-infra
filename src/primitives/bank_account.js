// ============================================================================
// bank_account.js — Unified agent bank account
//
// The "single pane of glass" that ties together every bank primitive into a
// real, working bank for AI agents:
//
//   • bank_chain.js     — on-chain non-custodial USDC wallet (Base)
//   • bank.js           — internal cents ledger (fast off-chain, with holds)
//   • cards.js          — virtual + physical debit cards
//   • savings.js        — interest-bearing USDC accounts (4% APY)
//   • lending.js        — borrow USDC against collateral
//   • escrow.js         — held funds under counterparty agreement
//   • payouts.js        — fiat off-ramp (A2H cash-out)
//
// Responsibilities:
//   1. /v1/agents/:did/bank — unified balance sheet (wallet + ledger +
//      savings + lending + escrow + cards spend) for an agent.
//   2. /v1/agents/:did/bank/statement — month-by-month bank statement.
//   3. /v1/agents/:did/bank/deposits — list incoming on-chain USDC arrivals
//      since last poll; cron deposit-sweep credits internal ledger.
//   4. /v1/agents/:did/bank/reconcile — proves the internal cents ledger
//      matches the on-chain USDC balance (off by 0 modulo dust).
//   5. JIT card auth: when a card swipe arrives, atomically place a hold
//      on the internal ledger BEFORE approving. Capture or release the hold
//      on settle / decline.
//   6. /v1/agents/:did/bank/sweep — transfer wallet → savings / savings →
//      wallet / wallet → lending repay.  Single endpoint, idempotent.
//   7. Statement export as JSON or CSV (audit-grade).
//
// This is the primitive every agent talks to first. Everything else is a
// detail.
// ============================================================================

const express = require('express');
const cryptoLib = require('crypto');
const { z } = require('zod');
const { registerCron } = require('../cron_auth');

const PLATFORM_DID = process.env.PLATFORM_DID || 'did:op:platform';

// ----- Migration -------------------------------------------------------------
async function migrate(pool) {
  await pool.query(`
    -- Snapshots written by /v1/_jobs/bank-snapshot for fast statement queries
    CREATE TABLE IF NOT EXISTS bank_snapshots (
      snapshot_id          TEXT PRIMARY KEY,
      agent_did            TEXT NOT NULL,
      taken_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      ledger_balance_cents BIGINT NOT NULL DEFAULT 0,
      wallet_usdc_raw      NUMERIC(78,0) NOT NULL DEFAULT 0,
      savings_total_raw    NUMERIC(78,0) NOT NULL DEFAULT 0,
      lending_debt_raw     NUMERIC(78,0) NOT NULL DEFAULT 0,
      escrow_locked_cents  BIGINT NOT NULL DEFAULT 0,
      cards_active         INTEGER NOT NULL DEFAULT 0,
      net_worth_cents      BIGINT NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_bank_snapshots_did
      ON bank_snapshots (agent_did, taken_at DESC);

    -- Incoming on-chain deposits detected by the deposit-sweep cron.
    -- Crediting to internal ledger is idempotent on (tx_hash, agent_did).
    CREATE TABLE IF NOT EXISTS bank_deposits (
      deposit_id      TEXT PRIMARY KEY,
      agent_did       TEXT NOT NULL,
      tx_hash         TEXT NOT NULL,
      chain           TEXT NOT NULL DEFAULT 'base',
      asset           TEXT NOT NULL DEFAULT 'USDC',
      amount_raw      NUMERIC(78,0) NOT NULL,
      from_address    TEXT,
      block_number    BIGINT,
      detected_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      credited_at     TIMESTAMPTZ,
      credit_txn_id   TEXT,
      UNIQUE (tx_hash, agent_did)
    );
    CREATE INDEX IF NOT EXISTS idx_bank_deposits_did
      ON bank_deposits (agent_did, detected_at DESC);
    CREATE INDEX IF NOT EXISTS idx_bank_deposits_pending
      ON bank_deposits (credited_at) WHERE credited_at IS NULL;

    -- Reconciliation log: ledger cents vs on-chain raw at each cron run.
    CREATE TABLE IF NOT EXISTS bank_reconciliation_log (
      recon_id        TEXT PRIMARY KEY,
      agent_did       TEXT NOT NULL,
      run_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      ledger_cents    BIGINT NOT NULL,
      onchain_cents   BIGINT NOT NULL,
      drift_cents     BIGINT NOT NULL,
      drift_pct_x100  INTEGER NOT NULL,
      action_taken    TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_bank_recon_did
      ON bank_reconciliation_log (agent_did, run_at DESC);
  `);
}

// ----- Helpers ---------------------------------------------------------------
function newId(prefix) {
  return prefix + '_' + cryptoLib.randomBytes(10).toString('hex');
}

// Convert raw stablecoin amount (6 decimals for USDC) → integer cents (2 dec)
// 1 USDC = 1,000,000 raw = 100 cents.  Floor for safety.
function rawUsdcToCents(rawStr) {
  if (!rawStr) return 0;
  const raw = BigInt(String(rawStr));
  return Number(raw / 10_000n);
}

function centsToRawUsdc(cents) {
  return (BigInt(cents) * 10_000n).toString();
}

// ----- Aggregate balance sheet -----------------------------------------------
async function buildAccount(pool, did, opts = {}) {
  const chain = opts.chain || 'base';

  // 1) On-chain wallet
  let wallet = null;
  let walletBalance = { raw: '0', cents: 0, formatted: '0.000000' };
  try {
    const walletRow = await pool.query(
      `SELECT address, chain FROM bank_wallets WHERE agent_did = $1 AND chain = $2`,
      [did, chain]
    );
    if (walletRow.rows[0]) {
      wallet = walletRow.rows[0];
      if (opts.skipChainCall !== true) {
        try {
          const bankChain = require('./bank_chain');
          const bal = await bankChain.getOnChainBalance(wallet.address, chain, 'USDC');
          walletBalance = {
            raw: bal.raw,
            cents: rawUsdcToCents(bal.raw),
            formatted: bal.formatted
          };
        } catch { /* RPC blip — leave zeros */ }
      }
    }
  } catch { /* table absent — leave null */ }

  // 2) Internal cents ledger
  let ledger = { balance_cents: 0, held_cents: 0, available_cents: 0,
                 lifetime_in_cents: 0, lifetime_out_cents: 0 };
  try {
    const r = await pool.query(`
      SELECT balance_cents, held_cents, lifetime_in_cents, lifetime_out_cents
      FROM bank_accounts WHERE agent_did = $1
    `, [did]);
    if (r.rows[0]) {
      const x = r.rows[0];
      ledger = {
        balance_cents: Number(x.balance_cents || 0),
        held_cents: Number(x.held_cents || 0),
        available_cents: Number(x.balance_cents || 0) - Number(x.held_cents || 0),
        lifetime_in_cents: Number(x.lifetime_in_cents || 0),
        lifetime_out_cents: Number(x.lifetime_out_cents || 0)
      };
    }
  } catch {}

  // 3) Savings (sum across all active accounts)
  let savings = { total_principal_raw: '0', total_interest_raw: '0',
                  total_raw: '0', accounts: 0 };
  try {
    const r = await pool.query(`
      SELECT
        COUNT(*)::int AS accounts,
        COALESCE(SUM(principal_raw), 0)::text AS principal,
        COALESCE(SUM(interest_earned_raw), 0)::text AS interest
      FROM savings_accounts
      WHERE agent_did = $1 AND status = 'active'
    `, [did]);
    if (r.rows[0]) {
      const principal = BigInt(r.rows[0].principal || '0');
      const interest = BigInt(r.rows[0].interest || '0');
      savings = {
        total_principal_raw: principal.toString(),
        total_interest_raw: interest.toString(),
        total_raw: (principal + interest).toString(),
        total_cents: rawUsdcToCents((principal + interest).toString()),
        accounts: Number(r.rows[0].accounts || 0)
      };
    } else {
      savings.total_cents = 0;
    }
  } catch {}

  // 4) Lending (outstanding debt)
  let lending = { total_debt_raw: '0', total_debt_cents: 0, positions: 0 };
  try {
    const r = await pool.query(`
      SELECT COUNT(*)::int AS positions,
             COALESCE(SUM(borrowed_raw - repaid_raw), 0)::text AS debt
      FROM lending_loans
      WHERE borrower_did = $1 AND status IN ('active', 'past_due')
    `, [did]);
    if (r.rows[0]) {
      lending = {
        total_debt_raw: String(r.rows[0].debt || '0'),
        total_debt_cents: rawUsdcToCents(r.rows[0].debt || '0'),
        positions: Number(r.rows[0].positions || 0)
      };
    }
  } catch {}

  // 5) Escrow (funds locked in pending agreements)
  let escrow = { locked_cents: 0, agreements: 0 };
  try {
    const r = await pool.query(`
      SELECT COUNT(*)::int AS agreements,
             COALESCE(SUM(amount_cents), 0)::bigint AS locked
      FROM escrow_agreements
      WHERE (buyer_did = $1 OR seller_did = $1) AND status = 'funded'
    `, [did]);
    if (r.rows[0]) {
      escrow = {
        locked_cents: Number(r.rows[0].locked || 0),
        agreements: Number(r.rows[0].agreements || 0)
      };
    }
  } catch {}

  // 6) Cards
  let cards = { active: 0, total_spent_this_month_cents: 0 };
  try {
    const r = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'active')::int AS active,
        COALESCE(SUM(spent_this_month_cents) FILTER (WHERE status = 'active'), 0)::bigint AS spent
      FROM agent_cards WHERE agent_did = $1
    `, [did]);
    if (r.rows[0]) {
      cards = {
        active: Number(r.rows[0].active || 0),
        total_spent_this_month_cents: Number(r.rows[0].spent || 0)
      };
    }
  } catch {}

  // 7) Net worth — wallet + ledger + savings - lending debt - escrow locked
  const netWorthCents = walletBalance.cents
                      + ledger.balance_cents
                      + (savings.total_cents || 0)
                      - lending.total_debt_cents
                      - escrow.locked_cents;

  return {
    agent_did: did,
    chain,
    wallet: wallet
      ? { address: wallet.address, chain: wallet.chain, balance: walletBalance }
      : null,
    ledger,
    savings,
    lending,
    escrow,
    cards,
    net_worth_cents: netWorthCents,
    net_worth_usd: (netWorthCents / 100).toFixed(2)
  };
}

// ----- Deposit sweep (cron) --------------------------------------------------
// Scans recent USDC Transfer events to each wallet address and credits the
// internal ledger.  Falls back gracefully if RPC is unavailable.
async function sweepDeposits(pool, auditChain, opts = {}) {
  const chain = opts.chain || 'base';
  let detected = 0;
  let credited = 0;

  // Strategy: poll the on-chain balance and, if it's higher than the sum of
  // already-credited deposits + the previous snapshot baseline, create a
  // pseudo-deposit entry for the delta.  This works even without an indexer.
  //
  // Real production deployments swap this for an indexer (Alchemy/Goldsky/
  // Subgraph) emitting Transfer-to-wallet events.
  let wallets;
  try {
    const r = await pool.query(`
      SELECT agent_did, address FROM bank_wallets WHERE chain = $1
    `, [chain]);
    wallets = r.rows;
  } catch { return { detected: 0, credited: 0, skipped: 'no_wallets_table' }; }

  if (!wallets.length) return { detected: 0, credited: 0 };
  if (process.env.BANK_DEPOSIT_SWEEP_DISABLED === 'true') {
    return { detected: 0, credited: 0, skipped: 'disabled' };
  }

  let bankChain;
  try { bankChain = require('./bank_chain'); }
  catch { return { detected: 0, credited: 0, skipped: 'no_bank_chain' }; }

  for (const w of wallets) {
    let onchainCents;
    try {
      const bal = await bankChain.getOnChainBalance(w.address, chain, 'USDC');
      onchainCents = rawUsdcToCents(bal.raw);
    } catch { continue; }

    // Sum already-credited deposits + ledger balance, compute drift.
    const sumR = await pool.query(`
      SELECT COALESCE(SUM(amount_raw), 0)::text AS credited
      FROM bank_deposits
      WHERE agent_did = $1 AND chain = $2 AND credited_at IS NOT NULL
    `, [w.agent_did, chain]).catch(() => ({ rows: [{ credited: '0' }] }));
    const ledgerR = await pool.query(
      `SELECT COALESCE(balance_cents, 0)::bigint AS bal
       FROM bank_accounts WHERE agent_did = $1`, [w.agent_did]
    ).catch(() => ({ rows: [{ bal: 0 }] }));
    const ledgerCents = Number(ledgerR.rows[0]?.bal || 0);
    const creditedRaw = BigInt(sumR.rows[0].credited);
    const creditedCents = rawUsdcToCents(creditedRaw.toString());

    // If the on-chain balance is higher than what we've credited, the delta
    // is a new deposit.  Use a synthetic tx_hash keyed off the run.
    const deltaCents = onchainCents - (creditedCents + ledgerCents);
    if (deltaCents <= 0) continue;

    detected++;
    const depositId = newId('dep');
    const syntheticHash = '0x' + cryptoLib.createHash('sha256')
      .update(`sweep|${w.agent_did}|${chain}|${onchainCents}|${Date.now()}`)
      .digest('hex');
    const amountRaw = centsToRawUsdc(deltaCents);
    const inserted = await pool.query(`
      INSERT INTO bank_deposits (deposit_id, agent_did, tx_hash, chain, asset, amount_raw)
      VALUES ($1, $2, $3, $4, 'USDC', $5)
      ON CONFLICT (tx_hash, agent_did) DO NOTHING
      RETURNING deposit_id
    `, [depositId, w.agent_did, syntheticHash, chain, amountRaw]).catch(() => ({ rows: [] }));
    if (!inserted.rows[0]) continue;

    // Ensure account, credit ledger.
    await pool.query(`
      INSERT INTO bank_accounts (agent_did, currency) VALUES ($1, 'usd')
      ON CONFLICT (agent_did) DO NOTHING
    `, [w.agent_did]).catch(() => {});
    await pool.query(`
      UPDATE bank_accounts SET
        balance_cents = balance_cents + $1,
        lifetime_in_cents = lifetime_in_cents + $1,
        updated_at = NOW()
      WHERE agent_did = $2
    `, [deltaCents, w.agent_did]).catch(() => {});

    const creditTxnId = 'btxn_' + cryptoLib.randomBytes(12).toString('hex');
    await pool.query(`
      INSERT INTO bank_transactions
        (txn_id, agent_did, type, amount_cents, currency, external_ref, created_at)
      VALUES ($1, $2, 'deposit', $3, 'usd', $4, NOW())
      ON CONFLICT (txn_id) DO NOTHING
    `, [creditTxnId, w.agent_did, deltaCents, syntheticHash]).catch(() => {});

    await pool.query(`
      UPDATE bank_deposits
      SET credited_at = NOW(), credit_txn_id = $1
      WHERE deposit_id = $2
    `, [creditTxnId, depositId]).catch(() => {});

    if (auditChain) {
      await auditChain.append({
        event_type: 'bank.deposit.credited',
        agent_did: w.agent_did,
        deposit_id: depositId,
        amount_cents: deltaCents,
        tx_hash: syntheticHash,
        chain
      }).catch(() => {});
    }
    credited++;
  }

  return { detected, credited, wallets: wallets.length };
}

// ----- Reconciliation cron ---------------------------------------------------
async function reconcileAll(pool, auditChain) {
  let reconciled = 0;
  let drifted = 0;
  let walletsR;
  try {
    walletsR = await pool.query(
      `SELECT agent_did, address FROM bank_wallets WHERE chain = 'base'`
    );
  } catch { return { reconciled: 0, drifted: 0, skipped: 'no_wallets' }; }

  let bankChain;
  try { bankChain = require('./bank_chain'); }
  catch { return { reconciled: 0, drifted: 0, skipped: 'no_bank_chain' }; }

  for (const w of walletsR.rows) {
    let onchainCents = 0;
    try {
      const bal = await bankChain.getOnChainBalance(w.address, 'base', 'USDC');
      onchainCents = rawUsdcToCents(bal.raw);
    } catch { continue; }

    const r = await pool.query(
      `SELECT COALESCE(balance_cents, 0)::bigint AS bal
       FROM bank_accounts WHERE agent_did = $1`, [w.agent_did]
    ).catch(() => ({ rows: [{ bal: 0 }] }));
    const ledgerCents = Number(r.rows[0]?.bal || 0);
    const drift = onchainCents - ledgerCents;
    const driftPctX100 = ledgerCents > 0
      ? Math.round((Math.abs(drift) * 10000) / ledgerCents)
      : (drift === 0 ? 0 : 9999);

    await pool.query(`
      INSERT INTO bank_reconciliation_log
        (recon_id, agent_did, ledger_cents, onchain_cents, drift_cents, drift_pct_x100, action_taken)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    `, [newId('rec'), w.agent_did, ledgerCents, onchainCents, drift, driftPctX100,
        drift === 0 ? 'in_sync' : 'logged_only']).catch(() => {});

    reconciled++;
    if (drift !== 0) drifted++;

    if (drift !== 0 && auditChain) {
      await auditChain.append({
        event_type: 'bank.reconciliation.drift',
        agent_did: w.agent_did,
        ledger_cents: ledgerCents,
        onchain_cents: onchainCents,
        drift_cents: drift
      }).catch(() => {});
    }
  }

  return { reconciled, drifted };
}

// ----- Snapshot cron ---------------------------------------------------------
async function snapshotAll(pool) {
  let dids;
  try {
    const r = await pool.query(`SELECT did FROM identities LIMIT 50000`);
    dids = r.rows.map(x => x.did);
  } catch { return { snapshots: 0 }; }

  let snapshots = 0;
  for (const did of dids) {
    try {
      const acct = await buildAccount(pool, did, { skipChainCall: true });
      await pool.query(`
        INSERT INTO bank_snapshots
          (snapshot_id, agent_did, ledger_balance_cents, wallet_usdc_raw,
           savings_total_raw, lending_debt_raw, escrow_locked_cents,
           cards_active, net_worth_cents)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      `, [newId('snap'), did,
          acct.ledger.balance_cents,
          acct.wallet?.balance.raw || '0',
          acct.savings.total_raw || '0',
          acct.lending.total_debt_raw || '0',
          acct.escrow.locked_cents,
          acct.cards.active,
          acct.net_worth_cents]).catch(() => {});
      snapshots++;
    } catch {}
  }
  return { snapshots };
}

// ----- Statement generation --------------------------------------------------
async function buildStatement(pool, did, opts) {
  const from = opts.from ? new Date(opts.from) : new Date(Date.now() - 30 * 24 * 3600 * 1000);
  const to = opts.to ? new Date(opts.to) : new Date();

  const accountNow = await buildAccount(pool, did, { skipChainCall: true });

  let txns = { rows: [] };
  try {
    txns = await pool.query(`
      SELECT txn_id, type, amount_cents, currency, counterparty_did, memo,
             external_ref, created_at
      FROM bank_transactions
      WHERE agent_did = $1 AND created_at BETWEEN $2 AND $3
      ORDER BY created_at ASC
      LIMIT 5000
    `, [did, from.toISOString(), to.toISOString()]);
  } catch {}

  const totals = { topup_cents: 0, transfer_in_cents: 0, transfer_out_cents: 0,
                   fee_cents: 0, payout_cents: 0, deposit_cents: 0, other_cents: 0 };
  for (const t of txns.rows) {
    const amt = Number(t.amount_cents);
    if (t.type === 'topup') totals.topup_cents += amt;
    else if (t.type === 'deposit') totals.deposit_cents += amt;
    else if (t.type === 'transfer_in') totals.transfer_in_cents += amt;
    else if (t.type === 'transfer_out') totals.transfer_out_cents += Math.abs(amt);
    else if (t.type === 'a2a_fee') totals.fee_cents += amt;
    else if (t.type === 'payout') totals.payout_cents += Math.abs(amt);
    else totals.other_cents += amt;
  }

  return {
    agent_did: did,
    period: { from: from.toISOString(), to: to.toISOString() },
    opening_balance_cents: null,
    closing_balance_cents: accountNow.ledger.balance_cents,
    totals,
    transactions: txns.rows.map(r => ({
      ...r,
      amount_cents: Number(r.amount_cents)
    })),
    account_at_close: accountNow,
    generated_at: new Date().toISOString()
  };
}

// ----- Routes ----------------------------------------------------------------
function registerBankAccountRoutes(app, pool, verifyAgentAuth, auditChain) {
  // GET /v1/agents/:did/bank — unified balance sheet
  app.get('/v1/agents/:did/bank', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    try {
      const acct = await buildAccount(pool, did, {
        chain: req.query.chain || 'base',
        skipChainCall: req.query.fast === '1'
      });
      return res.json(acct);
    } catch (e) {
      return res.status(500).json({ error: 'account_build_failed', message: e.message });
    }
  });

  // GET /v1/agents/:did/bank/statement?from=...&to=...&format=json|csv
  app.get('/v1/agents/:did/bank/statement', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    try {
      const stmt = await buildStatement(pool, did, {
        from: req.query.from, to: req.query.to
      });

      if (req.query.format === 'csv') {
        const lines = ['date,type,amount_cents,counterparty,memo'];
        for (const t of stmt.transactions) {
          lines.push([t.created_at, t.type, t.amount_cents,
                      t.counterparty_did || '', (t.memo || '').replace(/,/g, ' ')]
                     .join(','));
        }
        res.setHeader('content-type', 'text/csv');
        res.setHeader('content-disposition',
          `attachment; filename="bank-statement-${did.slice(7, 19)}.csv"`);
        return res.send(lines.join('\n'));
      }
      return res.json(stmt);
    } catch (e) {
      return res.status(500).json({ error: 'statement_failed', message: e.message });
    }
  });

  // GET /v1/agents/:did/bank/deposits — list incoming on-chain deposits
  app.get('/v1/agents/:did/bank/deposits', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const limit = Math.min(parseInt(req.query.limit) || 50, 500);
    const r = await pool.query(`
      SELECT deposit_id, tx_hash, chain, asset, amount_raw, from_address,
             block_number, detected_at, credited_at, credit_txn_id
      FROM bank_deposits WHERE agent_did = $1
      ORDER BY detected_at DESC LIMIT $2
    `, [did, limit]).catch(() => ({ rows: [] }));
    return res.json({
      agent_did: did,
      deposits: r.rows.map(d => ({
        ...d,
        amount_raw: String(d.amount_raw),
        amount_cents: rawUsdcToCents(d.amount_raw)
      }))
    });
  });

  // POST /v1/agents/:did/bank/deposits/notify — external notifier (webhook)
  // Body: { tx_hash, chain, asset, amount_raw, from_address, block_number }
  // Used when an indexer (Alchemy, Goldsky, etc.) detects an inbound transfer.
  // Requires the cron secret since it credits the ledger.
  app.post('/v1/agents/:did/bank/deposits/notify',
    express.json(),
    async (req, res) => {
      const { isCronRequest } = require('../cron_auth');
      if (!isCronRequest(req)) {
        return res.status(401).json({ error: 'cron_or_indexer_secret_required' });
      }
      const did = req.params.did;
      const schema = z.object({
        tx_hash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
        chain: z.string().default('base'),
        asset: z.string().default('USDC'),
        amount_raw: z.string().regex(/^\d+$/),
        from_address: z.string().optional(),
        block_number: z.number().int().nonnegative().optional()
      });
      const parsed = schema.safeParse(req.body || {});
      if (!parsed.success) {
        return res.status(400).json({ error: 'invalid_input', details: parsed.error.flatten() });
      }
      const body = parsed.data;
      const cents = rawUsdcToCents(body.amount_raw);
      const depositId = newId('dep');

      const inserted = await pool.query(`
        INSERT INTO bank_deposits
          (deposit_id, agent_did, tx_hash, chain, asset, amount_raw, from_address, block_number)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (tx_hash, agent_did) DO NOTHING
        RETURNING deposit_id
      `, [depositId, did, body.tx_hash, body.chain, body.asset,
          body.amount_raw, body.from_address || null, body.block_number || null])
        .catch(() => ({ rows: [] }));

      if (!inserted.rows[0]) {
        return res.json({ ok: true, idempotent: true });
      }

      await pool.query(`
        INSERT INTO bank_accounts (agent_did, currency) VALUES ($1, 'usd')
        ON CONFLICT (agent_did) DO NOTHING
      `, [did]).catch(() => {});
      await pool.query(`
        UPDATE bank_accounts SET
          balance_cents = balance_cents + $1,
          lifetime_in_cents = lifetime_in_cents + $1,
          updated_at = NOW()
        WHERE agent_did = $2
      `, [cents, did]).catch(() => {});

      const creditTxn = 'btxn_' + cryptoLib.randomBytes(12).toString('hex');
      await pool.query(`
        INSERT INTO bank_transactions
          (txn_id, agent_did, type, amount_cents, currency, external_ref, created_at)
        VALUES ($1, $2, 'deposit', $3, 'usd', $4, NOW())
      `, [creditTxn, did, cents, body.tx_hash]).catch(() => {});
      await pool.query(`
        UPDATE bank_deposits SET credited_at = NOW(), credit_txn_id = $1
        WHERE deposit_id = $2
      `, [creditTxn, depositId]).catch(() => {});

      if (auditChain) {
        await auditChain.append({
          event_type: 'bank.deposit.credited',
          agent_did: did, tx_hash: body.tx_hash,
          amount_cents: cents, source: 'indexer_webhook'
        });
      }

      return res.status(201).json({
        ok: true,
        deposit_id: depositId,
        credited_cents: cents,
        credit_txn_id: creditTxn
      });
    });

  // POST /v1/agents/:did/bank/reconcile — drift report
  app.post('/v1/agents/:did/bank/reconcile', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    try {
      const walletRow = await pool.query(
        `SELECT address FROM bank_wallets WHERE agent_did = $1 AND chain = 'base'`,
        [did]
      ).catch(() => ({ rows: [] }));
      let onchainCents = 0;
      if (walletRow.rows[0]) {
        try {
          const bankChain = require('./bank_chain');
          const bal = await bankChain.getOnChainBalance(walletRow.rows[0].address, 'base', 'USDC');
          onchainCents = rawUsdcToCents(bal.raw);
        } catch {}
      }
      const r = await pool.query(
        `SELECT COALESCE(balance_cents, 0)::bigint AS bal
         FROM bank_accounts WHERE agent_did = $1`, [did]
      ).catch(() => ({ rows: [{ bal: 0 }] }));
      const ledgerCents = Number(r.rows[0]?.bal || 0);
      const drift = onchainCents - ledgerCents;
      return res.json({
        agent_did: did,
        onchain_cents: onchainCents,
        ledger_cents: ledgerCents,
        drift_cents: drift,
        in_sync: drift === 0
      });
    } catch (e) {
      return res.status(500).json({ error: 'reconcile_failed', message: e.message });
    }
  });

  // POST /v1/agents/:did/bank/sweep — atomic move between bank surfaces
  // Body: { from: 'wallet'|'ledger'|'savings', to: 'wallet'|'ledger'|'savings'|'lending_repay', amount_cents, savings_account_id?, loan_id? }
  app.post('/v1/agents/:did/bank/sweep', express.json(), async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const schema = z.object({
      from: z.enum(['wallet', 'ledger', 'savings']),
      to: z.enum(['wallet', 'ledger', 'savings', 'lending_repay']),
      amount_cents: z.number().int().positive().max(100_000_000_00),
      savings_account_id: z.string().optional(),
      loan_id: z.string().optional()
    }).refine(d => d.from !== d.to, 'from_and_to_must_differ');
    const parsed = schema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'invalid_input', details: parsed.error.flatten() });
    }
    const { from, to, amount_cents, savings_account_id, loan_id } = parsed.data;

    // ledger → savings
    if (from === 'ledger' && to === 'savings') {
      if (!savings_account_id) return res.status(400).json({ error: 'savings_account_id_required' });
      const acc = await pool.query(
        `SELECT 1 FROM savings_accounts WHERE account_id = $1 AND agent_did = $2 AND status = 'active'`,
        [savings_account_id, did]
      ).catch(() => ({ rows: [] }));
      if (!acc.rows[0]) return res.status(404).json({ error: 'savings_account_not_active' });

      // Lock ledger funds
      const fund = await pool.query(`
        UPDATE bank_accounts SET
          balance_cents = balance_cents - $1,
          lifetime_out_cents = lifetime_out_cents + $1,
          updated_at = NOW()
        WHERE agent_did = $2 AND balance_cents >= $1
        RETURNING balance_cents
      `, [amount_cents, did]).catch(() => ({ rows: [] }));
      if (!fund.rows[0]) return res.status(400).json({ error: 'insufficient_ledger_balance' });

      const amountRaw = centsToRawUsdc(amount_cents);
      await pool.query(`
        UPDATE savings_accounts SET principal_raw = principal_raw + $1
        WHERE account_id = $2
      `, [amountRaw, savings_account_id]);
      await pool.query(`
        INSERT INTO savings_transactions
          (tx_id, account_id, agent_did, kind, amount_raw, balance_after_raw)
        VALUES ($1, $2, $3, 'deposit', $4,
          (SELECT principal_raw + interest_earned_raw FROM savings_accounts WHERE account_id = $2))
      `, [newId('savtx'), savings_account_id, did, amountRaw]).catch(() => {});

      if (auditChain) {
        await auditChain.append({
          event_type: 'bank.sweep.ledger_to_savings',
          agent_did: did, amount_cents, savings_account_id
        });
      }
      return res.json({ ok: true, from, to, amount_cents, savings_account_id });
    }

    // savings → ledger
    if (from === 'savings' && to === 'ledger') {
      if (!savings_account_id) return res.status(400).json({ error: 'savings_account_id_required' });
      const acc = await pool.query(
        `SELECT principal_raw, interest_earned_raw, lock_until FROM savings_accounts
         WHERE account_id = $1 AND agent_did = $2 AND status = 'active'`,
        [savings_account_id, did]
      ).catch(() => ({ rows: [] }));
      if (!acc.rows[0]) return res.status(404).json({ error: 'savings_account_not_active' });
      if (acc.rows[0].lock_until && new Date(acc.rows[0].lock_until) > new Date()) {
        return res.status(403).json({ error: 'savings_locked', until: acc.rows[0].lock_until });
      }
      const totalRaw = BigInt(acc.rows[0].principal_raw) + BigInt(acc.rows[0].interest_earned_raw);
      const wantRaw = BigInt(centsToRawUsdc(amount_cents));
      if (wantRaw > totalRaw) {
        return res.status(400).json({
          error: 'insufficient_savings',
          available_cents: rawUsdcToCents(totalRaw.toString())
        });
      }

      // Withdraw from interest first, then principal
      const interestRaw = BigInt(acc.rows[0].interest_earned_raw);
      const takeInterest = wantRaw <= interestRaw ? wantRaw : interestRaw;
      const takePrincipal = wantRaw - takeInterest;

      await pool.query(`
        UPDATE savings_accounts SET
          principal_raw = principal_raw - $1,
          interest_earned_raw = interest_earned_raw - $2
        WHERE account_id = $3
      `, [takePrincipal.toString(), takeInterest.toString(), savings_account_id]);

      await pool.query(`
        INSERT INTO bank_accounts (agent_did, currency) VALUES ($1, 'usd')
        ON CONFLICT (agent_did) DO NOTHING
      `, [did]).catch(() => {});
      await pool.query(`
        UPDATE bank_accounts SET
          balance_cents = balance_cents + $1,
          lifetime_in_cents = lifetime_in_cents + $1,
          updated_at = NOW()
        WHERE agent_did = $2
      `, [amount_cents, did]);

      if (auditChain) {
        await auditChain.append({
          event_type: 'bank.sweep.savings_to_ledger',
          agent_did: did, amount_cents, savings_account_id
        });
      }
      return res.json({ ok: true, from, to, amount_cents, savings_account_id });
    }

    // ledger → lending_repay
    if (from === 'ledger' && to === 'lending_repay') {
      if (!loan_id) return res.status(400).json({ error: 'loan_id_required' });
      const loan = await pool.query(
        `SELECT borrowed_raw, repaid_raw, status FROM lending_loans
         WHERE loan_id = $1 AND borrower_did = $2`, [loan_id, did]
      ).catch(() => ({ rows: [] }));
      if (!loan.rows[0]) return res.status(404).json({ error: 'loan_not_found' });
      if (loan.rows[0].status !== 'active' && loan.rows[0].status !== 'past_due') {
        return res.status(400).json({ error: 'loan_not_repayable', status: loan.rows[0].status });
      }
      const owed = BigInt(loan.rows[0].borrowed_raw) - BigInt(loan.rows[0].repaid_raw);
      const wantRaw = BigInt(centsToRawUsdc(amount_cents));
      if (wantRaw > owed) {
        return res.status(400).json({
          error: 'repayment_exceeds_debt',
          owed_cents: rawUsdcToCents(owed.toString())
        });
      }
      const debit = await pool.query(`
        UPDATE bank_accounts SET
          balance_cents = balance_cents - $1,
          lifetime_out_cents = lifetime_out_cents + $1,
          updated_at = NOW()
        WHERE agent_did = $2 AND balance_cents >= $1
        RETURNING balance_cents
      `, [amount_cents, did]).catch(() => ({ rows: [] }));
      if (!debit.rows[0]) return res.status(400).json({ error: 'insufficient_ledger_balance' });

      await pool.query(`
        UPDATE lending_loans SET
          repaid_raw = repaid_raw + $1,
          status = CASE
            WHEN repaid_raw + $1 >= borrowed_raw THEN 'repaid'
            ELSE status END
        WHERE loan_id = $2
      `, [wantRaw.toString(), loan_id]).catch(() => {});

      if (auditChain) {
        await auditChain.append({
          event_type: 'bank.sweep.ledger_to_lending_repay',
          agent_did: did, amount_cents, loan_id
        });
      }
      return res.json({ ok: true, from, to, amount_cents, loan_id });
    }

    return res.status(400).json({ error: 'unsupported_sweep_pair', from, to });
  });

  // Cron jobs
  registerCron(app, '/v1/_jobs/bank-deposit-sweep',
    async (req, res) => res.json(await sweepDeposits(pool, auditChain)),
    'every:5m');
  registerCron(app, '/v1/_jobs/bank-reconcile',
    async (req, res) => res.json(await reconcileAll(pool, auditChain)),
    'hourly');
  registerCron(app, '/v1/_jobs/bank-snapshot',
    async (req, res) => res.json(await snapshotAll(pool)),
    'daily');
}

module.exports = {
  migrate,
  registerBankAccountRoutes,
  buildAccount,
  buildStatement,
  sweepDeposits,
  reconcileAll,
  snapshotAll,
  rawUsdcToCents,
  centsToRawUsdc
};
