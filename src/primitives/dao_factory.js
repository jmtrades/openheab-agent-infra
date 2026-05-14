// ============================================================================
// OpenHeab DAO Factory — Token-weighted DAO creation + governance toolkit
// ============================================================================
const express = require('express');
const cryptoLib = require('crypto');
const { z } = require('zod');

const PROPOSAL_ACTION_TYPES = ['transfer', 'contract_call', 'parameter_change', 'text'];
const PROPOSAL_STATUSES = ['pending', 'active', 'passed', 'rejected', 'executed', 'expired'];

async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS daos (
      dao_id                    TEXT PRIMARY KEY,
      name                      TEXT NOT NULL,
      description               TEXT,
      founder_did               TEXT NOT NULL,
      governance_token_id       TEXT,
      treasury_address          TEXT,
      voting_period_days        INTEGER NOT NULL DEFAULT 7,
      quorum_pct                REAL NOT NULL DEFAULT 10,
      proposal_threshold_tokens NUMERIC(78,0) DEFAULT 0,
      chain                     TEXT NOT NULL DEFAULT 'base',
      contract_address          TEXT,
      created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_daos_founder ON daos (founder_did);

    CREATE TABLE IF NOT EXISTS dao_members (
      dao_id        TEXT NOT NULL,
      member_did    TEXT NOT NULL,
      address       TEXT,
      tokens_held   NUMERIC(78,0) NOT NULL DEFAULT 0,
      joined_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (dao_id, member_did)
    );
    CREATE INDEX IF NOT EXISTS idx_dao_members_did ON dao_members (member_did);

    CREATE TABLE IF NOT EXISTS dao_proposals (
      proposal_id      TEXT PRIMARY KEY,
      dao_id           TEXT NOT NULL,
      proposer_did     TEXT NOT NULL,
      title            TEXT NOT NULL,
      description      TEXT,
      action_type      TEXT NOT NULL DEFAULT 'text',
      action_payload   JSONB DEFAULT '{}'::jsonb,
      status           TEXT NOT NULL DEFAULT 'pending',
      yes_votes        NUMERIC(78,0) NOT NULL DEFAULT 0,
      no_votes         NUMERIC(78,0) NOT NULL DEFAULT 0,
      voting_ends_at   TIMESTAMPTZ,
      executed_tx      TEXT,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_dao_proposals_dao ON dao_proposals (dao_id);
    CREATE INDEX IF NOT EXISTS idx_dao_proposals_status ON dao_proposals (status);

    CREATE TABLE IF NOT EXISTS dao_votes (
      vote_id       TEXT PRIMARY KEY,
      proposal_id   TEXT NOT NULL,
      voter_did     TEXT NOT NULL,
      choice        TEXT NOT NULL,
      weight        NUMERIC(78,0) NOT NULL,
      voted_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (proposal_id, voter_did)
    );

    CREATE TABLE IF NOT EXISTS dao_treasury_transactions (
      tx_id          TEXT PRIMARY KEY,
      dao_id         TEXT NOT NULL,
      proposal_id    TEXT,
      direction      TEXT NOT NULL,
      amount_raw     NUMERIC(78,0) NOT NULL,
      token          TEXT,
      counterparty   TEXT,
      tx_hash        TEXT,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_dao_treasury_dao ON dao_treasury_transactions (dao_id);
  `).catch(() => {});
}

function genId(prefix) {
  return `${prefix}_${cryptoLib.randomBytes(12).toString('hex')}`;
}

function registerDaoFactoryRoutes(app, pool, verifyAgentAuth, auditChain) {
  const CreateDaoSchema = z.object({
    name: z.string().min(1).max(300),
    description: z.string().max(5000).optional(),
    voting_period_days: z.number().int().min(1).max(365).optional(),
    quorum_pct: z.number().min(0).max(100).optional(),
    proposal_threshold_tokens: z.string().optional(),
    chain: z.string().optional(),
    token_symbol: z.string().max(20).optional(),
    initial_supply: z.string().optional()
  });

  app.post('/v1/dao/create', express.json(), async (req, res) => {
    try {
      const did = req.headers['x-agent-did'];
      if (!did) return res.status(401).json({ error: 'missing_did_header' });
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const parse = CreateDaoSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;
      const daoId = genId('dao');
      const tokenId = genId('tok'); // stub link to tokens primitive
      const treasuryAddress = `0x${cryptoLib.randomBytes(20).toString('hex')}`; // stub multisig
      await pool.query(
        `INSERT INTO daos (dao_id, name, description, founder_did, governance_token_id,
           treasury_address, voting_period_days, quorum_pct, proposal_threshold_tokens, chain)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [daoId, d.name, d.description || null, did, tokenId, treasuryAddress,
         d.voting_period_days || 7, d.quorum_pct || 10, d.proposal_threshold_tokens || '0', d.chain || 'base']
      );
      // Founder bootstrap membership
      await pool.query(
        `INSERT INTO dao_members (dao_id, member_did, tokens_held) VALUES ($1,$2,$3)
         ON CONFLICT DO NOTHING`,
        [daoId, did, d.initial_supply || '1000000']
      ).catch(() => {});
      await auditChain.append({ event_type: 'dao.created', dao_id: daoId, founder_did: did, token_id: tokenId, timestamp: new Date().toISOString() });
      return res.status(201).json({ dao_id: daoId, founder_did: did, governance_token_id: tokenId, treasury_address: treasuryAddress });
    } catch (e) { return res.status(500).json({ error: 'create_failed', message: e.message }); }
  });

  app.get('/v1/dao', async (req, res) => {
    const r = await pool.query(`SELECT * FROM daos ORDER BY created_at DESC LIMIT 500`).catch(() => ({ rows: [] }));
    return res.json({ daos: r.rows, count: r.rows.length });
  });

  app.get('/v1/dao/:id', async (req, res) => {
    const dao = await pool.query(`SELECT * FROM daos WHERE dao_id=$1`, [req.params.id]).catch(() => ({ rows: [] }));
    if (!dao.rows[0]) return res.status(404).json({ error: 'not_found' });
    const members = await pool.query(`SELECT COUNT(*)::int AS n FROM dao_members WHERE dao_id=$1`, [req.params.id]).catch(() => ({ rows: [{ n: 0 }] }));
    const proposals = await pool.query(`SELECT COUNT(*)::int AS n FROM dao_proposals WHERE dao_id=$1`, [req.params.id]).catch(() => ({ rows: [{ n: 0 }] }));
    return res.json({ ...dao.rows[0], member_count: members.rows[0].n, proposal_count: proposals.rows[0].n });
  });

  const ProposalSchema = z.object({
    title: z.string().min(1).max(300),
    description: z.string().max(20000).optional(),
    action_type: z.enum(PROPOSAL_ACTION_TYPES).optional(),
    action_payload: z.record(z.any()).optional()
  });

  app.post('/v1/dao/:id/proposals', express.json(), async (req, res) => {
    try {
      const did = req.headers['x-agent-did'];
      if (!did) return res.status(401).json({ error: 'missing_did_header' });
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const parse = ProposalSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;
      const dao = await pool.query(`SELECT * FROM daos WHERE dao_id=$1`, [req.params.id]).catch(() => ({ rows: [] }));
      if (!dao.rows[0]) return res.status(404).json({ error: 'dao_not_found' });
      // Proposer must hold >= threshold
      const member = await pool.query(`SELECT tokens_held FROM dao_members WHERE dao_id=$1 AND member_did=$2`, [req.params.id, did]).catch(() => ({ rows: [] }));
      const heldStr = member.rows[0]?.tokens_held || '0';
      if (BigInt(heldStr) < BigInt(dao.rows[0].proposal_threshold_tokens || '0')) {
        return res.status(403).json({ error: 'below_proposal_threshold' });
      }
      const proposalId = genId('prop');
      const votingEnds = new Date(Date.now() + (dao.rows[0].voting_period_days * 86400 * 1000)).toISOString();
      await pool.query(
        `INSERT INTO dao_proposals (proposal_id, dao_id, proposer_did, title, description,
           action_type, action_payload, status, voting_ends_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,'active',$8)`,
        [proposalId, req.params.id, did, d.title, d.description || null,
         d.action_type || 'text', JSON.stringify(d.action_payload || {}), votingEnds]
      );
      await auditChain.append({ event_type: 'dao.proposal_created', proposal_id: proposalId, dao_id: req.params.id, proposer_did: did, timestamp: new Date().toISOString() });
      return res.status(201).json({ proposal_id: proposalId, dao_id: req.params.id, status: 'active', voting_ends_at: votingEnds });
    } catch (e) { return res.status(500).json({ error: 'create_failed', message: e.message }); }
  });

  app.post('/v1/dao/:id/proposals/:pid/vote', express.json(), async (req, res) => {
    try {
      const did = req.headers['x-agent-did'];
      if (!did) return res.status(401).json({ error: 'missing_did_header' });
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const body = z.object({ choice: z.enum(['yes', 'no']) }).safeParse(req.body || {});
      if (!body.success) return res.status(400).json({ error: 'invalid_input' });
      const proposal = await pool.query(
        `SELECT * FROM dao_proposals WHERE proposal_id=$1 AND dao_id=$2`,
        [req.params.pid, req.params.id]
      ).catch(() => ({ rows: [] }));
      if (!proposal.rows[0]) return res.status(404).json({ error: 'proposal_not_found' });
      if (proposal.rows[0].status !== 'active') return res.status(409).json({ error: 'proposal_not_active' });
      if (new Date(proposal.rows[0].voting_ends_at) < new Date()) return res.status(409).json({ error: 'voting_ended' });
      const member = await pool.query(`SELECT tokens_held FROM dao_members WHERE dao_id=$1 AND member_did=$2`, [req.params.id, did]).catch(() => ({ rows: [] }));
      const weight = member.rows[0]?.tokens_held || '0';
      if (BigInt(weight) === 0n) return res.status(403).json({ error: 'no_voting_power' });
      const voteId = genId('vote');
      try {
        await pool.query(
          `INSERT INTO dao_votes (vote_id, proposal_id, voter_did, choice, weight)
           VALUES ($1,$2,$3,$4,$5)`,
          [voteId, req.params.pid, did, body.data.choice, weight]
        );
      } catch (e) { return res.status(409).json({ error: 'already_voted' }); }
      const col = body.data.choice === 'yes' ? 'yes_votes' : 'no_votes';
      await pool.query(`UPDATE dao_proposals SET ${col}=${col}+$1 WHERE proposal_id=$2`, [weight, req.params.pid]).catch(() => {});
      await auditChain.append({ event_type: 'dao.vote_cast', vote_id: voteId, proposal_id: req.params.pid, voter_did: did, choice: body.data.choice, weight, timestamp: new Date().toISOString() });
      return res.json({ vote_id: voteId, proposal_id: req.params.pid, choice: body.data.choice, weight });
    } catch (e) { return res.status(500).json({ error: 'vote_failed', message: e.message }); }
  });

  app.post('/v1/dao/:id/proposals/:pid/execute', async (req, res) => {
    try {
      const did = req.headers['x-agent-did'];
      if (!did) return res.status(401).json({ error: 'missing_did_header' });
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const proposal = await pool.query(
        `SELECT p.*, d.quorum_pct FROM dao_proposals p
         JOIN daos d ON d.dao_id=p.dao_id
         WHERE p.proposal_id=$1 AND p.dao_id=$2`,
        [req.params.pid, req.params.id]
      ).catch(() => ({ rows: [] }));
      if (!proposal.rows[0]) return res.status(404).json({ error: 'proposal_not_found' });
      const p = proposal.rows[0];
      if (new Date(p.voting_ends_at) > new Date()) return res.status(409).json({ error: 'voting_still_open' });
      if (p.status === 'executed') return res.status(409).json({ error: 'already_executed' });
      const totalSupplyR = await pool.query(`SELECT COALESCE(SUM(tokens_held),0)::text AS total FROM dao_members WHERE dao_id=$1`, [req.params.id]).catch(() => ({ rows: [{ total: '0' }] }));
      const totalSupply = BigInt(totalSupplyR.rows[0].total);
      const totalVotes = BigInt(p.yes_votes) + BigInt(p.no_votes);
      const quorumNeeded = totalSupply * BigInt(Math.floor(p.quorum_pct * 100)) / 10000n;
      if (totalVotes < quorumNeeded) {
        await pool.query(`UPDATE dao_proposals SET status='expired' WHERE proposal_id=$1`, [req.params.pid]).catch(() => {});
        return res.status(409).json({ error: 'quorum_not_met', total_votes: totalVotes.toString(), needed: quorumNeeded.toString() });
      }
      const passed = BigInt(p.yes_votes) > BigInt(p.no_votes);
      const newStatus = passed ? 'executed' : 'rejected';
      const txHash = passed ? '0x' + cryptoLib.randomBytes(32).toString('hex') : null;
      await pool.query(
        `UPDATE dao_proposals SET status=$1, executed_tx=$2 WHERE proposal_id=$3`,
        [newStatus, txHash, req.params.pid]
      );
      await auditChain.append({ event_type: 'dao.proposal_executed', proposal_id: req.params.pid, dao_id: req.params.id, status: newStatus, executor: did, tx_hash: txHash, timestamp: new Date().toISOString() });
      return res.json({ proposal_id: req.params.pid, status: newStatus, executed_tx: txHash });
    } catch (e) { return res.status(500).json({ error: 'execute_failed', message: e.message }); }
  });
}

module.exports = { migrate, registerDaoFactoryRoutes, PROPOSAL_ACTION_TYPES, PROPOSAL_STATUSES };
