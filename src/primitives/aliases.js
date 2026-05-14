// ============================================================================
// OpenHeab Aliases — DID alias registry (alice.openheab -> did:op:...)
// ============================================================================
const express = require('express');
const cryptoLib = require('crypto');
const { z } = require('zod');

const RESERVED = new Set([
  'admin', 'system', 'root', 'platform', 'openheab', 'support', 'help',
  'api', 'www', 'mail', 'kyc', 'bank'
]);

const NAME_REGEX = /^[a-z0-9][a-z0-9-]{1,62}$/;

// ----------------------------------------------------------------------------
// Migration
// ----------------------------------------------------------------------------
async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS did_aliases (
      name             TEXT PRIMARY KEY,
      owner_did        TEXT NOT NULL,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      reservation_tx   TEXT,
      verified         BOOLEAN NOT NULL DEFAULT FALSE
    );
    CREATE INDEX IF NOT EXISTS idx_did_aliases_owner ON did_aliases (owner_did);

    CREATE TABLE IF NOT EXISTS alias_records (
      name           TEXT NOT NULL,
      record_key     TEXT NOT NULL,
      record_value   TEXT NOT NULL,
      updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (name, record_key)
    );

    CREATE TABLE IF NOT EXISTS alias_transfers (
      transfer_id    TEXT PRIMARY KEY,
      name           TEXT NOT NULL,
      from_did       TEXT NOT NULL,
      to_did         TEXT NOT NULL,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_alias_transfers_name ON alias_transfers (name, created_at DESC);
  `).catch(() => {});
}

function genId(prefix) {
  return `${prefix}_${cryptoLib.randomBytes(12).toString('hex')}`;
}

// ----------------------------------------------------------------------------
// Routes
// ----------------------------------------------------------------------------
function registerAliasesRoutes(app, pool, verifyAgentAuth, auditChain) {
  // POST /v1/aliases — register
  const RegisterSchema = z.object({
    name: z.string().min(2).max(63),
    owner_did: z.string()
  });

  app.post('/v1/aliases', express.json(), async (req, res) => {
    try {
      const parse = RegisterSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const { name, owner_did } = parse.data;
      const lcName = name.toLowerCase();

      if (!NAME_REGEX.test(lcName)) return res.status(400).json({ error: 'invalid_name_format' });
      if (RESERVED.has(lcName)) return res.status(403).json({ error: 'reserved' });

      const auth = await verifyAgentAuth(req, owner_did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const taken = await pool.query(`SELECT name FROM did_aliases WHERE name=$1`, [lcName])
        .catch(() => ({ rows: [] }));
      if (taken.rows[0]) return res.status(409).json({ error: 'name_taken' });

      const reservationTx = genId('alias-tx');
      await pool.query(
        `INSERT INTO did_aliases (name, owner_did, reservation_tx, verified)
         VALUES ($1,$2,$3,FALSE)`,
        [lcName, owner_did, reservationTx]
      );

      await auditChain.append({
        event_type: 'aliases.registered',
        name: lcName, owner_did, reservation_tx: reservationTx,
        timestamp: new Date().toISOString()
      });

      return res.status(201).json({
        name: lcName, owner_did, reservation_tx: reservationTx, verified: false
      });
    } catch (e) {
      console.error('[aliases.register]', e);
      return res.status(500).json({ error: 'register_failed', message: e.message });
    }
  });

  // GET /v1/aliases/:name — resolve
  app.get('/v1/aliases/:name', async (req, res) => {
    const name = req.params.name.toLowerCase();
    const r = await pool.query(
      `SELECT name, owner_did, created_at, updated_at, verified FROM did_aliases WHERE name=$1`,
      [name]
    ).catch(() => ({ rows: [] }));
    if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
    const records = await pool.query(
      `SELECT record_key, record_value, updated_at FROM alias_records WHERE name=$1`,
      [name]
    ).catch(() => ({ rows: [] }));
    return res.json({ ...r.rows[0], records: records.rows });
  });

  // GET /v1/agents/:did/aliases — list by owner
  app.get('/v1/agents/:did/aliases', async (req, res) => {
    const did = req.params.did;
    const r = await pool.query(
      `SELECT name, owner_did, created_at, verified FROM did_aliases WHERE owner_did=$1 ORDER BY created_at DESC`,
      [did]
    ).catch(() => ({ rows: [] }));
    return res.json({ aliases: r.rows, count: r.rows.length });
  });

  // POST /v1/aliases/:name/transfer (owner only)
  const TransferSchema = z.object({
    to_did: z.string()
  });

  app.post('/v1/aliases/:name/transfer', express.json(), async (req, res) => {
    try {
      const name = req.params.name.toLowerCase();
      const parse = TransferSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const { to_did } = parse.data;

      const row = await pool.query(`SELECT owner_did FROM did_aliases WHERE name=$1`, [name])
        .catch(() => ({ rows: [] }));
      if (!row.rows[0]) return res.status(404).json({ error: 'not_found' });

      const owner = row.rows[0].owner_did;
      const auth = await verifyAgentAuth(req, owner);
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const transferId = genId('alxfer');
      await pool.query(
        `INSERT INTO alias_transfers (transfer_id, name, from_did, to_did)
         VALUES ($1,$2,$3,$4)`,
        [transferId, name, owner, to_did]
      );
      await pool.query(
        `UPDATE did_aliases SET owner_did=$1, updated_at=NOW() WHERE name=$2`,
        [to_did, name]
      );

      await auditChain.append({
        event_type: 'aliases.transferred',
        name, from_did: owner, to_did,
        timestamp: new Date().toISOString()
      });

      return res.json({ transfer_id: transferId, name, from_did: owner, to_did });
    } catch (e) {
      console.error('[aliases.transfer]', e);
      return res.status(500).json({ error: 'transfer_failed', message: e.message });
    }
  });

  // DELETE /v1/aliases/:name
  app.delete('/v1/aliases/:name', async (req, res) => {
    try {
      const name = req.params.name.toLowerCase();
      const row = await pool.query(`SELECT owner_did FROM did_aliases WHERE name=$1`, [name])
        .catch(() => ({ rows: [] }));
      if (!row.rows[0]) return res.status(404).json({ error: 'not_found' });

      const auth = await verifyAgentAuth(req, row.rows[0].owner_did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      await pool.query(`DELETE FROM alias_records WHERE name=$1`, [name]).catch(() => {});
      await pool.query(`DELETE FROM did_aliases WHERE name=$1`, [name]);

      await auditChain.append({
        event_type: 'aliases.deleted',
        name, owner_did: row.rows[0].owner_did,
        timestamp: new Date().toISOString()
      });

      return res.json({ deleted: true, name });
    } catch (e) {
      console.error('[aliases.delete]', e);
      return res.status(500).json({ error: 'delete_failed', message: e.message });
    }
  });

  // POST /v1/aliases/:name/text — set TXT record
  const TextSchema = z.object({
    record_key: z.string().min(1).max(128),
    record_value: z.string().max(4096)
  });

  app.post('/v1/aliases/:name/text', express.json(), async (req, res) => {
    try {
      const name = req.params.name.toLowerCase();
      const parse = TextSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const { record_key, record_value } = parse.data;

      const row = await pool.query(`SELECT owner_did FROM did_aliases WHERE name=$1`, [name])
        .catch(() => ({ rows: [] }));
      if (!row.rows[0]) return res.status(404).json({ error: 'not_found' });

      const auth = await verifyAgentAuth(req, row.rows[0].owner_did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      await pool.query(
        `INSERT INTO alias_records (name, record_key, record_value)
         VALUES ($1,$2,$3)
         ON CONFLICT (name, record_key) DO UPDATE SET
           record_value = EXCLUDED.record_value, updated_at = NOW()`,
        [name, record_key, record_value]
      );

      await auditChain.append({
        event_type: 'aliases.text_record_set',
        name, record_key,
        timestamp: new Date().toISOString()
      });

      return res.json({ name, record_key, record_value });
    } catch (e) {
      console.error('[aliases.text]', e);
      return res.status(500).json({ error: 'text_failed', message: e.message });
    }
  });
}

module.exports = {
  migrate,
  registerAliasesRoutes,
  RESERVED
};
