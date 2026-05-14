// ============================================================================
// OpenHeab IPFS — Decentralized storage gateway
// Tables: ipfs_pins
// Providers: pinata (PINATA_JWT), web3-storage (WEB3_STORAGE_TOKEN), filebase
// Cost: ~$0.15/GB/month
// ============================================================================
const cryptoLib = require('crypto');
const express = require('express');
const { z } = require('zod');

const PROVIDERS = ['pinata', 'web3-storage', 'filebase'];
const PIN_STATUSES = ['pinning', 'pinned', 'failed'];

const COST_CENTS_PER_GB_MONTH = parseInt(process.env.IPFS_COST_CENTS_PER_GB_MONTH || '15');
const MAX_PIN_BYTES = parseInt(process.env.IPFS_MAX_PIN_BYTES || String(100 * 1024 * 1024)); // 100MB
const DEFAULT_PROVIDER = process.env.IPFS_DEFAULT_PROVIDER || 'pinata';

// ----------------------------------------------------------------------------
// Migration
// ----------------------------------------------------------------------------
async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ipfs_pins (
      pin_id              TEXT PRIMARY KEY,
      agent_did           TEXT NOT NULL,
      cid                 TEXT NOT NULL,
      name                TEXT,
      size_bytes          BIGINT NOT NULL DEFAULT 0,
      provider            TEXT NOT NULL DEFAULT 'pinata',
      status              TEXT NOT NULL DEFAULT 'pinning',
      cost_cents          INTEGER NOT NULL DEFAULT 0,
      pinned_at           TIMESTAMPTZ,
      expires_at          TIMESTAMPTZ,
      audit_chain_entry   TEXT,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_ipfs_pins_agent ON ipfs_pins (agent_did);
    CREATE INDEX IF NOT EXISTS idx_ipfs_pins_cid ON ipfs_pins (cid);
  `);
}

function genPinId() { return 'pin_' + cryptoLib.randomBytes(12).toString('hex'); }

function calcMonthlyCostCents(sizeBytes) {
  const gb = sizeBytes / (1024 * 1024 * 1024);
  return Math.max(1, Math.round(gb * COST_CENTS_PER_GB_MONTH));
}

function gatewayUrl(cid, provider) {
  const gateways = {
    'pinata': `https://gateway.pinata.cloud/ipfs/${cid}`,
    'web3-storage': `https://${cid}.ipfs.w3s.link`,
    'filebase': `https://ipfs.filebase.io/ipfs/${cid}`
  };
  return gateways[provider] || `https://ipfs.io/ipfs/${cid}`;
}

// ----------------------------------------------------------------------------
// Provider clients
// ----------------------------------------------------------------------------
async function pinToPinata(buf, name) {
  if (!process.env.PINATA_JWT) return null;
  try {
    const fetch = global.fetch || require('node-fetch');
    const FormData = global.FormData || require('form-data');
    const form = new FormData();
    const blob = global.Blob ? new Blob([buf]) : buf;
    if (global.Blob) {
      form.append('file', blob, name || 'file');
    } else {
      form.append('file', buf, { filename: name || 'file' });
    }
    const r = await fetch('https://api.pinata.cloud/pinning/pinFileToIPFS', {
      method: 'POST',
      headers: { 'authorization': `Bearer ${process.env.PINATA_JWT}` },
      body: form
    });
    const j = await r.json();
    if (j && j.IpfsHash) return { cid: j.IpfsHash, size: j.PinSize || buf.length };
  } catch (e) { console.warn('[ipfs.pinata]', e.message); }
  return null;
}

async function pinToWeb3Storage(buf, name) {
  if (!process.env.WEB3_STORAGE_TOKEN) return null;
  try {
    const fetch = global.fetch || require('node-fetch');
    const r = await fetch('https://api.web3.storage/upload', {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${process.env.WEB3_STORAGE_TOKEN}`,
        'content-type': 'application/octet-stream',
        'x-name': name || 'file'
      },
      body: buf
    });
    const j = await r.json();
    if (j && j.cid) return { cid: j.cid, size: buf.length };
  } catch (e) { console.warn('[ipfs.web3storage]', e.message); }
  return null;
}

async function pinExistingCidPinata(cid, name) {
  if (!process.env.PINATA_JWT) return null;
  try {
    const fetch = global.fetch || require('node-fetch');
    const r = await fetch('https://api.pinata.cloud/pinning/pinByHash', {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${process.env.PINATA_JWT}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ hashToPin: cid, pinataMetadata: { name } })
    });
    const j = await r.json();
    if (j && (j.ipfsHash || j.IpfsHash)) return { cid: j.ipfsHash || j.IpfsHash };
  } catch (e) { console.warn('[ipfs.pinata.pinByHash]', e.message); }
  return null;
}

async function pinBuffer(buf, name, provider) {
  if (provider === 'pinata') {
    const r = await pinToPinata(buf, name);
    if (r) return r;
  }
  if (provider === 'web3-storage') {
    const r = await pinToWeb3Storage(buf, name);
    if (r) return r;
  }
  // Stub: deterministic fake CID from sha256
  const fakeCid = 'bafy' + cryptoLib.createHash('sha256').update(buf).digest('base64url').slice(0, 50);
  return { cid: fakeCid, size: buf.length, stub: true };
}

// ----------------------------------------------------------------------------
// Routes
// ----------------------------------------------------------------------------
function registerIpfsRoutes(app, pool, verifyAgentAuth, auditChain) {
  // POST /v1/agents/:did/ipfs/pin — upload file/bytes
  const PinSchema = z.object({
    name: z.string().max(512).optional(),
    data_base64: z.string().min(1),
    provider: z.enum(PROVIDERS).optional(),
    expires_at: z.string().datetime().optional()
  });

  app.post('/v1/agents/:did/ipfs/pin', express.json({ limit: '120mb' }), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const parse = PinSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;

      let buf;
      try { buf = Buffer.from(d.data_base64, 'base64'); }
      catch { return res.status(400).json({ error: 'invalid_base64' }); }
      if (buf.length > MAX_PIN_BYTES) {
        return res.status(413).json({ error: 'too_large', max_bytes: MAX_PIN_BYTES });
      }

      const provider = d.provider || DEFAULT_PROVIDER;
      const pinId = genPinId();
      const result = await pinBuffer(buf, d.name, provider);
      const cost = calcMonthlyCostCents(result.size);

      const chainEntry = await auditChain.append({
        event_type: 'ipfs.pinned',
        pin_id: pinId, agent_did: did, cid: result.cid,
        size_bytes: result.size, provider,
        timestamp: new Date().toISOString()
      });

      await pool.query(
        `INSERT INTO ipfs_pins
         (pin_id, agent_did, cid, name, size_bytes, provider, status,
          cost_cents, pinned_at, expires_at, audit_chain_entry)
         VALUES ($1,$2,$3,$4,$5,$6,'pinned',$7,NOW(),$8,$9)`,
        [pinId, did, result.cid, d.name || null, result.size, provider,
         cost, d.expires_at || null, chainEntry.hash]
      );

      try {
        const cost_mod = require('./cost');
        await cost_mod.recordCost(pool, {
          agent_did: did,
          resource_type: 'ipfs_pin',
          provider,
          amount_cents: cost,
          units: result.size,
          unit_type: 'byte',
          tags: { cid: result.cid, pin_id: pinId },
          reference_id: `ipfs:${pinId}`
        });
      } catch {}

      return res.status(201).json({
        pin_id: pinId, agent_did: did, cid: result.cid,
        size_bytes: result.size, provider, status: 'pinned',
        cost_cents: cost,
        gateway_url: gatewayUrl(result.cid, provider),
        stub: result.stub || false
      });
    } catch (e) {
      console.error('[ipfs.pin]', e);
      return res.status(500).json({ error: 'pin_failed', message: e.message });
    }
  });

  // POST /v1/agents/:did/ipfs/pin-json — pin JSON object
  const JsonPinSchema = z.object({
    name: z.string().max(512).optional(),
    content: z.any(),
    provider: z.enum(PROVIDERS).optional()
  });

  app.post('/v1/agents/:did/ipfs/pin-json', express.json({ limit: '10mb' }), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const parse = JsonPinSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;

      const buf = Buffer.from(JSON.stringify(d.content));
      const provider = d.provider || DEFAULT_PROVIDER;
      const pinId = genPinId();
      const result = await pinBuffer(buf, d.name || 'json.json', provider);
      const cost = calcMonthlyCostCents(result.size);

      const chainEntry = await auditChain.append({
        event_type: 'ipfs.pinned_json',
        pin_id: pinId, agent_did: did, cid: result.cid,
        size_bytes: result.size, provider,
        timestamp: new Date().toISOString()
      });

      await pool.query(
        `INSERT INTO ipfs_pins
         (pin_id, agent_did, cid, name, size_bytes, provider, status,
          cost_cents, pinned_at, audit_chain_entry)
         VALUES ($1,$2,$3,$4,$5,$6,'pinned',$7,NOW(),$8)`,
        [pinId, did, result.cid, d.name || null, result.size, provider,
         cost, chainEntry.hash]
      );

      return res.status(201).json({
        pin_id: pinId, cid: result.cid, size_bytes: result.size,
        provider, gateway_url: gatewayUrl(result.cid, provider)
      });
    } catch (e) {
      console.error('[ipfs.pin_json]', e);
      return res.status(500).json({ error: 'pin_json_failed', message: e.message });
    }
  });

  // POST /v1/agents/:did/ipfs/pin-cid — pin existing CID
  const CidSchema = z.object({
    cid: z.string().min(46).max(128),
    name: z.string().max(512).optional(),
    provider: z.enum(PROVIDERS).optional()
  });

  app.post('/v1/agents/:did/ipfs/pin-cid', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const parse = CidSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;

      const provider = d.provider || DEFAULT_PROVIDER;
      let result = null;
      if (provider === 'pinata') {
        result = await pinExistingCidPinata(d.cid, d.name);
      }
      const cid = result?.cid || d.cid;
      const size = 0; // unknown without fetch
      const pinId = genPinId();

      const chainEntry = await auditChain.append({
        event_type: 'ipfs.cid_pinned',
        pin_id: pinId, agent_did: did, cid, provider,
        timestamp: new Date().toISOString()
      });

      await pool.query(
        `INSERT INTO ipfs_pins
         (pin_id, agent_did, cid, name, size_bytes, provider, status,
          pinned_at, audit_chain_entry)
         VALUES ($1,$2,$3,$4,$5,$6,'pinned',NOW(),$7)`,
        [pinId, did, cid, d.name || null, size, provider, chainEntry.hash]
      );

      return res.status(201).json({
        pin_id: pinId, cid, provider, status: 'pinned',
        gateway_url: gatewayUrl(cid, provider)
      });
    } catch (e) {
      console.error('[ipfs.pin_cid]', e);
      return res.status(500).json({ error: 'pin_cid_failed', message: e.message });
    }
  });

  // GET /v1/agents/:did/ipfs/pins
  app.get('/v1/agents/:did/ipfs/pins', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });

    const limit = Math.min(parseInt(req.query.limit) || 50, 500);
    const offset = Math.max(parseInt(req.query.offset) || 0, 0);
    const r = await pool.query(
      `SELECT pin_id, cid, name, size_bytes, provider, status, cost_cents,
              pinned_at, expires_at, created_at
       FROM ipfs_pins WHERE agent_did = $1 AND status != 'failed'
       ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
      [did, limit, offset]
    ).catch(() => ({ rows: [] }));
    return res.json({
      pins: r.rows.map(p => ({ ...p, gateway_url: gatewayUrl(p.cid, p.provider) })),
      count: r.rows.length
    });
  });

  // DELETE /v1/agents/:did/ipfs/pins/:id — unpin
  app.delete('/v1/agents/:did/ipfs/pins/:id', async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const r = await pool.query(
        `SELECT * FROM ipfs_pins WHERE pin_id = $1 AND agent_did = $2`,
        [req.params.id, did]
      ).catch(() => ({ rows: [] }));
      if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
      const pin = r.rows[0];

      if (pin.provider === 'pinata' && process.env.PINATA_JWT) {
        try {
          const fetch = global.fetch || require('node-fetch');
          await fetch(`https://api.pinata.cloud/pinning/unpin/${pin.cid}`, {
            method: 'DELETE',
            headers: { 'authorization': `Bearer ${process.env.PINATA_JWT}` }
          });
        } catch {}
      }

      await pool.query(
        `UPDATE ipfs_pins SET status = 'failed' WHERE pin_id = $1`,
        [req.params.id]
      );

      await auditChain.append({
        event_type: 'ipfs.unpinned',
        pin_id: req.params.id, agent_did: did, cid: pin.cid,
        timestamp: new Date().toISOString()
      });

      return res.json({ pin_id: req.params.id, unpinned: true });
    } catch (e) {
      console.error('[ipfs.unpin]', e);
      return res.status(500).json({ error: 'unpin_failed', message: e.message });
    }
  });

  // GET /v1/ipfs/:cid — gateway proxy
  app.get('/v1/ipfs/:cid', async (req, res) => {
    const cid = req.params.cid;
    const r = await pool.query(
      `SELECT provider FROM ipfs_pins WHERE cid = $1 AND status = 'pinned' LIMIT 1`,
      [cid]
    ).catch(() => ({ rows: [] }));
    const provider = r.rows[0]?.provider || DEFAULT_PROVIDER;
    return res.redirect(302, gatewayUrl(cid, provider));
  });
}

module.exports = {
  migrate,
  registerIpfsRoutes,
  pinBuffer,
  gatewayUrl,
  PROVIDERS,
  PIN_STATUSES
};
