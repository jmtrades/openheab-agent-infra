// ============================================================================
// OpenHeab Maps — Geocoding, routing, location services
// Providers: mapbox / google / openstreetmap (free Nominatim/OSRM fallback)
// ============================================================================
const express = require('express');
const cryptoLib = require('crypto');
const { z } = require('zod');

const PROVIDERS = ['mapbox', 'google', 'openstreetmap'];
const MODES = ['driving', 'walking', 'bicycling', 'transit'];
const GEOCODE_COST_CENTS = parseInt(process.env.MAPS_GEOCODE_COST_CENTS || '1');
const ROUTE_COST_CENTS = parseInt(process.env.MAPS_ROUTE_COST_CENTS || '2');
const NOMINATIM_BASE = process.env.NOMINATIM_BASE || 'https://nominatim.openstreetmap.org';
const OSRM_BASE = process.env.OSRM_BASE || 'https://router.project-osrm.org';
const USER_AGENT = process.env.MAPS_USER_AGENT || 'openheab-maps/1.0';

// ----------------------------------------------------------------------------
// Migration
// ----------------------------------------------------------------------------
async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS maps_geocodes (
      geocode_id    TEXT PRIMARY KEY,
      agent_did     TEXT,
      query         TEXT NOT NULL,
      lat           DOUBLE PRECISION,
      lng           DOUBLE PRECISION,
      address       TEXT,
      country_code  TEXT,
      place_id      TEXT,
      provider      TEXT NOT NULL,
      cost_cents    INTEGER NOT NULL DEFAULT 0,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_maps_geocodes_agent ON maps_geocodes (agent_did, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_maps_geocodes_query ON maps_geocodes (query);

    CREATE TABLE IF NOT EXISTS maps_routes (
      route_id          TEXT PRIMARY KEY,
      agent_did         TEXT,
      origin            TEXT NOT NULL,
      destination       TEXT NOT NULL,
      mode              TEXT NOT NULL,
      distance_meters   BIGINT,
      duration_seconds  INTEGER,
      geometry          JSONB,
      provider          TEXT NOT NULL,
      cost_cents        INTEGER NOT NULL DEFAULT 0,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_maps_routes_agent ON maps_routes (agent_did, created_at DESC);

    CREATE TABLE IF NOT EXISTS maps_locations (
      location_id   TEXT PRIMARY KEY,
      agent_did     TEXT NOT NULL,
      name          TEXT NOT NULL,
      lat           DOUBLE PRECISION,
      lng           DOUBLE PRECISION,
      address       TEXT,
      tags          TEXT[] NOT NULL DEFAULT '{}',
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_maps_locations_agent ON maps_locations (agent_did, created_at DESC);
  `).catch(() => {});
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------
function genId(prefix) {
  return `${prefix}_${cryptoLib.randomBytes(12).toString('hex')}`;
}

function selectProvider(requested) {
  if (requested && PROVIDERS.includes(requested)) {
    if (requested === 'mapbox' && process.env.MAPBOX_API_KEY) return 'mapbox';
    if (requested === 'google' && process.env.GOOGLE_MAPS_API_KEY) return 'google';
    return requested === 'openstreetmap' ? 'openstreetmap' : 'openstreetmap';
  }
  if (process.env.MAPBOX_API_KEY) return 'mapbox';
  if (process.env.GOOGLE_MAPS_API_KEY) return 'google';
  return 'openstreetmap';
}

async function geocodeAddress(query, provider) {
  provider = selectProvider(provider);
  if (provider === 'mapbox' && process.env.MAPBOX_API_KEY) {
    const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(query)}.json?access_token=${process.env.MAPBOX_API_KEY}&limit=1`;
    const r = await fetch(url).then(x => x.json()).catch(() => null);
    const f = r?.features?.[0];
    if (f) {
      const [lng, lat] = f.center || [null, null];
      return {
        lat, lng, address: f.place_name,
        country_code: (f.context || []).find(c => c.id?.startsWith('country'))?.short_code || null,
        place_id: f.id, provider: 'mapbox'
      };
    }
  }
  if (provider === 'google' && process.env.GOOGLE_MAPS_API_KEY) {
    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(query)}&key=${process.env.GOOGLE_MAPS_API_KEY}`;
    const r = await fetch(url).then(x => x.json()).catch(() => null);
    const f = r?.results?.[0];
    if (f) {
      const country = f.address_components?.find(c => c.types?.includes('country'))?.short_name;
      return {
        lat: f.geometry.location.lat, lng: f.geometry.location.lng,
        address: f.formatted_address, country_code: country || null,
        place_id: f.place_id, provider: 'google'
      };
    }
  }
  // OSM Nominatim fallback
  const url = `${NOMINATIM_BASE}/search?q=${encodeURIComponent(query)}&format=json&limit=1&addressdetails=1`;
  const r = await fetch(url, { headers: { 'user-agent': USER_AGENT } })
    .then(x => x.json()).catch(() => null);
  const f = Array.isArray(r) ? r[0] : null;
  if (!f) return null;
  return {
    lat: parseFloat(f.lat), lng: parseFloat(f.lon),
    address: f.display_name,
    country_code: f.address?.country_code?.toUpperCase() || null,
    place_id: f.place_id?.toString() || null, provider: 'openstreetmap'
  };
}

async function reverseGeocode(lat, lng, provider) {
  provider = selectProvider(provider);
  if (provider === 'mapbox' && process.env.MAPBOX_API_KEY) {
    const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${lng},${lat}.json?access_token=${process.env.MAPBOX_API_KEY}`;
    const r = await fetch(url).then(x => x.json()).catch(() => null);
    const f = r?.features?.[0];
    if (f) return { lat, lng, address: f.place_name, place_id: f.id, provider: 'mapbox' };
  }
  if (provider === 'google' && process.env.GOOGLE_MAPS_API_KEY) {
    const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&key=${process.env.GOOGLE_MAPS_API_KEY}`;
    const r = await fetch(url).then(x => x.json()).catch(() => null);
    const f = r?.results?.[0];
    if (f) return { lat, lng, address: f.formatted_address, place_id: f.place_id, provider: 'google' };
  }
  const url = `${NOMINATIM_BASE}/reverse?lat=${lat}&lon=${lng}&format=json&addressdetails=1`;
  const r = await fetch(url, { headers: { 'user-agent': USER_AGENT } })
    .then(x => x.json()).catch(() => null);
  if (!r) return null;
  return {
    lat, lng, address: r.display_name || null,
    country_code: r.address?.country_code?.toUpperCase() || null,
    place_id: r.place_id?.toString() || null, provider: 'openstreetmap'
  };
}

async function routeBetween(origin, destination, mode, provider) {
  provider = selectProvider(provider);
  // For Mapbox/Google, addresses must be geocoded first
  let originPt = origin, destPt = destination;
  if (typeof origin === 'string') originPt = await geocodeAddress(origin, provider);
  if (typeof destination === 'string') destPt = await geocodeAddress(destination, provider);
  if (!originPt || !destPt) return null;

  if (provider === 'mapbox' && process.env.MAPBOX_API_KEY) {
    const profile = mode === 'walking' ? 'walking' : mode === 'bicycling' ? 'cycling' : 'driving';
    const url = `https://api.mapbox.com/directions/v5/mapbox/${profile}/${originPt.lng},${originPt.lat};${destPt.lng},${destPt.lat}?access_token=${process.env.MAPBOX_API_KEY}&geometries=geojson&overview=simplified`;
    const r = await fetch(url).then(x => x.json()).catch(() => null);
    const route = r?.routes?.[0];
    if (route) {
      return {
        distance_meters: Math.round(route.distance),
        duration_seconds: Math.round(route.duration),
        geometry: route.geometry, provider: 'mapbox'
      };
    }
  }
  if (provider === 'google' && process.env.GOOGLE_MAPS_API_KEY) {
    const url = `https://maps.googleapis.com/maps/api/directions/json?origin=${originPt.lat},${originPt.lng}&destination=${destPt.lat},${destPt.lng}&mode=${mode}&key=${process.env.GOOGLE_MAPS_API_KEY}`;
    const r = await fetch(url).then(x => x.json()).catch(() => null);
    const leg = r?.routes?.[0]?.legs?.[0];
    if (leg) {
      return {
        distance_meters: leg.distance?.value || 0,
        duration_seconds: leg.duration?.value || 0,
        geometry: { type: 'LineString', polyline: r.routes[0].overview_polyline?.points },
        provider: 'google'
      };
    }
  }
  // OSRM fallback
  const profile = mode === 'walking' ? 'foot' : mode === 'bicycling' ? 'bike' : 'driving';
  const url = `${OSRM_BASE}/route/v1/${profile}/${originPt.lng},${originPt.lat};${destPt.lng},${destPt.lat}?geometries=geojson&overview=simplified`;
  const r = await fetch(url, { headers: { 'user-agent': USER_AGENT } })
    .then(x => x.json()).catch(() => null);
  const route = r?.routes?.[0];
  if (!route) return null;
  return {
    distance_meters: Math.round(route.distance),
    duration_seconds: Math.round(route.duration),
    geometry: route.geometry, provider: 'openstreetmap'
  };
}

async function searchPlaces(q, lat, lng, radius, provider) {
  provider = selectProvider(provider);
  if (provider === 'google' && process.env.GOOGLE_MAPS_API_KEY) {
    const url = `https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${lat},${lng}&radius=${radius || 1000}&keyword=${encodeURIComponent(q || '')}&key=${process.env.GOOGLE_MAPS_API_KEY}`;
    const r = await fetch(url).then(x => x.json()).catch(() => null);
    return (r?.results || []).map(p => ({
      name: p.name, lat: p.geometry?.location?.lat, lng: p.geometry?.location?.lng,
      address: p.vicinity, place_id: p.place_id, types: p.types
    }));
  }
  // OSM Nominatim viewbox search
  const v = 0.05;
  const url = `${NOMINATIM_BASE}/search?q=${encodeURIComponent(q || '')}&format=json&limit=20&viewbox=${lng - v},${lat + v},${lng + v},${lat - v}&bounded=1`;
  const r = await fetch(url, { headers: { 'user-agent': USER_AGENT } })
    .then(x => x.json()).catch(() => []);
  return (Array.isArray(r) ? r : []).map(p => ({
    name: p.display_name?.split(',')[0],
    lat: parseFloat(p.lat), lng: parseFloat(p.lon),
    address: p.display_name, place_id: p.place_id?.toString(),
    types: [p.type]
  }));
}

async function tryRecordCost(pool, did, amount, kind) {
  if (!did) return;
  try {
    const cost = require('./cost');
    if (cost && typeof cost.recordCost === 'function') {
      await cost.recordCost(pool, {
        agent_did: did, resource_type: 'maps', provider: kind, amount_cents: amount
      });
    }
  } catch {}
}

// ----------------------------------------------------------------------------
// Routes
// ----------------------------------------------------------------------------
function registerMapsRoutes(app, pool, verifyAgentAuth, auditChain) {
  // POST /v1/maps/geocode
  const GeocodeSchema = z.object({
    address: z.string().min(1).max(2048),
    provider: z.enum(PROVIDERS).optional(),
    agent_did: z.string().optional()
  });
  app.post('/v1/maps/geocode', express.json(), async (req, res) => {
    try {
      const parse = GeocodeSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;
      const result = await geocodeAddress(d.address, d.provider);
      if (!result) return res.status(404).json({ error: 'no_results' });
      const geocodeId = genId('geo');
      await pool.query(
        `INSERT INTO maps_geocodes
         (geocode_id, agent_did, query, lat, lng, address, country_code, place_id, provider, cost_cents)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [geocodeId, d.agent_did || null, d.address, result.lat, result.lng,
         result.address, result.country_code, result.place_id, result.provider, GEOCODE_COST_CENTS]
      ).catch(() => {});
      await tryRecordCost(pool, d.agent_did, GEOCODE_COST_CENTS, 'geocode');
      return res.json({ geocode_id: geocodeId, ...result });
    } catch (e) {
      console.error('[maps.geocode]', e);
      return res.status(500).json({ error: 'geocode_failed', message: e.message });
    }
  });

  // POST /v1/maps/reverse-geocode
  const RevSchema = z.object({
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
    provider: z.enum(PROVIDERS).optional(),
    agent_did: z.string().optional()
  });
  app.post('/v1/maps/reverse-geocode', express.json(), async (req, res) => {
    try {
      const parse = RevSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;
      const result = await reverseGeocode(d.lat, d.lng, d.provider);
      if (!result) return res.status(404).json({ error: 'no_results' });
      const geocodeId = genId('geo');
      await pool.query(
        `INSERT INTO maps_geocodes
         (geocode_id, agent_did, query, lat, lng, address, country_code, place_id, provider, cost_cents)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [geocodeId, d.agent_did || null, `${d.lat},${d.lng}`, result.lat, result.lng,
         result.address, result.country_code, result.place_id, result.provider, GEOCODE_COST_CENTS]
      ).catch(() => {});
      await tryRecordCost(pool, d.agent_did, GEOCODE_COST_CENTS, 'reverse_geocode');
      return res.json({ geocode_id: geocodeId, ...result });
    } catch (e) {
      console.error('[maps.reverse_geocode]', e);
      return res.status(500).json({ error: 'reverse_geocode_failed', message: e.message });
    }
  });

  // POST /v1/maps/route
  const RouteSchema = z.object({
    origin: z.string().min(1),
    destination: z.string().min(1),
    mode: z.enum(MODES).default('driving'),
    provider: z.enum(PROVIDERS).optional(),
    agent_did: z.string().optional()
  });
  app.post('/v1/maps/route', express.json(), async (req, res) => {
    try {
      const parse = RouteSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;
      const route = await routeBetween(d.origin, d.destination, d.mode, d.provider);
      if (!route) return res.status(404).json({ error: 'no_route' });
      const routeId = genId('route');
      await pool.query(
        `INSERT INTO maps_routes
         (route_id, agent_did, origin, destination, mode, distance_meters, duration_seconds, geometry, provider, cost_cents)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10)`,
        [routeId, d.agent_did || null, d.origin, d.destination, d.mode,
         route.distance_meters, route.duration_seconds,
         JSON.stringify(route.geometry || null), route.provider, ROUTE_COST_CENTS]
      ).catch(() => {});
      await tryRecordCost(pool, d.agent_did, ROUTE_COST_CENTS, 'route');
      return res.json({ route_id: routeId, mode: d.mode, ...route });
    } catch (e) {
      console.error('[maps.route]', e);
      return res.status(500).json({ error: 'route_failed', message: e.message });
    }
  });

  // POST /v1/maps/places/search
  const PlaceSchema = z.object({
    q: z.string().max(512).optional(),
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
    radius: z.number().int().positive().max(50000).optional(),
    provider: z.enum(PROVIDERS).optional(),
    agent_did: z.string().optional()
  });
  app.post('/v1/maps/places/search', express.json(), async (req, res) => {
    try {
      const parse = PlaceSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;
      const results = await searchPlaces(d.q, d.lat, d.lng, d.radius, d.provider);
      await tryRecordCost(pool, d.agent_did, GEOCODE_COST_CENTS, 'places_search');
      return res.json({
        query: { q: d.q, lat: d.lat, lng: d.lng, radius: d.radius || 1000 },
        results, count: results.length
      });
    } catch (e) {
      console.error('[maps.places.search]', e);
      return res.status(500).json({ error: 'search_failed', message: e.message });
    }
  });

  // POST /v1/agents/:did/maps/locations
  const LocSchema = z.object({
    name: z.string().min(1).max(256),
    lat: z.number().min(-90).max(90).optional(),
    lng: z.number().min(-180).max(180).optional(),
    address: z.string().optional(),
    tags: z.array(z.string()).max(20).optional()
  });
  app.post('/v1/agents/:did/maps/locations', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const parse = LocSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;

      let { lat, lng, address } = d;
      if ((lat == null || lng == null) && address) {
        const g = await geocodeAddress(address);
        if (g) { lat = g.lat; lng = g.lng; address = g.address || address; }
      }
      const locationId = genId('loc');
      await pool.query(
        `INSERT INTO maps_locations (location_id, agent_did, name, lat, lng, address, tags)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [locationId, did, d.name, lat ?? null, lng ?? null, address ?? null, d.tags || []]
      );
      await auditChain.append({
        event_type: 'maps.location_saved',
        location_id: locationId, agent_did: did, name: d.name,
        timestamp: new Date().toISOString()
      });
      return res.status(201).json({
        location_id: locationId, agent_did: did, name: d.name, lat, lng, address, tags: d.tags || []
      });
    } catch (e) {
      console.error('[maps.location.create]', e);
      return res.status(500).json({ error: 'location_create_failed', message: e.message });
    }
  });

  // GET /v1/agents/:did/maps/locations
  app.get('/v1/agents/:did/maps/locations', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    const r = await pool.query(
      `SELECT location_id, name, lat, lng, address, tags, created_at
       FROM maps_locations WHERE agent_did = $1 ORDER BY created_at DESC LIMIT $2`,
      [did, limit]
    ).catch(() => ({ rows: [] }));
    return res.json({ locations: r.rows, count: r.rows.length });
  });
}

module.exports = {
  migrate,
  registerMapsRoutes,
  geocodeAddress,
  reverseGeocode,
  routeBetween,
  searchPlaces,
  PROVIDERS,
  MODES
};
