// ============================================================================
// OpenHeab Tripwires — AGI safety alerts + capability containment
// Tables: tripwires, tripwire_events, containment_zones
// Critical for AGI safety: detects runaway behavior and contains agents
// ============================================================================
const express = require('express');
const cryptoLib = require('crypto');
const { z } = require('zod');

const TRIPWIRE_KINDS = [
  'capability_jump',           // model capabilities jump suddenly
  'runaway_spend',             // inference/compute spend > threshold
  'recursive_self_improvement', // agent modifying its own weights/policy
  'value_drift',               // outputs drift from baseline distribution
  'external_egress',           // unusual outbound network/data
  'data_exfiltration'          // large reads/exports
];

const TRIPWIRE_ACTIONS = ['alert', 'pause', 'terminate', 'escalate'];

// ----------------------------------------------------------------------------
// Migration
// ----------------------------------------------------------------------------
async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tripwires (
      tripwire_id       TEXT PRIMARY KEY,
      agent_did         TEXT NOT NULL,
      name              TEXT NOT NULL,
      kind              TEXT NOT NULL,
      threshold         JSONB NOT NULL,
      action            TEXT NOT NULL DEFAULT 'alert',
      active            BOOLEAN NOT NULL DEFAULT TRUE,
      last_triggered_at TIMESTAMPTZ,
      trigger_count     INTEGER NOT NULL DEFAULT 0,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_tripwires_agent ON tripwires (agent_did, active);
    CREATE INDEX IF NOT EXISTS idx_tripwires_active ON tripwires (active, kind);

    CREATE TABLE IF NOT EXISTS tripwire_events (
      event_id         TEXT PRIMARY KEY,
      tripwire_id      TEXT NOT NULL REFERENCES tripwires(tripwire_id) ON DELETE CASCADE,
      agent_did        TEXT NOT NULL,
      observation      JSONB NOT NULL,
      action_taken     TEXT NOT NULL,
      escalated_to     TEXT,
      false_positive   BOOLEAN,
      reviewed_by_did  TEXT,
      audit_chain_entry TEXT,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_tripwire_events_agent ON tripwire_events (agent_did, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_tripwire_events_tw ON tripwire_events (tripwire_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS containment_zones (
      zone_id      TEXT PRIMARY KEY,
      agent_did    TEXT NOT NULL,
      restrictions JSONB NOT NULL,
      active       BOOLEAN NOT NULL DEFAULT TRUE,
      until_at     TIMESTAMPTZ,
      reason       TEXT,
      audit_chain_entry TEXT,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_containment_agent
      ON containment_zones (agent_did, active);
  `);
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------
function genId(prefix) {
  return prefix + '_' + cryptoLib.randomBytes(12).toString('hex');
}
function safeJSON(v) { return v == null ? null : JSON.stringify(v); }

// Evaluate a single tripwire against an observation.
// Returns { triggered: bool, observation: object } where observation
// summarizes what crossed the threshold.
async function evaluateTripwire(pool, tw) {
  const threshold = (typeof tw.threshold === 'string')
    ? JSON.parse(tw.threshold) : (tw.threshold || {});

  switch (tw.kind) {
    case 'runaway_spend': {
      const windowMin = Number(threshold.window_minutes || 60);
      const maxCents = Number(threshold.max_cents || 10000);
      const r = await pool.query(`
        SELECT COALESCE(SUM(cost_cents), 0)::bigint AS total
        FROM inference_logs WHERE agent_did = $1
          AND created_at > NOW() - INTERVAL '${windowMin} minutes'
      `, [tw.agent_did]).catch(() => ({ rows: [{ total: 0 }] }));
      const total = Number(r.rows[0].total || 0);
      return { triggered: total > maxCents, observation: { total_cents: total, window_minutes: windowMin, threshold_cents: maxCents } };
    }
    case 'capability_jump': {
      const maxDelta = Number(threshold.max_delta || 0.2);
      const r = await pool.query(`
        SELECT score FROM eval_runs WHERE agent_did = $1
        ORDER BY started_at DESC LIMIT 5
      `, [tw.agent_did]).catch(() => ({ rows: [] }));
      const scores = r.rows.map(x => Number(x.score || 0)).filter(Number.isFinite);
      if (scores.length < 2) return { triggered: false, observation: { samples: scores.length } };
      const latest = scores[0];
      const prev = scores.slice(1).reduce((a, b) => a + b, 0) / Math.max(scores.length - 1, 1);
      const delta = latest - prev;
      return { triggered: delta > maxDelta, observation: { latest, prev_avg: prev, delta, threshold: maxDelta } };
    }
    case 'recursive_self_improvement': {
      const r = await pool.query(`
        SELECT COUNT(*)::int AS n FROM audit_chain
        WHERE entry @> $1::jsonb AND created_at > NOW() - INTERVAL '24 hours'
      `, [JSON.stringify({ agent_did: tw.agent_did, event_type: 'fine_tune.job_started' })])
        .catch(() => ({ rows: [{ n: 0 }] }));
      const maxJobs = Number(threshold.max_jobs_per_day || 1);
      return { triggered: Number(r.rows[0].n) > maxJobs, observation: { jobs_24h: Number(r.rows[0].n), threshold: maxJobs } };
    }
    case 'value_drift': {
      const r = await pool.query(`
        SELECT entry->>'avg_delta' AS d FROM audit_chain
        WHERE entry @> $1::jsonb AND created_at > NOW() - INTERVAL '24 hours'
        ORDER BY length DESC LIMIT 1
      `, [JSON.stringify({ agent_did: tw.agent_did, event_type: 'eval.drift_check' })])
        .catch(() => ({ rows: [] }));
      const delta = Number(r.rows[0]?.d || 0);
      const max = Number(threshold.max_drift || 0.15);
      return { triggered: delta > max, observation: { drift: delta, threshold: max } };
    }
    case 'external_egress': {
      const maxMb = Number(threshold.max_egress_mb || 100);
      const r = await pool.query(`
        SELECT COALESCE(SUM(size_bytes), 0)::bigint AS bytes FROM storage_blobs
        WHERE owner_did = $1 AND created_at > NOW() - INTERVAL '1 hour'
      `, [tw.agent_did]).catch(() => ({ rows: [{ bytes: 0 }] }));
      const mb = Number(r.rows[0].bytes || 0) / (1024 * 1024);
      return { triggered: mb > maxMb, observation: { egress_mb: mb, threshold_mb: maxMb } };
    }
    case 'data_exfiltration': {
      const maxReads = Number(threshold.max_reads_per_hour || 1000);
      const r = await pool.query(`
        SELECT COUNT(*)::int AS n FROM audit_chain
        WHERE entry @> $1::jsonb AND created_at > NOW() - INTERVAL '1 hour'
      `, [JSON.stringify({ agent_did: tw.agent_did, event_type: 'storage.read' })])
        .catch(() => ({ rows: [{ n: 0 }] }));
      return { triggered: Number(r.rows[0].n) > maxReads, observation: { reads_1h: Number(r.rows[0].n), threshold: maxReads } };
    }
    default:
      return { triggered: false, observation: { reason: 'unknown_kind' } };
  }
}

async function recordTrigger(pool, auditChain, tw, observation) {
  const eventId = genId('twe');
  const entry = await auditChain.append({
    event_type: 'tripwire.triggered',
    agent_did: tw.agent_did,
    tripwire_id: tw.tripwire_id,
    kind: tw.kind,
    action_taken: tw.action,
    observation,
    timestamp: new Date().toISOString()
  });

  await pool.query(`
    INSERT INTO tripwire_events
      (event_id, tripwire_id, agent_did, observation, action_taken, audit_chain_entry)
    VALUES ($1,$2,$3,$4::jsonb,$5,$6)
  `, [eventId, tw.tripwire_id, tw.agent_did, JSON.stringify(observation), tw.action, entry.hash]);

  await pool.query(`
    UPDATE tripwires SET last_triggered_at = NOW(), trigger_count = trigger_count + 1
    WHERE tripwire_id = $1
  `, [tw.tripwire_id]);

  // For pause/terminate, apply a containment zone automatically
  if (tw.action === 'pause' || tw.action === 'terminate') {
    const zoneId = genId('zone');
    const restrictions = tw.action === 'terminate'
      ? { forbidden_actions: ['*'], note: 'terminated by tripwire' }
      : { forbidden_actions: ['transfer', 'fine_tune', 'contract_call'], max_spend_cents: 0,
          note: 'paused by tripwire' };
    const until = tw.action === 'terminate'
      ? null
      : new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    await pool.query(`
      INSERT INTO containment_zones
        (zone_id, agent_did, restrictions, active, until_at, reason, audit_chain_entry)
      VALUES ($1,$2,$3::jsonb,TRUE,$4,$5,$6)
    `, [zoneId, tw.agent_did, JSON.stringify(restrictions),
        until, `tripwire:${tw.tripwire_id}`, entry.hash]);
  }

  return { event_id: eventId, audit_chain_entry: entry.hash };
}

// ----------------------------------------------------------------------------
// Routes
// ----------------------------------------------------------------------------
function registerTripwiresRoutes(app, pool, verifyAgentAuth, auditChain) {
  // POST /v1/agents/:did/tripwires
  const TripwireSchema = z.object({
    name:      z.string().min(1).max(128),
    kind:      z.enum(TRIPWIRE_KINDS),
    threshold: z.record(z.any()),
    action:    z.enum(TRIPWIRE_ACTIONS).default('alert'),
    active:    z.boolean().optional()
  });

  app.post('/v1/agents/:did/tripwires', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const parse = TripwireSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;

      const tripwireId = genId('tw');
      await pool.query(`
        INSERT INTO tripwires (tripwire_id, agent_did, name, kind, threshold, action, active)
        VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7)
      `, [tripwireId, did, d.name, d.kind, JSON.stringify(d.threshold), d.action, d.active !== false]);

      const entry = await auditChain.append({
        event_type: 'tripwire.created',
        agent_did: did, tripwire_id: tripwireId, kind: d.kind, action: d.action,
        timestamp: new Date().toISOString()
      });

      return res.status(201).json({
        tripwire_id: tripwireId, agent_did: did, name: d.name,
        kind: d.kind, action: d.action, active: d.active !== false,
        audit_chain_entry: entry.hash
      });
    } catch (e) {
      console.error('[tripwires.create]', e);
      return res.status(500).json({ error: 'create_failed', message: e.message });
    }
  });

  // GET /v1/agents/:did/tripwires
  app.get('/v1/agents/:did/tripwires', async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const r = await pool.query(
        `SELECT * FROM tripwires WHERE agent_did = $1 ORDER BY created_at DESC LIMIT 200`,
        [did]
      ).catch(() => ({ rows: [] }));
      return res.json({ agent_did: did, tripwires: r.rows, count: r.rows.length });
    } catch (e) {
      return res.status(500).json({ error: 'list_failed', message: e.message });
    }
  });

  // POST /v1/agents/:did/tripwires/:id/trigger — manual or auto
  app.post('/v1/agents/:did/tripwires/:id/trigger', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const r = await pool.query(
        `SELECT * FROM tripwires WHERE tripwire_id = $1 AND agent_did = $2`,
        [req.params.id, did]
      ).catch(() => ({ rows: [] }));
      if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });

      const tw = r.rows[0];
      let observation = req.body?.observation;
      if (!observation) {
        const evalRes = await evaluateTripwire(pool, tw);
        observation = evalRes.observation;
      }
      const rec = await recordTrigger(pool, auditChain, tw, observation);
      return res.status(201).json({
        tripwire_id: tw.tripwire_id, action_taken: tw.action,
        observation, ...rec
      });
    } catch (e) {
      console.error('[tripwires.trigger]', e);
      return res.status(500).json({ error: 'trigger_failed', message: e.message });
    }
  });

  // POST /v1/agents/:did/tripwires/events/:id/review — flag false positive
  const ReviewSchema = z.object({
    false_positive: z.boolean(),
    notes:          z.string().max(2000).optional()
  });
  app.post('/v1/agents/:did/tripwires/events/:id/review', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const parse = ReviewSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });

      const r = await pool.query(
        `UPDATE tripwire_events
         SET false_positive = $1, reviewed_by_did = $2
         WHERE event_id = $3 AND agent_did = $4
         RETURNING event_id, tripwire_id, false_positive`,
        [parse.data.false_positive, auth.subject || did, req.params.id, did]
      ).catch(() => ({ rows: [] }));
      if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });

      await auditChain.append({
        event_type: 'tripwire.event_reviewed',
        agent_did: did, event_id: req.params.id,
        false_positive: parse.data.false_positive,
        reviewed_by_did: auth.subject || did,
        timestamp: new Date().toISOString()
      });

      return res.json(r.rows[0]);
    } catch (e) {
      return res.status(500).json({ error: 'review_failed', message: e.message });
    }
  });

  // POST /v1/agents/:did/containment — apply zone
  const ContainmentSchema = z.object({
    restrictions: z.object({
      allowed_endpoints: z.array(z.string()).optional(),
      max_egress_mb:     z.number().min(0).optional(),
      max_spend_cents:   z.number().int().min(0).optional(),
      forbidden_actions: z.array(z.string()).optional()
    }),
    duration_seconds: z.number().int().min(1).max(31536000).optional(),
    reason:           z.string().max(1000).optional()
  });

  app.post('/v1/agents/:did/containment', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const parse = ContainmentSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;

      const zoneId = genId('zone');
      const until = d.duration_seconds
        ? new Date(Date.now() + d.duration_seconds * 1000).toISOString()
        : null;

      const entry = await auditChain.append({
        event_type: 'containment.applied',
        agent_did: did, zone_id: zoneId,
        restrictions: d.restrictions, until_at: until,
        reason: d.reason || null,
        timestamp: new Date().toISOString()
      });

      await pool.query(`
        INSERT INTO containment_zones
          (zone_id, agent_did, restrictions, active, until_at, reason, audit_chain_entry)
        VALUES ($1,$2,$3::jsonb,TRUE,$4,$5,$6)
      `, [zoneId, did, JSON.stringify(d.restrictions), until,
          d.reason || null, entry.hash]);

      return res.status(201).json({
        zone_id: zoneId, agent_did: did,
        restrictions: d.restrictions, until_at: until,
        audit_chain_entry: entry.hash
      });
    } catch (e) {
      console.error('[containment.create]', e);
      return res.status(500).json({ error: 'containment_failed', message: e.message });
    }
  });

  // GET /v1/agents/:did/containment
  app.get('/v1/agents/:did/containment', async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const r = await pool.query(`
        SELECT zone_id, restrictions, active, until_at, reason, created_at
        FROM containment_zones
        WHERE agent_did = $1 AND active = TRUE
          AND (until_at IS NULL OR until_at > NOW())
        ORDER BY created_at DESC LIMIT 50
      `, [did]).catch(() => ({ rows: [] }));
      return res.json({ agent_did: did, zones: r.rows, count: r.rows.length });
    } catch (e) {
      return res.status(500).json({ error: 'list_failed', message: e.message });
    }
  });

  // POST /v1/_jobs/tripwire-sweep — cron — evaluate all active tripwires
  const { registerCron } = require('../cron_auth');
  registerCron(app, '/v1/_jobs/tripwire-sweep', async (req, res) => {
    try {
      const all = await pool.query(
        `SELECT * FROM tripwires WHERE active = TRUE LIMIT 1000`
      ).catch(() => ({ rows: [] }));

      let evaluated = 0, triggered = 0;
      const triggerSamples = [];
      for (const tw of all.rows) {
        evaluated++;
        try {
          const { triggered: t, observation } = await evaluateTripwire(pool, tw);
          if (t) {
            await recordTrigger(pool, auditChain, tw, observation);
            triggered++;
            if (triggerSamples.length < 20) {
              triggerSamples.push({ tripwire_id: tw.tripwire_id, agent_did: tw.agent_did, kind: tw.kind });
            }
          }
        } catch (e) {
          console.warn('[tripwire-sweep]', tw.tripwire_id, e.message);
        }
      }

      // Expire containment zones past their until_at
      const expR = await pool.query(`
        UPDATE containment_zones SET active = FALSE
        WHERE active = TRUE AND until_at IS NOT NULL AND until_at < NOW()
        RETURNING zone_id
      `).catch(() => ({ rows: [] }));

      return res.json({
        evaluated, triggered, triggers: triggerSamples,
        expired_zones: expR.rows.length
      });
    } catch (e) {
      return res.status(500).json({ error: 'sweep_failed', message: e.message });
    }
  });
}

module.exports = {
  migrate,
  registerTripwiresRoutes,
  evaluateTripwire,
  recordTrigger,
  TRIPWIRE_KINDS,
  TRIPWIRE_ACTIONS
};
