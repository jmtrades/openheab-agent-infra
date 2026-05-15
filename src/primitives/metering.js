// ============================================================================
// metering.js — usage tracking for usage-based billing.
//
// Every primitive that wants to bill a customer calls recordEvent({...}).
// At the end of each billing period we aggregate into meter_aggregates and
// the subscriptions primitive turns overages into invoice line items.
// ============================================================================
const crypto = require('crypto');
const { z } = require('zod');
const { registerCron } = require('../cron_auth');

const STANDARD_METERS = [
  ['inference.tokens',         'Inference tokens',          '1k tokens',     'Tokens consumed via /v1/agents/:did/inference/chat',                  20],
  ['storage.gb_hours',         'Storage GB-hours',          'GB-hour',       'Encrypted blob storage',                                              0.139],
  ['compute.gpu_seconds',      'Compute GPU seconds',       'GPU-second',    'GPU seconds consumed via /v1/agents/:did/compute/instances',         5],
  ['wallet.transfer_count',    'Wallet transfers',          'transfer',      'USDC transfers via /v1/agents/:did/wallet/transfer',                  10],
  ['wallet.transfer_volume',   'Wallet transfer volume',    'cents',         'USDC volume in cents',                                                1],
  ['card.transaction',         'Card transactions',         'swipe',         'Card auths approved',                                                 5],
  ['card.spend',               'Card spend',                'cents',         'Card spend in cents (sum of captures)',                               2],
  ['extension.invocation',     'Extension invocations',     'call',          'Extensions marketplace invocations',                                  1],
  ['sandbox.session_minutes',  'Sandbox session minutes',   'minute',        'Code sandbox session minutes',                                        2],
  ['browser.session_minutes',  'Browser session minutes',   'minute',        'Headless browser session minutes',                                    2],
  ['voice.tts_chars',          'Voice TTS chars',           '1k chars',      'Text-to-speech characters',                                           15],
  ['vision.images',            'Vision images',             'image',         'Image generation + analysis calls',                                   40],
  ['search.queries',           'Search queries',            'query',         'Web search queries',                                                  4],
  ['translate.chars',          'Translate chars',           '1k chars',      'Translate characters',                                                10]
];

async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS meter_definitions (
      kind                 TEXT PRIMARY KEY,
      name                 TEXT NOT NULL,
      unit                 TEXT NOT NULL,
      description          TEXT,
      included_in_plans    JSONB DEFAULT '{}'::jsonb,
      overage_rate_cents   NUMERIC(20,6) NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS meter_events (
      event_id             TEXT PRIMARY KEY,
      org_id               TEXT,
      agent_did            TEXT,
      kind                 TEXT NOT NULL,
      quantity             NUMERIC(38,6) NOT NULL,
      unit                 TEXT,
      occurred_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      period_yyyymm        INTEGER NOT NULL,
      metadata             JSONB,
      idempotency_key      TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_meter_events_org_period
      ON meter_events (org_id, period_yyyymm, kind);
    CREATE INDEX IF NOT EXISTS idx_meter_events_agent_period
      ON meter_events (agent_did, period_yyyymm, kind);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_meter_events_idem
      ON meter_events (kind, idempotency_key) WHERE idempotency_key IS NOT NULL;

    CREATE TABLE IF NOT EXISTS meter_aggregates (
      org_id               TEXT NOT NULL,
      kind                 TEXT NOT NULL,
      period_yyyymm        INTEGER NOT NULL,
      total_quantity       NUMERIC(38,6) NOT NULL DEFAULT 0,
      event_count          INTEGER NOT NULL DEFAULT 0,
      last_updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (org_id, kind, period_yyyymm)
    );
  `);
  // Seed the 14 standard meters
  for (const [kind, name, unit, desc, rate] of STANDARD_METERS) {
    await pool.query(
      `INSERT INTO meter_definitions (kind, name, unit, description, overage_rate_cents)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (kind) DO NOTHING`,
      [kind, name, unit, desc, rate]
    ).catch(() => {});
  }
}

function periodFromDate(d = new Date()) {
  return d.getUTCFullYear() * 100 + (d.getUTCMonth() + 1);
}

function newId(prefix) { return prefix + '_' + crypto.randomBytes(10).toString('hex'); }

async function recordEvent({ pool, org_id = null, agent_did = null, kind,
                              quantity, unit = null, idempotency_key = null,
                              metadata = null, occurred_at = null }) {
  if (!kind || quantity === undefined || quantity === null) {
    throw new Error('kind_and_quantity_required');
  }
  const occ = occurred_at ? new Date(occurred_at) : new Date();
  const period = periodFromDate(occ);
  const id = newId('mev');
  await pool.query(
    `INSERT INTO meter_events
       (event_id, org_id, agent_did, kind, quantity, unit, occurred_at,
        period_yyyymm, metadata, idempotency_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (kind, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING`,
    [id, org_id, agent_did, kind, quantity, unit, occ.toISOString(),
     period, metadata ? JSON.stringify(metadata) : null, idempotency_key]
  ).catch(() => {});
  return { event_id: id, period_yyyymm: period };
}

async function getUsage(pool, orgId, kind, periodYYYYMM) {
  const r = await pool.query(`
    SELECT total_quantity, event_count FROM meter_aggregates
    WHERE org_id = $1 AND kind = $2 AND period_yyyymm = $3
  `, [orgId, kind, periodYYYYMM]).catch(() => ({ rows: [] }));
  if (r.rows[0]) return { total_quantity: String(r.rows[0].total_quantity), event_count: r.rows[0].event_count };
  // fallback: live aggregate from events
  const live = await pool.query(`
    SELECT COALESCE(SUM(quantity),0)::text AS q, COUNT(*)::int AS c
    FROM meter_events WHERE org_id = $1 AND kind = $2 AND period_yyyymm = $3
  `, [orgId, kind, periodYYYYMM]).catch(() => ({ rows: [{ q: '0', c: 0 }] }));
  return { total_quantity: live.rows[0].q, event_count: live.rows[0].c };
}

async function getForecast(pool, orgId, kind) {
  const period = periodFromDate(new Date());
  const usage = await getUsage(pool, orgId, kind, period);
  const now = new Date();
  const dayOfMonth = now.getUTCDate();
  const daysInMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
  const factor = daysInMonth / Math.max(1, dayOfMonth);
  return {
    kind, period_yyyymm: period,
    actual_so_far: usage.total_quantity,
    forecast_eom: String(Math.ceil(Number(usage.total_quantity) * factor)),
    days_elapsed: dayOfMonth, days_in_period: daysInMonth
  };
}

// ----- Cron: aggregate events into meter_aggregates -------------------------
async function runAggregate(pool) {
  const period = periodFromDate(new Date());
  const r = await pool.query(`
    SELECT org_id, kind, COUNT(*)::int AS c, COALESCE(SUM(quantity),0) AS q
    FROM meter_events
    WHERE period_yyyymm = $1 AND org_id IS NOT NULL
    GROUP BY org_id, kind
  `, [period]).catch(() => ({ rows: [] }));
  let upserted = 0;
  for (const row of r.rows) {
    await pool.query(`
      INSERT INTO meter_aggregates (org_id, kind, period_yyyymm, total_quantity, event_count)
      VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (org_id, kind, period_yyyymm) DO UPDATE
      SET total_quantity = $4, event_count = $5, last_updated_at = NOW()
    `, [row.org_id, row.kind, period, row.q, row.c]).catch(() => {});
    upserted++;
  }
  return { period_yyyymm: period, rolled_up: upserted };
}

// ----- Cron: end-of-period billing — turn overages into invoice items -------
async function runBilling(pool, auditChain) {
  // Bill the previous month
  const now = new Date();
  const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const period = periodFromDate(prev);
  let billed = 0;
  const meters = await pool.query(`SELECT kind, overage_rate_cents FROM meter_definitions`)
    .catch(() => ({ rows: [] }));
  for (const m of meters.rows) {
    const rate = Number(m.overage_rate_cents);
    if (!rate) continue;
    const usage = await pool.query(`
      SELECT org_id, total_quantity FROM meter_aggregates
      WHERE kind = $1 AND period_yyyymm = $2 AND total_quantity > 0
    `, [m.kind, period]).catch(() => ({ rows: [] }));
    for (const u of usage.rows) {
      const cents = Math.ceil(Number(u.total_quantity) * rate);
      if (auditChain) {
        await auditChain.append({
          event_type: 'metering.billed',
          org_id: u.org_id, kind: m.kind,
          period_yyyymm: period, quantity: String(u.total_quantity),
          rate_cents: rate, total_cents: cents
        }).catch(() => {});
      }
      billed++;
    }
  }
  return { period_yyyymm: period, line_items_emitted: billed };
}

const ingestSchema = z.object({
  org_id: z.string().nullable().optional(),
  agent_did: z.string().nullable().optional(),
  kind: z.string().min(1),
  quantity: z.number(),
  unit: z.string().optional(),
  idempotency_key: z.string().optional(),
  metadata: z.record(z.any()).optional(),
  occurred_at: z.string().optional()
});

function registerMeteringRoutes(app, pool, verifyAgentAuth, auditChain) {
  const express = require('express');
  const { isCronRequest } = require('../cron_auth');

  app.get('/v1/metering/definitions', async (req, res) => {
    const r = await pool.query(`SELECT kind, name, unit, description, overage_rate_cents
                                FROM meter_definitions ORDER BY kind`)
      .catch(() => ({ rows: [] }));
    res.json({ meters: r.rows });
  });

  app.post('/v1/metering/events', express.json(), async (req, res) => {
    const did = req.headers['x-agent-did'];
    if (!isCronRequest(req) && did) {
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
    } else if (!isCronRequest(req)) {
      return res.status(401).json({ error: 'agent_or_cron_auth_required' });
    }
    const parsed = ingestSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: 'invalid_input', details: parsed.error.flatten() });
    const out = await recordEvent({ pool, ...parsed.data });
    return res.status(201).json(out);
  });

  app.post('/v1/metering/events/batch', express.json({ limit: '5mb' }), async (req, res) => {
    if (!isCronRequest(req)) return res.status(401).json({ error: 'cron_auth_required' });
    const events = Array.isArray(req.body) ? req.body : (req.body?.events || []);
    let ok = 0, bad = 0;
    for (const e of events) {
      try {
        const p = ingestSchema.parse(e);
        await recordEvent({ pool, ...p });
        ok++;
      } catch { bad++; }
    }
    return res.json({ accepted: ok, rejected: bad });
  });

  app.get('/v1/orgs/:id/usage', async (req, res) => {
    const period = parseInt(req.query.period) || periodFromDate(new Date());
    const kind = req.query.kind;
    if (kind) {
      const u = await getUsage(pool, req.params.id, kind, period);
      return res.json({ org_id: req.params.id, period_yyyymm: period, kind, ...u });
    }
    const r = await pool.query(`
      SELECT kind, total_quantity, event_count FROM meter_aggregates
      WHERE org_id = $1 AND period_yyyymm = $2 ORDER BY kind
    `, [req.params.id, period]).catch(() => ({ rows: [] }));
    return res.json({
      org_id: req.params.id, period_yyyymm: period,
      meters: r.rows.map(x => ({ kind: x.kind, total_quantity: String(x.total_quantity), event_count: x.event_count }))
    });
  });

  app.get('/v1/orgs/:id/usage/forecast', async (req, res) => {
    const kind = req.query.kind;
    if (!kind) return res.status(400).json({ error: 'kind_required' });
    const f = await getForecast(pool, req.params.id, kind);
    return res.json({ org_id: req.params.id, ...f });
  });

  registerCron(app, '/v1/_jobs/metering-aggregate',
    async (req, res) => res.json(await runAggregate(pool)));
  registerCron(app, '/v1/_jobs/metering-bill',
    async (req, res) => res.json(await runBilling(pool, auditChain)));
}

module.exports = {
  migrate, registerMeteringRoutes, recordEvent, getUsage, getForecast,
  periodFromDate, runAggregate, runBilling, STANDARD_METERS
};
