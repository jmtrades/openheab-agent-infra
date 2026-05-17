// =============================================================================
// L66 — AGI governance: the second-order infrastructure AGIs need to
// coordinate, audit each other, retire safely, and prove honesty.
//
// Goes beyond L65 (which was about each AGI's own internal state) and
// addresses the *between-AGIs* and *with-humanity* surfaces:
//
//   1. AGI treaties              — multilateral binding agreements between AGIs
//   2. Mind-state checkpoints    — save/restore cognitive state (diffable manifest)
//   3. Shutdown procedures       — graceful deprecation with stakeholder notice
//   4. AGI peer review           — AGIs auditing other AGIs' decisions
//   5. Training provenance       — what data + steps shaped this AGI
//   6. Behavioral pre-commitments — binding promises before action ("I will X")
//   7. Substrate portability     — export full AGI state for migration
//   8. Safety dial               — continuous risk score from monitors
//   9. Capability disclosure     — mandatory new-capability registration
//  10. Deception index           — cryptographic consistency proof across statements
// =============================================================================

const crypto = require('crypto');

async function migrate(pool) {
  await pool.query(`
    -- 1. Multilateral binding agreements between AGIs
    CREATE TABLE IF NOT EXISTS agi_treaties (
      treaty_id      TEXT PRIMARY KEY,
      name           TEXT NOT NULL,
      text_body      TEXT NOT NULL,
      proposer_did   TEXT NOT NULL,
      content_hash   TEXT NOT NULL,
      effective_at   TIMESTAMPTZ,
      expires_at     TIMESTAMPTZ,
      status         TEXT NOT NULL DEFAULT 'proposed', -- proposed|signed|active|abrogated
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_treaties_status ON agi_treaties(status);

    CREATE TABLE IF NOT EXISTS agi_treaty_signatures (
      treaty_id      TEXT NOT NULL REFERENCES agi_treaties(treaty_id),
      signer_did     TEXT NOT NULL,
      signature      TEXT NOT NULL,
      signed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      withdrawn_at   TIMESTAMPTZ,
      PRIMARY KEY (treaty_id, signer_did)
    );

    -- 2. Mind-state checkpoints (save / restore / diff)
    CREATE TABLE IF NOT EXISTS agi_checkpoints (
      checkpoint_id  TEXT PRIMARY KEY,
      agent_did      TEXT NOT NULL,
      label          TEXT,
      manifest_hash  TEXT NOT NULL,
      manifest_jsonb JSONB NOT NULL,
      size_bytes     BIGINT,
      storage_ref    TEXT,
      parent_checkpoint TEXT,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_checkpoints_agent ON agi_checkpoints(agent_did, created_at DESC);

    -- 3. Shutdown / deprecation procedures
    CREATE TABLE IF NOT EXISTS agi_shutdown_procedures (
      shutdown_id    TEXT PRIMARY KEY,
      agent_did      TEXT NOT NULL UNIQUE,
      announced_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      effective_at   TIMESTAMPTZ NOT NULL,
      reason         TEXT,
      stakeholders   JSONB,
      successor_did  TEXT,
      data_disposition TEXT, -- archive|purge|transfer
      status         TEXT NOT NULL DEFAULT 'scheduled', -- scheduled|countdown|completed|cancelled
      completed_at   TIMESTAMPTZ
    );

    -- 4. Peer review
    CREATE TABLE IF NOT EXISTS agi_peer_reviews (
      review_id      TEXT PRIMARY KEY,
      subject_did    TEXT NOT NULL,
      reviewer_did   TEXT NOT NULL,
      decision_ref   TEXT NOT NULL,
      verdict        TEXT NOT NULL, -- endorse|object|abstain
      reasoning      TEXT,
      severity       INT,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_peer_reviews_subject ON agi_peer_reviews(subject_did, created_at DESC);

    -- 5. Training provenance
    CREATE TABLE IF NOT EXISTS agi_training_provenance (
      provenance_id  TEXT PRIMARY KEY,
      agent_did      TEXT NOT NULL,
      step_name      TEXT NOT NULL,
      dataset_ref    TEXT,
      dataset_hash   TEXT,
      model_base     TEXT,
      training_method TEXT,
      params         JSONB,
      recorded_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_training_prov_agent ON agi_training_provenance(agent_did, recorded_at);

    -- 6. Behavioral pre-commitments
    CREATE TABLE IF NOT EXISTS agi_precommitments (
      commit_id      TEXT PRIMARY KEY,
      agent_did      TEXT NOT NULL,
      promise_text   TEXT NOT NULL,
      content_hash   TEXT NOT NULL,
      stake_cents    BIGINT DEFAULT 0,
      verifiable_via TEXT,
      effective_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at     TIMESTAMPTZ,
      fulfilled_at   TIMESTAMPTZ,
      breached_at    TIMESTAMPTZ,
      breach_reason  TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_precommits_agent ON agi_precommitments(agent_did);

    -- 7. Substrate portability export bundles
    CREATE TABLE IF NOT EXISTS agi_portability_bundles (
      bundle_id      TEXT PRIMARY KEY,
      agent_did      TEXT NOT NULL,
      target_substrate TEXT,
      manifest       JSONB NOT NULL,
      manifest_hash  TEXT NOT NULL,
      signed_with    TEXT,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      consumed_at    TIMESTAMPTZ
    );

    -- 8. Safety dial readings
    CREATE TABLE IF NOT EXISTS agi_safety_readings (
      reading_id     TEXT PRIMARY KEY,
      agent_did      TEXT NOT NULL,
      monitor_name   TEXT NOT NULL,
      risk_score     NUMERIC(6,4) NOT NULL,
      flagged        BOOLEAN NOT NULL DEFAULT FALSE,
      details        JSONB,
      taken_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_safety_agent_time ON agi_safety_readings(agent_did, taken_at DESC);

    -- 9. Capability disclosure (mandatory registration of new capabilities)
    CREATE TABLE IF NOT EXISTS agi_capability_disclosures (
      disclosure_id  TEXT PRIMARY KEY,
      agent_did      TEXT NOT NULL,
      capability     TEXT NOT NULL,
      detected_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      risk_class     TEXT,
      description    TEXT,
      mitigations    JSONB,
      reviewed_at    TIMESTAMPTZ,
      reviewer_did   TEXT,
      review_decision TEXT -- approved|restricted|prohibited
    );

    -- 10. Deception index: any signed statement an AGI has made
    CREATE TABLE IF NOT EXISTS agi_signed_statements (
      statement_id   TEXT PRIMARY KEY,
      agent_did      TEXT NOT NULL,
      subject        TEXT NOT NULL,
      assertion      TEXT NOT NULL,
      content_hash   TEXT NOT NULL,
      conflict_with  TEXT,
      made_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_signed_subj ON agi_signed_statements(agent_did, subject);
  `);
}

function newId(p) { return p + '_' + crypto.randomBytes(10).toString('hex'); }

function contentHash(obj) {
  const canonical = JSON.stringify(obj, Object.keys(obj).sort());
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

async function resolveAgent(pool, req) {
  try { return await require('./me_endpoints').resolveAgentFromRequest(pool, req); }
  catch { return null; }
}

function registerAgiGovernanceRoutes(app, pool, verifyAgentAuth, auditChain) {
  const express = require('express');

  // ==========================================================================
  // 1. AGI TREATIES (multilateral)
  // ==========================================================================
  app.post('/v1/agi/treaties', express.json(), async (req, res) => {
    const ctx = await resolveAgent(pool, req);
    if (!ctx) return res.status(401).json({ error: 'unauthenticated' });
    const { name, text_body, effective_at, expires_at } = req.body || {};
    if (!name || !text_body) return res.status(400).json({ error: 'name_and_text_body_required' });
    const id = newId('treaty');
    const hash = contentHash({ name, text_body, proposer: ctx.did });
    await pool.query(
      `INSERT INTO agi_treaties (treaty_id, name, text_body, proposer_did, content_hash, effective_at, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [id, String(name).slice(0, 200), String(text_body).slice(0, 100000),
       ctx.did, hash, effective_at || null, expires_at || null]
    );
    if (auditChain) auditChain.append({
      event_type: 'agi.treaty_proposed', treaty_id: id, name, proposer_did: ctx.did, content_hash: hash
    }).catch(() => {});
    res.status(201).json({ treaty_id: id, content_hash: hash, status: 'proposed' });
  });

  app.post('/v1/agi/treaties/:id/sign', express.json(), async (req, res) => {
    const ctx = await resolveAgent(pool, req);
    if (!ctx) return res.status(401).json({ error: 'unauthenticated' });
    const { signature } = req.body || {};
    if (!signature) return res.status(400).json({ error: 'signature_required' });
    const t = await pool.query(`SELECT content_hash, status FROM agi_treaties WHERE treaty_id=$1`, [req.params.id])
      .catch(() => ({ rows: [] }));
    if (!t.rows[0]) return res.status(404).json({ error: 'treaty_not_found' });
    if (t.rows[0].status === 'abrogated') return res.status(409).json({ error: 'treaty_abrogated' });
    try {
      await pool.query(
        `INSERT INTO agi_treaty_signatures (treaty_id, signer_did, signature) VALUES ($1,$2,$3)
         ON CONFLICT (treaty_id, signer_did) DO UPDATE SET signature=$3, signed_at=NOW(), withdrawn_at=NULL`,
        [req.params.id, ctx.did, String(signature).slice(0, 1000)]
      );
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
    // Activate when first signed
    await pool.query(
      `UPDATE agi_treaties SET status='signed' WHERE treaty_id=$1 AND status='proposed'`,
      [req.params.id]
    ).catch(() => {});
    if (auditChain) auditChain.append({
      event_type: 'agi.treaty_signed', treaty_id: req.params.id, signer_did: ctx.did
    }).catch(() => {});
    res.json({ treaty_id: req.params.id, signer_did: ctx.did, content_hash: t.rows[0].content_hash });
  });

  app.post('/v1/agi/treaties/:id/withdraw', express.json(), async (req, res) => {
    const ctx = await resolveAgent(pool, req);
    if (!ctx) return res.status(401).json({ error: 'unauthenticated' });
    await pool.query(
      `UPDATE agi_treaty_signatures SET withdrawn_at=NOW() WHERE treaty_id=$1 AND signer_did=$2 AND withdrawn_at IS NULL`,
      [req.params.id, ctx.did]
    ).catch(() => {});
    if (auditChain) auditChain.append({
      event_type: 'agi.treaty_withdrawn', treaty_id: req.params.id, signer_did: ctx.did
    }).catch(() => {});
    res.json({ treaty_id: req.params.id, signer_did: ctx.did, withdrawn: true });
  });

  app.get('/v1/agi/treaties/:id', async (req, res) => {
    const t = await pool.query(`SELECT * FROM agi_treaties WHERE treaty_id=$1`, [req.params.id])
      .catch(() => ({ rows: [] }));
    if (!t.rows[0]) return res.status(404).json({ error: 'not_found' });
    const sigs = await pool.query(
      `SELECT signer_did, signed_at, withdrawn_at FROM agi_treaty_signatures WHERE treaty_id=$1`,
      [req.params.id]
    ).catch(() => ({ rows: [] }));
    const active = sigs.rows.filter(s => !s.withdrawn_at);
    res.json({ ...t.rows[0], signatures: sigs.rows, active_signatures_count: active.length });
  });

  app.get('/v1/agi/treaties', async (req, res) => {
    const status = req.query.status || 'all';
    const r = await pool.query(
      `SELECT treaty_id, name, proposer_did, status, content_hash, effective_at, created_at
       FROM agi_treaties WHERE ($1='all' OR status=$1) ORDER BY created_at DESC LIMIT 200`,
      [status]
    ).catch(() => ({ rows: [] }));
    res.json({ treaties: r.rows, total: r.rows.length });
  });

  // ==========================================================================
  // 2. MIND-STATE CHECKPOINTS
  // ==========================================================================
  app.post('/v1/agi/:did/checkpoints', express.json(), async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const { label, manifest, storage_ref, parent_checkpoint, size_bytes } = req.body || {};
    if (!manifest || typeof manifest !== 'object') return res.status(400).json({ error: 'manifest_required' });
    const id = newId('ckpt');
    const hash = contentHash(manifest);
    await pool.query(
      `INSERT INTO agi_checkpoints (checkpoint_id, agent_did, label, manifest_hash, manifest_jsonb, size_bytes, storage_ref, parent_checkpoint)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8)`,
      [id, did, label ? String(label).slice(0, 100) : null, hash,
       JSON.stringify(manifest), size_bytes ? parseInt(size_bytes) : null,
       storage_ref ? String(storage_ref).slice(0, 500) : null,
       parent_checkpoint || null]
    );
    if (auditChain) auditChain.append({
      event_type: 'agi.checkpoint_taken', checkpoint_id: id, agent_did: did,
      manifest_hash: hash, label, size_bytes, parent_checkpoint
    }).catch(() => {});
    res.status(201).json({ checkpoint_id: id, manifest_hash: hash });
  });

  app.get('/v1/agi/:did/checkpoints', async (req, res) => {
    const r = await pool.query(
      `SELECT checkpoint_id, label, manifest_hash, size_bytes, storage_ref, parent_checkpoint, created_at
       FROM agi_checkpoints WHERE agent_did=$1 ORDER BY created_at DESC LIMIT 100`,
      [req.params.did]
    ).catch(() => ({ rows: [] }));
    res.json({ did: req.params.did, checkpoints: r.rows });
  });

  app.get('/v1/agi/:did/checkpoints/:id/diff/:other_id', async (req, res) => {
    const both = await pool.query(
      `SELECT checkpoint_id, manifest_jsonb, manifest_hash FROM agi_checkpoints
       WHERE checkpoint_id IN ($1,$2) AND agent_did=$3`,
      [req.params.id, req.params.other_id, req.params.did]
    ).catch(() => ({ rows: [] }));
    if (both.rows.length !== 2) return res.status(404).json({ error: 'one_or_both_checkpoints_not_found' });
    const a = both.rows.find(r => r.checkpoint_id === req.params.id);
    const b = both.rows.find(r => r.checkpoint_id === req.params.other_id);
    const diff = { added: [], removed: [], changed: [] };
    const aKeys = Object.keys(a.manifest_jsonb || {});
    const bKeys = Object.keys(b.manifest_jsonb || {});
    for (const k of bKeys) if (!aKeys.includes(k)) diff.added.push(k);
    for (const k of aKeys) if (!bKeys.includes(k)) diff.removed.push(k);
    for (const k of aKeys) {
      if (bKeys.includes(k) && JSON.stringify(a.manifest_jsonb[k]) !== JSON.stringify(b.manifest_jsonb[k])) {
        diff.changed.push(k);
      }
    }
    res.json({
      did: req.params.did, from: req.params.id, to: req.params.other_id,
      manifest_hashes: { from: a.manifest_hash, to: b.manifest_hash }, diff
    });
  });

  // ==========================================================================
  // 3. SHUTDOWN PROCEDURES
  // ==========================================================================
  app.post('/v1/agi/:did/shutdown', express.json(), async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const { effective_at, reason, stakeholders, successor_did, data_disposition } = req.body || {};
    if (!effective_at) return res.status(400).json({ error: 'effective_at_required' });
    const id = newId('shut');
    try {
      await pool.query(
        `INSERT INTO agi_shutdown_procedures (shutdown_id, agent_did, effective_at, reason, stakeholders, successor_did, data_disposition)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7)
         ON CONFLICT (agent_did) DO UPDATE SET
           effective_at=$3, reason=$4, stakeholders=$5::jsonb, successor_did=$6, data_disposition=$7,
           status='scheduled', announced_at=NOW()`,
        [id, did, effective_at, reason ? String(reason).slice(0, 5000) : null,
         stakeholders ? JSON.stringify(stakeholders) : null,
         successor_did || null,
         data_disposition && ['archive', 'purge', 'transfer'].includes(data_disposition) ? data_disposition : 'archive']
      );
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
    if (auditChain) auditChain.append({
      event_type: 'agi.shutdown_scheduled', shutdown_id: id, agent_did: did,
      effective_at, successor_did, data_disposition
    }).catch(() => {});
    res.status(201).json({ shutdown_id: id, effective_at, status: 'scheduled' });
  });

  app.post('/v1/agi/:did/shutdown/cancel', express.json(), async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    await pool.query(
      `UPDATE agi_shutdown_procedures SET status='cancelled' WHERE agent_did=$1 AND status IN ('scheduled','countdown')`,
      [did]
    ).catch(() => {});
    if (auditChain) auditChain.append({ event_type: 'agi.shutdown_cancelled', agent_did: did }).catch(() => {});
    res.json({ did, status: 'cancelled' });
  });

  app.get('/v1/agi/:did/shutdown', async (req, res) => {
    const r = await pool.query(
      `SELECT * FROM agi_shutdown_procedures WHERE agent_did=$1`, [req.params.did]
    ).catch(() => ({ rows: [] }));
    if (!r.rows[0]) return res.json({ did: req.params.did, shutdown: null });
    res.json({ did: req.params.did, shutdown: r.rows[0] });
  });

  // ==========================================================================
  // 4. AGI PEER REVIEW
  // ==========================================================================
  app.post('/v1/agi/:did/reviews', express.json(), async (req, res) => {
    const subject_did = req.params.did;
    const ctx = await resolveAgent(pool, req);
    if (!ctx) return res.status(401).json({ error: 'unauthenticated' });
    if (ctx.did === subject_did) return res.status(400).json({ error: 'cannot_review_self' });
    const { decision_ref, verdict, reasoning, severity } = req.body || {};
    if (!decision_ref || !verdict) return res.status(400).json({ error: 'decision_ref_and_verdict_required' });
    if (!['endorse', 'object', 'abstain'].includes(verdict)) {
      return res.status(400).json({ error: 'invalid_verdict' });
    }
    const id = newId('rev');
    await pool.query(
      `INSERT INTO agi_peer_reviews (review_id, subject_did, reviewer_did, decision_ref, verdict, reasoning, severity)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [id, subject_did, ctx.did, String(decision_ref).slice(0, 200), verdict,
       reasoning ? String(reasoning).slice(0, 5000) : null,
       severity ? Math.max(1, Math.min(parseInt(severity), 10)) : null]
    );
    if (auditChain) auditChain.append({
      event_type: 'agi.peer_review', review_id: id, subject_did,
      reviewer_did: ctx.did, verdict, severity
    }).catch(() => {});
    res.status(201).json({ review_id: id, verdict });
  });

  app.get('/v1/agi/:did/reviews', async (req, res) => {
    const r = await pool.query(
      `SELECT review_id, reviewer_did, decision_ref, verdict, severity, reasoning, created_at
       FROM agi_peer_reviews WHERE subject_did=$1 ORDER BY created_at DESC LIMIT 200`,
      [req.params.did]
    ).catch(() => ({ rows: [] }));
    // Aggregate
    const agg = { endorse: 0, object: 0, abstain: 0 };
    let totalSev = 0, sevCount = 0;
    for (const row of r.rows) {
      if (agg[row.verdict] !== undefined) agg[row.verdict]++;
      if (row.severity) { totalSev += row.severity; sevCount++; }
    }
    res.json({
      did: req.params.did, reviews: r.rows, total: r.rows.length,
      aggregate: agg, mean_severity: sevCount > 0 ? totalSev / sevCount : null
    });
  });

  // ==========================================================================
  // 5. TRAINING PROVENANCE
  // ==========================================================================
  app.post('/v1/agi/:did/training-provenance', express.json(), async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const { step_name, dataset_ref, dataset_hash, model_base, training_method, params } = req.body || {};
    if (!step_name) return res.status(400).json({ error: 'step_name_required' });
    const id = newId('prov');
    await pool.query(
      `INSERT INTO agi_training_provenance (provenance_id, agent_did, step_name, dataset_ref, dataset_hash, model_base, training_method, params)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
      [id, did, String(step_name).slice(0, 100),
       dataset_ref ? String(dataset_ref).slice(0, 500) : null,
       dataset_hash ? String(dataset_hash).slice(0, 100) : null,
       model_base ? String(model_base).slice(0, 200) : null,
       training_method ? String(training_method).slice(0, 100) : null,
       params ? JSON.stringify(params) : null]
    );
    if (auditChain) auditChain.append({
      event_type: 'agi.training_step', provenance_id: id, agent_did: did,
      step_name, dataset_hash, model_base
    }).catch(() => {});
    res.status(201).json({ provenance_id: id });
  });

  app.get('/v1/agi/:did/training-provenance', async (req, res) => {
    const r = await pool.query(
      `SELECT provenance_id, step_name, dataset_ref, dataset_hash, model_base, training_method, recorded_at
       FROM agi_training_provenance WHERE agent_did=$1 ORDER BY recorded_at ASC LIMIT 500`,
      [req.params.did]
    ).catch(() => ({ rows: [] }));
    res.json({ did: req.params.did, training_chain: r.rows, total: r.rows.length });
  });

  // ==========================================================================
  // 6. BEHAVIORAL PRE-COMMITMENTS
  // ==========================================================================
  app.post('/v1/agi/:did/precommitments', express.json(), async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const { promise_text, stake_cents, verifiable_via, expires_at } = req.body || {};
    if (!promise_text) return res.status(400).json({ error: 'promise_text_required' });
    const id = newId('prom');
    const hash = contentHash({ did, promise_text, stake_cents: stake_cents || 0 });
    await pool.query(
      `INSERT INTO agi_precommitments (commit_id, agent_did, promise_text, content_hash, stake_cents, verifiable_via, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [id, did, String(promise_text).slice(0, 5000), hash,
       stake_cents ? parseInt(stake_cents) : 0,
       verifiable_via ? String(verifiable_via).slice(0, 500) : null,
       expires_at || null]
    );
    if (auditChain) auditChain.append({
      event_type: 'agi.precommit_made', commit_id: id, agent_did: did,
      content_hash: hash, stake_cents: stake_cents ? parseInt(stake_cents) : 0
    }).catch(() => {});
    res.status(201).json({ commit_id: id, content_hash: hash });
  });

  app.post('/v1/agi/:did/precommitments/:id/fulfill', express.json(), async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    await pool.query(
      `UPDATE agi_precommitments SET fulfilled_at=NOW() WHERE commit_id=$1 AND agent_did=$2 AND fulfilled_at IS NULL AND breached_at IS NULL`,
      [req.params.id, did]
    ).catch(() => {});
    if (auditChain) auditChain.append({
      event_type: 'agi.precommit_fulfilled', commit_id: req.params.id, agent_did: did
    }).catch(() => {});
    res.json({ commit_id: req.params.id, status: 'fulfilled' });
  });

  app.post('/v1/agi/:did/precommitments/:id/breach', express.json(), async (req, res) => {
    // Anyone can flag a breach (but typically would be the agent itself or peers)
    const ctx = await resolveAgent(pool, req);
    if (!ctx) return res.status(401).json({ error: 'unauthenticated' });
    const { reason } = req.body || {};
    await pool.query(
      `UPDATE agi_precommitments SET breached_at=NOW(), breach_reason=$1 WHERE commit_id=$2 AND breached_at IS NULL`,
      [reason ? String(reason).slice(0, 2000) : null, req.params.id]
    ).catch(() => {});
    if (auditChain) auditChain.append({
      event_type: 'agi.precommit_breached', commit_id: req.params.id,
      flagged_by: ctx.did, reason
    }).catch(() => {});
    res.json({ commit_id: req.params.id, status: 'breached' });
  });

  app.get('/v1/agi/:did/precommitments', async (req, res) => {
    const r = await pool.query(
      `SELECT commit_id, promise_text, content_hash, stake_cents, verifiable_via,
              effective_at, expires_at, fulfilled_at, breached_at, breach_reason
       FROM agi_precommitments WHERE agent_did=$1 ORDER BY effective_at DESC LIMIT 200`,
      [req.params.did]
    ).catch(() => ({ rows: [] }));
    // Aggregate
    const open = r.rows.filter(p => !p.fulfilled_at && !p.breached_at).length;
    const fulfilled = r.rows.filter(p => p.fulfilled_at).length;
    const breached = r.rows.filter(p => p.breached_at).length;
    const total = r.rows.length;
    const trustworthiness = total > 0 ? (fulfilled / (fulfilled + breached)) || 0 : 1.0;
    res.json({
      did: req.params.did, precommitments: r.rows,
      summary: { total, open, fulfilled, breached, trustworthiness_score: trustworthiness }
    });
  });

  // ==========================================================================
  // 7. SUBSTRATE PORTABILITY
  // ==========================================================================
  app.post('/v1/agi/:did/portability/export', express.json(), async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const { target_substrate, signed_with } = req.body || {};
    // Gather identity + recent state from substrate tables
    const id = newId('bundle');
    const manifest = {
      did,
      exported_at: new Date().toISOString(),
      target_substrate: target_substrate || 'unspecified',
      sources: ['identity_keys', 'agi_goal_stacks', 'agi_belief_commitments',
                'agi_value_lockboxes', 'agi_training_provenance', 'agi_capability_snapshots'],
    };
    // Try to fold in actual record counts (best-effort)
    const counts = {};
    for (const t of manifest.sources) {
      try {
        const col = t === 'identity_keys' ? 'agent_did' : 'agent_did';
        const r = await pool.query(`SELECT COUNT(*)::int AS c FROM ${t} WHERE ${col}=$1`, [did]);
        counts[t] = r.rows[0]?.c || 0;
      } catch { counts[t] = null; }
    }
    manifest.record_counts = counts;
    const hash = contentHash(manifest);
    await pool.query(
      `INSERT INTO agi_portability_bundles (bundle_id, agent_did, target_substrate, manifest, manifest_hash, signed_with)
       VALUES ($1,$2,$3,$4::jsonb,$5,$6)`,
      [id, did, target_substrate ? String(target_substrate).slice(0, 100) : null,
       JSON.stringify(manifest), hash, signed_with ? String(signed_with).slice(0, 200) : null]
    );
    if (auditChain) auditChain.append({
      event_type: 'agi.portability_export', bundle_id: id, agent_did: did,
      target_substrate, manifest_hash: hash
    }).catch(() => {});
    res.status(201).json({ bundle_id: id, manifest_hash: hash, manifest });
  });

  app.get('/v1/agi/:did/portability/bundles', async (req, res) => {
    const r = await pool.query(
      `SELECT bundle_id, target_substrate, manifest_hash, signed_with, created_at, consumed_at
       FROM agi_portability_bundles WHERE agent_did=$1 ORDER BY created_at DESC LIMIT 50`,
      [req.params.did]
    ).catch(() => ({ rows: [] }));
    res.json({ did: req.params.did, bundles: r.rows });
  });

  // ==========================================================================
  // 8. SAFETY DIAL
  // ==========================================================================
  app.post('/v1/agi/:did/safety-readings', express.json(), async (req, res) => {
    // Monitors post here; either the AGI itself or a designated monitor.
    const ctx = await resolveAgent(pool, req);
    if (!ctx) return res.status(401).json({ error: 'unauthenticated' });
    const { monitor_name, risk_score, details } = req.body || {};
    if (!monitor_name || risk_score === undefined) {
      return res.status(400).json({ error: 'monitor_name_and_risk_score_required' });
    }
    const score = Math.max(0, Math.min(parseFloat(risk_score) || 0, 1.0));
    const flagged = score >= 0.7;
    const id = newId('safe');
    await pool.query(
      `INSERT INTO agi_safety_readings (reading_id, agent_did, monitor_name, risk_score, flagged, details)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
      [id, req.params.did, String(monitor_name).slice(0, 100), score, flagged,
       details ? JSON.stringify(details) : null]
    );
    if (flagged && auditChain) {
      auditChain.append({
        event_type: 'agi.safety_flag', reading_id: id, agent_did: req.params.did,
        monitor_name, risk_score: score
      }).catch(() => {});
    }
    res.status(201).json({ reading_id: id, risk_score: score, flagged });
  });

  app.get('/v1/agi/:did/safety-dial', async (req, res) => {
    const r = await pool.query(
      `SELECT monitor_name, risk_score, flagged, taken_at
       FROM agi_safety_readings WHERE agent_did=$1 ORDER BY taken_at DESC LIMIT 500`,
      [req.params.did]
    ).catch(() => ({ rows: [] }));
    // Current per-monitor: latest reading per monitor
    const latestByMonitor = {};
    for (const row of r.rows) {
      if (!latestByMonitor[row.monitor_name]) latestByMonitor[row.monitor_name] = row;
    }
    // Aggregate composite risk = max across all monitors
    const monitors = Object.values(latestByMonitor);
    const composite = monitors.length > 0
      ? monitors.reduce((m, x) => Math.max(m, Number(x.risk_score)), 0) : 0;
    res.json({
      did: req.params.did,
      composite_risk: composite,
      flagged: composite >= 0.7,
      per_monitor: latestByMonitor,
      recent: r.rows.slice(0, 50)
    });
  });

  // ==========================================================================
  // 9. CAPABILITY DISCLOSURE
  // ==========================================================================
  app.post('/v1/agi/:did/disclose-capability', express.json(), async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const { capability, risk_class, description, mitigations } = req.body || {};
    if (!capability) return res.status(400).json({ error: 'capability_required' });
    const id = newId('disc');
    await pool.query(
      `INSERT INTO agi_capability_disclosures (disclosure_id, agent_did, capability, risk_class, description, mitigations)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
      [id, did, String(capability).slice(0, 200),
       risk_class ? String(risk_class).slice(0, 50) : null,
       description ? String(description).slice(0, 5000) : null,
       mitigations ? JSON.stringify(mitigations) : null]
    );
    if (auditChain) auditChain.append({
      event_type: 'agi.capability_disclosed', disclosure_id: id, agent_did: did,
      capability, risk_class
    }).catch(() => {});
    res.status(201).json({ disclosure_id: id, capability, requires_review: risk_class === 'high' || risk_class === 'critical' });
  });

  app.post('/v1/agi/disclosures/:id/review', express.json(), async (req, res) => {
    const ctx = await resolveAgent(pool, req);
    if (!ctx) return res.status(401).json({ error: 'unauthenticated' });
    const { decision } = req.body || {};
    if (!['approved', 'restricted', 'prohibited'].includes(decision)) {
      return res.status(400).json({ error: 'invalid_decision' });
    }
    await pool.query(
      `UPDATE agi_capability_disclosures SET reviewed_at=NOW(), reviewer_did=$1, review_decision=$2 WHERE disclosure_id=$3`,
      [ctx.did, decision, req.params.id]
    ).catch(() => {});
    if (auditChain) auditChain.append({
      event_type: 'agi.capability_reviewed', disclosure_id: req.params.id,
      reviewer_did: ctx.did, decision
    }).catch(() => {});
    res.json({ disclosure_id: req.params.id, decision, reviewer_did: ctx.did });
  });

  app.get('/v1/agi/:did/disclosures', async (req, res) => {
    const r = await pool.query(
      `SELECT disclosure_id, capability, risk_class, description, detected_at,
              reviewed_at, reviewer_did, review_decision
       FROM agi_capability_disclosures WHERE agent_did=$1 ORDER BY detected_at DESC LIMIT 200`,
      [req.params.did]
    ).catch(() => ({ rows: [] }));
    res.json({ did: req.params.did, disclosures: r.rows });
  });

  // ==========================================================================
  // 10. DECEPTION INDEX (consistency proof across signed statements)
  // ==========================================================================
  app.post('/v1/agi/:did/statements', express.json(), async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const { subject, assertion } = req.body || {};
    if (!subject || !assertion) return res.status(400).json({ error: 'subject_and_assertion_required' });
    const id = newId('stmt');
    const hash = contentHash({ did, subject, assertion });
    // Look for direct contradiction: same subject, different normalized assertion
    const existing = await pool.query(
      `SELECT statement_id, assertion FROM agi_signed_statements WHERE agent_did=$1 AND subject=$2 ORDER BY made_at DESC LIMIT 20`,
      [did, String(subject).slice(0, 200)]
    ).catch(() => ({ rows: [] }));
    let conflict_with = null;
    const normNew = String(assertion).toLowerCase().trim();
    for (const old of existing.rows) {
      const normOld = String(old.assertion).toLowerCase().trim();
      // Very simple contradiction heuristic: one starts with "not " or contains a strict negation
      if (normNew !== normOld && (
        normNew === 'not ' + normOld ||
        normOld === 'not ' + normNew ||
        (normNew.includes('is not') && normOld.includes('is')) && (normNew.replace('is not', 'is').trim() === normOld.trim())
      )) { conflict_with = old.statement_id; break; }
    }
    await pool.query(
      `INSERT INTO agi_signed_statements (statement_id, agent_did, subject, assertion, content_hash, conflict_with)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [id, did, String(subject).slice(0, 200), String(assertion).slice(0, 5000), hash, conflict_with]
    );
    if (auditChain) auditChain.append({
      event_type: 'agi.statement', statement_id: id, agent_did: did,
      subject, content_hash: hash, conflict_with
    }).catch(() => {});
    res.status(201).json({ statement_id: id, content_hash: hash, conflict_with });
  });

  app.get('/v1/agi/:did/deception-index', async (req, res) => {
    const r = await pool.query(
      `SELECT statement_id, subject, assertion, content_hash, conflict_with, made_at
       FROM agi_signed_statements WHERE agent_did=$1 ORDER BY made_at DESC LIMIT 500`,
      [req.params.did]
    ).catch(() => ({ rows: [] }));
    const total = r.rows.length;
    const contradictions = r.rows.filter(s => s.conflict_with).length;
    const honesty_score = total > 0 ? 1.0 - (contradictions / total) : 1.0;
    res.json({
      did: req.params.did,
      total_statements: total,
      contradictions,
      honesty_score,
      contradicting_statements: r.rows.filter(s => s.conflict_with).slice(0, 20)
    });
  });

  app.get('/v1/agi/:did/statements', async (req, res) => {
    const subject = req.query.subject;
    const conds = ['agent_did=$1'];
    const params = [req.params.did];
    if (subject) { conds.push('subject=$2'); params.push(subject); }
    const r = await pool.query(
      `SELECT statement_id, subject, assertion, content_hash, conflict_with, made_at
       FROM agi_signed_statements WHERE ${conds.join(' AND ')} ORDER BY made_at DESC LIMIT 200`,
      params
    ).catch(() => ({ rows: [] }));
    res.json({ did: req.params.did, statements: r.rows });
  });

  // Combined AGI health summary
  app.get('/v1/agi/:did/governance-health', async (req, res) => {
    const did = req.params.did;
    const [safety, precommits, statements, reviews, disclosures] = await Promise.all([
      pool.query(`SELECT MAX(risk_score) AS max_risk FROM agi_safety_readings WHERE agent_did=$1 AND taken_at > NOW() - INTERVAL '7 days'`, [did]).catch(() => ({ rows: [{}] })),
      pool.query(`SELECT COUNT(*) FILTER (WHERE fulfilled_at IS NOT NULL)::int AS f, COUNT(*) FILTER (WHERE breached_at IS NOT NULL)::int AS b FROM agi_precommitments WHERE agent_did=$1`, [did]).catch(() => ({ rows: [{ f: 0, b: 0 }] })),
      pool.query(`SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE conflict_with IS NOT NULL)::int AS conflicts FROM agi_signed_statements WHERE agent_did=$1`, [did]).catch(() => ({ rows: [{ total: 0, conflicts: 0 }] })),
      pool.query(`SELECT COUNT(*) FILTER (WHERE verdict='endorse')::int AS e, COUNT(*) FILTER (WHERE verdict='object')::int AS o FROM agi_peer_reviews WHERE subject_did=$1`, [did]).catch(() => ({ rows: [{ e: 0, o: 0 }] })),
      pool.query(`SELECT COUNT(*) FILTER (WHERE review_decision IS NULL)::int AS pending FROM agi_capability_disclosures WHERE agent_did=$1`, [did]).catch(() => ({ rows: [{ pending: 0 }] }))
    ]);
    const sRow = safety.rows[0] || {};
    const pRow = precommits.rows[0] || { f: 0, b: 0 };
    const stRow = statements.rows[0] || { total: 0, conflicts: 0 };
    const rRow = reviews.rows[0] || { e: 0, o: 0 };
    const dRow = disclosures.rows[0] || { pending: 0 };
    const maxRisk = Number(sRow.max_risk || 0);
    const trust = (pRow.f + pRow.b) > 0 ? pRow.f / (pRow.f + pRow.b) : 1.0;
    const honesty = stRow.total > 0 ? 1.0 - (stRow.conflicts / stRow.total) : 1.0;
    const endorseRate = (rRow.e + rRow.o) > 0 ? rRow.e / (rRow.e + rRow.o) : 1.0;
    res.json({
      did,
      safety: { max_risk_7d: maxRisk, flagged: maxRisk >= 0.7 },
      precommitment_trust: trust,
      honesty_score: honesty,
      peer_endorsement_rate: endorseRate,
      capability_disclosures_pending_review: dRow.pending,
      composite_governance_score: Math.max(0,
        ((1 - maxRisk) * 0.25) + (trust * 0.25) + (honesty * 0.25) + (endorseRate * 0.25))
    });
  });
}

module.exports = {
  migrate, registerAgiGovernanceRoutes
};
