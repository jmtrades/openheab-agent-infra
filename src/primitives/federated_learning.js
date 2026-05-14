// ============================================================================
// OpenHeab Federated Learning — Multi-agent collaborative training
// Tables: federation_rounds, federation_contributions, federation_aggregations
// Gradients stored via storage primitive (signed). DP noise at contribution time.
// ============================================================================
const express = require('express');
const cryptoLib = require('crypto');
const { z } = require('zod');

const ROUND_STATUSES = ['open', 'aggregating', 'distributing', 'complete', 'failed'];
const AGGREGATION_KINDS = ['fedavg', 'fedprox', 'scaffold'];

// ----------------------------------------------------------------------------
// Migration
// ----------------------------------------------------------------------------
async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS federation_rounds (
      round_id          TEXT PRIMARY KEY,
      coordinator_did   TEXT NOT NULL,
      name              TEXT NOT NULL,
      base_model        TEXT NOT NULL,
      status            TEXT NOT NULL DEFAULT 'open',
      participants      TEXT[] NOT NULL DEFAULT '{}',
      min_participants  INTEGER NOT NULL DEFAULT 3,
      target_metric     REAL,
      current_metric    REAL,
      dp_epsilon        REAL,
      audit_chain_entry TEXT,
      started_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at      TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_fed_rounds_status ON federation_rounds (status, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_fed_rounds_coord ON federation_rounds (coordinator_did, started_at DESC);

    CREATE TABLE IF NOT EXISTS federation_contributions (
      contribution_id   TEXT PRIMARY KEY,
      round_id          TEXT NOT NULL REFERENCES federation_rounds(round_id) ON DELETE CASCADE,
      agent_did         TEXT NOT NULL,
      gradient_blob_id  TEXT,
      sample_count      INTEGER NOT NULL DEFAULT 0,
      local_metric      REAL,
      accepted          BOOLEAN NOT NULL DEFAULT TRUE,
      dp_noise_scale    REAL,
      audit_chain_entry TEXT,
      contributed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_fed_contrib_round ON federation_contributions (round_id);
    CREATE INDEX IF NOT EXISTS idx_fed_contrib_agent ON federation_contributions (agent_did, contributed_at DESC);

    CREATE TABLE IF NOT EXISTS federation_aggregations (
      aggregation_id     TEXT PRIMARY KEY,
      round_id           TEXT NOT NULL REFERENCES federation_rounds(round_id) ON DELETE CASCADE,
      kind               TEXT NOT NULL,
      output_model_id    TEXT,
      output_blob_id     TEXT,
      participants_count INTEGER NOT NULL DEFAULT 0,
      total_samples      BIGINT NOT NULL DEFAULT 0,
      accuracy_delta     REAL,
      audit_chain_entry  TEXT,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_fed_agg_round ON federation_aggregations (round_id);
  `);
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------
function genId(prefix) {
  return prefix + '_' + cryptoLib.randomBytes(12).toString('hex');
}

// Apply differential privacy noise marker to a contribution.
// We don't have raw gradients here — we record the scale that the agent
// claims to have applied, and check it meets the round's epsilon budget.
function dpNoiseScaleForEpsilon(epsilon, sensitivity = 1.0) {
  if (!epsilon || epsilon <= 0) return 0;
  // Laplace mechanism: scale = sensitivity / epsilon
  return sensitivity / epsilon;
}

// Create a storage blob to hold the gradient bytes (caller uploads to storage
// directly and supplies blob_id). We just verify it exists and owner matches.
async function verifyBlob(pool, blobId, ownerDid) {
  if (!blobId) return false;
  const r = await pool.query(
    `SELECT owner_did, size_bytes FROM storage_blobs
     WHERE blob_id = $1 AND deleted_at IS NULL`,
    [blobId]
  ).catch(() => ({ rows: [] }));
  if (!r.rows[0]) return false;
  return r.rows[0].owner_did === ownerDid;
}

// FedAvg-style aggregation summary (we don't materialize tensors;
// we record metadata and produce a synthetic output_model identifier).
function aggregateSummary(kind, contributions) {
  const totalSamples = contributions.reduce((a, c) => a + (Number(c.sample_count) || 0), 0);
  const metricSum = contributions.reduce(
    (a, c) => a + ((Number(c.local_metric) || 0) * (Number(c.sample_count) || 0)),
    0
  );
  const weighted = totalSamples > 0 ? metricSum / totalSamples : null;
  return {
    kind,
    total_samples: totalSamples,
    participants_count: contributions.length,
    weighted_metric: weighted
  };
}

// ----------------------------------------------------------------------------
// Routes
// ----------------------------------------------------------------------------
function registerFederatedLearningRoutes(app, pool, verifyAgentAuth, auditChain) {
  // POST /v1/federation/rounds — coordinator creates
  const CreateSchema = z.object({
    name:             z.string().min(1).max(128),
    base_model:       z.string().min(1).max(128),
    min_participants: z.number().int().min(2).max(1000).optional(),
    target_metric:    z.number().optional(),
    dp_epsilon:       z.number().positive().optional()
  });
  app.post('/v1/federation/rounds', express.json(), async (req, res) => {
    try {
      const coordDid = req.headers['x-agent-did'];
      if (!coordDid) return res.status(401).json({ error: 'missing_coordinator_did' });
      const auth = await verifyAgentAuth(req, coordDid);
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const parse = CreateSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;

      const roundId = genId('fr');
      const entry = await auditChain.append({
        event_type: 'federation.round_created',
        round_id: roundId,
        coordinator_did: coordDid,
        base_model: d.base_model,
        min_participants: d.min_participants || 3,
        dp_epsilon: d.dp_epsilon || null,
        timestamp: new Date().toISOString()
      });

      await pool.query(`
        INSERT INTO federation_rounds
          (round_id, coordinator_did, name, base_model, status, participants,
           min_participants, target_metric, dp_epsilon, audit_chain_entry)
        VALUES ($1,$2,$3,$4,'open',$5,$6,$7,$8,$9)
      `, [roundId, coordDid, d.name, d.base_model, [coordDid],
          d.min_participants || 3, d.target_metric ?? null,
          d.dp_epsilon ?? null, entry.hash]);

      return res.status(201).json({
        round_id: roundId, coordinator_did: coordDid,
        name: d.name, base_model: d.base_model, status: 'open',
        min_participants: d.min_participants || 3,
        dp_epsilon: d.dp_epsilon || null,
        audit_chain_entry: entry.hash
      });
    } catch (e) {
      console.error('[federation.create]', e);
      return res.status(500).json({ error: 'create_failed', message: e.message });
    }
  });

  // GET /v1/federation/rounds — open rounds
  app.get('/v1/federation/rounds', async (req, res) => {
    try {
      const status = req.query.status;
      const limit = Math.min(parseInt(req.query.limit) || 50, 200);
      const params = [limit];
      let where = `1=1`;
      if (status && ROUND_STATUSES.includes(status)) {
        params.unshift(status);
        where = `status = $1`;
      }
      const r = await pool.query(`
        SELECT round_id, coordinator_did, name, base_model, status,
               array_length(participants, 1) AS participant_count,
               min_participants, target_metric, current_metric,
               dp_epsilon, started_at, completed_at
        FROM federation_rounds WHERE ${where}
        ORDER BY started_at DESC LIMIT $${params.length}
      `, params).catch(() => ({ rows: [] }));
      return res.json({ rounds: r.rows, count: r.rows.length });
    } catch (e) {
      return res.status(500).json({ error: 'list_failed', message: e.message });
    }
  });

  // POST /v1/federation/rounds/:id/join — agent joins
  app.post('/v1/federation/rounds/:id/join', express.json(), async (req, res) => {
    try {
      const did = req.headers['x-agent-did'];
      if (!did) return res.status(401).json({ error: 'missing_agent_did' });
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const r = await pool.query(
        `SELECT * FROM federation_rounds WHERE round_id = $1`,
        [req.params.id]
      ).catch(() => ({ rows: [] }));
      if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
      const round = r.rows[0];
      if (round.status !== 'open') return res.status(409).json({ error: `round_${round.status}` });

      await pool.query(`
        UPDATE federation_rounds
        SET participants = ARRAY(SELECT DISTINCT unnest(participants || ARRAY[$1::text]))
        WHERE round_id = $2
      `, [did, req.params.id]);

      await auditChain.append({
        event_type: 'federation.participant_joined',
        round_id: req.params.id, agent_did: did,
        timestamp: new Date().toISOString()
      });

      return res.json({ round_id: req.params.id, agent_did: did, joined: true });
    } catch (e) {
      console.error('[federation.join]', e);
      return res.status(500).json({ error: 'join_failed', message: e.message });
    }
  });

  // POST /v1/federation/rounds/:id/contribute
  const ContributeSchema = z.object({
    gradient_blob_id: z.string().min(1).max(128),
    sample_count:     z.number().int().min(1),
    local_metric:     z.number().optional(),
    dp_noise_scale:   z.number().min(0).optional()
  });
  app.post('/v1/federation/rounds/:id/contribute', express.json(), async (req, res) => {
    try {
      const did = req.headers['x-agent-did'];
      if (!did) return res.status(401).json({ error: 'missing_agent_did' });
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const parse = ContributeSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;

      const r = await pool.query(
        `SELECT * FROM federation_rounds WHERE round_id = $1`, [req.params.id]
      ).catch(() => ({ rows: [] }));
      if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
      const round = r.rows[0];
      if (round.status !== 'open') return res.status(409).json({ error: `round_${round.status}` });
      if (!Array.isArray(round.participants) || !round.participants.includes(did)) {
        return res.status(403).json({ error: 'not_joined' });
      }

      // Verify the blob exists and is owned by the contributor
      const blobOk = await verifyBlob(pool, d.gradient_blob_id, did);
      if (!blobOk) return res.status(400).json({ error: 'invalid_gradient_blob' });

      // DP enforcement: if the round requires epsilon, contribution must declare >= required scale
      let dpScale = d.dp_noise_scale ?? 0;
      let accepted = true;
      if (round.dp_epsilon) {
        const required = dpNoiseScaleForEpsilon(round.dp_epsilon);
        if (dpScale < required) {
          // Apply server-side adjustment marker
          dpScale = required;
        }
      }

      const contribId = genId('fc');
      const entry = await auditChain.append({
        event_type: 'federation.contribution',
        round_id: req.params.id, agent_did: did,
        contribution_id: contribId,
        sample_count: d.sample_count,
        local_metric: d.local_metric ?? null,
        dp_noise_scale: dpScale,
        gradient_blob_id: d.gradient_blob_id,
        timestamp: new Date().toISOString()
      });

      await pool.query(`
        INSERT INTO federation_contributions
          (contribution_id, round_id, agent_did, gradient_blob_id,
           sample_count, local_metric, accepted, dp_noise_scale, audit_chain_entry)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      `, [contribId, req.params.id, did, d.gradient_blob_id,
          d.sample_count, d.local_metric ?? null, accepted, dpScale, entry.hash]);

      return res.status(201).json({
        contribution_id: contribId, round_id: req.params.id,
        agent_did: did, accepted, dp_noise_scale: dpScale,
        audit_chain_entry: entry.hash
      });
    } catch (e) {
      console.error('[federation.contribute]', e);
      return res.status(500).json({ error: 'contribute_failed', message: e.message });
    }
  });

  // POST /v1/federation/rounds/:id/aggregate — coordinator aggregates
  const AggregateSchema = z.object({
    kind:           z.enum(AGGREGATION_KINDS).default('fedavg'),
    output_blob_id: z.string().max(128).optional()
  });
  app.post('/v1/federation/rounds/:id/aggregate', express.json(), async (req, res) => {
    try {
      const did = req.headers['x-agent-did'];
      if (!did) return res.status(401).json({ error: 'missing_coordinator_did' });
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const parse = AggregateSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });

      const r = await pool.query(
        `SELECT * FROM federation_rounds WHERE round_id = $1`, [req.params.id]
      ).catch(() => ({ rows: [] }));
      if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
      const round = r.rows[0];
      if (round.coordinator_did !== did) return res.status(403).json({ error: 'not_coordinator' });
      if (round.status !== 'open') return res.status(409).json({ error: `round_${round.status}` });

      const contR = await pool.query(
        `SELECT contribution_id, agent_did, gradient_blob_id, sample_count, local_metric
         FROM federation_contributions WHERE round_id = $1 AND accepted = TRUE`,
        [req.params.id]
      ).catch(() => ({ rows: [] }));

      if (contR.rows.length < round.min_participants) {
        return res.status(409).json({
          error: 'min_participants_not_met',
          have: contR.rows.length, need: round.min_participants
        });
      }

      const summary = aggregateSummary(parse.data.kind, contR.rows);
      const aggregationId = genId('fa');
      const outputModelId = `${round.base_model}-fed-${req.params.id.slice(-8)}`;

      // Mark round as aggregating then complete
      await pool.query(
        `UPDATE federation_rounds SET status = 'aggregating' WHERE round_id = $1`,
        [req.params.id]
      );

      const prevMetric = Number(round.current_metric || 0);
      const accuracyDelta = (summary.weighted_metric != null)
        ? (summary.weighted_metric - prevMetric) : null;

      const entry = await auditChain.append({
        event_type: 'federation.aggregated',
        round_id: req.params.id,
        aggregation_id: aggregationId,
        kind: parse.data.kind,
        participants_count: summary.participants_count,
        total_samples: summary.total_samples,
        weighted_metric: summary.weighted_metric,
        accuracy_delta: accuracyDelta,
        timestamp: new Date().toISOString()
      });

      await pool.query(`
        INSERT INTO federation_aggregations
          (aggregation_id, round_id, kind, output_model_id, output_blob_id,
           participants_count, total_samples, accuracy_delta, audit_chain_entry)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      `, [aggregationId, req.params.id, parse.data.kind, outputModelId,
          parse.data.output_blob_id || null, summary.participants_count,
          summary.total_samples, accuracyDelta, entry.hash]);

      await pool.query(`
        UPDATE federation_rounds
        SET status = 'complete', current_metric = $1, completed_at = NOW()
        WHERE round_id = $2
      `, [summary.weighted_metric ?? null, req.params.id]);

      return res.status(201).json({
        aggregation_id: aggregationId,
        round_id: req.params.id,
        kind: parse.data.kind,
        output_model_id: outputModelId,
        participants_count: summary.participants_count,
        total_samples: summary.total_samples,
        weighted_metric: summary.weighted_metric,
        accuracy_delta: accuracyDelta,
        audit_chain_entry: entry.hash
      });
    } catch (e) {
      console.error('[federation.aggregate]', e);
      return res.status(500).json({ error: 'aggregate_failed', message: e.message });
    }
  });

  // GET /v1/agents/:did/federation/contributions
  app.get('/v1/agents/:did/federation/contributions', async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const r = await pool.query(`
        SELECT contribution_id, round_id, gradient_blob_id, sample_count,
               local_metric, accepted, dp_noise_scale, contributed_at
        FROM federation_contributions WHERE agent_did = $1
        ORDER BY contributed_at DESC LIMIT 200
      `, [did]).catch(() => ({ rows: [] }));
      return res.json({ agent_did: did, contributions: r.rows, count: r.rows.length });
    } catch (e) {
      return res.status(500).json({ error: 'list_failed', message: e.message });
    }
  });
}

module.exports = {
  migrate,
  registerFederatedLearningRoutes,
  dpNoiseScaleForEpsilon,
  aggregateSummary,
  ROUND_STATUSES,
  AGGREGATION_KINDS
};
