// ============================================================================
// OpenHeab Climate — Carbon accounting + sustainability + offset purchasing.
// Tables: carbon_inventories, emission_events, carbon_offsets, climate_pledges.
// Auto-hooks compute primitive: each GPU hour → 0.4 kg CO2e (scope 2).
// Offset purchases retire via Toucan/Klima providers (stubbed).
// ============================================================================
const express = require('express');
const cryptoLib = require('crypto');
const { z } = require('zod');

const INVENTORY_STATUSES = ['drafted', 'verified', 'published'];
const EMISSION_KINDS = ['energy', 'transportation', 'food', 'cloud_compute', 'manufacturing', 'other'];
const PLEDGE_TARGETS = ['net_zero', 'carbon_neutral', 'halve'];
const PLEDGE_STATUSES = ['active', 'met', 'abandoned'];
const OFFSET_PROJECTS = ['verra', 'gold_standard', 'puro', 'climate_action_reserve', 'american_carbon_registry'];

// Emission factors (kg CO2e per unit)
const EMISSION_FACTORS = {
  // cloud_compute
  gpu_hour: 0.4,
  cpu_hour: 0.05,
  // energy
  kwh: 0.42,         // US grid avg
  kwh_renewable: 0.0,
  // transportation
  km_car: 0.171,
  km_flight_short: 0.255,
  km_flight_long: 0.195,
  km_train: 0.041,
  // food (per kg of food)
  kg_beef: 27,
  kg_chicken: 6.9,
  kg_vegan: 1.5
};

// Offset price (USDC cents per kg CO2e)
const OFFSET_PRICE_CENTS_PER_KG = 1.5; // ~$15/tonne

// ----------------------------------------------------------------------------
// Migration
// ----------------------------------------------------------------------------
async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS carbon_inventories (
      inventory_id        TEXT PRIMARY KEY,
      owner_did           TEXT NOT NULL,
      entity_id           TEXT,
      period_start        DATE,
      period_end          DATE,
      scope1_kg_co2e      BIGINT NOT NULL DEFAULT 0,
      scope2_kg_co2e      BIGINT NOT NULL DEFAULT 0,
      scope3_kg_co2e      BIGINT NOT NULL DEFAULT 0,
      total_kg_co2e       BIGINT NOT NULL DEFAULT 0,
      methodology         TEXT,
      verified_by         TEXT,
      verified_at         TIMESTAMPTZ,
      status              TEXT NOT NULL DEFAULT 'drafted',
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_carbon_inventories_owner ON carbon_inventories (owner_did, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_carbon_inventories_entity ON carbon_inventories (entity_id);

    CREATE TABLE IF NOT EXISTS emission_events (
      event_id          TEXT PRIMARY KEY,
      inventory_id      TEXT,
      agent_did         TEXT NOT NULL,
      kind              TEXT NOT NULL,
      scope             INTEGER NOT NULL DEFAULT 3,
      source            TEXT,
      quantity          NUMERIC NOT NULL DEFAULT 0,
      unit              TEXT,
      emission_factor   REAL NOT NULL DEFAULT 0,
      kg_co2e           BIGINT NOT NULL DEFAULT 0,
      occurred_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      source_event_id   TEXT,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_emission_events_agent ON emission_events (agent_did, occurred_at DESC);
    CREATE INDEX IF NOT EXISTS idx_emission_events_inventory ON emission_events (inventory_id);
    CREATE INDEX IF NOT EXISTS idx_emission_events_source ON emission_events (source_event_id) WHERE source_event_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS carbon_offsets (
      offset_id         TEXT PRIMARY KEY,
      agent_did         TEXT NOT NULL,
      kg_co2e           BIGINT NOT NULL DEFAULT 0,
      project           TEXT,
      project_id        TEXT,
      vintage_year      INTEGER,
      retired           BOOLEAN NOT NULL DEFAULT FALSE,
      retirement_tx     TEXT,
      cost_usdc_raw     NUMERIC(78,0) NOT NULL DEFAULT 0,
      purchased_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      retired_at        TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_carbon_offsets_agent ON carbon_offsets (agent_did, purchased_at DESC);

    CREATE TABLE IF NOT EXISTS climate_pledges (
      pledge_id          TEXT PRIMARY KEY,
      agent_did          TEXT NOT NULL,
      name               TEXT NOT NULL,
      target             TEXT NOT NULL,
      target_year        INTEGER,
      baseline_year      INTEGER,
      baseline_kg_co2e   BIGINT NOT NULL DEFAULT 0,
      status             TEXT NOT NULL DEFAULT 'active',
      created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_climate_pledges_agent ON climate_pledges (agent_did);
  `).catch(() => {});
}

function genId(prefix) { return `${prefix}_${cryptoLib.randomBytes(12).toString('hex')}`; }

function computeKgCo2e(unit, quantity, customFactor) {
  const factor = customFactor != null ? Number(customFactor) : (EMISSION_FACTORS[unit] || 0);
  return Math.round(Number(quantity || 0) * factor);
}

// Exported helper that other primitives (e.g., compute) can call to log emissions
async function recordEmission(pool, opts, auditChain = null) {
  const {
    agent_did, kind, scope = 3, source = null,
    quantity, unit, emission_factor = null,
    occurred_at = null, source_event_id = null, inventory_id = null
  } = opts;
  if (!agent_did || !kind || quantity == null || !unit) {
    throw new Error('agent_did, kind, quantity, unit required');
  }
  // Idempotency on source_event_id
  if (source_event_id) {
    const ex = await pool.query(
      `SELECT event_id, kg_co2e FROM emission_events WHERE source_event_id=$1 AND agent_did=$2 LIMIT 1`,
      [source_event_id, agent_did]
    ).catch(() => ({ rows: [] }));
    if (ex.rows[0]) return { event_id: ex.rows[0].event_id, deduped: true };
  }
  const factor = emission_factor != null ? Number(emission_factor) : (EMISSION_FACTORS[unit] || 0);
  const kg = computeKgCo2e(unit, quantity, factor);
  const eventId = genId('em');
  await pool.query(
    `INSERT INTO emission_events (event_id, inventory_id, agent_did, kind, scope, source,
                                    quantity, unit, emission_factor, kg_co2e, occurred_at,
                                    source_event_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [eventId, inventory_id, agent_did, kind, scope, source,
     quantity, unit, factor, kg, occurred_at || new Date(), source_event_id]
  );
  if (auditChain) {
    await auditChain.append({
      event_type: 'climate.emission_recorded', event_id: eventId,
      agent_did, kind, scope, kg_co2e: kg,
      timestamp: new Date().toISOString()
    }).catch(() => {});
  }
  return { event_id: eventId, kg_co2e: kg };
}

// Stubbed offset purchase + retirement
async function purchaseOffset(pool, opts, auditChain) {
  const { agent_did, kg_co2e, project = 'verra', vintage_year = new Date().getFullYear() - 1 } = opts;
  const cost = BigInt(Math.round(Number(kg_co2e) * OFFSET_PRICE_CENTS_PER_KG * 10000)); // raw 1e6 USDC
  const offsetId = genId('off');
  await pool.query(
    `INSERT INTO carbon_offsets (offset_id, agent_did, kg_co2e, project, project_id, vintage_year,
                                   retired, retirement_tx, cost_usdc_raw, retired_at)
     VALUES ($1,$2,$3,$4,$5,$6,TRUE,$7,$8,NOW())`,
    [offsetId, agent_did, kg_co2e, project,
     'proj_' + cryptoLib.randomBytes(4).toString('hex'), vintage_year,
     '0x' + cryptoLib.randomBytes(32).toString('hex'),
     cost.toString()]
  );
  if (auditChain) {
    await auditChain.append({
      event_type: 'climate.offset_purchased', offset_id: offsetId,
      agent_did, kg_co2e, project, cost_usdc_raw: cost.toString(),
      timestamp: new Date().toISOString()
    }).catch(() => {});
  }
  return { offset_id: offsetId, kg_co2e, project, cost_usdc_raw: cost.toString() };
}

// Called by compute primitive (or others) when compute is consumed.
// total_gpu_hours and total_cpu_hours come in as floats.
async function autoRecordComputeEmissions(pool, opts, auditChain) {
  const { agent_did, gpu_hours = 0, cpu_hours = 0, source_event_id = null, renewable = false } = opts;
  const events = [];
  if (gpu_hours > 0) {
    const r = await recordEmission(pool, {
      agent_did, kind: 'cloud_compute', scope: 2,
      source: 'gpu', quantity: gpu_hours,
      unit: renewable ? 'kwh_renewable' : 'gpu_hour',
      source_event_id: source_event_id ? `${source_event_id}:gpu` : null
    }, auditChain);
    events.push(r);
  }
  if (cpu_hours > 0) {
    const r = await recordEmission(pool, {
      agent_did, kind: 'cloud_compute', scope: 2,
      source: 'cpu', quantity: cpu_hours,
      unit: renewable ? 'kwh_renewable' : 'cpu_hour',
      source_event_id: source_event_id ? `${source_event_id}:cpu` : null
    }, auditChain);
    events.push(r);
  }
  return events;
}

// ----------------------------------------------------------------------------
// Routes
// ----------------------------------------------------------------------------
function registerClimateRoutes(app, pool, verifyAgentAuth, auditChain) {
  // ---- Inventories ---------------------------------------------------------
  const InventorySchema = z.object({
    entity_id: z.string().max(200).optional(),
    period_start: z.string().optional(),
    period_end: z.string().optional(),
    methodology: z.string().max(500).optional()
  });
  app.post('/v1/agents/:did/climate/inventories', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const parse = InventorySchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;
      const id = genId('inv');
      await pool.query(
        `INSERT INTO carbon_inventories (inventory_id, owner_did, entity_id, period_start,
                                           period_end, methodology, status)
         VALUES ($1,$2,$3,$4,$5,$6,'drafted')`,
        [id, did, d.entity_id || null, d.period_start || null,
         d.period_end || null, d.methodology || null]
      );
      await auditChain.append({
        event_type: 'climate.inventory_created', inventory_id: id, owner_did: did,
        timestamp: new Date().toISOString()
      });
      return res.status(201).json({ inventory_id: id, status: 'drafted' });
    } catch (e) { return res.status(500).json({ error: 'create_failed', message: e.message }); }
  });

  // ---- Emission events -----------------------------------------------------
  const EmissionSchema = z.object({
    inventory_id: z.string().optional(),
    kind: z.enum(EMISSION_KINDS),
    scope: z.number().int().min(1).max(3).optional(),
    source: z.string().max(200).optional(),
    quantity: z.number(),
    unit: z.string().min(1).max(60),
    emission_factor: z.number().optional(),
    occurred_at: z.string().optional(),
    source_event_id: z.string().optional()
  });
  app.post('/v1/agents/:did/climate/emission-events', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const parse = EmissionSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;
      const r = await recordEmission(pool, {
        agent_did: did, ...d,
        scope: d.scope ?? (d.kind === 'cloud_compute' ? 2 : 3)
      }, auditChain);
      return res.status(201).json({ ...r, kind: d.kind });
    } catch (e) { return res.status(500).json({ error: 'record_failed', message: e.message }); }
  });

  // ---- Footprint (rolling 365) --------------------------------------------
  app.get('/v1/agents/:did/climate/footprint', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });

    const r = await pool.query(
      `SELECT scope, COALESCE(SUM(kg_co2e),0)::bigint AS kg
         FROM emission_events
        WHERE agent_did=$1 AND occurred_at >= NOW() - INTERVAL '365 days'
        GROUP BY scope`,
      [did]
    ).catch(() => ({ rows: [] }));
    const offsets = await pool.query(
      `SELECT COALESCE(SUM(kg_co2e),0)::bigint AS kg
         FROM carbon_offsets
        WHERE agent_did=$1 AND retired=TRUE AND retired_at >= NOW() - INTERVAL '365 days'`,
      [did]
    ).catch(() => ({ rows: [{ kg: 0 }] }));

    const byScope = { 1: 0, 2: 0, 3: 0 };
    for (const row of r.rows) byScope[Number(row.scope)] = Number(row.kg);
    const total = byScope[1] + byScope[2] + byScope[3];
    const offsetKg = Number(offsets.rows[0]?.kg || 0);
    return res.json({
      agent_did: did,
      window: 'rolling_365',
      scope1_kg_co2e: byScope[1], scope2_kg_co2e: byScope[2], scope3_kg_co2e: byScope[3],
      total_kg_co2e: total, offset_kg_co2e: offsetKg, net_kg_co2e: total - offsetKg
    });
  });

  // ---- Offsets -------------------------------------------------------------
  const OffsetSchema = z.object({
    kg_co2e: z.number().int().min(1).max(1_000_000_000),
    project: z.string().max(60).optional(),
    vintage_year: z.number().int().min(1990).max(2100).optional()
  });
  app.post('/v1/agents/:did/climate/offsets', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const parse = OffsetSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;
      const r = await purchaseOffset(pool, {
        agent_did: did, kg_co2e: d.kg_co2e,
        project: d.project || 'verra',
        vintage_year: d.vintage_year || new Date().getFullYear() - 1
      }, auditChain);
      return res.status(201).json({ ...r, agent_did: did, retired: true });
    } catch (e) { return res.status(500).json({ error: 'offset_failed', message: e.message }); }
  });

  // ---- Pledges -------------------------------------------------------------
  const PledgeSchema = z.object({
    name: z.string().min(1).max(200),
    target: z.enum(PLEDGE_TARGETS),
    target_year: z.number().int().min(2020).max(2200),
    baseline_year: z.number().int().min(1990).max(2200).optional(),
    baseline_kg_co2e: z.number().int().min(0).optional()
  });
  app.post('/v1/agents/:did/climate/pledges', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const parse = PledgeSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;
      const id = genId('pledge');
      await pool.query(
        `INSERT INTO climate_pledges (pledge_id, agent_did, name, target, target_year,
                                         baseline_year, baseline_kg_co2e, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'active')`,
        [id, did, d.name, d.target, d.target_year,
         d.baseline_year || null, d.baseline_kg_co2e || 0]
      );
      await auditChain.append({
        event_type: 'climate.pledge_created', pledge_id: id, agent_did: did,
        target: d.target, target_year: d.target_year,
        timestamp: new Date().toISOString()
      });
      return res.status(201).json({ pledge_id: id, target: d.target, target_year: d.target_year });
    } catch (e) { return res.status(500).json({ error: 'create_failed', message: e.message }); }
  });

  // ---- Browse offset projects (public) -------------------------------------
  app.get('/v1/climate/projects', async (req, res) => {
    return res.json({
      projects: [
        { project: 'verra', name: 'Verra VCS', kind: 'standards body', region: 'global' },
        { project: 'gold_standard', name: 'Gold Standard', kind: 'standards body', region: 'global' },
        { project: 'puro', name: 'Puro.earth', kind: 'durable removals', region: 'global' },
        { project: 'climate_action_reserve', name: 'Climate Action Reserve', kind: 'standards body', region: 'NA' },
        { project: 'american_carbon_registry', name: 'American Carbon Registry', kind: 'standards body', region: 'NA' }
      ],
      price_cents_per_kg: OFFSET_PRICE_CENTS_PER_KG
    });
  });
}

module.exports = {
  migrate, registerClimateRoutes,
  INVENTORY_STATUSES, EMISSION_KINDS, PLEDGE_TARGETS, PLEDGE_STATUSES, OFFSET_PROJECTS,
  EMISSION_FACTORS, OFFSET_PRICE_CENTS_PER_KG,
  recordEmission, purchaseOffset, autoRecordComputeEmissions, computeKgCo2e
};
