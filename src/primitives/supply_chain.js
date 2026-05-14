// ============================================================================
// OpenHeab Supply Chain — B2B procurement + supplier management
// ============================================================================
const express = require('express');
const cryptoLib = require('crypto');
const { z } = require('zod');

const SUPPLIER_STATUSES = ['active', 'suspended', 'blacklisted'];
const PO_STATUSES = ['drafted', 'sent', 'acknowledged', 'in_production', 'shipped', 'received', 'cancelled'];
const RECEIPT_CONDITIONS = ['good', 'damaged', 'short'];
const ISSUE_KINDS = ['defect', 'short', 'wrong_item', 'damaged'];
const ISSUE_RESOLUTIONS = ['refund', 'replace', 'credit'];
const RFQ_STATUSES = ['open', 'closed'];
const QUOTE_STATUSES = ['submitted', 'accepted', 'rejected'];

async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS suppliers (
      supplier_id     TEXT PRIMARY KEY,
      buyer_did       TEXT NOT NULL,
      name            TEXT NOT NULL,
      contact         JSONB DEFAULT '{}'::jsonb,
      categories      TEXT[] DEFAULT '{}',
      country         TEXT,
      rating          REAL,
      payment_terms   TEXT,
      lead_time_days  INTEGER,
      status          TEXT NOT NULL DEFAULT 'active',
      did_link        TEXT,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_suppliers_buyer ON suppliers (buyer_did);
    CREATE INDEX IF NOT EXISTS idx_suppliers_status ON suppliers (status);

    CREATE TABLE IF NOT EXISTS purchase_orders (
      po_id              TEXT PRIMARY KEY,
      buyer_did          TEXT NOT NULL,
      supplier_id        TEXT NOT NULL,
      po_number          TEXT UNIQUE NOT NULL,
      items              JSONB DEFAULT '[]'::jsonb,
      subtotal_cents     BIGINT NOT NULL DEFAULT 0,
      tax_cents          BIGINT NOT NULL DEFAULT 0,
      shipping_cents     BIGINT NOT NULL DEFAULT 0,
      total_cents        BIGINT NOT NULL DEFAULT 0,
      currency           TEXT NOT NULL DEFAULT 'USD',
      payment_terms      TEXT,
      expected_delivery  DATE,
      status             TEXT NOT NULL DEFAULT 'drafted',
      sent_at            TIMESTAMPTZ,
      received_at        TIMESTAMPTZ,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_purchase_orders_buyer ON purchase_orders (buyer_did);
    CREATE INDEX IF NOT EXISTS idx_purchase_orders_supplier ON purchase_orders (supplier_id);
    CREATE INDEX IF NOT EXISTS idx_purchase_orders_status ON purchase_orders (status);

    CREATE TABLE IF NOT EXISTS goods_receipts (
      receipt_id         TEXT PRIMARY KEY,
      po_id              TEXT NOT NULL,
      received_quantity  JSONB DEFAULT '{}'::jsonb,
      condition          TEXT NOT NULL DEFAULT 'good',
      signed_by_did      TEXT,
      received_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      photos             JSONB DEFAULT '[]'::jsonb
    );
    CREATE INDEX IF NOT EXISTS idx_goods_receipts_po ON goods_receipts (po_id);

    CREATE TABLE IF NOT EXISTS quality_issues (
      issue_id     TEXT PRIMARY KEY,
      po_id        TEXT NOT NULL,
      receipt_id   TEXT,
      kind         TEXT NOT NULL,
      quantity     INTEGER,
      description  TEXT,
      resolution   TEXT,
      resolved_at  TIMESTAMPTZ,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_quality_issues_po ON quality_issues (po_id);

    CREATE TABLE IF NOT EXISTS rfqs (
      rfq_id        TEXT PRIMARY KEY,
      buyer_did     TEXT NOT NULL,
      title         TEXT NOT NULL,
      specs         JSONB DEFAULT '{}'::jsonb,
      quantity      INTEGER,
      budget_cents  BIGINT,
      deadline      TIMESTAMPTZ,
      status        TEXT NOT NULL DEFAULT 'open',
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_rfqs_buyer ON rfqs (buyer_did);

    CREATE TABLE IF NOT EXISTS rfq_quotes (
      quote_id        TEXT PRIMARY KEY,
      rfq_id          TEXT NOT NULL,
      supplier_id     TEXT,
      supplier_did    TEXT,
      price_cents     BIGINT NOT NULL,
      lead_time_days  INTEGER,
      terms           TEXT,
      valid_until     TIMESTAMPTZ,
      status          TEXT NOT NULL DEFAULT 'submitted',
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_rfq_quotes_rfq ON rfq_quotes (rfq_id);
  `).catch(() => {});
}

function genId(prefix) {
  return `${prefix}_${cryptoLib.randomBytes(12).toString('hex')}`;
}

function genPoNumber() {
  return `PO-${Date.now()}-${cryptoLib.randomBytes(3).toString('hex').toUpperCase()}`;
}

function registerSupplyChainRoutes(app, pool, verifyAgentAuth, auditChain) {
  // ---- Suppliers ----
  const SupplierSchema = z.object({
    name: z.string().min(1).max(300),
    contact: z.record(z.any()).optional(),
    categories: z.array(z.string()).optional(),
    country: z.string().max(80).optional(),
    rating: z.number().min(0).max(5).optional(),
    payment_terms: z.string().max(200).optional(),
    lead_time_days: z.number().int().min(0).optional(),
    status: z.enum(SUPPLIER_STATUSES).optional(),
    did_link: z.string().max(300).optional()
  });

  app.post('/v1/agents/:did/supply/suppliers', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const parse = SupplierSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;
      const supplierId = genId('sup');
      await pool.query(
        `INSERT INTO suppliers (supplier_id, buyer_did, name, contact, categories, country,
           rating, payment_terms, lead_time_days, status, did_link)
         VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10,$11)`,
        [supplierId, did, d.name, JSON.stringify(d.contact || {}), d.categories || [],
         d.country || null, d.rating || null, d.payment_terms || null,
         d.lead_time_days || null, d.status || 'active', d.did_link || null]
      );
      await auditChain.append({
        event_type: 'supply.supplier_added', supplier_id: supplierId, buyer_did: did,
        timestamp: new Date().toISOString()
      });
      return res.status(201).json({ supplier_id: supplierId, buyer_did: did, name: d.name });
    } catch (e) { return res.status(500).json({ error: 'create_failed', message: e.message }); }
  });

  app.get('/v1/agents/:did/supply/suppliers', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const status = req.query.status;
    const category = req.query.category;
    const params = [did];
    let sql = `SELECT * FROM suppliers WHERE buyer_did=$1`;
    if (status) { params.push(status); sql += ` AND status=$${params.length}`; }
    if (category) { params.push(category); sql += ` AND $${params.length} = ANY(categories)`; }
    sql += ` ORDER BY created_at DESC LIMIT 500`;
    const r = await pool.query(sql, params).catch(() => ({ rows: [] }));
    return res.json({ suppliers: r.rows, count: r.rows.length });
  });

  // ---- Purchase orders ----
  const POSchema = z.object({
    supplier_id: z.string().min(1),
    items: z.array(z.record(z.any())).min(1),
    subtotal_cents: z.number().int().min(0).optional(),
    tax_cents: z.number().int().min(0).optional(),
    shipping_cents: z.number().int().min(0).optional(),
    total_cents: z.number().int().min(0).optional(),
    currency: z.string().max(10).optional(),
    payment_terms: z.string().max(200).optional(),
    expected_delivery: z.string().optional(),
    send: z.boolean().optional()
  });

  app.post('/v1/agents/:did/supply/pos', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const parse = POSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;
      const supplier = await pool.query(
        `SELECT supplier_id FROM suppliers WHERE supplier_id=$1 AND buyer_did=$2`,
        [d.supplier_id, did]
      ).catch(() => ({ rows: [] }));
      if (!supplier.rows[0]) return res.status(404).json({ error: 'supplier_not_found' });

      // Compute totals from items if not provided
      let subtotal = d.subtotal_cents || 0;
      if (!subtotal) {
        for (const it of d.items) {
          const qty = parseInt(it.quantity) || 0;
          const unit = parseInt(it.unit_price_cents) || 0;
          subtotal += qty * unit;
        }
      }
      const tax = d.tax_cents || 0;
      const shipping = d.shipping_cents || 0;
      const total = d.total_cents || (subtotal + tax + shipping);

      const poId = genId('po');
      const poNumber = genPoNumber();
      const status = d.send ? 'sent' : 'drafted';
      const sentAt = d.send ? new Date().toISOString() : null;
      await pool.query(
        `INSERT INTO purchase_orders (po_id, buyer_did, supplier_id, po_number, items,
           subtotal_cents, tax_cents, shipping_cents, total_cents, currency,
           payment_terms, expected_delivery, status, sent_at)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [poId, did, d.supplier_id, poNumber, JSON.stringify(d.items),
         subtotal, tax, shipping, total, d.currency || 'USD',
         d.payment_terms || null, d.expected_delivery || null, status, sentAt]
      );
      await auditChain.append({
        event_type: 'supply.po_created', po_id: poId, po_number: poNumber, buyer_did: did,
        supplier_id: d.supplier_id, total_cents: total, status, timestamp: new Date().toISOString()
      });
      return res.status(201).json({ po_id: poId, po_number: poNumber, total_cents: total, status });
    } catch (e) {
      console.error('[supply.po.create]', e);
      return res.status(500).json({ error: 'create_failed', message: e.message });
    }
  });

  app.get('/v1/agents/:did/supply/pos', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const status = req.query.status;
    const supplierId = req.query.supplier_id;
    const params = [did];
    let sql = `SELECT * FROM purchase_orders WHERE buyer_did=$1`;
    if (status) { params.push(status); sql += ` AND status=$${params.length}`; }
    if (supplierId) { params.push(supplierId); sql += ` AND supplier_id=$${params.length}`; }
    sql += ` ORDER BY created_at DESC LIMIT 500`;
    const r = await pool.query(sql, params).catch(() => ({ rows: [] }));
    return res.json({ purchase_orders: r.rows, count: r.rows.length });
  });

  // ---- Update PO status ----
  app.post('/v1/agents/:did/supply/pos/:id/status', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const body = z.object({ status: z.enum(PO_STATUSES) }).safeParse(req.body || {});
      if (!body.success) return res.status(400).json({ error: 'invalid_input', details: body.error.issues });
      const r = await pool.query(
        `UPDATE purchase_orders SET status=$1,
           sent_at=CASE WHEN $1='sent' AND sent_at IS NULL THEN NOW() ELSE sent_at END,
           received_at=CASE WHEN $1='received' THEN NOW() ELSE received_at END
         WHERE po_id=$2 AND buyer_did=$3 RETURNING po_id, status`,
        [body.data.status, req.params.id, did]
      ).catch(() => ({ rows: [] }));
      if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
      await auditChain.append({
        event_type: 'supply.po_status_changed', po_id: req.params.id, buyer_did: did,
        status: body.data.status, timestamp: new Date().toISOString()
      });
      return res.json({ po_id: req.params.id, status: r.rows[0].status });
    } catch (e) { return res.status(500).json({ error: 'status_failed', message: e.message }); }
  });

  // ---- Receive goods ----
  const ReceiveSchema = z.object({
    received_quantity: z.record(z.any()).optional(),
    condition: z.enum(RECEIPT_CONDITIONS).optional(),
    photos: z.array(z.any()).optional()
  });

  app.post('/v1/agents/:did/supply/pos/:id/receive', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const parse = ReceiveSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;
      const po = await pool.query(
        `SELECT po_id FROM purchase_orders WHERE po_id=$1 AND buyer_did=$2`,
        [req.params.id, did]
      ).catch(() => ({ rows: [] }));
      if (!po.rows[0]) return res.status(404).json({ error: 'po_not_found' });
      const receiptId = genId('rcpt');
      await pool.query(
        `INSERT INTO goods_receipts (receipt_id, po_id, received_quantity, condition, signed_by_did, photos)
         VALUES ($1,$2,$3::jsonb,$4,$5,$6::jsonb)`,
        [receiptId, req.params.id, JSON.stringify(d.received_quantity || {}),
         d.condition || 'good', did, JSON.stringify(d.photos || [])]
      );
      if ((d.condition || 'good') === 'good') {
        await pool.query(
          `UPDATE purchase_orders SET status='received', received_at=NOW() WHERE po_id=$1`,
          [req.params.id]
        ).catch(() => {});
      }
      await auditChain.append({
        event_type: 'supply.po_received', po_id: req.params.id, receipt_id: receiptId,
        buyer_did: did, condition: d.condition || 'good', timestamp: new Date().toISOString()
      });
      return res.status(201).json({ receipt_id: receiptId, po_id: req.params.id, condition: d.condition || 'good' });
    } catch (e) { return res.status(500).json({ error: 'receive_failed', message: e.message }); }
  });

  // ---- Raise quality issue ----
  const IssueSchema = z.object({
    receipt_id: z.string().optional(),
    kind: z.enum(ISSUE_KINDS),
    quantity: z.number().int().min(0).optional(),
    description: z.string().max(5000).optional(),
    resolution: z.enum(ISSUE_RESOLUTIONS).optional()
  });

  app.post('/v1/agents/:did/supply/pos/:id/issue', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const parse = IssueSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;
      const po = await pool.query(
        `SELECT po_id FROM purchase_orders WHERE po_id=$1 AND buyer_did=$2`,
        [req.params.id, did]
      ).catch(() => ({ rows: [] }));
      if (!po.rows[0]) return res.status(404).json({ error: 'po_not_found' });
      const issueId = genId('issue');
      await pool.query(
        `INSERT INTO quality_issues (issue_id, po_id, receipt_id, kind, quantity, description, resolution, resolved_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [issueId, req.params.id, d.receipt_id || null, d.kind, d.quantity || null,
         d.description || null, d.resolution || null, d.resolution ? new Date().toISOString() : null]
      );
      await auditChain.append({
        event_type: 'supply.quality_issue_raised', issue_id: issueId, po_id: req.params.id,
        buyer_did: did, kind: d.kind, timestamp: new Date().toISOString()
      });
      return res.status(201).json({ issue_id: issueId, po_id: req.params.id, kind: d.kind });
    } catch (e) { return res.status(500).json({ error: 'issue_failed', message: e.message }); }
  });

  // ---- RFQs ----
  const RfqSchema = z.object({
    title: z.string().min(1).max(300),
    specs: z.record(z.any()).optional(),
    quantity: z.number().int().min(1).optional(),
    budget_cents: z.number().int().min(0).optional(),
    deadline: z.string().optional()
  });

  app.post('/v1/agents/:did/supply/rfqs', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const parse = RfqSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;
      const rfqId = genId('rfq');
      await pool.query(
        `INSERT INTO rfqs (rfq_id, buyer_did, title, specs, quantity, budget_cents, deadline, status)
         VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,'open')`,
        [rfqId, did, d.title, JSON.stringify(d.specs || {}),
         d.quantity || null, d.budget_cents || null, d.deadline || null]
      );
      await auditChain.append({
        event_type: 'supply.rfq_created', rfq_id: rfqId, buyer_did: did, timestamp: new Date().toISOString()
      });
      return res.status(201).json({ rfq_id: rfqId, buyer_did: did, status: 'open' });
    } catch (e) { return res.status(500).json({ error: 'create_failed', message: e.message }); }
  });

  app.get('/v1/agents/:did/supply/rfqs', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(
      `SELECT * FROM rfqs WHERE buyer_did=$1 ORDER BY created_at DESC LIMIT 200`,
      [did]
    ).catch(() => ({ rows: [] }));
    return res.json({ rfqs: r.rows, count: r.rows.length });
  });

  app.get('/v1/supply/rfqs', async (req, res) => {
    const r = await pool.query(
      `SELECT * FROM rfqs WHERE status='open' AND (deadline IS NULL OR deadline > NOW())
       ORDER BY created_at DESC LIMIT 200`
    ).catch(() => ({ rows: [] }));
    return res.json({ rfqs: r.rows, count: r.rows.length });
  });

  // ---- Public: supplier submits quote ----
  const QuoteSchema = z.object({
    supplier_id: z.string().optional(),
    supplier_did: z.string().optional(),
    price_cents: z.number().int().min(0),
    lead_time_days: z.number().int().min(0).optional(),
    terms: z.string().max(2000).optional(),
    valid_until: z.string().optional()
  });

  app.post('/v1/supply/rfqs/:id/quote', express.json(), async (req, res) => {
    try {
      const parse = QuoteSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;
      if (!d.supplier_id && !d.supplier_did) return res.status(400).json({ error: 'supplier_id_or_did_required' });
      const rfq = await pool.query(`SELECT * FROM rfqs WHERE rfq_id=$1 AND status='open'`, [req.params.id]).catch(() => ({ rows: [] }));
      if (!rfq.rows[0]) return res.status(404).json({ error: 'rfq_not_found_or_closed' });
      if (rfq.rows[0].deadline && new Date(rfq.rows[0].deadline) < new Date()) {
        return res.status(410).json({ error: 'rfq_deadline_passed' });
      }
      const quoteId = genId('quote');
      await pool.query(
        `INSERT INTO rfq_quotes (quote_id, rfq_id, supplier_id, supplier_did, price_cents,
           lead_time_days, terms, valid_until, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'submitted')`,
        [quoteId, req.params.id, d.supplier_id || null, d.supplier_did || null,
         d.price_cents, d.lead_time_days || null, d.terms || null, d.valid_until || null]
      );
      await auditChain.append({
        event_type: 'supply.quote_submitted', quote_id: quoteId, rfq_id: req.params.id,
        buyer_did: rfq.rows[0].buyer_did, price_cents: d.price_cents,
        supplier_did: d.supplier_did || null, timestamp: new Date().toISOString()
      });
      return res.status(201).json({ quote_id: quoteId, rfq_id: req.params.id });
    } catch (e) { return res.status(500).json({ error: 'quote_failed', message: e.message }); }
  });

  app.get('/v1/agents/:did/supply/rfqs/:id/quotes', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(
      `SELECT q.* FROM rfq_quotes q
       JOIN rfqs rf ON rf.rfq_id = q.rfq_id
       WHERE q.rfq_id=$1 AND rf.buyer_did=$2
       ORDER BY q.price_cents ASC`,
      [req.params.id, did]
    ).catch(() => ({ rows: [] }));
    return res.json({ quotes: r.rows, count: r.rows.length });
  });

  // ---- Accept / reject quote ----
  app.post('/v1/agents/:did/supply/rfqs/:id/quotes/:qid/decision', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const body = z.object({ decision: z.enum(['accepted', 'rejected']) }).safeParse(req.body || {});
      if (!body.success) return res.status(400).json({ error: 'invalid_input', details: body.error.issues });
      // Verify rfq belongs to this agent
      const rfq = await pool.query(`SELECT * FROM rfqs WHERE rfq_id=$1 AND buyer_did=$2`, [req.params.id, did]).catch(() => ({ rows: [] }));
      if (!rfq.rows[0]) return res.status(404).json({ error: 'rfq_not_found' });
      const r = await pool.query(
        `UPDATE rfq_quotes SET status=$1 WHERE quote_id=$2 AND rfq_id=$3 RETURNING quote_id`,
        [body.data.decision, req.params.qid, req.params.id]
      ).catch(() => ({ rows: [] }));
      if (!r.rows[0]) return res.status(404).json({ error: 'quote_not_found' });
      if (body.data.decision === 'accepted') {
        // Reject all other quotes and close RFQ
        await pool.query(
          `UPDATE rfq_quotes SET status='rejected' WHERE rfq_id=$1 AND quote_id<>$2 AND status='submitted'`,
          [req.params.id, req.params.qid]
        ).catch(() => {});
        await pool.query(`UPDATE rfqs SET status='closed' WHERE rfq_id=$1`, [req.params.id]).catch(() => {});
      }
      await auditChain.append({
        event_type: 'supply.quote_decided', quote_id: req.params.qid, rfq_id: req.params.id,
        buyer_did: did, decision: body.data.decision, timestamp: new Date().toISOString()
      });
      return res.json({ quote_id: req.params.qid, status: body.data.decision });
    } catch (e) { return res.status(500).json({ error: 'decide_failed', message: e.message }); }
  });
}

module.exports = {
  migrate,
  registerSupplyChainRoutes,
  SUPPLIER_STATUSES,
  PO_STATUSES,
  RECEIPT_CONDITIONS,
  ISSUE_KINDS,
  ISSUE_RESOLUTIONS,
  RFQ_STATUSES,
  QUOTE_STATUSES
};
