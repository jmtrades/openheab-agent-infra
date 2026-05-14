// ============================================================================
// OpenHeab Lending — Agent-to-agent collateralized lending pools
//
// Pools accept supplied liquidity (e.g. USDC). Borrowers post collateral and
// draw against it, capped by ltv_max_bps. Interest accrues continuously on
// outstanding principal at borrow_apr_bps and on supplied principal at
// supply_apr_bps. Health factor = (collateral * LTV) / borrowed. Positions
// with health_factor < 1.0 are liquidatable.
// ============================================================================

const express = require('express');
const cryptoLib = require('crypto');
const { z } = require('zod');

const POSITION_STATUSES = ['active', 'closed', 'liquidated'];
const POOL_STATUSES = ['active', 'paused'];
const BPS = 10000n;
const SECONDS_PER_YEAR = 365n * 24n * 3600n;

// ----------------------------------------------------------------------------
// Migration
// ----------------------------------------------------------------------------
async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS lending_pools (
      pool_id              TEXT PRIMARY KEY,
      name                 TEXT NOT NULL,
      asset                TEXT NOT NULL DEFAULT 'USDC',
      chain                TEXT NOT NULL DEFAULT 'base',
      total_supplied_raw   NUMERIC(78,0) NOT NULL DEFAULT 0,
      total_borrowed_raw   NUMERIC(78,0) NOT NULL DEFAULT 0,
      supply_apr_bps       INTEGER NOT NULL DEFAULT 300,
      borrow_apr_bps       INTEGER NOT NULL DEFAULT 800,
      ltv_max_bps          INTEGER NOT NULL DEFAULT 7500,
      collateral_assets    TEXT[] NOT NULL DEFAULT ARRAY['USDC']::TEXT[],
      operator_did         TEXT,
      status               TEXT NOT NULL DEFAULT 'active',
      created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_lending_pools_asset ON lending_pools (asset, chain);

    CREATE TABLE IF NOT EXISTS lending_positions (
      position_id        TEXT PRIMARY KEY,
      pool_id            TEXT NOT NULL,
      agent_did          TEXT NOT NULL,
      supplied_raw       NUMERIC(78,0) NOT NULL DEFAULT 0,
      borrowed_raw       NUMERIC(78,0) NOT NULL DEFAULT 0,
      collateral_raw     NUMERIC(78,0) NOT NULL DEFAULT 0,
      collateral_asset   TEXT,
      health_factor      REAL,
      last_interest_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      opened_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      closed_at          TIMESTAMPTZ,
      status             TEXT NOT NULL DEFAULT 'active'
    );
    CREATE INDEX IF NOT EXISTS idx_lending_positions_pool
      ON lending_positions (pool_id, status);
    CREATE INDEX IF NOT EXISTS idx_lending_positions_agent
      ON lending_positions (agent_did, status);
    CREATE INDEX IF NOT EXISTS idx_lending_positions_health
      ON lending_positions (health_factor) WHERE status = 'active';

    CREATE TABLE IF NOT EXISTS lending_repayments (
      repayment_id   TEXT PRIMARY KEY,
      position_id    TEXT NOT NULL,
      agent_did      TEXT NOT NULL,
      amount_raw     NUMERIC(78,0) NOT NULL,
      interest_raw   NUMERIC(78,0) NOT NULL DEFAULT 0,
      principal_raw  NUMERIC(78,0) NOT NULL DEFAULT 0,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_lending_repayments_position
      ON lending_repayments (position_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS lending_liquidations (
      liquidation_id    TEXT PRIMARY KEY,
      position_id       TEXT NOT NULL,
      liquidator_did    TEXT,
      seized_raw        NUMERIC(78,0) NOT NULL,
      repaid_raw        NUMERIC(78,0) NOT NULL,
      health_at_liq     REAL,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_lending_liquidations_pos
      ON lending_liquidations (position_id, created_at DESC);
  `).catch(() => {});
}

function genId(prefix) {
  return `${prefix}_${cryptoLib.randomBytes(12).toString('hex')}`;
}

// ----------------------------------------------------------------------------
// Interest math (compound-via-step approximation as simple interest per call)
// ----------------------------------------------------------------------------
function accrueInterest(borrowedRaw, aprBps, secondsElapsed) {
  if (BigInt(borrowedRaw) === 0n || secondsElapsed <= 0n) return 0n;
  // interest = principal * apr * elapsed / (BPS * SECONDS_PER_YEAR)
  return (BigInt(borrowedRaw) * BigInt(aprBps) * secondsElapsed) / (BPS * SECONDS_PER_YEAR);
}

function computeHealthFactor(collateralRaw, ltvBps, borrowedRaw) {
  if (BigInt(borrowedRaw) === 0n) return 999.0; // infinite-ish
  // (collateral * ltv) / (borrowed * BPS)
  const numerator = BigInt(collateralRaw) * BigInt(ltvBps);
  const denom = BigInt(borrowedRaw) * BPS;
  // Scale to 6dp float
  const scaled = (numerator * 1000000n) / denom;
  return Number(scaled) / 1000000;
}

async function refreshPosition(pool, positionId) {
  const r = await pool.query(
    `SELECT p.*, pl.borrow_apr_bps, pl.ltv_max_bps
       FROM lending_positions p
       JOIN lending_pools pl ON pl.pool_id = p.pool_id
      WHERE p.position_id = $1`,
    [positionId]
  ).catch(() => ({ rows: [] }));
  if (!r.rows[0]) return null;
  const pos = r.rows[0];
  if (pos.status !== 'active') return pos;

  const now = new Date();
  const elapsed = BigInt(Math.floor(
    (now.getTime() - new Date(pos.last_interest_at).getTime()) / 1000
  ));
  const interest = accrueInterest(pos.borrowed_raw, pos.borrow_apr_bps, elapsed);
  const newBorrowed = (BigInt(pos.borrowed_raw) + interest).toString();
  const healthFactor = computeHealthFactor(pos.collateral_raw, pos.ltv_max_bps, newBorrowed);

  await pool.query(
    `UPDATE lending_positions
        SET borrowed_raw=$1, health_factor=$2, last_interest_at=NOW()
      WHERE position_id=$3`,
    [newBorrowed, healthFactor, positionId]
  ).catch(() => {});

  if (interest > 0n) {
    await pool.query(
      `UPDATE lending_pools
          SET total_borrowed_raw = total_borrowed_raw + $1
        WHERE pool_id=$2`,
      [interest.toString(), pos.pool_id]
    ).catch(() => {});
  }

  return { ...pos, borrowed_raw: newBorrowed, health_factor: healthFactor };
}

// ----------------------------------------------------------------------------
// Routes
// ----------------------------------------------------------------------------
function registerLendingRoutes(app, pool, verifyAgentAuth, auditChain) {
  // POST /v1/lending/pools — admin/operator
  const CreatePoolSchema = z.object({
    operator_did: z.string(),
    name: z.string().min(1).max(200),
    asset: z.string().default('USDC'),
    chain: z.string().default('base'),
    supply_apr_bps: z.number().int().min(0).max(50000).default(300),
    borrow_apr_bps: z.number().int().min(0).max(50000).default(800),
    ltv_max_bps: z.number().int().min(1).max(9500).default(7500),
    collateral_assets: z.array(z.string()).default(['USDC'])
  });

  app.post('/v1/lending/pools', express.json(), async (req, res) => {
    try {
      const parse = CreatePoolSchema.safeParse(req.body || {});
      if (!parse.success) {
        return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      }
      const d = parse.data;
      const auth = await verifyAgentAuth(req, d.operator_did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const poolId = genId('lp');
      await pool.query(
        `INSERT INTO lending_pools
           (pool_id, name, asset, chain, supply_apr_bps, borrow_apr_bps,
            ltv_max_bps, collateral_assets, operator_did)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [poolId, d.name, d.asset, d.chain, d.supply_apr_bps, d.borrow_apr_bps,
         d.ltv_max_bps, d.collateral_assets, d.operator_did]
      );

      await auditChain.append({
        event_type: 'lending.pool.created', pool_id: poolId, operator_did: d.operator_did,
        asset: d.asset, chain: d.chain, timestamp: new Date().toISOString()
      });

      return res.status(201).json({ pool_id: poolId, ...d });
    } catch (e) {
      console.error('[lending.pool.create]', e);
      return res.status(500).json({ error: 'create_failed', message: e.message });
    }
  });

  // GET /v1/lending/pools
  app.get('/v1/lending/pools', async (req, res) => {
    const r = await pool.query(
      `SELECT pool_id, name, asset, chain, total_supplied_raw, total_borrowed_raw,
              supply_apr_bps, borrow_apr_bps, ltv_max_bps, collateral_assets,
              operator_did, status, created_at
         FROM lending_pools
         WHERE status = 'active'
         ORDER BY created_at DESC LIMIT 200`
    ).catch(() => ({ rows: [] }));
    const pools = r.rows.map(p => ({
      ...p,
      total_supplied_raw: String(p.total_supplied_raw),
      total_borrowed_raw: String(p.total_borrowed_raw)
    }));
    return res.json({ count: pools.length, pools });
  });

  // POST /v1/lending/pools/:id/supply
  const SupplySchema = z.object({
    agent_did: z.string(),
    amount_raw: z.string().regex(/^\d+$/)
  });

  app.post('/v1/lending/pools/:id/supply', express.json(), async (req, res) => {
    try {
      const parse = SupplySchema.safeParse(req.body || {});
      if (!parse.success) {
        return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      }
      const { agent_did, amount_raw } = parse.data;
      const auth = await verifyAgentAuth(req, agent_did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const pl = await pool.query(
        `SELECT pool_id, status FROM lending_pools WHERE pool_id=$1`, [req.params.id]
      ).catch(() => ({ rows: [] }));
      if (!pl.rows[0]) return res.status(404).json({ error: 'pool_not_found' });
      if (pl.rows[0].status !== 'active') return res.status(400).json({ error: 'pool_paused' });

      // Get-or-create position
      let posId;
      const existing = await pool.query(
        `SELECT position_id FROM lending_positions
          WHERE pool_id=$1 AND agent_did=$2 AND status='active'`,
        [req.params.id, agent_did]
      ).catch(() => ({ rows: [] }));
      if (existing.rows[0]) {
        posId = existing.rows[0].position_id;
        await pool.query(
          `UPDATE lending_positions SET supplied_raw = supplied_raw + $1
            WHERE position_id=$2`,
          [amount_raw, posId]
        );
      } else {
        posId = genId('lpos');
        await pool.query(
          `INSERT INTO lending_positions
             (position_id, pool_id, agent_did, supplied_raw, health_factor)
           VALUES ($1,$2,$3,$4,999.0)`,
          [posId, req.params.id, agent_did, amount_raw]
        );
      }
      await pool.query(
        `UPDATE lending_pools SET total_supplied_raw = total_supplied_raw + $1
          WHERE pool_id=$2`,
        [amount_raw, req.params.id]
      );

      await auditChain.append({
        event_type: 'lending.supplied',
        pool_id: req.params.id, position_id: posId, agent_did,
        amount_raw, timestamp: new Date().toISOString()
      });

      return res.status(201).json({ position_id: posId, supplied_raw: amount_raw });
    } catch (e) {
      console.error('[lending.supply]', e);
      return res.status(500).json({ error: 'supply_failed', message: e.message });
    }
  });

  // POST /v1/lending/pools/:id/withdraw
  app.post('/v1/lending/pools/:id/withdraw', express.json(), async (req, res) => {
    try {
      const parse = SupplySchema.safeParse(req.body || {});
      if (!parse.success) {
        return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      }
      const { agent_did, amount_raw } = parse.data;
      const auth = await verifyAgentAuth(req, agent_did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const r = await pool.query(
        `SELECT position_id, supplied_raw FROM lending_positions
          WHERE pool_id=$1 AND agent_did=$2 AND status='active'`,
        [req.params.id, agent_did]
      ).catch(() => ({ rows: [] }));
      if (!r.rows[0]) return res.status(404).json({ error: 'position_not_found' });
      if (BigInt(r.rows[0].supplied_raw) < BigInt(amount_raw)) {
        return res.status(400).json({ error: 'insufficient_supplied' });
      }

      await pool.query(
        `UPDATE lending_positions SET supplied_raw = supplied_raw - $1
          WHERE position_id=$2`,
        [amount_raw, r.rows[0].position_id]
      );
      await pool.query(
        `UPDATE lending_pools SET total_supplied_raw = total_supplied_raw - $1
          WHERE pool_id=$2`,
        [amount_raw, req.params.id]
      );

      await auditChain.append({
        event_type: 'lending.withdrawn',
        pool_id: req.params.id, position_id: r.rows[0].position_id,
        agent_did, amount_raw, timestamp: new Date().toISOString()
      });

      return res.json({ position_id: r.rows[0].position_id, withdrew_raw: amount_raw });
    } catch (e) {
      console.error('[lending.withdraw]', e);
      return res.status(500).json({ error: 'withdraw_failed', message: e.message });
    }
  });

  // POST /v1/lending/pools/:id/borrow
  const BorrowSchema = z.object({
    agent_did: z.string(),
    amount_raw: z.string().regex(/^\d+$/),
    collateral_raw: z.string().regex(/^\d+$/),
    collateral_asset: z.string().default('USDC')
  });

  app.post('/v1/lending/pools/:id/borrow', express.json(), async (req, res) => {
    try {
      const parse = BorrowSchema.safeParse(req.body || {});
      if (!parse.success) {
        return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      }
      const d = parse.data;
      const auth = await verifyAgentAuth(req, d.agent_did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const pl = await pool.query(
        `SELECT ltv_max_bps, collateral_assets, status FROM lending_pools WHERE pool_id=$1`,
        [req.params.id]
      ).catch(() => ({ rows: [] }));
      if (!pl.rows[0]) return res.status(404).json({ error: 'pool_not_found' });
      if (pl.rows[0].status !== 'active') return res.status(400).json({ error: 'pool_paused' });
      if (!pl.rows[0].collateral_assets.includes(d.collateral_asset)) {
        return res.status(400).json({ error: 'collateral_not_accepted' });
      }

      // Verify health factor with proposed values
      const newHealth = computeHealthFactor(d.collateral_raw, pl.rows[0].ltv_max_bps, d.amount_raw);
      if (newHealth < 1.0) {
        return res.status(400).json({
          error: 'unhealthy_borrow', health_factor: newHealth,
          message: 'insufficient_collateral'
        });
      }

      // Get-or-create position
      let posId;
      const existing = await pool.query(
        `SELECT position_id, borrowed_raw, collateral_raw FROM lending_positions
          WHERE pool_id=$1 AND agent_did=$2 AND status='active'`,
        [req.params.id, d.agent_did]
      ).catch(() => ({ rows: [] }));

      if (existing.rows[0]) {
        // Re-check health with combined positions
        const combinedBorrow = (BigInt(existing.rows[0].borrowed_raw) + BigInt(d.amount_raw)).toString();
        const combinedCollat = (BigInt(existing.rows[0].collateral_raw) + BigInt(d.collateral_raw)).toString();
        const h = computeHealthFactor(combinedCollat, pl.rows[0].ltv_max_bps, combinedBorrow);
        if (h < 1.0) return res.status(400).json({ error: 'unhealthy_combined', health_factor: h });
        posId = existing.rows[0].position_id;
        await pool.query(
          `UPDATE lending_positions
              SET borrowed_raw = borrowed_raw + $1,
                  collateral_raw = collateral_raw + $2,
                  collateral_asset = COALESCE(collateral_asset, $3),
                  health_factor = $4,
                  last_interest_at = NOW()
            WHERE position_id=$5`,
          [d.amount_raw, d.collateral_raw, d.collateral_asset, h, posId]
        );
      } else {
        posId = genId('lpos');
        await pool.query(
          `INSERT INTO lending_positions
             (position_id, pool_id, agent_did, borrowed_raw, collateral_raw,
              collateral_asset, health_factor, last_interest_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())`,
          [posId, req.params.id, d.agent_did, d.amount_raw, d.collateral_raw,
           d.collateral_asset, newHealth]
        );
      }

      await pool.query(
        `UPDATE lending_pools SET total_borrowed_raw = total_borrowed_raw + $1
          WHERE pool_id=$2`,
        [d.amount_raw, req.params.id]
      );

      await auditChain.append({
        event_type: 'lending.borrowed',
        pool_id: req.params.id, position_id: posId, agent_did: d.agent_did,
        amount_raw: d.amount_raw, collateral_raw: d.collateral_raw,
        health_factor: newHealth, timestamp: new Date().toISOString()
      });

      return res.status(201).json({
        position_id: posId, borrowed_raw: d.amount_raw,
        collateral_raw: d.collateral_raw, health_factor: newHealth
      });
    } catch (e) {
      console.error('[lending.borrow]', e);
      return res.status(500).json({ error: 'borrow_failed', message: e.message });
    }
  });

  // POST /v1/lending/positions/:id/repay
  app.post('/v1/lending/positions/:id/repay', express.json(), async (req, res) => {
    try {
      const parse = z.object({
        agent_did: z.string(),
        amount_raw: z.string().regex(/^\d+$/)
      }).safeParse(req.body || {});
      if (!parse.success) {
        return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      }
      const { agent_did, amount_raw } = parse.data;
      const auth = await verifyAgentAuth(req, agent_did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      await refreshPosition(pool, req.params.id);

      const r = await pool.query(
        `SELECT agent_did, borrowed_raw, pool_id, collateral_raw
           FROM lending_positions WHERE position_id=$1 AND status='active'`,
        [req.params.id]
      ).catch(() => ({ rows: [] }));
      if (!r.rows[0]) return res.status(404).json({ error: 'position_not_found' });
      if (r.rows[0].agent_did !== agent_did) return res.status(403).json({ error: 'not_owner' });

      const borrowed = BigInt(r.rows[0].borrowed_raw);
      const repay = BigInt(amount_raw) > borrowed ? borrowed : BigInt(amount_raw);
      const newBorrowed = (borrowed - repay).toString();

      await pool.query(
        `UPDATE lending_positions SET borrowed_raw=$1 WHERE position_id=$2`,
        [newBorrowed, req.params.id]
      );
      await pool.query(
        `UPDATE lending_pools SET total_borrowed_raw = total_borrowed_raw - $1
          WHERE pool_id=$2`,
        [repay.toString(), r.rows[0].pool_id]
      );

      const repayId = genId('lrep');
      await pool.query(
        `INSERT INTO lending_repayments (repayment_id, position_id, agent_did, amount_raw)
         VALUES ($1,$2,$3,$4)`,
        [repayId, req.params.id, agent_did, repay.toString()]
      );

      if (BigInt(newBorrowed) === 0n) {
        await pool.query(
          `UPDATE lending_positions SET status='closed', closed_at=NOW()
            WHERE position_id=$1 AND supplied_raw=0`,
          [req.params.id]
        );
      }

      await auditChain.append({
        event_type: 'lending.repaid', position_id: req.params.id,
        agent_did, amount_raw: repay.toString(),
        remaining_borrowed: newBorrowed, timestamp: new Date().toISOString()
      });

      return res.json({
        repayment_id: repayId, repaid_raw: repay.toString(),
        remaining_borrowed_raw: newBorrowed
      });
    } catch (e) {
      console.error('[lending.repay]', e);
      return res.status(500).json({ error: 'repay_failed', message: e.message });
    }
  });

  // POST /v1/lending/positions/:id/liquidate
  app.post('/v1/lending/positions/:id/liquidate', express.json(), async (req, res) => {
    try {
      const liquidatorDid = (req.body && req.body.liquidator_did) || null;
      if (!liquidatorDid) return res.status(400).json({ error: 'liquidator_did_required' });
      const auth = await verifyAgentAuth(req, liquidatorDid);
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      await refreshPosition(pool, req.params.id);

      const r = await pool.query(
        `SELECT * FROM lending_positions WHERE position_id=$1 AND status='active'`,
        [req.params.id]
      ).catch(() => ({ rows: [] }));
      if (!r.rows[0]) return res.status(404).json({ error: 'position_not_found' });
      const pos = r.rows[0];
      if (pos.health_factor >= 1.0) {
        return res.status(400).json({ error: 'position_healthy', health_factor: pos.health_factor });
      }

      const seizedRaw = String(pos.collateral_raw);
      const repaidRaw = String(pos.borrowed_raw);

      await pool.query(
        `UPDATE lending_positions
            SET status='liquidated', closed_at=NOW(),
                collateral_raw=0, borrowed_raw=0
          WHERE position_id=$1`,
        [req.params.id]
      );

      await pool.query(
        `UPDATE lending_pools SET total_borrowed_raw = total_borrowed_raw - $1
          WHERE pool_id=$2`,
        [repaidRaw, pos.pool_id]
      );

      const liqId = genId('lliq');
      await pool.query(
        `INSERT INTO lending_liquidations
           (liquidation_id, position_id, liquidator_did, seized_raw, repaid_raw, health_at_liq)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [liqId, req.params.id, liquidatorDid, seizedRaw, repaidRaw, pos.health_factor]
      );

      await auditChain.append({
        event_type: 'lending.liquidated', position_id: req.params.id,
        liquidator_did: liquidatorDid, seized_raw: seizedRaw, repaid_raw: repaidRaw,
        health_factor: pos.health_factor, timestamp: new Date().toISOString()
      });

      return res.json({
        liquidation_id: liqId, seized_raw: seizedRaw, repaid_raw: repaidRaw,
        health_factor: pos.health_factor
      });
    } catch (e) {
      console.error('[lending.liquidate]', e);
      return res.status(500).json({ error: 'liquidate_failed', message: e.message });
    }
  });

  // GET /v1/agents/:did/lending/positions
  app.get('/v1/agents/:did/lending/positions', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(
      `SELECT position_id, pool_id, supplied_raw, borrowed_raw, collateral_raw,
              collateral_asset, health_factor, status, opened_at, closed_at
         FROM lending_positions WHERE agent_did=$1
        ORDER BY opened_at DESC LIMIT 200`,
      [did]
    ).catch(() => ({ rows: [] }));
    const positions = r.rows.map(p => ({
      ...p,
      supplied_raw: String(p.supplied_raw),
      borrowed_raw: String(p.borrowed_raw),
      collateral_raw: String(p.collateral_raw)
    }));
    return res.json({ did, count: positions.length, positions });
  });

  // Cron: liquidation sweep
  const { registerCron } = require('../cron_auth');
  registerCron(app, '/v1/_jobs/lending-liquidations', async (req, res) => {
    try {
      // Refresh interest on all active positions, then collect unhealthy ones.
      const all = await pool.query(
        `SELECT position_id FROM lending_positions WHERE status='active' AND borrowed_raw > 0`
      ).catch(() => ({ rows: [] }));
      let unhealthy = 0;
      const ids = [];
      for (const row of all.rows) {
        const r = await refreshPosition(pool, row.position_id);
        if (r && r.health_factor < 1.0) {
          unhealthy += 1;
          ids.push(row.position_id);
        }
      }
      return res.json({ refreshed: all.rows.length, unhealthy, unhealthy_position_ids: ids.slice(0, 100) });
    } catch (e) {
      res.status(500).json({ error: 'sweep_failed', message: e.message });
    }
  });
}

module.exports = {
  migrate,
  registerLendingRoutes,
  computeHealthFactor,
  accrueInterest,
  refreshPosition,
  POSITION_STATUSES,
  POOL_STATUSES
};
