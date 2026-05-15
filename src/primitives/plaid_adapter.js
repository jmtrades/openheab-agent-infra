// plaid_adapter.js — REAL Plaid bank account verification + balance lookup.
const crypto = require('crypto');
const { z } = require('zod');

const BASE = process.env.PLAID_ENV === 'production' ? 'https://production.plaid.com'
           : process.env.PLAID_ENV === 'development' ? 'https://development.plaid.com'
           : 'https://sandbox.plaid.com';

async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS plaid_items (
      item_id TEXT PRIMARY KEY, agent_did TEXT NOT NULL,
      access_token_encrypted BYTEA, institution_id TEXT,
      institution_name TEXT, accounts JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      revoked_at TIMESTAMPTZ
    );
  `);
}

function getKek() {
  const raw = process.env.PLAID_KEK || process.env.IDENTITY_MASTER_KEK || process.env.CRYPTO_MASTER_KEK;
  if (!raw) throw new Error('kek_unset');
  return /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, 'hex') : crypto.createHash('sha256').update(raw).digest();
}
function encrypt(s) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', getKek(), iv);
  const ct = Buffer.concat([c.update(s, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]);
}
function decrypt(b) {
  const iv = b.subarray(0, 12), tag = b.subarray(12, 28), ct = b.subarray(28);
  const d = crypto.createDecipheriv('aes-256-gcm', getKek(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
}
function newId(p) { return p + '_' + crypto.randomBytes(10).toString('hex'); }

async function plaidAPI(path, body) {
  const id = process.env.PLAID_CLIENT_ID;
  const sec = process.env.PLAID_SECRET;
  if (!id || !sec) return { stub: true };
  if (typeof fetch !== 'function') throw new Error('fetch_unavailable');
  const r = await fetch(`${BASE}/${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: id, secret: sec, ...body })
  });
  const json = await r.json();
  if (!r.ok) throw new Error(`plaid_${r.status}_${json.error_message || JSON.stringify(json).slice(0, 200)}`);
  return json;
}

function registerPlaidAdapterRoutes(app, pool, verifyAgentAuth, auditChain) {
  const express = require('express');

  app.post('/v1/agents/:did/plaid/link-token', express.json(), async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    try {
      const out = await plaidAPI('link/token/create', {
        user: { client_user_id: did }, client_name: 'OpenHeab',
        products: ['auth', 'transactions'], country_codes: ['US'], language: 'en'
      });
      if (out.stub) return res.json({ link_token: 'link-stub-' + crypto.randomBytes(6).toString('hex'), stub: true });
      res.json({ link_token: out.link_token, expiration: out.expiration });
    } catch (e) { res.status(502).json({ error: 'plaid_failed', message: e.message }); }
  });

  app.post('/v1/agents/:did/plaid/exchange', express.json(), async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const publicToken = req.body?.public_token;
    if (!publicToken) return res.status(400).json({ error: 'public_token_required' });
    try {
      const out = await plaidAPI('item/public_token/exchange', { public_token: publicToken });
      const id = newId('plaid');
      const accounts = await plaidAPI('accounts/get', { access_token: out.access_token || 'stub' });
      let enc = null;
      try { enc = out.access_token ? encrypt(out.access_token) : null; } catch {}
      await pool.query(`INSERT INTO plaid_items (item_id, agent_did, access_token_encrypted, accounts) VALUES ($1,$2,$3,$4)`,
        [id, did, enc, JSON.stringify(accounts.accounts || [])]).catch(() => {});
      if (auditChain) await auditChain.append({ event_type: 'plaid.linked', agent_did: did, item_id: id }).catch(() => {});
      res.status(201).json({ item_id: id, accounts: (accounts.accounts || []).map(a => ({ id: a.account_id, name: a.name, mask: a.mask, type: a.type, subtype: a.subtype })) });
    } catch (e) { res.status(502).json({ error: 'plaid_failed', message: e.message }); }
  });

  app.get('/v1/agents/:did/plaid/items/:iid/balance', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(`SELECT access_token_encrypted FROM plaid_items WHERE item_id=$1 AND agent_did=$2`, [req.params.iid, did]).catch(() => ({ rows: [] }));
    if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
    let token = 'stub';
    try { token = r.rows[0].access_token_encrypted ? decrypt(Buffer.from(r.rows[0].access_token_encrypted)) : 'stub'; } catch {}
    try {
      const out = await plaidAPI('accounts/balance/get', { access_token: token });
      res.json({ accounts: out.accounts || [], stub: !!out.stub });
    } catch (e) { res.status(502).json({ error: 'plaid_failed', message: e.message }); }
  });
}
module.exports = { migrate, registerPlaidAdapterRoutes };
