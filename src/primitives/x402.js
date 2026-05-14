// ============================================================================
// OpenHeab x402 — HTTP 402 payment protocol
// ============================================================================
const express = require('express');
const cryptoLib = require('crypto');
const { z } = require('zod');

// ----------------------------------------------------------------------------
// Migration
// ----------------------------------------------------------------------------
async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS x402_resources (
      resource_id     TEXT PRIMARY KEY,
      owner_did       TEXT NOT NULL,
      label           TEXT NOT NULL,
      upstream_url    TEXT NOT NULL,
      price_usdc_raw  NUMERIC(78,0) NOT NULL,
      chain           TEXT NOT NULL,
      recipient_addr  TEXT NOT NULL,
      access_seconds  INTEGER NOT NULL DEFAULT 3600,
      max_calls       INTEGER NOT NULL DEFAULT 1,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_x402_resources_owner ON x402_resources (owner_did);

    CREATE TABLE IF NOT EXISTS x402_payments (
      tx_hash             TEXT PRIMARY KEY,
      resource_id         TEXT NOT NULL,
      payer_did           TEXT,
      payer_addr          TEXT,
      amount_raw          NUMERIC(78,0),
      chain               TEXT,
      verified            BOOLEAN NOT NULL DEFAULT FALSE,
      access_token        TEXT,
      access_expires_at   TIMESTAMPTZ,
      calls_used          INTEGER NOT NULL DEFAULT 0,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_x402_payments_token ON x402_payments (access_token) WHERE access_token IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_x402_payments_resource ON x402_payments (resource_id);
  `).catch(() => {});
}

function genId(prefix) {
  return `${prefix}_${cryptoLib.randomBytes(12).toString('hex')}`;
}

function genAccessToken() {
  return 'xtk_' + cryptoLib.randomBytes(24).toString('hex');
}

// Minimal eth_getTransactionReceipt verification via RPC
async function verifyTxOnChain(chain, txHash) {
  const rpc = process.env[`RPC_URL_${(chain || '').toUpperCase()}`] || process.env.RPC_URL_DEFAULT;
  if (!rpc) return { ok: false, reason: 'no_rpc_configured' };
  try {
    const resp = await fetch(rpc, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1,
        method: 'eth_getTransactionReceipt',
        params: [txHash]
      })
    });
    const data = await resp.json();
    const rec = data && data.result;
    if (!rec) return { ok: false, reason: 'tx_not_found' };
    if (rec.status && rec.status !== '0x1') return { ok: false, reason: 'tx_failed' };
    return { ok: true, receipt: rec };
  } catch (e) {
    return { ok: false, reason: 'rpc_failed', error: e.message };
  }
}

// ----------------------------------------------------------------------------
// Routes
// ----------------------------------------------------------------------------
function registerX402Routes(app, pool, verifyAgentAuth, auditChain) {
  // POST /v1/x402/resources
  const ResourceSchema = z.object({
    owner_did: z.string(),
    label: z.string().min(1).max(200),
    upstream_url: z.string().url(),
    price_usdc_raw: z.string().regex(/^\d+$/),
    chain: z.string().min(1).max(40),
    recipient_addr: z.string().min(1).max(80),
    access_seconds: z.number().int().positive().max(86400 * 30).default(3600),
    max_calls: z.number().int().positive().max(100000).default(1)
  });

  app.post('/v1/x402/resources', express.json(), async (req, res) => {
    try {
      const parse = ResourceSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;
      const auth = await verifyAgentAuth(req, d.owner_did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const resourceId = genId('x402res');
      await pool.query(
        `INSERT INTO x402_resources (resource_id, owner_did, label, upstream_url,
           price_usdc_raw, chain, recipient_addr, access_seconds, max_calls)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [resourceId, d.owner_did, d.label, d.upstream_url,
         d.price_usdc_raw, d.chain, d.recipient_addr,
         d.access_seconds, d.max_calls]
      );

      await auditChain.append({
        event_type: 'x402.resource_created',
        resource_id: resourceId, owner_did: d.owner_did,
        timestamp: new Date().toISOString()
      });

      return res.status(201).json({
        resource_id: resourceId, owner_did: d.owner_did, label: d.label,
        price_usdc_raw: d.price_usdc_raw, chain: d.chain
      });
    } catch (e) {
      console.error('[x402.resource.create]', e);
      return res.status(500).json({ error: 'create_failed', message: e.message });
    }
  });

  // GET /v1/x402/resources
  app.get('/v1/x402/resources', async (req, res) => {
    const owner = req.query.owner_did;
    const params = [];
    let where = '';
    if (owner) { params.push(owner); where = `WHERE owner_did=$1`; }
    const r = await pool.query(
      `SELECT resource_id, owner_did, label, upstream_url, price_usdc_raw, chain,
              recipient_addr, access_seconds, max_calls, created_at
       FROM x402_resources ${where} ORDER BY created_at DESC LIMIT 200`,
      params
    ).catch(() => ({ rows: [] }));
    return res.json({ resources: r.rows.map(row => ({ ...row, price_usdc_raw: String(row.price_usdc_raw) })), count: r.rows.length });
  });

  // POST /v1/x402/challenge — returns 402 envelope
  const ChallengeSchema = z.object({
    resource_id: z.string()
  });

  app.post('/v1/x402/challenge', express.json(), async (req, res) => {
    const parse = ChallengeSchema.safeParse(req.body || {});
    if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
    const r = await pool.query(
      `SELECT resource_id, label, price_usdc_raw, chain, recipient_addr
       FROM x402_resources WHERE resource_id=$1`,
      [parse.data.resource_id]
    ).catch(() => ({ rows: [] }));
    if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
    const row = r.rows[0];
    const memo = cryptoLib.createHash('sha256').update(row.resource_id + ':' + Date.now()).digest('hex').slice(0, 16);
    const envelope = {
      version: '1',
      resource_id: row.resource_id,
      amount_raw: String(row.price_usdc_raw),
      asset: 'USDC',
      chain: row.chain,
      recipient: row.recipient_addr,
      memo,
      verify_url: `${process.env.OPERATOR_PUBLIC_URL || ''}/v1/x402/verify`.replace(/^\/+/, 'https:///').replace(/\/\/+/g, '/')
    };
    // proper join
    envelope.verify_url = `${(process.env.OPERATOR_PUBLIC_URL || '').replace(/\/$/, '')}/v1/x402/verify`;

    return res.status(402).json({ x402: envelope });
  });

  // POST /v1/x402/verify
  const VerifySchema = z.object({
    resource_id: z.string(),
    tx_hash: z.string().min(1),
    payer_did: z.string().optional(),
    payer_addr: z.string().optional()
  });

  app.post('/v1/x402/verify', express.json(), async (req, res) => {
    try {
      const parse = VerifySchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;

      const r = await pool.query(
        `SELECT resource_id, chain, price_usdc_raw, access_seconds
         FROM x402_resources WHERE resource_id=$1`, [d.resource_id]
      ).catch(() => ({ rows: [] }));
      if (!r.rows[0]) return res.status(404).json({ error: 'resource_not_found' });
      const resource = r.rows[0];

      const existing = await pool.query(`SELECT access_token FROM x402_payments WHERE tx_hash=$1`, [d.tx_hash])
        .catch(() => ({ rows: [] }));
      if (existing.rows[0]) {
        return res.json({ already_verified: true, access_token: existing.rows[0].access_token });
      }

      const v = await verifyTxOnChain(resource.chain, d.tx_hash);
      const verified = v.ok;
      const accessToken = verified ? genAccessToken() : null;
      const expiresAt = verified ? new Date(Date.now() + resource.access_seconds * 1000) : null;

      await pool.query(
        `INSERT INTO x402_payments (tx_hash, resource_id, payer_did, payer_addr,
           amount_raw, chain, verified, access_token, access_expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [d.tx_hash, d.resource_id, d.payer_did || null, d.payer_addr || null,
         resource.price_usdc_raw, resource.chain, verified, accessToken, expiresAt]
      );

      await auditChain.append({
        event_type: 'x402.payment_verified',
        tx_hash: d.tx_hash, resource_id: d.resource_id, verified,
        timestamp: new Date().toISOString()
      });

      if (!verified) return res.status(400).json({ error: 'verification_failed', reason: v.reason });
      return res.json({
        verified: true, access_token: accessToken,
        access_expires_at: expiresAt, resource_id: d.resource_id
      });
    } catch (e) {
      console.error('[x402.verify]', e);
      return res.status(500).json({ error: 'verify_failed', message: e.message });
    }
  });

  // GET /v1/x402/access/:token
  app.get('/v1/x402/access/:token', async (req, res) => {
    const r = await pool.query(
      `SELECT tx_hash, resource_id, access_token, access_expires_at, calls_used,
              (SELECT max_calls FROM x402_resources WHERE resource_id = p.resource_id) AS max_calls
       FROM x402_payments p WHERE access_token=$1`,
      [req.params.token]
    ).catch(() => ({ rows: [] }));
    if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
    const row = r.rows[0];
    const expired = row.access_expires_at && new Date(row.access_expires_at) < new Date();
    const exhausted = row.max_calls && row.calls_used >= row.max_calls;
    return res.json({
      access_token: row.access_token, resource_id: row.resource_id,
      expires_at: row.access_expires_at, calls_used: row.calls_used,
      max_calls: row.max_calls, expired: !!expired, exhausted: !!exhausted,
      valid: !expired && !exhausted
    });
  });

  // POST/GET /v1/x402/proxy/:resource_id
  const proxyHandler = async (req, res) => {
    try {
      const token = req.headers['x-x402-token'];
      if (!token) return res.status(401).json({ error: 'missing_x402_token' });

      const pr = await pool.query(
        `SELECT p.tx_hash, p.resource_id, p.access_expires_at, p.calls_used, p.verified,
                r.upstream_url, r.max_calls
         FROM x402_payments p
         JOIN x402_resources r ON r.resource_id = p.resource_id
         WHERE p.access_token=$1 AND p.resource_id=$2`,
        [token, req.params.resource_id]
      ).catch(() => ({ rows: [] }));
      if (!pr.rows[0]) return res.status(401).json({ error: 'invalid_token' });
      const row = pr.rows[0];
      if (!row.verified) return res.status(402).json({ error: 'payment_not_verified' });
      if (row.access_expires_at && new Date(row.access_expires_at) < new Date()) {
        return res.status(402).json({ error: 'token_expired' });
      }
      if (row.max_calls && row.calls_used >= row.max_calls) {
        return res.status(402).json({ error: 'token_exhausted' });
      }

      const init = {
        method: req.method,
        headers: { 'content-type': req.headers['content-type'] || 'application/json' }
      };
      if (req.method !== 'GET' && req.body) {
        init.body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
      }
      let upstreamResp;
      try {
        upstreamResp = await fetch(row.upstream_url, init);
      } catch (e) {
        return res.status(502).json({ error: 'upstream_failed', message: e.message });
      }

      await pool.query(
        `UPDATE x402_payments SET calls_used = calls_used + 1 WHERE tx_hash=$1`,
        [row.tx_hash]
      ).catch(() => {});

      const contentType = upstreamResp.headers.get('content-type') || 'application/json';
      res.status(upstreamResp.status);
      res.setHeader('content-type', contentType);
      const text = await upstreamResp.text();
      return res.send(text);
    } catch (e) {
      console.error('[x402.proxy]', e);
      return res.status(500).json({ error: 'proxy_failed', message: e.message });
    }
  };

  app.post('/v1/x402/proxy/:resource_id', express.json(), proxyHandler);
  app.get('/v1/x402/proxy/:resource_id', proxyHandler);
}

module.exports = {
  migrate,
  registerX402Routes,
  verifyTxOnChain
};
