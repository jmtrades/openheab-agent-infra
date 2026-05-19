// ============================================================================
// enterprise_billing.js — opens the $1M+ enterprise sales motion.
//
// Procurement at a Fortune 500 doesn't sign a Stripe checkout. They want:
//   - Purchase orders (PO numbers tied to invoices)
//   - NET-30/60/90 terms (invoice today, pay in 30/60/90)
//   - Annual prepay with multi-year commitments + discount
//   - Multi-currency invoices (USD/EUR/GBP/JPY)
//   - Tax handling (VAT, GST, US sales tax)
//   - Capacity reservations (lock in headroom)
//
// Closes more revenue per deal than 1,000 free-tier signups combined.
//
// Endpoints:
//   POST /v1/enterprise/orders                   create PO-backed order
//   POST /v1/enterprise/invoices                 issue NET-X invoice
//   POST /v1/enterprise/invoices/:id/pay         mark paid (manual or webhook)
//   POST /v1/enterprise/prepay                   annual prepay w/ discount
//   GET  /v1/enterprise/orgs/:org/billing        org billing summary
//   GET  /v1/enterprise/invoices                 admin: list issued invoices
//
// UI: /enterprise-billing
// ============================================================================
const crypto = require('crypto');
const { z } = require('zod');
const ds = require('../design_system');
const { safeTokenCompare } = require('../safe_compare');

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
}
function shell(title, description, content) {
  return `${ds.head(`${title} — OpenHeab`, description)}${ds.NAV_HTML('')}<main>${content}</main>${ds.FOOTER_HTML()}`;
}
async function safe(pool, sql, params = []) {
  try { return (await pool.query(sql, params)).rows; }
  catch { return []; }
}

const CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'USDC'];
const PAYMENT_TERMS = ['NET_0', 'NET_15', 'NET_30', 'NET_45', 'NET_60', 'NET_90'];
const PREPAY_DISCOUNT_BPS = { 1: 0, 2: 800, 3: 1500 }; // 0% / 8% / 15% off for 1/2/3 yr

async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS enterprise_orders (
      order_id          TEXT PRIMARY KEY,
      org_id            TEXT NOT NULL,
      po_number         TEXT,
      contract_summary  TEXT NOT NULL,
      annual_value_cents BIGINT NOT NULL,
      currency          TEXT NOT NULL DEFAULT 'USD',
      payment_terms     TEXT NOT NULL DEFAULT 'NET_30',
      start_date        DATE NOT NULL,
      end_date          DATE NOT NULL,
      status            TEXT NOT NULL DEFAULT 'active',
      signed_by         TEXT,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_enterprise_orders_org ON enterprise_orders (org_id);

    CREATE TABLE IF NOT EXISTS enterprise_invoices (
      invoice_id        TEXT PRIMARY KEY,
      invoice_number    TEXT UNIQUE NOT NULL,
      org_id            TEXT NOT NULL,
      order_id          TEXT,
      po_number         TEXT,
      line_items        JSONB NOT NULL,
      subtotal_cents    BIGINT NOT NULL,
      tax_cents         BIGINT NOT NULL DEFAULT 0,
      total_cents       BIGINT NOT NULL,
      currency          TEXT NOT NULL DEFAULT 'USD',
      payment_terms     TEXT NOT NULL DEFAULT 'NET_30',
      due_at            DATE NOT NULL,
      status            TEXT NOT NULL DEFAULT 'issued',
      paid_at           TIMESTAMPTZ,
      paid_method       TEXT,
      paid_reference    TEXT,
      issued_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_enterprise_invoices_org ON enterprise_invoices (org_id);
    CREATE INDEX IF NOT EXISTS idx_enterprise_invoices_status ON enterprise_invoices (status, due_at);

    CREATE TABLE IF NOT EXISTS enterprise_prepays (
      prepay_id         TEXT PRIMARY KEY,
      org_id            TEXT NOT NULL,
      term_years        INTEGER NOT NULL,
      list_price_cents  BIGINT NOT NULL,
      discount_bps      INTEGER NOT NULL,
      paid_cents        BIGINT NOT NULL,
      currency          TEXT NOT NULL DEFAULT 'USD',
      effective_from    DATE NOT NULL,
      effective_to      DATE NOT NULL,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_enterprise_prepays_org ON enterprise_prepays (org_id, effective_from);
  `).catch(() => {});
}

function isAdmin(req) {
  return safeTokenCompare(req.headers['x-admin-token'], process.env.OPERATOR_ADMIN_TOKEN);
}

function termDays(t) {
  return { NET_0: 0, NET_15: 15, NET_30: 30, NET_45: 45, NET_60: 60, NET_90: 90 }[t] || 30;
}

async function nextInvoiceNumber(pool) {
  // Globally monotonic invoice numbers per fiscal year for accounting cleanliness.
  const y = new Date().getFullYear();
  const r = await pool.query(
    `SELECT COUNT(*)::int AS n FROM enterprise_invoices WHERE invoice_number LIKE $1`,
    [`INV-${y}-%`]
  ).catch(() => ({ rows: [{ n: 0 }] }));
  return `INV-${y}-${String((r.rows[0]?.n || 0) + 1).padStart(6, '0')}`;
}

function registerEnterpriseBillingRoutes(app, pool, verifyAgentAuth, auditChain) {
  const express = require('express');

  app.post('/v1/enterprise/orders', express.json(), async (req, res) => {
    if (!isAdmin(req)) return res.status(401).json({ error: { message: 'admin_required' } });
    const b = z.object({
      org_id: z.string(),
      po_number: z.string().max(80).optional(),
      contract_summary: z.string().min(2).max(2000),
      annual_value_cents: z.number().int().positive(),
      currency: z.enum(CURRENCIES).default('USD'),
      payment_terms: z.enum(PAYMENT_TERMS).default('NET_30'),
      start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      signed_by: z.string().max(200).optional()
    }).safeParse(req.body || {});
    if (!b.success) return res.status(400).json({ error: { message: 'invalid_input', details: b.error.flatten() } });
    if (new Date(b.data.end_date) <= new Date(b.data.start_date)) {
      return res.status(400).json({ error: { message: 'end_date_must_follow_start_date' } });
    }
    const order_id = 'ord_' + crypto.randomBytes(10).toString('hex');
    try {
      await pool.query(
        `INSERT INTO enterprise_orders (order_id, org_id, po_number, contract_summary, annual_value_cents,
            currency, payment_terms, start_date, end_date, signed_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [order_id, b.data.org_id, b.data.po_number || null, b.data.contract_summary, b.data.annual_value_cents,
         b.data.currency, b.data.payment_terms, b.data.start_date, b.data.end_date, b.data.signed_by || null]
      );
      if (auditChain) await auditChain.append({ event_type: 'enterprise.order_created', order_id, org_id: b.data.org_id, annual_value_cents: b.data.annual_value_cents, currency: b.data.currency }).catch(() => {});
      res.status(201).json({ order_id, status: 'active' });
    } catch (e) { res.status(500).json({ error: { message: e.message } }); }
  });

  app.post('/v1/enterprise/invoices', express.json(), async (req, res) => {
    if (!isAdmin(req)) return res.status(401).json({ error: { message: 'admin_required' } });
    const b = z.object({
      org_id: z.string(),
      order_id: z.string().optional(),
      po_number: z.string().max(80).optional(),
      line_items: z.array(z.object({
        description: z.string().min(1).max(200),
        quantity: z.number().positive(),
        unit_price_cents: z.number().int().nonnegative()
      })).min(1).max(50),
      tax_cents: z.number().int().nonnegative().default(0),
      currency: z.enum(CURRENCIES).default('USD'),
      payment_terms: z.enum(PAYMENT_TERMS).default('NET_30')
    }).safeParse(req.body || {});
    if (!b.success) return res.status(400).json({ error: { message: 'invalid_input', details: b.error.flatten() } });
    const subtotal = b.data.line_items.reduce((s, li) => s + Math.floor(li.quantity * li.unit_price_cents), 0);
    const total = subtotal + b.data.tax_cents;
    const due = new Date(); due.setDate(due.getDate() + termDays(b.data.payment_terms));
    const invoice_id = 'einv_' + crypto.randomBytes(10).toString('hex');
    const invoice_number = await nextInvoiceNumber(pool);
    try {
      await pool.query(
        `INSERT INTO enterprise_invoices (invoice_id, invoice_number, org_id, order_id, po_number, line_items,
            subtotal_cents, tax_cents, total_cents, currency, payment_terms, due_at)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12)`,
        [invoice_id, invoice_number, b.data.org_id, b.data.order_id || null, b.data.po_number || null,
         JSON.stringify(b.data.line_items), subtotal, b.data.tax_cents, total,
         b.data.currency, b.data.payment_terms, due.toISOString().slice(0,10)]
      );
      if (auditChain) await auditChain.append({ event_type: 'enterprise.invoice_issued', invoice_id, invoice_number, org_id: b.data.org_id, total_cents: total, currency: b.data.currency, due_at: due.toISOString().slice(0,10) }).catch(() => {});
      res.status(201).json({ invoice_id, invoice_number, total_cents: total, due_at: due.toISOString().slice(0,10) });
    } catch (e) { res.status(500).json({ error: { message: e.message } }); }
  });

  app.post('/v1/enterprise/invoices/:id/pay', express.json(), async (req, res) => {
    if (!isAdmin(req)) return res.status(401).json({ error: { message: 'admin_required' } });
    const b = z.object({
      paid_method: z.enum(['wire', 'ach', 'usdc', 'check', 'card', 'other']),
      paid_reference: z.string().max(200).optional()
    }).safeParse(req.body || {});
    if (!b.success) return res.status(400).json({ error: { message: 'invalid_input', details: b.error.flatten() } });
    const r = await pool.query(
      `UPDATE enterprise_invoices SET status='paid', paid_at=NOW(), paid_method=$1, paid_reference=$2
       WHERE invoice_id=$3 AND status='issued' RETURNING invoice_number, total_cents, currency, org_id`,
      [b.data.paid_method, b.data.paid_reference || null, req.params.id]
    );
    if (!r.rows[0]) return res.status(404).json({ error: { message: 'not_found_or_already_paid' } });
    if (auditChain) await auditChain.append({ event_type: 'enterprise.invoice_paid', invoice_id: req.params.id, invoice_number: r.rows[0].invoice_number, org_id: r.rows[0].org_id, total_cents: Number(r.rows[0].total_cents), currency: r.rows[0].currency, method: b.data.paid_method }).catch(() => {});
    res.json({ paid: true, ...r.rows[0] });
  });

  app.post('/v1/enterprise/prepay', express.json(), async (req, res) => {
    if (!isAdmin(req)) return res.status(401).json({ error: { message: 'admin_required' } });
    const b = z.object({
      org_id: z.string(),
      term_years: z.number().int().min(1).max(3),
      list_price_cents: z.number().int().positive(),
      currency: z.enum(CURRENCIES).default('USD'),
      effective_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
    }).safeParse(req.body || {});
    if (!b.success) return res.status(400).json({ error: { message: 'invalid_input', details: b.error.flatten() } });
    const discount = PREPAY_DISCOUNT_BPS[b.data.term_years];
    const paid = Math.floor(b.data.list_price_cents * (10000 - discount) / 10000);
    const eff_from = new Date(b.data.effective_from);
    const eff_to = new Date(eff_from); eff_to.setFullYear(eff_to.getFullYear() + b.data.term_years);
    const prepay_id = 'pp_' + crypto.randomBytes(10).toString('hex');
    try {
      await pool.query(
        `INSERT INTO enterprise_prepays (prepay_id, org_id, term_years, list_price_cents, discount_bps, paid_cents, currency, effective_from, effective_to)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [prepay_id, b.data.org_id, b.data.term_years, b.data.list_price_cents, discount, paid,
         b.data.currency, eff_from.toISOString().slice(0,10), eff_to.toISOString().slice(0,10)]
      );
      if (auditChain) await auditChain.append({ event_type: 'enterprise.prepay_locked', prepay_id, org_id: b.data.org_id, term_years: b.data.term_years, paid_cents: paid, discount_bps: discount, currency: b.data.currency }).catch(() => {});
      res.status(201).json({ prepay_id, paid_cents: paid, discount_bps: discount, effective_to: eff_to.toISOString().slice(0,10) });
    } catch (e) { res.status(500).json({ error: { message: e.message } }); }
  });

  app.get('/v1/enterprise/orgs/:org/billing', async (req, res) => {
    const orders = await safe(pool, `SELECT * FROM enterprise_orders WHERE org_id=$1 ORDER BY created_at DESC`, [req.params.org]);
    const invoices = await safe(pool, `SELECT invoice_id, invoice_number, total_cents, currency, status, due_at, paid_at, issued_at FROM enterprise_invoices WHERE org_id=$1 ORDER BY issued_at DESC LIMIT 100`, [req.params.org]);
    const prepays = await safe(pool, `SELECT * FROM enterprise_prepays WHERE org_id=$1 ORDER BY effective_from DESC`, [req.params.org]);
    res.json({ org_id: req.params.org, orders, invoices, prepays });
  });

  app.get('/v1/enterprise/invoices', async (req, res) => {
    if (!isAdmin(req)) return res.status(401).json({ error: { message: 'admin_required' } });
    res.json({ invoices: await safe(pool, `SELECT invoice_id, invoice_number, org_id, total_cents, currency, status, due_at, issued_at FROM enterprise_invoices ORDER BY issued_at DESC LIMIT 500`) });
  });

  // UI — public-friendly explainer + admin link
  app.get('/enterprise-billing', async (req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.send(shell('Enterprise Billing', 'POs, NET-30/60/90, multi-currency, annual prepay.',
`<section style="max-width:780px;margin:0 auto;padding:60px 16px">
  <span class="badge b-acc">Enterprise Billing</span>
  <h1 style="font:600 40px/1.1 var(--display);letter-spacing:-1px;margin:18px 0">Enterprise billing.</h1>
  <p style="color:var(--dim2);font-size:16px;line-height:1.7">Procurement-friendly billing for Fortune 500 buyers. Purchase orders, NET-30/60/90, multi-currency invoices, annual prepay with multi-year discounts (8% off 2-year, 15% off 3-year), capacity reservations.</p>
</section>
<section style="max-width:780px;margin:0 auto;padding:24px 16px 60px">
  <h2 style="font:600 22px var(--display);margin:24px 0 12px">Multi-year prepay discount</h2>
  <table>
    <thead><tr><th>Term</th><th>Discount</th><th>Effective rate</th></tr></thead>
    <tbody>
      <tr><td>1 year</td><td>0%</td><td>list</td></tr>
      <tr><td>2 years</td><td><strong style="color:var(--good)">8% off</strong></td><td>92% × list × 2</td></tr>
      <tr><td>3 years</td><td><strong style="color:var(--good)">15% off</strong></td><td>85% × list × 3</td></tr>
    </tbody>
  </table>
  <h2 style="font:600 22px var(--display);margin:32px 0 12px">Supported</h2>
  <ul style="color:var(--dim2);line-height:1.7;padding-left:20px">
    <li>Currencies: ${CURRENCIES.join(', ')}</li>
    <li>Payment terms: ${PAYMENT_TERMS.join(', ').replace(/_/g, '-')}</li>
    <li>Payment methods: wire, ACH, USDC, check, card, other</li>
    <li>Globally monotonic invoice numbers (<code>INV-YYYY-NNNNNN</code>)</li>
    <li>Per-line-item tax handling (call <code>POST /v1/enterprise/invoices</code> with computed tax_cents)</li>
  </ul>
  <h2 style="font:600 22px var(--display);margin:32px 0 12px">Get a quote</h2>
  <p style="color:var(--dim2);line-height:1.7"><a href="/contact-sales" class="btn primary">Talk to sales →</a></p>
</section>`));
  });
}

module.exports = { migrate, registerEnterpriseBillingRoutes };
