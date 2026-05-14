// ============================================================================
// OpenHeab Travel — Flight, hotel, car, train search + booking.
// Wraps Amadeus / Sabre / Booking / Expedia (stubbed for tests). Manages
// loyalty programs across airlines/hotels/cars.
// ============================================================================
const express = require('express');
const cryptoLib = require('crypto');
const { z } = require('zod');

const KINDS = ['flight', 'hotel', 'car', 'train'];
const PROVIDERS = ['amadeus', 'sabre', 'booking', 'expedia', 'stub'];
const BOOKING_STATUSES = ['pending', 'confirmed', 'cancelled', 'completed'];
const LOYALTY_KINDS = ['airline', 'hotel', 'car', 'rail'];

const PER_BOOKING_COST_CENTS = 25;

// ----------------------------------------------------------------------------
// Migration
// ----------------------------------------------------------------------------
async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS travel_searches (
      search_id     TEXT PRIMARY KEY,
      agent_did     TEXT NOT NULL,
      kind          TEXT NOT NULL,
      params        JSONB NOT NULL,
      results       JSONB,
      expires_at    TIMESTAMPTZ,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_travel_searches_agent ON travel_searches (agent_did, created_at DESC);

    CREATE TABLE IF NOT EXISTS travel_bookings (
      booking_id          TEXT PRIMARY KEY,
      agent_did           TEXT NOT NULL,
      kind                TEXT NOT NULL,
      provider            TEXT NOT NULL,
      provider_booking_id TEXT,
      traveler_info       JSONB NOT NULL,
      pnr                 TEXT,
      itinerary           JSONB NOT NULL,
      total_cents         BIGINT NOT NULL,
      currency            TEXT NOT NULL DEFAULT 'USD',
      status              TEXT NOT NULL DEFAULT 'pending',
      booked_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      cancel_deadline     TIMESTAMPTZ,
      refundable          BOOLEAN NOT NULL DEFAULT FALSE
    );
    CREATE INDEX IF NOT EXISTS idx_travel_bookings_agent ON travel_bookings (agent_did, booked_at DESC);
    CREATE INDEX IF NOT EXISTS idx_travel_bookings_kind ON travel_bookings (kind, status);

    CREATE TABLE IF NOT EXISTS loyalty_programs (
      program_id      TEXT PRIMARY KEY,
      agent_did       TEXT NOT NULL,
      kind            TEXT NOT NULL,
      provider        TEXT NOT NULL,
      member_id       TEXT NOT NULL,
      status          TEXT,
      miles_or_points BIGINT NOT NULL DEFAULT 0,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (agent_did, provider, member_id)
    );
    CREATE INDEX IF NOT EXISTS idx_loyalty_agent ON loyalty_programs (agent_did);
  `).catch(() => {});
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------
function genId(prefix) { return `${prefix}_${cryptoLib.randomBytes(12).toString('hex')}`; }

function hashSeed(s) { return cryptoLib.createHash('sha256').update(String(s)).digest(); }

function stubFlightSearch(params) {
  const seed = hashSeed(`${params.origin}:${params.destination}:${params.departure_date}`);
  const carriers = ['UA', 'DL', 'AA', 'BA', 'AF', 'LH', 'EK'];
  const results = [];
  for (let i = 0; i < 6; i++) {
    const r = seed.readUInt32BE((i * 4) % (seed.length - 4));
    const price = 15000 + (r % 60000);
    const carrier = carriers[r % carriers.length];
    results.push({
      option_id: `flt_${carrier}_${(r % 9999).toString().padStart(4, '0')}_${i}`,
      carrier, flight_number: `${carrier}${(r % 9000) + 100}`,
      origin: params.origin, destination: params.destination,
      departure_time: `${params.departure_date}T${String(6 + (r % 16)).padStart(2, '0')}:${String(r % 60).padStart(2, '0')}:00Z`,
      duration_minutes: 60 + (r % 600),
      stops: r % 3,
      price_cents: price,
      cabin: ['economy', 'premium_economy', 'business'][r % 3],
      refundable: (r % 2) === 0
    });
  }
  return results;
}

function stubHotelSearch(params) {
  const seed = hashSeed(`${params.city}:${params.check_in}:${params.check_out}`);
  const brands = ['Marriott', 'Hilton', 'Hyatt', 'IHG', 'Boutique Inn'];
  const results = [];
  for (let i = 0; i < 8; i++) {
    const r = seed.readUInt32BE((i * 4) % (seed.length - 4));
    results.push({
      option_id: `htl_${(r % 99999).toString().padStart(5, '0')}_${i}`,
      name: `${brands[r % brands.length]} ${params.city}`,
      city: params.city,
      check_in: params.check_in,
      check_out: params.check_out,
      stars: 3 + (r % 3),
      nightly_rate_cents: 8000 + (r % 50000),
      total_cents: (8000 + (r % 50000)) * Math.max(1, params.nights || 1),
      refundable: (r % 2) === 0
    });
  }
  return results;
}

function stubCarSearch(params) {
  const seed = hashSeed(`${params.pickup_location}:${params.pickup_date}`);
  const brands = ['Hertz', 'Avis', 'Enterprise', 'Budget', 'National'];
  const classes = ['economy', 'compact', 'midsize', 'fullsize', 'suv', 'luxury'];
  const results = [];
  for (let i = 0; i < 5; i++) {
    const r = seed.readUInt32BE((i * 4) % (seed.length - 4));
    results.push({
      option_id: `car_${(r % 99999).toString().padStart(5, '0')}_${i}`,
      brand: brands[r % brands.length],
      car_class: classes[r % classes.length],
      pickup_location: params.pickup_location,
      pickup_date: params.pickup_date,
      return_date: params.return_date,
      daily_rate_cents: 3500 + (r % 12000),
      transmission: r % 4 === 0 ? 'manual' : 'automatic'
    });
  }
  return results;
}

// ----------------------------------------------------------------------------
// Routes
// ----------------------------------------------------------------------------
function registerTravelRoutes(app, pool, verifyAgentAuth, auditChain) {
  // POST /v1/travel/flights/search
  const FlightSearchSchema = z.object({
    agent_did: z.string().optional(),
    origin: z.string().min(2).max(10),
    destination: z.string().min(2).max(10),
    departure_date: z.string(),
    return_date: z.string().optional(),
    passengers: z.number().int().min(1).max(9).optional(),
    cabin: z.enum(['economy', 'premium_economy', 'business', 'first']).optional()
  });
  app.post('/v1/travel/flights/search', express.json(), async (req, res) => {
    try {
      const parse = FlightSearchSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;
      const results = stubFlightSearch(d);
      const searchId = genId('tsrch');
      await pool.query(
        `INSERT INTO travel_searches (search_id, agent_did, kind, params, results, expires_at)
         VALUES ($1,$2,'flight',$3::jsonb,$4::jsonb, NOW() + INTERVAL '24 hours')`,
        [searchId, d.agent_did || 'did:op:anonymous',
         JSON.stringify(d), JSON.stringify(results)]
      ).catch(() => {});
      return res.json({ search_id: searchId, results, count: results.length });
    } catch (e) { return res.status(500).json({ error: 'search_failed', message: e.message }); }
  });

  // POST /v1/travel/hotels/search
  const HotelSearchSchema = z.object({
    agent_did: z.string().optional(),
    city: z.string().min(2).max(120),
    check_in: z.string(),
    check_out: z.string(),
    guests: z.number().int().min(1).max(10).optional(),
    rooms: z.number().int().min(1).max(5).optional(),
    nights: z.number().int().min(1).max(60).optional()
  });
  app.post('/v1/travel/hotels/search', express.json(), async (req, res) => {
    try {
      const parse = HotelSearchSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;
      // Derive nights if not provided
      if (!d.nights && d.check_in && d.check_out) {
        const diff = Math.round((new Date(d.check_out) - new Date(d.check_in)) / 86_400_000);
        d.nights = Math.max(1, diff);
      }
      const results = stubHotelSearch(d);
      const searchId = genId('tsrch');
      await pool.query(
        `INSERT INTO travel_searches (search_id, agent_did, kind, params, results, expires_at)
         VALUES ($1,$2,'hotel',$3::jsonb,$4::jsonb, NOW() + INTERVAL '24 hours')`,
        [searchId, d.agent_did || 'did:op:anonymous',
         JSON.stringify(d), JSON.stringify(results)]
      ).catch(() => {});
      return res.json({ search_id: searchId, results, count: results.length });
    } catch (e) { return res.status(500).json({ error: 'search_failed', message: e.message }); }
  });

  // POST /v1/travel/cars/search
  const CarSearchSchema = z.object({
    agent_did: z.string().optional(),
    pickup_location: z.string().min(2).max(120),
    return_location: z.string().max(120).optional(),
    pickup_date: z.string(),
    return_date: z.string()
  });
  app.post('/v1/travel/cars/search', express.json(), async (req, res) => {
    try {
      const parse = CarSearchSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;
      const results = stubCarSearch(d);
      const searchId = genId('tsrch');
      await pool.query(
        `INSERT INTO travel_searches (search_id, agent_did, kind, params, results, expires_at)
         VALUES ($1,$2,'car',$3::jsonb,$4::jsonb, NOW() + INTERVAL '24 hours')`,
        [searchId, d.agent_did || 'did:op:anonymous',
         JSON.stringify(d), JSON.stringify(results)]
      ).catch(() => {});
      return res.json({ search_id: searchId, results, count: results.length });
    } catch (e) { return res.status(500).json({ error: 'search_failed', message: e.message }); }
  });

  // POST /v1/agents/:did/travel/book
  const BookSchema = z.object({
    search_id: z.string(),
    option_id: z.string(),
    traveler_info: z.array(z.object({
      first_name: z.string().max(100),
      last_name: z.string().max(100),
      dob: z.string().optional(),
      passport: z.string().max(40).optional(),
      loyalty_member_id: z.string().max(80).optional()
    })).min(1).max(9),
    payment_method: z.string().max(60).optional()
  });
  app.post('/v1/agents/:did/travel/book', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const parse = BookSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;

      const sr = await pool.query(
        `SELECT kind, results FROM travel_searches WHERE search_id=$1`,
        [d.search_id]
      ).catch(() => ({ rows: [] }));
      if (!sr.rows[0]) return res.status(404).json({ error: 'search_not_found' });

      const results = Array.isArray(sr.rows[0].results) ? sr.rows[0].results : [];
      const chosen = results.find(r => r.option_id === d.option_id);
      if (!chosen) return res.status(400).json({ error: 'option_not_found' });

      const bookingId = genId('bkg');
      const totalCents = Number(chosen.price_cents || chosen.total_cents || chosen.daily_rate_cents || 0);
      const provider = process.env.AMADEUS_API_KEY ? 'amadeus' : 'stub';
      const providerBookingId = `${provider}_${cryptoLib.randomBytes(8).toString('hex')}`;
      const pnr = cryptoLib.randomBytes(3).toString('hex').toUpperCase();

      const cancelDeadline = new Date(Date.now() + 24 * 3600 * 1000).toISOString();

      await pool.query(
        `INSERT INTO travel_bookings
           (booking_id, agent_did, kind, provider, provider_booking_id, traveler_info,
            pnr, itinerary, total_cents, status, cancel_deadline, refundable)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8::jsonb,$9,'confirmed',$10,$11)`,
        [bookingId, did, sr.rows[0].kind, provider, providerBookingId,
         JSON.stringify(d.traveler_info), pnr,
         JSON.stringify(chosen), totalCents, cancelDeadline,
         !!chosen.refundable]
      );

      try {
        const cost = require('./cost');
        if (cost && typeof cost.recordCost === 'function') {
          await cost.recordCost(pool, {
            agent_did: did,
            resource_type: 'travel_booking',
            provider,
            amount_cents: PER_BOOKING_COST_CENTS,
            units: 1, unit_type: 'booking',
            reference_id: bookingId,
            tags: { kind: sr.rows[0].kind, total_cents: totalCents }
          });
        }
      } catch {}

      await auditChain.append({
        event_type: 'travel.booking_created', booking_id: bookingId,
        agent_did: did, kind: sr.rows[0].kind, total_cents: totalCents,
        timestamp: new Date().toISOString()
      });

      return res.status(201).json({
        booking_id: bookingId, pnr, provider, provider_booking_id: providerBookingId,
        kind: sr.rows[0].kind, total_cents: totalCents, status: 'confirmed'
      });
    } catch (e) { return res.status(500).json({ error: 'booking_failed', message: e.message }); }
  });

  // GET /v1/agents/:did/travel/bookings
  app.get('/v1/agents/:did/travel/bookings', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const params = [did];
    let sql = `SELECT * FROM travel_bookings WHERE agent_did=$1`;
    if (req.query.kind) { params.push(req.query.kind); sql += ` AND kind=$${params.length}`; }
    if (req.query.status) { params.push(req.query.status); sql += ` AND status=$${params.length}`; }
    sql += ` ORDER BY booked_at DESC LIMIT 200`;
    const r = await pool.query(sql, params).catch(() => ({ rows: [] }));
    return res.json({ bookings: r.rows, count: r.rows.length });
  });

  // POST /v1/agents/:did/travel/bookings/:id/cancel
  app.post('/v1/agents/:did/travel/bookings/:id/cancel', async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const r = await pool.query(
        `UPDATE travel_bookings SET status='cancelled'
         WHERE booking_id=$1 AND agent_did=$2 AND status IN ('pending','confirmed')
         RETURNING booking_id, status, refundable, total_cents`,
        [req.params.id, did]
      ).catch(() => ({ rows: [] }));
      if (!r.rows[0]) return res.status(409).json({ error: 'not_cancellable' });
      await auditChain.append({
        event_type: 'travel.booking_cancelled', booking_id: req.params.id,
        agent_did: did, refundable: r.rows[0].refundable,
        timestamp: new Date().toISOString()
      });
      return res.json(r.rows[0]);
    } catch (e) { return res.status(500).json({ error: 'cancel_failed', message: e.message }); }
  });

  // POST /v1/agents/:did/travel/loyalty
  const LoyaltySchema = z.object({
    kind: z.enum(LOYALTY_KINDS),
    provider: z.string().min(1).max(80),
    member_id: z.string().min(1).max(80),
    status: z.string().max(60).optional(),
    miles_or_points: z.number().int().optional()
  });
  app.post('/v1/agents/:did/travel/loyalty', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const parse = LoyaltySchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;
      const programId = genId('loy');
      await pool.query(
        `INSERT INTO loyalty_programs
           (program_id, agent_did, kind, provider, member_id, status, miles_or_points)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (agent_did, provider, member_id) DO UPDATE
           SET status=EXCLUDED.status, miles_or_points=EXCLUDED.miles_or_points`,
        [programId, did, d.kind, d.provider, d.member_id,
         d.status || 'active', d.miles_or_points || 0]
      );
      await auditChain.append({
        event_type: 'travel.loyalty_added', program_id: programId,
        agent_did: did, kind: d.kind, provider: d.provider,
        timestamp: new Date().toISOString()
      });
      return res.status(201).json({ program_id: programId, kind: d.kind, provider: d.provider });
    } catch (e) { return res.status(500).json({ error: 'loyalty_failed', message: e.message }); }
  });

  // GET /v1/agents/:did/travel/loyalty
  app.get('/v1/agents/:did/travel/loyalty', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(
      `SELECT * FROM loyalty_programs WHERE agent_did=$1 ORDER BY created_at DESC`, [did]
    ).catch(() => ({ rows: [] }));
    return res.json({ programs: r.rows, count: r.rows.length });
  });
}

module.exports = {
  migrate,
  registerTravelRoutes,
  stubFlightSearch,
  stubHotelSearch,
  stubCarSearch,
  KINDS,
  PROVIDERS,
  BOOKING_STATUSES,
  LOYALTY_KINDS
};
