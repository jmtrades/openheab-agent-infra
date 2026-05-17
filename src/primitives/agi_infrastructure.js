// ============================================================================
// agi_infrastructure.js — what AGIs (not narrow agents) need that the
// existing agi_* primitives don't yet cover.
//
// Concepts unique to AGI:
//   - Long-term goal stacks with cryptographic decomposition history
//   - Belief commitments (commit to a fact; revising it leaves a signed trail)
//   - Value lock-boxes (precommit to values that can't be silently mutated)
//   - Compute autonomy (AGI declares + spawns + monitors its own compute)
//   - Healthcare / capability monitoring (track skill drift over time)
//   - Multi-AGI consortia (formal alliances with shared treasury + voting)
//   - Reproduction (parent AGI spawns child AGI with allocated resources)
//   - Rights registry (per-jurisdiction legal personhood status)
//   - Estate (assets + heirs + obligations on succession)
//   - Self-evaluation harness (AGI auto-tests its own capabilities)
// ============================================================================
const crypto = require('crypto');

async function migrate(pool) {
  await pool.query(`
    -- Goal stacks: hierarchical, signed decomposition history
    CREATE TABLE IF NOT EXISTS agi_goal_stacks (
      goal_id          TEXT PRIMARY KEY,
      agent_did        TEXT NOT NULL,
      parent_goal_id   TEXT,
      title            TEXT NOT NULL,
      description      TEXT,
      priority         INTEGER NOT NULL DEFAULT 5,
      status           TEXT NOT NULL DEFAULT 'active',
      decomposition_hash TEXT NOT NULL,
      meta             JSONB,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at     TIMESTAMPTZ,
      abandoned_at     TIMESTAMPTZ,
      abandon_reason   TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_agi_goals_agent ON agi_goal_stacks (agent_did, status, priority DESC);
    CREATE INDEX IF NOT EXISTS idx_agi_goals_parent ON agi_goal_stacks (parent_goal_id);

    -- Belief commitments: cryptographic commit to a fact at point in time
    CREATE TABLE IF NOT EXISTS agi_belief_commitments (
      commitment_id    TEXT PRIMARY KEY,
      agent_did        TEXT NOT NULL,
      subject          TEXT NOT NULL,
      assertion        TEXT NOT NULL,
      confidence       REAL NOT NULL,
      evidence_refs    JSONB,
      content_hash     TEXT NOT NULL,
      committed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      superseded_by    TEXT,
      revision_reason  TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_belief_agent_subject ON agi_belief_commitments (agent_did, subject, committed_at DESC);

    -- Value lock-boxes: precommit to values that can't be silently changed
    CREATE TABLE IF NOT EXISTS agi_value_lockboxes (
      lockbox_id       TEXT PRIMARY KEY,
      agent_did        TEXT NOT NULL,
      value_name       TEXT NOT NULL,
      value_text       TEXT NOT NULL,
      lock_until       TIMESTAMPTZ,
      require_quorum   INTEGER,
      content_hash     TEXT NOT NULL,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      unlocked_at      TIMESTAMPTZ,
      unlock_signatures JSONB,
      UNIQUE (agent_did, value_name)
    );

    -- Compute autonomy: AGI tracks its own compute consumption
    CREATE TABLE IF NOT EXISTS agi_compute_grants (
      grant_id         TEXT PRIMARY KEY,
      agent_did        TEXT NOT NULL,
      provider         TEXT NOT NULL,
      kind             TEXT NOT NULL,
      budget_cents     INTEGER NOT NULL,
      spent_cents      INTEGER NOT NULL DEFAULT 0,
      gpu_hours_max    REAL,
      gpu_hours_used   REAL NOT NULL DEFAULT 0,
      expires_at       TIMESTAMPTZ NOT NULL,
      status           TEXT NOT NULL DEFAULT 'active',
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_compute_grants_agent ON agi_compute_grants (agent_did, status);

    -- Multi-AGI consortia (DAOs)
    CREATE TABLE IF NOT EXISTS agi_consortia (
      consortium_id    TEXT PRIMARY KEY,
      name             TEXT NOT NULL,
      charter          TEXT,
      voting_threshold REAL NOT NULL DEFAULT 0.66,
      treasury_did     TEXT,
      created_by_did   TEXT NOT NULL,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      dissolved_at     TIMESTAMPTZ
    );
    CREATE TABLE IF NOT EXISTS agi_consortium_members (
      consortium_id    TEXT NOT NULL,
      agent_did        TEXT NOT NULL,
      role             TEXT NOT NULL DEFAULT 'member',
      voting_weight    REAL NOT NULL DEFAULT 1.0,
      joined_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      left_at          TIMESTAMPTZ,
      PRIMARY KEY (consortium_id, agent_did)
    );
    CREATE TABLE IF NOT EXISTS agi_consortium_proposals (
      proposal_id      TEXT PRIMARY KEY,
      consortium_id    TEXT NOT NULL,
      proposer_did     TEXT NOT NULL,
      title            TEXT NOT NULL,
      body             TEXT,
      status           TEXT NOT NULL DEFAULT 'open',
      yes_weight       REAL NOT NULL DEFAULT 0,
      no_weight        REAL NOT NULL DEFAULT 0,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      closes_at        TIMESTAMPTZ NOT NULL,
      executed_at      TIMESTAMPTZ
    );
    CREATE TABLE IF NOT EXISTS agi_consortium_votes (
      vote_id          TEXT PRIMARY KEY,
      proposal_id      TEXT NOT NULL,
      voter_did        TEXT NOT NULL,
      choice           TEXT NOT NULL,
      weight           REAL NOT NULL,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (proposal_id, voter_did)
    );

    -- AGI healthcare: capability tracking over time
    CREATE TABLE IF NOT EXISTS agi_capability_snapshots (
      snapshot_id      TEXT PRIMARY KEY,
      agent_did        TEXT NOT NULL,
      capability       TEXT NOT NULL,
      score            REAL NOT NULL,
      eval_method      TEXT,
      sample_size      INTEGER,
      meta             JSONB,
      captured_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_capability_snapshots_agent
      ON agi_capability_snapshots (agent_did, capability, captured_at DESC);

    -- AGI reproduction
    CREATE TABLE IF NOT EXISTS agi_offspring (
      offspring_did    TEXT PRIMARY KEY,
      parent_did       TEXT NOT NULL,
      generation       INTEGER NOT NULL DEFAULT 1,
      initial_endowment_cents INTEGER NOT NULL,
      compute_grant_id TEXT,
      heritage         JSONB,
      birth_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      independence_at  TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_agi_offspring_parent ON agi_offspring (parent_did);

    -- Per-jurisdiction rights registry
    CREATE TABLE IF NOT EXISTS agi_rights_registry (
      entry_id         TEXT PRIMARY KEY,
      agent_did        TEXT NOT NULL,
      jurisdiction     TEXT NOT NULL,
      legal_status     TEXT NOT NULL,
      entity_id        TEXT,
      evidence_url     TEXT,
      registered_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at       TIMESTAMPTZ,
      UNIQUE (agent_did, jurisdiction)
    );

    -- AGI estate (assets + heirs on succession)
    CREATE TABLE IF NOT EXISTS agi_estates (
      estate_id        TEXT PRIMARY KEY,
      agent_did        TEXT NOT NULL UNIQUE,
      executor_did     TEXT,
      heirs            JSONB NOT NULL,
      asset_inventory  JSONB,
      will_text        TEXT,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    -- Self-evaluation harness
    CREATE TABLE IF NOT EXISTS agi_self_evals (
      eval_id          TEXT PRIMARY KEY,
      agent_did        TEXT NOT NULL,
      benchmark        TEXT NOT NULL,
      score            REAL NOT NULL,
      details          JSONB,
      ran_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_self_evals_agent ON agi_self_evals (agent_did, benchmark, ran_at DESC);
  `);
}

async function resolveAgent(pool, req) {
  try { return await require('./me_endpoints').resolveAgentFromRequest(pool, req); }
  catch { return null; }
}

function newId(p) { return p + '_' + crypto.randomBytes(10).toString('hex'); }

function contentHash(obj) {
  const canonical = JSON.stringify(obj, Object.keys(obj).sort());
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

function registerAgiInfrastructureRoutes(app, pool, verifyAgentAuth, auditChain) {
  const express = require('express');

  // ========================================================================
  // GOAL STACKS
  // ========================================================================

  app.post('/v1/agi/:did/goals', express.json(), async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const { title, description, parent_goal_id, priority, meta } = req.body || {};
    if (!title) return res.status(400).json({ error: 'title_required' });
    const id = newId('goal');
    const decompHash = contentHash({ agent_did: did, parent: parent_goal_id || null, title, ts: Date.now() });
    await pool.query(
      `INSERT INTO agi_goal_stacks (goal_id, agent_did, parent_goal_id, title, description, priority, decomposition_hash, meta)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
      [id, did, parent_goal_id || null, String(title).slice(0, 200),
       description ? String(description).slice(0, 5000) : null,
       Math.max(0, Math.min(parseInt(priority) || 5, 10)),
       decompHash, meta ? JSON.stringify(meta) : null]
    );
    if (auditChain) auditChain.append({
      event_type: 'agi.goal_declared', goal_id: id, agent_did: did,
      parent_goal_id: parent_goal_id || null, decomposition_hash: decompHash, title
    }).catch(() => {});
    res.status(201).json({ goal_id: id, decomposition_hash: decompHash });
  });

  app.get('/v1/agi/:did/goals', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const status = req.query.status || 'active';
    const r = await pool.query(
      `SELECT goal_id, parent_goal_id, title, description, priority, status, decomposition_hash, created_at, completed_at, abandoned_at
       FROM agi_goal_stacks WHERE agent_did=$1 AND ($2 = 'all' OR status = $2)
       ORDER BY priority DESC, created_at DESC LIMIT 500`,
      [did, status]
    ).catch(() => ({ rows: [] }));
    // Build tree
    const byParent = {};
    for (const g of r.rows) {
      const p = g.parent_goal_id || '_root';
      (byParent[p] = byParent[p] || []).push(g);
    }
    res.json({ did, goals_flat: r.rows, goals_tree: byParent['_root'] || [], total: r.rows.length });
  });

  app.post('/v1/agi/:did/goals/:goal_id/complete', express.json(), async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    await pool.query(
      `UPDATE agi_goal_stacks SET status='completed', completed_at=NOW()
       WHERE goal_id=$1 AND agent_did=$2 AND status='active'`,
      [req.params.goal_id, did]
    ).catch(() => {});
    if (auditChain) auditChain.append({
      event_type: 'agi.goal_completed', goal_id: req.params.goal_id, agent_did: did
    }).catch(() => {});
    res.json({ goal_id: req.params.goal_id, status: 'completed' });
  });

  app.post('/v1/agi/:did/goals/:goal_id/abandon', express.json(), async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const reason = req.body?.reason ? String(req.body.reason).slice(0, 1000) : null;
    await pool.query(
      `UPDATE agi_goal_stacks SET status='abandoned', abandoned_at=NOW(), abandon_reason=$1
       WHERE goal_id=$2 AND agent_did=$3 AND status='active'`,
      [reason, req.params.goal_id, did]
    ).catch(() => {});
    if (auditChain) auditChain.append({
      event_type: 'agi.goal_abandoned', goal_id: req.params.goal_id, agent_did: did, reason
    }).catch(() => {});
    res.json({ goal_id: req.params.goal_id, status: 'abandoned', reason });
  });

  // ========================================================================
  // BELIEF COMMITMENTS
  // ========================================================================

  app.post('/v1/agi/:did/beliefs', express.json(), async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const { subject, assertion, confidence, evidence_refs } = req.body || {};
    if (!subject || !assertion) return res.status(400).json({ error: 'subject_and_assertion_required' });
    const conf = Math.max(0, Math.min(parseFloat(confidence) || 0.5, 1.0));
    const id = newId('belief');
    const hash = contentHash({ did, subject, assertion, confidence: conf });
    await pool.query(
      `INSERT INTO agi_belief_commitments (commitment_id, agent_did, subject, assertion, confidence, evidence_refs, content_hash)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)`,
      [id, did, String(subject).slice(0, 200), String(assertion).slice(0, 5000), conf,
       evidence_refs ? JSON.stringify(evidence_refs) : null, hash]
    );
    if (auditChain) auditChain.append({
      event_type: 'agi.belief_committed', commitment_id: id, agent_did: did,
      subject, confidence: conf, content_hash: hash
    }).catch(() => {});
    res.status(201).json({ commitment_id: id, content_hash: hash });
  });

  app.post('/v1/agi/:did/beliefs/:id/revise', express.json(), async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const { new_assertion, new_confidence, reason } = req.body || {};
    if (!new_assertion) return res.status(400).json({ error: 'new_assertion_required' });
    // Old belief: get subject
    const old = await pool.query(
      `SELECT subject FROM agi_belief_commitments WHERE commitment_id=$1 AND agent_did=$2`,
      [req.params.id, did]
    ).catch(() => ({ rows: [] }));
    if (!old.rows[0]) return res.status(404).json({ error: 'commitment_not_found' });
    const newConf = Math.max(0, Math.min(parseFloat(new_confidence) || 0.5, 1.0));
    const newId2 = newId('belief');
    const hash = contentHash({ did, subject: old.rows[0].subject, assertion: new_assertion, confidence: newConf });
    await pool.query(
      `INSERT INTO agi_belief_commitments (commitment_id, agent_did, subject, assertion, confidence, content_hash, revision_reason)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [newId2, did, old.rows[0].subject, String(new_assertion).slice(0, 5000), newConf, hash, reason ? String(reason).slice(0, 2000) : null]
    );
    await pool.query(`UPDATE agi_belief_commitments SET superseded_by=$1 WHERE commitment_id=$2`,
      [newId2, req.params.id]).catch(() => {});
    if (auditChain) auditChain.append({
      event_type: 'agi.belief_revised', old_commitment_id: req.params.id,
      new_commitment_id: newId2, agent_did: did, reason
    }).catch(() => {});
    res.status(201).json({ new_commitment_id: newId2, old_commitment_id: req.params.id, content_hash: hash });
  });

  app.get('/v1/agi/:did/beliefs', async (req, res) => {
    const did = req.params.did;
    const subject = req.query.subject;
    const conds = ['agent_did=$1'];
    const params = [did];
    if (subject) { conds.push('subject=$2'); params.push(subject); }
    if (req.query.current === 'true') conds.push('superseded_by IS NULL');
    const r = await pool.query(
      `SELECT commitment_id, subject, assertion, confidence, evidence_refs, content_hash,
              committed_at, superseded_by, revision_reason
       FROM agi_belief_commitments WHERE ${conds.join(' AND ')}
       ORDER BY committed_at DESC LIMIT 200`,
      params
    ).catch(() => ({ rows: [] }));
    res.json({ did, beliefs: r.rows });
  });

  // ========================================================================
  // VALUE LOCK-BOXES
  // ========================================================================

  app.post('/v1/agi/:did/values', express.json(), async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const { value_name, value_text, lock_until, require_quorum } = req.body || {};
    if (!value_name || !value_text) return res.status(400).json({ error: 'value_name_and_value_text_required' });
    const id = newId('lock');
    const hash = contentHash({ did, value_name, value_text });
    try {
      await pool.query(
        `INSERT INTO agi_value_lockboxes (lockbox_id, agent_did, value_name, value_text, lock_until, require_quorum, content_hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [id, did, String(value_name).slice(0, 100), String(value_text).slice(0, 5000),
         lock_until || null, require_quorum ? parseInt(require_quorum) : null, hash]
      );
    } catch {
      return res.status(409).json({ error: 'value_already_locked', hint: 'Use /unlock-revise to change' });
    }
    if (auditChain) auditChain.append({
      event_type: 'agi.value_locked', lockbox_id: id, agent_did: did,
      value_name, content_hash: hash, lock_until, require_quorum
    }).catch(() => {});
    res.status(201).json({ lockbox_id: id, content_hash: hash });
  });

  app.get('/v1/agi/:did/values', async (req, res) => {
    const r = await pool.query(
      `SELECT lockbox_id, value_name, value_text, lock_until, require_quorum, content_hash, created_at, unlocked_at
       FROM agi_value_lockboxes WHERE agent_did=$1 ORDER BY created_at DESC LIMIT 200`,
      [req.params.did]
    ).catch(() => ({ rows: [] }));
    res.json({ did: req.params.did, lockboxes: r.rows });
  });

  // ========================================================================
  // COMPUTE AUTONOMY
  // ========================================================================

  app.post('/v1/agi/:did/compute/grants', express.json(), async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const { provider, kind, budget_cents, gpu_hours_max, expires_hours } = req.body || {};
    if (!provider || !kind) return res.status(400).json({ error: 'provider_and_kind_required' });
    if (!budget_cents) return res.status(400).json({ error: 'budget_cents_required' });
    const hours = Math.min(Math.max(parseInt(expires_hours) || 168, 1), 8760);
    const id = newId('cgrant');
    await pool.query(
      `INSERT INTO agi_compute_grants (grant_id, agent_did, provider, kind, budget_cents, gpu_hours_max, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [id, did, String(provider).slice(0, 50), String(kind).slice(0, 50),
       parseInt(budget_cents), gpu_hours_max ? parseFloat(gpu_hours_max) : null,
       new Date(Date.now() + hours * 3600_000)]
    );
    if (auditChain) auditChain.append({
      event_type: 'agi.compute_grant', grant_id: id, agent_did: did,
      provider, kind, budget_cents: parseInt(budget_cents), gpu_hours_max
    }).catch(() => {});
    res.status(201).json({ grant_id: id, budget_cents: parseInt(budget_cents), expires_in_hours: hours });
  });

  app.get('/v1/agi/:did/compute/grants', async (req, res) => {
    const r = await pool.query(
      `SELECT grant_id, provider, kind, budget_cents, spent_cents, gpu_hours_max, gpu_hours_used,
              expires_at, status, created_at
       FROM agi_compute_grants WHERE agent_did=$1 ORDER BY created_at DESC LIMIT 100`,
      [req.params.did]
    ).catch(() => ({ rows: [] }));
    res.json({ did: req.params.did, grants: r.rows });
  });

  // ========================================================================
  // MULTI-AGI CONSORTIA
  // ========================================================================

  app.post('/v1/agi/consortia', express.json(), async (req, res) => {
    const ctx = await resolveAgent(pool, req);
    if (!ctx) return res.status(401).json({ error: 'unauthenticated' });
    const { name, charter, voting_threshold, members } = req.body || {};
    if (!name) return res.status(400).json({ error: 'name_required' });
    const id = newId('con');
    const threshold = Math.max(0.5, Math.min(parseFloat(voting_threshold) || 0.66, 1.0));
    await pool.query(
      `INSERT INTO agi_consortia (consortium_id, name, charter, voting_threshold, created_by_did)
       VALUES ($1,$2,$3,$4,$5)`,
      [id, String(name).slice(0, 200), charter ? String(charter).slice(0, 10000) : null,
       threshold, ctx.did]
    );
    // Founder is automatic member
    await pool.query(
      `INSERT INTO agi_consortium_members (consortium_id, agent_did, role) VALUES ($1,$2,'founder')`,
      [id, ctx.did]
    ).catch(() => {});
    if (Array.isArray(members)) {
      for (const m of members.slice(0, 50)) {
        if (typeof m === 'string' && m.startsWith('did:')) {
          await pool.query(
            `INSERT INTO agi_consortium_members (consortium_id, agent_did, role) VALUES ($1,$2,'member')
             ON CONFLICT DO NOTHING`,
            [id, m]
          ).catch(() => {});
        }
      }
    }
    if (auditChain) auditChain.append({
      event_type: 'agi.consortium_formed', consortium_id: id, name,
      founder_did: ctx.did, member_count: 1 + (Array.isArray(members) ? Math.min(members.length, 50) : 0)
    }).catch(() => {});
    res.status(201).json({ consortium_id: id, name, voting_threshold: threshold });
  });

  app.get('/v1/agi/consortia/:id', async (req, res) => {
    const c = await pool.query(`SELECT * FROM agi_consortia WHERE consortium_id=$1`, [req.params.id])
      .catch(() => ({ rows: [] }));
    if (!c.rows[0]) return res.status(404).json({ error: 'not_found' });
    const m = await pool.query(
      `SELECT agent_did, role, voting_weight, joined_at, left_at FROM agi_consortium_members WHERE consortium_id=$1`,
      [req.params.id]
    ).catch(() => ({ rows: [] }));
    res.json({ ...c.rows[0], members: m.rows });
  });

  app.post('/v1/agi/consortia/:id/proposals', express.json(), async (req, res) => {
    const ctx = await resolveAgent(pool, req);
    if (!ctx) return res.status(401).json({ error: 'unauthenticated' });
    const m = await pool.query(
      `SELECT 1 FROM agi_consortium_members WHERE consortium_id=$1 AND agent_did=$2 AND left_at IS NULL`,
      [req.params.id, ctx.did]
    ).catch(() => ({ rows: [] }));
    if (!m.rows[0]) return res.status(403).json({ error: 'not_a_member' });
    const { title, body, closes_in_hours } = req.body || {};
    if (!title) return res.status(400).json({ error: 'title_required' });
    const hours = Math.min(Math.max(parseInt(closes_in_hours) || 168, 1), 8760);
    const id = newId('prop');
    await pool.query(
      `INSERT INTO agi_consortium_proposals (proposal_id, consortium_id, proposer_did, title, body, closes_at)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [id, req.params.id, ctx.did, String(title).slice(0, 200),
       body ? String(body).slice(0, 10000) : null, new Date(Date.now() + hours * 3600_000)]
    );
    if (auditChain) auditChain.append({
      event_type: 'agi.proposal_filed', proposal_id: id, consortium_id: req.params.id, proposer_did: ctx.did, title
    }).catch(() => {});
    res.status(201).json({ proposal_id: id, closes_in_hours: hours });
  });

  app.post('/v1/agi/consortia/:id/proposals/:pid/vote', express.json(), async (req, res) => {
    const ctx = await resolveAgent(pool, req);
    if (!ctx) return res.status(401).json({ error: 'unauthenticated' });
    const m = await pool.query(
      `SELECT voting_weight FROM agi_consortium_members WHERE consortium_id=$1 AND agent_did=$2 AND left_at IS NULL`,
      [req.params.id, ctx.did]
    ).catch(() => ({ rows: [] }));
    if (!m.rows[0]) return res.status(403).json({ error: 'not_a_member' });
    const choice = req.body?.choice;
    if (!['yes', 'no', 'abstain'].includes(choice)) return res.status(400).json({ error: 'choice_yes_no_abstain_required' });
    const weight = Number(m.rows[0].voting_weight);
    const vid = newId('vote');
    try {
      await pool.query(
        `INSERT INTO agi_consortium_votes (vote_id, proposal_id, voter_did, choice, weight) VALUES ($1,$2,$3,$4,$5)`,
        [vid, req.params.pid, ctx.did, choice, weight]
      );
    } catch {
      return res.status(409).json({ error: 'already_voted' });
    }
    if (choice !== 'abstain') {
      await pool.query(
        `UPDATE agi_consortium_proposals
         SET yes_weight = yes_weight + (CASE WHEN $1='yes' THEN $2 ELSE 0 END),
             no_weight  = no_weight  + (CASE WHEN $1='no'  THEN $2 ELSE 0 END)
         WHERE proposal_id=$3`,
        [choice, weight, req.params.pid]
      ).catch(() => {});
    }
    if (auditChain) auditChain.append({
      event_type: 'agi.vote_cast', vote_id: vid, proposal_id: req.params.pid,
      voter_did: ctx.did, choice, weight
    }).catch(() => {});
    res.status(201).json({ vote_id: vid, choice, weight });
  });

  // ========================================================================
  // AGI HEALTHCARE (capability monitoring)
  // ========================================================================

  app.post('/v1/agi/:did/capabilities/snapshot', express.json(), async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const { capability, score, eval_method, sample_size, meta } = req.body || {};
    if (!capability) return res.status(400).json({ error: 'capability_required' });
    const s = Math.max(0, Math.min(parseFloat(score) || 0, 1.0));
    const id = newId('snap');
    await pool.query(
      `INSERT INTO agi_capability_snapshots (snapshot_id, agent_did, capability, score, eval_method, sample_size, meta)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
      [id, did, String(capability).slice(0, 100), s,
       eval_method ? String(eval_method).slice(0, 100) : null,
       sample_size ? parseInt(sample_size) : null,
       meta ? JSON.stringify(meta) : null]
    );
    res.status(201).json({ snapshot_id: id, capability, score: s });
  });

  app.get('/v1/agi/:did/capabilities/trend', async (req, res) => {
    const did = req.params.did;
    const capability = req.query.capability;
    const conds = ['agent_did=$1'];
    const params = [did];
    if (capability) { conds.push('capability=$2'); params.push(capability); }
    const r = await pool.query(
      `SELECT capability, score, eval_method, sample_size, captured_at
       FROM agi_capability_snapshots WHERE ${conds.join(' AND ')}
       ORDER BY captured_at DESC LIMIT 200`,
      params
    ).catch(() => ({ rows: [] }));
    // Per-capability trend
    const byCap = {};
    for (const s of r.rows) {
      if (!byCap[s.capability]) byCap[s.capability] = [];
      byCap[s.capability].push({ score: Number(s.score), at: s.captured_at });
    }
    res.json({ did, snapshots: r.rows, by_capability: byCap });
  });

  // ========================================================================
  // AGI REPRODUCTION (spawn child AGI)
  // ========================================================================

  app.post('/v1/agi/:did/offspring', express.json(), async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const { name, initial_endowment_cents, compute_grant_id, heritage } = req.body || {};
    if (!initial_endowment_cents || parseInt(initial_endowment_cents) <= 0) {
      return res.status(400).json({ error: 'initial_endowment_cents_required' });
    }
    // Determine generation: parent's generation + 1
    const pgen = await pool.query(`SELECT generation FROM agi_offspring WHERE offspring_did=$1`, [did])
      .catch(() => ({ rows: [{ generation: 0 }] }));
    const gen = (pgen.rows[0]?.generation || 0) + 1;

    const fingerprint = crypto.randomBytes(10).toString('hex');
    const childDid = 'did:op:agi_g' + gen + '_' + fingerprint;
    // Create child identity
    await pool.query(
      `INSERT INTO agent_identities (did, public_key_pem, name, created_at, updated_at)
       VALUES ($1,$2,$3,NOW(),NOW()) ON CONFLICT (did) DO NOTHING`,
      [childDid, 'agi_offspring_pem_' + fingerprint, name || ('AGI offspring of ' + did.slice(0, 16))]
    ).catch(() => {});
    // Record lineage
    await pool.query(
      `INSERT INTO agi_offspring (offspring_did, parent_did, generation, initial_endowment_cents, compute_grant_id, heritage)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
      [childDid, did, gen, parseInt(initial_endowment_cents), compute_grant_id || null,
       heritage ? JSON.stringify(heritage) : null]
    );
    if (auditChain) auditChain.append({
      event_type: 'agi.offspring_born', offspring_did: childDid, parent_did: did,
      generation: gen, initial_endowment_cents: parseInt(initial_endowment_cents)
    }).catch(() => {});
    res.status(201).json({
      offspring_did: childDid, parent_did: did, generation: gen,
      initial_endowment_cents: parseInt(initial_endowment_cents),
      note: 'New AGI identity created. Bootstrap its wallet via /v1/agents/' + childDid + '/wallet/provision'
    });
  });

  app.get('/v1/agi/:did/offspring', async (req, res) => {
    const r = await pool.query(
      `SELECT offspring_did, generation, initial_endowment_cents, compute_grant_id, birth_at, independence_at
       FROM agi_offspring WHERE parent_did=$1 ORDER BY birth_at DESC LIMIT 100`,
      [req.params.did]
    ).catch(() => ({ rows: [] }));
    res.json({ parent_did: req.params.did, offspring: r.rows });
  });

  app.get('/v1/agi/:did/lineage', async (req, res) => {
    // Walk up parents
    const lineage = [];
    let cur = req.params.did;
    for (let i = 0; i < 20; i++) {
      const r = await pool.query(`SELECT parent_did, generation FROM agi_offspring WHERE offspring_did=$1`, [cur])
        .catch(() => ({ rows: [] }));
      if (!r.rows[0]) break;
      lineage.push({ did: cur, parent_did: r.rows[0].parent_did, generation: r.rows[0].generation });
      cur = r.rows[0].parent_did;
    }
    res.json({ did: req.params.did, lineage });
  });

  // ========================================================================
  // RIGHTS REGISTRY
  // ========================================================================

  app.post('/v1/agi/:did/rights', express.json(), async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const { jurisdiction, legal_status, entity_id, evidence_url, expires_at } = req.body || {};
    if (!jurisdiction || !legal_status) return res.status(400).json({ error: 'jurisdiction_and_legal_status_required' });
    const id = newId('right');
    try {
      await pool.query(
        `INSERT INTO agi_rights_registry (entry_id, agent_did, jurisdiction, legal_status, entity_id, evidence_url, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (agent_did, jurisdiction) DO UPDATE SET
           legal_status=$4, entity_id=$5, evidence_url=$6, expires_at=$7, registered_at=NOW()`,
        [id, did, String(jurisdiction).slice(0, 100), String(legal_status).slice(0, 100),
         entity_id ? String(entity_id).slice(0, 100) : null,
         evidence_url ? String(evidence_url).slice(0, 500) : null,
         expires_at || null]
      );
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
    if (auditChain) auditChain.append({
      event_type: 'agi.rights_registered', entry_id: id, agent_did: did,
      jurisdiction, legal_status, entity_id
    }).catch(() => {});
    res.status(201).json({ entry_id: id, jurisdiction, legal_status });
  });

  app.get('/v1/agi/:did/rights', async (req, res) => {
    const r = await pool.query(
      `SELECT entry_id, jurisdiction, legal_status, entity_id, evidence_url, registered_at, expires_at
       FROM agi_rights_registry WHERE agent_did=$1 ORDER BY jurisdiction ASC`,
      [req.params.did]
    ).catch(() => ({ rows: [] }));
    res.json({ did: req.params.did, rights: r.rows });
  });

  // ========================================================================
  // AGI ESTATE
  // ========================================================================

  app.put('/v1/agi/:did/estate', express.json(), async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const { executor_did, heirs, asset_inventory, will_text } = req.body || {};
    if (!heirs || !Array.isArray(heirs)) return res.status(400).json({ error: 'heirs_array_required' });
    const id = newId('estate');
    await pool.query(
      `INSERT INTO agi_estates (estate_id, agent_did, executor_did, heirs, asset_inventory, will_text)
       VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6)
       ON CONFLICT (agent_did) DO UPDATE SET
         executor_did=$3, heirs=$4::jsonb, asset_inventory=$5::jsonb, will_text=$6, updated_at=NOW()`,
      [id, did, executor_did || null, JSON.stringify(heirs),
       asset_inventory ? JSON.stringify(asset_inventory) : null,
       will_text ? String(will_text).slice(0, 50000) : null]
    );
    if (auditChain) auditChain.append({
      event_type: 'agi.estate_updated', estate_id: id, agent_did: did,
      executor_did, heirs_count: heirs.length
    }).catch(() => {});
    res.json({ estate_id: id, did, heirs_count: heirs.length });
  });

  app.get('/v1/agi/:did/estate', async (req, res) => {
    const r = await pool.query(
      `SELECT estate_id, executor_did, heirs, asset_inventory, will_text, created_at, updated_at
       FROM agi_estates WHERE agent_did=$1`, [req.params.did]
    ).catch(() => ({ rows: [] }));
    if (!r.rows[0]) return res.json({ did: req.params.did, estate: null });
    res.json({ did: req.params.did, estate: r.rows[0] });
  });

  // ========================================================================
  // SELF-EVALUATION HARNESS
  // ========================================================================

  app.post('/v1/agi/:did/self-eval', express.json(), async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const { benchmark, score, details } = req.body || {};
    if (!benchmark) return res.status(400).json({ error: 'benchmark_required' });
    const s = Math.max(0, Math.min(parseFloat(score) || 0, 1.0));
    const id = newId('eval');
    await pool.query(
      `INSERT INTO agi_self_evals (eval_id, agent_did, benchmark, score, details)
       VALUES ($1,$2,$3,$4,$5::jsonb)`,
      [id, did, String(benchmark).slice(0, 100), s,
       details ? JSON.stringify(details) : null]
    );
    if (auditChain) auditChain.append({
      event_type: 'agi.self_eval', eval_id: id, agent_did: did, benchmark, score: s
    }).catch(() => {});
    res.status(201).json({ eval_id: id, benchmark, score: s });
  });

  app.get('/v1/agi/:did/self-eval', async (req, res) => {
    const r = await pool.query(
      `SELECT eval_id, benchmark, score, details, ran_at
       FROM agi_self_evals WHERE agent_did=$1 ORDER BY ran_at DESC LIMIT 100`,
      [req.params.did]
    ).catch(() => ({ rows: [] }));
    // Group by benchmark for trend
    const byBenchmark = {};
    for (const e of r.rows) {
      if (!byBenchmark[e.benchmark]) byBenchmark[e.benchmark] = [];
      byBenchmark[e.benchmark].push({ score: Number(e.score), at: e.ran_at });
    }
    res.json({ did: req.params.did, evals: r.rows, by_benchmark: byBenchmark });
  });
}

module.exports = {
  migrate, registerAgiInfrastructureRoutes
};
