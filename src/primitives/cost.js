// ============================================================================
// OpenHeab Cost — Per-agent cost attribution + budgets
// Records cost events, enforces monthly budget caps, fires alert webhooks at
// configurable percentage thresholds.
// ============================================================================
const cryptoLib = require('crypto');
const express = require('express');
const { z } = require('zod');

// ----------------------------------------------------------------------------
// Migration
// ----------------------------------------------------------------------------
async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cost_events (
      event_id        TEXT PRIMARY KEY,
      agent_did       TEXT NOT NULL,
      operator_did    TEXT,
      customer_id     TEXT,
      resource_type   TEXT NOT NULL,
      provider        TEXT,
      amount_cents    BIGINT NOT NULL,
      currency        TEXT NOT NULL DEFAULT 'USD',
      units           NUMERIC(78, 6),
      unit_type       TEXT,
      tags            JSONB,
      reference_id    TEXT,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_cost_events_agent ON cost_events (agent_did, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_cost_events_resource ON cost_events (agent_did, resource_type, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_cost_events_period ON cost_events (agent_did, date_trunc('month', created_at));
    CREATE INDEX IF NOT EXISTS idx_cost_events_reference ON cost_events (reference_id) WHERE reference_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS cost_budgets (
      agent_did                  TEXT PRIMARY KEY,
      monthly_cap_cents          BIGINT,
      hard_cap                   BOOLEAN NOT NULL DEFAULT FALSE,
      alert_thresholds           INTEGER[] NOT NULL DEFAULT ARRAY[50, 75, 90, 100],
      alert_webhook_url          TEXT,
      period_start               TIMESTAMPTZ NOT NULL DEFAULT date_trunc('month', NOW()),
      spent_this_period_cents    BIGINT NOT NULL DEFAULT 0,
      paused                     BOOLEAN NOT NULL DEFAULT FALSE,
      created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS cost_alerts_fired (
      alert_id       TEXT PRIMARY KEY,
      agent_did      TEXT NOT NULL,
      period_start   TIMESTAMPTZ NOT NULL,
      threshold_pct  INTEGER NOT NULL,
      spent_cents    BIGINT NOT NULL,
      cap_cents      BIGINT NOT NULL,
      webhook_url    TEXT,
      webhook_status TEXT,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (agent_did, period_start, threshold_pct)
    );
    CREATE INDEX IF NOT EXISTS idx_alerts_agent ON cost_alerts_fired (agent_did, created_at DESC);

    CREATE TABLE IF NOT EXISTS cost_idempotency (
      idem_key      TEXT NOT NULL,
      agent_did     TEXT NOT NULL,
      response      JSONB NOT NULL,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (agent_did, idem_key)
    );
  `);
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------
function periodStart(d = new Date()) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

async function getBudget(pool, did) {
  const r = await pool.query(`SELECT * FROM cost_budgets WHERE agent_did=$1`, [did])
    .catch(() => ({ rows: [] }));
  return r.rows[0] || null;
}

async function rolloverIfNeeded(pool, did) {
  const b = await getBudget(pool, did);
  if (!b) return null;
  const start = periodStart();
  if (new Date(b.period_start) < start) {
    await pool.query(
      `UPDATE cost_budgets SET period_start=$2, spent_this_period_cents=0, updated_at=NOW()
       WHERE agent_did=$1`,
      [did, start]
    );
    b.period_start = start;
    b.spent_this_period_cents = 0;
  }
  return b;
}

// ----------------------------------------------------------------------------
// Exported helpers: recordCost(pool, {...}), canSpend(pool, did, additional)
// ----------------------------------------------------------------------------
async function recordCost(pool, opts) {
  const {
    agent_did, operator_did = null, customer_id = null, resource_type, provider = null,
    amount_cents, currency = 'USD', units = null, unit_type = null,
    tags = null, reference_id = null, auditChain = null
  } = opts;
  if (!agent_did || !resource_type || amount_cents == null) {
    throw new Error('agent_did, resource_type, amount_cents required');
  }

  // Idempotency on reference_id if provided
  if (reference_id) {
    const ex = await pool.query(
      `SELECT event_id, amount_cents FROM cost_events WHERE reference_id=$1 AND agent_did=$2 LIMIT 1`,
      [reference_id, agent_did]
    ).catch(() => ({ rows: [] }));
    if (ex.rows[0]) return { event_id: ex.rows[0].event_id, deduped: true };
  }

  const eventId = 'cost_' + cryptoLib.randomBytes(12).toString('hex');
  const amt = BigInt(Math.round(Number(amount_cents)));
  await pool.query(
    `INSERT INTO cost_events
     (event_id, agent_did, operator_did, customer_id, resource_type, provider,
      amount_cents, currency, units, unit_type, tags, reference_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12)`,
    [eventId, agent_did, operator_did, customer_id, resource_type, provider,
     amt.toString(), currency, units, unit_type,
     tags ? JSON.stringify(tags) : null, reference_id]
  );

  // Bump budget if exists
  await rolloverIfNeeded(pool, agent_did);
  await pool.query(
    `UPDATE cost_budgets SET spent_this_period_cents = spent_this_period_cents + $2,
                              updated_at = NOW()
     WHERE agent_did = $1`,
    [agent_did, amt.toString()]
  ).catch(() => {});

  // Check alert thresholds
  const b = await getBudget(pool, agent_did);
  if (b && b.monthly_cap_cents) {
    const spent = BigInt(b.spent_this_period_cents);
    const cap = BigInt(b.monthly_cap_cents);
    const pct = cap > 0n ? Number((spent * 100n) / cap) : 0;
    for (const threshold of (b.alert_thresholds || [50, 75, 90, 100])) {
      if (pct >= threshold) {
        const alertId = 'alert_' + cryptoLib.randomBytes(8).toString('hex');
        const ins = await pool.query(
          `INSERT INTO cost_alerts_fired
           (alert_id, agent_did, period_start, threshold_pct, spent_cents, cap_cents, webhook_url)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (agent_did, period_start, threshold_pct) DO NOTHING
           RETURNING alert_id`,
          [alertId, agent_did, b.period_start, threshold,
           spent.toString(), cap.toString(), b.alert_webhook_url]
        ).catch(() => ({ rows: [] }));

        if (ins.rows[0] && b.alert_webhook_url) {
          try {
            const resp = await fetch(b.alert_webhook_url, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                event: 'cost.threshold_crossed',
                agent_did, threshold_pct: threshold,
                spent_cents: spent.toString(), cap_cents: cap.toString(),
                period_start: b.period_start
              })
            });
            await pool.query(
              `UPDATE cost_alerts_fired SET webhook_status=$2 WHERE alert_id=$1`,
              [ins.rows[0].alert_id, `http_${resp.status}`]
            ).catch(() => {});
          } catch (e) {
            await pool.query(
              `UPDATE cost_alerts_fired SET webhook_status=$2 WHERE alert_id=$1`,
              [ins.rows[0].alert_id, `error_${e.message.slice(0, 60)}`]
            ).catch(() => {});
          }
        }
        if (auditChain) {
          await auditChain.append({
            event_type: 'cost.threshold_crossed',
            agent_did, threshold_pct: threshold,
            spent_cents: spent.toString(), cap_cents: cap.toString(),
            timestamp: new Date().toISOString()
          });
        }
      }
    }
  }

  if (auditChain) {
    await auditChain.append({
      event_type: 'cost.event_recorded',
      event_id: eventId, agent_did, resource_type, provider,
      amount_cents: amt.toString(), currency,
      timestamp: new Date().toISOString()
    });
  }

  return {
    event_id: eventId, agent_did, resource_type, provider,
    amount_cents: amt.toString(), currency
  };
}

async function canSpend(pool, did, additional_cents) {
  const b = await rolloverIfNeeded(pool, did);
  if (!b) return { ok: true };
  if (b.paused) return { ok: false, reason: 'budget_paused' };
  if (!b.monthly_cap_cents) return { ok: true };
  const spent = BigInt(b.spent_this_period_cents);
  const cap = BigInt(b.monthly_cap_cents);
  const add = BigInt(Math.round(Number(additional_cents || 0)));
  if (b.hard_cap && (spent + add) > cap) {
    return {
      ok: false, reason: 'hard_cap_exceeded',
      spent_cents: spent.toString(), cap_cents: cap.toString(),
      additional_cents: add.toString()
    };
  }
  return {
    ok: true,
    spent_cents: spent.toString(), cap_cents: cap.toString(),
    pct: cap > 0n ? Number((spent * 100n) / cap) : 0
  };
}

// ----------------------------------------------------------------------------
// Routes
// ----------------------------------------------------------------------------
function registerCostRoutes(app, pool, verifyAgentAuth, auditChain) {
  const EventSchema = z.object({
    operator_did: z.string().optional(),
    customer_id: z.string().optional(),
    resource_type: z.string().min(1).max(128),
    provider: z.string().max(128).optional(),
    amount_cents: z.number().int(),
    currency: z.string().length(3).default('USD'),
    units: z.number().optional(),
    unit_type: z.string().max(64).optional(),
    tags: z.record(z.any()).optional(),
    reference_id: z.string().max(256).optional()
  });

  app.post('/v1/agents/:did/cost/event', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const parse = EventSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });

      const idemKey = req.headers['x-idempotency-key'];
      if (idemKey) {
        const cached = await pool.query(
          `SELECT response FROM cost_idempotency WHERE agent_did=$1 AND idem_key=$2`,
          [did, idemKey]
        ).catch(() => ({ rows: [] }));
        if (cached.rows[0]) return res.json(cached.rows[0].response);
      }

      const result = await recordCost(pool, {
        agent_did: did, ...parse.data, auditChain
      });

      if (idemKey) {
        await pool.query(
          `INSERT INTO cost_idempotency (agent_did, idem_key, response)
           VALUES ($1, $2, $3::jsonb) ON CONFLICT DO NOTHING`,
          [did, idemKey, JSON.stringify(result)]
        ).catch(() => {});
      }

      return res.status(201).json(result);
    } catch (e) {
      console.error('[cost.event]', e);
      return res.status(500).json({ error: 'event_failed', message: e.message });
    }
  });

  app.get('/v1/agents/:did/cost/summary', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });

    const period = req.query.period || 'month';
    const intervalSql = period === 'day' ? "1 day"
                      : period === 'week' ? "7 days"
                      : period === 'year' ? "1 year"
                      : "1 month";

    const totalR = await pool.query(
      `SELECT COALESCE(SUM(amount_cents), 0) AS total, COUNT(*) AS n
       FROM cost_events
       WHERE agent_did=$1 AND created_at >= NOW() - INTERVAL '${intervalSql}'`,
      [did]
    ).catch(() => ({ rows: [{ total: 0, n: 0 }] }));

    const byResource = await pool.query(
      `SELECT resource_type, provider,
              COALESCE(SUM(amount_cents), 0) AS amount_cents,
              COUNT(*) AS events
       FROM cost_events
       WHERE agent_did=$1 AND created_at >= NOW() - INTERVAL '${intervalSql}'
       GROUP BY resource_type, provider
       ORDER BY SUM(amount_cents) DESC LIMIT 100`,
      [did]
    ).catch(() => ({ rows: [] }));

    const budget = await rolloverIfNeeded(pool, did);

    return res.json({
      agent_did: did, period,
      total_cents: String(totalR.rows[0].total),
      events: parseInt(totalR.rows[0].n),
      by_resource: byResource.rows.map(r => ({
        resource_type: r.resource_type,
        provider: r.provider,
        amount_cents: String(r.amount_cents),
        events: parseInt(r.events)
      })),
      budget: budget ? {
        monthly_cap_cents: budget.monthly_cap_cents ? String(budget.monthly_cap_cents) : null,
        spent_this_period_cents: String(budget.spent_this_period_cents),
        period_start: budget.period_start,
        hard_cap: budget.hard_cap, paused: budget.paused
      } : null
    });
  });

  app.get('/v1/agents/:did/cost/timeseries', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });

    const granularity = req.query.granularity || 'day';
    const lookback = req.query.lookback || '30 days';

    const validGran = ['hour', 'day', 'week', 'month'].includes(granularity)
      ? granularity : 'day';
    // sanitise lookback
    const validLookback = /^[0-9]+ (hour|day|week|month|year)s?$/.test(lookback)
      ? lookback : '30 days';

    const r = await pool.query(
      `SELECT date_trunc('${validGran}', created_at) AS bucket,
              COALESCE(SUM(amount_cents), 0) AS amount_cents,
              COUNT(*) AS events
       FROM cost_events
       WHERE agent_did=$1 AND created_at >= NOW() - INTERVAL '${validLookback}'
       GROUP BY bucket ORDER BY bucket ASC`,
      [did]
    ).catch(() => ({ rows: [] }));

    return res.json({
      agent_did: did, granularity: validGran, lookback: validLookback,
      series: r.rows.map(row => ({
        bucket: row.bucket,
        amount_cents: String(row.amount_cents),
        events: parseInt(row.events)
      }))
    });
  });

  const BudgetSchema = z.object({
    monthly_cap_cents: z.number().int().nonnegative().nullable().optional(),
    hard_cap: z.boolean().optional(),
    alert_thresholds: z.array(z.number().int().min(1).max(1000)).optional(),
    alert_webhook_url: z.string().url().nullable().optional(),
    paused: z.boolean().optional()
  });

  app.post('/v1/agents/:did/cost/budget', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const parse = BudgetSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;

      await pool.query(
        `INSERT INTO cost_budgets
         (agent_did, monthly_cap_cents, hard_cap, alert_thresholds, alert_webhook_url,
          period_start, spent_this_period_cents, paused, created_at, updated_at)
         VALUES ($1, $2, COALESCE($3, FALSE),
                 COALESCE($4::int[], ARRAY[50,75,90,100]::int[]),
                 $5,
                 date_trunc('month', NOW()), 0,
                 COALESCE($6, FALSE), NOW(), NOW())
         ON CONFLICT (agent_did) DO UPDATE SET
           monthly_cap_cents = COALESCE($2, cost_budgets.monthly_cap_cents),
           hard_cap          = COALESCE($3, cost_budgets.hard_cap),
           alert_thresholds  = COALESCE($4::int[], cost_budgets.alert_thresholds),
           alert_webhook_url = COALESCE($5, cost_budgets.alert_webhook_url),
           paused            = COALESCE($6, cost_budgets.paused),
           updated_at        = NOW()`,
        [did,
         d.monthly_cap_cents ?? null,
         d.hard_cap ?? null,
         d.alert_thresholds ?? null,
         d.alert_webhook_url ?? null,
         d.paused ?? null]
      );

      await auditChain.append({
        event_type: 'cost.budget_updated',
        agent_did: did, fields: Object.keys(d),
        timestamp: new Date().toISOString()
      });

      const b = await getBudget(pool, did);
      return res.json({
        ...b,
        monthly_cap_cents: b.monthly_cap_cents != null ? String(b.monthly_cap_cents) : null,
        spent_this_period_cents: String(b.spent_this_period_cents)
      });
    } catch (e) {
      console.error('[cost.budget.set]', e);
      return res.status(500).json({ error: 'budget_update_failed', message: e.message });
    }
  });

  app.get('/v1/agents/:did/cost/budget', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const b = await rolloverIfNeeded(pool, did);
    if (!b) return res.json({ agent_did: did, budget: null });
    return res.json({
      ...b,
      monthly_cap_cents: b.monthly_cap_cents != null ? String(b.monthly_cap_cents) : null,
      spent_this_period_cents: String(b.spent_this_period_cents)
    });
  });
}

module.exports = {
  migrate,
  registerCostRoutes,
  recordCost,
  canSpend,
  getBudget,
  rolloverIfNeeded,
  periodStart
};
