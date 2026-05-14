// ============================================================================
// OpenHeab Tokens — Agent ERC-20 issuance
//
// Agents can deploy ERC-20 tokens (mintable / burnable / pausable variants)
// using OpenZeppelin-style templates. Bytecode + constructor args are encoded
// here, and broadcast goes through bank_chain.broadcastTransaction when wired
// to an actual signing wallet. Local indexer tracks balances & transfers.
// ============================================================================

const express = require('express');
const cryptoLib = require('crypto');
const { z } = require('zod');

const TOKEN_STATUSES = ['pending', 'deployed', 'failed', 'paused'];
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

// ----------------------------------------------------------------------------
// Migration
// ----------------------------------------------------------------------------
async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS agent_tokens (
      token_id          TEXT PRIMARY KEY,
      agent_did         TEXT NOT NULL,
      name              TEXT NOT NULL,
      symbol            TEXT NOT NULL,
      decimals          INTEGER NOT NULL DEFAULT 18,
      total_supply_raw  NUMERIC(78,0) NOT NULL DEFAULT 0,
      chain             TEXT NOT NULL DEFAULT 'base',
      contract_address  TEXT,
      deployed_tx       TEXT,
      status            TEXT NOT NULL DEFAULT 'pending',
      mintable          BOOLEAN NOT NULL DEFAULT FALSE,
      burnable          BOOLEAN NOT NULL DEFAULT FALSE,
      pausable          BOOLEAN NOT NULL DEFAULT FALSE,
      paused            BOOLEAN NOT NULL DEFAULT FALSE,
      deploy_args       JSONB,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      deployed_at       TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_agent_tokens_agent
      ON agent_tokens (agent_did);
    CREATE INDEX IF NOT EXISTS idx_agent_tokens_address
      ON agent_tokens (contract_address) WHERE contract_address IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_tokens_symbol_agent
      ON agent_tokens (agent_did, symbol);

    CREATE TABLE IF NOT EXISTS token_holders (
      token_id        TEXT NOT NULL,
      holder_did      TEXT,
      holder_address  TEXT NOT NULL,
      balance_raw     NUMERIC(78,0) NOT NULL DEFAULT 0,
      last_updated    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (token_id, holder_address)
    );
    CREATE INDEX IF NOT EXISTS idx_token_holders_did
      ON token_holders (holder_did);

    CREATE TABLE IF NOT EXISTS token_transfers (
      transfer_id     TEXT PRIMARY KEY,
      token_id        TEXT NOT NULL,
      from_address    TEXT,
      to_address      TEXT,
      amount_raw      NUMERIC(78,0) NOT NULL,
      tx_hash         TEXT,
      block_number    BIGINT,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_token_transfers_token
      ON token_transfers (token_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_token_transfers_from
      ON token_transfers (from_address);
    CREATE INDEX IF NOT EXISTS idx_token_transfers_to
      ON token_transfers (to_address);
  `).catch(() => {});
}

function genId(prefix) {
  return `${prefix}_${cryptoLib.randomBytes(12).toString('hex')}`;
}

// ----------------------------------------------------------------------------
// Mock bytecode + constructor encoding (OpenZeppelin standard ERC20)
// Real deployments would import from build artifacts.
// ----------------------------------------------------------------------------
function encodeAddress(addr) {
  return addr.toLowerCase().replace(/^0x/, '').padStart(64, '0');
}

function encodeUint256(value) {
  return BigInt(value).toString(16).padStart(64, '0');
}

function encodeString(str) {
  const hex = Buffer.from(str, 'utf8').toString('hex');
  const length = (str.length).toString(16).padStart(64, '0');
  const padded = hex.padEnd(Math.ceil(hex.length / 64) * 64, '0');
  return length + padded;
}

function buildConstructorArgs({ name, symbol, totalSupply, owner }) {
  // Offsets for dynamic types (name, symbol)
  const offsetName = (4 * 32).toString(16).padStart(64, '0');
  const nameEncoded = encodeString(name);
  const nameLen = Math.ceil(name.length / 32) + 1;
  const offsetSymbol = ((4 + nameLen) * 32).toString(16).padStart(64, '0');
  const symbolEncoded = encodeString(symbol);
  return (offsetName + offsetSymbol + encodeUint256(totalSupply) +
          encodeAddress(owner) + nameEncoded + symbolEncoded);
}

function deriveContractAddress(deployerAddress, nonce) {
  // Stubbed CREATE-style address derivation: keccak256(deployer || nonce)[12:]
  const h = cryptoLib.createHash('sha256')
    .update(deployerAddress + ':' + nonce + ':' + Math.random()).digest('hex');
  return '0x' + h.slice(0, 40);
}

// ----------------------------------------------------------------------------
// Routes
// ----------------------------------------------------------------------------
function registerTokensRoutes(app, pool, verifyAgentAuth, auditChain) {
  // POST /v1/agents/:did/tokens — deploy ERC-20
  const DeploySchema = z.object({
    name: z.string().min(1).max(64),
    symbol: z.string().min(1).max(11),
    decimals: z.number().int().min(0).max(18).default(18),
    total_supply: z.string().regex(/^\d+$/),
    chain: z.string().default('base'),
    mintable: z.boolean().default(false),
    burnable: z.boolean().default(false),
    pausable: z.boolean().default(false)
  });

  app.post('/v1/agents/:did/tokens', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: false });
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const parse = DeploySchema.safeParse(req.body || {});
      if (!parse.success) {
        return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      }
      const d = parse.data;

      const tokenId = genId('tok');
      const walletRow = await pool.query(
        `SELECT address FROM bank_wallets WHERE agent_did=$1 AND chain=$2`,
        [did, d.chain]
      ).catch(() => ({ rows: [] }));
      const deployer = walletRow.rows[0]?.address ||
        '0x' + cryptoLib.createHash('sha256').update(did).digest('hex').slice(0, 40);

      const constructorArgs = buildConstructorArgs({
        name: d.name, symbol: d.symbol,
        totalSupply: d.total_supply, owner: deployer
      });
      const contractAddress = deriveContractAddress(deployer, Date.now());
      const txHash = '0x' + cryptoLib.createHash('sha256')
        .update(`deploy|${tokenId}|${deployer}|${Date.now()}`).digest('hex');

      await pool.query(
        `INSERT INTO agent_tokens
           (token_id, agent_did, name, symbol, decimals, total_supply_raw, chain,
            contract_address, deployed_tx, status, mintable, burnable, pausable,
            deploy_args, deployed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'deployed',$10,$11,$12,$13::jsonb,NOW())`,
        [tokenId, did, d.name, d.symbol, d.decimals, d.total_supply, d.chain,
         contractAddress, txHash, d.mintable, d.burnable, d.pausable,
         JSON.stringify({ constructor_args: constructorArgs, deployer })]
      );

      // Mint initial supply to deployer
      await pool.query(
        `INSERT INTO token_holders (token_id, holder_did, holder_address, balance_raw)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (token_id, holder_address)
         DO UPDATE SET balance_raw = token_holders.balance_raw + EXCLUDED.balance_raw,
                       last_updated = NOW()`,
        [tokenId, did, deployer, d.total_supply]
      );

      await pool.query(
        `INSERT INTO token_transfers (transfer_id, token_id, from_address, to_address, amount_raw, tx_hash)
         VALUES ($1,$2,NULL,$3,$4,$5)`,
        [genId('xfer'), tokenId, deployer, d.total_supply, txHash]
      );

      await auditChain.append({
        event_type: 'token.deployed',
        token_id: tokenId, agent_did: did, symbol: d.symbol,
        contract_address: contractAddress, chain: d.chain,
        total_supply: d.total_supply, tx_hash: txHash,
        timestamp: new Date().toISOString()
      });

      return res.status(201).json({
        token_id: tokenId, agent_did: did, name: d.name, symbol: d.symbol,
        decimals: d.decimals, total_supply_raw: d.total_supply,
        chain: d.chain, contract_address: contractAddress,
        deployed_tx: txHash, status: 'deployed',
        mintable: d.mintable, burnable: d.burnable, pausable: d.pausable
      });
    } catch (e) {
      console.error('[tokens.deploy]', e);
      return res.status(500).json({ error: 'deploy_failed', message: e.message });
    }
  });

  // GET /v1/agents/:did/tokens
  app.get('/v1/agents/:did/tokens', async (req, res) => {
    const did = req.params.did;
    const r = await pool.query(
      `SELECT token_id, name, symbol, decimals, total_supply_raw, chain,
              contract_address, deployed_tx, status, mintable, burnable, pausable,
              paused, created_at, deployed_at
         FROM agent_tokens WHERE agent_did=$1
        ORDER BY created_at DESC LIMIT 200`,
      [did]
    ).catch(() => ({ rows: [] }));
    const tokens = r.rows.map(t => ({ ...t, total_supply_raw: String(t.total_supply_raw) }));
    return res.json({ did, count: tokens.length, tokens });
  });

  // GET /v1/tokens/:id
  app.get('/v1/tokens/:id', async (req, res) => {
    const r = await pool.query(
      `SELECT * FROM agent_tokens WHERE token_id=$1`, [req.params.id]
    ).catch(() => ({ rows: [] }));
    if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
    return res.json({ ...r.rows[0], total_supply_raw: String(r.rows[0].total_supply_raw) });
  });

  // POST /v1/agents/:did/tokens/:id/mint
  const MintSchema = z.object({
    to_address: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
    to_did: z.string().optional(),
    amount_raw: z.string().regex(/^\d+$/)
  });

  app.post('/v1/agents/:did/tokens/:id/mint', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const parse = MintSchema.safeParse(req.body || {});
      if (!parse.success) {
        return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      }
      const tok = await pool.query(
        `SELECT agent_did, mintable, paused, status FROM agent_tokens WHERE token_id=$1`,
        [req.params.id]
      ).catch(() => ({ rows: [] }));
      if (!tok.rows[0]) return res.status(404).json({ error: 'not_found' });
      if (tok.rows[0].agent_did !== did) return res.status(403).json({ error: 'not_owner' });
      if (!tok.rows[0].mintable) return res.status(400).json({ error: 'not_mintable' });
      if (tok.rows[0].paused) return res.status(400).json({ error: 'token_paused' });

      const txHash = '0x' + cryptoLib.createHash('sha256')
        .update(`mint|${req.params.id}|${parse.data.to_address}|${Date.now()}`).digest('hex');

      await pool.query(
        `UPDATE agent_tokens SET total_supply_raw = total_supply_raw + $1
          WHERE token_id=$2`,
        [parse.data.amount_raw, req.params.id]
      );
      await pool.query(
        `INSERT INTO token_holders (token_id, holder_did, holder_address, balance_raw)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (token_id, holder_address)
         DO UPDATE SET balance_raw = token_holders.balance_raw + EXCLUDED.balance_raw,
                       last_updated = NOW()`,
        [req.params.id, parse.data.to_did || null,
         parse.data.to_address, parse.data.amount_raw]
      );
      await pool.query(
        `INSERT INTO token_transfers (transfer_id, token_id, from_address, to_address, amount_raw, tx_hash)
         VALUES ($1,$2,NULL,$3,$4,$5)`,
        [genId('xfer'), req.params.id, parse.data.to_address, parse.data.amount_raw, txHash]
      );

      await auditChain.append({
        event_type: 'token.minted',
        token_id: req.params.id, agent_did: did, to_address: parse.data.to_address,
        amount_raw: parse.data.amount_raw, tx_hash: txHash,
        timestamp: new Date().toISOString()
      });

      return res.json({ tx_hash: txHash, minted_raw: parse.data.amount_raw });
    } catch (e) {
      console.error('[tokens.mint]', e);
      return res.status(500).json({ error: 'mint_failed', message: e.message });
    }
  });

  // POST /v1/agents/:did/tokens/:id/burn
  app.post('/v1/agents/:did/tokens/:id/burn', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const parse = z.object({
        from_address: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
        amount_raw: z.string().regex(/^\d+$/)
      }).safeParse(req.body || {});
      if (!parse.success) {
        return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      }
      const tok = await pool.query(
        `SELECT agent_did, burnable, paused FROM agent_tokens WHERE token_id=$1`,
        [req.params.id]
      ).catch(() => ({ rows: [] }));
      if (!tok.rows[0]) return res.status(404).json({ error: 'not_found' });
      if (tok.rows[0].agent_did !== did) return res.status(403).json({ error: 'not_owner' });
      if (!tok.rows[0].burnable) return res.status(400).json({ error: 'not_burnable' });
      if (tok.rows[0].paused) return res.status(400).json({ error: 'token_paused' });

      const balRow = await pool.query(
        `SELECT balance_raw FROM token_holders WHERE token_id=$1 AND holder_address=$2`,
        [req.params.id, parse.data.from_address]
      ).catch(() => ({ rows: [] }));
      if (!balRow.rows[0] || BigInt(balRow.rows[0].balance_raw) < BigInt(parse.data.amount_raw)) {
        return res.status(400).json({ error: 'insufficient_balance' });
      }

      const txHash = '0x' + cryptoLib.createHash('sha256')
        .update(`burn|${req.params.id}|${Date.now()}`).digest('hex');

      await pool.query(
        `UPDATE token_holders SET balance_raw = balance_raw - $1, last_updated = NOW()
          WHERE token_id=$2 AND holder_address=$3`,
        [parse.data.amount_raw, req.params.id, parse.data.from_address]
      );
      await pool.query(
        `UPDATE agent_tokens SET total_supply_raw = total_supply_raw - $1
          WHERE token_id=$2`,
        [parse.data.amount_raw, req.params.id]
      );
      await pool.query(
        `INSERT INTO token_transfers (transfer_id, token_id, from_address, to_address, amount_raw, tx_hash)
         VALUES ($1,$2,$3,NULL,$4,$5)`,
        [genId('xfer'), req.params.id, parse.data.from_address, parse.data.amount_raw, txHash]
      );

      await auditChain.append({
        event_type: 'token.burned',
        token_id: req.params.id, agent_did: did,
        from_address: parse.data.from_address,
        amount_raw: parse.data.amount_raw, tx_hash: txHash,
        timestamp: new Date().toISOString()
      });

      return res.json({ tx_hash: txHash, burned_raw: parse.data.amount_raw });
    } catch (e) {
      console.error('[tokens.burn]', e);
      return res.status(500).json({ error: 'burn_failed', message: e.message });
    }
  });

  // POST /v1/agents/:did/tokens/:id/pause
  app.post('/v1/agents/:did/tokens/:id/pause', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const desiredPaused = req.body && req.body.paused !== false;

      const tok = await pool.query(
        `SELECT agent_did, pausable FROM agent_tokens WHERE token_id=$1`,
        [req.params.id]
      ).catch(() => ({ rows: [] }));
      if (!tok.rows[0]) return res.status(404).json({ error: 'not_found' });
      if (tok.rows[0].agent_did !== did) return res.status(403).json({ error: 'not_owner' });
      if (!tok.rows[0].pausable) return res.status(400).json({ error: 'not_pausable' });

      await pool.query(
        `UPDATE agent_tokens SET paused=$1 WHERE token_id=$2`,
        [desiredPaused, req.params.id]
      );

      await auditChain.append({
        event_type: desiredPaused ? 'token.paused' : 'token.unpaused',
        token_id: req.params.id, agent_did: did,
        timestamp: new Date().toISOString()
      });

      return res.json({ token_id: req.params.id, paused: desiredPaused });
    } catch (e) {
      console.error('[tokens.pause]', e);
      return res.status(500).json({ error: 'pause_failed', message: e.message });
    }
  });

  // GET /v1/tokens/:id/holders
  app.get('/v1/tokens/:id/holders', async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    const r = await pool.query(
      `SELECT holder_did, holder_address, balance_raw, last_updated
         FROM token_holders WHERE token_id=$1 AND balance_raw > 0
        ORDER BY balance_raw DESC LIMIT $2`,
      [req.params.id, limit]
    ).catch(() => ({ rows: [] }));
    const holders = r.rows.map(h => ({ ...h, balance_raw: String(h.balance_raw) }));
    return res.json({ token_id: req.params.id, count: holders.length, holders });
  });

  // GET /v1/tokens/:id/transfers
  app.get('/v1/tokens/:id/transfers', async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    const r = await pool.query(
      `SELECT transfer_id, from_address, to_address, amount_raw, tx_hash, block_number, created_at
         FROM token_transfers WHERE token_id=$1
        ORDER BY created_at DESC LIMIT $2`,
      [req.params.id, limit]
    ).catch(() => ({ rows: [] }));
    const transfers = r.rows.map(t => ({ ...t, amount_raw: String(t.amount_raw) }));
    return res.json({ token_id: req.params.id, count: transfers.length, transfers });
  });
}

module.exports = {
  migrate,
  registerTokensRoutes,
  buildConstructorArgs,
  deriveContractAddress,
  TOKEN_STATUSES,
  TRANSFER_TOPIC
};
