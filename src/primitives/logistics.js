// ============================================================================
// Logistics — shipping labels, tracking, fulfillment for agents selling
// physical goods or moving them between locations.
// ============================================================================
const crypto = require('crypto');
const { z } = require('zod');

const CARRIERS = ['ups', 'usps', 'fedex', 'dhl', 'royal_mail', 'sf_express', 'auspost'];

async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS shipments (
      shipment_id     TEXT PRIMARY KEY,
      agent_did       TEXT NOT NULL,
      carrier         TEXT NOT NULL,
      service         TEXT,
      tracking_number TEXT UNIQUE,
      from_address    JSONB NOT NULL,
      to_address      JSONB NOT NULL,
      parcels         JSONB NOT NULL,
      label_url       TEXT,
      label_blob_id   TEXT,
      cost_cents      BIGINT,
      currency        TEXT NOT NULL DEFAULT 'USD',
      provider_id     TEXT,
      status          TEXT NOT NULL DEFAULT 'created',
      ship_date       DATE,
      delivered_at    TIMESTAMPTZ,
      tracking_events JSONB DEFAULT '[]',
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_shipments_did ON shipments (agent_did, status);
    CREATE INDEX IF NOT EXISTS idx_shipments_tracking ON shipments (tracking_number);

    CREATE TABLE IF NOT EXISTS shipping_rates_cache (
      cache_key       TEXT PRIMARY KEY,
      rates           JSONB NOT NULL,
      fetched_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at      TIMESTAMPTZ NOT NULL
    );

    CREATE TABLE IF NOT EXISTS shipping_addresses (
      address_id      TEXT PRIMARY KEY,
      owner_did       TEXT NOT NULL,
      label           TEXT,
      name            TEXT,
      company         TEXT,
      line1           TEXT NOT NULL,
      line2           TEXT,
      city            TEXT NOT NULL,
      state           TEXT,
      postal_code     TEXT NOT NULL,
      country         TEXT NOT NULL,
      phone           TEXT,
      is_default      BOOLEAN NOT NULL DEFAULT FALSE,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_shipping_addr_owner ON shipping_addresses (owner_did);
  `);
}

const addressSchema = z.object({
  name: z.string().min(1).max(120),
  company: z.string().max(120).optional(),
  line1: z.string().min(1).max(200),
  line2: z.string().max(200).optional(),
  city: z.string().min(1).max(100),
  state: z.string().max(80).optional(),
  postal_code: z.string().min(2).max(20),
  country: z.string().length(2),
  phone: z.string().max(40).optional()
});

const parcelSchema = z.object({
  length_cm: z.number().positive(),
  width_cm: z.number().positive(),
  height_cm: z.number().positive(),
  weight_g: z.number().positive(),
  declared_value_cents: z.number().int().nonnegative().optional()
});

const rateSchema = z.object({
  from_address: addressSchema,
  to_address: addressSchema,
  parcels: z.array(parcelSchema).min(1)
});

const shipSchema = rateSchema.extend({
  carrier: z.enum(CARRIERS),
  service: z.string().max(60).optional(),
  ship_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
});

async function handleQuoteRates(req, res, pool) {
  let body;
  try { body = rateSchema.parse(req.body); }
  catch (e) { return res.status(400).json({ error: 'invalid_request', details: e.errors }); }

  // Stub rates — in production call Shippo / EasyPost API
  const weight_total_g = body.parcels.reduce((s, p) => s + p.weight_g, 0);
  const base = Math.max(500, Math.floor(weight_total_g * 0.01));
  const rates = [
    { carrier: 'ups', service: 'ground', amount_cents: base + 300, days: 3 },
    { carrier: 'ups', service: 'next_day_air', amount_cents: base + 4500, days: 1 },
    { carrier: 'fedex', service: '2day', amount_cents: base + 1500, days: 2 },
    { carrier: 'usps', service: 'priority', amount_cents: base + 100, days: 3 },
    { carrier: 'dhl', service: 'international_express', amount_cents: base + 2500, days: 5 }
  ];
  return res.json({ rates });
}

async function handleCreateShipment(req, res, pool, verifyAgentAuth, auditChain) {
  const did = req.params.did;
  const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
  if (!auth.valid) return res.status(401).json({ error: auth.error });

  let body;
  try { body = shipSchema.parse(req.body); }
  catch (e) { return res.status(400).json({ error: 'invalid_request', details: e.errors }); }

  const shipmentId = 'ship_' + crypto.randomBytes(12).toString('hex');
  const trackingNumber = '1Z' + crypto.randomBytes(8).toString('hex').toUpperCase();
  const totalWeight = body.parcels.reduce((s, p) => s + p.weight_g, 0);
  const cost = Math.max(500, Math.floor(totalWeight * 0.012));

  await pool.query(`
    INSERT INTO shipments (shipment_id, agent_did, carrier, service, tracking_number,
      from_address, to_address, parcels, cost_cents, ship_date, status)
    VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9, $10, 'created')
  `, [shipmentId, did, body.carrier, body.service || 'standard', trackingNumber,
      JSON.stringify(body.from_address), JSON.stringify(body.to_address),
      JSON.stringify(body.parcels), cost, body.ship_date || null]);

  if (auditChain) {
    await auditChain.append({
      event_type: 'logistics.shipment_created',
      agent_did: did, shipment_id: shipmentId, carrier: body.carrier, tracking_number: trackingNumber
    });
  }
  return res.status(201).json({
    shipment_id: shipmentId,
    tracking_number: trackingNumber,
    carrier: body.carrier,
    cost_cents: cost,
    label_url: `/v1/logistics/shipments/${shipmentId}/label`
  });
}

async function handleTrack(req, res, pool) {
  const tracking = req.params.tracking || req.query.tracking;
  if (!tracking) return res.status(400).json({ error: 'tracking_required' });
  const r = await pool.query(
    `SELECT carrier, status, tracking_events, ship_date, delivered_at
     FROM shipments WHERE tracking_number = $1`,
    [tracking]
  );
  if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
  return res.json({ tracking_number: tracking, ...r.rows[0] });
}

async function handleList(req, res, pool, verifyAgentAuth) {
  const did = req.params.did;
  const auth = await verifyAgentAuth(req, did);
  if (!auth.valid) return res.status(401).json({ error: auth.error });
  const r = await pool.query(`
    SELECT shipment_id, carrier, service, tracking_number, status, cost_cents,
           ship_date, delivered_at, created_at
    FROM shipments WHERE agent_did = $1 ORDER BY created_at DESC LIMIT 200
  `, [did]);
  return res.json({ agent_did: did, shipments: r.rows });
}

async function handleCancel(req, res, pool, verifyAgentAuth, auditChain) {
  const did = req.params.did;
  const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
  if (!auth.valid) return res.status(401).json({ error: auth.error });
  const r = await pool.query(`
    UPDATE shipments SET status = 'cancelled', updated_at = NOW()
    WHERE shipment_id = $1 AND agent_did = $2 AND status IN ('created', 'label_purchased')
    RETURNING shipment_id
  `, [req.params.id, did]);
  if (!r.rows[0]) return res.status(404).json({ error: 'not_found_or_already_shipped' });
  if (auditChain) {
    await auditChain.append({ event_type: 'logistics.shipment_cancelled', agent_did: did, shipment_id: r.rows[0].shipment_id });
  }
  return res.json({ shipment_id: r.rows[0].shipment_id, status: 'cancelled' });
}

async function handleSaveAddress(req, res, pool, verifyAgentAuth) {
  const did = req.params.did;
  const auth = await verifyAgentAuth(req, did);
  if (!auth.valid) return res.status(401).json({ error: auth.error });
  let body;
  try { body = addressSchema.extend({ label: z.string().max(80).optional(), is_default: z.boolean().optional() }).parse(req.body); }
  catch (e) { return res.status(400).json({ error: 'invalid_request', details: e.errors }); }

  const id = 'addr_' + crypto.randomBytes(8).toString('hex');
  if (body.is_default) {
    await pool.query(`UPDATE shipping_addresses SET is_default = FALSE WHERE owner_did = $1`, [did]);
  }
  await pool.query(`
    INSERT INTO shipping_addresses (address_id, owner_did, label, name, company,
      line1, line2, city, state, postal_code, country, phone, is_default)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
  `, [id, did, body.label || null, body.name, body.company || null,
      body.line1, body.line2 || null, body.city, body.state || null,
      body.postal_code, body.country, body.phone || null, !!body.is_default]);
  return res.status(201).json({ address_id: id });
}

async function handleListAddresses(req, res, pool, verifyAgentAuth) {
  const did = req.params.did;
  const auth = await verifyAgentAuth(req, did);
  if (!auth.valid) return res.status(401).json({ error: auth.error });
  const r = await pool.query(`
    SELECT * FROM shipping_addresses WHERE owner_did = $1 ORDER BY is_default DESC, created_at DESC
  `, [did]);
  return res.json({ agent_did: did, addresses: r.rows });
}

function registerLogisticsRoutes(app, pool, verifyAgentAuth, auditChain) {
  app.post('/v1/logistics/rates',
    (req, res) => handleQuoteRates(req, res, pool));
  app.post('/v1/agents/:did/logistics/shipments',
    (req, res) => handleCreateShipment(req, res, pool, verifyAgentAuth, auditChain));
  app.get('/v1/agents/:did/logistics/shipments',
    (req, res) => handleList(req, res, pool, verifyAgentAuth));
  app.post('/v1/agents/:did/logistics/shipments/:id/cancel',
    (req, res) => handleCancel(req, res, pool, verifyAgentAuth, auditChain));
  app.get('/v1/logistics/track/:tracking',
    (req, res) => handleTrack(req, res, pool));
  app.post('/v1/agents/:did/logistics/addresses',
    (req, res) => handleSaveAddress(req, res, pool, verifyAgentAuth));
  app.get('/v1/agents/:did/logistics/addresses',
    (req, res) => handleListAddresses(req, res, pool, verifyAgentAuth));
}

module.exports = { migrate, registerLogisticsRoutes, CARRIERS };
