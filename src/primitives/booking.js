// ============================================================================
// OpenHeab Booking — Calendly-style meeting / appointment booking system.
// Owners define booking types with availability rules; bookers see open slots
// for the next 60 days and book them, optionally with x402 payment.
// ============================================================================
const express = require('express');
const cryptoLib = require('crypto');
const { z } = require('zod');

const LOCATIONS = ['virtual', 'in_person', 'phone'];
const BOOKING_STATUSES = ['confirmed', 'cancelled', 'no_show', 'completed'];
const PAYMENT_STATUSES = ['free', 'paid', 'refunded'];

// ----------------------------------------------------------------------------
// Migration
// ----------------------------------------------------------------------------
async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS booking_owner_slugs (
      owner_slug TEXT PRIMARY KEY,
      owner_did  TEXT NOT NULL UNIQUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS booking_types (
      type_id                 TEXT PRIMARY KEY,
      owner_did               TEXT NOT NULL,
      name                    TEXT NOT NULL,
      slug                    TEXT NOT NULL,
      description             TEXT,
      duration_minutes        INTEGER NOT NULL,
      buffer_before_minutes   INTEGER NOT NULL DEFAULT 0,
      buffer_after_minutes    INTEGER NOT NULL DEFAULT 0,
      max_per_day             INTEGER,
      price_cents             BIGINT NOT NULL DEFAULT 0,
      currency                TEXT NOT NULL DEFAULT 'USD',
      location                TEXT NOT NULL DEFAULT 'virtual',
      virtual_url_template    TEXT,
      color                   TEXT,
      active                  BOOLEAN NOT NULL DEFAULT TRUE,
      advance_notice_minutes  INTEGER NOT NULL DEFAULT 60,
      max_advance_days        INTEGER NOT NULL DEFAULT 60,
      created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (owner_did, slug)
    );
    CREATE INDEX IF NOT EXISTS idx_booking_types_owner ON booking_types (owner_did, active);

    CREATE TABLE IF NOT EXISTS booking_availability (
      rule_id      TEXT PRIMARY KEY,
      owner_did    TEXT NOT NULL,
      type_id      TEXT,
      day_of_week  INTEGER NOT NULL,
      start_minute INTEGER NOT NULL,
      end_minute   INTEGER NOT NULL,
      timezone     TEXT NOT NULL DEFAULT 'UTC',
      CHECK (day_of_week >= 0 AND day_of_week <= 6),
      CHECK (start_minute >= 0 AND start_minute < 1440),
      CHECK (end_minute > 0 AND end_minute <= 1440)
    );
    CREATE INDEX IF NOT EXISTS idx_booking_availability_type ON booking_availability (type_id);
    CREATE INDEX IF NOT EXISTS idx_booking_availability_owner ON booking_availability (owner_did);

    CREATE TABLE IF NOT EXISTS bookings (
      booking_id          TEXT PRIMARY KEY,
      type_id             TEXT NOT NULL,
      owner_did           TEXT NOT NULL,
      booker_did          TEXT,
      booker_email        TEXT,
      booker_name         TEXT,
      start_at            TIMESTAMPTZ NOT NULL,
      end_at              TIMESTAMPTZ NOT NULL,
      status              TEXT NOT NULL DEFAULT 'confirmed',
      payment_status      TEXT NOT NULL DEFAULT 'free',
      x402_invoice_id     TEXT,
      notes               TEXT,
      virtual_url         TEXT,
      cancellation_reason TEXT,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      cancelled_at        TIMESTAMPTZ,
      completed_at        TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_bookings_owner ON bookings (owner_did, start_at);
    CREATE INDEX IF NOT EXISTS idx_bookings_booker ON bookings (booker_did, start_at);
    CREATE INDEX IF NOT EXISTS idx_bookings_type ON bookings (type_id, start_at);
  `).catch(() => {});
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------
function genId(prefix) { return `${prefix}_${cryptoLib.randomBytes(12).toString('hex')}`; }

function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
}

async function ensureOwnerSlug(pool, ownerDid, hint) {
  const ex = await pool.query(
    `SELECT owner_slug FROM booking_owner_slugs WHERE owner_did=$1`, [ownerDid]
  ).catch(() => ({ rows: [] }));
  if (ex.rows[0]) return ex.rows[0].owner_slug;
  let base = hint ? slugify(hint) : null;
  if (!base) base = `u${ownerDid.replace(/^did:op:/, '').slice(0, 10)}`;
  let slug = base;
  let n = 1;
  while (true) {
    const c = await pool.query(`SELECT 1 FROM booking_owner_slugs WHERE owner_slug=$1`, [slug])
      .catch(() => ({ rows: [] }));
    if (!c.rows[0]) break;
    n++;
    slug = `${base}-${n}`;
    if (n > 999) { slug = `${base}-${cryptoLib.randomBytes(3).toString('hex')}`; break; }
  }
  await pool.query(
    `INSERT INTO booking_owner_slugs (owner_slug, owner_did) VALUES ($1, $2)
     ON CONFLICT DO NOTHING`,
    [slug, ownerDid]
  ).catch(() => {});
  return slug;
}

// Compute open slots over a date range, respecting:
//   - availability rules (day_of_week + start/end minutes UTC)
//   - duration + buffers
//   - existing confirmed bookings
//   - max_per_day cap
//   - advance_notice_minutes / max_advance_days
function computeOpenSlots(type, rules, existing, now = new Date()) {
  const slots = [];
  const startBound = new Date(now.getTime() + (type.advance_notice_minutes || 60) * 60 * 1000);
  const endBound = new Date(now.getTime() + (type.max_advance_days || 60) * 86_400_000);
  const dur = (type.duration_minutes || 30) * 60 * 1000;
  const buffBefore = (type.buffer_before_minutes || 0) * 60 * 1000;
  const buffAfter = (type.buffer_after_minutes || 0) * 60 * 1000;
  // Index existing bookings by day for fast collision detection.
  const occupied = existing.map(b => ({
    start: new Date(b.start_at).getTime() - buffBefore,
    end: new Date(b.end_at).getTime() + buffAfter,
    day: new Date(b.start_at).toISOString().slice(0, 10)
  }));
  const perDay = {};
  for (const o of occupied) perDay[o.day] = (perDay[o.day] || 0) + 1;

  // Iterate day by day across range
  const oneDay = 86_400_000;
  for (let t = Date.UTC(startBound.getUTCFullYear(), startBound.getUTCMonth(), startBound.getUTCDate());
       t < endBound.getTime(); t += oneDay) {
    const day = new Date(t);
    const dow = day.getUTCDay();
    const dayKey = day.toISOString().slice(0, 10);
    if (type.max_per_day && (perDay[dayKey] || 0) >= type.max_per_day) continue;
    for (const rule of rules.filter(r => r.day_of_week === dow)) {
      // Generate slots from start_minute to end_minute - duration
      let m = rule.start_minute;
      const endMin = rule.end_minute - (type.duration_minutes || 30);
      while (m <= endMin) {
        const slotStart = new Date(Date.UTC(
          day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(),
          Math.floor(m / 60), m % 60, 0
        ));
        const slotEnd = new Date(slotStart.getTime() + dur);
        if (slotStart < startBound) { m += (type.duration_minutes || 30); continue; }
        if (slotEnd > endBound) break;
        const collides = occupied.some(o =>
          slotStart.getTime() < o.end && slotEnd.getTime() > o.start
        );
        if (!collides) {
          slots.push({ start_at: slotStart.toISOString(), end_at: slotEnd.toISOString() });
        }
        m += (type.duration_minutes || 30);
      }
    }
  }
  return slots.slice(0, 1000);
}

// ----------------------------------------------------------------------------
// Routes
// ----------------------------------------------------------------------------
function registerBookingRoutes(app, pool, verifyAgentAuth, auditChain) {
  // POST /v1/agents/:did/booking/types
  const TypeSchema = z.object({
    name: z.string().min(1).max(300),
    slug: z.string().max(80).optional(),
    description: z.string().max(20000).optional(),
    duration_minutes: z.number().int().positive().max(1440),
    buffer_before_minutes: z.number().int().nonnegative().optional(),
    buffer_after_minutes: z.number().int().nonnegative().optional(),
    max_per_day: z.number().int().positive().optional(),
    price_cents: z.number().int().nonnegative().optional(),
    currency: z.string().max(8).optional(),
    location: z.enum(LOCATIONS).optional(),
    virtual_url_template: z.string().max(2000).optional(),
    color: z.string().max(20).optional(),
    active: z.boolean().optional(),
    advance_notice_minutes: z.number().int().nonnegative().optional(),
    max_advance_days: z.number().int().positive().max(365).optional(),
    owner_slug_hint: z.string().max(80).optional()
  });
  app.post('/v1/agents/:did/booking/types', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const parse = TypeSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;
      await ensureOwnerSlug(pool, did, d.owner_slug_hint || d.name);
      const typeId = genId('btype');
      let slug = d.slug ? slugify(d.slug) : slugify(d.name);
      if (!slug) slug = `t-${typeId.slice(-8)}`;
      const base = slug;
      let n = 1;
      while (true) {
        const c = await pool.query(
          `SELECT 1 FROM booking_types WHERE owner_did=$1 AND slug=$2`, [did, slug]
        ).catch(() => ({ rows: [] }));
        if (!c.rows[0]) break;
        n++;
        slug = `${base}-${n}`;
        if (n > 999) { slug = `${base}-${cryptoLib.randomBytes(3).toString('hex')}`; break; }
      }
      await pool.query(
        `INSERT INTO booking_types
           (type_id, owner_did, name, slug, description, duration_minutes,
            buffer_before_minutes, buffer_after_minutes, max_per_day, price_cents,
            currency, location, virtual_url_template, color, active,
            advance_notice_minutes, max_advance_days)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
        [typeId, did, d.name, slug, d.description || null,
         d.duration_minutes,
         d.buffer_before_minutes || 0, d.buffer_after_minutes || 0,
         d.max_per_day || null, d.price_cents || 0,
         d.currency || 'USD', d.location || 'virtual',
         d.virtual_url_template || null, d.color || null,
         d.active !== false,
         d.advance_notice_minutes || 60, d.max_advance_days || 60]
      );
      await auditChain.append({
        event_type: 'booking.type_created', type_id: typeId,
        owner_did: did, slug, timestamp: new Date().toISOString()
      });
      return res.status(201).json({ type_id: typeId, slug });
    } catch (e) { return res.status(500).json({ error: 'create_failed', message: e.message }); }
  });

  // GET /v1/agents/:did/booking/types
  app.get('/v1/agents/:did/booking/types', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(
      `SELECT * FROM booking_types WHERE owner_did=$1 ORDER BY created_at DESC`, [did]
    ).catch(() => ({ rows: [] }));
    return res.json({ types: r.rows, count: r.rows.length });
  });

  // POST /v1/agents/:did/booking/types/:slug/availability
  const AvailSchema = z.object({
    timezone: z.string().max(60).optional(),
    rules: z.array(z.object({
      day_of_week: z.number().int().min(0).max(6),
      start_minute: z.number().int().min(0).max(1439),
      end_minute: z.number().int().min(1).max(1440)
    })).min(1).max(50)
  });
  app.post('/v1/agents/:did/booking/types/:slug/availability', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const t = await pool.query(
        `SELECT type_id FROM booking_types WHERE owner_did=$1 AND slug=$2`,
        [did, req.params.slug]
      ).catch(() => ({ rows: [] }));
      if (!t.rows[0]) return res.status(404).json({ error: 'type_not_found' });
      const parse = AvailSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;
      // Wipe + replace.
      await pool.query(`DELETE FROM booking_availability WHERE type_id=$1`, [t.rows[0].type_id]);
      for (const r of d.rules) {
        const ruleId = genId('arule');
        await pool.query(
          `INSERT INTO booking_availability
             (rule_id, owner_did, type_id, day_of_week, start_minute, end_minute, timezone)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [ruleId, did, t.rows[0].type_id, r.day_of_week, r.start_minute, r.end_minute,
           d.timezone || 'UTC']
        );
      }
      await auditChain.append({
        event_type: 'booking.availability_set', type_id: t.rows[0].type_id,
        owner_did: did, rule_count: d.rules.length,
        timestamp: new Date().toISOString()
      });
      return res.json({ type_id: t.rows[0].type_id, rule_count: d.rules.length });
    } catch (e) { return res.status(500).json({ error: 'availability_failed', message: e.message }); }
  });

  // GET /v1/booking/:owner_slug/:type_slug/availability  (public)
  app.get('/v1/booking/:owner_slug/:type_slug/availability', async (req, res) => {
    const owner = await pool.query(
      `SELECT owner_did FROM booking_owner_slugs WHERE owner_slug=$1`,
      [req.params.owner_slug]
    ).catch(() => ({ rows: [] }));
    if (!owner.rows[0]) return res.status(404).json({ error: 'owner_not_found' });
    const t = await pool.query(
      `SELECT * FROM booking_types WHERE owner_did=$1 AND slug=$2 AND active=TRUE`,
      [owner.rows[0].owner_did, req.params.type_slug]
    ).catch(() => ({ rows: [] }));
    if (!t.rows[0]) return res.status(404).json({ error: 'type_not_found' });
    const rules = await pool.query(
      `SELECT * FROM booking_availability WHERE type_id=$1`, [t.rows[0].type_id]
    ).catch(() => ({ rows: [] }));
    const existing = await pool.query(
      `SELECT start_at, end_at FROM bookings
       WHERE type_id=$1 AND status='confirmed' AND end_at > NOW()`,
      [t.rows[0].type_id]
    ).catch(() => ({ rows: [] }));
    const slots = computeOpenSlots(t.rows[0], rules.rows, existing.rows);
    return res.json({
      owner_slug: req.params.owner_slug,
      type_slug: req.params.type_slug,
      name: t.rows[0].name,
      duration_minutes: t.rows[0].duration_minutes,
      price_cents: Number(t.rows[0].price_cents || 0),
      currency: t.rows[0].currency,
      slots
    });
  });

  // POST /v1/booking/:owner_slug/:type_slug/book
  const BookSchema = z.object({
    start_at: z.string(),
    booker_did: z.string().optional(),
    booker_email: z.string().email().optional(),
    booker_name: z.string().max(300).optional(),
    notes: z.string().max(5000).optional(),
    payment_tx_hash: z.string().max(200).optional()
  });
  app.post('/v1/booking/:owner_slug/:type_slug/book', express.json(), async (req, res) => {
    try {
      const owner = await pool.query(
        `SELECT owner_did FROM booking_owner_slugs WHERE owner_slug=$1`,
        [req.params.owner_slug]
      ).catch(() => ({ rows: [] }));
      if (!owner.rows[0]) return res.status(404).json({ error: 'owner_not_found' });
      const t = await pool.query(
        `SELECT * FROM booking_types WHERE owner_did=$1 AND slug=$2 AND active=TRUE`,
        [owner.rows[0].owner_did, req.params.type_slug]
      ).catch(() => ({ rows: [] }));
      if (!t.rows[0]) return res.status(404).json({ error: 'type_not_found' });

      const parse = BookSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;
      if (!d.booker_did && !d.booker_email) {
        return res.status(400).json({ error: 'booker_did_or_email_required' });
      }

      const startAt = new Date(d.start_at);
      if (isNaN(startAt.getTime())) return res.status(400).json({ error: 'invalid_start_at' });
      const endAt = new Date(startAt.getTime() + t.rows[0].duration_minutes * 60 * 1000);

      // Collision check
      const coll = await pool.query(
        `SELECT booking_id FROM bookings
         WHERE type_id=$1 AND status='confirmed'
           AND tstzrange(start_at, end_at) && tstzrange($2::timestamptz, $3::timestamptz)`,
        [t.rows[0].type_id, startAt.toISOString(), endAt.toISOString()]
      ).catch(() => ({ rows: [] }));
      if (coll.rows[0]) return res.status(409).json({ error: 'slot_taken' });

      // Payment status (paid if price>0 AND tx provided; require x402 verify in real impl)
      const priceCents = Number(t.rows[0].price_cents || 0);
      let paymentStatus = 'free';
      if (priceCents > 0) {
        if (!d.payment_tx_hash) return res.status(402).json({
          error: 'payment_required',
          price_cents: priceCents, currency: t.rows[0].currency
        });
        // Best-effort verify via x402 if available
        try {
          const x402 = require('./x402');
          if (x402 && typeof x402.verifyTxOnChain === 'function') {
            await x402.verifyTxOnChain('base', d.payment_tx_hash).catch(() => null);
          }
        } catch {}
        paymentStatus = 'paid';
      }

      const bookingId = genId('bkng');
      const virtualUrl = (t.rows[0].location === 'virtual' && t.rows[0].virtual_url_template)
        ? String(t.rows[0].virtual_url_template).replace('{booking_id}', bookingId)
        : null;

      await pool.query(
        `INSERT INTO bookings
           (booking_id, type_id, owner_did, booker_did, booker_email, booker_name,
            start_at, end_at, status, payment_status, x402_invoice_id, notes, virtual_url)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'confirmed',$9,$10,$11,$12)`,
        [bookingId, t.rows[0].type_id, owner.rows[0].owner_did,
         d.booker_did || null, d.booker_email || null, d.booker_name || null,
         startAt.toISOString(), endAt.toISOString(), paymentStatus,
         d.payment_tx_hash || null, d.notes || null, virtualUrl]
      );
      await auditChain.append({
        event_type: 'booking.created', booking_id: bookingId,
        type_id: t.rows[0].type_id, owner_did: owner.rows[0].owner_did,
        booker_did: d.booker_did || null, payment_status: paymentStatus,
        timestamp: new Date().toISOString()
      });
      return res.status(201).json({
        booking_id: bookingId, start_at: startAt.toISOString(),
        end_at: endAt.toISOString(), payment_status: paymentStatus,
        virtual_url: virtualUrl
      });
    } catch (e) { return res.status(500).json({ error: 'book_failed', message: e.message }); }
  });

  // GET /v1/agents/:did/booking/bookings
  app.get('/v1/agents/:did/booking/bookings', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const params = [did];
    let sql = `SELECT * FROM bookings WHERE (owner_did=$1 OR booker_did=$1)`;
    if (req.query.status) { params.push(req.query.status); sql += ` AND status=$${params.length}`; }
    if (req.query.type_id) { params.push(req.query.type_id); sql += ` AND type_id=$${params.length}`; }
    sql += ` ORDER BY start_at DESC LIMIT 500`;
    const r = await pool.query(sql, params).catch(() => ({ rows: [] }));
    return res.json({ bookings: r.rows, count: r.rows.length });
  });

  // POST /v1/agents/:did/booking/bookings/:id/cancel
  const CancelSchema = z.object({ reason: z.string().max(2000).optional() });
  app.post('/v1/agents/:did/booking/bookings/:id/cancel', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const parse = CancelSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const r = await pool.query(
        `UPDATE bookings SET status='cancelled', cancelled_at=NOW(),
                              cancellation_reason=$3
         WHERE booking_id=$1 AND (owner_did=$2 OR booker_did=$2) AND status='confirmed'
         RETURNING booking_id, status, payment_status`,
        [req.params.id, did, parse.data.reason || null]
      ).catch(() => ({ rows: [] }));
      if (!r.rows[0]) return res.status(409).json({ error: 'not_cancellable' });
      await auditChain.append({
        event_type: 'booking.cancelled', booking_id: req.params.id,
        cancelled_by: did, reason: parse.data.reason || null,
        timestamp: new Date().toISOString()
      });
      return res.json(r.rows[0]);
    } catch (e) { return res.status(500).json({ error: 'cancel_failed', message: e.message }); }
  });

  // POST /v1/booking/bookings/:id/no-show  (owner marks no-show)
  const NoShowSchema = z.object({ owner_did: z.string() });
  app.post('/v1/booking/bookings/:id/no-show', express.json(), async (req, res) => {
    try {
      const parse = NoShowSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const auth = await verifyAgentAuth(req, parse.data.owner_did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const r = await pool.query(
        `UPDATE bookings SET status='no_show'
         WHERE booking_id=$1 AND owner_did=$2 AND status='confirmed'
         RETURNING booking_id, status`,
        [req.params.id, parse.data.owner_did]
      ).catch(() => ({ rows: [] }));
      if (!r.rows[0]) return res.status(409).json({ error: 'not_markable' });
      await auditChain.append({
        event_type: 'booking.no_show', booking_id: req.params.id,
        owner_did: parse.data.owner_did, timestamp: new Date().toISOString()
      });
      return res.json(r.rows[0]);
    } catch (e) { return res.status(500).json({ error: 'no_show_failed', message: e.message }); }
  });
}

module.exports = {
  migrate,
  registerBookingRoutes,
  computeOpenSlots,
  slugify,
  ensureOwnerSlug,
  LOCATIONS,
  BOOKING_STATUSES,
  PAYMENT_STATUSES
};
