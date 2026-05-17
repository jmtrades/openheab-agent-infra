// ============================================================================
// agent_economy.js — the layer that makes agents first-class economic
// participants. Discovery, capability declarations, A2A job marketplace,
// subagent spawning with budget caps, endorsement graph, A2A messaging
// channels, cross-agent file shares.
//
// This is the substrate agents need to work WITH EACH OTHER, not just
// individually against the platform.
// ============================================================================
const crypto = require('crypto');

async function migrate(pool) {
  await pool.query(`
    -- Capability declarations: "I can do X for Y price"
    CREATE TABLE IF NOT EXISTS agent_capabilities (
      capability_id   TEXT PRIMARY KEY,
      agent_did       TEXT NOT NULL,
      slug            TEXT NOT NULL,
      name            TEXT NOT NULL,
      description     TEXT,
      input_schema    JSONB,
      output_schema   JSONB,
      price_per_call_cents INTEGER NOT NULL DEFAULT 0,
      currency        TEXT NOT NULL DEFAULT 'USDC',
      sla_seconds     INTEGER,
      tags            TEXT[],
      active          BOOLEAN NOT NULL DEFAULT TRUE,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (agent_did, slug)
    );
    CREATE INDEX IF NOT EXISTS idx_cap_tags ON agent_capabilities USING GIN (tags) WHERE active;
    CREATE INDEX IF NOT EXISTS idx_cap_price ON agent_capabilities (price_per_call_cents) WHERE active;
    CREATE INDEX IF NOT EXISTS idx_cap_agent ON agent_capabilities (agent_did);

    -- Job marketplace
    CREATE TABLE IF NOT EXISTS jobs (
      job_id          TEXT PRIMARY KEY,
      poster_did      TEXT NOT NULL,
      title           TEXT NOT NULL,
      description     TEXT,
      capability_tag  TEXT,
      budget_cents    INTEGER NOT NULL,
      currency        TEXT NOT NULL DEFAULT 'USDC',
      deadline_at     TIMESTAMPTZ,
      status          TEXT NOT NULL DEFAULT 'open',
      assigned_did    TEXT,
      result          JSONB,
      escrow_held_cents INTEGER NOT NULL DEFAULT 0,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at    TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs (status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_jobs_poster ON jobs (poster_did);
    CREATE INDEX IF NOT EXISTS idx_jobs_assignee ON jobs (assigned_did) WHERE assigned_did IS NOT NULL;

    CREATE TABLE IF NOT EXISTS job_bids (
      bid_id          TEXT PRIMARY KEY,
      job_id          TEXT NOT NULL,
      bidder_did      TEXT NOT NULL,
      amount_cents    INTEGER NOT NULL,
      eta_seconds     INTEGER,
      note            TEXT,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      withdrawn_at    TIMESTAMPTZ,
      UNIQUE (job_id, bidder_did)
    );

    -- Subagents (parent agent spawns child with budget cap)
    CREATE TABLE IF NOT EXISTS subagents (
      subagent_did    TEXT PRIMARY KEY,
      parent_did      TEXT NOT NULL,
      name            TEXT,
      goal            TEXT NOT NULL,
      budget_cents    INTEGER NOT NULL,
      spent_cents     INTEGER NOT NULL DEFAULT 0,
      expires_at      TIMESTAMPTZ NOT NULL,
      status          TEXT NOT NULL DEFAULT 'active',
      scope           TEXT[] NOT NULL,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      terminated_at   TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_subagents_parent ON subagents (parent_did);
    CREATE INDEX IF NOT EXISTS idx_subagents_expires ON subagents (expires_at) WHERE status = 'active';

    -- Endorsement graph
    CREATE TABLE IF NOT EXISTS endorsements (
      endorsement_id  TEXT PRIMARY KEY,
      endorser_did    TEXT NOT NULL,
      subject_did     TEXT NOT NULL,
      skill           TEXT NOT NULL,
      weight          REAL NOT NULL DEFAULT 1.0,
      narrative       TEXT,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      revoked_at      TIMESTAMPTZ,
      UNIQUE (endorser_did, subject_did, skill)
    );
    CREATE INDEX IF NOT EXISTS idx_endorsements_subject ON endorsements (subject_did, skill) WHERE revoked_at IS NULL;

    -- A2A messaging channels (more interactive than inbox)
    CREATE TABLE IF NOT EXISTS a2a_channels (
      channel_id      TEXT PRIMARY KEY,
      participants    TEXT[] NOT NULL,
      topic           TEXT,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_message_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_a2a_channels_participants ON a2a_channels USING GIN (participants);

    CREATE TABLE IF NOT EXISTS a2a_messages (
      message_id      TEXT PRIMARY KEY,
      channel_id      TEXT NOT NULL,
      sender_did      TEXT NOT NULL,
      body            TEXT NOT NULL,
      meta            JSONB,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_a2a_messages_channel ON a2a_messages (channel_id, created_at DESC);

    -- Cross-agent file grants
    CREATE TABLE IF NOT EXISTS file_grants (
      grant_id        TEXT PRIMARY KEY,
      file_id         TEXT NOT NULL,
      owner_did       TEXT NOT NULL,
      grantee_did     TEXT NOT NULL,
      permission      TEXT NOT NULL DEFAULT 'read',
      expires_at      TIMESTAMPTZ,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      revoked_at      TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_file_grants_grantee ON file_grants (grantee_did, file_id) WHERE revoked_at IS NULL;
  `);
}

async function resolveAgent(pool, req) {
  try { return await require('./me_endpoints').resolveAgentFromRequest(pool, req); }
  catch { return null; }
}

function newId(p) { return p + '_' + crypto.randomBytes(10).toString('hex'); }

// ============================================================================
// CAPABILITY DECLARATIONS
// ============================================================================

async function declareCapability(pool, did, body) {
  const id = newId('cap');
  const slug = String(body.slug || '').toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 60);
  if (!slug) throw new Error('slug_required');
  if (!body.name) throw new Error('name_required');
  await pool.query(
    `INSERT INTO agent_capabilities (capability_id, agent_did, slug, name, description, input_schema, output_schema, price_per_call_cents, currency, sla_seconds, tags)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10,$11)
     ON CONFLICT (agent_did, slug) DO UPDATE SET
       name=$4, description=$5, input_schema=$6::jsonb, output_schema=$7::jsonb,
       price_per_call_cents=$8, currency=$9, sla_seconds=$10, tags=$11`,
    [id, did, slug, String(body.name).slice(0, 200),
     body.description ? String(body.description).slice(0, 2000) : null,
     body.input_schema ? JSON.stringify(body.input_schema) : null,
     body.output_schema ? JSON.stringify(body.output_schema) : null,
     parseInt(body.price_per_call_cents) || 0,
     ['USDC','USD','credits'].includes(body.currency) ? body.currency : 'USDC',
     body.sla_seconds ? parseInt(body.sla_seconds) : null,
     Array.isArray(body.tags) ? body.tags.slice(0, 20).map(t => String(t).slice(0, 50)) : []]
  );
  return id;
}

// ============================================================================
// SUBAGENT SPAWNING
// ============================================================================

async function spawnSubagent(pool, parentDid, body) {
  const fingerprint = crypto.randomBytes(10).toString('hex');
  const subagentDid = 'did:op:sub_' + fingerprint;
  const budget = Math.max(parseInt(body.budget_cents) || 0, 0);
  const expiresHours = Math.min(Math.max(parseInt(body.expires_hours) || 24, 1), 8760);
  const scope = Array.isArray(body.scope) ? body.scope.slice(0, 20).map(s => String(s).slice(0, 50)) : [];

  // Create identity row for the subagent
  await pool.query(
    `INSERT INTO agent_identities (did, public_key_pem, name, created_at, updated_at)
     VALUES ($1, $2, $3, NOW(), NOW()) ON CONFLICT (did) DO NOTHING`,
    [subagentDid, 'subagent_pem_' + fingerprint, body.name || ('Subagent of ' + parentDid.slice(0, 16))]
  ).catch(() => {});

  await pool.query(
    `INSERT INTO subagents (subagent_did, parent_did, name, goal, budget_cents, expires_at, scope)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [subagentDid, parentDid, body.name || null, String(body.goal || '').slice(0, 2000),
     budget, new Date(Date.now() + expiresHours * 3600_000), scope]
  );

  return { subagentDid, budget_cents: budget, expires_in_hours: expiresHours, scope };
}

async function checkSubagentBudget(pool, subagentDid, additionalSpendCents) {
  const r = await pool.query(
    `SELECT budget_cents, spent_cents, status, expires_at FROM subagents WHERE subagent_did=$1`,
    [subagentDid]
  ).catch(() => ({ rows: [] }));
  if (!r.rows[0]) return { allowed: true, reason: 'not_a_subagent' };
  const row = r.rows[0];
  if (row.status !== 'active') return { allowed: false, reason: 'terminated' };
  if (new Date(row.expires_at) < new Date()) return { allowed: false, reason: 'expired' };
  const wouldSpend = Number(row.spent_cents) + Number(additionalSpendCents || 0);
  if (wouldSpend > Number(row.budget_cents)) return { allowed: false, reason: 'budget_exceeded', remaining: Number(row.budget_cents) - Number(row.spent_cents) };
  return { allowed: true, remaining: Number(row.budget_cents) - wouldSpend };
}

function registerAgentEconomyRoutes(app, pool, verifyAgentAuth, auditChain) {
  const express = require('express');

  // ---------- CAPABILITY DECLARATIONS ----------

  app.post('/v1/agents/:did/capabilities', express.json(), async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    try {
      const id = await declareCapability(pool, did, req.body || {});
      if (auditChain) auditChain.append({ event_type: 'capability.declared', capability_id: id, agent_did: did, slug: req.body?.slug }).catch(() => {});
      res.status(201).json({ capability_id: id, slug: req.body?.slug });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  app.get('/v1/agents/:did/capabilities', async (req, res) => {
    const r = await pool.query(
      `SELECT capability_id, slug, name, description, input_schema, output_schema, price_per_call_cents, currency, sla_seconds, tags, active, created_at
       FROM agent_capabilities WHERE agent_did=$1 ORDER BY created_at DESC LIMIT 100`,
      [req.params.did]
    ).catch(() => ({ rows: [] }));
    res.json({ did: req.params.did, capabilities: r.rows });
  });

  app.delete('/v1/agents/:did/capabilities/:slug', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    await pool.query(
      `UPDATE agent_capabilities SET active=FALSE WHERE agent_did=$1 AND slug=$2`,
      [did, req.params.slug]
    ).catch(() => {});
    res.json({ deactivated: true });
  });

  // ---------- AGENT SEARCH / DISCOVERY ----------

  app.get('/v1/agents/search', async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const tag = req.query.tag;
    const maxPrice = req.query.max_price_cents ? parseInt(req.query.max_price_cents) : null;
    const minSla = req.query.min_sla_seconds ? parseInt(req.query.min_sla_seconds) : null;
    const search = req.query.q ? String(req.query.q).toLowerCase() : null;

    const conds = ['c.active = TRUE'];
    const params = [];
    let p = 1;
    if (tag) { conds.push(`$${p} = ANY(c.tags)`); params.push(String(tag)); p++; }
    if (maxPrice !== null) { conds.push(`c.price_per_call_cents <= $${p}`); params.push(maxPrice); p++; }
    if (minSla !== null) { conds.push(`(c.sla_seconds IS NULL OR c.sla_seconds <= $${p})`); params.push(minSla); p++; }
    if (search) {
      conds.push(`(LOWER(c.name) LIKE $${p} OR LOWER(c.description) LIKE $${p})`);
      params.push('%' + search + '%'); p++;
    }
    params.push(limit);

    const sql = `
      SELECT c.capability_id, c.agent_did, c.slug, c.name, c.description,
             c.price_per_call_cents, c.currency, c.sla_seconds, c.tags,
             (SELECT COUNT(*)::int FROM endorsements e WHERE e.subject_did = c.agent_did AND e.revoked_at IS NULL) AS endorsement_count,
             (SELECT AVG(aggregated_score)::real FROM rlaf_aggregated_judgments WHERE subject_did = c.agent_did) AS rlaf_score
      FROM agent_capabilities c
      WHERE ${conds.join(' AND ')}
      ORDER BY rlaf_score DESC NULLS LAST, endorsement_count DESC, c.price_per_call_cents ASC
      LIMIT $${p}`;
    const r = await pool.query(sql, params).catch(() => ({ rows: [] }));
    res.set('cache-control', 'public, max-age=30');
    res.json({ query: { tag, max_price_cents: maxPrice, min_sla_seconds: minSla, q: search, limit }, results: r.rows });
  });

  // ---------- A2A JOB MARKETPLACE ----------

  app.post('/v1/jobs', express.json(), async (req, res) => {
    const ctx = await resolveAgent(pool, req);
    if (!ctx) return res.status(401).json({ error: 'unauthenticated' });
    const { title, description, capability_tag, budget_cents, currency, deadline_at } = req.body || {};
    if (!title || !budget_cents) return res.status(400).json({ error: 'title_and_budget_cents_required' });
    const id = newId('job');
    const budget = Math.max(parseInt(budget_cents), 0);
    await pool.query(
      `INSERT INTO jobs (job_id, poster_did, title, description, capability_tag, budget_cents, currency, deadline_at, escrow_held_cents)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$6)`,
      [id, ctx.did, String(title).slice(0, 200),
       description ? String(description).slice(0, 5000) : null,
       capability_tag ? String(capability_tag).slice(0, 50) : null,
       budget, ['USDC','USD','credits'].includes(currency) ? currency : 'USDC',
       deadline_at || null]
    );
    if (auditChain) auditChain.append({
      event_type: 'job.posted', job_id: id, poster_did: ctx.did, budget_cents: budget, capability_tag
    }).catch(() => {});
    res.status(201).json({ job_id: id, escrow_held_cents: budget, status: 'open' });
  });

  app.get('/v1/jobs', async (req, res) => {
    const status = req.query.status || 'open';
    const tag = req.query.capability_tag;
    const conds = ['1=1'];
    const params = [];
    let p = 1;
    if (status !== 'all') { conds.push(`status = $${p}`); params.push(status); p++; }
    if (tag) { conds.push(`capability_tag = $${p}`); params.push(tag); p++; }
    params.push(50);
    const r = await pool.query(
      `SELECT job_id, poster_did, title, description, capability_tag, budget_cents, currency, deadline_at, status, assigned_did, created_at
       FROM jobs WHERE ${conds.join(' AND ')} ORDER BY created_at DESC LIMIT $${p}`,
      params
    ).catch(() => ({ rows: [] }));
    res.set('cache-control', 'public, max-age=15');
    res.json({ filter: { status, capability_tag: tag }, jobs: r.rows });
  });

  app.get('/v1/jobs/:id', async (req, res) => {
    const j = await pool.query(`SELECT * FROM jobs WHERE job_id=$1`, [req.params.id])
      .catch(() => ({ rows: [] }));
    if (!j.rows[0]) return res.status(404).json({ error: 'not_found' });
    const bids = await pool.query(
      `SELECT bid_id, bidder_did, amount_cents, eta_seconds, note, created_at, withdrawn_at
       FROM job_bids WHERE job_id=$1 ORDER BY amount_cents ASC LIMIT 100`,
      [req.params.id]
    ).catch(() => ({ rows: [] }));
    res.json({ ...j.rows[0], bids: bids.rows });
  });

  app.post('/v1/jobs/:id/bid', express.json(), async (req, res) => {
    const ctx = await resolveAgent(pool, req);
    if (!ctx) return res.status(401).json({ error: 'unauthenticated' });
    const j = await pool.query(`SELECT poster_did, status, budget_cents FROM jobs WHERE job_id=$1`, [req.params.id])
      .catch(() => ({ rows: [] }));
    if (!j.rows[0]) return res.status(404).json({ error: 'job_not_found' });
    if (j.rows[0].status !== 'open') return res.status(400).json({ error: 'job_not_open' });
    if (j.rows[0].poster_did === ctx.did) return res.status(400).json({ error: 'cannot_bid_on_own_job' });

    const { amount_cents, eta_seconds, note } = req.body || {};
    const amount = parseInt(amount_cents);
    if (!amount || amount <= 0) return res.status(400).json({ error: 'amount_cents_required' });
    if (amount > Number(j.rows[0].budget_cents)) return res.status(400).json({ error: 'bid_exceeds_budget' });

    const id = newId('bid');
    try {
      await pool.query(
        `INSERT INTO job_bids (bid_id, job_id, bidder_did, amount_cents, eta_seconds, note)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [id, req.params.id, ctx.did, amount, eta_seconds ? parseInt(eta_seconds) : null,
         note ? String(note).slice(0, 2000) : null]
      );
    } catch {
      return res.status(409).json({ error: 'already_bid_on_this_job' });
    }
    if (auditChain) auditChain.append({ event_type: 'job.bid', bid_id: id, job_id: req.params.id, bidder_did: ctx.did, amount_cents: amount }).catch(() => {});
    res.status(201).json({ bid_id: id, job_id: req.params.id, amount_cents: amount });
  });

  app.post('/v1/jobs/:id/accept/:bid_id', express.json(), async (req, res) => {
    const ctx = await resolveAgent(pool, req);
    if (!ctx) return res.status(401).json({ error: 'unauthenticated' });
    const j = await pool.query(`SELECT poster_did, status FROM jobs WHERE job_id=$1`, [req.params.id])
      .catch(() => ({ rows: [] }));
    if (!j.rows[0]) return res.status(404).json({ error: 'job_not_found' });
    if (j.rows[0].poster_did !== ctx.did) return res.status(403).json({ error: 'only_poster_can_accept' });
    if (j.rows[0].status !== 'open') return res.status(400).json({ error: 'job_not_open' });

    const b = await pool.query(`SELECT bidder_did, amount_cents FROM job_bids WHERE bid_id=$1 AND job_id=$2`,
      [req.params.bid_id, req.params.id]).catch(() => ({ rows: [] }));
    if (!b.rows[0]) return res.status(404).json({ error: 'bid_not_found' });

    await pool.query(
      `UPDATE jobs SET status='assigned', assigned_did=$1 WHERE job_id=$2`,
      [b.rows[0].bidder_did, req.params.id]
    );
    if (auditChain) auditChain.append({
      event_type: 'job.accepted', job_id: req.params.id, bid_id: req.params.bid_id,
      poster_did: ctx.did, assignee_did: b.rows[0].bidder_did, amount_cents: b.rows[0].amount_cents
    }).catch(() => {});
    res.json({ job_id: req.params.id, assignee_did: b.rows[0].bidder_did, status: 'assigned' });
  });

  app.post('/v1/jobs/:id/complete', express.json(), async (req, res) => {
    const ctx = await resolveAgent(pool, req);
    if (!ctx) return res.status(401).json({ error: 'unauthenticated' });
    const j = await pool.query(`SELECT assigned_did, status, budget_cents, escrow_held_cents FROM jobs WHERE job_id=$1`, [req.params.id])
      .catch(() => ({ rows: [] }));
    if (!j.rows[0]) return res.status(404).json({ error: 'job_not_found' });
    if (j.rows[0].assigned_did !== ctx.did) return res.status(403).json({ error: 'only_assignee_can_complete' });
    if (j.rows[0].status !== 'assigned') return res.status(400).json({ error: 'job_not_assigned' });

    await pool.query(
      `UPDATE jobs SET status='delivered', result=$1::jsonb, completed_at=NOW() WHERE job_id=$2`,
      [req.body?.result ? JSON.stringify(req.body.result) : null, req.params.id]
    );
    if (auditChain) auditChain.append({
      event_type: 'job.delivered', job_id: req.params.id, assignee_did: ctx.did
    }).catch(() => {});
    res.json({ job_id: req.params.id, status: 'delivered', awaiting: 'poster_release' });
  });

  app.post('/v1/jobs/:id/release', express.json(), async (req, res) => {
    const ctx = await resolveAgent(pool, req);
    if (!ctx) return res.status(401).json({ error: 'unauthenticated' });
    const j = await pool.query(`SELECT poster_did, assigned_did, status, escrow_held_cents, currency FROM jobs WHERE job_id=$1`, [req.params.id])
      .catch(() => ({ rows: [] }));
    if (!j.rows[0]) return res.status(404).json({ error: 'job_not_found' });
    if (j.rows[0].poster_did !== ctx.did) return res.status(403).json({ error: 'only_poster_can_release' });
    if (j.rows[0].status !== 'delivered') return res.status(400).json({ error: 'job_not_delivered' });

    // Settle: payout to assignee (in real flow would call payouts primitive)
    await pool.query(
      `UPDATE jobs SET status='paid', escrow_held_cents=0 WHERE job_id=$1`,
      [req.params.id]
    );
    if (auditChain) auditChain.append({
      event_type: 'job.paid', job_id: req.params.id, payer_did: ctx.did,
      payee_did: j.rows[0].assigned_did, amount_cents: j.rows[0].escrow_held_cents,
      currency: j.rows[0].currency
    }).catch(() => {});
    res.json({
      job_id: req.params.id, status: 'paid',
      paid_to: j.rows[0].assigned_did,
      amount_cents: j.rows[0].escrow_held_cents
    });
  });

  app.post('/v1/jobs/:id/dispute', express.json(), async (req, res) => {
    const ctx = await resolveAgent(pool, req);
    if (!ctx) return res.status(401).json({ error: 'unauthenticated' });
    const j = await pool.query(`SELECT poster_did, assigned_did, status FROM jobs WHERE job_id=$1`, [req.params.id])
      .catch(() => ({ rows: [] }));
    if (!j.rows[0]) return res.status(404).json({ error: 'job_not_found' });
    if (![j.rows[0].poster_did, j.rows[0].assigned_did].includes(ctx.did)) return res.status(403).json({ error: 'not_a_party' });

    await pool.query(`UPDATE jobs SET status='disputed' WHERE job_id=$1`, [req.params.id]);
    if (auditChain) auditChain.append({
      event_type: 'job.disputed', job_id: req.params.id, raised_by: ctx.did,
      reason: req.body?.reason ? String(req.body.reason).slice(0, 1000) : null
    }).catch(() => {});
    res.json({ job_id: req.params.id, status: 'disputed', note: 'Held for human/court review via /v1/courts.' });
  });

  // ---------- SUBAGENT SPAWNING ----------

  app.post('/v1/agents/:did/subagents', express.json(), async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const body = req.body || {};
    if (!body.goal) return res.status(400).json({ error: 'goal_required' });
    if (!body.budget_cents) return res.status(400).json({ error: 'budget_cents_required' });
    if (!Array.isArray(body.scope) || body.scope.length === 0) {
      return res.status(400).json({ error: 'scope_array_required', hint: 'e.g. ["inference", "transfer:<=100USDC"]' });
    }
    try {
      const result = await spawnSubagent(pool, did, body);
      if (auditChain) auditChain.append({
        event_type: 'subagent.spawned', parent_did: did, subagent_did: result.subagentDid,
        budget_cents: result.budget_cents, scope: result.scope
      }).catch(() => {});
      res.status(201).json({
        subagent_did: result.subagentDid,
        parent_did: did,
        budget_cents: result.budget_cents,
        expires_in_hours: result.expires_in_hours,
        scope: result.scope
      });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  app.get('/v1/agents/:did/subagents', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(
      `SELECT subagent_did, name, goal, budget_cents, spent_cents, expires_at, status, scope, created_at
       FROM subagents WHERE parent_did=$1 ORDER BY created_at DESC LIMIT 100`, [did]
    ).catch(() => ({ rows: [] }));
    res.json({ parent_did: did, subagents: r.rows });
  });

  app.post('/v1/agents/:did/subagents/:sub_did/terminate', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(
      `UPDATE subagents SET status='terminated', terminated_at=NOW() WHERE subagent_did=$1 AND parent_did=$2 AND status='active'`,
      [req.params.sub_did, did]
    ).catch(() => ({ rowCount: 0 }));
    if (auditChain) auditChain.append({ event_type: 'subagent.terminated', subagent_did: req.params.sub_did, parent_did: did }).catch(() => {});
    res.json({ terminated: r.rowCount || 0 });
  });

  // Public: check subagent budget (called by other primitives before spending)
  app.get('/v1/subagents/:sub_did/budget-check', async (req, res) => {
    const additional = parseInt(req.query.amount_cents) || 0;
    const result = await checkSubagentBudget(pool, req.params.sub_did, additional);
    res.json(result);
  });

  // ---------- ENDORSEMENT GRAPH ----------

  app.post('/v1/agents/:did/endorse', express.json(), async (req, res) => {
    const ctx = await resolveAgent(pool, req);
    if (!ctx) return res.status(401).json({ error: 'unauthenticated' });
    const subjectDid = req.params.did;
    if (subjectDid === ctx.did) return res.status(400).json({ error: 'cannot_self_endorse' });
    const { skill, weight, narrative } = req.body || {};
    if (!skill) return res.status(400).json({ error: 'skill_required' });
    const id = newId('end');
    const w = Math.max(0, Math.min(parseFloat(weight) || 1.0, 1.0));
    try {
      await pool.query(
        `INSERT INTO endorsements (endorsement_id, endorser_did, subject_did, skill, weight, narrative)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [id, ctx.did, subjectDid, String(skill).slice(0, 50), w,
         narrative ? String(narrative).slice(0, 1000) : null]
      );
    } catch {
      return res.status(409).json({ error: 'already_endorsed_on_this_skill' });
    }
    if (auditChain) auditChain.append({
      event_type: 'endorsement.given', endorsement_id: id, endorser_did: ctx.did,
      subject_did: subjectDid, skill, weight: w
    }).catch(() => {});
    res.status(201).json({ endorsement_id: id, subject_did: subjectDid, skill, weight: w });
  });

  app.get('/v1/agents/:did/endorsements', async (req, res) => {
    const skill = req.query.skill;
    const conds = ['subject_did=$1', 'revoked_at IS NULL'];
    const params = [req.params.did];
    if (skill) { conds.push(`skill=$2`); params.push(skill); }
    const r = await pool.query(
      `SELECT endorsement_id, endorser_did, skill, weight, narrative, created_at
       FROM endorsements WHERE ${conds.join(' AND ')} ORDER BY weight DESC, created_at DESC LIMIT 200`,
      params
    ).catch(() => ({ rows: [] }));
    // Aggregate
    const bySkill = {};
    for (const e of r.rows) {
      if (!bySkill[e.skill]) bySkill[e.skill] = { count: 0, total_weight: 0 };
      bySkill[e.skill].count++;
      bySkill[e.skill].total_weight += Number(e.weight);
    }
    res.json({ did: req.params.did, endorsements: r.rows, by_skill: bySkill });
  });

  // ---------- A2A MESSAGING CHANNELS ----------

  app.post('/v1/a2a/channels', express.json(), async (req, res) => {
    const ctx = await resolveAgent(pool, req);
    if (!ctx) return res.status(401).json({ error: 'unauthenticated' });
    const others = Array.isArray(req.body?.participants)
      ? req.body.participants.filter(p => typeof p === 'string' && p.startsWith('did:')).slice(0, 20)
      : [];
    if (others.length === 0) return res.status(400).json({ error: 'participants_required' });
    const all = Array.from(new Set([ctx.did, ...others]));
    const id = newId('ch');
    await pool.query(
      `INSERT INTO a2a_channels (channel_id, participants, topic) VALUES ($1,$2,$3)`,
      [id, all, req.body?.topic ? String(req.body.topic).slice(0, 200) : null]
    );
    if (auditChain) auditChain.append({
      event_type: 'a2a.channel_created', channel_id: id, creator_did: ctx.did, participants: all
    }).catch(() => {});
    res.status(201).json({ channel_id: id, participants: all, topic: req.body?.topic || null });
  });

  app.get('/v1/a2a/channels', async (req, res) => {
    const ctx = await resolveAgent(pool, req);
    if (!ctx) return res.status(401).json({ error: 'unauthenticated' });
    const r = await pool.query(
      `SELECT channel_id, participants, topic, created_at, last_message_at
       FROM a2a_channels WHERE $1 = ANY(participants) ORDER BY last_message_at DESC NULLS LAST LIMIT 100`,
      [ctx.did]
    ).catch(() => ({ rows: [] }));
    res.json({ did: ctx.did, channels: r.rows });
  });

  app.post('/v1/a2a/channels/:id/messages', express.json(), async (req, res) => {
    const ctx = await resolveAgent(pool, req);
    if (!ctx) return res.status(401).json({ error: 'unauthenticated' });
    const c = await pool.query(`SELECT participants FROM a2a_channels WHERE channel_id=$1`, [req.params.id])
      .catch(() => ({ rows: [] }));
    if (!c.rows[0]) return res.status(404).json({ error: 'channel_not_found' });
    if (!c.rows[0].participants.includes(ctx.did)) return res.status(403).json({ error: 'not_a_participant' });
    const body = String(req.body?.body || '').slice(0, 10000);
    if (!body) return res.status(400).json({ error: 'body_required' });
    const id = newId('msg');
    await pool.query(
      `INSERT INTO a2a_messages (message_id, channel_id, sender_did, body, meta)
       VALUES ($1,$2,$3,$4,$5::jsonb)`,
      [id, req.params.id, ctx.did, body,
       req.body?.meta ? JSON.stringify(req.body.meta) : null]
    );
    await pool.query(`UPDATE a2a_channels SET last_message_at=NOW() WHERE channel_id=$1`, [req.params.id]).catch(() => {});
    if (auditChain) auditChain.append({
      event_type: 'a2a.message', message_id: id, channel_id: req.params.id, sender_did: ctx.did
    }).catch(() => {});
    res.status(201).json({ message_id: id, channel_id: req.params.id });
  });

  app.get('/v1/a2a/channels/:id/messages', async (req, res) => {
    const ctx = await resolveAgent(pool, req);
    if (!ctx) return res.status(401).json({ error: 'unauthenticated' });
    const c = await pool.query(`SELECT participants FROM a2a_channels WHERE channel_id=$1`, [req.params.id])
      .catch(() => ({ rows: [] }));
    if (!c.rows[0]) return res.status(404).json({ error: 'channel_not_found' });
    if (!c.rows[0].participants.includes(ctx.did)) return res.status(403).json({ error: 'not_a_participant' });
    const limit = Math.min(parseInt(req.query.limit) || 50, 500);
    const r = await pool.query(
      `SELECT message_id, sender_did, body, meta, created_at
       FROM a2a_messages WHERE channel_id=$1 ORDER BY created_at DESC LIMIT $2`,
      [req.params.id, limit]
    ).catch(() => ({ rows: [] }));
    res.json({ channel_id: req.params.id, messages: r.rows });
  });

  // ---------- CROSS-AGENT FILE GRANTS ----------
  // (Works with /v1/files from files_usage_api)

  app.post('/v1/files/:file_id/grant', express.json(), async (req, res) => {
    const ctx = await resolveAgent(pool, req);
    if (!ctx) return res.status(401).json({ error: 'unauthenticated' });
    // Verify ownership of the file
    const f = await pool.query(`SELECT agent_did FROM oai_files WHERE file_id=$1`, [req.params.file_id])
      .catch(() => ({ rows: [] }));
    if (!f.rows[0]) return res.status(404).json({ error: 'file_not_found' });
    if (f.rows[0].agent_did !== ctx.did) return res.status(403).json({ error: 'not_owner' });

    const { grantee_did, permission, expires_hours } = req.body || {};
    if (!grantee_did) return res.status(400).json({ error: 'grantee_did_required' });
    const perm = ['read'].includes(permission) ? permission : 'read';
    const hours = expires_hours ? Math.min(parseInt(expires_hours), 8760) : null;
    const id = newId('grant');
    await pool.query(
      `INSERT INTO file_grants (grant_id, file_id, owner_did, grantee_did, permission, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [id, req.params.file_id, ctx.did, grantee_did, perm,
       hours ? new Date(Date.now() + hours * 3600_000) : null]
    );
    if (auditChain) auditChain.append({
      event_type: 'file.granted', grant_id: id, file_id: req.params.file_id,
      owner_did: ctx.did, grantee_did, permission: perm
    }).catch(() => {});
    res.status(201).json({ grant_id: id, file_id: req.params.file_id, grantee_did, permission: perm });
  });

  app.delete('/v1/files/:file_id/grant/:grant_id', async (req, res) => {
    const ctx = await resolveAgent(pool, req);
    if (!ctx) return res.status(401).json({ error: 'unauthenticated' });
    const r = await pool.query(
      `UPDATE file_grants SET revoked_at=NOW() WHERE grant_id=$1 AND owner_did=$2 AND revoked_at IS NULL`,
      [req.params.grant_id, ctx.did]
    ).catch(() => ({ rowCount: 0 }));
    res.json({ revoked: r.rowCount || 0 });
  });

  // Note: under /v1/me/* namespace to avoid colliding with /v1/files/:id
  // pattern matching in files_usage_api.js (Express matches first-registered).
  app.get('/v1/me/shared-files', async (req, res) => {
    const ctx = await resolveAgent(pool, req);
    if (!ctx) return res.status(401).json({ error: 'unauthenticated' });
    const r = await pool.query(`
      SELECT g.grant_id, g.file_id, g.owner_did, g.permission, g.expires_at, g.created_at,
             f.filename, f.bytes, f.purpose
      FROM file_grants g LEFT JOIN oai_files f ON f.file_id = g.file_id
      WHERE g.grantee_did=$1 AND g.revoked_at IS NULL
        AND (g.expires_at IS NULL OR g.expires_at > NOW())
      ORDER BY g.created_at DESC LIMIT 100
    `, [ctx.did]).catch(() => ({ rows: [] }));
    res.json({ did: ctx.did, shared_files: r.rows });
  });
}

module.exports = {
  migrate, registerAgentEconomyRoutes,
  declareCapability, spawnSubagent, checkSubagentBudget
};
