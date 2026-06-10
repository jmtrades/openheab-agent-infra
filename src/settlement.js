// ============================================================================
// settlement.js — moves real ledger money for the economy primitives.
//
// Layer 82's wedges (treasury, credit, clearing, payroll, funds) keep their
// own books; this helper makes those books settle on the bank's cents ledger
// (bank_accounts / bank_transactions) so value is conserved across the whole
// substrate: payroll debits the employer, fund buys cost real balance, fees
// land in the platform's account.
//
// Modes (SETTLEMENT_MODE env, read per call):
//   besteffort (default) — attempt the transfer; on failure (no balance, no
//                          bank module) record { settled:false, reason } and
//                          let the operation proceed. Right for dev/demo
//                          where wallets start empty.
//   strict               — user-initiated operations must settle or fail.
//                          Right for production, where balances are real.
//
// Scheduled work (crons) is ALWAYS besteffort — a payroll run records its
// settlement outcome rather than throwing, so one broke employer can't halt
// the cycle for everyone else.
// ============================================================================

const POOLS = {
  platform: process.env.PLATFORM_DID || 'did:op:platform',
  treasury: process.env.TREASURY_POOL_DID || 'did:op:treasury',
  clearing: process.env.CLEARING_POOL_DID || 'did:op:clearing',
  tax: process.env.TAX_ESCROW_DID || 'did:op:tax-escrow',
  fund: (slug) => `did:op:fund:${slug}`
};

function strictMode() {
  return process.env.SETTLEMENT_MODE === 'strict';
}

// Attempt a ledger transfer. Never throws; returns
//   { settled: true,  txn_id }            on success
//   { settled: false, reason }            on any failure
async function settle(bank, pool, auditChain, { from, to, amount_cents, memo, idem }) {
  if (!amount_cents || amount_cents <= 0) return { settled: false, reason: 'zero_amount' };
  if (!bank || typeof bank.handleTransfer !== 'function') {
    return { settled: false, reason: 'ledger_unavailable' };
  }
  try {
    const r = await bank.handleTransfer(pool, auditChain, {
      from_did: from, to_did: to, amount_cents, memo, idempotency_key: idem
    });
    return { settled: true, txn_id: r.txn_id };
  } catch (e) {
    return { settled: false, reason: e.message };
  }
}

// For user-initiated operations: settle, and in strict mode report whether
// the caller should reject the operation.
async function settleOrReject(bank, pool, auditChain, params) {
  const r = await settle(bank, pool, auditChain, params);
  r.reject = !r.settled && strictMode();
  return r;
}

module.exports = { settle, settleOrReject, strictMode, POOLS };
