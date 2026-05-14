// ============================================================================
// OpenHeab Licensing — Software/content licenses agents can buy and sell
// ============================================================================
const express = require('express');
const cryptoLib = require('crypto');
const { z } = require('zod');

const PRODUCT_KINDS = ['software', 'content', 'font', 'dataset', 'api_access', 'api_call'];
const LICENSE_STATUSES = ['active', 'expired', 'revoked'];
const USAGE_KINDS = ['api_call', 'feature_used', 'print'];

async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS license_products (
      product_id        TEXT PRIMARY KEY,
      owner_did         TEXT NOT NULL,
      name              TEXT NOT NULL,
      kind              TEXT NOT NULL DEFAULT 'software',
      sku               TEXT UNIQUE NOT NULL,
      license_terms     TEXT,
      allowed_uses      INTEGER,
      max_seats         INTEGER,
      base_price_cents  INTEGER NOT NULL DEFAULT 0,
      currency          TEXT NOT NULL DEFAULT 'USD',
      recurring         BOOLEAN NOT NULL DEFAULT FALSE,
      active            BOOLEAN NOT NULL DEFAULT TRUE,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_license_products_owner ON license_products (owner_did);
    CREATE INDEX IF NOT EXISTS idx_license_products_kind ON license_products (kind);

    CREATE TABLE IF NOT EXISTS licenses_issued (
      license_id              TEXT PRIMARY KEY,
      product_id              TEXT NOT NULL,
      licensor_did            TEXT NOT NULL,
      licensee_did            TEXT,
      licensee_email          TEXT,
      seats_purchased         INTEGER NOT NULL DEFAULT 1,
      current_seats           INTEGER NOT NULL DEFAULT 0,
      valid_from              DATE,
      valid_until             DATE,
      license_key             TEXT UNIQUE NOT NULL,
      status                  TEXT NOT NULL DEFAULT 'active',
      purchase_amount_cents   BIGINT NOT NULL DEFAULT 0,
      created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      revoked_at              TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_licenses_product ON licenses_issued (product_id);
    CREATE INDEX IF NOT EXISTS idx_licenses_licensor ON licenses_issued (licensor_did);
    CREATE INDEX IF NOT EXISTS idx_licenses_licensee ON licenses_issued (licensee_did);

    CREATE TABLE IF NOT EXISTS license_seat_activations (
      activation_id    TEXT PRIMARY KEY,
      license_id       TEXT NOT NULL,
      seat_identifier  TEXT NOT NULL,
      activated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_check_at    TIMESTAMPTZ,
      UNIQUE (license_id, seat_identifier)
    );
    CREATE INDEX IF NOT EXISTS idx_license_activations_license ON license_seat_activations (license_id);

    CREATE TABLE IF NOT EXISTS license_usage (
      usage_id      TEXT PRIMARY KEY,
      license_id    TEXT NOT NULL,
      kind          TEXT NOT NULL,
      quantity      INTEGER NOT NULL DEFAULT 1,
      occurred_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_license_usage_license ON license_usage (license_id);
  `).catch(() => {});
}

function genId(prefix) {
  return `${prefix}_${cryptoLib.randomBytes(12).toString('hex')}`;
}

function genLicenseKey() {
  // Format: AAAA-BBBB-CCCC-DDDD-EEEE
  const segs = [];
  for (let i = 0; i < 5; i++) segs.push(cryptoLib.randomBytes(2).toString('hex').toUpperCase());
  return segs.join('-');
}

function genSku() {
  return `SKU-${cryptoLib.randomBytes(6).toString('hex').toUpperCase()}`;
}

function registerLicensingRoutes(app, pool, verifyAgentAuth, auditChain) {
  // ---- Products ----
  const ProductSchema = z.object({
    name: z.string().min(1).max(300),
    kind: z.enum(PRODUCT_KINDS).optional(),
    sku: z.string().max(80).optional(),
    license_terms: z.string().max(50000).optional(),
    allowed_uses: z.number().int().min(1).optional(),
    max_seats: z.number().int().min(1).optional(),
    base_price_cents: z.number().int().min(0),
    currency: z.string().max(10).optional(),
    recurring: z.boolean().optional(),
    active: z.boolean().optional()
  });

  app.post('/v1/agents/:did/licensing/products', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const parse = ProductSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;
      const productId = genId('lprod');
      let sku = d.sku || genSku();
      // Ensure unique
      for (let attempt = 0; attempt < 5; attempt++) {
        const exists = await pool.query(`SELECT 1 FROM license_products WHERE sku=$1`, [sku]).catch(() => ({ rows: [] }));
        if (!exists.rows[0]) break;
        sku = genSku();
      }
      await pool.query(
        `INSERT INTO license_products (product_id, owner_did, name, kind, sku, license_terms,
           allowed_uses, max_seats, base_price_cents, currency, recurring, active)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [productId, did, d.name, d.kind || 'software', sku, d.license_terms || null,
         d.allowed_uses || null, d.max_seats || null, d.base_price_cents,
         d.currency || 'USD', d.recurring || false, d.active !== false]
      );
      await auditChain.append({
        event_type: 'licensing.product_created', product_id: productId, owner_did: did,
        sku, kind: d.kind || 'software', timestamp: new Date().toISOString()
      });
      return res.status(201).json({ product_id: productId, owner_did: did, sku, name: d.name });
    } catch (e) {
      console.error('[licensing.product.create]', e);
      return res.status(500).json({ error: 'create_failed', message: e.message });
    }
  });

  // ---- Public browse ----
  app.get('/v1/licensing/products', async (req, res) => {
    const kind = req.query.kind;
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    const params = [];
    let sql = `SELECT * FROM license_products WHERE active=TRUE`;
    if (kind) { params.push(kind); sql += ` AND kind=$${params.length}`; }
    params.push(limit);
    sql += ` ORDER BY created_at DESC LIMIT $${params.length}`;
    const r = await pool.query(sql, params).catch(() => ({ rows: [] }));
    return res.json({ products: r.rows, count: r.rows.length });
  });

  app.get('/v1/agents/:did/licensing/products', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(
      `SELECT * FROM license_products WHERE owner_did=$1 ORDER BY created_at DESC`, [did]
    ).catch(() => ({ rows: [] }));
    return res.json({ products: r.rows, count: r.rows.length });
  });

  // ---- Purchase ----
  const PurchaseSchema = z.object({
    licensee_did: z.string().optional(),
    licensee_email: z.string().email().optional(),
    seats: z.number().int().min(1).optional(),
    valid_days: z.number().int().min(1).optional(),
    payment_amount_cents: z.number().int().min(0).optional()
  });

  app.post('/v1/licensing/products/:id/purchase', express.json(), async (req, res) => {
    try {
      const parse = PurchaseSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;
      if (!d.licensee_did && !d.licensee_email) return res.status(400).json({ error: 'licensee_did_or_email_required' });
      const product = await pool.query(
        `SELECT * FROM license_products WHERE product_id=$1 AND active=TRUE`, [req.params.id]
      ).catch(() => ({ rows: [] }));
      if (!product.rows[0]) return res.status(404).json({ error: 'product_not_found_or_inactive' });
      const p = product.rows[0];
      const seats = d.seats || 1;
      if (p.max_seats && seats > p.max_seats) return res.status(400).json({ error: 'seats_exceeds_max', max_seats: p.max_seats });

      const licenseId = genId('lic');
      let licenseKey = genLicenseKey();
      for (let attempt = 0; attempt < 5; attempt++) {
        const exists = await pool.query(`SELECT 1 FROM licenses_issued WHERE license_key=$1`, [licenseKey]).catch(() => ({ rows: [] }));
        if (!exists.rows[0]) break;
        licenseKey = genLicenseKey();
      }
      const purchaseAmount = d.payment_amount_cents !== undefined ? d.payment_amount_cents : (p.base_price_cents * seats);
      const validFrom = new Date();
      let validUntil = null;
      if (d.valid_days) {
        validUntil = new Date(Date.now() + d.valid_days * 86400000);
      } else if (p.recurring) {
        validUntil = new Date(Date.now() + 365 * 86400000); // default 1 year for recurring
      }
      await pool.query(
        `INSERT INTO licenses_issued (license_id, product_id, licensor_did, licensee_did, licensee_email,
           seats_purchased, current_seats, valid_from, valid_until, license_key, status, purchase_amount_cents)
         VALUES ($1,$2,$3,$4,$5,$6,0,$7,$8,$9,'active',$10)`,
        [licenseId, p.product_id, p.owner_did, d.licensee_did || null, d.licensee_email || null,
         seats, validFrom.toISOString().slice(0, 10),
         validUntil ? validUntil.toISOString().slice(0, 10) : null,
         licenseKey, purchaseAmount]
      );
      await auditChain.append({
        event_type: 'licensing.license_issued', license_id: licenseId, license_key: licenseKey,
        product_id: p.product_id, licensor_did: p.owner_did,
        licensee_did: d.licensee_did || null, seats, amount_cents: purchaseAmount,
        timestamp: new Date().toISOString()
      });
      return res.status(201).json({
        license_id: licenseId,
        license_key: licenseKey,
        product_id: p.product_id,
        seats,
        valid_until: validUntil ? validUntil.toISOString().slice(0, 10) : null,
        purchase_amount_cents: purchaseAmount
      });
    } catch (e) {
      console.error('[licensing.purchase]', e);
      return res.status(500).json({ error: 'purchase_failed', message: e.message });
    }
  });

  // ---- Activate seat ----
  app.post('/v1/licensing/licenses/:key/activate', express.json(), async (req, res) => {
    try {
      const body = z.object({
        seat_identifier: z.string().min(1).max(200)
      }).safeParse(req.body || {});
      if (!body.success) return res.status(400).json({ error: 'invalid_input', details: body.error.issues });
      const lic = await pool.query(
        `SELECT * FROM licenses_issued WHERE license_key=$1`, [req.params.key]
      ).catch(() => ({ rows: [] }));
      if (!lic.rows[0]) return res.status(404).json({ error: 'license_not_found' });
      const l = lic.rows[0];
      if (l.status !== 'active') return res.status(409).json({ error: 'license_not_active', status: l.status });
      if (l.valid_until && new Date(l.valid_until) < new Date()) {
        await pool.query(`UPDATE licenses_issued SET status='expired' WHERE license_id=$1`, [l.license_id]).catch(() => {});
        return res.status(410).json({ error: 'license_expired' });
      }

      // Check if seat already exists
      const existing = await pool.query(
        `SELECT * FROM license_seat_activations WHERE license_id=$1 AND seat_identifier=$2`,
        [l.license_id, body.data.seat_identifier]
      ).catch(() => ({ rows: [] }));
      if (existing.rows[0]) {
        await pool.query(
          `UPDATE license_seat_activations SET last_check_at=NOW()
           WHERE license_id=$1 AND seat_identifier=$2`,
          [l.license_id, body.data.seat_identifier]
        ).catch(() => {});
        return res.json({ already_activated: true, license_key: req.params.key, seat: body.data.seat_identifier });
      }
      if (l.current_seats >= l.seats_purchased) {
        return res.status(409).json({ error: 'no_seats_available', current_seats: l.current_seats, seats_purchased: l.seats_purchased });
      }
      const activationId = genId('act');
      await pool.query(
        `INSERT INTO license_seat_activations (activation_id, license_id, seat_identifier, last_check_at)
         VALUES ($1,$2,$3,NOW())`,
        [activationId, l.license_id, body.data.seat_identifier]
      );
      await pool.query(`UPDATE licenses_issued SET current_seats = current_seats + 1 WHERE license_id=$1`, [l.license_id]).catch(() => {});
      await auditChain.append({
        event_type: 'licensing.seat_activated', license_id: l.license_id, activation_id: activationId,
        licensor_did: l.licensor_did, seat: body.data.seat_identifier, timestamp: new Date().toISOString()
      });
      return res.status(201).json({
        activation_id: activationId, license_key: req.params.key,
        seat: body.data.seat_identifier, current_seats: l.current_seats + 1
      });
    } catch (e) { return res.status(500).json({ error: 'activate_failed', message: e.message }); }
  });

  // ---- Check (validate) ----
  app.post('/v1/licensing/licenses/:key/check', express.json(), async (req, res) => {
    try {
      const body = z.object({
        seat_identifier: z.string().optional()
      }).safeParse(req.body || {});
      if (!body.success) return res.status(400).json({ error: 'invalid_input', details: body.error.issues });
      const lic = await pool.query(
        `SELECT * FROM licenses_issued WHERE license_key=$1`, [req.params.key]
      ).catch(() => ({ rows: [] }));
      if (!lic.rows[0]) return res.status(404).json({ valid: false, error: 'license_not_found' });
      const l = lic.rows[0];
      let valid = l.status === 'active';
      let reason = null;
      if (l.status !== 'active') reason = l.status;
      else if (l.valid_until && new Date(l.valid_until) < new Date()) {
        valid = false; reason = 'expired';
        await pool.query(`UPDATE licenses_issued SET status='expired' WHERE license_id=$1`, [l.license_id]).catch(() => {});
      }
      if (valid && body.data.seat_identifier) {
        const seat = await pool.query(
          `SELECT * FROM license_seat_activations WHERE license_id=$1 AND seat_identifier=$2`,
          [l.license_id, body.data.seat_identifier]
        ).catch(() => ({ rows: [] }));
        if (!seat.rows[0]) { valid = false; reason = 'seat_not_activated'; }
        else {
          await pool.query(
            `UPDATE license_seat_activations SET last_check_at=NOW()
             WHERE license_id=$1 AND seat_identifier=$2`,
            [l.license_id, body.data.seat_identifier]
          ).catch(() => {});
        }
      }
      return res.json({
        valid, reason, license_id: l.license_id, status: l.status,
        valid_until: l.valid_until, current_seats: l.current_seats, seats_purchased: l.seats_purchased
      });
    } catch (e) { return res.status(500).json({ error: 'check_failed', message: e.message }); }
  });

  // ---- Usage metering ----
  app.post('/v1/licensing/licenses/:key/usage', express.json(), async (req, res) => {
    try {
      const body = z.object({
        kind: z.enum(USAGE_KINDS),
        quantity: z.number().int().min(1).optional()
      }).safeParse(req.body || {});
      if (!body.success) return res.status(400).json({ error: 'invalid_input', details: body.error.issues });
      const lic = await pool.query(
        `SELECT * FROM licenses_issued WHERE license_key=$1`, [req.params.key]
      ).catch(() => ({ rows: [] }));
      if (!lic.rows[0]) return res.status(404).json({ error: 'license_not_found' });
      const l = lic.rows[0];
      if (l.status !== 'active') return res.status(409).json({ error: 'license_not_active' });

      const product = await pool.query(`SELECT allowed_uses FROM license_products WHERE product_id=$1`, [l.product_id]).catch(() => ({ rows: [] }));
      const allowedUses = product.rows[0]?.allowed_uses;
      const qty = body.data.quantity || 1;

      // Quota check
      if (allowedUses) {
        const total = await pool.query(
          `SELECT COALESCE(SUM(quantity),0)::int AS used FROM license_usage WHERE license_id=$1`,
          [l.license_id]
        ).catch(() => ({ rows: [{ used: 0 }] }));
        const used = parseInt(total.rows[0].used) || 0;
        if (used + qty > allowedUses) {
          return res.status(429).json({ error: 'quota_exceeded', used, allowed_uses: allowedUses });
        }
      }

      const usageId = genId('use');
      await pool.query(
        `INSERT INTO license_usage (usage_id, license_id, kind, quantity)
         VALUES ($1,$2,$3,$4)`,
        [usageId, l.license_id, body.data.kind, qty]
      );
      await auditChain.append({
        event_type: 'licensing.usage_recorded', usage_id: usageId, license_id: l.license_id,
        licensor_did: l.licensor_did, kind: body.data.kind, quantity: qty,
        timestamp: new Date().toISOString()
      });
      return res.status(201).json({ usage_id: usageId, license_id: l.license_id, kind: body.data.kind, quantity: qty });
    } catch (e) { return res.status(500).json({ error: 'usage_failed', message: e.message }); }
  });

  // ---- Revoke ----
  app.post('/v1/agents/:did/licensing/licenses/:id/revoke', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const r = await pool.query(
        `UPDATE licenses_issued SET status='revoked', revoked_at=NOW()
         WHERE license_id=$1 AND licensor_did=$2 AND status<>'revoked' RETURNING license_id, license_key`,
        [req.params.id, did]
      ).catch(() => ({ rows: [] }));
      if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
      await auditChain.append({
        event_type: 'licensing.license_revoked', license_id: req.params.id,
        licensor_did: did, timestamp: new Date().toISOString()
      });
      return res.json({ license_id: req.params.id, license_key: r.rows[0].license_key, status: 'revoked' });
    } catch (e) { return res.status(500).json({ error: 'revoke_failed', message: e.message }); }
  });

  // ---- List (issued or purchased) ----
  app.get('/v1/agents/:did/licensing/licenses', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const role = req.query.role || 'all'; // issued, purchased, all
    let sql, params;
    if (role === 'issued') {
      sql = `SELECT * FROM licenses_issued WHERE licensor_did=$1 ORDER BY created_at DESC LIMIT 500`;
      params = [did];
    } else if (role === 'purchased') {
      sql = `SELECT * FROM licenses_issued WHERE licensee_did=$1 ORDER BY created_at DESC LIMIT 500`;
      params = [did];
    } else {
      sql = `SELECT * FROM licenses_issued WHERE licensor_did=$1 OR licensee_did=$1 ORDER BY created_at DESC LIMIT 500`;
      params = [did];
    }
    const r = await pool.query(sql, params).catch(() => ({ rows: [] }));
    return res.json({ licenses: r.rows, count: r.rows.length });
  });
}

module.exports = {
  migrate,
  registerLicensingRoutes,
  PRODUCT_KINDS,
  LICENSE_STATUSES,
  USAGE_KINDS
};
