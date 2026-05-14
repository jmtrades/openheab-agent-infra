// ============================================================================
// OpenHeab Invoicing — Full invoicing system for agent-billed customers.
// Generates numbers, supports line items, tax, draft -> sent -> paid lifecycle,
// payments in USDC/card/bank, signed public view links.
// ============================================================================
const express = require('express');
const cryptoLib = require('crypto');
const { z } = require('zod');

const STATUSES = ['draft', 'sent', 'viewed', 'paid', 'overdue', 'cancelled'];
const METHODS = ['usdc', 'card', 'bank'];

async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS invoices (
      invoice_id        TEXT PRIMARY KEY,
      agent_did         TEXT NOT NULL,
      customer_did      TEXT,
      customer_email    TEXT,
      customer_name     TEXT,
      customer_address  JSONB,
      number            TEXT NOT NULL,
      currency          TEXT NOT NULL DEFAULT 'USD',
      subtotal_cents    BIGINT NOT NULL DEFAULT 0,
      tax_cents         BIGINT NOT NULL DEFAULT 0,
      total_cents       BIGINT NOT NULL DEFAULT 0,
      status            TEXT NOT NULL DEFAULT 'draft',
      issued_at         TIMESTAMPTZ,
      due_at            TIMESTAMPTZ,
      paid_at           TIMESTAMPTZ,
      payment_tx_hash   TEXT,
      payment_method    TEXT,
      notes             TEXT,
      terms             TEXT,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (agent_did, number)
    );
    CREATE INDEX IF NOT EXISTS idx_invoices_agent ON invoices (agent_did, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices (status);

    CREATE TABLE IF NOT EXISTS invoice_line_items (
      item_id            TEXT PRIMARY KEY,
      invoice_id         TEXT NOT NULL,
      sequence           INTEGER NOT NULL DEFAULT 0,
      description        TEXT NOT NULL,
      quantity           NUMERIC NOT NULL DEFAULT 1,
      unit_price_cents   BIGINT NOT NULL DEFAULT 0,
      amount_cents       BIGINT NOT NULL DEFAULT 0,
      tax_rate_bps       INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_invoice_line_items_invoice ON invoice_line_items (invoice_id);

    CREATE TABLE IF NOT EXISTS invoice_payments (
      payment_id    TEXT PRIMARY KEY,
      invoice_id    TEXT NOT NULL,
      amount_cents  BIGINT NOT NULL,
      method        TEXT NOT NULL,
      tx_hash       TEXT,
      paid_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_invoice_payments_invoice ON invoice_payments (invoice_id);
  `).catch(() => {});
}

function genId(prefix) {
  return `${prefix}_${cryptoLib.randomBytes(12).toString('hex')}`;
}

async function nextInvoiceNumber(pool, agentDid) {
  const r = await pool.query(
    `SELECT COUNT(*)::int AS n FROM invoices WHERE agent_did=$1`,
    [agentDid]
  ).catch(() => ({ rows: [{ n: 0 }] }));
  const yr = new Date().getFullYear();
  const seq = (parseInt(r.rows[0].n) + 1).toString().padStart(4, '0');
  return `INV-${yr}-${seq}`;
}

function signViewToken(invoiceId) {
  const secret = process.env.INVOICE_VIEW_SECRET || process.env.OPERATOR_ADMIN_TOKEN || 'dev-invoice-secret';
  return cryptoLib.createHmac('sha256', secret).update(invoiceId).digest('hex').slice(0, 32);
}

function registerInvoicingRoutes(app, pool, verifyAgentAuth, auditChain) {
  const LineItem = z.object({
    description: z.string().min(1).max(2000),
    quantity: z.number().positive().default(1),
    unit_price_cents: z.number().int().nonnegative(),
    tax_rate_bps: z.number().int().min(0).max(10000).optional()
  });

  const InvoiceSchema = z.object({
    customer_did: z.string().optional(),
    customer_email: z.string().email().optional(),
    customer_name: z.string().max(300).optional(),
    customer_address: z.record(z.any()).optional(),
    currency: z.string().length(3).optional(),
    due_at: z.string().optional(),
    notes: z.string().max(5000).optional(),
    terms: z.string().max(5000).optional(),
    line_items: z.array(LineItem).min(1)
  });

  // POST /v1/agents/:did/invoicing/invoices — create draft
  app.post('/v1/agents/:did/invoicing/invoices', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const parse = InvoiceSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;
      const invoiceId = genId('inv');
      const number = await nextInvoiceNumber(pool, did);

      let subtotal = 0n, tax = 0n;
      const items = d.line_items.map((li, i) => {
        const amt = BigInt(Math.round(li.quantity * li.unit_price_cents));
        subtotal += amt;
        const lineTax = (amt * BigInt(li.tax_rate_bps || 0)) / 10000n;
        tax += lineTax;
        return { ...li, idx: i, amount_cents: amt };
      });
      const total = subtotal + tax;

      await pool.query(
        `INSERT INTO invoices (invoice_id, agent_did, customer_did, customer_email, customer_name,
                               customer_address, number, currency, subtotal_cents, tax_cents, total_cents,
                               status, due_at, notes, terms)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,'draft',$12,$13,$14)`,
        [invoiceId, did, d.customer_did || null, d.customer_email || null, d.customer_name || null,
         d.customer_address ? JSON.stringify(d.customer_address) : null,
         number, d.currency || 'USD', subtotal.toString(), tax.toString(), total.toString(),
         d.due_at || null, d.notes || null, d.terms || null]
      );
      for (const it of items) {
        await pool.query(
          `INSERT INTO invoice_line_items (item_id, invoice_id, sequence, description, quantity,
                                            unit_price_cents, amount_cents, tax_rate_bps)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [genId('li'), invoiceId, it.idx, it.description, it.quantity,
           it.unit_price_cents, it.amount_cents.toString(), it.tax_rate_bps || 0]
        );
      }
      await auditChain.append({
        event_type: 'invoicing.created', invoice_id: invoiceId, agent_did: did,
        number, total_cents: total.toString(), timestamp: new Date().toISOString()
      });
      return res.status(201).json({
        invoice_id: invoiceId, number, status: 'draft',
        subtotal_cents: subtotal.toString(), tax_cents: tax.toString(), total_cents: total.toString()
      });
    } catch (e) { return res.status(500).json({ error: 'create_failed', message: e.message }); }
  });

  // POST /v1/agents/:did/invoicing/invoices/:id/send
  app.post('/v1/agents/:did/invoicing/invoices/:id/send', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const inv = await pool.query(
        `SELECT * FROM invoices WHERE invoice_id=$1 AND agent_did=$2`,
        [req.params.id, did]
      ).catch(() => ({ rows: [] }));
      if (!inv.rows[0]) return res.status(404).json({ error: 'not_found' });
      await pool.query(
        `UPDATE invoices SET status='sent', issued_at=COALESCE(issued_at, NOW()) WHERE invoice_id=$1`,
        [req.params.id]
      );
      const token = signViewToken(req.params.id);
      const baseUrl = process.env.OPERATOR_PUBLIC_URL || '';
      const viewUrl = `${baseUrl}/v1/invoicing/invoices/${req.params.id}?token=${token}`;
      // Best-effort email send via email primitive if present
      try {
        const email = require('./email');
        if (email && typeof email.deliverOutboundEmail === 'function' && inv.rows[0].customer_email) {
          await email.deliverOutboundEmail(pool, {
            from_did: did,
            to: inv.rows[0].customer_email,
            subject: `Invoice ${inv.rows[0].number}`,
            text: `Your invoice ${inv.rows[0].number} for ${inv.rows[0].total_cents} ${inv.rows[0].currency} cents. View: ${viewUrl}`
          });
        }
      } catch {}
      await auditChain.append({
        event_type: 'invoicing.sent', invoice_id: req.params.id, agent_did: did,
        to: inv.rows[0].customer_email || null, timestamp: new Date().toISOString()
      });
      return res.json({ invoice_id: req.params.id, status: 'sent', view_url: viewUrl });
    } catch (e) { return res.status(500).json({ error: 'send_failed', message: e.message }); }
  });

  // GET /v1/agents/:did/invoicing/invoices
  app.get('/v1/agents/:did/invoicing/invoices', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const params = [did];
    let sql = `SELECT * FROM invoices WHERE agent_did=$1`;
    if (req.query.status) { params.push(req.query.status); sql += ` AND status=$${params.length}`; }
    sql += ` ORDER BY created_at DESC LIMIT 500`;
    const r = await pool.query(sql, params).catch(() => ({ rows: [] }));
    return res.json({ invoices: r.rows, count: r.rows.length });
  });

  // GET /v1/invoicing/invoices/:id — public-ish customer view (gated by token)
  app.get('/v1/invoicing/invoices/:id', async (req, res) => {
    const token = req.query.token;
    if (!token || token !== signViewToken(req.params.id)) {
      return res.status(401).json({ error: 'invalid_or_missing_token' });
    }
    const inv = await pool.query(`SELECT * FROM invoices WHERE invoice_id=$1`, [req.params.id]).catch(() => ({ rows: [] }));
    if (!inv.rows[0]) return res.status(404).json({ error: 'not_found' });
    const items = await pool.query(
      `SELECT * FROM invoice_line_items WHERE invoice_id=$1 ORDER BY sequence ASC`, [req.params.id]
    ).catch(() => ({ rows: [] }));
    // Mark viewed (only if not yet)
    if (inv.rows[0].status === 'sent') {
      await pool.query(`UPDATE invoices SET status='viewed' WHERE invoice_id=$1`, [req.params.id]).catch(() => {});
    }
    return res.json({ invoice: inv.rows[0], line_items: items.rows });
  });

  // POST /v1/invoicing/invoices/:id/pay
  const PaySchema = z.object({
    token: z.string(),
    amount_cents: z.number().int().positive(),
    method: z.enum(METHODS),
    tx_hash: z.string().optional()
  });
  app.post('/v1/invoicing/invoices/:id/pay', express.json(), async (req, res) => {
    try {
      const parse = PaySchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;
      if (d.token !== signViewToken(req.params.id)) {
        return res.status(401).json({ error: 'invalid_token' });
      }
      const inv = await pool.query(`SELECT * FROM invoices WHERE invoice_id=$1`, [req.params.id]).catch(() => ({ rows: [] }));
      if (!inv.rows[0]) return res.status(404).json({ error: 'not_found' });
      if (inv.rows[0].status === 'cancelled') return res.status(400).json({ error: 'invoice_cancelled' });
      const paymentId = genId('pay');
      await pool.query(
        `INSERT INTO invoice_payments (payment_id, invoice_id, amount_cents, method, tx_hash)
         VALUES ($1,$2,$3,$4,$5)`,
        [paymentId, req.params.id, d.amount_cents, d.method, d.tx_hash || null]
      );
      // Total paid?
      const sumR = await pool.query(
        `SELECT COALESCE(SUM(amount_cents),0)::bigint AS s FROM invoice_payments WHERE invoice_id=$1`,
        [req.params.id]
      );
      const paidNow = BigInt(sumR.rows[0].s);
      const total = BigInt(inv.rows[0].total_cents);
      if (paidNow >= total) {
        await pool.query(
          `UPDATE invoices SET status='paid', paid_at=NOW(), payment_tx_hash=$2, payment_method=$3
           WHERE invoice_id=$1`,
          [req.params.id, d.tx_hash || null, d.method]
        );
      }
      await auditChain.append({
        event_type: 'invoicing.paid', invoice_id: req.params.id, payment_id: paymentId,
        amount_cents: d.amount_cents, method: d.method, timestamp: new Date().toISOString()
      });
      return res.status(201).json({ payment_id: paymentId, amount_cents: d.amount_cents,
                                   fully_paid: paidNow >= total });
    } catch (e) { return res.status(500).json({ error: 'pay_failed', message: e.message }); }
  });

  // POST /v1/agents/:did/invoicing/invoices/:id/cancel
  app.post('/v1/agents/:did/invoicing/invoices/:id/cancel', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const r = await pool.query(
        `UPDATE invoices SET status='cancelled' WHERE invoice_id=$1 AND agent_did=$2
         AND status NOT IN ('paid','cancelled') RETURNING invoice_id, status`,
        [req.params.id, did]
      ).catch(() => ({ rows: [] }));
      if (!r.rows[0]) return res.status(404).json({ error: 'not_found_or_finalized' });
      await auditChain.append({
        event_type: 'invoicing.cancelled', invoice_id: req.params.id, agent_did: did,
        timestamp: new Date().toISOString()
      });
      return res.json(r.rows[0]);
    } catch (e) { return res.status(500).json({ error: 'cancel_failed', message: e.message }); }
  });

  // GET /v1/agents/:did/invoicing/stats
  app.get('/v1/agents/:did/invoicing/stats', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(
      `SELECT
         COUNT(*)::int AS total,
         SUM(CASE WHEN status='paid' THEN total_cents ELSE 0 END)::bigint AS revenue_cents,
         SUM(CASE WHEN status IN ('sent','viewed') AND due_at < NOW() THEN total_cents ELSE 0 END)::bigint AS overdue_cents,
         COUNT(*) FILTER (WHERE status='paid') AS paid_count,
         COUNT(*) FILTER (WHERE status IN ('sent','viewed')) AS outstanding_count
       FROM invoices WHERE agent_did=$1`,
      [did]
    ).catch(() => ({ rows: [{}] }));
    return res.json({ agent_did: did, ...r.rows[0] });
  });
}

module.exports = { migrate, registerInvoicingRoutes, STATUSES, METHODS, nextInvoiceNumber, signViewToken };
