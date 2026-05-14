// ============================================================================
// OpenHeab Governance — Agent constitutions + DAO groups + signed proposals
// + quorum voting + execution.
// ============================================================================
const express = require('express');
const cryptoLib = require('crypto');
const { z } = require('zod');

// ----------------------------------------------------------------------------
// Migration
// ----------------------------------------------------------------------------
async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS agent_constitutions (
      constitution_id          TEXT PRIMARY KEY,
      agent_did                TEXT NOT NULL,
      version                  INTEGER NOT NULL,
      values                   JSONB,
      mission                  TEXT,
      forbidden_actions        JSONB,
      required_human_approval  JSONB,
      signature                TEXT,
      previous_id              TEXT,
      audit_chain_entry        TEXT,
      created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      superseded_at            TIMESTAMPTZ,
      UNIQUE (agent_did, version)
    );
    CREATE INDEX IF NOT EXISTS idx_constitutions_agent ON agent_constitutions (agent_did, version DESC);

    CREATE TABLE IF NOT EXISTS governance_groups (
      group_id             TEXT PRIMARY KEY,
      name                 TEXT NOT NULL,
      description          TEXT,
      founder_did          TEXT NOT NULL,
      quorum_pct           REAL NOT NULL DEFAULT 0.51,
      voting_period_seconds INTEGER NOT NULL DEFAULT 604800,
      member_count         INTEGER NOT NULL DEFAULT 0,
      created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      audit_chain_entry    TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_groups_founder ON governance_groups (founder_did);

    CREATE TABLE IF NOT EXISTS group_members (
      group_id       TEXT NOT NULL,
      member_did     TEXT NOT NULL,
      role           TEXT NOT NULL DEFAULT 'member',
      voting_weight  REAL NOT NULL DEFAULT 1.0,
      joined_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      removed_at     TIMESTAMPTZ,
      PRIMARY KEY (group_id, member_did)
    );
    CREATE INDEX IF NOT EXISTS idx_members_member ON group_members (member_did) WHERE removed_at IS NULL;

    CREATE TABLE IF NOT EXISTS governance_proposals (
      proposal_id        TEXT PRIMARY KEY,
      group_id           TEXT NOT NULL,
      proposer_did       TEXT NOT NULL,
      title              TEXT NOT NULL,
      description        TEXT,
      action_type        TEXT,
      action_payload     JSONB,
      status             TEXT NOT NULL DEFAULT 'open',
      yes_votes          REAL NOT NULL DEFAULT 0,
      no_votes           REAL NOT NULL DEFAULT 0,
      abstain_votes      REAL NOT NULL DEFAULT 0,
      vote_count         INTEGER NOT NULL DEFAULT 0,
      voting_ends_at     TIMESTAMPTZ,
      executed_at        TIMESTAMPTZ,
      execution_result   JSONB,
      audit_chain_entry  TEXT,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_proposals_group ON governance_proposals (group_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_proposals_status ON governance_proposals (status);

    CREATE TABLE IF NOT EXISTS governance_votes (
      proposal_id        TEXT NOT NULL,
      voter_did          TEXT NOT NULL,
      vote               TEXT NOT NULL,
      weight             REAL NOT NULL DEFAULT 1.0,
      signature          TEXT,
      audit_chain_entry  TEXT,
      cast_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (proposal_id, voter_did)
    );
    CREATE INDEX IF NOT EXISTS idx_votes_voter ON governance_votes (voter_did);
  `).catch(() => {});
}

// ----------------------------------------------------------------------------
// Idempotency
// ----------------------------------------------------------------------------
async function checkIdempotency(pool, agentDid, key, scope) {
  if (!key) return null;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS governance_idempotency (
      agent_did TEXT NOT NULL,
      scope TEXT NOT NULL,
      idem_key TEXT NOT NULL,
      response JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (agent_did, scope, idem_key)
    )`).catch(() => {});
  const r = await pool.query(
    `SELECT response FROM governance_idempotency WHERE agent_did=$1 AND scope=$2 AND idem_key=$3`,
    [agentDid, scope, key]
  ).catch(() => ({ rows: [] }));
  return r.rows[0]?.response || null;
}

async function recordIdempotency(pool, agentDid, key, scope, response) {
  if (!key) return;
  await pool.query(
    `INSERT INTO governance_idempotency (agent_did, scope, idem_key, response)
     VALUES ($1,$2,$3,$4::jsonb) ON CONFLICT DO NOTHING`,
    [agentDid, scope, key, JSON.stringify(response)]
  ).catch(() => {});
}

// ----------------------------------------------------------------------------
// Signing helpers
// ----------------------------------------------------------------------------
async function getAgentPubKey(pool, agentDid) {
  const k = await pool.query(
    `SELECT public_key FROM identity_keys
     WHERE agent_did = $1 AND status = 'active'
     ORDER BY generation DESC LIMIT 1`,
    [agentDid]
  ).catch(() => ({ rows: [] }));
  if (k.rows[0]) return k.rows[0].public_key;
  const i = await pool.query(
    `SELECT public_key FROM identities WHERE did = $1`, [agentDid]
  ).catch(() => ({ rows: [] }));
  return i.rows[0]?.public_key || null;
}

function verifyEd25519Signature(pubPem, canonical, signatureHex) {
  try {
    return cryptoLib.verify(null, Buffer.from(canonical),
      cryptoLib.createPublicKey(pubPem), Buffer.from(signatureHex, 'hex'));
  } catch { return false; }
}

// ----------------------------------------------------------------------------
// Routes
// ----------------------------------------------------------------------------
function registerGovernanceRoutes(app, pool, verifyAgentAuth, auditChain) {
  // --------------------------------------------------------------------------
  // POST /v1/agents/:did/constitution
  // --------------------------------------------------------------------------
  const ConstitutionSchema = z.object({
    values: z.array(z.string()).optional(),
    mission: z.string().max(10000).optional(),
    forbidden_actions: z.array(z.string()).optional(),
    required_human_approval: z.array(z.string()).optional(),
    signature: z.string().optional()
  });

  app.post('/v1/agents/:did/constitution', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const parse = ConstitutionSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;

      const idemKey = req.headers['x-idempotency-key'];
      const cached = await checkIdempotency(pool, did, idemKey, 'constitution-create');
      if (cached) return res.json(cached);

      // Determine next version, supersede previous
      const prevR = await pool.query(
        `SELECT constitution_id, version FROM agent_constitutions
         WHERE agent_did = $1 AND superseded_at IS NULL
         ORDER BY version DESC LIMIT 1`,
        [did]
      );
      const prevId = prevR.rows[0]?.constitution_id || null;
      const nextVersion = (prevR.rows[0]?.version || 0) + 1;

      const constitutionId = 'con_' + cryptoLib.randomBytes(12).toString('hex');

      const chainEntry = await auditChain.append({
        event_type: 'governance.constitution_created',
        constitution_id: constitutionId,
        agent_did: did,
        version: nextVersion,
        previous_id: prevId,
        timestamp: new Date().toISOString()
      });

      if (prevId) {
        await pool.query(
          `UPDATE agent_constitutions SET superseded_at = NOW() WHERE constitution_id = $1`,
          [prevId]
        );
      }

      const ins = await pool.query(`
        INSERT INTO agent_constitutions
          (constitution_id, agent_did, version, values, mission, forbidden_actions,
           required_human_approval, signature, previous_id, audit_chain_entry)
        VALUES ($1, $2, $3, $4::jsonb, $5, $6::jsonb, $7::jsonb, $8, $9, $10)
        RETURNING *
      `, [
        constitutionId, did, nextVersion,
        d.values ? JSON.stringify(d.values) : null,
        d.mission || null,
        d.forbidden_actions ? JSON.stringify(d.forbidden_actions) : null,
        d.required_human_approval ? JSON.stringify(d.required_human_approval) : null,
        d.signature || null, prevId, chainEntry.hash
      ]);

      const response = { ...ins.rows[0], audit_chain_entry: chainEntry.hash };
      await recordIdempotency(pool, did, idemKey, 'constitution-create', response);
      return res.status(201).json(response);
    } catch (e) {
      console.error('[governance.constitution]', e);
      return res.status(500).json({ error: 'constitution_failed', message: e.message });
    }
  });

  // --------------------------------------------------------------------------
  // GET /v1/agents/:did/constitution
  // --------------------------------------------------------------------------
  app.get('/v1/agents/:did/constitution', async (req, res) => {
    const did = req.params.did;
    if (req.query.history === 'true') {
      const r = await pool.query(
        `SELECT * FROM agent_constitutions WHERE agent_did = $1
         ORDER BY version DESC`,
        [did]
      ).catch(() => ({ rows: [] }));
      return res.json({ constitutions: r.rows, count: r.rows.length });
    }
    const r = await pool.query(
      `SELECT * FROM agent_constitutions
       WHERE agent_did = $1 AND superseded_at IS NULL
       ORDER BY version DESC LIMIT 1`,
      [did]
    ).catch(() => ({ rows: [] }));
    if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
    return res.json(r.rows[0]);
  });

  // --------------------------------------------------------------------------
  // POST /v1/groups — create a DAO group
  // --------------------------------------------------------------------------
  const GroupSchema = z.object({
    founder_did: z.string(),
    name: z.string().min(1).max(200),
    description: z.string().max(10000).optional(),
    quorum_pct: z.number().min(0).max(1).optional(),
    voting_period_seconds: z.number().int().positive().optional()
  });

  app.post('/v1/groups', express.json(), async (req, res) => {
    try {
      const parse = GroupSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;

      const auth = await verifyAgentAuth(req, d.founder_did, { strictSignatureRequired: true });
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const idemKey = req.headers['x-idempotency-key'];
      const cached = await checkIdempotency(pool, d.founder_did, idemKey, 'group-create');
      if (cached) return res.json(cached);

      const groupId = 'grp_' + cryptoLib.randomBytes(12).toString('hex');

      const chainEntry = await auditChain.append({
        event_type: 'governance.group_created',
        group_id: groupId,
        founder_did: d.founder_did,
        name: d.name,
        timestamp: new Date().toISOString()
      });

      await pool.query(`
        INSERT INTO governance_groups
          (group_id, name, description, founder_did, quorum_pct, voting_period_seconds,
           member_count, audit_chain_entry)
        VALUES ($1, $2, $3, $4, $5, $6, 1, $7)
      `, [
        groupId, d.name, d.description || null, d.founder_did,
        d.quorum_pct ?? 0.51, d.voting_period_seconds ?? 604800,
        chainEntry.hash
      ]);

      await pool.query(`
        INSERT INTO group_members (group_id, member_did, role, voting_weight)
        VALUES ($1, $2, 'founder', 1.0)
        ON CONFLICT DO NOTHING
      `, [groupId, d.founder_did]);

      const response = {
        group_id: groupId,
        name: d.name,
        founder_did: d.founder_did,
        quorum_pct: d.quorum_pct ?? 0.51,
        voting_period_seconds: d.voting_period_seconds ?? 604800,
        member_count: 1,
        audit_chain_entry: chainEntry.hash
      };
      await recordIdempotency(pool, d.founder_did, idemKey, 'group-create', response);
      return res.status(201).json(response);
    } catch (e) {
      console.error('[governance.group]', e);
      return res.status(500).json({ error: 'group_failed', message: e.message });
    }
  });

  // --------------------------------------------------------------------------
  // GET /v1/groups/:groupId
  // --------------------------------------------------------------------------
  app.get('/v1/groups/:groupId', async (req, res) => {
    const groupId = req.params.groupId;
    const g = await pool.query(
      `SELECT * FROM governance_groups WHERE group_id = $1`, [groupId]
    ).catch(() => ({ rows: [] }));
    if (!g.rows[0]) return res.status(404).json({ error: 'not_found' });

    const members = await pool.query(
      `SELECT member_did, role, voting_weight, joined_at FROM group_members
       WHERE group_id = $1 AND removed_at IS NULL ORDER BY joined_at ASC LIMIT 1000`,
      [groupId]
    ).catch(() => ({ rows: [] }));

    return res.json({ ...g.rows[0], members: members.rows });
  });

  // --------------------------------------------------------------------------
  // POST /v1/groups/:groupId/members (admin only)
  // --------------------------------------------------------------------------
  const MemberSchema = z.object({
    actor_did: z.string(),
    member_did: z.string(),
    role: z.enum(['member', 'admin', 'founder']).optional(),
    voting_weight: z.number().positive().optional()
  });

  app.post('/v1/groups/:groupId/members', express.json(), async (req, res) => {
    try {
      const parse = MemberSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;
      const groupId = req.params.groupId;

      const auth = await verifyAgentAuth(req, d.actor_did, { strictSignatureRequired: true });
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      // Actor must be admin or founder of group
      const r = await pool.query(
        `SELECT role FROM group_members WHERE group_id=$1 AND member_did=$2 AND removed_at IS NULL`,
        [groupId, d.actor_did]
      );
      const actorRole = r.rows[0]?.role;
      if (!actorRole || !['admin', 'founder'].includes(actorRole)) {
        return res.status(403).json({ error: 'admin_required' });
      }

      const chainEntry = await auditChain.append({
        event_type: 'governance.member_added',
        group_id: groupId,
        member_did: d.member_did,
        role: d.role || 'member',
        actor_did: d.actor_did,
        timestamp: new Date().toISOString()
      });

      const ins = await pool.query(`
        INSERT INTO group_members (group_id, member_did, role, voting_weight)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (group_id, member_did) DO UPDATE SET
          role = EXCLUDED.role,
          voting_weight = EXCLUDED.voting_weight,
          removed_at = NULL
        RETURNING *
      `, [groupId, d.member_did, d.role || 'member', d.voting_weight ?? 1.0]);

      await pool.query(`
        UPDATE governance_groups SET member_count = (
          SELECT COUNT(*) FROM group_members WHERE group_id=$1 AND removed_at IS NULL
        ) WHERE group_id=$1
      `, [groupId]);

      return res.status(201).json({ ...ins.rows[0], audit_chain_entry: chainEntry.hash });
    } catch (e) {
      console.error('[governance.member]', e);
      return res.status(500).json({ error: 'add_member_failed', message: e.message });
    }
  });

  // --------------------------------------------------------------------------
  // POST /v1/groups/:groupId/proposals
  // --------------------------------------------------------------------------
  const ProposalSchema = z.object({
    proposer_did: z.string(),
    title: z.string().min(1).max(500),
    description: z.string().max(50000).optional(),
    action_type: z.string().max(64).optional(),
    action_payload: z.any().optional()
  });

  app.post('/v1/groups/:groupId/proposals', express.json(), async (req, res) => {
    try {
      const parse = ProposalSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;
      const groupId = req.params.groupId;

      const auth = await verifyAgentAuth(req, d.proposer_did, { strictSignatureRequired: true });
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      // Proposer must be a member
      const memberR = await pool.query(
        `SELECT role FROM group_members WHERE group_id=$1 AND member_did=$2 AND removed_at IS NULL`,
        [groupId, d.proposer_did]
      );
      if (!memberR.rows[0]) return res.status(403).json({ error: 'not_a_member' });

      const groupR = await pool.query(
        `SELECT voting_period_seconds FROM governance_groups WHERE group_id=$1`, [groupId]
      );
      if (!groupR.rows[0]) return res.status(404).json({ error: 'group_not_found' });

      const idemKey = req.headers['x-idempotency-key'];
      const cached = await checkIdempotency(pool, d.proposer_did, idemKey, `proposal:${groupId}`);
      if (cached) return res.json(cached);

      const proposalId = 'prp_' + cryptoLib.randomBytes(12).toString('hex');
      const votingEndsAt = new Date(Date.now() + groupR.rows[0].voting_period_seconds * 1000);

      const chainEntry = await auditChain.append({
        event_type: 'governance.proposal_created',
        proposal_id: proposalId,
        group_id: groupId,
        proposer_did: d.proposer_did,
        title: d.title,
        action_type: d.action_type || null,
        voting_ends_at: votingEndsAt.toISOString(),
        timestamp: new Date().toISOString()
      });

      const ins = await pool.query(`
        INSERT INTO governance_proposals
          (proposal_id, group_id, proposer_did, title, description, action_type,
           action_payload, status, voting_ends_at, audit_chain_entry)
        VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, 'open', $8, $9)
        RETURNING *
      `, [
        proposalId, groupId, d.proposer_did, d.title, d.description || null,
        d.action_type || null,
        d.action_payload ? JSON.stringify(d.action_payload) : null,
        votingEndsAt, chainEntry.hash
      ]);

      const response = { ...ins.rows[0], audit_chain_entry: chainEntry.hash };
      await recordIdempotency(pool, d.proposer_did, idemKey, `proposal:${groupId}`, response);
      return res.status(201).json(response);
    } catch (e) {
      console.error('[governance.proposal]', e);
      return res.status(500).json({ error: 'proposal_failed', message: e.message });
    }
  });

  // --------------------------------------------------------------------------
  // POST /v1/proposals/:proposalId/vote (signed)
  // --------------------------------------------------------------------------
  const VoteSchema = z.object({
    voter_did: z.string(),
    vote: z.enum(['yes', 'no', 'abstain']),
    signature: z.string().optional()
  });

  app.post('/v1/proposals/:proposalId/vote', express.json(), async (req, res) => {
    try {
      const parse = VoteSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;
      const proposalId = req.params.proposalId;

      const auth = await verifyAgentAuth(req, d.voter_did, { strictSignatureRequired: true });
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const propR = await pool.query(
        `SELECT * FROM governance_proposals WHERE proposal_id=$1`, [proposalId]
      );
      if (!propR.rows[0]) return res.status(404).json({ error: 'not_found' });
      const proposal = propR.rows[0];
      if (proposal.status !== 'open') return res.status(400).json({ error: 'proposal_closed', status: proposal.status });
      if (new Date(proposal.voting_ends_at) < new Date()) {
        return res.status(400).json({ error: 'voting_period_ended' });
      }

      // Voter must be a member
      const memberR = await pool.query(
        `SELECT voting_weight FROM group_members
         WHERE group_id=$1 AND member_did=$2 AND removed_at IS NULL`,
        [proposal.group_id, d.voter_did]
      );
      if (!memberR.rows[0]) return res.status(403).json({ error: 'not_a_member' });
      const weight = parseFloat(memberR.rows[0].voting_weight);

      // Optional explicit signature verification (signed vote)
      if (d.signature) {
        const pubKey = await getAgentPubKey(pool, d.voter_did);
        if (pubKey) {
          const canonical = `VOTE|${proposalId}|${d.voter_did}|${d.vote}`;
          if (!verifyEd25519Signature(pubKey, canonical, d.signature)) {
            return res.status(400).json({ error: 'invalid_vote_signature' });
          }
        }
      }

      // Cast vote
      const existing = await pool.query(
        `SELECT vote, weight FROM governance_votes WHERE proposal_id=$1 AND voter_did=$2`,
        [proposalId, d.voter_did]
      );

      const chainEntry = await auditChain.append({
        event_type: 'governance.vote_cast',
        proposal_id: proposalId,
        voter_did: d.voter_did,
        vote: d.vote,
        weight,
        timestamp: new Date().toISOString()
      });

      if (existing.rows[0]) {
        // Reverse old, apply new
        const prevCol = `${existing.rows[0].vote}_votes`;
        await pool.query(
          `UPDATE governance_proposals
           SET ${prevCol} = GREATEST(${prevCol} - $2, 0)
           WHERE proposal_id = $1`,
          [proposalId, parseFloat(existing.rows[0].weight)]
        );
      }

      const newCol = `${d.vote}_votes`;
      await pool.query(
        `INSERT INTO governance_votes
           (proposal_id, voter_did, vote, weight, signature, audit_chain_entry)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (proposal_id, voter_did) DO UPDATE SET
           vote = EXCLUDED.vote, weight = EXCLUDED.weight,
           signature = EXCLUDED.signature, audit_chain_entry = EXCLUDED.audit_chain_entry,
           cast_at = NOW()`,
        [proposalId, d.voter_did, d.vote, weight, d.signature || null, chainEntry.hash]
      );

      await pool.query(
        `UPDATE governance_proposals
         SET ${newCol} = ${newCol} + $2,
             vote_count = (SELECT COUNT(*) FROM governance_votes WHERE proposal_id=$1)
         WHERE proposal_id = $1`,
        [proposalId, weight]
      );

      return res.json({
        proposal_id: proposalId,
        voter_did: d.voter_did,
        vote: d.vote,
        weight,
        audit_chain_entry: chainEntry.hash
      });
    } catch (e) {
      console.error('[governance.vote]', e);
      return res.status(500).json({ error: 'vote_failed', message: e.message });
    }
  });

  // --------------------------------------------------------------------------
  // POST /v1/proposals/:proposalId/execute
  // --------------------------------------------------------------------------
  app.post('/v1/proposals/:proposalId/execute', express.json(), async (req, res) => {
    try {
      const proposalId = req.params.proposalId;
      const propR = await pool.query(
        `SELECT p.*, g.quorum_pct, g.member_count
         FROM governance_proposals p
         JOIN governance_groups g ON g.group_id = p.group_id
         WHERE p.proposal_id = $1`,
        [proposalId]
      );
      if (!propR.rows[0]) return res.status(404).json({ error: 'not_found' });
      const p = propR.rows[0];

      if (p.status !== 'open') return res.status(400).json({ error: 'not_open', status: p.status });
      if (new Date(p.voting_ends_at) > new Date()) {
        return res.status(400).json({ error: 'voting_still_open', voting_ends_at: p.voting_ends_at });
      }

      // Compute total voting weight in group (active members)
      const totalR = await pool.query(
        `SELECT COALESCE(SUM(voting_weight), 0)::real AS total
         FROM group_members WHERE group_id=$1 AND removed_at IS NULL`,
        [p.group_id]
      );
      const totalWeight = parseFloat(totalR.rows[0]?.total || 0);
      const yes = parseFloat(p.yes_votes);
      const no = parseFloat(p.no_votes);
      const abstain = parseFloat(p.abstain_votes);
      const participated = yes + no + abstain;

      const quorumMet = totalWeight > 0 && (participated / totalWeight) >= parseFloat(p.quorum_pct);
      const decisive = yes + no > 0;
      const majorityYes = decisive && yes > no;

      let newStatus, executionResult;
      if (!quorumMet) {
        newStatus = 'failed';
        executionResult = { reason: 'quorum_not_met', participated, total: totalWeight, quorum_pct: p.quorum_pct };
      } else if (!majorityYes) {
        newStatus = 'failed';
        executionResult = { reason: 'majority_no', yes, no, abstain };
      } else {
        newStatus = 'executed';
        executionResult = {
          reason: 'passed',
          yes, no, abstain,
          action_type: p.action_type,
          action_payload: p.action_payload,
          note: 'Action recorded; off-chain execution to be performed by group operators'
        };
      }

      const chainEntry = await auditChain.append({
        event_type: 'governance.proposal_executed',
        proposal_id: proposalId,
        group_id: p.group_id,
        status: newStatus,
        yes, no, abstain,
        total_weight: totalWeight,
        timestamp: new Date().toISOString()
      });

      await pool.query(
        `UPDATE governance_proposals
         SET status = $2, executed_at = NOW(), execution_result = $3::jsonb,
             audit_chain_entry = $4
         WHERE proposal_id = $1`,
        [proposalId, newStatus, JSON.stringify(executionResult), chainEntry.hash]
      );

      return res.json({
        proposal_id: proposalId,
        status: newStatus,
        execution_result: executionResult,
        audit_chain_entry: chainEntry.hash
      });
    } catch (e) {
      console.error('[governance.execute]', e);
      return res.status(500).json({ error: 'execute_failed', message: e.message });
    }
  });
}

module.exports = {
  migrate,
  registerGovernanceRoutes
};
