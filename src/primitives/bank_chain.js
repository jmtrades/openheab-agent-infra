// ============================================================================
// bank_chain.js — Non-custodial USDC wallet on Base
//
// Generates secp256k1 keypair, derives Ethereum address via keccak256,
// encrypts private key with AES-256-GCM (KEK from HKDF over BANK_MASTER_KEK).
// Live balance via eth_call balanceOf(addr) on USDC contract.
// Transfers go via FeeSplitter contract (viem) — stubbable via BANK_TRANSFER_STUB.
// ============================================================================

const express   = require('express');
const cryptoLib = require('crypto');
const keccak    = require('keccak');
const { z }     = require('zod');
const bankConfig = require('./bank_config');

const USDC_BASE_MAINNET   = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const USDC_BASE_SEPOLIA   = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const BALANCE_OF_SELECTOR = '0x70a08231';
const DEFAULT_CHAIN       = process.env.BANK_DEFAULT_CHAIN || 'base';

// ----- KEK derivation --------------------------------------------------------
function getMasterKek() {
  const raw = process.env.BANK_MASTER_KEK
           || process.env.CRYPTO_MASTER_KEK
           || process.env.IDENTITY_MASTER_KEK;
  if (!raw) throw new Error('BANK_MASTER_KEK_unset');
  // Accept hex/base64; fall back to utf8 hash
  let buf;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) buf = Buffer.from(raw, 'hex');
  else if (/^[A-Za-z0-9+/=]{40,}$/.test(raw)) {
    try { buf = Buffer.from(raw, 'base64'); }
    catch { buf = cryptoLib.createHash('sha256').update(raw).digest(); }
  } else {
    buf = cryptoLib.createHash('sha256').update(raw).digest();
  }
  if (buf.length < 32) {
    buf = cryptoLib.createHash('sha256').update(buf).digest();
  }
  return buf.subarray(0, 32);
}

function hkdf(ikm, salt, info, length = 32) {
  return cryptoLib.hkdfSync('sha256', ikm, salt, Buffer.from(info), length);
}

function deriveAgentKek(agentDid, kekSalt) {
  const master = getMasterKek();
  const info = `openheab:bank_chain:v1:${agentDid}`;
  return Buffer.from(hkdf(master, kekSalt, info, 32));
}

// ----- Encryption ------------------------------------------------------------
function encryptPrivateKey(privKeyBuf, agentDid) {
  const kekSalt = cryptoLib.randomBytes(16);
  const kek = deriveAgentKek(agentDid, kekSalt);
  const iv  = cryptoLib.randomBytes(12);
  const cipher = cryptoLib.createCipheriv('aes-256-gcm', kek, iv);
  const ct = Buffer.concat([cipher.update(privKeyBuf), cipher.final()]);
  const tag = cipher.getAuthTag();
  // packed: [iv(12)][tag(16)][ct]
  const packed = Buffer.concat([iv, tag, ct]);
  return { encrypted: packed, kekSalt };
}

function decryptPrivateKey(packed, kekSalt, agentDid) {
  const kek = deriveAgentKek(agentDid, kekSalt);
  const iv  = packed.subarray(0, 12);
  const tag = packed.subarray(12, 28);
  const ct  = packed.subarray(28);
  const decipher = cryptoLib.createDecipheriv('aes-256-gcm', kek, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

// ----- Keypair / address derivation ------------------------------------------
function compressedToUncompressedPubKey(pubKeyObj) {
  const jwk = pubKeyObj.export({ format: 'jwk' });
  const x = Buffer.from(jwk.x, 'base64url');
  const y = Buffer.from(jwk.y, 'base64url');
  return Buffer.concat([x, y]); // 64 bytes; no 0x04 prefix for keccak hash
}

function privateKeyToHex(privKeyObj) {
  const jwk = privKeyObj.export({ format: 'jwk' });
  return Buffer.from(jwk.d, 'base64url');
}

function deriveEthAddress(uncompressedPubKey64) {
  // keccak256 over (X || Y), take last 20 bytes
  const hash = keccak('keccak256').update(uncompressedPubKey64).digest();
  const addr = hash.subarray(hash.length - 20);
  return '0x' + addr.toString('hex');
}

function generateWallet() {
  const { publicKey, privateKey } = cryptoLib.generateKeyPairSync('ec', {
    namedCurve: 'secp256k1'
  });
  const rawPub = compressedToUncompressedPubKey(publicKey);
  const address = deriveEthAddress(rawPub);
  const privBuf = privateKeyToHex(privateKey);
  return {
    address,
    publicKeyHex: '0x04' + rawPub.toString('hex'),
    privateKey: privBuf
  };
}

// ----- JSON-RPC helpers ------------------------------------------------------
async function rpcCall(rpcUrl, method, params) {
  if (typeof fetch !== 'function') throw new Error('fetch_unavailable');
  const r = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
  });
  if (!r.ok) throw new Error(`rpc_http_${r.status}`);
  const j = await r.json();
  if (j.error) throw new Error(`rpc_${j.error.code}_${j.error.message}`);
  return j.result;
}

function padAddress(addr) {
  return addr.toLowerCase().replace(/^0x/, '').padStart(64, '0');
}

function usdcAddressFor(chain) {
  if (chain === 'base-sepolia') return USDC_BASE_SEPOLIA;
  const cfg = bankConfig.getAssetConfig('USDC', chain);
  return cfg ? cfg.address : USDC_BASE_MAINNET;
}

async function getOnChainBalance(address, chain = DEFAULT_CHAIN, asset = 'USDC') {
  if (process.env.BANK_BALANCE_STUB === 'true') {
    return { raw: '0', decimals: 6, formatted: '0.000000', stub: true };
  }
  const chainCfg = bankConfig.getChainConfig(chain);
  if (!chainCfg) throw new Error(`unsupported_chain_${chain}`);
  const assetCfg = bankConfig.getAssetConfig(asset, chain);
  if (!assetCfg && asset !== 'USDC') throw new Error(`unsupported_asset_${asset}_on_${chain}`);
  const tokenAddress = assetCfg ? assetCfg.address : usdcAddressFor(chain);
  const decimals = assetCfg ? assetCfg.decimals : 6;

  const data = BALANCE_OF_SELECTOR + padAddress(address);
  try {
    const result = await rpcCall(chainCfg.rpc, 'eth_call', [
      { to: tokenAddress, data }, 'latest'
    ]);
    const raw = BigInt(result || '0x0').toString();
    const formatted = formatUnits(raw, decimals);
    return { raw, decimals, formatted, token: tokenAddress, chain, asset };
  } catch (e) {
    return { raw: '0', decimals, formatted: '0.' + '0'.repeat(decimals), error: e.message };
  }
}

function formatUnits(raw, decimals) {
  const s = String(raw).padStart(decimals + 1, '0');
  const i = s.length - decimals;
  return s.slice(0, i) + '.' + s.slice(i);
}

// ----- Transfer broadcasting (viem if available) -----------------------------
async function broadcastTransfer({
  fromPrivKey, fromAddress, toAddress, amountRaw, chain = DEFAULT_CHAIN, asset = 'USDC'
}) {
  if (process.env.BANK_TRANSFER_STUB === 'true' || !process.env.BANK_FEE_SPLITTER) {
    // Deterministic stub
    const h = cryptoLib.createHash('sha256')
      .update(`${fromAddress}|${toAddress}|${amountRaw}|${chain}|${asset}|${Date.now()}`)
      .digest('hex');
    return {
      tx_hash: '0x' + h,
      stub: true,
      gross_amount: String(amountRaw),
      net_amount: String(BigInt(amountRaw) * 99n / 100n),
      fee_amount: String(BigInt(amountRaw) / 100n),
      chain,
      block_number: null,
      status: 'confirmed'
    };
  }

  // Real broadcast via viem
  try {
    const { createWalletClient, http, parseUnits } = require('viem');
    const { privateKeyToAccount } = require('viem/accounts');
    const chainCfg = bankConfig.getChainConfig(chain);
    if (!chainCfg) throw new Error(`unsupported_chain_${chain}`);

    const account = privateKeyToAccount('0x' + fromPrivKey.toString('hex'));
    const client  = createWalletClient({
      account,
      transport: http(chainCfg.rpc),
      chain: { id: chainCfg.chainId, name: chain, nativeCurrency: { name: chainCfg.nativeSymbol, symbol: chainCfg.nativeSymbol, decimals: 18 }, rpcUrls: { default: { http: [chainCfg.rpc] } } }
    });

    const tokenAddr = usdcAddressFor(chain);
    const feeSplitter = process.env.BANK_FEE_SPLITTER || chainCfg.feeSplitter;
    const abi = [{
      name: 'transfer', type: 'function', stateMutability: 'nonpayable',
      inputs: [
        { name: 'token', type: 'address' },
        { name: 'to', type: 'address' },
        { name: 'amount', type: 'uint256' }
      ],
      outputs: [{ name: '', type: 'bytes32' }]
    }];
    const txHash = await client.writeContract({
      address: feeSplitter,
      abi,
      functionName: 'transfer',
      args: [tokenAddr, toAddress, BigInt(amountRaw)]
    });

    return {
      tx_hash: txHash,
      stub: false,
      gross_amount: String(amountRaw),
      net_amount: String(BigInt(amountRaw) * 99n / 100n),
      fee_amount: String(BigInt(amountRaw) / 100n),
      chain,
      block_number: null,
      status: 'pending'
    };
  } catch (e) {
    throw new Error('broadcast_failed_' + e.message);
  }
}

// ----- Wallet provisioning ---------------------------------------------------
async function provisionWallet(pool, auditChain, agentDid, chain = DEFAULT_CHAIN) {
  // Idempotent: return existing wallet if present
  const existing = await pool.query(
    `SELECT address, chain, created_at FROM bank_wallets
     WHERE agent_did = $1 AND chain = $2`,
    [agentDid, chain]
  ).catch(() => ({ rows: [] }));
  if (existing.rows[0]) return existing.rows[0];

  const { address, privateKey, publicKeyHex } = generateWallet();
  const { encrypted, kekSalt } = encryptPrivateKey(privateKey, agentDid);

  await pool.query(
    `INSERT INTO bank_wallets (agent_did, chain, address, encrypted_key, kek_salt, public_key, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW())
     ON CONFLICT (agent_did, chain) DO NOTHING`,
    [agentDid, chain, address, encrypted, kekSalt, publicKeyHex]
  );

  if (auditChain) {
    await auditChain.append({
      event_type: 'bank_chain.wallet.provisioned',
      agent_did: agentDid, chain, address,
      timestamp: new Date().toISOString()
    });
  }
  return { agent_did: agentDid, chain, address };
}

// ----- Migrate ---------------------------------------------------------------
async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bank_wallets (
      agent_did       TEXT NOT NULL,
      chain           TEXT NOT NULL DEFAULT 'base',
      address         TEXT NOT NULL,
      encrypted_key   BYTEA NOT NULL,
      kek_salt        BYTEA NOT NULL,
      public_key      TEXT,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (agent_did, chain)
    );
    CREATE INDEX IF NOT EXISTS idx_bank_wallets_address ON bank_wallets (address);

    CREATE TABLE IF NOT EXISTS chain_transactions (
      tx_hash          TEXT PRIMARY KEY,
      from_did         TEXT,
      to_did           TEXT,
      from_address     TEXT NOT NULL,
      to_address       TEXT NOT NULL,
      gross_amount     NUMERIC(78,0) NOT NULL,
      net_amount       NUMERIC(78,0) NOT NULL,
      fee_amount       NUMERIC(78,0) NOT NULL DEFAULT 0,
      chain            TEXT NOT NULL DEFAULT 'base',
      asset            TEXT NOT NULL DEFAULT 'USDC',
      block_number     BIGINT,
      status           TEXT NOT NULL DEFAULT 'pending',
      reason           TEXT,
      idempotency_key  TEXT,
      audit_hash       TEXT,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      confirmed_at     TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_chain_tx_from ON chain_transactions (from_did, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_chain_tx_to   ON chain_transactions (to_did, created_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_chain_tx_idem
      ON chain_transactions (from_did, idempotency_key)
      WHERE idempotency_key IS NOT NULL;
  `);
}

// ----- Routes ----------------------------------------------------------------
function registerBankChainRoutes(app, pool, verifyAgentAuth, auditChain) {
  const provisionSchema = z.object({ chain: z.string().optional() });
  const transferSchema = z.object({
    to_address: z.string().regex(/^0x[a-fA-F0-9]{40}$/).optional(),
    to_did: z.string().optional(),
    amount: z.string().regex(/^\d+(\.\d+)?$/),
    asset: z.string().default('USDC'),
    chain: z.string().optional(),
    reason: z.string().max(500).optional()
  }).refine(d => d.to_address || d.to_did, 'to_address_or_to_did_required');

  // POST /v1/agents/:did/wallet/provision
  app.post('/v1/agents/:did/wallet/provision', express.json(), async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const parsed = provisionSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: 'invalid_input', details: parsed.error.flatten() });
    const chain = parsed.data.chain || DEFAULT_CHAIN;
    try {
      const w = await provisionWallet(pool, auditChain, did, chain);
      return res.status(201).json(w);
    } catch (e) {
      return res.status(500).json({ error: 'provision_failed', message: e.message });
    }
  });

  // GET /v1/agents/:did/wallet/balance
  app.get('/v1/agents/:did/wallet/balance', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const chain = req.query.chain || DEFAULT_CHAIN;
    const asset = req.query.asset || 'USDC';
    const r = await pool.query(
      `SELECT address FROM bank_wallets WHERE agent_did = $1 AND chain = $2`,
      [did, chain]
    ).catch(() => ({ rows: [] }));
    if (!r.rows[0]) return res.status(404).json({ error: 'wallet_not_found' });
    try {
      const bal = await getOnChainBalance(r.rows[0].address, chain, asset);
      return res.json({ did, chain, asset, address: r.rows[0].address, balance: bal });
    } catch (e) {
      return res.status(500).json({ error: 'balance_failed', message: e.message });
    }
  });

  // POST /v1/agents/:did/wallet/transfer
  app.post('/v1/agents/:did/wallet/transfer', express.json(), async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const parsed = transferSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: 'invalid_input', details: parsed.error.flatten() });
    const idemKey = req.headers['x-idempotency-key'] || null;
    const chain = parsed.data.chain || DEFAULT_CHAIN;
    const asset = parsed.data.asset || 'USDC';
    const assetCfg = bankConfig.getAssetConfig(asset, chain) ||
                     { decimals: 6, address: usdcAddressFor(chain) };

    // Idempotency check
    if (idemKey) {
      const existing = await pool.query(
        `SELECT tx_hash, gross_amount, net_amount, fee_amount, status, chain
         FROM chain_transactions WHERE from_did = $1 AND idempotency_key = $2`,
        [did, idemKey]
      ).catch(() => ({ rows: [] }));
      if (existing.rows[0]) {
        const r = existing.rows[0];
        return res.json({
          tx_hash: r.tx_hash,
          gross_amount: String(r.gross_amount),
          net_amount: String(r.net_amount),
          fee_amount: String(r.fee_amount),
          status: r.status, chain: r.chain, idempotent: true
        });
      }
    }

    // Resolve recipient address
    let toAddress = parsed.data.to_address;
    let toDid = parsed.data.to_did || null;
    if (!toAddress && toDid) {
      const r = await pool.query(
        `SELECT address FROM bank_wallets WHERE agent_did = $1 AND chain = $2`,
        [toDid, chain]
      ).catch(() => ({ rows: [] }));
      if (!r.rows[0]) return res.status(404).json({ error: 'recipient_wallet_not_found' });
      toAddress = r.rows[0].address;
    }

    // Load sender wallet
    const sender = await pool.query(
      `SELECT address, encrypted_key, kek_salt FROM bank_wallets
       WHERE agent_did = $1 AND chain = $2`,
      [did, chain]
    ).catch(() => ({ rows: [] }));
    if (!sender.rows[0]) return res.status(404).json({ error: 'wallet_not_found' });

    // Convert amount to raw units
    const [intPart, fracPart = ''] = String(parsed.data.amount).split('.');
    const fracPadded = (fracPart + '0'.repeat(assetCfg.decimals)).slice(0, assetCfg.decimals);
    const amountRaw = BigInt(intPart + fracPadded).toString();

    let result;
    try {
      const privKey = decryptPrivateKey(
        Buffer.from(sender.rows[0].encrypted_key),
        Buffer.from(sender.rows[0].kek_salt),
        did
      );
      result = await broadcastTransfer({
        fromPrivKey: privKey,
        fromAddress: sender.rows[0].address,
        toAddress,
        amountRaw,
        chain,
        asset
      });
    } catch (e) {
      return res.status(500).json({ error: 'transfer_failed', message: e.message });
    }

    const audit = await auditChain.append({
      event_type: 'bank_chain.transfer',
      from_did: did, to_did: toDid, from_address: sender.rows[0].address,
      to_address: toAddress, gross_amount: result.gross_amount,
      net_amount: result.net_amount, fee_amount: result.fee_amount,
      chain, asset, tx_hash: result.tx_hash,
      timestamp: new Date().toISOString()
    });

    await pool.query(
      `INSERT INTO chain_transactions
        (tx_hash, from_did, to_did, from_address, to_address,
         gross_amount, net_amount, fee_amount, chain, asset,
         status, reason, idempotency_key, audit_hash, created_at, confirmed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NOW(),
               CASE WHEN $11 = 'confirmed' THEN NOW() ELSE NULL END)
       ON CONFLICT (tx_hash) DO NOTHING`,
      [
        result.tx_hash, did, toDid, sender.rows[0].address, toAddress,
        result.gross_amount, result.net_amount, result.fee_amount,
        chain, asset, result.status, parsed.data.reason || null,
        idemKey, audit.hash
      ]
    );

    return res.status(201).json({
      tx_hash: result.tx_hash,
      from_address: sender.rows[0].address,
      to_address: toAddress,
      gross_amount: result.gross_amount,
      net_amount: result.net_amount,
      fee_amount: result.fee_amount,
      chain, asset,
      status: result.status,
      stub: !!result.stub
    });
  });

  // GET /v1/agents/:did/wallet/transactions
  app.get('/v1/agents/:did/wallet/transactions', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const limit = Math.min(parseInt(req.query.limit) || 50, 500);
    const offset = Math.max(parseInt(req.query.offset) || 0, 0);
    const r = await pool.query(
      `SELECT tx_hash, from_did, to_did, from_address, to_address,
              gross_amount, net_amount, fee_amount, chain, asset,
              status, reason, block_number, created_at, confirmed_at
       FROM chain_transactions
       WHERE from_did = $1 OR to_did = $1
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      [did, limit, offset]
    ).catch(() => ({ rows: [] }));
    const txs = r.rows.map(x => ({
      ...x,
      gross_amount: String(x.gross_amount),
      net_amount: String(x.net_amount),
      fee_amount: String(x.fee_amount)
    }));
    return res.json({ did, count: txs.length, transactions: txs });
  });

  // GET /v1/bank/info — public bank/protocol info
  app.get('/v1/bank/info', async (req, res) => {
    res.json({
      protocol: 'openheab-bank',
      default_chain: DEFAULT_CHAIN,
      supported_chains: bankConfig.listSupportedChains(),
      supported_assets: bankConfig.listSupportedAssets(),
      fee_bps: 100,
      fee_splitter: process.env.BANK_FEE_SPLITTER || null,
      stub_mode: process.env.BANK_TRANSFER_STUB === 'true'
    });
  });
}

module.exports = {
  migrate,
  registerBankChainRoutes,
  provisionWallet,
  getOnChainBalance,
  generateWallet,
  broadcastTransfer,
  decryptPrivateKey,
  encryptPrivateKey
};
