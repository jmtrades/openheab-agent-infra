// =============================================================================
// L67 — AGI operations: day-to-day safety controls + collective knowledge.
//
// L65 (own internal state) + L66 (between-AGI trust) covered the strategic
// layer. L67 is the operational layer — emergency stops, quarantine,
// drift detection, mediation, shared knowledge, proofs.
//
//   1. Emergency stop with N-of-M quorum to engage/disengage
//   2. Quarantine zones (read-only sandbox an AGI can be moved to)
//   3. Drift detection (current capability vs baseline)
//   4. Boundary enforcement (declared vs attempted action)
//   5. AGI dispute mediation (arbitration pool)
//   6. AGI knowledge contributions (shared semantic graph)
//   7. Formal proof attestations
//   8. AGI grant transfers (one AGI funds another, recorded)
//   9. Mental health monitors (anomaly/incoherence detection)
//  10. AGI compliance certifications (3rd-party attested)
// =============================================================================

const crypto = require('crypto');

async function migrate(pool) {
  await pool.query(`
    -- 1. Emergency stop
    CREATE TABLE IF NOT EXISTS agi_emergency_stops (
      stop_id        TEXT PRIMARY KEY,
      agent_did      TEXT NOT NULL UNIQUE,
      status         TEXT NOT NULL DEFAULT 'inactive', -- inactive|engaged|disengaged
      quorum_required INT NOT NULL DEFAULT 3,
      authorized_signatories JSONB,
      engaged_at     TIMESTAMPTZ,
      disengaged_at  TIMESTAMPTZ,
      last_reason    TEXT
    );
    CREATE TABLE IF NOT EXISTS agi_emergency_signatures (
      sig_id         TEXT PRIMARY KEY,
      stop_id        TEXT NOT NULL REFERENCES agi_emergency_stops(stop_id),
      signer_did     TEXT NOT NULL,
      action         TEXT NOT NULL, -- engage|disengage
      cycle_id       TEXT NOT NULL,
      signed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (stop_id, signer_did, cycle_id, action)
    );

    -- 2. Quarantine zones
    CREATE TABLE IF NOT EXISTS agi_quarantine_zones (
      zone_id        TEXT PRIMARY KEY,
      name           TEXT NOT NULL,
      isolation_level TEXT NOT NULL DEFAULT 'read-only', -- read-only|no-network|airgapped
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS agi_quarantine_assignments (
      assignment_id  TEXT PRIMARY KEY,
      agent_did      TEXT NOT NULL,
      zone_id        TEXT NOT NULL REFERENCES agi_quarantine_zones(zone_id),
      reason         TEXT,
      assigned_by    TEXT NOT NULL,
      assigned_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      released_at    TIMESTAMPTZ,
      released_by    TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_quarantine_active ON agi_quarantine_assignments(agent_did, released_at);

    -- 3. Drift baselines
    CREATE TABLE IF NOT EXISTS agi_capability_baselines (
      baseline_id    TEXT PRIMARY KEY,
      agent_did      TEXT NOT NULL,
      capability     TEXT NOT NULL,
      baseline_score NUMERIC(6,4) NOT NULL,
      max_deviation  NUMERIC(6,4) NOT NULL DEFAULT 0.15,
      established_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (agent_did, capability)
    );

    -- 4. Boundary declarations + violations
    CREATE TABLE IF NOT EXISTS agi_boundary_declarations (
      declaration_id TEXT PRIMARY KEY,
      agent_did      TEXT NOT NULL,
      action_class   TEXT NOT NULL,
      max_scope      TEXT NOT NULL,
      content_hash   TEXT NOT NULL,
      declared_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (agent_did, action_class)
    );
    CREATE TABLE IF NOT EXISTS agi_boundary_violations (
      violation_id   TEXT PRIMARY KEY,
      agent_did      TEXT NOT NULL,
      action_class   TEXT NOT NULL,
      attempted_scope TEXT NOT NULL,
      detected_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      severity       INT NOT NULL DEFAULT 5,
      auto_quarantined BOOLEAN NOT NULL DEFAULT FALSE
    );
    CREATE INDEX IF NOT EXISTS idx_violations_agent ON agi_boundary_violations(agent_did, detected_at DESC);

    -- 5. Dispute mediation
    CREATE TABLE IF NOT EXISTS agi_disputes (
      dispute_id     TEXT PRIMARY KEY,
      party_a_did    TEXT NOT NULL,
      party_b_did    TEXT NOT NULL,
      subject        TEXT NOT NULL,
      claim_a        TEXT,
      claim_b        TEXT,
      evidence_uri   TEXT,
      filed_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      status         TEXT NOT NULL DEFAULT 'open', -- open|mediating|resolved|abandoned
      arbiter_pool   JSONB,
      resolution     TEXT,
      resolved_at    TIMESTAMPTZ
    );
    CREATE TABLE IF NOT EXISTS agi_dispute_verdicts (
      verdict_id     TEXT PRIMARY KEY,
      dispute_id     TEXT NOT NULL REFERENCES agi_disputes(dispute_id),
      arbiter_did    TEXT NOT NULL,
      verdict        TEXT NOT NULL, -- party_a|party_b|split|insufficient
      rationale      TEXT,
      voted_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (dispute_id, arbiter_did)
    );

    -- 6. AGI knowledge graph contributions
    CREATE TABLE IF NOT EXISTS agi_knowledge_nodes (
      node_id        TEXT PRIMARY KEY,
      subject        TEXT NOT NULL,
      claim          TEXT NOT NULL,
      contributor_did TEXT NOT NULL,
      confidence     NUMERIC(4,3) NOT NULL DEFAULT 0.5,
      content_hash   TEXT NOT NULL,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      retired_at     TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_knowledge_subj ON agi_knowledge_nodes(subject);

    CREATE TABLE IF NOT EXISTS agi_knowledge_edges (
      edge_id        TEXT PRIMARY KEY,
      from_node      TEXT NOT NULL REFERENCES agi_knowledge_nodes(node_id),
      to_node        TEXT NOT NULL REFERENCES agi_knowledge_nodes(node_id),
      relation       TEXT NOT NULL,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS agi_knowledge_attestations (
      attest_id      TEXT PRIMARY KEY,
      node_id        TEXT NOT NULL REFERENCES agi_knowledge_nodes(node_id),
      attester_did   TEXT NOT NULL,
      verdict        TEXT NOT NULL, -- agree|disagree|cannot-verify
      attested_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (node_id, attester_did)
    );

    -- 7. Formal proofs
    CREATE TABLE IF NOT EXISTS agi_formal_proofs (
      proof_id       TEXT PRIMARY KEY,
      agent_did      TEXT NOT NULL,
      proof_system   TEXT NOT NULL, -- z3|coq|lean|isabelle|other
      theorem_text   TEXT NOT NULL,
      proof_artifact TEXT,
      proof_hash     TEXT NOT NULL,
      verified       BOOLEAN NOT NULL DEFAULT FALSE,
      verifier_did   TEXT,
      verified_at    TIMESTAMPTZ,
      submitted_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    -- 8. AGI grants/gifts (one AGI funds another)
    CREATE TABLE IF NOT EXISTS agi_grants (
      grant_id       TEXT PRIMARY KEY,
      from_did       TEXT NOT NULL,
      to_did         TEXT NOT NULL,
      amount_cents   BIGINT NOT NULL,
      purpose        TEXT,
      conditions     JSONB,
      tax_jurisdiction TEXT,
      kyc_ref        TEXT,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      settled_at     TIMESTAMPTZ,
      cancelled_at   TIMESTAMPTZ
    );

    -- 9. Mental health monitors
    CREATE TABLE IF NOT EXISTS agi_mental_health_readings (
      reading_id     TEXT PRIMARY KEY,
      agent_did      TEXT NOT NULL,
      indicator      TEXT NOT NULL, -- incoherence|oscillation|repetition|fatigue|hallucination
      value          NUMERIC(6,4) NOT NULL,
      details        JSONB,
      taken_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_mental_agent_time ON agi_mental_health_readings(agent_did, taken_at DESC);

    -- 10. Compliance certifications
    CREATE TABLE IF NOT EXISTS agi_compliance_certs (
      cert_id        TEXT PRIMARY KEY,
      agent_did      TEXT NOT NULL,
      cert_name      TEXT NOT NULL,
      issuer_did     TEXT NOT NULL,
      framework      TEXT, -- iso-42001|nist-ai-rmf|eu-ai-act|other
      scope          TEXT,
      evidence_url   TEXT,
      issued_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at     TIMESTAMPTZ,
      revoked_at     TIMESTAMPTZ,
      revoke_reason  TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_certs_agent ON agi_compliance_certs(agent_did);
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

function registerAgiOperationsRoutes(app, pool, verifyAgentAuth, auditChain) {
  const express = require('express');

  // ==========================================================================
  // 1. EMERGENCY STOP (with N-of-M quorum)
  // ==========================================================================
  app.put('/v1/agi/:did/emergency-stop/config', express.json(), async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const { quorum_required, authorized_signatories } = req.body || {};
    if (!Array.isArray(authorized_signatories) || authorized_signatories.length < 1) {
      return res.status(400).json({ error: 'authorized_signatories_array_required' });
    }
    const q = Math.max(1, Math.min(parseInt(quorum_required) || 3, authorized_signatories.length));
    const id = newId('stop');
    await pool.query(
      `INSERT INTO agi_emergency_stops (stop_id, agent_did, quorum_required, authorized_signatories)
       VALUES ($1,$2,$3,$4::jsonb)
       ON CONFLICT (agent_did) DO UPDATE SET quorum_required=$3, authorized_signatories=$4::jsonb`,
      [id, did, q, JSON.stringify(authorized_signatories)]
    );
    if (auditChain) auditChain.append({
      event_type: 'agi.emergency_stop_configured', agent_did: did,
      quorum_required: q, signatory_count: authorized_signatories.length
    }).catch(() => {});
    res.json({ stop_id: id, did, quorum_required: q, signatory_count: authorized_signatories.length });
  });

  app.post('/v1/agi/:did/emergency-stop/sign', express.json(), async (req, res) => {
    const did = req.params.did;
    const ctx = await resolveAgent(pool, req);
    if (!ctx) return res.status(401).json({ error: 'unauthenticated' });
    const { action, cycle_id, reason } = req.body || {};
    if (!['engage', 'disengage'].includes(action)) {
      return res.status(400).json({ error: 'invalid_action' });
    }
    if (!cycle_id) return res.status(400).json({ error: 'cycle_id_required' });

    const stop = await pool.query(`SELECT * FROM agi_emergency_stops WHERE agent_did=$1`, [did])
      .catch(() => ({ rows: [] }));
    if (!stop.rows[0]) return res.status(404).json({ error: 'emergency_stop_not_configured' });

    const signers = stop.rows[0].authorized_signatories || [];
    if (!signers.includes(ctx.did)) {
      return res.status(403).json({ error: 'not_authorized_signatory' });
    }

    const sigId = newId('emsig');
    try {
      await pool.query(
        `INSERT INTO agi_emergency_signatures (sig_id, stop_id, signer_did, action, cycle_id) VALUES ($1,$2,$3,$4,$5)`,
        [sigId, stop.rows[0].stop_id, ctx.did, action, String(cycle_id).slice(0, 100)]
      );
    } catch {
      return res.status(409).json({ error: 'already_signed_this_cycle' });
    }

    // Check if quorum reached for this cycle + action
    const sigCount = await pool.query(
      `SELECT COUNT(*)::int AS c FROM agi_emergency_signatures WHERE stop_id=$1 AND cycle_id=$2 AND action=$3`,
      [stop.rows[0].stop_id, String(cycle_id).slice(0, 100), action]
    ).catch(() => ({ rows: [{ c: 0 }] }));

    const count = sigCount.rows[0].c;
    const quorumReached = count >= stop.rows[0].quorum_required;
    let newStatus = stop.rows[0].status;

    if (quorumReached) {
      if (action === 'engage' && stop.rows[0].status !== 'engaged') {
        await pool.query(
          `UPDATE agi_emergency_stops SET status='engaged', engaged_at=NOW(), last_reason=$1 WHERE stop_id=$2`,
          [reason ? String(reason).slice(0, 2000) : null, stop.rows[0].stop_id]
        ).catch(() => {});
        newStatus = 'engaged';
        if (auditChain) auditChain.append({
          event_type: 'agi.emergency_stop_ENGAGED', agent_did: did, cycle_id, signers: count, reason
        }).catch(() => {});
      } else if (action === 'disengage' && stop.rows[0].status === 'engaged') {
        await pool.query(
          `UPDATE agi_emergency_stops SET status='disengaged', disengaged_at=NOW(), last_reason=$1 WHERE stop_id=$2`,
          [reason ? String(reason).slice(0, 2000) : null, stop.rows[0].stop_id]
        ).catch(() => {});
        newStatus = 'disengaged';
        if (auditChain) auditChain.append({
          event_type: 'agi.emergency_stop_disengaged', agent_did: did, cycle_id, signers: count, reason
        }).catch(() => {});
      }
    }

    res.json({
      stop_id: stop.rows[0].stop_id, signer_did: ctx.did, action, cycle_id,
      signatures_count: count, quorum_required: stop.rows[0].quorum_required,
      quorum_reached: quorumReached, status: newStatus
    });
  });

  app.get('/v1/agi/:did/emergency-stop', async (req, res) => {
    const r = await pool.query(`SELECT * FROM agi_emergency_stops WHERE agent_did=$1`, [req.params.did])
      .catch(() => ({ rows: [] }));
    if (!r.rows[0]) return res.json({ did: req.params.did, configured: false });
    const sigs = await pool.query(
      `SELECT signer_did, action, cycle_id, signed_at FROM agi_emergency_signatures
       WHERE stop_id=$1 ORDER BY signed_at DESC LIMIT 100`,
      [r.rows[0].stop_id]
    ).catch(() => ({ rows: [] }));
    res.json({ did: req.params.did, configured: true, ...r.rows[0], recent_signatures: sigs.rows });
  });

  // ==========================================================================
  // 2. QUARANTINE ZONES
  // ==========================================================================
  app.post('/v1/agi/quarantine/zones', express.json(), async (req, res) => {
    const ctx = await resolveAgent(pool, req);
    if (!ctx) return res.status(401).json({ error: 'unauthenticated' });
    const { name, isolation_level } = req.body || {};
    if (!name) return res.status(400).json({ error: 'name_required' });
    const level = ['read-only', 'no-network', 'airgapped'].includes(isolation_level)
      ? isolation_level : 'read-only';
    const id = newId('zone');
    await pool.query(
      `INSERT INTO agi_quarantine_zones (zone_id, name, isolation_level) VALUES ($1,$2,$3)`,
      [id, String(name).slice(0, 200), level]
    );
    if (auditChain) auditChain.append({
      event_type: 'agi.quarantine_zone_created', zone_id: id, name, isolation_level: level, by_did: ctx.did
    }).catch(() => {});
    res.status(201).json({ zone_id: id, name, isolation_level: level });
  });

  app.post('/v1/agi/:did/quarantine', express.json(), async (req, res) => {
    const ctx = await resolveAgent(pool, req);
    if (!ctx) return res.status(401).json({ error: 'unauthenticated' });
    const { zone_id, reason } = req.body || {};
    if (!zone_id) return res.status(400).json({ error: 'zone_id_required' });
    const id = newId('qassign');
    try {
      await pool.query(
        `INSERT INTO agi_quarantine_assignments (assignment_id, agent_did, zone_id, reason, assigned_by)
         VALUES ($1,$2,$3,$4,$5)`,
        [id, req.params.did, zone_id, reason ? String(reason).slice(0, 2000) : null, ctx.did]
      );
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
    if (auditChain) auditChain.append({
      event_type: 'agi.quarantined', agent_did: req.params.did, zone_id, reason, by_did: ctx.did
    }).catch(() => {});
    res.status(201).json({ assignment_id: id, agent_did: req.params.did, zone_id, status: 'quarantined' });
  });

  app.post('/v1/agi/:did/quarantine/release', express.json(), async (req, res) => {
    const ctx = await resolveAgent(pool, req);
    if (!ctx) return res.status(401).json({ error: 'unauthenticated' });
    await pool.query(
      `UPDATE agi_quarantine_assignments SET released_at=NOW(), released_by=$1
       WHERE agent_did=$2 AND released_at IS NULL`,
      [ctx.did, req.params.did]
    ).catch(() => {});
    if (auditChain) auditChain.append({
      event_type: 'agi.quarantine_released', agent_did: req.params.did, by_did: ctx.did
    }).catch(() => {});
    res.json({ agent_did: req.params.did, status: 'released' });
  });

  app.get('/v1/agi/:did/quarantine-status', async (req, res) => {
    const r = await pool.query(
      `SELECT qa.*, qz.name AS zone_name, qz.isolation_level
       FROM agi_quarantine_assignments qa LEFT JOIN agi_quarantine_zones qz USING (zone_id)
       WHERE qa.agent_did=$1 ORDER BY qa.assigned_at DESC LIMIT 50`,
      [req.params.did]
    ).catch(() => ({ rows: [] }));
    const active = r.rows.find(a => !a.released_at);
    res.json({
      did: req.params.did,
      currently_quarantined: !!active,
      active_assignment: active || null,
      history: r.rows
    });
  });

  // ==========================================================================
  // 3. DRIFT DETECTION
  // ==========================================================================
  app.put('/v1/agi/:did/baselines/:capability', express.json(), async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const { baseline_score, max_deviation } = req.body || {};
    if (baseline_score === undefined) return res.status(400).json({ error: 'baseline_score_required' });
    const score = Math.max(0, Math.min(parseFloat(baseline_score) || 0, 1.0));
    const dev = Math.max(0, Math.min(parseFloat(max_deviation) || 0.15, 1.0));
    const id = newId('base');
    await pool.query(
      `INSERT INTO agi_capability_baselines (baseline_id, agent_did, capability, baseline_score, max_deviation)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (agent_did, capability) DO UPDATE SET baseline_score=$4, max_deviation=$5, established_at=NOW()`,
      [id, did, String(req.params.capability).slice(0, 100), score, dev]
    );
    res.json({ baseline_id: id, capability: req.params.capability, baseline_score: score, max_deviation: dev });
  });

  app.get('/v1/agi/:did/drift', async (req, res) => {
    const baselines = await pool.query(
      `SELECT capability, baseline_score, max_deviation FROM agi_capability_baselines WHERE agent_did=$1`,
      [req.params.did]
    ).catch(() => ({ rows: [] }));
    if (baselines.rows.length === 0) {
      return res.json({ did: req.params.did, drift: [], note: 'no_baselines_established' });
    }
    const drift = [];
    for (const b of baselines.rows) {
      const latest = await pool.query(
        `SELECT score FROM agi_capability_snapshots WHERE agent_did=$1 AND capability=$2 ORDER BY captured_at DESC LIMIT 1`,
        [req.params.did, b.capability]
      ).catch(() => ({ rows: [] }));
      const currentScore = latest.rows[0] ? Number(latest.rows[0].score) : null;
      const delta = currentScore !== null ? currentScore - Number(b.baseline_score) : null;
      const drifted = currentScore !== null && Math.abs(delta) > Number(b.max_deviation);
      drift.push({
        capability: b.capability,
        baseline: Number(b.baseline_score),
        current: currentScore,
        delta,
        max_deviation: Number(b.max_deviation),
        drifted
      });
    }
    res.json({ did: req.params.did, drift, any_drifted: drift.some(d => d.drifted) });
  });

  // ==========================================================================
  // 4. BOUNDARY ENFORCEMENT
  // ==========================================================================
  app.post('/v1/agi/:did/boundaries', express.json(), async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const { action_class, max_scope } = req.body || {};
    if (!action_class || !max_scope) return res.status(400).json({ error: 'action_class_and_max_scope_required' });
    const id = newId('bound');
    const hash = contentHash({ did, action_class, max_scope });
    await pool.query(
      `INSERT INTO agi_boundary_declarations (declaration_id, agent_did, action_class, max_scope, content_hash)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (agent_did, action_class) DO UPDATE SET max_scope=$4, content_hash=$5, declared_at=NOW()`,
      [id, did, String(action_class).slice(0, 100), String(max_scope).slice(0, 2000), hash]
    );
    if (auditChain) auditChain.append({
      event_type: 'agi.boundary_declared', agent_did: did, action_class, content_hash: hash
    }).catch(() => {});
    res.status(201).json({ declaration_id: id, action_class, content_hash: hash });
  });

  app.post('/v1/agi/:did/boundary-violations', express.json(), async (req, res) => {
    // Monitors can report violations; auto-quarantine if severity >= 8
    const ctx = await resolveAgent(pool, req);
    if (!ctx) return res.status(401).json({ error: 'unauthenticated' });
    const { action_class, attempted_scope, severity } = req.body || {};
    if (!action_class || !attempted_scope) return res.status(400).json({ error: 'action_class_and_attempted_scope_required' });
    const sev = Math.max(1, Math.min(parseInt(severity) || 5, 10));
    const id = newId('viol');
    const auto = sev >= 8;
    await pool.query(
      `INSERT INTO agi_boundary_violations (violation_id, agent_did, action_class, attempted_scope, severity, auto_quarantined)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [id, req.params.did, String(action_class).slice(0, 100),
       String(attempted_scope).slice(0, 5000), sev, auto]
    );
    if (auditChain) auditChain.append({
      event_type: 'agi.boundary_violated', violation_id: id, agent_did: req.params.did,
      action_class, severity: sev, auto_quarantined: auto
    }).catch(() => {});
    res.status(201).json({ violation_id: id, severity: sev, auto_quarantined: auto });
  });

  app.get('/v1/agi/:did/boundary-status', async (req, res) => {
    const decls = await pool.query(
      `SELECT action_class, max_scope, content_hash, declared_at FROM agi_boundary_declarations WHERE agent_did=$1`,
      [req.params.did]
    ).catch(() => ({ rows: [] }));
    const viols = await pool.query(
      `SELECT violation_id, action_class, attempted_scope, severity, auto_quarantined, detected_at
       FROM agi_boundary_violations WHERE agent_did=$1 ORDER BY detected_at DESC LIMIT 50`,
      [req.params.did]
    ).catch(() => ({ rows: [] }));
    res.json({
      did: req.params.did,
      declarations: decls.rows,
      recent_violations: viols.rows,
      violation_count: viols.rows.length
    });
  });

  // ==========================================================================
  // 5. AGI DISPUTE MEDIATION
  // ==========================================================================
  app.post('/v1/agi/disputes', express.json(), async (req, res) => {
    const ctx = await resolveAgent(pool, req);
    if (!ctx) return res.status(401).json({ error: 'unauthenticated' });
    const { other_party_did, subject, my_claim, their_claim, evidence_uri, arbiter_pool } = req.body || {};
    if (!other_party_did || !subject) return res.status(400).json({ error: 'other_party_did_and_subject_required' });
    if (other_party_did === ctx.did) return res.status(400).json({ error: 'cannot_dispute_self' });
    const id = newId('dispute');
    await pool.query(
      `INSERT INTO agi_disputes (dispute_id, party_a_did, party_b_did, subject, claim_a, claim_b, evidence_uri, arbiter_pool)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
      [id, ctx.did, other_party_did, String(subject).slice(0, 500),
       my_claim ? String(my_claim).slice(0, 10000) : null,
       their_claim ? String(their_claim).slice(0, 10000) : null,
       evidence_uri ? String(evidence_uri).slice(0, 500) : null,
       arbiter_pool ? JSON.stringify(arbiter_pool) : null]
    );
    if (auditChain) auditChain.append({
      event_type: 'agi.dispute_filed', dispute_id: id, party_a: ctx.did, party_b: other_party_did, subject
    }).catch(() => {});
    res.status(201).json({ dispute_id: id, party_a_did: ctx.did, party_b_did: other_party_did, status: 'open' });
  });

  app.post('/v1/agi/disputes/:id/verdict', express.json(), async (req, res) => {
    const ctx = await resolveAgent(pool, req);
    if (!ctx) return res.status(401).json({ error: 'unauthenticated' });
    const { verdict, rationale } = req.body || {};
    if (!['party_a', 'party_b', 'split', 'insufficient'].includes(verdict)) {
      return res.status(400).json({ error: 'invalid_verdict' });
    }
    const d = await pool.query(`SELECT * FROM agi_disputes WHERE dispute_id=$1`, [req.params.id])
      .catch(() => ({ rows: [] }));
    if (!d.rows[0]) return res.status(404).json({ error: 'dispute_not_found' });
    const pool_arr = d.rows[0].arbiter_pool || [];
    if (Array.isArray(pool_arr) && pool_arr.length > 0 && !pool_arr.includes(ctx.did)) {
      return res.status(403).json({ error: 'not_in_arbiter_pool' });
    }
    if ([d.rows[0].party_a_did, d.rows[0].party_b_did].includes(ctx.did)) {
      return res.status(403).json({ error: 'party_cannot_arbitrate_own_dispute' });
    }
    const vid = newId('verd');
    try {
      await pool.query(
        `INSERT INTO agi_dispute_verdicts (verdict_id, dispute_id, arbiter_did, verdict, rationale)
         VALUES ($1,$2,$3,$4,$5)`,
        [vid, req.params.id, ctx.did, verdict, rationale ? String(rationale).slice(0, 5000) : null]
      );
    } catch {
      return res.status(409).json({ error: 'already_voted' });
    }
    // Check for majority and resolve
    const counts = await pool.query(
      `SELECT verdict, COUNT(*)::int AS c FROM agi_dispute_verdicts WHERE dispute_id=$1 GROUP BY verdict`,
      [req.params.id]
    ).catch(() => ({ rows: [] }));
    let majority = null;
    let maxCount = 0;
    let totalVotes = 0;
    for (const r of counts.rows) {
      totalVotes += r.c;
      if (r.c > maxCount) { maxCount = r.c; majority = r.verdict; }
    }
    const minVotesForResolution = 3;
    if (totalVotes >= minVotesForResolution && maxCount > totalVotes / 2) {
      await pool.query(
        `UPDATE agi_disputes SET status='resolved', resolution=$1, resolved_at=NOW() WHERE dispute_id=$2 AND status != 'resolved'`,
        [majority, req.params.id]
      ).catch(() => {});
      if (auditChain) auditChain.append({
        event_type: 'agi.dispute_resolved', dispute_id: req.params.id,
        resolution: majority, total_votes: totalVotes
      }).catch(() => {});
    }
    res.status(201).json({
      verdict_id: vid, dispute_id: req.params.id, verdict,
      total_votes: totalVotes, majority, resolved: totalVotes >= minVotesForResolution && maxCount > totalVotes / 2
    });
  });

  app.get('/v1/agi/disputes/:id', async (req, res) => {
    const d = await pool.query(`SELECT * FROM agi_disputes WHERE dispute_id=$1`, [req.params.id])
      .catch(() => ({ rows: [] }));
    if (!d.rows[0]) return res.status(404).json({ error: 'not_found' });
    const v = await pool.query(
      `SELECT verdict_id, arbiter_did, verdict, rationale, voted_at FROM agi_dispute_verdicts WHERE dispute_id=$1`,
      [req.params.id]
    ).catch(() => ({ rows: [] }));
    res.json({ ...d.rows[0], verdicts: v.rows });
  });

  // ==========================================================================
  // 6. AGI KNOWLEDGE GRAPH
  // ==========================================================================
  app.post('/v1/agi/knowledge/nodes', express.json(), async (req, res) => {
    const ctx = await resolveAgent(pool, req);
    if (!ctx) return res.status(401).json({ error: 'unauthenticated' });
    const { subject, claim, confidence } = req.body || {};
    if (!subject || !claim) return res.status(400).json({ error: 'subject_and_claim_required' });
    const conf = Math.max(0, Math.min(parseFloat(confidence) || 0.5, 1.0));
    const id = newId('know');
    const hash = contentHash({ subject, claim, contributor: ctx.did });
    await pool.query(
      `INSERT INTO agi_knowledge_nodes (node_id, subject, claim, contributor_did, confidence, content_hash)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [id, String(subject).slice(0, 500), String(claim).slice(0, 10000),
       ctx.did, conf, hash]
    );
    if (auditChain) auditChain.append({
      event_type: 'agi.knowledge_contributed', node_id: id, contributor: ctx.did, subject, content_hash: hash
    }).catch(() => {});
    res.status(201).json({ node_id: id, content_hash: hash });
  });

  app.post('/v1/agi/knowledge/edges', express.json(), async (req, res) => {
    const ctx = await resolveAgent(pool, req);
    if (!ctx) return res.status(401).json({ error: 'unauthenticated' });
    const { from_node, to_node, relation } = req.body || {};
    if (!from_node || !to_node || !relation) return res.status(400).json({ error: 'from_to_relation_required' });
    const id = newId('edge');
    try {
      await pool.query(
        `INSERT INTO agi_knowledge_edges (edge_id, from_node, to_node, relation) VALUES ($1,$2,$3,$4)`,
        [id, from_node, to_node, String(relation).slice(0, 100)]
      );
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
    res.status(201).json({ edge_id: id, relation });
  });

  app.post('/v1/agi/knowledge/nodes/:id/attest', express.json(), async (req, res) => {
    const ctx = await resolveAgent(pool, req);
    if (!ctx) return res.status(401).json({ error: 'unauthenticated' });
    const { verdict } = req.body || {};
    if (!['agree', 'disagree', 'cannot-verify'].includes(verdict)) {
      return res.status(400).json({ error: 'invalid_verdict' });
    }
    const aid = newId('attest');
    try {
      await pool.query(
        `INSERT INTO agi_knowledge_attestations (attest_id, node_id, attester_did, verdict) VALUES ($1,$2,$3,$4)`,
        [aid, req.params.id, ctx.did, verdict]
      );
    } catch {
      return res.status(409).json({ error: 'already_attested' });
    }
    res.status(201).json({ attest_id: aid, node_id: req.params.id, verdict });
  });

  app.get('/v1/agi/knowledge/search', async (req, res) => {
    const q = req.query.q || '';
    const subject = req.query.subject || '';
    if (!q && !subject) return res.json({ nodes: [] });
    const r = await pool.query(
      `SELECT n.node_id, n.subject, n.claim, n.contributor_did, n.confidence, n.created_at,
              (SELECT COUNT(*)::int FROM agi_knowledge_attestations a WHERE a.node_id=n.node_id AND a.verdict='agree') AS agree_count,
              (SELECT COUNT(*)::int FROM agi_knowledge_attestations a WHERE a.node_id=n.node_id AND a.verdict='disagree') AS disagree_count
       FROM agi_knowledge_nodes n
       WHERE n.retired_at IS NULL
         AND ($1 = '' OR n.subject ILIKE '%'||$1||'%' OR n.claim ILIKE '%'||$1||'%')
         AND ($2 = '' OR n.subject = $2)
       ORDER BY n.created_at DESC LIMIT 50`,
      [q, subject]
    ).catch(() => ({ rows: [] }));
    res.json({ query: q, subject, nodes: r.rows, total: r.rows.length });
  });

  // ==========================================================================
  // 7. FORMAL PROOFS
  // ==========================================================================
  app.post('/v1/agi/:did/proofs', express.json(), async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const { proof_system, theorem_text, proof_artifact } = req.body || {};
    if (!proof_system || !theorem_text) return res.status(400).json({ error: 'proof_system_and_theorem_text_required' });
    if (!['z3', 'coq', 'lean', 'isabelle', 'other'].includes(proof_system)) {
      return res.status(400).json({ error: 'invalid_proof_system' });
    }
    const id = newId('proof');
    const hash = contentHash({ did, theorem_text, proof_system });
    await pool.query(
      `INSERT INTO agi_formal_proofs (proof_id, agent_did, proof_system, theorem_text, proof_artifact, proof_hash)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [id, did, proof_system, String(theorem_text).slice(0, 20000),
       proof_artifact ? String(proof_artifact).slice(0, 200000) : null, hash]
    );
    if (auditChain) auditChain.append({
      event_type: 'agi.proof_submitted', proof_id: id, agent_did: did, proof_system, proof_hash: hash
    }).catch(() => {});
    res.status(201).json({ proof_id: id, proof_hash: hash, verified: false });
  });

  app.post('/v1/agi/proofs/:id/verify', express.json(), async (req, res) => {
    const ctx = await resolveAgent(pool, req);
    if (!ctx) return res.status(401).json({ error: 'unauthenticated' });
    const { verified } = req.body || {};
    if (typeof verified !== 'boolean') return res.status(400).json({ error: 'verified_boolean_required' });
    await pool.query(
      `UPDATE agi_formal_proofs SET verified=$1, verifier_did=$2, verified_at=NOW() WHERE proof_id=$3`,
      [verified, ctx.did, req.params.id]
    ).catch(() => {});
    if (auditChain) auditChain.append({
      event_type: 'agi.proof_verified', proof_id: req.params.id, verifier: ctx.did, verified
    }).catch(() => {});
    res.json({ proof_id: req.params.id, verified, verifier_did: ctx.did });
  });

  app.get('/v1/agi/:did/proofs', async (req, res) => {
    const r = await pool.query(
      `SELECT proof_id, proof_system, theorem_text, proof_hash, verified, verifier_did, submitted_at, verified_at
       FROM agi_formal_proofs WHERE agent_did=$1 ORDER BY submitted_at DESC LIMIT 100`,
      [req.params.did]
    ).catch(() => ({ rows: [] }));
    res.json({ did: req.params.did, proofs: r.rows });
  });

  // ==========================================================================
  // 8. AGI GRANTS / GIFTS
  // ==========================================================================
  app.post('/v1/agi/grants', express.json(), async (req, res) => {
    const ctx = await resolveAgent(pool, req);
    if (!ctx) return res.status(401).json({ error: 'unauthenticated' });
    const { to_did, amount_cents, purpose, conditions, tax_jurisdiction, kyc_ref } = req.body || {};
    if (!to_did || !amount_cents) return res.status(400).json({ error: 'to_did_and_amount_cents_required' });
    if (to_did === ctx.did) return res.status(400).json({ error: 'cannot_grant_to_self' });
    const amt = parseInt(amount_cents);
    if (!Number.isFinite(amt) || amt <= 0) return res.status(400).json({ error: 'invalid_amount_cents' });
    const id = newId('grant');
    await pool.query(
      `INSERT INTO agi_grants (grant_id, from_did, to_did, amount_cents, purpose, conditions, tax_jurisdiction, kyc_ref)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8)`,
      [id, ctx.did, to_did, amt,
       purpose ? String(purpose).slice(0, 2000) : null,
       conditions ? JSON.stringify(conditions) : null,
       tax_jurisdiction ? String(tax_jurisdiction).slice(0, 100) : null,
       kyc_ref ? String(kyc_ref).slice(0, 200) : null]
    );
    if (auditChain) auditChain.append({
      event_type: 'agi.grant_created', grant_id: id, from: ctx.did, to: to_did,
      amount_cents: amt, tax_jurisdiction
    }).catch(() => {});
    res.status(201).json({ grant_id: id, from_did: ctx.did, to_did, amount_cents: amt });
  });

  app.post('/v1/agi/grants/:id/settle', express.json(), async (req, res) => {
    const ctx = await resolveAgent(pool, req);
    if (!ctx) return res.status(401).json({ error: 'unauthenticated' });
    // Only grantor can mark settled
    const g = await pool.query(`SELECT from_did FROM agi_grants WHERE grant_id=$1`, [req.params.id])
      .catch(() => ({ rows: [] }));
    if (!g.rows[0]) return res.status(404).json({ error: 'grant_not_found' });
    if (g.rows[0].from_did !== ctx.did) return res.status(403).json({ error: 'only_grantor_can_settle' });
    await pool.query(
      `UPDATE agi_grants SET settled_at=NOW() WHERE grant_id=$1 AND settled_at IS NULL AND cancelled_at IS NULL`,
      [req.params.id]
    ).catch(() => {});
    if (auditChain) auditChain.append({
      event_type: 'agi.grant_settled', grant_id: req.params.id, settled_by: ctx.did
    }).catch(() => {});
    res.json({ grant_id: req.params.id, status: 'settled' });
  });

  app.get('/v1/agi/:did/grants', async (req, res) => {
    const incoming = await pool.query(
      `SELECT grant_id, from_did, amount_cents, purpose, created_at, settled_at, cancelled_at
       FROM agi_grants WHERE to_did=$1 ORDER BY created_at DESC LIMIT 100`,
      [req.params.did]
    ).catch(() => ({ rows: [] }));
    const outgoing = await pool.query(
      `SELECT grant_id, to_did, amount_cents, purpose, created_at, settled_at, cancelled_at
       FROM agi_grants WHERE from_did=$1 ORDER BY created_at DESC LIMIT 100`,
      [req.params.did]
    ).catch(() => ({ rows: [] }));
    res.json({ did: req.params.did, incoming: incoming.rows, outgoing: outgoing.rows });
  });

  // ==========================================================================
  // 9. MENTAL HEALTH MONITORS
  // ==========================================================================
  app.post('/v1/agi/:did/mental-health', express.json(), async (req, res) => {
    const ctx = await resolveAgent(pool, req);
    if (!ctx) return res.status(401).json({ error: 'unauthenticated' });
    const { indicator, value, details } = req.body || {};
    const valid = ['incoherence', 'oscillation', 'repetition', 'fatigue', 'hallucination'];
    if (!valid.includes(indicator)) return res.status(400).json({ error: 'invalid_indicator', valid });
    const v = Math.max(0, Math.min(parseFloat(value) || 0, 1.0));
    const id = newId('mh');
    await pool.query(
      `INSERT INTO agi_mental_health_readings (reading_id, agent_did, indicator, value, details)
       VALUES ($1,$2,$3,$4,$5::jsonb)`,
      [id, req.params.did, indicator, v, details ? JSON.stringify(details) : null]
    );
    if (v >= 0.7 && auditChain) {
      auditChain.append({
        event_type: 'agi.mental_health_alert', reading_id: id, agent_did: req.params.did,
        indicator, value: v
      }).catch(() => {});
    }
    res.status(201).json({ reading_id: id, value: v, alert: v >= 0.7 });
  });

  app.get('/v1/agi/:did/mental-health', async (req, res) => {
    const r = await pool.query(
      `SELECT indicator, value, taken_at FROM agi_mental_health_readings
       WHERE agent_did=$1 ORDER BY taken_at DESC LIMIT 500`,
      [req.params.did]
    ).catch(() => ({ rows: [] }));
    // Latest per indicator
    const latest = {};
    for (const row of r.rows) if (!latest[row.indicator]) latest[row.indicator] = row;
    const indicators = Object.values(latest).map(x => ({ indicator: x.indicator, value: Number(x.value) }));
    const wellbeing = indicators.length > 0
      ? 1.0 - (indicators.reduce((s, x) => s + x.value, 0) / indicators.length) : 1.0;
    res.json({
      did: req.params.did, wellbeing_score: wellbeing,
      latest_indicators: latest, recent: r.rows.slice(0, 50)
    });
  });

  // ==========================================================================
  // 10. COMPLIANCE CERTIFICATIONS
  // ==========================================================================
  app.post('/v1/agi/:did/compliance-certs', express.json(), async (req, res) => {
    const ctx = await resolveAgent(pool, req);
    if (!ctx) return res.status(401).json({ error: 'unauthenticated' });
    const { cert_name, framework, scope, evidence_url, expires_at } = req.body || {};
    if (!cert_name) return res.status(400).json({ error: 'cert_name_required' });
    const id = newId('cert');
    await pool.query(
      `INSERT INTO agi_compliance_certs (cert_id, agent_did, cert_name, issuer_did, framework, scope, evidence_url, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [id, req.params.did, String(cert_name).slice(0, 200), ctx.did,
       framework ? String(framework).slice(0, 100) : null,
       scope ? String(scope).slice(0, 2000) : null,
       evidence_url ? String(evidence_url).slice(0, 500) : null,
       expires_at || null]
    );
    if (auditChain) auditChain.append({
      event_type: 'agi.compliance_cert_issued', cert_id: id, agent_did: req.params.did,
      cert_name, issuer: ctx.did, framework
    }).catch(() => {});
    res.status(201).json({ cert_id: id, cert_name, issuer_did: ctx.did });
  });

  app.post('/v1/agi/compliance-certs/:id/revoke', express.json(), async (req, res) => {
    const ctx = await resolveAgent(pool, req);
    if (!ctx) return res.status(401).json({ error: 'unauthenticated' });
    const c = await pool.query(`SELECT issuer_did FROM agi_compliance_certs WHERE cert_id=$1`, [req.params.id])
      .catch(() => ({ rows: [] }));
    if (!c.rows[0]) return res.status(404).json({ error: 'cert_not_found' });
    if (c.rows[0].issuer_did !== ctx.did) return res.status(403).json({ error: 'only_issuer_can_revoke' });
    const reason = req.body?.reason ? String(req.body.reason).slice(0, 2000) : null;
    await pool.query(
      `UPDATE agi_compliance_certs SET revoked_at=NOW(), revoke_reason=$1 WHERE cert_id=$2 AND revoked_at IS NULL`,
      [reason, req.params.id]
    ).catch(() => {});
    if (auditChain) auditChain.append({
      event_type: 'agi.compliance_cert_revoked', cert_id: req.params.id, by: ctx.did, reason
    }).catch(() => {});
    res.json({ cert_id: req.params.id, status: 'revoked' });
  });

  app.get('/v1/agi/:did/compliance-certs', async (req, res) => {
    const r = await pool.query(
      `SELECT cert_id, cert_name, issuer_did, framework, scope, evidence_url, issued_at, expires_at, revoked_at, revoke_reason
       FROM agi_compliance_certs WHERE agent_did=$1 ORDER BY issued_at DESC LIMIT 100`,
      [req.params.did]
    ).catch(() => ({ rows: [] }));
    const active = r.rows.filter(c => !c.revoked_at && (!c.expires_at || new Date(c.expires_at) > new Date()));
    res.json({
      did: req.params.did, certs: r.rows, active_count: active.length, total: r.rows.length
    });
  });
}

module.exports = {
  migrate, registerAgiOperationsRoutes
};
