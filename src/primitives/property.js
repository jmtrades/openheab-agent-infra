// ============================================================================
// Property — real estate / digital asset listings + rentals
// ============================================================================
const crypto = require('crypto');
const { z } = require('zod');

const PROPERTY_TYPES = ['residential', 'commercial', 'land', 'industrial',
  'digital_domain', 'digital_username', 'digital_handle', 'license', 'other'];

async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS properties (
      property_id     TEXT PRIMARY KEY,
      owner_did       TEXT NOT NULL,
      kind            TEXT NOT NULL,
      title           TEXT NOT NULL,
      description     TEXT,
      address         JSONB,
      coordinates     JSONB,
      area_sqft       NUMERIC,
      area_sqm        NUMERIC,
      bedrooms        INTEGER,
      bathrooms       NUMERIC,
      year_built      INTEGER,
      features        TEXT[],
      photos          JSONB,
      legal_status    TEXT,
      title_deed_uri  TEXT,
      tags            TEXT[],
      status          TEXT NOT NULL DEFAULT 'active',
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_properties_owner ON properties (owner_did, status);
    CREATE INDEX IF NOT EXISTS idx_properties_kind ON properties (kind, status);

    CREATE TABLE IF NOT EXISTS property_listings (
      listing_id      TEXT PRIMARY KEY,
      property_id     TEXT NOT NULL,
      owner_did       TEXT NOT NULL,
      mode            TEXT NOT NULL,
      price_cents     BIGINT,
      currency        TEXT NOT NULL DEFAULT 'USD',
      rent_per_period_cents BIGINT,
      rent_period     TEXT,
      min_term_days   INTEGER,
      deposit_cents   BIGINT,
      available_from  DATE,
      available_until DATE,
      visibility      TEXT NOT NULL DEFAULT 'public',
      status          TEXT NOT NULL DEFAULT 'active',
      views           INTEGER NOT NULL DEFAULT 0,
      inquiries       INTEGER NOT NULL DEFAULT 0,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      sold_at         TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_listings_property ON property_listings (property_id);

    CREATE TABLE IF NOT EXISTS property_leases (
      lease_id        TEXT PRIMARY KEY,
      listing_id      TEXT NOT NULL,
      property_id     TEXT NOT NULL,
      lessor_did      TEXT NOT NULL,
      lessee_did      TEXT NOT NULL,
      start_date      DATE NOT NULL,
      end_date        DATE,
      rent_per_period_cents BIGINT NOT NULL,
      rent_period     TEXT NOT NULL,
      deposit_cents   BIGINT,
      deposit_held_in TEXT,
      contract_id     TEXT,
      status          TEXT NOT NULL DEFAULT 'active',
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      terminated_at   TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS property_inquiries (
      inquiry_id      TEXT PRIMARY KEY,
      listing_id      TEXT NOT NULL,
      inquirer_did    TEXT NOT NULL,
      message         TEXT,
      contact_email   TEXT,
      status          TEXT NOT NULL DEFAULT 'open',
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

const propertySchema = z.object({
  kind: z.enum(PROPERTY_TYPES),
  title: z.string().min(1).max(200),
  description: z.string().max(10000).optional(),
  address: z.record(z.any()).optional(),
  coordinates: z.object({ lat: z.number(), lng: z.number() }).optional(),
  area_sqft: z.number().positive().optional(),
  area_sqm: z.number().positive().optional(),
  bedrooms: z.number().int().nonnegative().optional(),
  bathrooms: z.number().nonnegative().optional(),
  year_built: z.number().int().min(1500).max(3000).optional(),
  features: z.array(z.string()).max(50).optional(),
  photos: z.array(z.string()).max(50).optional(),
  legal_status: z.string().max(80).optional(),
  title_deed_uri: z.string().url().optional(),
  tags: z.array(z.string()).max(20).optional()
});

async function handleCreate(req, res, pool, verifyAgentAuth, auditChain) {
  const did = req.params.did;
  const auth = await verifyAgentAuth(req, did);
  if (!auth.valid) return res.status(401).json({ error: auth.error });
  let body;
  try { body = propertySchema.parse(req.body); }
  catch (e) { return res.status(400).json({ error: 'invalid_request', details: e.errors }); }
  const id = 'prop_' + crypto.randomBytes(10).toString('hex');
  await pool.query(`
    INSERT INTO properties (property_id, owner_did, kind, title, description, address,
      coordinates, area_sqft, area_sqm, bedrooms, bathrooms, year_built, features,
      photos, legal_status, title_deed_uri, tags)
    VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10, $11, $12, $13, $14::jsonb, $15, $16, $17)
  `, [id, did, body.kind, body.title, body.description || null,
      body.address ? JSON.stringify(body.address) : null,
      body.coordinates ? JSON.stringify(body.coordinates) : null,
      body.area_sqft || null, body.area_sqm || null,
      body.bedrooms || null, body.bathrooms || null, body.year_built || null,
      body.features || null, body.photos ? JSON.stringify(body.photos) : null,
      body.legal_status || null, body.title_deed_uri || null, body.tags || null]);
  if (auditChain) {
    await auditChain.append({ event_type: 'property.created', owner_did: did, property_id: id, kind: body.kind });
  }
  return res.status(201).json({ property_id: id });
}

async function handleList(req, res, pool, verifyAgentAuth) {
  const did = req.params.did;
  const auth = await verifyAgentAuth(req, did);
  if (!auth.valid) return res.status(401).json({ error: auth.error });
  const r = await pool.query(`SELECT * FROM properties WHERE owner_did = $1 ORDER BY created_at DESC LIMIT 200`, [did]);
  return res.json({ owner_did: did, properties: r.rows });
}

const listingSchema = z.object({
  mode: z.enum(['sale', 'rent', 'lease']),
  price_cents: z.number().int().positive().optional(),
  currency: z.string().length(3).optional(),
  rent_per_period_cents: z.number().int().positive().optional(),
  rent_period: z.enum(['day', 'week', 'month', 'year']).optional(),
  min_term_days: z.number().int().positive().optional(),
  deposit_cents: z.number().int().nonnegative().optional(),
  available_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  available_until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  visibility: z.enum(['public', 'private', 'agents_only']).optional()
});

async function handleList_listing(req, res, pool, verifyAgentAuth, auditChain) {
  const did = req.headers['x-agent-did'];
  const propertyId = req.params.id;
  if (!did) return res.status(401).json({ error: 'agent_did_required' });

  const prop = await pool.query(`SELECT owner_did FROM properties WHERE property_id = $1`, [propertyId]);
  if (!prop.rows[0]) return res.status(404).json({ error: 'property_not_found' });
  if (prop.rows[0].owner_did !== did) return res.status(403).json({ error: 'not_owner' });
  const auth = await verifyAgentAuth(req, did);
  if (!auth.valid) return res.status(401).json({ error: auth.error });

  let body;
  try { body = listingSchema.parse(req.body); }
  catch (e) { return res.status(400).json({ error: 'invalid_request', details: e.errors }); }

  const id = 'plist_' + crypto.randomBytes(10).toString('hex');
  await pool.query(`
    INSERT INTO property_listings (listing_id, property_id, owner_did, mode, price_cents,
      currency, rent_per_period_cents, rent_period, min_term_days, deposit_cents,
      available_from, available_until, visibility)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
  `, [id, propertyId, did, body.mode, body.price_cents || null,
      body.currency || 'USD', body.rent_per_period_cents || null,
      body.rent_period || null, body.min_term_days || null,
      body.deposit_cents || null, body.available_from || null,
      body.available_until || null, body.visibility || 'public']);
  if (auditChain) {
    await auditChain.append({ event_type: 'property.listed', owner_did: did, listing_id: id, mode: body.mode });
  }
  return res.status(201).json({ listing_id: id });
}

async function handleSearchListings(req, res, pool) {
  const kind = req.query.kind;
  const mode = req.query.mode;
  const max_price = parseInt(req.query.max_price_cents || '999999999999');
  const params = [max_price];
  let conds = [`pl.visibility = 'public'`, `pl.status = 'active'`,
               `COALESCE(pl.price_cents, pl.rent_per_period_cents, 0) <= $1`];
  if (kind) { params.push(kind); conds.push(`p.kind = $${params.length}`); }
  if (mode) { params.push(mode); conds.push(`pl.mode = $${params.length}`); }

  const r = await pool.query(`
    SELECT pl.listing_id, pl.mode, pl.price_cents, pl.rent_per_period_cents, pl.rent_period,
           pl.available_from, p.property_id, p.kind, p.title, p.description, p.address,
           p.bedrooms, p.bathrooms, p.area_sqft, p.area_sqm, p.photos
    FROM property_listings pl
    JOIN properties p ON p.property_id = pl.property_id
    WHERE ${conds.join(' AND ')}
    ORDER BY pl.created_at DESC LIMIT 100
  `, params);
  return res.json({ listings: r.rows });
}

async function handleInquire(req, res, pool, verifyAgentAuth, auditChain) {
  const did = req.headers['x-agent-did'];
  if (!did) return res.status(401).json({ error: 'agent_did_required' });
  const auth = await verifyAgentAuth(req, did);
  if (!auth.valid) return res.status(401).json({ error: auth.error });

  const inq = z.object({
    listing_id: z.string(),
    message: z.string().max(2000),
    contact_email: z.string().email().optional()
  }).safeParse(req.body);
  if (!inq.success) return res.status(400).json({ error: 'invalid_request', details: inq.error.errors });

  const id = 'pinq_' + crypto.randomBytes(8).toString('hex');
  await pool.query(`
    INSERT INTO property_inquiries (inquiry_id, listing_id, inquirer_did, message, contact_email)
    VALUES ($1, $2, $3, $4, $5)
  `, [id, inq.data.listing_id, did, inq.data.message, inq.data.contact_email || null]);
  await pool.query(`UPDATE property_listings SET inquiries = inquiries + 1 WHERE listing_id = $1`, [inq.data.listing_id]);
  if (auditChain) {
    await auditChain.append({ event_type: 'property.inquiry', listing_id: inq.data.listing_id, inquirer_did: did });
  }
  return res.status(201).json({ inquiry_id: id });
}

function registerPropertyRoutes(app, pool, verifyAgentAuth, auditChain) {
  app.post('/v1/agents/:did/property',
    (req, res) => handleCreate(req, res, pool, verifyAgentAuth, auditChain));
  app.get('/v1/agents/:did/property',
    (req, res) => handleList(req, res, pool, verifyAgentAuth));
  app.post('/v1/property/:id/list',
    (req, res) => handleList_listing(req, res, pool, verifyAgentAuth, auditChain));
  app.get('/v1/property/listings',
    (req, res) => handleSearchListings(req, res, pool));
  app.post('/v1/property/inquiries',
    (req, res) => handleInquire(req, res, pool, verifyAgentAuth, auditChain));
}

module.exports = { migrate, registerPropertyRoutes, PROPERTY_TYPES };
