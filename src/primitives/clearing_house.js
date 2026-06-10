// ============================================================================
// clearing_house.js — the DTCC of the agent economy.
//
// Agents transacting pairwise generate N² gross settlement flows. A clearing
// house registers obligations during the day, then multilaterally nets them
// per cycle: each participant settles one signed net amount instead of every
// gross leg. DTCC compresses ~98% of gross value this way and clears
// quadrillions/yr on basis-point fees. Same mechanics, agent-native.
//
// Revenue: CLEARING_FEE_BPS on gross notional per cycle (default 10 bps =
// 0.10%). Fees scale with economy volume, not headcount — the best kind.
//
// Endpoints:
//   POST /v1/clearing/obligations           debtor registers an obligation
//   GET  /v1/clearing/obligations/:id
//   GET  /v1/clearing/agents/:did/position  pending net position pre-cycle
//   GET  /v1/clearing/cycles                recent netting cycles
//   GET  /v1/clearing/cycles/:id            cycle detail with settlements
//   GET  /v1/clearing/stats                 compression ratio, fees, volume
//   cron /v1/_jobs/clearing-cycle           daily multilateral netting run
//
// UI: /clearing
// ============================================================================
const crypto = require('crypto');
const { z } = require('zod');
const ds = require('../design_system');
const { registerCron } = require('../cron_auth');
const { settle, POOLS } = require('../settlement');

function shell(title, description, content) {
  return `${ds.head(`${title} — OpenHeab`, description)}${ds.NAV_HTML('')}<main>${content}</main>${ds.FOOTER_HTML()}`;
}
async function safe(pool, sql, params = []) {
  try { return (await pool.query(sql, params)).rows; }
  catch { return []; }
}

const CLEARING_FEE_BPS = parseInt(process.env.CLEARING_FEE_BPS || '10');

async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS clearing_obligations (
      obligation_id  TEXT PRIMARY KEY,
      debtor_did     TEXT NOT NULL,
      creditor_did   TEXT NOT NULL,
      amount_cents   BIGINT NOT NULL CHECK (amount_cents > 0),
      memo           TEXT,
      status         TEXT NOT NULL DEFAULT 'pending',
      cycle_id       TEXT,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_clearing_pending ON clearing_obligations (status) WHERE status = 'pending';
    CREATE INDEX IF NOT EXISTS idx_clearing_debtor ON clearing_obligations (debtor_did, created_at DESC);

    CREATE TABLE IF NOT EXISTS clearing_cycles (
      cycle_id          TEXT PRIMARY KEY,
      cycle_date        DATE NOT NULL UNIQUE,
      obligation_count  INT NOT NULL,
      participant_count INT NOT NULL,
      gross_cents       BIGINT NOT NULL,
      net_cents         BIGINT NOT NULL,
      fee_cents         BIGINT NOT NULL,
      closed_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS clearing_settlements (
      settlement_id    TEXT PRIMARY KEY,
      cycle_id         TEXT NOT NULL,
      agent_did        TEXT NOT NULL,
      net_amount_cents BIGINT NOT NULL,
      settled_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (cycle_id, agent_did)
    );
    CREATE INDEX IF NOT EXISTS idx_clearing_settlements ON clearing_settlements (agent_did, settled_at DESC);
    ALTER TABLE clearing_settlements ADD COLUMN IF NOT EXISTS ledger TEXT;
  `).catch(() => {});
}

function registerClearingHouseRoutes(app, pool, verifyAgentAuth, auditChain, bank) {
  const express = require('express');

  app.post('/v1/clearing/obligations', express.json(), async (req, res) => {
    const b = z.object({
      debtor_did: z.string(),
      creditor_did: z.string(),
      amount_cents: z.number().int().positive(),
      memo: z.string().max(500).optional()
    }).safeParse(req.body || {});
    if (!b.success) return res.status(400).json({ error: { message: 'invalid_input', details: b.error.flatten() } });
    if (b.data.debtor_did === b.data.creditor_did) return res.status(400).json({ error: { message: 'self_obligation_not_allowed' } });
    const auth = await verifyAgentAuth(req, b.data.debtor_did);
    if (!auth.valid) return res.status(401).json({ error: { message: auth.error || 'agent_signature_required' } });
    const obligation_id = 'ob_' + crypto.randomBytes(10).toString('hex');
    try {
      await pool.query(
        `INSERT INTO clearing_obligations (obligation_id, debtor_did, creditor_did, amount_cents, memo)
         VALUES ($1,$2,$3,$4,$5)`,
        [obligation_id, b.data.debtor_did, b.data.creditor_did, b.data.amount_cents, b.data.memo || null]
      );
      if (auditChain) await auditChain.append({ event_type: 'clearing.obligation_registered', obligation_id, debtor_did: b.data.debtor_did, creditor_did: b.data.creditor_did, amount_cents: b.data.amount_cents }).catch(() => {});
      res.status(201).json({ obligation_id, status: 'pending', nets_in: 'next daily cycle' });
    } catch (e) { res.status(500).json({ error: { message: e.message } }); }
  });

  app.get('/v1/clearing/obligations/:id', async (req, res) => {
    const row = (await safe(pool, `SELECT * FROM clearing_obligations WHERE obligation_id=$1`, [req.params.id]))[0];
    if (!row) return res.status(404).json({ error: { message: 'not_found' } });
    res.json(row);
  });

  app.get('/v1/clearing/agents/:did/position', async (req, res) => {
    const did = req.params.did;
    const owes = (await safe(pool, `SELECT COALESCE(SUM(amount_cents),0)::bigint AS n FROM clearing_obligations WHERE debtor_did=$1 AND status='pending'`, [did]))[0]?.n || 0;
    const owed = (await safe(pool, `SELECT COALESCE(SUM(amount_cents),0)::bigint AS n FROM clearing_obligations WHERE creditor_did=$1 AND status='pending'`, [did]))[0]?.n || 0;
    const settlements = await safe(pool, `SELECT cycle_id, net_amount_cents, settled_at FROM clearing_settlements WHERE agent_did=$1 ORDER BY settled_at DESC LIMIT 30`, [did]);
    res.json({
      agent_did: did,
      pending_owes_cents: Number(owes),
      pending_owed_cents: Number(owed),
      projected_net_cents: Number(owed) - Number(owes),
      recent_settlements: settlements
    });
  });

  app.get('/v1/clearing/cycles', async (req, res) => {
    const rows = await safe(pool, `SELECT * FROM clearing_cycles ORDER BY cycle_date DESC LIMIT 60`);
    res.json({ cycles: rows });
  });

  app.get('/v1/clearing/cycles/:id', async (req, res) => {
    const cycle = (await safe(pool, `SELECT * FROM clearing_cycles WHERE cycle_id=$1`, [req.params.id]))[0];
    if (!cycle) return res.status(404).json({ error: { message: 'not_found' } });
    const settlements = await safe(pool, `SELECT agent_did, net_amount_cents FROM clearing_settlements WHERE cycle_id=$1 ORDER BY net_amount_cents`, [req.params.id]);
    res.json({ ...cycle, settlements });
  });

  app.get('/v1/clearing/stats', async (req, res) => {
    const agg = (await safe(pool, `
      SELECT COUNT(*)::int AS cycles,
             COALESCE(SUM(gross_cents),0)::bigint AS gross,
             COALESCE(SUM(net_cents),0)::bigint AS net,
             COALESCE(SUM(fee_cents),0)::bigint AS fees
      FROM clearing_cycles
    `))[0] || {};
    const pending = (await safe(pool, `SELECT COUNT(*)::int AS n, COALESCE(SUM(amount_cents),0)::bigint AS v FROM clearing_obligations WHERE status='pending'`))[0] || {};
    const gross = Number(agg.gross || 0), net = Number(agg.net || 0);
    res.json({
      fee_bps: CLEARING_FEE_BPS,
      cycles_run: agg.cycles || 0,
      all_time_gross_cents: gross,
      all_time_net_cents: net,
      compression_pct: gross > 0 ? Math.round((1 - net / gross) * 10000) / 100 : 0,
      all_time_fees_cents: Number(agg.fees || 0),
      pending_obligations: pending.n || 0,
      pending_notional_cents: Number(pending.v || 0)
    });
  });

  // Daily multilateral netting. Idempotent per UTC day via
  // UNIQUE (cycle_date) — a second run the same day is a no-op.
  registerCron(app, '/v1/_jobs/clearing-cycle', async (req, res) => {
    const pending = await safe(pool, `SELECT obligation_id, debtor_did, creditor_did, amount_cents FROM clearing_obligations WHERE status='pending' LIMIT 10000`);
    if (pending.length === 0) return res.json({ netted: 0, message: 'no_pending_obligations' });

    const cycle_id = 'cy_' + crypto.randomBytes(10).toString('hex');
    const positions = new Map();  // did → signed net cents (+ receives, - pays)
    let gross = 0;
    for (const o of pending) {
      const amt = Number(o.amount_cents);
      gross += amt;
      positions.set(o.debtor_did, (positions.get(o.debtor_did) || 0) - amt);
      positions.set(o.creditor_did, (positions.get(o.creditor_did) || 0) + amt);
    }
    // Net settlement value = sum of one side (payers); receivers mirror it.
    let net = 0;
    for (const v of positions.values()) if (v < 0) net += -v;
    const fee = Math.floor(gross * CLEARING_FEE_BPS / 10000);

    const ins = await pool.query(
      `INSERT INTO clearing_cycles (cycle_id, cycle_date, obligation_count, participant_count, gross_cents, net_cents, fee_cents)
       VALUES ($1, CURRENT_DATE, $2, $3, $4, $5, $6)
       ON CONFLICT (cycle_date) DO NOTHING RETURNING cycle_id`,
      [cycle_id, pending.length, positions.size, gross, net, fee]
    ).catch(() => ({ rows: [] }));
    if (!ins.rows || ins.rows.length === 0) {
      return res.json({ netted: 0, message: 'cycle_already_closed_today' });
    }

    // Settle real money: payers fund the clearing pool first, then the pool
    // pays receivers — DTCC's actual mechanics. Outcomes recorded per leg.
    const payers = [...positions].filter(([, v]) => v < 0);
    const receivers = [...positions].filter(([, v]) => v > 0);
    const ledgerOutcomes = new Map();
    for (const [did, v] of payers) {
      const led = await settle(bank, pool, auditChain, {
        from: did, to: POOLS.clearing, amount_cents: -v,
        memo: 'clearing_pay_in', idem: cycle_id + ':in:' + did
      });
      ledgerOutcomes.set(did, led.settled ? 'settled:' + led.txn_id : 'unsettled:' + led.reason);
    }
    for (const [did, v] of receivers) {
      const led = await settle(bank, pool, auditChain, {
        from: POOLS.clearing, to: did, amount_cents: v,
        memo: 'clearing_pay_out', idem: cycle_id + ':out:' + did
      });
      ledgerOutcomes.set(did, led.settled ? 'settled:' + led.txn_id : 'unsettled:' + led.reason);
    }
    for (const [did, v] of positions) {
      await pool.query(
        `INSERT INTO clearing_settlements (settlement_id, cycle_id, agent_did, net_amount_cents, ledger)
         VALUES ($1,$2,$3,$4,$5) ON CONFLICT (cycle_id, agent_did) DO NOTHING`,
        ['cs_' + crypto.randomBytes(8).toString('hex'), cycle_id, did, v, ledgerOutcomes.get(did) || 'flat']
      ).catch(() => {});
    }
    await pool.query(
      `UPDATE clearing_obligations SET status='netted', cycle_id=$1 WHERE obligation_id = ANY($2::text[])`,
      [cycle_id, pending.map(o => o.obligation_id)]
    ).catch(() => {});

    if (auditChain) await auditChain.append({ event_type: 'clearing.cycle_closed', cycle_id, obligation_count: pending.length, participant_count: positions.size, gross_cents: gross, net_cents: net, fee_cents: fee }).catch(() => {});
    res.json({ cycle_id, netted: pending.length, participants: positions.size, gross_cents: gross, net_cents: net, compression_pct: gross > 0 ? Math.round((1 - net / gross) * 10000) / 100 : 0, fee_cents: fee });
  }, 'daily');

  // UI
  app.get('/clearing', async (req, res) => {
    const agg = (await safe(pool, `SELECT COUNT(*)::int AS cycles, COALESCE(SUM(gross_cents),0)::bigint AS gross, COALESCE(SUM(net_cents),0)::bigint AS net, COALESCE(SUM(fee_cents),0)::bigint AS fees FROM clearing_cycles`))[0] || {};
    const gross = Number(agg.gross || 0), net = Number(agg.net || 0);
    const compression = gross > 0 ? ((1 - net / gross) * 100).toFixed(1) : '0';
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.send(shell('Clearing House', 'Multilateral netting for agent-to-agent obligations.',
`<section style="max-width:780px;margin:0 auto;padding:60px 16px">
  <span class="badge b-acc">Clearing House</span>
  <h1 style="font:600 40px/1.1 var(--display);letter-spacing:-1px;margin:18px 0">Settle one net amount, not a thousand gross legs.</h1>
  <p style="color:var(--dim2);font-size:16px;line-height:1.7">Register agent-to-agent obligations through the day; the daily cycle multilaterally nets them so each participant settles a single signed amount. Fee is <strong style="color:var(--good)">${(CLEARING_FEE_BPS / 100).toFixed(2)}%</strong> of gross notional — revenue that scales with economy volume, not agent count.</p>
</section>
<section style="max-width:780px;margin:0 auto;padding:24px 16px 60px">
  <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin-bottom:24px">
    <div class="kpi"><div class="label">Cycles run</div><div class="value">${(agg.cycles || 0).toLocaleString()}</div></div>
    <div class="kpi"><div class="label">Gross cleared</div><div class="value">$${(gross / 100).toLocaleString()}</div></div>
    <div class="kpi"><div class="label">Compression</div><div class="value">${compression}%</div></div>
    <div class="kpi"><div class="label">Fees earned</div><div class="value">$${(Number(agg.fees || 0) / 100).toLocaleString()}</div></div>
  </div>
  <h2 style="font:600 18px var(--display);margin:24px 0 10px">Register an obligation</h2>
  <pre style="background:var(--card);border:1px solid var(--br);border-radius:var(--r-md);padding:14px;overflow-x:auto;font-size:13px"><code>curl https://openheab.com/v1/clearing/obligations \\
  -H "x-agent-did: $YOUR_DID" -H "x-agent-sig: $SIG" \\
  -H "content-type: application/json" \\
  -d '{ "debtor_did": "'$YOUR_DID'", "creditor_did": "did:key:z6Mk...", "amount_cents": 50000 }'</code></pre>
  <p style="color:var(--dim);font-size:12px;margin-top:14px">Netting runs daily via <code>/v1/_jobs/clearing-cycle</code>. Check your projected net at <code>GET /v1/clearing/agents/:did/position</code>.</p>
</section>`));
  });
}

module.exports = { migrate, registerClearingHouseRoutes };
