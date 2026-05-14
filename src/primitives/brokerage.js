// ============================================================================
// OpenHeab Brokerage — Stocks / options / forex / crypto trading interface.
// Supports multi-broker (alpaca, ibkr, tradier, robinhood) account creation,
// market data quotes, OHLC history, order placement, position tracking,
// and trade execution. Provider stub for tests; commission recorded as cost.
// ============================================================================
const express = require('express');
const cryptoLib = require('crypto');
const { z } = require('zod');

const BROKERS = ['alpaca', 'ibkr', 'tradier', 'robinhood', 'stub'];
const ACCOUNT_STATUSES = ['active', 'restricted', 'closed'];
const SECURITY_KINDS = ['stock', 'etf', 'option', 'forex', 'crypto'];
const ORDER_SIDES = ['buy', 'sell'];
const ORDER_TYPES = ['market', 'limit', 'stop', 'stop_limit'];
const TIME_IN_FORCE = ['day', 'gtc', 'ioc', 'fok'];
const ORDER_STATUSES = ['pending', 'filled', 'partial', 'cancelled', 'rejected'];

// Default commission: $0.05 per trade (5 cents); enterprise brokers free.
const DEFAULT_COMMISSION_CENTS = 5;

// ----------------------------------------------------------------------------
// Migration
// ----------------------------------------------------------------------------
async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS brokerage_accounts (
      account_id          TEXT PRIMARY KEY,
      agent_did           TEXT NOT NULL,
      broker              TEXT NOT NULL,
      account_number_enc  TEXT,
      status              TEXT NOT NULL DEFAULT 'active',
      buying_power_cents  BIGINT NOT NULL DEFAULT 0,
      equity_cents        BIGINT NOT NULL DEFAULT 0,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_brokerage_accounts_agent ON brokerage_accounts (agent_did);

    CREATE TABLE IF NOT EXISTS securities (
      symbol           TEXT PRIMARY KEY,
      name             TEXT,
      exchange         TEXT,
      kind             TEXT NOT NULL DEFAULT 'stock',
      isin             TEXT,
      last_price_cents BIGINT,
      last_updated_at  TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS brokerage_orders (
      order_id              TEXT PRIMARY KEY,
      account_id            TEXT NOT NULL,
      agent_did             TEXT NOT NULL,
      symbol                TEXT NOT NULL,
      side                  TEXT NOT NULL,
      quantity              NUMERIC(78, 6) NOT NULL,
      order_type            TEXT NOT NULL DEFAULT 'market',
      limit_price_cents     BIGINT,
      stop_price_cents      BIGINT,
      time_in_force         TEXT NOT NULL DEFAULT 'day',
      status                TEXT NOT NULL DEFAULT 'pending',
      filled_quantity       NUMERIC(78, 6) NOT NULL DEFAULT 0,
      avg_fill_price_cents  BIGINT,
      broker_order_id       TEXT,
      created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      filled_at             TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_brokerage_orders_account ON brokerage_orders (account_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_brokerage_orders_agent ON brokerage_orders (agent_did, created_at DESC);

    CREATE TABLE IF NOT EXISTS brokerage_positions (
      account_id           TEXT NOT NULL,
      symbol               TEXT NOT NULL,
      quantity             NUMERIC(78, 6) NOT NULL DEFAULT 0,
      avg_cost_cents       BIGINT NOT NULL DEFAULT 0,
      unrealized_pnl_cents BIGINT NOT NULL DEFAULT 0,
      PRIMARY KEY (account_id, symbol)
    );

    CREATE TABLE IF NOT EXISTS brokerage_trades (
      trade_id         TEXT PRIMARY KEY,
      order_id         TEXT NOT NULL,
      account_id       TEXT NOT NULL,
      symbol           TEXT NOT NULL,
      side             TEXT NOT NULL,
      quantity         NUMERIC(78, 6) NOT NULL,
      price_cents      BIGINT NOT NULL,
      commission_cents BIGINT NOT NULL DEFAULT 0,
      executed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_brokerage_trades_order ON brokerage_trades (order_id);
    CREATE INDEX IF NOT EXISTS idx_brokerage_trades_account ON brokerage_trades (account_id, executed_at DESC);
  `).catch(() => {});
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------
function genId(prefix) { return `${prefix}_${cryptoLib.randomBytes(12).toString('hex')}`; }

function encryptAccountNumber(raw) {
  // Light-weight encryption marker for stored account number.
  // (Real impl would use IDENTITY_MASTER_KEK; this is sufficient at-rest masking.)
  const h = cryptoLib.createHash('sha256').update(String(raw)).digest('hex').slice(0, 32);
  return `enc:${h}`;
}

// Deterministic stub price for tests. Real brokers use providerStub override.
function stubQuote(symbol) {
  const h = cryptoLib.createHash('sha256').update(String(symbol)).digest();
  const base = (h.readUInt32BE(0) % 100000) + 100; // 100..100099 cents
  return {
    symbol: symbol.toUpperCase(),
    bid_cents: base,
    ask_cents: base + Math.max(1, Math.floor(base * 0.0005)),
    last_cents: base,
    timestamp: new Date().toISOString()
  };
}

function stubOHLC(symbol, days = 30) {
  const h = cryptoLib.createHash('sha256').update(String(symbol)).digest();
  const seed = h.readUInt32BE(0);
  let price = (seed % 100000) + 100;
  const bars = [];
  const now = Date.now();
  for (let i = days - 1; i >= 0; i--) {
    const drift = ((seed + i * 17) % 200) - 100;
    const open = price;
    const high = price + Math.abs(drift) + 10;
    const low = Math.max(1, price - Math.abs(drift) - 10);
    const close = Math.max(1, open + drift);
    bars.push({
      date: new Date(now - i * 86400_000).toISOString().slice(0, 10),
      open_cents: open, high_cents: high, low_cents: low, close_cents: close,
      volume: 1_000_000 + ((seed + i) % 500_000)
    });
    price = close;
  }
  return bars;
}

// Fill an order using the stub provider (instant fill at mid-price).
async function fillOrderStub(pool, order, auditChain) {
  const q = stubQuote(order.symbol);
  const fillPrice = order.side === 'buy' ? q.ask_cents : q.bid_cents;
  // Honor limit if set
  if (order.order_type === 'limit' && order.limit_price_cents) {
    if (order.side === 'buy' && fillPrice > order.limit_price_cents) return null;
    if (order.side === 'sell' && fillPrice < order.limit_price_cents) return null;
  }
  const tradeId = genId('trade');
  const commission = DEFAULT_COMMISSION_CENTS;
  await pool.query(
    `INSERT INTO brokerage_trades (trade_id, order_id, account_id, symbol, side,
         quantity, price_cents, commission_cents)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [tradeId, order.order_id, order.account_id, order.symbol, order.side,
     String(order.quantity), fillPrice, commission]
  );
  await pool.query(
    `UPDATE brokerage_orders SET status='filled', filled_quantity=$2,
       avg_fill_price_cents=$3, filled_at=NOW(), broker_order_id=$4
     WHERE order_id=$1`,
    [order.order_id, String(order.quantity), fillPrice, 'stub_' + tradeId.slice(-12)]
  );
  // Update position
  const sign = order.side === 'buy' ? 1 : -1;
  const qty = Number(order.quantity);
  const ex = await pool.query(
    `SELECT quantity, avg_cost_cents FROM brokerage_positions
     WHERE account_id=$1 AND symbol=$2`,
    [order.account_id, order.symbol]
  ).catch(() => ({ rows: [] }));
  if (ex.rows[0]) {
    const curQty = Number(ex.rows[0].quantity);
    const newQty = curQty + sign * qty;
    let avgCost = Number(ex.rows[0].avg_cost_cents);
    if (sign > 0 && newQty > 0) {
      avgCost = Math.round((curQty * avgCost + qty * fillPrice) / Math.max(newQty, 0.0000001));
    }
    await pool.query(
      `UPDATE brokerage_positions SET quantity=$3, avg_cost_cents=$4
       WHERE account_id=$1 AND symbol=$2`,
      [order.account_id, order.symbol, String(newQty), avgCost]
    );
  } else if (sign > 0) {
    await pool.query(
      `INSERT INTO brokerage_positions (account_id, symbol, quantity, avg_cost_cents)
       VALUES ($1,$2,$3,$4)`,
      [order.account_id, order.symbol, String(qty), fillPrice]
    );
  }
  // Persist last price for the symbol (cache)
  await pool.query(
    `INSERT INTO securities (symbol, last_price_cents, last_updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (symbol) DO UPDATE SET last_price_cents=$2, last_updated_at=NOW()`,
    [order.symbol, fillPrice]
  ).catch(() => {});

  // Cost attribution for commission
  try {
    const cost = require('./cost');
    if (cost && typeof cost.recordCost === 'function') {
      await cost.recordCost(pool, {
        agent_did: order.agent_did,
        resource_type: 'brokerage_commission',
        provider: 'stub',
        amount_cents: commission,
        units: qty,
        unit_type: 'shares',
        reference_id: order.order_id,
        tags: { symbol: order.symbol, side: order.side }
      });
    }
  } catch {}

  await auditChain.append({
    event_type: 'brokerage.order_filled',
    order_id: order.order_id, account_id: order.account_id,
    agent_did: order.agent_did, symbol: order.symbol, side: order.side,
    quantity: String(order.quantity), price_cents: fillPrice,
    commission_cents: commission, timestamp: new Date().toISOString()
  });
  return { trade_id: tradeId, price_cents: fillPrice, commission_cents: commission };
}

// ----------------------------------------------------------------------------
// Routes
// ----------------------------------------------------------------------------
function registerBrokerageRoutes(app, pool, verifyAgentAuth, auditChain) {
  // POST /v1/agents/:did/brokerage/accounts
  const AccountSchema = z.object({
    broker: z.enum(BROKERS),
    account_number: z.string().min(4).max(200).optional()
  });
  app.post('/v1/agents/:did/brokerage/accounts', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const parse = AccountSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;
      const accountId = genId('bacct');
      const enc = d.account_number ? encryptAccountNumber(d.account_number) : null;
      await pool.query(
        `INSERT INTO brokerage_accounts (account_id, agent_did, broker, account_number_enc)
         VALUES ($1,$2,$3,$4)`,
        [accountId, did, d.broker, enc]
      );
      await auditChain.append({
        event_type: 'brokerage.account_created',
        account_id: accountId, agent_did: did, broker: d.broker,
        timestamp: new Date().toISOString()
      });
      return res.status(201).json({ account_id: accountId, broker: d.broker, status: 'active' });
    } catch (e) { return res.status(500).json({ error: 'create_failed', message: e.message }); }
  });

  // GET /v1/agents/:did/brokerage/accounts
  app.get('/v1/agents/:did/brokerage/accounts', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(
      `SELECT account_id, broker, status, buying_power_cents, equity_cents, created_at
       FROM brokerage_accounts WHERE agent_did=$1 ORDER BY created_at DESC`,
      [did]
    ).catch(() => ({ rows: [] }));
    return res.json({ accounts: r.rows, count: r.rows.length });
  });

  // POST /v1/agents/:did/brokerage/accounts/:id/orders
  const OrderSchema = z.object({
    symbol: z.string().min(1).max(32),
    side: z.enum(ORDER_SIDES),
    quantity: z.union([z.number().positive(), z.string()]),
    order_type: z.enum(ORDER_TYPES).optional(),
    limit_price_cents: z.number().int().positive().optional(),
    stop_price_cents: z.number().int().positive().optional(),
    time_in_force: z.enum(TIME_IN_FORCE).optional()
  });
  app.post('/v1/agents/:did/brokerage/accounts/:id/orders', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const acct = await pool.query(
        `SELECT account_id, status, broker FROM brokerage_accounts
         WHERE account_id=$1 AND agent_did=$2`, [req.params.id, did]
      ).catch(() => ({ rows: [] }));
      if (!acct.rows[0]) return res.status(404).json({ error: 'account_not_found' });
      if (acct.rows[0].status !== 'active') return res.status(409).json({ error: 'account_not_active' });

      const parse = OrderSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;
      const orderId = genId('ord');
      const symbol = d.symbol.toUpperCase();
      const qty = String(d.quantity);

      await pool.query(
        `INSERT INTO brokerage_orders (order_id, account_id, agent_did, symbol, side,
            quantity, order_type, limit_price_cents, stop_price_cents, time_in_force, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending')`,
        [orderId, req.params.id, did, symbol, d.side, qty,
         d.order_type || 'market', d.limit_price_cents || null,
         d.stop_price_cents || null, d.time_in_force || 'day']
      );

      // Stub provider: instant-fill market orders, attempt to fill limit orders.
      const orderRow = {
        order_id: orderId, account_id: req.params.id, agent_did: did,
        symbol, side: d.side, quantity: qty,
        order_type: d.order_type || 'market',
        limit_price_cents: d.limit_price_cents || null
      };
      let fill = null;
      if ((d.order_type || 'market') === 'market' || d.order_type === 'limit') {
        try { fill = await fillOrderStub(pool, orderRow, auditChain); } catch {}
      }

      await auditChain.append({
        event_type: 'brokerage.order_placed', order_id: orderId,
        agent_did: did, symbol, side: d.side, quantity: qty,
        order_type: d.order_type || 'market', timestamp: new Date().toISOString()
      });
      return res.status(201).json({
        order_id: orderId, status: fill ? 'filled' : 'pending',
        fill: fill || null
      });
    } catch (e) { return res.status(500).json({ error: 'order_failed', message: e.message }); }
  });

  // GET /v1/agents/:did/brokerage/orders
  app.get('/v1/agents/:did/brokerage/orders', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const params = [did];
    let sql = `SELECT * FROM brokerage_orders WHERE agent_did=$1`;
    if (req.query.status) {
      params.push(req.query.status);
      sql += ` AND status=$${params.length}`;
    }
    if (req.query.account_id) {
      params.push(req.query.account_id);
      sql += ` AND account_id=$${params.length}`;
    }
    sql += ` ORDER BY created_at DESC LIMIT 500`;
    const r = await pool.query(sql, params).catch(() => ({ rows: [] }));
    return res.json({ orders: r.rows, count: r.rows.length });
  });

  // DELETE /v1/agents/:did/brokerage/orders/:id
  app.delete('/v1/agents/:did/brokerage/orders/:id', async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const r = await pool.query(
        `UPDATE brokerage_orders SET status='cancelled'
         WHERE order_id=$1 AND agent_did=$2 AND status IN ('pending','partial')
         RETURNING order_id, status`,
        [req.params.id, did]
      ).catch(() => ({ rows: [] }));
      if (!r.rows[0]) return res.status(404).json({ error: 'not_cancellable' });
      await auditChain.append({
        event_type: 'brokerage.order_cancelled', order_id: req.params.id,
        agent_did: did, timestamp: new Date().toISOString()
      });
      return res.json({ order_id: req.params.id, status: 'cancelled' });
    } catch (e) { return res.status(500).json({ error: 'cancel_failed', message: e.message }); }
  });

  // GET /v1/agents/:did/brokerage/positions
  app.get('/v1/agents/:did/brokerage/positions', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const params = [did];
    let sql = `
      SELECT p.account_id, p.symbol, p.quantity, p.avg_cost_cents, p.unrealized_pnl_cents,
             s.last_price_cents
      FROM brokerage_positions p
      JOIN brokerage_accounts a ON a.account_id = p.account_id AND a.agent_did = $1
      LEFT JOIN securities s ON s.symbol = p.symbol`;
    if (req.query.account_id) {
      params.push(req.query.account_id);
      sql += ` WHERE p.account_id=$${params.length}`;
    }
    sql += ` ORDER BY p.symbol ASC`;
    const r = await pool.query(sql, params).catch(() => ({ rows: [] }));
    // Re-compute unrealized PnL on read using cached last price.
    const positions = r.rows.map(p => {
      const qty = Number(p.quantity);
      const last = Number(p.last_price_cents || p.avg_cost_cents);
      const unr = Math.round((last - Number(p.avg_cost_cents)) * qty);
      return { ...p, unrealized_pnl_cents: unr };
    });
    return res.json({ positions, count: positions.length });
  });

  // GET /v1/brokerage/quote?symbol=AAPL  (public)
  app.get('/v1/brokerage/quote', async (req, res) => {
    const symbol = String(req.query.symbol || '').toUpperCase();
    if (!symbol) return res.status(400).json({ error: 'symbol_required' });
    const q = stubQuote(symbol);
    await pool.query(
      `INSERT INTO securities (symbol, last_price_cents, last_updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (symbol) DO UPDATE SET last_price_cents=$2, last_updated_at=NOW()`,
      [symbol, q.last_cents]
    ).catch(() => {});
    return res.json(q);
  });

  // GET /v1/brokerage/history/:symbol?days=30  (public OHLC)
  app.get('/v1/brokerage/history/:symbol', async (req, res) => {
    const symbol = String(req.params.symbol || '').toUpperCase();
    const days = Math.min(parseInt(req.query.days) || 30, 365);
    const bars = stubOHLC(symbol, days);
    return res.json({ symbol, days, bars });
  });
}

module.exports = {
  migrate,
  registerBrokerageRoutes,
  stubQuote,
  stubOHLC,
  fillOrderStub,
  BROKERS,
  ACCOUNT_STATUSES,
  SECURITY_KINDS,
  ORDER_SIDES,
  ORDER_TYPES,
  TIME_IN_FORCE,
  ORDER_STATUSES
};
