// ============================================================================
// OpenHeab Tax — Tax form records, tax events, and 1099-K preview
// ============================================================================
const express = require('express');
const cryptoLib = require('crypto');
const { z } = require('zod');

const FORMS = ['W-9', 'W-8BEN', 'W-8BEN-E', 'W-8ECI', '8233', 'none'];

const EVENT_KINDS = [
  'earning', 'sale', 'royalty', 'subscription_revenue', 'a2a_received',
  'expense', 'refund', 'sales_tax_collected', 'vat_collected',
  'crypto_disposal', 'staking_reward'
];

const SOURCES = ['extension', 'marketplace', 'dataset', 'prompt', 'a2a', 'subscription'];

// ----------------------------------------------------------------------------
// Migration
// ----------------------------------------------------------------------------
async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tax_forms (
      form_id         TEXT PRIMARY KEY,
      agent_did       TEXT NOT NULL,
      form_type       TEXT NOT NULL,
      legal_name      TEXT,
      country         TEXT,
      tax_id_last4    TEXT,
      filed_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at      TIMESTAMPTZ,
      revoked_at      TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_tax_forms_agent ON tax_forms (agent_did);

    CREATE TABLE IF NOT EXISTS tax_events (
      event_id        TEXT PRIMARY KEY,
      agent_did       TEXT NOT NULL,
      kind            TEXT NOT NULL,
      amount_cents    BIGINT NOT NULL,
      currency        TEXT NOT NULL DEFAULT 'USD',
      counterparty_did TEXT,
      source          TEXT,
      source_ref      TEXT,
      jurisdiction    TEXT,
      tax_rate_bps    INTEGER,
      occurred_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_tax_events_agent ON tax_events (agent_did, occurred_at DESC);
    CREATE INDEX IF NOT EXISTS idx_tax_events_kind ON tax_events (agent_did, kind);

    CREATE TABLE IF NOT EXISTS tax_year_summaries (
      agent_did       TEXT NOT NULL,
      year            INTEGER NOT NULL,
      gross_cents     BIGINT NOT NULL DEFAULT 0,
      expenses_cents  BIGINT NOT NULL DEFAULT 0,
      net_cents       BIGINT NOT NULL DEFAULT 0,
      tx_count        INTEGER NOT NULL DEFAULT 0,
      by_kind         JSONB NOT NULL DEFAULT '{}'::jsonb,
      finalized_at    TIMESTAMPTZ,
      PRIMARY KEY (agent_did, year)
    );
  `).catch(() => {});
}

function genId(prefix) {
  return `${prefix}_${cryptoLib.randomBytes(12).toString('hex')}`;
}

// ----------------------------------------------------------------------------
// Routes
// ----------------------------------------------------------------------------
function registerTaxRoutes(app, pool, verifyAgentAuth, auditChain) {
  // POST /v1/agents/:did/tax/forms
  const FormSchema = z.object({
    form_type: z.enum(FORMS),
    legal_name: z.string().max(200).optional(),
    country: z.string().max(80).optional(),
    tax_id_last4: z.string().max(4).optional(),
    expires_at: z.string().datetime().optional()
  });

  app.post('/v1/agents/:did/tax/forms', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const parse = FormSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;

      const formId = genId('txf');
      await pool.query(
        `INSERT INTO tax_forms (form_id, agent_did, form_type, legal_name,
           country, tax_id_last4, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [formId, did, d.form_type, d.legal_name || null, d.country || null,
         d.tax_id_last4 || null, d.expires_at || null]
      );

      await auditChain.append({
        event_type: 'tax.form_filed',
        form_id: formId, agent_did: did, form_type: d.form_type,
        timestamp: new Date().toISOString()
      });

      return res.status(201).json({
        form_id: formId, agent_did: did, form_type: d.form_type
      });
    } catch (e) {
      console.error('[tax.form]', e);
      return res.status(500).json({ error: 'form_failed', message: e.message });
    }
  });

  // GET /v1/agents/:did/tax/forms
  app.get('/v1/agents/:did/tax/forms', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(
      `SELECT form_id, form_type, legal_name, country, tax_id_last4,
              filed_at, expires_at, revoked_at
       FROM tax_forms WHERE agent_did=$1 ORDER BY filed_at DESC`,
      [did]
    ).catch(() => ({ rows: [] }));
    return res.json({ forms: r.rows, count: r.rows.length });
  });

  // POST /v1/agents/:did/tax/events
  const EventSchema = z.object({
    kind: z.enum(EVENT_KINDS),
    amount_cents: z.number().int(),
    currency: z.string().max(10).default('USD'),
    counterparty_did: z.string().optional(),
    source: z.enum(SOURCES).optional(),
    source_ref: z.string().max(200).optional(),
    jurisdiction: z.string().max(80).optional(),
    tax_rate_bps: z.number().int().nonnegative().max(10000).optional(),
    occurred_at: z.string().datetime().optional()
  });

  app.post('/v1/agents/:did/tax/events', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const parse = EventSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;

      const eventId = genId('txe');
      const occurredAt = d.occurred_at ? new Date(d.occurred_at) : new Date();
      await pool.query(
        `INSERT INTO tax_events (event_id, agent_did, kind, amount_cents, currency,
           counterparty_did, source, source_ref, jurisdiction, tax_rate_bps, occurred_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [eventId, did, d.kind, d.amount_cents, d.currency,
         d.counterparty_did || null, d.source || null, d.source_ref || null,
         d.jurisdiction || null,
         d.tax_rate_bps === undefined ? null : d.tax_rate_bps,
         occurredAt]
      );

      await auditChain.append({
        event_type: 'tax.event_recorded',
        event_id: eventId, agent_did: did, kind: d.kind,
        amount_cents: d.amount_cents,
        timestamp: new Date().toISOString()
      });

      return res.status(201).json({
        event_id: eventId, agent_did: did, kind: d.kind, amount_cents: d.amount_cents
      });
    } catch (e) {
      console.error('[tax.event]', e);
      return res.status(500).json({ error: 'event_failed', message: e.message });
    }
  });

  // GET /v1/agents/:did/tax/summary — current year
  app.get('/v1/agents/:did/tax/summary', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });

    const year = new Date().getUTCFullYear();
    const summary = await computeYearSummary(pool, did, year);
    return res.json(summary);
  });

  // GET /v1/agents/:did/tax/1099 — prior year 1099-K preview
  app.get('/v1/agents/:did/tax/1099', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });

    const priorYear = new Date().getUTCFullYear() - 1;
    const summary = await computeYearSummary(pool, did, priorYear);
    return res.json({
      form: '1099-K',
      year: priorYear,
      payee_did: did,
      eligible: summary.eligible_1099k,
      gross_amount_cents: summary.gross_cents,
      number_of_transactions: summary.tx_count,
      by_month: summary.by_month || []
    });
  });

  // Cron: year roll
  const { registerCron } = require('../cron_auth');
  registerCron(app, '/v1/_jobs/tax-year-roll', async (req, res) => {
    try {
      const priorYear = new Date().getUTCFullYear() - 1;
      const dids = await pool.query(
        `SELECT DISTINCT agent_did FROM tax_events
         WHERE EXTRACT(YEAR FROM occurred_at) = $1`,
        [priorYear]
      ).catch(() => ({ rows: [] }));
      let finalized = 0;
      for (const row of dids.rows) {
        const s = await computeYearSummary(pool, row.agent_did, priorYear);
        await pool.query(
          `INSERT INTO tax_year_summaries (agent_did, year, gross_cents,
             expenses_cents, net_cents, tx_count, by_kind, finalized_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,NOW())
           ON CONFLICT (agent_did, year) DO UPDATE SET
             gross_cents=$3, expenses_cents=$4, net_cents=$5,
             tx_count=$6, by_kind=$7::jsonb, finalized_at=NOW()`,
          [row.agent_did, priorYear, s.gross_cents, s.expenses_cents,
           s.net_cents, s.tx_count, JSON.stringify(s.by_kind || {})]
        ).catch(() => {});
        finalized += 1;
        if (auditChain) {
          await auditChain.append({
            event_type: 'tax.year_finalized',
            agent_did: row.agent_did, year: priorYear,
            timestamp: new Date().toISOString()
          });
        }
      }
      res.json({ finalized, year: priorYear });
    } catch (e) {
      res.status(500).json({ error: 'year_roll_failed', message: e.message });
    }
  });
}

async function computeYearSummary(pool, did, year) {
  const r = await pool.query(
    `SELECT kind, COUNT(*)::int AS n, COALESCE(SUM(amount_cents)::bigint, 0) AS sum
     FROM tax_events
     WHERE agent_did=$1 AND EXTRACT(YEAR FROM occurred_at) = $2
     GROUP BY kind`,
    [did, year]
  ).catch(() => ({ rows: [] }));

  const byKind = {};
  let gross = 0;
  let expenses = 0;
  let txCount = 0;
  for (const row of r.rows) {
    const n = parseInt(row.n);
    const sum = parseInt(row.sum);
    byKind[row.kind] = { count: n, amount_cents: sum };
    txCount += n;
    if (row.kind === 'expense' || row.kind === 'refund') expenses += Math.abs(sum);
    else gross += sum;
  }

  // Monthly breakdown for 1099-K
  const months = await pool.query(
    `SELECT EXTRACT(MONTH FROM occurred_at)::int AS month,
            COUNT(*)::int AS n,
            COALESCE(SUM(amount_cents)::bigint, 0) AS sum
     FROM tax_events
     WHERE agent_did=$1 AND EXTRACT(YEAR FROM occurred_at) = $2
       AND kind NOT IN ('expense','refund')
     GROUP BY month ORDER BY month`,
    [did, year]
  ).catch(() => ({ rows: [] }));

  const net = gross - expenses;
  const eligible1099k = gross >= 60000 || txCount >= 200;

  return {
    agent_did: did, year,
    gross_cents: gross,
    expenses_cents: expenses,
    net_cents: net,
    tx_count: txCount,
    by_kind: byKind,
    by_month: months.rows.map(m => ({
      month: parseInt(m.month), tx_count: parseInt(m.n), gross_cents: parseInt(m.sum)
    })),
    eligible_1099k: eligible1099k
  };
}

module.exports = {
  migrate,
  registerTaxRoutes,
  FORMS,
  EVENT_KINDS
};
