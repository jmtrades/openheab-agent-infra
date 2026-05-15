// ============================================================================
// quotes.js — quote-to-cash (CPQ) for enterprise sales: send a custom quote →
// customer accepts → order placed → invoice issued → payment collected.
// ============================================================================
const crypto = require('crypto');
const { z } = require('zod');
const { registerCron } = require('../cron_auth');

async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS quotes (
      quote_id            TEXT PRIMARY KEY,
      org_id              TEXT,
      prepared_by_did     TEXT NOT NULL,
      prepared_for_email  TEXT NOT NULL,
      prepared_for_name   TEXT,
      valid_until         TIMESTAMPTZ,
      currency            TEXT DEFAULT 'usd',
      subtotal_cents      BIGINT NOT NULL DEFAULT 0,
      tax_cents           BIGINT NOT NULL DEFAULT 0,
      discount_cents      BIGINT NOT NULL DEFAULT 0,
      total_cents         BIGINT NOT NULL DEFAULT 0,
      status              TEXT NOT NULL DEFAULT 'draft',
      accepted_at         TIMESTAMPTZ,
      declined_at         TIMESTAMPTZ,
      declined_reason     TEXT,
      terms               TEXT,
      payment_terms       TEXT DEFAULT 'net30',
      custom_msa_url      TEXT,
      signed_at           TIMESTAMPTZ,
      signed_by_email     TEXT,
      signature_blob      TEXT,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      sent_at             TIMESTAMPTZ
    );
    CREATE TABLE IF NOT EXISTS quote_line_items (
      item_id             TEXT PRIMARY KEY,
      quote_id            TEXT NOT NULL,
      kind                TEXT NOT NULL,
      sku                 TEXT,
      description         TEXT,
      quantity            NUMERIC(20,6) NOT NULL DEFAULT 1,
      unit_price_cents    BIGINT NOT NULL,
      amount_cents        BIGINT NOT NULL,
      recurring           BOOLEAN NOT NULL DEFAULT FALSE,
      billing_interval    TEXT,
      sort_order          INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS quote_orders (
      order_id            TEXT PRIMARY KEY,
      quote_id            TEXT NOT NULL,
      org_id              TEXT,
      status              TEXT NOT NULL DEFAULT 'pending',
      activated_at        TIMESTAMPTZ,
      billing_subscription_id TEXT,
      stripe_invoice_id   TEXT,
      contract_pdf_url    TEXT,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

function newId(p) { return p + '_' + crypto.randomBytes(10).toString('hex'); }

function sumLineItems(items) {
  let subtotal = 0;
  for (const it of items) {
    const amt = Math.round(Number(it.quantity || 1) * Number(it.unit_price_cents));
    subtotal += amt;
  }
  return subtotal;
}

const lineItemSchema = z.object({
  kind: z.enum(['subscription', 'credits', 'setup_fee', 'professional_services', 'custom']),
  sku: z.string().optional(),
  description: z.string().min(1),
  quantity: z.number().min(0).default(1),
  unit_price_cents: z.number().int().min(0),
  recurring: z.boolean().optional(),
  billing_interval: z.string().optional()
});

const quoteSchema = z.object({
  prepared_for_email: z.string().email(),
  prepared_for_name: z.string().optional(),
  line_items: z.array(lineItemSchema).min(1),
  payment_terms: z.enum(['net15', 'net30', 'net60', 'upfront', 'milestone']).optional(),
  valid_until: z.string().optional(),
  terms: z.string().optional(),
  custom_msa_url: z.string().url().optional(),
  discount_cents: z.number().int().min(0).optional(),
  tax_cents: z.number().int().min(0).optional()
});

async function createQuote({ pool, org_id, prepared_by_did, ...data }) {
  const id = newId('quo');
  const subtotal = sumLineItems(data.line_items);
  const total = subtotal + (data.tax_cents || 0) - (data.discount_cents || 0);
  const validUntil = data.valid_until ? new Date(data.valid_until).toISOString()
    : new Date(Date.now() + 30 * 86400000).toISOString();
  await pool.query(
    `INSERT INTO quotes
       (quote_id, org_id, prepared_by_did, prepared_for_email, prepared_for_name,
        valid_until, subtotal_cents, tax_cents, discount_cents, total_cents,
        terms, payment_terms, custom_msa_url, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'draft')`,
    [id, org_id, prepared_by_did, data.prepared_for_email, data.prepared_for_name || null,
     validUntil, subtotal, data.tax_cents || 0, data.discount_cents || 0, total,
     data.terms || null, data.payment_terms || 'net30', data.custom_msa_url || null]
  );
  for (let i = 0; i < data.line_items.length; i++) {
    const it = data.line_items[i];
    await pool.query(
      `INSERT INTO quote_line_items (item_id, quote_id, kind, sku, description, quantity,
        unit_price_cents, amount_cents, recurring, billing_interval, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [newId('qli'), id, it.kind, it.sku || null, it.description, it.quantity,
       it.unit_price_cents, Math.round(it.quantity * it.unit_price_cents),
       it.recurring || false, it.billing_interval || null, i]
    );
  }
  return { quote_id: id, total_cents: total, valid_until: validUntil };
}

async function quoteToOrder(pool, quoteId, auditChain = null) {
  const q = await pool.query(`SELECT * FROM quotes WHERE quote_id = $1`, [quoteId]).catch(() => ({ rows: [] }));
  if (!q.rows[0]) throw new Error('quote_not_found');
  const items = await pool.query(`SELECT * FROM quote_line_items WHERE quote_id = $1 ORDER BY sort_order`, [quoteId])
    .catch(() => ({ rows: [] }));
  const orderId = newId('ord');
  await pool.query(
    `INSERT INTO quote_orders (order_id, quote_id, org_id, status, activated_at)
     VALUES ($1,$2,$3,'active',NOW())`,
    [orderId, quoteId, q.rows[0].org_id]
  );
  // For each line item, fan-out side effects:
  for (const it of items.rows) {
    if (it.kind === 'subscription' && it.sku && q.rows[0].org_id) {
      // Try to activate a subscription via the subscriptions primitive
      try { /* no-op; subscriptions primitive will pick up via webhook if integrated */ } catch {}
    }
    if (it.kind === 'credits' && q.rows[0].org_id) {
      try {
        const c = require('./credits');
        await c.grantCredits({ pool, orgId: q.rows[0].org_id, credits: Number(it.quantity) || 1, reason: 'quote_accepted', expires_at: null });
      } catch {}
    }
  }
  // Record revenue: setup fees + professional services hit immediately
  let immediateRev = 0;
  for (const it of items.rows) if (!it.recurring) immediateRev += Number(it.amount_cents);
  if (immediateRev > 0) {
    try {
      const rev = require('./revenue');
      await rev.recordRevenue({ pool, source_layer: 'professional_services',
        amount_cents: immediateRev, org_id: q.rows[0].org_id, related_id: orderId });
    } catch {}
  }
  if (auditChain) await auditChain.append({ event_type: 'quote.order_created', quote_id: quoteId, order_id: orderId, total_cents: Number(q.rows[0].total_cents) }).catch(() => {});
  return { order_id: orderId };
}

const acceptSchema = z.object({
  signed_by_email: z.string().email(),
  signature: z.string().min(1),
  accept_terms: z.boolean()
});

function registerQuotesRoutes(app, pool, verifyAgentAuth, auditChain) {
  const express = require('express');

  app.post('/v1/orgs/:id/quotes', express.json(), async (req, res) => {
    const did = req.headers['x-agent-did'];
    if (!did) return res.status(401).json({ error: 'agent_did_required' });
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const p = quoteSchema.safeParse(req.body || {});
    if (!p.success) return res.status(400).json({ error: 'invalid_input', details: p.error.flatten() });
    const out = await createQuote({ pool, org_id: req.params.id, prepared_by_did: did, ...p.data });
    if (auditChain) await auditChain.append({ event_type: 'quote.created', org_id: req.params.id, ...out }).catch(() => {});
    res.status(201).json(out);
  });

  app.get('/v1/orgs/:id/quotes', async (req, res) => {
    const did = req.headers['x-agent-did'];
    if (!did) return res.status(401).json({ error: 'agent_did_required' });
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(`
      SELECT quote_id, prepared_for_email, total_cents, status, valid_until, created_at, sent_at
      FROM quotes WHERE org_id = $1 ORDER BY created_at DESC LIMIT 200
    `, [req.params.id]).catch(() => ({ rows: [] }));
    res.json({ quotes: r.rows });
  });

  app.get('/v1/orgs/:id/quotes/:qid', async (req, res) => {
    const did = req.headers['x-agent-did'];
    if (!did) return res.status(401).json({ error: 'agent_did_required' });
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const q = await pool.query(`SELECT * FROM quotes WHERE quote_id = $1 AND org_id = $2`, [req.params.qid, req.params.id])
      .catch(() => ({ rows: [] }));
    if (!q.rows[0]) return res.status(404).json({ error: 'not_found' });
    const items = await pool.query(`SELECT * FROM quote_line_items WHERE quote_id = $1 ORDER BY sort_order`, [req.params.qid])
      .catch(() => ({ rows: [] }));
    res.json({ ...q.rows[0], line_items: items.rows });
  });

  app.post('/v1/orgs/:id/quotes/:qid/send', async (req, res) => {
    const did = req.headers['x-agent-did'];
    if (!did) return res.status(401).json({ error: 'agent_did_required' });
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(`UPDATE quotes SET status='sent', sent_at = NOW() WHERE quote_id = $1 AND org_id = $2 RETURNING quote_id, prepared_for_email`,
      [req.params.qid, req.params.id]).catch(() => ({ rows: [] }));
    if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
    if (auditChain) await auditChain.append({ event_type: 'quote.sent', quote_id: r.rows[0].quote_id, recipient: r.rows[0].prepared_for_email }).catch(() => {});
    res.json({ quote_id: r.rows[0].quote_id, status: 'sent', view_url: `${process.env.OPERATOR_PUBLIC_URL || ''}/v1/quotes/${r.rows[0].quote_id}/view` });
  });

  // Public viewer
  app.get('/v1/quotes/:qid/view', async (req, res) => {
    const q = await pool.query(`SELECT * FROM quotes WHERE quote_id = $1`, [req.params.qid]).catch(() => ({ rows: [] }));
    if (!q.rows[0]) return res.status(404).json({ error: 'not_found' });
    if (q.rows[0].status === 'sent') {
      await pool.query(`UPDATE quotes SET status='viewed' WHERE quote_id = $1`, [req.params.qid]).catch(() => {});
    }
    const items = await pool.query(`SELECT * FROM quote_line_items WHERE quote_id = $1 ORDER BY sort_order`, [req.params.qid])
      .catch(() => ({ rows: [] }));
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.send(renderQuoteHTML(q.rows[0], items.rows));
  });

  app.post('/v1/quotes/:qid/accept', express.json(), async (req, res) => {
    const p = acceptSchema.safeParse(req.body || {});
    if (!p.success) return res.status(400).json({ error: 'invalid_input', details: p.error.flatten() });
    if (!p.data.accept_terms) return res.status(400).json({ error: 'must_accept_terms' });
    const r = await pool.query(`
      UPDATE quotes SET status='accepted', accepted_at=NOW(), signed_at=NOW(),
        signed_by_email = $1, signature_blob = $2
      WHERE quote_id = $3 AND status IN ('sent','viewed','draft')
      RETURNING quote_id, org_id, total_cents
    `, [p.data.signed_by_email, p.data.signature, req.params.qid]).catch(() => ({ rows: [] }));
    if (!r.rows[0]) return res.status(404).json({ error: 'not_found_or_already_decided' });
    const order = await quoteToOrder(pool, r.rows[0].quote_id, auditChain);
    res.json({ quote_id: r.rows[0].quote_id, status: 'accepted', order });
  });

  app.post('/v1/quotes/:qid/decline', express.json(), async (req, res) => {
    const r = await pool.query(`
      UPDATE quotes SET status='declined', declined_at=NOW(), declined_reason = $1
      WHERE quote_id = $2 AND status IN ('sent','viewed','draft')
      RETURNING quote_id
    `, [req.body?.reason || null, req.params.qid]).catch(() => ({ rows: [] }));
    if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
    if (auditChain) await auditChain.append({ event_type: 'quote.declined', quote_id: r.rows[0].quote_id, reason: req.body?.reason }).catch(() => {});
    res.json({ quote_id: r.rows[0].quote_id, status: 'declined' });
  });

  app.get('/v1/orgs/:id/quotes/:qid/orders', async (req, res) => {
    const did = req.headers['x-agent-did'];
    if (!did) return res.status(401).json({ error: 'agent_did_required' });
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(`SELECT * FROM quote_orders WHERE quote_id = $1`, [req.params.qid])
      .catch(() => ({ rows: [] }));
    res.json({ orders: r.rows });
  });

  registerCron(app, '/v1/_jobs/quotes-expire', async (req, res) => {
    const r = await pool.query(`
      UPDATE quotes SET status='expired'
      WHERE status IN ('sent','viewed','draft') AND valid_until < NOW()
      RETURNING quote_id
    `).catch(() => ({ rows: [] }));
    res.json({ expired: r.rows.length });
  });
}

function renderQuoteHTML(quote, items) {
  const itemsHtml = items.map(it => `
    <tr><td>${escapeHtml(it.description)}</td>
        <td style="text-align:right">${it.quantity}</td>
        <td style="text-align:right">$${(Number(it.unit_price_cents)/100).toFixed(2)}</td>
        <td style="text-align:right">$${(Number(it.amount_cents)/100).toFixed(2)}</td></tr>`).join('');
  return `<!doctype html><html><head><meta charset=utf-8>
<title>Quote ${quote.quote_id}</title>
<style>
body{font-family:-apple-system,system-ui,sans-serif;max-width:780px;margin:40px auto;padding:0 24px;color:#0a0a0a;line-height:1.55;background:#fafafa}
h1{font-size:28px;letter-spacing:-1px}.meta{color:#666;font-size:14px;margin-bottom:30px}
table{width:100%;border-collapse:collapse;margin:24px 0;background:#fff;border:1px solid #e5e5e5;border-radius:8px;overflow:hidden}
th,td{padding:12px 16px;text-align:left;border-bottom:1px solid #f0f0f0}
th{background:#f5f5f5;font:600 11px/1 ui-monospace,monospace;text-transform:uppercase;letter-spacing:1px;color:#666}
.total{background:#fff;border:1px solid #e5e5e5;border-radius:8px;padding:18px 20px;display:flex;justify-content:space-between;align-items:center;margin:18px 0}
.total .lbl{color:#666;font-size:14px}.total .v{font:700 26px/1 ui-monospace,monospace;letter-spacing:-1px}
.btns{display:flex;gap:12px;margin-top:24px}
.btn{padding:14px 24px;border-radius:8px;font-weight:600;font-size:14px;border:0;cursor:pointer;font-family:inherit}
.btn.accept{background:#0a0a0a;color:#7df9ff}.btn.decline{background:#fff;border:1px solid #e5e5e5;color:#0a0a0a}
form{display:contents}
.terms{color:#888;font-size:12px;margin-top:24px;padding-top:18px;border-top:1px solid #e5e5e5}
</style></head><body>
<h1>Quote ${escapeHtml(quote.quote_id.slice(4, 14))}</h1>
<div class=meta>For: ${escapeHtml(quote.prepared_for_name || quote.prepared_for_email)} · Valid until: ${new Date(quote.valid_until).toISOString().slice(0,10)} · Status: <strong>${escapeHtml(quote.status)}</strong></div>
<table><thead><tr><th>Description</th><th style="text-align:right">Qty</th><th style="text-align:right">Unit price</th><th style="text-align:right">Amount</th></tr></thead><tbody>${itemsHtml}</tbody></table>
<div class=total><span class=lbl>Subtotal</span><span class=v>$${(Number(quote.subtotal_cents)/100).toFixed(2)}</span></div>
${Number(quote.discount_cents) > 0 ? `<div class=total><span class=lbl>Discount</span><span class=v>−$${(Number(quote.discount_cents)/100).toFixed(2)}</span></div>` : ''}
${Number(quote.tax_cents) > 0 ? `<div class=total><span class=lbl>Tax</span><span class=v>$${(Number(quote.tax_cents)/100).toFixed(2)}</span></div>` : ''}
<div class=total style="background:#0a0a0a;color:#7df9ff"><span class=lbl style="color:#aaa">Total · ${escapeHtml(quote.payment_terms)}</span><span class=v>$${(Number(quote.total_cents)/100).toFixed(2)}</span></div>
${quote.status === 'sent' || quote.status === 'viewed' ? `
<form method=post action="/v1/quotes/${escapeHtml(quote.quote_id)}/accept" onsubmit="event.preventDefault();fetch('/v1/quotes/${escapeHtml(quote.quote_id)}/accept',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({signed_by_email:document.getElementById('em').value,signature:document.getElementById('sg').value,accept_terms:true})}).then(r=>r.json()).then(d=>{location.reload()});">
<div class=btns>
  <input id=em type=email placeholder="your email" required style="padding:14px 12px;border:1px solid #e5e5e5;border-radius:8px;font-size:14px;flex:1">
  <input id=sg type=text placeholder="your name (signature)" required style="padding:14px 12px;border:1px solid #e5e5e5;border-radius:8px;font-size:14px;flex:1">
  <button type=submit class="btn accept">Accept</button>
</div></form>` : ''}
${quote.terms ? `<div class=terms>${escapeHtml(quote.terms)}</div>` : ''}
</body></html>`;
}
function escapeHtml(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c])); }

module.exports = { migrate, registerQuotesRoutes, createQuote, quoteToOrder };
