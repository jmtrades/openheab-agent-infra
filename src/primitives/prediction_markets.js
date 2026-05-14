// ============================================================================
// OpenHeab Prediction Markets — Polymarket-style binary / multi / scalar
// markets with constant-product AMM pricing. Resolvers (admin or designated
// oracle DID) settle markets; winners claim payouts. Costs recorded per order.
// ============================================================================
const express = require('express');
const cryptoLib = require('crypto');
const { z } = require('zod');

const MARKET_KINDS = ['binary', 'multi', 'scalar'];
const MARKET_STATUSES = ['open', 'closed', 'resolved', 'disputed'];
const ORDER_SIDES = ['buy', 'sell'];
const ORDER_STATUSES = ['pending', 'filled', 'cancelled'];

// 10000 bps = 100% probability
const MAX_BPS = 10000;
// Default initial liquidity per option (in shares) for AMM bootstrapping.
const INITIAL_LIQUIDITY = 1_000_000;
// Per-order operational cost (cents). Routed to cost primitive.
const PER_ORDER_COST_CENTS = 1;

// ----------------------------------------------------------------------------
// Migration
// ----------------------------------------------------------------------------
async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS prediction_markets (
      market_id              TEXT PRIMARY KEY,
      creator_did            TEXT NOT NULL,
      question               TEXT NOT NULL,
      description            TEXT,
      resolution_source_url  TEXT,
      kind                   TEXT NOT NULL DEFAULT 'binary',
      options                JSONB NOT NULL,
      resolves_at            TIMESTAMPTZ,
      resolved_at            TIMESTAMPTZ,
      resolution_value       TEXT,
      status                 TEXT NOT NULL DEFAULT 'open',
      total_volume_usdc_raw  NUMERIC(78, 0) NOT NULL DEFAULT 0,
      category               TEXT,
      tags                   TEXT[],
      liquidity              JSONB NOT NULL DEFAULT '{}'::jsonb,
      oracle_did             TEXT,
      created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_pred_markets_status ON prediction_markets (status, resolves_at);
    CREATE INDEX IF NOT EXISTS idx_pred_markets_category ON prediction_markets (category);

    CREATE TABLE IF NOT EXISTS prediction_positions (
      position_id     TEXT PRIMARY KEY,
      market_id       TEXT NOT NULL,
      holder_did      TEXT NOT NULL,
      option_id       TEXT NOT NULL,
      shares          NUMERIC(78, 0) NOT NULL DEFAULT 0,
      avg_price_bps   INTEGER NOT NULL DEFAULT 5000,
      claimed         BOOLEAN NOT NULL DEFAULT FALSE,
      opened_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (market_id, holder_did, option_id)
    );
    CREATE INDEX IF NOT EXISTS idx_pred_positions_holder ON prediction_positions (holder_did);
    CREATE INDEX IF NOT EXISTS idx_pred_positions_market ON prediction_positions (market_id);

    CREATE TABLE IF NOT EXISTS prediction_orders (
      order_id        TEXT PRIMARY KEY,
      market_id       TEXT NOT NULL,
      agent_did       TEXT NOT NULL,
      option_id       TEXT NOT NULL,
      side            TEXT NOT NULL,
      shares          NUMERIC(78, 0) NOT NULL,
      limit_price_bps INTEGER,
      fill_price_bps  INTEGER,
      status          TEXT NOT NULL DEFAULT 'pending',
      filled_at       TIMESTAMPTZ,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_pred_orders_agent ON prediction_orders (agent_did, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_pred_orders_market ON prediction_orders (market_id);

    CREATE TABLE IF NOT EXISTS prediction_resolutions (
      resolution_id TEXT PRIMARY KEY,
      market_id     TEXT NOT NULL,
      resolver_did  TEXT NOT NULL,
      value         TEXT NOT NULL,
      evidence_uri  TEXT,
      signature     TEXT,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `).catch(() => {});
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------
function genId(prefix) { return `${prefix}_${cryptoLib.randomBytes(12).toString('hex')}`; }

// Constant-product AMM: price = shares_in_option / total_shares_across_options
function computePricesBps(liquidity, options) {
  const totals = {};
  let total = 0;
  for (const opt of options) {
    const v = Number(liquidity[opt.id] || INITIAL_LIQUIDITY);
    totals[opt.id] = v;
    total += v;
  }
  const prices = {};
  if (total <= 0) {
    for (const opt of options) prices[opt.id] = Math.floor(MAX_BPS / options.length);
  } else {
    for (const opt of options) {
      // For CP-AMM in prediction markets, option price = (total - opt) / total
      // (lower liquidity in an option = higher probability for that option)
      // We use: price_i = (sum_j!=i L_j) / sum_j L_j
      // This ensures sum of prices = (n-1) - effectively normalized below.
      const other = total - totals[opt.id];
      prices[opt.id] = total > 0 ? Math.round((other / total) * MAX_BPS / (options.length - 1 || 1)) : 0;
    }
    // Normalize so prices sum to MAX_BPS
    const sum = Object.values(prices).reduce((a, b) => a + b, 0);
    if (sum > 0) {
      for (const k of Object.keys(prices)) {
        prices[k] = Math.round((prices[k] / sum) * MAX_BPS);
      }
    }
  }
  return prices;
}

// Execute a buy/sell against the AMM. Returns { shares, price_bps, new_liquidity }
function executeAMM(liquidity, options, optionId, side, shares) {
  const liq = { ...liquidity };
  for (const opt of options) {
    if (liq[opt.id] == null) liq[opt.id] = INITIAL_LIQUIDITY;
  }
  // Price before trade
  const pricesBefore = computePricesBps(liq, options);
  // Adjust liquidity: buying option X removes shares from option X's bucket.
  // Selling adds back.
  const delta = side === 'buy' ? -Number(shares) : Number(shares);
  liq[optionId] = Math.max(1, Number(liq[optionId]) + delta);
  const pricesAfter = computePricesBps(liq, options);
  // Average fill price = midpoint between before/after for the option.
  const fillBps = Math.round(((pricesBefore[optionId] || 0) + (pricesAfter[optionId] || 0)) / 2);
  return {
    fill_price_bps: Math.min(MAX_BPS, Math.max(1, fillBps)),
    new_liquidity: liq
  };
}

// ----------------------------------------------------------------------------
// Routes
// ----------------------------------------------------------------------------
function registerPredictionMarketsRoutes(app, pool, verifyAgentAuth, auditChain) {
  // POST /v1/prediction/markets — create
  const MarketSchema = z.object({
    creator_did: z.string(),
    question: z.string().min(3).max(2000),
    description: z.string().max(20000).optional(),
    resolution_source_url: z.string().url().max(2000).optional(),
    kind: z.enum(MARKET_KINDS).optional(),
    options: z.array(z.object({ id: z.string().min(1).max(80), label: z.string().max(200) })).min(2).max(50),
    resolves_at: z.string(),
    category: z.string().max(80).optional(),
    tags: z.array(z.string().max(50)).max(20).optional(),
    oracle_did: z.string().optional()
  });
  app.post('/v1/prediction/markets', express.json(), async (req, res) => {
    try {
      const parse = MarketSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;
      const auth = await verifyAgentAuth(req, d.creator_did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const marketId = genId('mkt');
      const initialLiquidity = {};
      for (const opt of d.options) initialLiquidity[opt.id] = INITIAL_LIQUIDITY;
      await pool.query(
        `INSERT INTO prediction_markets
           (market_id, creator_did, question, description, resolution_source_url,
            kind, options, resolves_at, status, category, tags, liquidity, oracle_did)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,'open',$9,$10,$11::jsonb,$12)`,
        [marketId, d.creator_did, d.question, d.description || null,
         d.resolution_source_url || null, d.kind || 'binary',
         JSON.stringify(d.options), d.resolves_at, d.category || null,
         d.tags || null, JSON.stringify(initialLiquidity),
         d.oracle_did || null]
      );
      await auditChain.append({
        event_type: 'prediction.market_created', market_id: marketId,
        creator_did: d.creator_did, kind: d.kind || 'binary',
        timestamp: new Date().toISOString()
      });
      return res.status(201).json({
        market_id: marketId, question: d.question,
        options: d.options, status: 'open'
      });
    } catch (e) { return res.status(500).json({ error: 'create_failed', message: e.message }); }
  });

  // GET /v1/prediction/markets — browse
  app.get('/v1/prediction/markets', async (req, res) => {
    const params = [];
    let sql = `SELECT * FROM prediction_markets WHERE 1=1`;
    if (req.query.status) {
      params.push(req.query.status);
      sql += ` AND status=$${params.length}`;
    }
    if (req.query.category) {
      params.push(req.query.category);
      sql += ` AND category=$${params.length}`;
    }
    sql += ` ORDER BY created_at DESC LIMIT 200`;
    const r = await pool.query(sql, params).catch(() => ({ rows: [] }));
    const enriched = r.rows.map(m => ({
      ...m,
      prices_bps: computePricesBps(m.liquidity || {}, m.options || [])
    }));
    return res.json({ markets: enriched, count: enriched.length });
  });

  // GET /v1/prediction/markets/:id
  app.get('/v1/prediction/markets/:id', async (req, res) => {
    const r = await pool.query(
      `SELECT * FROM prediction_markets WHERE market_id=$1`, [req.params.id]
    ).catch(() => ({ rows: [] }));
    if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
    const m = r.rows[0];
    return res.json({
      ...m,
      prices_bps: computePricesBps(m.liquidity || {}, m.options || [])
    });
  });

  // POST /v1/prediction/markets/:id/orders — place a bet
  const OrderSchema = z.object({
    agent_did: z.string(),
    option_id: z.string(),
    side: z.enum(ORDER_SIDES),
    shares: z.union([z.number().int().positive(), z.string()]),
    limit_price_bps: z.number().int().min(1).max(MAX_BPS).optional()
  });
  app.post('/v1/prediction/markets/:id/orders', express.json(), async (req, res) => {
    try {
      const parse = OrderSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;
      const auth = await verifyAgentAuth(req, d.agent_did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const mRow = await pool.query(
        `SELECT * FROM prediction_markets WHERE market_id=$1`, [req.params.id]
      ).catch(() => ({ rows: [] }));
      if (!mRow.rows[0]) return res.status(404).json({ error: 'market_not_found' });
      const m = mRow.rows[0];
      if (m.status !== 'open') return res.status(409).json({ error: 'market_not_open' });
      const opt = (m.options || []).find(o => o.id === d.option_id);
      if (!opt) return res.status(400).json({ error: 'invalid_option' });

      const exec = executeAMM(m.liquidity || {}, m.options, d.option_id, d.side, d.shares);
      if (d.limit_price_bps) {
        if (d.side === 'buy' && exec.fill_price_bps > d.limit_price_bps) {
          return res.status(409).json({ error: 'limit_not_met', current_bps: exec.fill_price_bps });
        }
        if (d.side === 'sell' && exec.fill_price_bps < d.limit_price_bps) {
          return res.status(409).json({ error: 'limit_not_met', current_bps: exec.fill_price_bps });
        }
      }

      const orderId = genId('pord');
      await pool.query(
        `INSERT INTO prediction_orders
           (order_id, market_id, agent_did, option_id, side, shares,
            limit_price_bps, fill_price_bps, status, filled_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'filled', NOW())`,
        [orderId, req.params.id, d.agent_did, d.option_id, d.side,
         String(d.shares), d.limit_price_bps || null, exec.fill_price_bps]
      );

      // Update market liquidity + total volume (volume = shares * price in USDC bps)
      const sharesNum = BigInt(String(d.shares));
      const volumeRaw = (sharesNum * BigInt(exec.fill_price_bps)) / BigInt(MAX_BPS);
      await pool.query(
        `UPDATE prediction_markets SET liquidity=$2::jsonb,
                                       total_volume_usdc_raw = total_volume_usdc_raw + $3
         WHERE market_id=$1`,
        [req.params.id, JSON.stringify(exec.new_liquidity), volumeRaw.toString()]
      );

      // Update position
      const ex = await pool.query(
        `SELECT position_id, shares, avg_price_bps FROM prediction_positions
         WHERE market_id=$1 AND holder_did=$2 AND option_id=$3`,
        [req.params.id, d.agent_did, d.option_id]
      ).catch(() => ({ rows: [] }));
      const signedShares = d.side === 'buy' ? sharesNum : -sharesNum;
      if (ex.rows[0]) {
        const curShares = BigInt(ex.rows[0].shares);
        const newShares = curShares + signedShares;
        let avgBps = ex.rows[0].avg_price_bps;
        if (d.side === 'buy' && newShares > 0n) {
          avgBps = Math.round(
            (Number(curShares) * Number(ex.rows[0].avg_price_bps) +
             Number(sharesNum) * exec.fill_price_bps) / Number(newShares)
          );
        }
        await pool.query(
          `UPDATE prediction_positions SET shares=$2, avg_price_bps=$3
           WHERE position_id=$1`,
          [ex.rows[0].position_id, newShares.toString(), avgBps]
        );
      } else if (d.side === 'buy') {
        const positionId = genId('pos');
        await pool.query(
          `INSERT INTO prediction_positions
             (position_id, market_id, holder_did, option_id, shares, avg_price_bps)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [positionId, req.params.id, d.agent_did, d.option_id,
           sharesNum.toString(), exec.fill_price_bps]
        );
      }

      // Cost attribution
      try {
        const cost = require('./cost');
        if (cost && typeof cost.recordCost === 'function') {
          await cost.recordCost(pool, {
            agent_did: d.agent_did,
            resource_type: 'prediction_order',
            provider: 'amm',
            amount_cents: PER_ORDER_COST_CENTS,
            units: Number(d.shares),
            unit_type: 'shares',
            reference_id: orderId,
            tags: { market_id: req.params.id, option_id: d.option_id, side: d.side }
          });
        }
      } catch {}

      await auditChain.append({
        event_type: 'prediction.order_placed',
        order_id: orderId, market_id: req.params.id,
        agent_did: d.agent_did, option_id: d.option_id, side: d.side,
        shares: String(d.shares), fill_price_bps: exec.fill_price_bps,
        timestamp: new Date().toISOString()
      });

      return res.status(201).json({
        order_id: orderId, status: 'filled',
        fill_price_bps: exec.fill_price_bps, shares: String(d.shares)
      });
    } catch (e) { return res.status(500).json({ error: 'order_failed', message: e.message }); }
  });

  // GET /v1/agents/:did/prediction/positions
  app.get('/v1/agents/:did/prediction/positions', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(
      `SELECT p.*, m.question, m.status AS market_status, m.options, m.liquidity,
              m.resolution_value
       FROM prediction_positions p
       JOIN prediction_markets m ON m.market_id = p.market_id
       WHERE p.holder_did=$1
       ORDER BY p.opened_at DESC LIMIT 500`, [did]
    ).catch(() => ({ rows: [] }));
    const enriched = r.rows.map(p => ({
      ...p,
      current_price_bps: computePricesBps(p.liquidity || {}, p.options || [])[p.option_id] || 0
    }));
    return res.json({ positions: enriched, count: enriched.length });
  });

  // POST /v1/prediction/markets/:id/resolve
  const ResolveSchema = z.object({
    resolver_did: z.string(),
    value: z.string().min(1).max(200),
    evidence_uri: z.string().url().max(2000).optional(),
    signature: z.string().max(2000).optional()
  });
  app.post('/v1/prediction/markets/:id/resolve', express.json(), async (req, res) => {
    try {
      const parse = ResolveSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;
      const auth = await verifyAgentAuth(req, d.resolver_did);
      const isAdmin = req.headers['x-admin-token'] === process.env.OPERATOR_ADMIN_TOKEN;
      if (!auth.valid && !isAdmin) return res.status(401).json({ error: 'unauthorized' });

      const mRow = await pool.query(
        `SELECT * FROM prediction_markets WHERE market_id=$1`, [req.params.id]
      ).catch(() => ({ rows: [] }));
      if (!mRow.rows[0]) return res.status(404).json({ error: 'market_not_found' });
      const m = mRow.rows[0];
      if (m.status === 'resolved') return res.status(409).json({ error: 'already_resolved' });
      // Only oracle_did or admin can resolve.
      if (!isAdmin && m.oracle_did && d.resolver_did !== m.oracle_did) {
        return res.status(403).json({ error: 'not_oracle' });
      }

      const resolutionId = genId('res');
      await pool.query(
        `INSERT INTO prediction_resolutions
           (resolution_id, market_id, resolver_did, value, evidence_uri, signature)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [resolutionId, req.params.id, d.resolver_did, d.value,
         d.evidence_uri || null, d.signature || null]
      );
      await pool.query(
        `UPDATE prediction_markets
         SET status='resolved', resolved_at=NOW(), resolution_value=$2
         WHERE market_id=$1`,
        [req.params.id, d.value]
      );
      await auditChain.append({
        event_type: 'prediction.market_resolved',
        market_id: req.params.id, resolver_did: d.resolver_did,
        value: d.value, timestamp: new Date().toISOString()
      });
      return res.json({ market_id: req.params.id, status: 'resolved', value: d.value });
    } catch (e) { return res.status(500).json({ error: 'resolve_failed', message: e.message }); }
  });

  // POST /v1/prediction/markets/:id/claim
  const ClaimSchema = z.object({ holder_did: z.string() });
  app.post('/v1/prediction/markets/:id/claim', express.json(), async (req, res) => {
    try {
      const parse = ClaimSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;
      const auth = await verifyAgentAuth(req, d.holder_did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const mRow = await pool.query(
        `SELECT * FROM prediction_markets WHERE market_id=$1`, [req.params.id]
      ).catch(() => ({ rows: [] }));
      if (!mRow.rows[0]) return res.status(404).json({ error: 'market_not_found' });
      const m = mRow.rows[0];
      if (m.status !== 'resolved') return res.status(409).json({ error: 'market_not_resolved' });

      const pos = await pool.query(
        `SELECT * FROM prediction_positions
         WHERE market_id=$1 AND holder_did=$2 AND option_id=$3 AND claimed=FALSE`,
        [req.params.id, d.holder_did, m.resolution_value]
      ).catch(() => ({ rows: [] }));
      if (!pos.rows[0]) return res.status(404).json({ error: 'no_winning_position' });

      const shares = BigInt(pos.rows[0].shares);
      // Each winning share is worth 1 USDC unit (in raw 6-dec base = 1_000_000)
      // We store payout as raw USDC.
      const payoutRaw = shares * 1_000_000n;
      await pool.query(
        `UPDATE prediction_positions SET claimed=TRUE WHERE position_id=$1`,
        [pos.rows[0].position_id]
      );
      await auditChain.append({
        event_type: 'prediction.payout_claimed',
        market_id: req.params.id, holder_did: d.holder_did,
        shares: shares.toString(), payout_usdc_raw: payoutRaw.toString(),
        timestamp: new Date().toISOString()
      });
      return res.json({
        market_id: req.params.id,
        winning_option: m.resolution_value,
        shares: shares.toString(),
        payout_usdc_raw: payoutRaw.toString()
      });
    } catch (e) { return res.status(500).json({ error: 'claim_failed', message: e.message }); }
  });
}

module.exports = {
  migrate,
  registerPredictionMarketsRoutes,
  computePricesBps,
  executeAMM,
  MARKET_KINDS,
  MARKET_STATUSES,
  ORDER_SIDES,
  ORDER_STATUSES,
  MAX_BPS,
  INITIAL_LIQUIDITY
};
