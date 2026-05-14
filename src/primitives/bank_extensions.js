// ============================================================================
// bank_extensions.js — Holds, spend policies, webhooks, social recovery,
//                       multi-chain provisioning for on-chain bank wallets.
// ============================================================================

const express = require('express');
const cryptoLib = require('crypto');
const { z } = require('zod');
const bankConfig = require('./bank_config');
const bankChain  = require('./bank_chain');
const { registerCron } = require('../cron_auth');

const WEBHOOK_MAX_FAILURES = parseInt(process.env.BANK_WEBHOOK_MAX_FAILURES || '8');
const WEBHOOK_BATCH_SIZE   = parseInt(process.env.BANK_WEBHOOK_BATCH_SIZE   || '50');

async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bank_holds_v2 (
      hold_id              TEXT PRIMARY KEY,
      agent_did            TEXT NOT NULL,
      beneficiary_did      TEXT,
      beneficiary_address  TEXT,
      asset                TEXT NOT NULL DEFAULT 'USDC',
      chain                TEXT NOT NULL DEFAULT 'base',
      amount_raw           NUMERIC(78,0) NOT NULL,
      status               TEXT NOT NULL DEFAULT 'active',
      reason               TEXT,
      expires_at           TIMESTAMPTZ,
      audit_hash           TEXT,
      created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      captured_at          TIMESTAMPTZ,
      released_at          TIMESTAMPTZ,
      capture_tx_hash      TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_bank_holds_v2_agent ON bank_holds_v2 (agent_did, status);
    CREATE INDEX IF NOT EXISTS idx_bank_holds_v2_expires ON bank_holds_v2 (expires_at)
      WHERE status = 'active';

    CREATE TABLE IF NOT EXISTS bank_spending_policy (
      agent_did                   TEXT PRIMARY KEY,
      daily_limit_raw             NUMERIC(78,0),
      per_tx_limit_raw            NUMERIC(78,0),
      whitelist_addresses         TEXT[],
      blacklist_addresses         TEXT[],
      require_signature_above_raw NUMERIC(78,0),
      paused                      BOOLEAN NOT NULL DEFAULT FALSE,
      updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS bank_webhooks (
      webhook_id        TEXT PRIMARY KEY,
      agent_did         TEXT NOT NULL,
      url               TEXT NOT NULL,
      secret            TEXT NOT NULL,
      event_types       TEXT[] NOT NULL DEFAULT '{}',
      active            BOOLEAN NOT NULL DEFAULT TRUE,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_delivery_at  TIMESTAMPTZ,
      failure_count     INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_bank_webhooks_agent ON bank_webhooks (agent_did);

    CREATE TABLE IF NOT EXISTS bank_webhook_deliveries (
      delivery_id      TEXT PRIMARY KEY,
      webhook_id       TEXT NOT NULL,
      event_type       TEXT NOT NULL,
      payload          JSONB NOT NULL,
      attempt          INTEGER NOT NULL DEFAULT 0,
      status           TEXT NOT NULL DEFAULT 'pending',
      response_status  INTEGER,
      response_body    TEXT,
      next_retry_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      delivered_at     TIMESTAMPTZ,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_bank_deliveries_pending
      ON bank_webhook_deliveries (status, next_retry_at)
      WHERE status IN ('pending', 'retrying');

    CREATE TABLE IF NOT EXISTS bank_recovery_requests (
      request_id        TEXT PRIMARY KEY,
      agent_did         TEXT NOT NULL,
      new_owner_did     TEXT NOT NULL,
      reason            TEXT,
      status            TEXT NOT NULL DEFAULT 'pending',
      approvals_needed  INTEGER NOT NULL DEFAULT 2,
      approvals_count   INTEGER NOT NULL DEFAULT 0,
      approver_dids     TEXT[] NOT NULL DEFAULT '{}',
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      finalized_at      TIMESTAMPTZ
    );
    CREATE TABLE IF NOT EXISTS bank_recovery_guardians (
      agent_did       TEXT NOT NULL,
      guardian_did    TEXT NOT NULL,
      added_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (agent_did, guardian_did)
    );
  `);
}

// ----- Webhook helpers -------------------------------------------------------
function newWebhookId()  { return 'whk_' + cryptoLib.randomBytes(12).toString('hex'); }
function newDeliveryId() { return 'whd_' + cryptoLib.randomBytes(12).toString('hex'); }
function newHoldId()     { return 'hld_' + cryptoLib.randomBytes(12).toString('hex'); }
function newRecoveryId() { return 'rec_' + cryptoLib.randomBytes(12).toString('hex'); }
function newSecret()     { return 'whsec_' + cryptoLib.randomBytes(24).toString('hex'); }

async function enqueueWebhookEvent(pool, agentDid, eventType, payload) {
  const hooks = await pool.query(
    `SELECT webhook_id FROM bank_webhooks
     WHERE agent_did = $1 AND active = TRUE
       AND (event_types = '{}' OR $2 = ANY(event_types))`,
    [agentDid, eventType]
  ).catch(() => ({ rows: [] }));
  for (const h of hooks.rows) {
    await pool.query(`
      INSERT INTO bank_webhook_deliveries
        (delivery_id, webhook_id, event_type, payload, attempt, status, next_retry_at, created_at)
      VALUES ($1, $2, $3, $4::jsonb, 0, 'pending', NOW(), NOW())
    `, [newDeliveryId(), h.webhook_id, eventType, JSON.stringify(payload)]).catch(() => {});
  }
  return hooks.rows.length;
}

function signWebhookPayload(secret, body) {
  return cryptoLib.createHmac('sha256', secret).update(body).digest('hex');
}

async function processWebhooks(pool, auditChain) {
  const pending = await pool.query(`
    SELECT d.delivery_id, d.webhook_id, d.event_type, d.payload, d.attempt,
           w.url, w.secret
      FROM bank_webhook_deliveries d
      JOIN bank_webhooks w ON w.webhook_id = d.webhook_id
     WHERE d.status IN ('pending','retrying')
       AND d.next_retry_at <= NOW()
       AND w.active = TRUE
     ORDER BY d.next_retry_at ASC
     LIMIT $1
  `, [WEBHOOK_BATCH_SIZE]).catch(() => ({ rows: [] }));

  let delivered = 0, failed = 0;
  for (const d of pending.rows) {
    const body = JSON.stringify({
      event_type: d.event_type,
      payload: d.payload,
      delivery_id: d.delivery_id,
      attempt: d.attempt + 1
    });
    const sig = signWebhookPayload(d.secret, body);
    let respStatus = 0, respBody = '';
    try {
      const resp = await fetch(d.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-openheab-signature': sig,
          'x-openheab-event': d.event_type
        },
        body
      });
      respStatus = resp.status;
      respBody = (await resp.text()).slice(0, 2000);
    } catch (e) {
      respStatus = 0;
      respBody = e.message;
    }
    const ok = respStatus >= 200 && respStatus < 300;
    if (ok) {
      delivered++;
      await pool.query(`
        UPDATE bank_webhook_deliveries
           SET status='delivered', delivered_at=NOW(),
               response_status=$1, response_body=$2, attempt=$3
         WHERE delivery_id=$4
      `, [respStatus, respBody, d.attempt + 1, d.delivery_id]);
      await pool.query(`
        UPDATE bank_webhooks
           SET last_delivery_at=NOW(), failure_count=0
         WHERE webhook_id=$1
      `, [d.webhook_id]);
    } else {
      failed++;
      const nextAttempt = d.attempt + 1;
      const backoffSec = Math.min(60 * Math.pow(2, nextAttempt), 3600);
      const giveUp = nextAttempt >= WEBHOOK_MAX_FAILURES;
      await pool.query(`
        UPDATE bank_webhook_deliveries
           SET status = $1,
               attempt = $2,
               response_status = $3,
               response_body = $4,
               next_retry_at = NOW() + ($5 || ' seconds')::interval
         WHERE delivery_id = $6
      `, [giveUp ? 'failed' : 'retrying', nextAttempt, respStatus, respBody, String(backoffSec), d.delivery_id]);
      await pool.query(`
        UPDATE bank_webhooks
           SET failure_count = failure_count + 1,
               active = CASE WHEN failure_count + 1 >= $1 THEN FALSE ELSE active END
         WHERE webhook_id = $2
      `, [WEBHOOK_MAX_FAILURES, d.webhook_id]);
    }
  }
  if (auditChain && (delivered + failed) > 0) {
    await auditChain.append({
      event_type: 'bank.webhook.batch_processed',
      delivered, failed, batch_size: pending.rows.length,
      timestamp: new Date().toISOString()
    });
  }
  return { delivered, failed, scanned: pending.rows.length };
}

async function expireHolds(pool, auditChain) {
  const expired = await pool.query(`
    SELECT hold_id, agent_did, amount_raw, asset, chain FROM bank_holds_v2
     WHERE status='active' AND expires_at IS NOT NULL AND expires_at <= NOW()
     LIMIT 200
  `).catch(() => ({ rows: [] }));
  let count = 0;
  for (const h of expired.rows) {
    await pool.query(`
      UPDATE bank_holds_v2
         SET status='expired', released_at=NOW()
       WHERE hold_id=$1 AND status='active'
    `, [h.hold_id]);
    await auditChain.append({
      event_type: 'bank.hold.expired',
      hold_id: h.hold_id, agent_did: h.agent_did,
      amount_raw: String(h.amount_raw), asset: h.asset, chain: h.chain,
      timestamp: new Date().toISOString()
    });
    await enqueueWebhookEvent(pool, h.agent_did, 'bank.hold.expired', {
      hold_id: h.hold_id, amount_raw: String(h.amount_raw), asset: h.asset, chain: h.chain
    });
    count++;
  }
  return { expired: count };
}

// ----- Routes ----------------------------------------------------------------
function registerBankExtensionRoutes(app, pool, verifyAgentAuth, auditChain) {
  // ---- HOLDS ---------------------------------------------------------------
  const holdSchema = z.object({
    beneficiary_did: z.string().optional(),
    beneficiary_address: z.string().regex(/^0x[a-fA-F0-9]{40}$/).optional(),
    asset: z.string().default('USDC'),
    chain: z.string().default('base'),
    amount: z.string().regex(/^\d+(\.\d+)?$/),
    reason: z.string().max(500).optional(),
    expires_in_seconds: z.number().int().positive().max(60 * 60 * 24 * 365).optional()
  }).refine(d => d.beneficiary_did || d.beneficiary_address, 'beneficiary_required');

  app.post('/v1/agents/:did/wallet/holds', express.json(), async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const parsed = holdSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: 'invalid_input', details: parsed.error.flatten() });
    const d = parsed.data;
    const assetCfg = bankConfig.getAssetConfig(d.asset, d.chain);
    if (!assetCfg) return res.status(400).json({ error: 'unsupported_asset_chain' });

    const [int, frac = ''] = d.amount.split('.');
    const fracPadded = (frac + '0'.repeat(assetCfg.decimals)).slice(0, assetCfg.decimals);
    const amountRaw = BigInt(int + fracPadded).toString();

    let beneficiaryAddress = d.beneficiary_address;
    if (!beneficiaryAddress && d.beneficiary_did) {
      const w = await pool.query(
        `SELECT address FROM bank_wallets WHERE agent_did = $1 AND chain = $2`,
        [d.beneficiary_did, d.chain]
      ).catch(() => ({ rows: [] }));
      if (w.rows[0]) beneficiaryAddress = w.rows[0].address;
    }

    const holdId = newHoldId();
    const expiresAt = d.expires_in_seconds
      ? new Date(Date.now() + d.expires_in_seconds * 1000).toISOString()
      : null;

    const audit = await auditChain.append({
      event_type: 'bank.hold.created',
      agent_did: did, hold_id: holdId, amount_raw: amountRaw,
      asset: d.asset, chain: d.chain,
      beneficiary_did: d.beneficiary_did || null,
      beneficiary_address: beneficiaryAddress || null,
      timestamp: new Date().toISOString()
    });

    await pool.query(`
      INSERT INTO bank_holds_v2
        (hold_id, agent_did, beneficiary_did, beneficiary_address,
         asset, chain, amount_raw, status, reason, expires_at, audit_hash, created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,'active',$8,$9,$10,NOW())
    `, [holdId, did, d.beneficiary_did || null, beneficiaryAddress || null,
        d.asset, d.chain, amountRaw, d.reason || null, expiresAt, audit.hash]);

    await enqueueWebhookEvent(pool, did, 'bank.hold.created',
      { hold_id: holdId, amount_raw: amountRaw, asset: d.asset, chain: d.chain });

    return res.status(201).json({
      hold_id: holdId, agent_did: did, amount_raw: amountRaw,
      asset: d.asset, chain: d.chain, expires_at: expiresAt,
      beneficiary_did: d.beneficiary_did, beneficiary_address: beneficiaryAddress
    });
  });

  app.get('/v1/agents/:did/wallet/holds', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(`
      SELECT hold_id, beneficiary_did, beneficiary_address, asset, chain,
             amount_raw, status, reason, expires_at, created_at,
             captured_at, released_at, capture_tx_hash
        FROM bank_holds_v2
       WHERE agent_did = $1
       ORDER BY created_at DESC LIMIT 500
    `, [did]).catch(() => ({ rows: [] }));
    const out = r.rows.map(x => ({ ...x, amount_raw: String(x.amount_raw) }));
    return res.json({ did, count: out.length, holds: out });
  });

  app.post('/v1/agents/:did/wallet/holds/:holdId/capture', express.json(), async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const hold = await pool.query(`SELECT * FROM bank_holds_v2 WHERE hold_id = $1`, [req.params.holdId]).catch(() => ({ rows: [] }));
    if (!hold.rows[0]) return res.status(404).json({ error: 'hold_not_found' });
    const h = hold.rows[0];
    if (h.agent_did !== did) return res.status(403).json({ error: 'hold_did_mismatch' });
    if (h.status !== 'active') return res.status(400).json({ error: 'hold_not_active' });
    if (!h.beneficiary_address) return res.status(400).json({ error: 'no_beneficiary_address' });

    const sender = await pool.query(
      `SELECT address, encrypted_key, kek_salt FROM bank_wallets WHERE agent_did = $1 AND chain = $2`,
      [did, h.chain]
    ).catch(() => ({ rows: [] }));
    if (!sender.rows[0]) return res.status(404).json({ error: 'wallet_not_found' });

    let result;
    try {
      const pk = bankChain.decryptPrivateKey(
        Buffer.from(sender.rows[0].encrypted_key),
        Buffer.from(sender.rows[0].kek_salt),
        did
      );
      result = await bankChain.broadcastTransfer({
        fromPrivKey: pk,
        fromAddress: sender.rows[0].address,
        toAddress: h.beneficiary_address,
        amountRaw: String(h.amount_raw),
        chain: h.chain,
        asset: h.asset
      });
    } catch (e) {
      return res.status(500).json({ error: 'capture_failed', message: e.message });
    }

    const audit = await auditChain.append({
      event_type: 'bank.hold.captured',
      hold_id: h.hold_id, tx_hash: result.tx_hash,
      amount_raw: String(h.amount_raw), asset: h.asset, chain: h.chain,
      timestamp: new Date().toISOString()
    });

    await pool.query(`
      UPDATE bank_holds_v2
         SET status='captured', captured_at=NOW(), capture_tx_hash=$1, audit_hash=$2
       WHERE hold_id=$3
    `, [result.tx_hash, audit.hash, h.hold_id]);

    await enqueueWebhookEvent(pool, did, 'bank.hold.captured',
      { hold_id: h.hold_id, tx_hash: result.tx_hash });

    return res.json({ hold_id: h.hold_id, captured: true, tx_hash: result.tx_hash });
  });

  app.post('/v1/agents/:did/wallet/holds/:holdId/release', express.json(), async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(`
      UPDATE bank_holds_v2 SET status='released', released_at=NOW()
       WHERE hold_id=$1 AND agent_did=$2 AND status='active' RETURNING hold_id
    `, [req.params.holdId, did]);
    if (!r.rows[0]) return res.status(404).json({ error: 'hold_not_found_or_not_active' });
    await auditChain.append({
      event_type: 'bank.hold.released', hold_id: req.params.holdId, agent_did: did,
      timestamp: new Date().toISOString()
    });
    await enqueueWebhookEvent(pool, did, 'bank.hold.released', { hold_id: req.params.holdId });
    return res.json({ hold_id: req.params.holdId, released: true });
  });

  // ---- POLICY --------------------------------------------------------------
  const policySchema = z.object({
    daily_limit_raw: z.string().regex(/^\d+$/).optional(),
    per_tx_limit_raw: z.string().regex(/^\d+$/).optional(),
    whitelist_addresses: z.array(z.string()).optional(),
    blacklist_addresses: z.array(z.string()).optional(),
    require_signature_above_raw: z.string().regex(/^\d+$/).optional(),
    paused: z.boolean().optional()
  });

  app.get('/v1/agents/:did/wallet/policy', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(`SELECT * FROM bank_spending_policy WHERE agent_did = $1`, [did]).catch(() => ({ rows: [] }));
    const row = r.rows[0];
    if (!row) return res.json({ agent_did: did, paused: false });
    return res.json({
      agent_did: row.agent_did,
      daily_limit_raw: row.daily_limit_raw == null ? null : String(row.daily_limit_raw),
      per_tx_limit_raw: row.per_tx_limit_raw == null ? null : String(row.per_tx_limit_raw),
      whitelist_addresses: row.whitelist_addresses,
      blacklist_addresses: row.blacklist_addresses,
      require_signature_above_raw: row.require_signature_above_raw == null ? null : String(row.require_signature_above_raw),
      paused: row.paused
    });
  });

  app.put('/v1/agents/:did/wallet/policy', express.json(), async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const parsed = policySchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: 'invalid_input', details: parsed.error.flatten() });
    const d = parsed.data;
    await pool.query(`
      INSERT INTO bank_spending_policy
        (agent_did, daily_limit_raw, per_tx_limit_raw, whitelist_addresses,
         blacklist_addresses, require_signature_above_raw, paused, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7,FALSE),NOW())
      ON CONFLICT (agent_did) DO UPDATE SET
        daily_limit_raw = COALESCE(EXCLUDED.daily_limit_raw, bank_spending_policy.daily_limit_raw),
        per_tx_limit_raw = COALESCE(EXCLUDED.per_tx_limit_raw, bank_spending_policy.per_tx_limit_raw),
        whitelist_addresses = COALESCE(EXCLUDED.whitelist_addresses, bank_spending_policy.whitelist_addresses),
        blacklist_addresses = COALESCE(EXCLUDED.blacklist_addresses, bank_spending_policy.blacklist_addresses),
        require_signature_above_raw = COALESCE(EXCLUDED.require_signature_above_raw, bank_spending_policy.require_signature_above_raw),
        paused = COALESCE(EXCLUDED.paused, bank_spending_policy.paused),
        updated_at = NOW()
    `, [
      did,
      d.daily_limit_raw ?? null,
      d.per_tx_limit_raw ?? null,
      d.whitelist_addresses ?? null,
      d.blacklist_addresses ?? null,
      d.require_signature_above_raw ?? null,
      d.paused ?? null
    ]);
    await auditChain.append({
      event_type: 'bank.policy.updated', agent_did: did,
      timestamp: new Date().toISOString()
    });
    return res.json({ ok: true, agent_did: did });
  });

  // ---- WEBHOOKS ------------------------------------------------------------
  const webhookSchema = z.object({
    url: z.string().url(),
    event_types: z.array(z.string()).optional()
  });

  app.post('/v1/agents/:did/wallet/webhooks', express.json(), async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const parsed = webhookSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: 'invalid_input', details: parsed.error.flatten() });
    const id = newWebhookId();
    const secret = newSecret();
    await pool.query(`
      INSERT INTO bank_webhooks (webhook_id, agent_did, url, secret, event_types)
      VALUES ($1, $2, $3, $4, $5)
    `, [id, did, parsed.data.url, secret, parsed.data.event_types || []]);
    await auditChain.append({
      event_type: 'bank.webhook.created',
      agent_did: did, webhook_id: id, url: parsed.data.url,
      timestamp: new Date().toISOString()
    });
    return res.status(201).json({
      webhook_id: id, secret, url: parsed.data.url,
      event_types: parsed.data.event_types || []
    });
  });

  app.get('/v1/agents/:did/wallet/webhooks', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(`
      SELECT webhook_id, url, event_types, active, created_at, last_delivery_at, failure_count
        FROM bank_webhooks WHERE agent_did = $1 ORDER BY created_at DESC
    `, [did]).catch(() => ({ rows: [] }));
    return res.json({ did, webhooks: r.rows });
  });

  app.delete('/v1/agents/:did/wallet/webhooks/:webhookId', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(`
      DELETE FROM bank_webhooks WHERE webhook_id = $1 AND agent_did = $2 RETURNING webhook_id
    `, [req.params.webhookId, did]);
    if (!r.rows[0]) return res.status(404).json({ error: 'webhook_not_found' });
    await auditChain.append({
      event_type: 'bank.webhook.deleted', agent_did: did,
      webhook_id: req.params.webhookId, timestamp: new Date().toISOString()
    });
    return res.json({ deleted: true, webhook_id: req.params.webhookId });
  });

  app.post('/v1/agents/:did/wallet/webhooks/:webhookId/rotate-secret', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const secret = newSecret();
    const r = await pool.query(`
      UPDATE bank_webhooks SET secret = $1 WHERE webhook_id = $2 AND agent_did = $3 RETURNING webhook_id
    `, [secret, req.params.webhookId, did]);
    if (!r.rows[0]) return res.status(404).json({ error: 'webhook_not_found' });
    await auditChain.append({
      event_type: 'bank.webhook.secret_rotated',
      agent_did: did, webhook_id: req.params.webhookId,
      timestamp: new Date().toISOString()
    });
    return res.json({ webhook_id: req.params.webhookId, secret });
  });

  // ---- SOCIAL RECOVERY ------------------------------------------------------
  const guardianSchema = z.object({ guardian_did: z.string().min(3) });
  const recoveryInitSchema = z.object({
    new_owner_did: z.string().min(3),
    reason: z.string().max(500).optional(),
    approvals_needed: z.number().int().positive().max(10).optional()
  });

  app.post('/v1/agents/:did/wallet/guardians', express.json(), async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const parsed = guardianSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: 'invalid_input', details: parsed.error.flatten() });
    await pool.query(`
      INSERT INTO bank_recovery_guardians (agent_did, guardian_did)
      VALUES ($1, $2) ON CONFLICT DO NOTHING
    `, [did, parsed.data.guardian_did]);
    await auditChain.append({
      event_type: 'bank.guardian.added', agent_did: did,
      guardian_did: parsed.data.guardian_did, timestamp: new Date().toISOString()
    });
    return res.status(201).json({ agent_did: did, guardian_did: parsed.data.guardian_did });
  });

  app.get('/v1/agents/:did/wallet/guardians', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(
      `SELECT guardian_did, added_at FROM bank_recovery_guardians WHERE agent_did = $1`,
      [did]
    ).catch(() => ({ rows: [] }));
    return res.json({ agent_did: did, guardians: r.rows });
  });

  app.post('/v1/agents/:did/wallet/recovery/initiate', express.json(), async (req, res) => {
    const did = req.params.did;
    // Initiation can be from new_owner; we treat as public-ish but require their auth
    const parsed = recoveryInitSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: 'invalid_input', details: parsed.error.flatten() });
    const newOwner = parsed.data.new_owner_did;
    const auth = await verifyAgentAuth(req, newOwner);
    if (!auth.valid) return res.status(401).json({ error: auth.error });

    const id = newRecoveryId();
    const guardianCount = await pool.query(
      `SELECT COUNT(*)::int AS n FROM bank_recovery_guardians WHERE agent_did = $1`,
      [did]
    ).catch(() => ({ rows: [{ n: 0 }] }));
    const totalGuardians = guardianCount.rows[0].n;
    const needed = parsed.data.approvals_needed || Math.max(2, Math.ceil(totalGuardians / 2));

    await pool.query(`
      INSERT INTO bank_recovery_requests
        (request_id, agent_did, new_owner_did, reason, approvals_needed)
      VALUES ($1, $2, $3, $4, $5)
    `, [id, did, newOwner, parsed.data.reason || null, needed]);

    await auditChain.append({
      event_type: 'bank.recovery.initiated',
      request_id: id, agent_did: did, new_owner_did: newOwner,
      approvals_needed: needed, timestamp: new Date().toISOString()
    });
    return res.status(201).json({
      request_id: id, agent_did: did,
      new_owner_did: newOwner, approvals_needed: needed
    });
  });

  app.post('/v1/agents/:did/wallet/recovery/:requestId/approve', express.json(), async (req, res) => {
    const did = req.params.did;
    const requestId = req.params.requestId;
    // Guardian must sign
    const guardianDid = (req.body && req.body.guardian_did) || null;
    if (!guardianDid) return res.status(400).json({ error: 'guardian_did_required' });
    const auth = await verifyAgentAuth(req, guardianDid, { strictSignatureRequired: true });
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const isGuardian = await pool.query(
      `SELECT 1 FROM bank_recovery_guardians WHERE agent_did = $1 AND guardian_did = $2`,
      [did, guardianDid]
    ).catch(() => ({ rows: [] }));
    if (!isGuardian.rows[0]) return res.status(403).json({ error: 'not_a_guardian' });

    const r = await pool.query(`
      UPDATE bank_recovery_requests
         SET approver_dids = ARRAY(SELECT DISTINCT unnest(approver_dids || ARRAY[$1]::text[])),
             approvals_count = array_length(ARRAY(SELECT DISTINCT unnest(approver_dids || ARRAY[$1]::text[])), 1)
       WHERE request_id = $2 AND agent_did = $3 AND status = 'pending'
       RETURNING approvals_count, approvals_needed, new_owner_did
    `, [guardianDid, requestId, did]);
    if (!r.rows[0]) return res.status(404).json({ error: 'request_not_found_or_finalized' });
    await auditChain.append({
      event_type: 'bank.recovery.approved',
      request_id: requestId, agent_did: did,
      guardian_did: guardianDid,
      approvals_count: r.rows[0].approvals_count,
      approvals_needed: r.rows[0].approvals_needed,
      timestamp: new Date().toISOString()
    });
    return res.json({
      request_id: requestId, agent_did: did,
      approvals_count: r.rows[0].approvals_count,
      approvals_needed: r.rows[0].approvals_needed
    });
  });

  app.post('/v1/agents/:did/wallet/recovery/:requestId/finalize', express.json(), async (req, res) => {
    const did = req.params.did;
    const requestId = req.params.requestId;
    const r = await pool.query(`
      SELECT agent_did, new_owner_did, approvals_count, approvals_needed, status
        FROM bank_recovery_requests WHERE request_id = $1 AND agent_did = $2
    `, [requestId, did]).catch(() => ({ rows: [] }));
    if (!r.rows[0]) return res.status(404).json({ error: 'request_not_found' });
    if (r.rows[0].status !== 'pending') return res.status(400).json({ error: 'already_finalized' });
    if (Number(r.rows[0].approvals_count) < Number(r.rows[0].approvals_needed)) {
      return res.status(400).json({ error: 'insufficient_approvals' });
    }
    const newOwner = r.rows[0].new_owner_did;
    const auth = await verifyAgentAuth(req, newOwner, { strictSignatureRequired: true });
    if (!auth.valid) return res.status(401).json({ error: auth.error });

    // Reassign wallets to new owner DID
    await pool.query(`
      UPDATE bank_wallets SET agent_did = $1 WHERE agent_did = $2
    `, [newOwner, did]);
    await pool.query(`
      UPDATE bank_recovery_requests SET status='finalized', finalized_at=NOW() WHERE request_id=$1
    `, [requestId]);

    await auditChain.append({
      event_type: 'bank.recovery.finalized',
      request_id: requestId, previous_did: did, new_did: newOwner,
      timestamp: new Date().toISOString()
    });
    return res.json({ request_id: requestId, finalized: true, new_did: newOwner });
  });

  // ---- MULTI-CHAIN ---------------------------------------------------------
  app.post('/v1/agents/:did/wallet/multichain/provision', express.json(), async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const chain = (req.body && req.body.chain) || null;
    if (!chain) return res.status(400).json({ error: 'chain_required' });
    if (!bankConfig.getChainConfig(chain)) return res.status(400).json({ error: 'unsupported_chain' });
    try {
      const w = await bankChain.provisionWallet(pool, auditChain, did, chain);
      return res.status(201).json(w);
    } catch (e) {
      return res.status(500).json({ error: 'provision_failed', message: e.message });
    }
  });

  app.get('/v1/agents/:did/wallet/multichain', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(`
      SELECT chain, address, created_at FROM bank_wallets WHERE agent_did = $1 ORDER BY created_at ASC
    `, [did]).catch(() => ({ rows: [] }));
    return res.json({ did, wallets: r.rows });
  });

  // ---- BANK ASSETS LISTING --------------------------------------------------
  app.get('/v1/bank/assets', async (req, res) => {
    const chain = req.query.chain;
    return res.json({
      assets: bankConfig.listSupportedAssets(chain),
      chains: bankConfig.listSupportedChains()
    });
  });

  // ---- CRON JOBS ------------------------------------------------------------
  registerCron(app, '/v1/_jobs/process-bank-webhooks', async (req, res) => {
    try {
      const r = await processWebhooks(pool, auditChain);
      return res.json(r);
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  });

  registerCron(app, '/v1/_jobs/expire-holds', async (req, res) => {
    try {
      const r = await expireHolds(pool, auditChain);
      return res.json(r);
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  });
}

module.exports = {
  migrate,
  registerBankExtensionRoutes,
  enqueueWebhookEvent,
  processWebhooks,
  expireHolds
};
