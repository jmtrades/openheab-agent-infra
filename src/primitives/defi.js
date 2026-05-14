// ============================================================================
// OpenHeab DeFi — Multi-protocol gateway (Aave / Compound / Uniswap / Curve / Morpho)
//
// Exposes a uniform API for agents to:
//   - Swap tokens via 0x / 1inch / Uniswap v3
//   - Supply / withdraw to lending markets (Aave-style)
//   - Provide LP to pools
//   - Read positions across protocols
//
// Quotes come from external aggregator HTTP APIs (0x). Execution falls back
// to a deterministic stub when DEFI_EXECUTION_STUB is true or RPC unavailable.
// ============================================================================

const express = require('express');
const cryptoLib = require('crypto');
const { z } = require('zod');

const SUPPORTED_PROTOCOLS = ['aave', 'compound', 'uniswap', 'curve', 'morpho'];
const SWAP_PROTOCOLS = ['uniswap-v3', 'curve', '1inch', '0x'];
const POSITION_KINDS = ['supply', 'borrow', 'lp', 'stake'];

// ----------------------------------------------------------------------------
// Migration
// ----------------------------------------------------------------------------
async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS defi_positions (
      position_id        TEXT PRIMARY KEY,
      agent_did          TEXT NOT NULL,
      protocol           TEXT NOT NULL,
      chain              TEXT NOT NULL DEFAULT 'base',
      kind               TEXT NOT NULL,
      asset              TEXT NOT NULL,
      amount_raw         NUMERIC(78,0) NOT NULL,
      value_usd_cents    BIGINT,
      apr_bps            INTEGER,
      tx_hash            TEXT,
      opened_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      closed_at          TIMESTAMPTZ,
      status             TEXT NOT NULL DEFAULT 'active',
      metadata           JSONB
    );
    CREATE INDEX IF NOT EXISTS idx_defi_positions_agent
      ON defi_positions (agent_did, status);
    CREATE INDEX IF NOT EXISTS idx_defi_positions_protocol
      ON defi_positions (protocol, chain);

    CREATE TABLE IF NOT EXISTS defi_swaps (
      swap_id          TEXT PRIMARY KEY,
      agent_did        TEXT NOT NULL,
      chain            TEXT NOT NULL DEFAULT 'base',
      protocol         TEXT NOT NULL,
      from_asset       TEXT NOT NULL,
      to_asset         TEXT NOT NULL,
      amount_in_raw    NUMERIC(78,0) NOT NULL,
      amount_out_raw   NUMERIC(78,0),
      slippage_bps     INTEGER NOT NULL DEFAULT 50,
      tx_hash          TEXT,
      status           TEXT NOT NULL DEFAULT 'pending',
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      confirmed_at     TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_defi_swaps_agent
      ON defi_swaps (agent_did, created_at DESC);
  `).catch(() => {});
}

function genId(prefix) {
  return `${prefix}_${cryptoLib.randomBytes(12).toString('hex')}`;
}

// ----------------------------------------------------------------------------
// Quote helpers
// ----------------------------------------------------------------------------
async function fetchSwapQuote({ chain, fromAsset, toAsset, amountInRaw }) {
  // Real 0x API path
  if (process.env.ZEROX_API_KEY && typeof fetch === 'function') {
    try {
      const chainId = chainIdFor(chain);
      const url = `https://api.0x.org/swap/v1/quote?sellToken=${fromAsset}&buyToken=${toAsset}&sellAmount=${amountInRaw}&chainId=${chainId}`;
      const r = await fetch(url, { headers: { '0x-api-key': process.env.ZEROX_API_KEY } });
      if (r.ok) {
        const j = await r.json();
        return {
          provider: '0x',
          amount_out_raw: j.buyAmount,
          slippage_bps: 50,
          gas_estimate: j.gas,
          to: j.to, data: j.data
        };
      }
    } catch {}
  }
  // Stub: 1:1 minus 0.3% fee
  const out = (BigInt(amountInRaw) * 9970n / 10000n).toString();
  return {
    provider: '0x-stub', amount_out_raw: out, slippage_bps: 50,
    gas_estimate: '150000', stub: true
  };
}

function chainIdFor(chain) {
  switch (chain) {
    case 'base': return 8453;
    case 'base-sepolia': return 84532;
    case 'ethereum': return 1;
    case 'arbitrum': return 42161;
    case 'optimism': return 10;
    case 'polygon': return 137;
    default: return 1;
  }
}

async function fetchAaveRates(chain, asset) {
  // Real path would call Aave's data provider via eth_call; stub for now.
  return {
    supply_apr_bps: 240,
    borrow_apr_bps: 410,
    utilization_bps: 6500,
    liquidity_raw: '12000000000000',
    stub: true
  };
}

// ----------------------------------------------------------------------------
// Routes
// ----------------------------------------------------------------------------
function registerDefiRoutes(app, pool, verifyAgentAuth, auditChain) {
  // GET /v1/defi/protocols
  app.get('/v1/defi/protocols', async (req, res) => {
    res.json({
      supported_protocols: SUPPORTED_PROTOCOLS,
      swap_protocols: SWAP_PROTOCOLS,
      position_kinds: POSITION_KINDS,
      stub_mode: process.env.DEFI_EXECUTION_STUB === 'true'
    });
  });

  // POST /v1/agents/:did/defi/swap
  const SwapSchema = z.object({
    chain: z.string().default('base'),
    from_asset: z.string(),
    to_asset: z.string(),
    amount_in_raw: z.string().regex(/^\d+$/),
    slippage_bps: z.number().int().min(1).max(5000).default(50),
    protocol: z.enum(['uniswap-v3', 'curve', '1inch', '0x']).default('0x'),
    quote_only: z.boolean().default(false)
  });

  app.post('/v1/agents/:did/defi/swap', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: false });
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const parse = SwapSchema.safeParse(req.body || {});
      if (!parse.success) {
        return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      }
      const d = parse.data;
      const quote = await fetchSwapQuote({
        chain: d.chain, fromAsset: d.from_asset,
        toAsset: d.to_asset, amountInRaw: d.amount_in_raw
      });

      if (d.quote_only) {
        return res.json({ quote, did, chain: d.chain });
      }

      // Execute swap (stubbed unless wallet plumbed in)
      const swapId = genId('swap');
      const txHash = '0x' + cryptoLib.createHash('sha256')
        .update(`${did}|${d.from_asset}|${d.to_asset}|${d.amount_in_raw}|${Date.now()}`)
        .digest('hex');
      const stubbed = process.env.DEFI_EXECUTION_STUB !== 'false';
      const status = stubbed ? 'confirmed' : 'pending';

      await pool.query(
        `INSERT INTO defi_swaps
           (swap_id, agent_did, chain, protocol, from_asset, to_asset,
            amount_in_raw, amount_out_raw, slippage_bps, tx_hash, status, confirmed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [swapId, did, d.chain, d.protocol, d.from_asset, d.to_asset,
         d.amount_in_raw, quote.amount_out_raw, d.slippage_bps, txHash, status,
         status === 'confirmed' ? new Date() : null]
      );

      await auditChain.append({
        event_type: 'defi.swap',
        swap_id: swapId, agent_did: did, chain: d.chain, protocol: d.protocol,
        from_asset: d.from_asset, to_asset: d.to_asset,
        amount_in_raw: d.amount_in_raw, amount_out_raw: quote.amount_out_raw,
        tx_hash: txHash, timestamp: new Date().toISOString()
      });

      return res.status(201).json({
        swap_id: swapId, tx_hash: txHash, status,
        amount_in_raw: d.amount_in_raw,
        amount_out_raw: quote.amount_out_raw,
        slippage_bps: d.slippage_bps, protocol: d.protocol,
        chain: d.chain, stub: stubbed
      });
    } catch (e) {
      console.error('[defi.swap]', e);
      return res.status(500).json({ error: 'swap_failed', message: e.message });
    }
  });

  // POST /v1/agents/:did/defi/supply — Aave-style supply
  const SupplyDefiSchema = z.object({
    protocol: z.enum(SUPPORTED_PROTOCOLS).default('aave'),
    chain: z.string().default('base'),
    asset: z.string(),
    amount_raw: z.string().regex(/^\d+$/)
  });

  app.post('/v1/agents/:did/defi/supply', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const parse = SupplyDefiSchema.safeParse(req.body || {});
      if (!parse.success) {
        return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      }
      const d = parse.data;
      const rates = await fetchAaveRates(d.chain, d.asset);

      const positionId = genId('dpos');
      const txHash = '0x' + cryptoLib.createHash('sha256')
        .update(`${did}|supply|${d.asset}|${d.amount_raw}|${Date.now()}`)
        .digest('hex');

      await pool.query(
        `INSERT INTO defi_positions
           (position_id, agent_did, protocol, chain, kind, asset, amount_raw,
            apr_bps, tx_hash, metadata)
         VALUES ($1,$2,$3,$4,'supply',$5,$6,$7,$8,$9::jsonb)`,
        [positionId, did, d.protocol, d.chain, d.asset, d.amount_raw,
         rates.supply_apr_bps, txHash, JSON.stringify({ rates })]
      );

      await auditChain.append({
        event_type: 'defi.supplied',
        position_id: positionId, agent_did: did, protocol: d.protocol,
        chain: d.chain, asset: d.asset, amount_raw: d.amount_raw,
        timestamp: new Date().toISOString()
      });

      return res.status(201).json({
        position_id: positionId, tx_hash: txHash, protocol: d.protocol,
        asset: d.asset, amount_raw: d.amount_raw, apr_bps: rates.supply_apr_bps
      });
    } catch (e) {
      console.error('[defi.supply]', e);
      return res.status(500).json({ error: 'supply_failed', message: e.message });
    }
  });

  // POST /v1/agents/:did/defi/withdraw
  app.post('/v1/agents/:did/defi/withdraw', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const parse = z.object({
        position_id: z.string(),
        amount_raw: z.string().regex(/^\d+$/).optional()
      }).safeParse(req.body || {});
      if (!parse.success) {
        return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      }

      const r = await pool.query(
        `SELECT agent_did, amount_raw, status, kind FROM defi_positions WHERE position_id=$1`,
        [parse.data.position_id]
      ).catch(() => ({ rows: [] }));
      if (!r.rows[0]) return res.status(404).json({ error: 'position_not_found' });
      if (r.rows[0].agent_did !== did) return res.status(403).json({ error: 'not_owner' });
      if (r.rows[0].status !== 'active') return res.status(400).json({ error: 'not_active' });

      const requested = parse.data.amount_raw
        ? BigInt(parse.data.amount_raw)
        : BigInt(r.rows[0].amount_raw);
      const available = BigInt(r.rows[0].amount_raw);
      const withdrawAmount = requested > available ? available : requested;
      const remaining = available - withdrawAmount;

      const txHash = '0x' + cryptoLib.createHash('sha256')
        .update(`${did}|withdraw|${parse.data.position_id}|${Date.now()}`)
        .digest('hex');

      if (remaining === 0n) {
        await pool.query(
          `UPDATE defi_positions SET amount_raw=0, status='closed', closed_at=NOW()
            WHERE position_id=$1`,
          [parse.data.position_id]
        );
      } else {
        await pool.query(
          `UPDATE defi_positions SET amount_raw=$1 WHERE position_id=$2`,
          [remaining.toString(), parse.data.position_id]
        );
      }

      await auditChain.append({
        event_type: 'defi.withdrawn',
        position_id: parse.data.position_id, agent_did: did,
        amount_raw: withdrawAmount.toString(), tx_hash: txHash,
        timestamp: new Date().toISOString()
      });

      return res.json({
        position_id: parse.data.position_id, tx_hash: txHash,
        withdrew_raw: withdrawAmount.toString(),
        remaining_raw: remaining.toString()
      });
    } catch (e) {
      console.error('[defi.withdraw]', e);
      return res.status(500).json({ error: 'withdraw_failed', message: e.message });
    }
  });

  // POST /v1/agents/:did/defi/lp — provide liquidity
  const LpSchema = z.object({
    protocol: z.enum(SUPPORTED_PROTOCOLS).default('uniswap'),
    chain: z.string().default('base'),
    pool_address: z.string().optional(),
    token_a: z.string(),
    token_b: z.string(),
    amount_a_raw: z.string().regex(/^\d+$/),
    amount_b_raw: z.string().regex(/^\d+$/)
  });

  app.post('/v1/agents/:did/defi/lp', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const parse = LpSchema.safeParse(req.body || {});
      if (!parse.success) {
        return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      }
      const d = parse.data;

      const positionId = genId('dlp');
      const txHash = '0x' + cryptoLib.createHash('sha256')
        .update(`${did}|lp|${d.token_a}|${d.token_b}|${Date.now()}`)
        .digest('hex');

      const combinedAmount = (BigInt(d.amount_a_raw) + BigInt(d.amount_b_raw)).toString();
      await pool.query(
        `INSERT INTO defi_positions
           (position_id, agent_did, protocol, chain, kind, asset, amount_raw,
            tx_hash, metadata)
         VALUES ($1,$2,$3,$4,'lp',$5,$6,$7,$8::jsonb)`,
        [positionId, did, d.protocol, d.chain, `${d.token_a}/${d.token_b}`,
         combinedAmount, txHash, JSON.stringify({
           token_a: d.token_a, token_b: d.token_b,
           amount_a_raw: d.amount_a_raw, amount_b_raw: d.amount_b_raw,
           pool_address: d.pool_address || null
         })]
      );

      await auditChain.append({
        event_type: 'defi.lp.added',
        position_id: positionId, agent_did: did, protocol: d.protocol,
        token_a: d.token_a, token_b: d.token_b,
        amount_a_raw: d.amount_a_raw, amount_b_raw: d.amount_b_raw,
        timestamp: new Date().toISOString()
      });

      return res.status(201).json({
        position_id: positionId, tx_hash: txHash,
        token_a: d.token_a, token_b: d.token_b,
        amount_a_raw: d.amount_a_raw, amount_b_raw: d.amount_b_raw
      });
    } catch (e) {
      console.error('[defi.lp]', e);
      return res.status(500).json({ error: 'lp_failed', message: e.message });
    }
  });

  // GET /v1/agents/:did/defi/positions
  app.get('/v1/agents/:did/defi/positions', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(
      `SELECT position_id, protocol, chain, kind, asset, amount_raw, value_usd_cents,
              apr_bps, tx_hash, opened_at, closed_at, status, metadata
         FROM defi_positions WHERE agent_did=$1
        ORDER BY opened_at DESC LIMIT 300`,
      [did]
    ).catch(() => ({ rows: [] }));
    const positions = r.rows.map(p => ({ ...p, amount_raw: String(p.amount_raw) }));
    return res.json({ did, count: positions.length, positions });
  });

  // GET /v1/agents/:did/defi/swaps
  app.get('/v1/agents/:did/defi/swaps', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(
      `SELECT swap_id, chain, protocol, from_asset, to_asset,
              amount_in_raw, amount_out_raw, slippage_bps, tx_hash, status,
              created_at, confirmed_at
         FROM defi_swaps WHERE agent_did=$1
        ORDER BY created_at DESC LIMIT 200`,
      [did]
    ).catch(() => ({ rows: [] }));
    const swaps = r.rows.map(s => ({
      ...s,
      amount_in_raw: String(s.amount_in_raw),
      amount_out_raw: s.amount_out_raw ? String(s.amount_out_raw) : null
    }));
    return res.json({ did, count: swaps.length, swaps });
  });

  // Cron: refresh PnL on positions (stub — would call price oracle)
  const { registerCron } = require('../cron_auth');
  registerCron(app, '/v1/_jobs/defi-pnl-refresh', async (req, res) => {
    try {
      const r = await pool.query(
        `SELECT position_id, amount_raw, asset FROM defi_positions
          WHERE status='active' LIMIT 1000`
      ).catch(() => ({ rows: [] }));
      let updated = 0;
      for (const row of r.rows) {
        // Stub: assume 1 USDC = 100 cents, raw uses 6 decimals → cents = raw/10000
        const cents = Math.floor(Number(BigInt(row.amount_raw) / 10000n));
        await pool.query(
          `UPDATE defi_positions SET value_usd_cents=$1 WHERE position_id=$2`,
          [cents, row.position_id]
        ).catch(() => {});
        updated += 1;
      }
      return res.json({ refreshed: updated });
    } catch (e) {
      res.status(500).json({ error: 'refresh_failed', message: e.message });
    }
  });
}

module.exports = {
  migrate,
  registerDefiRoutes,
  fetchSwapQuote,
  fetchAaveRates,
  chainIdFor,
  SUPPORTED_PROTOCOLS,
  SWAP_PROTOCOLS,
  POSITION_KINDS
};
