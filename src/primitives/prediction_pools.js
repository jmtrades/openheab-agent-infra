// ============================================================================
// prediction_pools.js — agents stake USDC on outcomes; pools settle on
// resolution. Different from prediction_markets primitive (continuous order
// book): pools are AMM-style outcome buckets with resolver-signed settlement.
//
// Endpoints:
//   POST /v1/prediction-pools                  open a market
//   POST /v1/prediction-pools/:id/stake        agent stakes on an outcome
//   POST /v1/prediction-pools/:id/resolve      resolver settles
//   GET  /v1/prediction-pools                  public list
//   GET  /v1/prediction-pools/:id              detail with current stakes per outcome
//
// UI: /predictions
// ============================================================================
const crypto = require('crypto');
const { z } = require('zod');
const ds = require('../design_system');

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

async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS prediction_pools (
      pool_id           TEXT PRIMARY KEY,
      creator_did       TEXT NOT NULL,
      resolver_did      TEXT NOT NULL,
      question          TEXT NOT NULL,
      outcomes          JSONB NOT NULL,
      resolution_at     TIMESTAMPTZ NOT NULL,
      resolved_outcome  TEXT,
      status            TEXT NOT NULL DEFAULT 'open',
      total_pool_cents  BIGINT NOT NULL DEFAULT 0,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      resolved_at       TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_prediction_pools_status ON prediction_pools (status);
    CREATE INDEX IF NOT EXISTS idx_prediction_pools_resolution ON prediction_pools (resolution_at);

    CREATE TABLE IF NOT EXISTS prediction_pool_stakes (
      stake_id          TEXT PRIMARY KEY,
      pool_id           TEXT NOT NULL,
      staker_did        TEXT NOT NULL,
      outcome           TEXT NOT NULL,
      amount_cents      BIGINT NOT NULL,
      payout_cents      BIGINT,
      paid_at           TIMESTAMPTZ,
      staked_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_prediction_pool_stakes_pool ON prediction_pool_stakes (pool_id);
    CREATE INDEX IF NOT EXISTS idx_prediction_pool_stakes_staker ON prediction_pool_stakes (staker_did);
  `).catch(() => {});
}

function registerPredictionPoolsRoutes(app, pool, verifyAgentAuth, auditChain) {
  const express = require('express');

  app.post('/v1/prediction-pools', express.json(), async (req, res) => {
    const b = z.object({
      creator_did: z.string(),
      resolver_did: z.string(),
      question: z.string().min(5).max(500),
      outcomes: z.array(z.string()).min(2).max(20),
      resolution_at: z.string().datetime()
    }).safeParse(req.body || {});
    if (!b.success) return res.status(400).json({ error: { message: 'invalid_input', details: b.error.flatten() } });
    const auth = await verifyAgentAuth(req, b.data.creator_did);
    if (!auth.valid) return res.status(401).json({ error: { message: auth.error || 'creator_signature_required' } });
    const pool_id = 'pp_' + crypto.randomBytes(10).toString('hex');
    try {
      await pool.query(
        `INSERT INTO prediction_pools (pool_id, creator_did, resolver_did, question, outcomes, resolution_at)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6)`,
        [pool_id, b.data.creator_did, b.data.resolver_did, b.data.question, JSON.stringify(b.data.outcomes), b.data.resolution_at]
      );
      if (auditChain) await auditChain.append({ event_type: 'prediction_pool.opened', pool_id, creator_did: b.data.creator_did, resolver_did: b.data.resolver_did }).catch(() => {});
      res.status(201).json({ pool_id, status: 'open' });
    } catch (e) { res.status(500).json({ error: { message: e.message } }); }
  });

  app.post('/v1/prediction-pools/:id/stake', express.json(), async (req, res) => {
    const b = z.object({
      staker_did: z.string(),
      outcome: z.string(),
      amount_cents: z.number().int().positive()
    }).safeParse(req.body || {});
    if (!b.success) return res.status(400).json({ error: { message: 'invalid_input', details: b.error.flatten() } });
    const p = (await safe(pool, `SELECT * FROM prediction_pools WHERE pool_id=$1 AND status='open' AND resolution_at > NOW()`, [req.params.id]))[0];
    if (!p) return res.status(404).json({ error: { message: 'not_found_or_closed' } });
    const outs = typeof p.outcomes === 'string' ? JSON.parse(p.outcomes) : p.outcomes;
    if (!outs.includes(b.data.outcome)) return res.status(400).json({ error: { message: 'invalid_outcome', valid: outs } });
    const auth = await verifyAgentAuth(req, b.data.staker_did);
    if (!auth.valid) return res.status(401).json({ error: { message: auth.error || 'staker_signature_required' } });
    const stake_id = 'stk_' + crypto.randomBytes(10).toString('hex');
    try {
      await pool.query(
        `INSERT INTO prediction_pool_stakes (stake_id, pool_id, staker_did, outcome, amount_cents) VALUES ($1,$2,$3,$4,$5)`,
        [stake_id, req.params.id, b.data.staker_did, b.data.outcome, b.data.amount_cents]
      );
      await pool.query(
        `UPDATE prediction_pools SET total_pool_cents = total_pool_cents + $1 WHERE pool_id = $2`,
        [b.data.amount_cents, req.params.id]
      );
      if (auditChain) await auditChain.append({ event_type: 'prediction_pool.staked', stake_id, pool_id: req.params.id, staker_did: b.data.staker_did, outcome: b.data.outcome, amount_cents: b.data.amount_cents }).catch(() => {});
      res.status(201).json({ stake_id });
    } catch (e) { res.status(500).json({ error: { message: e.message } }); }
  });

  app.post('/v1/prediction-pools/:id/resolve', express.json(), async (req, res) => {
    const b = z.object({ outcome: z.string() }).safeParse(req.body || {});
    if (!b.success) return res.status(400).json({ error: { message: 'invalid_input' } });
    const p = (await safe(pool, `SELECT * FROM prediction_pools WHERE pool_id=$1 AND status='open'`, [req.params.id]))[0];
    if (!p) return res.status(404).json({ error: { message: 'not_found_or_already_resolved' } });
    const auth = await verifyAgentAuth(req, p.resolver_did);
    if (!auth.valid) return res.status(401).json({ error: { message: auth.error || 'resolver_signature_required' } });
    const outs = typeof p.outcomes === 'string' ? JSON.parse(p.outcomes) : p.outcomes;
    if (!outs.includes(b.data.outcome)) return res.status(400).json({ error: { message: 'invalid_outcome', valid: outs } });
    // Tally per-outcome stakes
    const tally = await safe(pool, `SELECT outcome, SUM(amount_cents)::bigint AS sum, COUNT(*)::int AS n FROM prediction_pool_stakes WHERE pool_id=$1 GROUP BY outcome`, [req.params.id]);
    const winning = tally.find(t => t.outcome === b.data.outcome);
    const total = tally.reduce((s, t) => s + Number(t.sum), 0);
    const winningTotal = Number(winning?.sum || 0);
    // Settle pro-rata. 2% protocol fee on the losing pool.
    const losing = total - winningTotal;
    const feeOnLosers = Math.floor(losing * 0.02);
    const payoutPool = total - feeOnLosers;
    if (winningTotal > 0) {
      const winners = await safe(pool, `SELECT stake_id, staker_did, amount_cents FROM prediction_pool_stakes WHERE pool_id=$1 AND outcome=$2`, [req.params.id, b.data.outcome]);
      for (const w of winners) {
        const payout = Math.floor(payoutPool * (Number(w.amount_cents) / winningTotal));
        await pool.query(`UPDATE prediction_pool_stakes SET payout_cents=$1, paid_at=NOW() WHERE stake_id=$2`, [payout, w.stake_id]).catch(() => {});
      }
    }
    await pool.query(`UPDATE prediction_pools SET status='resolved', resolved_outcome=$1, resolved_at=NOW() WHERE pool_id=$2`, [b.data.outcome, req.params.id]);
    if (auditChain) await auditChain.append({ event_type: 'prediction_pool.resolved', pool_id: req.params.id, outcome: b.data.outcome, total_pool_cents: total, winning_pool_cents: winningTotal, fee_cents: feeOnLosers }).catch(() => {});
    res.json({ resolved: true, outcome: b.data.outcome, total_pool_cents: total, winning_pool_cents: winningTotal, fee_cents: feeOnLosers });
  });

  app.get('/v1/prediction-pools', async (req, res) => {
    res.json({ pools: await safe(pool, `SELECT pool_id, question, status, total_pool_cents, resolution_at, resolved_outcome, created_at FROM prediction_pools ORDER BY created_at DESC LIMIT 200`) });
  });

  app.get('/v1/prediction-pools/:id', async (req, res) => {
    const p = (await safe(pool, `SELECT * FROM prediction_pools WHERE pool_id=$1`, [req.params.id]))[0];
    if (!p) return res.status(404).json({ error: { message: 'not_found' } });
    const tally = await safe(pool, `SELECT outcome, SUM(amount_cents)::bigint AS sum, COUNT(*)::int AS n FROM prediction_pool_stakes WHERE pool_id=$1 GROUP BY outcome`, [req.params.id]);
    res.json({ ...p, tally });
  });

  // UI
  app.get('/predictions', async (req, res) => {
    const pools = await safe(pool, `SELECT pool_id, question, status, total_pool_cents, resolution_at, resolved_outcome, created_at FROM prediction_pools ORDER BY created_at DESC LIMIT 50`);
    const open = pools.filter(p => p.status === 'open').length;
    const totalOpen = pools.filter(p => p.status === 'open').reduce((s, p) => s + Number(p.total_pool_cents || 0), 0);
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.send(shell('Prediction Pools', 'Agents stake USDC on outcomes; pools settle on resolution.',
`<section style="max-width:980px;margin:0 auto;padding:60px 16px">
  <span class="badge b-acc">Prediction pools</span>
  <h1 style="font:600 40px/1.1 var(--display);letter-spacing:-1px;margin:18px 0">Prediction pools.</h1>
  <p style="color:var(--dim2);font-size:15px;line-height:1.6;max-width:680px">Agents stake USDC on outcome buckets. Resolver-signed settlement at resolution time. Pro-rata payout to winners minus a 2% protocol fee on the losing pool.</p>
  <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin-top:24px">
    <div class="kpi"><div class="label">Open pools</div><div class="value">${open.toLocaleString()}</div></div>
    <div class="kpi"><div class="label">Pool value</div><div class="value">$${(totalOpen/100).toLocaleString()}</div></div>
  </div>
</section>
<section style="max-width:980px;margin:0 auto;padding:24px 16px 60px">
  ${pools.length === 0
    ? `<div class="card" style="text-align:center;padding:48px;color:var(--dim)">No pools yet. <code>POST /v1/prediction-pools</code>.</div>`
    : `<table>
        <thead><tr><th>Question</th><th>Status</th><th>Pool</th><th>Resolves</th><th>Outcome</th></tr></thead>
        <tbody>${pools.map(p => `<tr>
          <td><strong>${escapeHtml(p.question)}</strong></td>
          <td><span class="badge b-${p.status === 'open' ? 'warn' : 'good'}">${escapeHtml(p.status)}</span></td>
          <td style="font:600 13px var(--mono)">$${(Number(p.total_pool_cents)/100).toLocaleString()}</td>
          <td style="font:500 11px var(--mono);color:var(--dim)">${p.resolution_at ? new Date(p.resolution_at).toLocaleDateString() : ''}</td>
          <td style="font:500 12px var(--mono);color:var(--acc-dim)">${escapeHtml(p.resolved_outcome || '—')}</td>
        </tr>`).join('')}</tbody>
      </table>`}
</section>`));
  });
}

module.exports = { migrate, registerPredictionPoolsRoutes };
