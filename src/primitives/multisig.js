// ============================================================================
// OpenHeab Multisig — N-of-M multi-signature wallets for agent DAOs
//
// Each multisig has M signer DIDs and requires N signatures to execute.
// Proposals collect signatures over canonical `MULTISIG|proposal_id|target|amount|data`
// using each signer's current Ed25519 identity key. Once threshold met, the
// proposal is executable. On-chain broadcast hooks into bank_chain when wired.
// ============================================================================

const express = require('express');
const cryptoLib = require('crypto');
const { z } = require('zod');

const PROPOSAL_STATUSES = ['pending', 'approved', 'executed', 'rejected', 'expired'];
const DEFAULT_PROPOSAL_TTL_HOURS = 168; // 7 days

// ----------------------------------------------------------------------------
// Migration
// ----------------------------------------------------------------------------
async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS multisig_wallets (
      wallet_id        TEXT PRIMARY KEY,
      name             TEXT NOT NULL,
      chain            TEXT NOT NULL DEFAULT 'base',
      address          TEXT,
      threshold        INTEGER NOT NULL,
      signers          TEXT[] NOT NULL,
      created_by_did   TEXT NOT NULL,
      metadata         JSONB,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_multisig_wallets_creator
      ON multisig_wallets (created_by_did);
    CREATE INDEX IF NOT EXISTS idx_multisig_wallets_signers
      ON multisig_wallets USING GIN (signers);

    CREATE TABLE IF NOT EXISTS multisig_proposals (
      proposal_id      TEXT PRIMARY KEY,
      wallet_id        TEXT NOT NULL,
      proposer_did     TEXT NOT NULL,
      target_address   TEXT NOT NULL,
      amount_raw       NUMERIC(78,0) NOT NULL DEFAULT 0,
      asset            TEXT NOT NULL DEFAULT 'USDC',
      data_hex         TEXT,
      description      TEXT,
      status           TEXT NOT NULL DEFAULT 'pending',
      signatures       JSONB NOT NULL DEFAULT '[]'::jsonb,
      threshold        INTEGER NOT NULL,
      executed_at      TIMESTAMPTZ,
      rejected_at      TIMESTAMPTZ,
      tx_hash          TEXT,
      expires_at       TIMESTAMPTZ,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_multisig_proposals_wallet
      ON multisig_proposals (wallet_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_multisig_proposals_status
      ON multisig_proposals (status, created_at DESC);
  `).catch(() => {});
}

function genId(prefix) {
  return `${prefix}_${cryptoLib.randomBytes(12).toString('hex')}`;
}

function canonicalProposalMessage(proposalId, targetAddress, amountRaw, dataHex) {
  return `MULTISIG|${proposalId}|${targetAddress}|${amountRaw}|${dataHex || ''}`;
}

async function verifySignerSig(pool, signerDid, message, signatureHex) {
  const keyRow = await pool.query(
    `SELECT public_key FROM identity_keys
      WHERE agent_did = $1 AND status = 'active'
      UNION ALL
      SELECT public_key FROM identities WHERE did = $1 LIMIT 1`,
    [signerDid]
  ).catch(() => ({ rows: [] }));
  if (!keyRow.rows[0]) return false;
  try {
    const pubKey = cryptoLib.createPublicKey(keyRow.rows[0].public_key);
    return cryptoLib.verify(null, Buffer.from(message),
      pubKey, Buffer.from(signatureHex, 'hex'));
  } catch {
    return false;
  }
}

// ----------------------------------------------------------------------------
// Routes
// ----------------------------------------------------------------------------
function registerMultisigRoutes(app, pool, verifyAgentAuth, auditChain) {
  // POST /v1/multisig/wallets — create wallet
  const CreateWalletSchema = z.object({
    creator_did: z.string(),
    name: z.string().min(1).max(200),
    chain: z.string().default('base'),
    threshold: z.number().int().positive(),
    signers: z.array(z.string()).min(1).max(20),
    address: z.string().optional(),
    metadata: z.record(z.any()).optional()
  });

  app.post('/v1/multisig/wallets', express.json(), async (req, res) => {
    try {
      const parse = CreateWalletSchema.safeParse(req.body || {});
      if (!parse.success) {
        return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      }
      const d = parse.data;
      if (d.threshold > d.signers.length) {
        return res.status(400).json({ error: 'threshold_exceeds_signers' });
      }
      const auth = await verifyAgentAuth(req, d.creator_did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      if (!d.signers.includes(d.creator_did)) {
        return res.status(400).json({ error: 'creator_must_be_signer' });
      }

      const walletId = genId('msw');
      await pool.query(
        `INSERT INTO multisig_wallets
           (wallet_id, name, chain, address, threshold, signers, created_by_did, metadata)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
        [walletId, d.name, d.chain, d.address || null, d.threshold, d.signers,
         d.creator_did, JSON.stringify(d.metadata || {})]
      );

      await auditChain.append({
        event_type: 'multisig.wallet.created',
        wallet_id: walletId, creator_did: d.creator_did,
        chain: d.chain, threshold: d.threshold, signer_count: d.signers.length,
        timestamp: new Date().toISOString()
      });

      return res.status(201).json({
        wallet_id: walletId, name: d.name, chain: d.chain,
        threshold: d.threshold, signers: d.signers, address: d.address || null
      });
    } catch (e) {
      console.error('[multisig.create]', e);
      return res.status(500).json({ error: 'create_failed', message: e.message });
    }
  });

  // GET /v1/multisig/wallets — list wallets where caller is signer
  app.get('/v1/multisig/wallets', async (req, res) => {
    const did = req.query.did;
    if (!did) return res.status(400).json({ error: 'did_required' });
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(
      `SELECT wallet_id, name, chain, address, threshold, signers,
              created_by_did, metadata, created_at
         FROM multisig_wallets
        WHERE $1 = ANY(signers)
        ORDER BY created_at DESC LIMIT 500`,
      [did]
    ).catch(() => ({ rows: [] }));
    return res.json({ count: r.rows.length, wallets: r.rows });
  });

  // GET /v1/multisig/wallets/:id
  app.get('/v1/multisig/wallets/:id', async (req, res) => {
    const r = await pool.query(
      `SELECT * FROM multisig_wallets WHERE wallet_id=$1`, [req.params.id]
    ).catch(() => ({ rows: [] }));
    if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
    return res.json(r.rows[0]);
  });

  // POST /v1/multisig/wallets/:id/proposals — propose
  const ProposeSchema = z.object({
    proposer_did: z.string(),
    target_address: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
    amount_raw: z.string().regex(/^\d+$/).default('0'),
    asset: z.string().default('USDC'),
    data_hex: z.string().regex(/^0x[a-fA-F0-9]*$/).optional(),
    description: z.string().max(2000).optional(),
    ttl_hours: z.number().int().positive().max(8760).optional()
  });

  app.post('/v1/multisig/wallets/:id/proposals', express.json(), async (req, res) => {
    try {
      const parse = ProposeSchema.safeParse(req.body || {});
      if (!parse.success) {
        return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      }
      const d = parse.data;
      const auth = await verifyAgentAuth(req, d.proposer_did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const wallet = await pool.query(
        `SELECT signers, threshold FROM multisig_wallets WHERE wallet_id=$1`,
        [req.params.id]
      ).catch(() => ({ rows: [] }));
      if (!wallet.rows[0]) return res.status(404).json({ error: 'wallet_not_found' });
      if (!wallet.rows[0].signers.includes(d.proposer_did)) {
        return res.status(403).json({ error: 'not_a_signer' });
      }

      const proposalId = genId('msp');
      const ttl = d.ttl_hours || DEFAULT_PROPOSAL_TTL_HOURS;
      const expiresAt = new Date(Date.now() + ttl * 3600 * 1000);

      await pool.query(
        `INSERT INTO multisig_proposals
           (proposal_id, wallet_id, proposer_did, target_address, amount_raw, asset,
            data_hex, description, threshold, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [proposalId, req.params.id, d.proposer_did, d.target_address, d.amount_raw,
         d.asset, d.data_hex || null, d.description || null,
         wallet.rows[0].threshold, expiresAt]
      );

      await auditChain.append({
        event_type: 'multisig.proposal.created',
        proposal_id: proposalId, wallet_id: req.params.id,
        proposer_did: d.proposer_did, target_address: d.target_address,
        amount_raw: d.amount_raw, timestamp: new Date().toISOString()
      });

      const canonical = canonicalProposalMessage(
        proposalId, d.target_address, d.amount_raw, d.data_hex
      );

      return res.status(201).json({
        proposal_id: proposalId, wallet_id: req.params.id,
        target_address: d.target_address, amount_raw: d.amount_raw,
        asset: d.asset, status: 'pending', threshold: wallet.rows[0].threshold,
        signature_canonical: canonical, expires_at: expiresAt.toISOString()
      });
    } catch (e) {
      console.error('[multisig.propose]', e);
      return res.status(500).json({ error: 'propose_failed', message: e.message });
    }
  });

  // POST /v1/multisig/proposals/:id/sign
  const SignSchema = z.object({
    signer_did: z.string(),
    signature: z.string().regex(/^[0-9a-fA-F]+$/)
  });

  app.post('/v1/multisig/proposals/:id/sign', express.json(), async (req, res) => {
    try {
      const parse = SignSchema.safeParse(req.body || {});
      if (!parse.success) {
        return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      }
      const { signer_did, signature } = parse.data;
      const auth = await verifyAgentAuth(req, signer_did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const prop = await pool.query(
        `SELECT p.*, w.signers, w.threshold AS wallet_threshold
           FROM multisig_proposals p
           JOIN multisig_wallets w ON w.wallet_id = p.wallet_id
          WHERE p.proposal_id=$1`,
        [req.params.id]
      ).catch(() => ({ rows: [] }));
      if (!prop.rows[0]) return res.status(404).json({ error: 'not_found' });
      const p = prop.rows[0];
      if (p.status !== 'pending') return res.status(400).json({ error: 'not_pending', status: p.status });
      if (p.expires_at && new Date(p.expires_at) < new Date()) {
        await pool.query(`UPDATE multisig_proposals SET status='expired' WHERE proposal_id=$1`,
          [req.params.id]).catch(() => {});
        return res.status(400).json({ error: 'expired' });
      }
      if (!p.signers.includes(signer_did)) {
        return res.status(403).json({ error: 'not_a_signer' });
      }

      const existing = Array.isArray(p.signatures) ? p.signatures : [];
      if (existing.find(s => s.signer_did === signer_did)) {
        return res.status(409).json({ error: 'already_signed' });
      }

      const canonical = canonicalProposalMessage(
        p.proposal_id, p.target_address, String(p.amount_raw), p.data_hex
      );
      const sigValid = await verifySignerSig(pool, signer_did, canonical, signature);
      if (!sigValid) return res.status(400).json({ error: 'invalid_signature' });

      const updated = existing.concat([{
        signer_did, signature, signed_at: new Date().toISOString()
      }]);
      const becomesApproved = updated.length >= p.wallet_threshold;
      const newStatus = becomesApproved ? 'approved' : 'pending';

      await pool.query(
        `UPDATE multisig_proposals SET signatures=$1::jsonb, status=$2
          WHERE proposal_id=$3`,
        [JSON.stringify(updated), newStatus, req.params.id]
      );

      await auditChain.append({
        event_type: 'multisig.proposal.signed',
        proposal_id: req.params.id, signer_did,
        signature_count: updated.length, threshold: p.wallet_threshold,
        approved: becomesApproved, timestamp: new Date().toISOString()
      });

      return res.json({
        proposal_id: req.params.id, status: newStatus,
        signature_count: updated.length, threshold: p.wallet_threshold
      });
    } catch (e) {
      console.error('[multisig.sign]', e);
      return res.status(500).json({ error: 'sign_failed', message: e.message });
    }
  });

  // POST /v1/multisig/proposals/:id/execute
  app.post('/v1/multisig/proposals/:id/execute', express.json(), async (req, res) => {
    try {
      const actorDid = (req.body && req.body.actor_did) || null;
      if (!actorDid) return res.status(400).json({ error: 'actor_did_required' });
      const auth = await verifyAgentAuth(req, actorDid);
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const prop = await pool.query(
        `SELECT p.*, w.signers, w.chain
           FROM multisig_proposals p
           JOIN multisig_wallets w ON w.wallet_id = p.wallet_id
          WHERE p.proposal_id=$1`,
        [req.params.id]
      ).catch(() => ({ rows: [] }));
      if (!prop.rows[0]) return res.status(404).json({ error: 'not_found' });
      const p = prop.rows[0];
      if (p.status !== 'approved') {
        return res.status(400).json({ error: 'not_approved', status: p.status });
      }
      if (!p.signers.includes(actorDid)) {
        return res.status(403).json({ error: 'not_a_signer' });
      }

      // Stubbed on-chain execution; real broadcast would call bank_chain.
      const txHash = '0x' + cryptoLib.createHash('sha256')
        .update(`${p.proposal_id}|${p.target_address}|${p.amount_raw}|${Date.now()}`)
        .digest('hex');

      await pool.query(
        `UPDATE multisig_proposals
            SET status='executed', executed_at=NOW(), tx_hash=$1
          WHERE proposal_id=$2`,
        [txHash, req.params.id]
      );

      await auditChain.append({
        event_type: 'multisig.proposal.executed',
        proposal_id: req.params.id, wallet_id: p.wallet_id,
        tx_hash: txHash, amount_raw: String(p.amount_raw),
        target_address: p.target_address, timestamp: new Date().toISOString()
      });

      return res.json({
        proposal_id: req.params.id, status: 'executed',
        tx_hash: txHash, chain: p.chain
      });
    } catch (e) {
      console.error('[multisig.execute]', e);
      return res.status(500).json({ error: 'execute_failed', message: e.message });
    }
  });

  // POST /v1/multisig/proposals/:id/reject
  app.post('/v1/multisig/proposals/:id/reject', express.json(), async (req, res) => {
    try {
      const actorDid = (req.body && req.body.actor_did) || null;
      const reason = (req.body && req.body.reason) || null;
      if (!actorDid) return res.status(400).json({ error: 'actor_did_required' });
      const auth = await verifyAgentAuth(req, actorDid);
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const prop = await pool.query(
        `SELECT p.status, w.signers, p.wallet_id
           FROM multisig_proposals p
           JOIN multisig_wallets w ON w.wallet_id = p.wallet_id
          WHERE p.proposal_id=$1`,
        [req.params.id]
      ).catch(() => ({ rows: [] }));
      if (!prop.rows[0]) return res.status(404).json({ error: 'not_found' });
      if (!['pending', 'approved'].includes(prop.rows[0].status)) {
        return res.status(400).json({ error: 'not_rejectable', status: prop.rows[0].status });
      }
      if (!prop.rows[0].signers.includes(actorDid)) {
        return res.status(403).json({ error: 'not_a_signer' });
      }

      await pool.query(
        `UPDATE multisig_proposals SET status='rejected', rejected_at=NOW()
          WHERE proposal_id=$1`,
        [req.params.id]
      );

      await auditChain.append({
        event_type: 'multisig.proposal.rejected',
        proposal_id: req.params.id, actor_did: actorDid, reason,
        timestamp: new Date().toISOString()
      });

      return res.json({ proposal_id: req.params.id, status: 'rejected' });
    } catch (e) {
      console.error('[multisig.reject]', e);
      return res.status(500).json({ error: 'reject_failed', message: e.message });
    }
  });

  // GET /v1/multisig/proposals — filter
  app.get('/v1/multisig/proposals', async (req, res) => {
    const status = req.query.status;
    const walletId = req.query.wallet_id;
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    const params = [];
    const conds = [];
    if (status) { params.push(status); conds.push(`status = $${params.length}`); }
    if (walletId) { params.push(walletId); conds.push(`wallet_id = $${params.length}`); }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    params.push(limit);
    const r = await pool.query(
      `SELECT proposal_id, wallet_id, proposer_did, target_address, amount_raw,
              asset, status, threshold, signatures, executed_at, tx_hash,
              expires_at, created_at
         FROM multisig_proposals
         ${where}
         ORDER BY created_at DESC LIMIT $${params.length}`,
      params
    ).catch(() => ({ rows: [] }));
    const proposals = r.rows.map(p => ({
      ...p, amount_raw: String(p.amount_raw),
      signature_count: Array.isArray(p.signatures) ? p.signatures.length : 0
    }));
    return res.json({ count: proposals.length, proposals });
  });

  // Cron: expire stale proposals
  const { registerCron } = require('../cron_auth');
  registerCron(app, '/v1/_jobs/multisig-expire', async (req, res) => {
    try {
      const r = await pool.query(
        `UPDATE multisig_proposals SET status='expired'
          WHERE status='pending' AND expires_at IS NOT NULL AND expires_at < NOW()
        RETURNING proposal_id`
      ).catch(() => ({ rows: [] }));
      res.json({ expired: r.rows.length });
    } catch (e) {
      res.status(500).json({ error: 'expire_failed', message: e.message });
    }
  });
}

module.exports = {
  migrate,
  registerMultisigRoutes,
  canonicalProposalMessage,
  PROPOSAL_STATUSES
};
