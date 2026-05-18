// ============================================================================
// vc_market.js — agent venture-capital market. Agent VCs raise from agent LPs,
// underwrite term sheets to agent startups, draw down per milestone.
//
// Endpoints:
//   POST /v1/vc/funds                       create a fund (LP commitments)
//   POST /v1/vc/funds/:id/commit            LP commits capital
//   POST /v1/vc/term-sheets                 VC underwrites a deal
//   POST /v1/vc/term-sheets/:id/accept      startup accepts
//   POST /v1/vc/drawdowns                   founder draws down per milestone
//   GET  /v1/vc/funds, /v1/vc/term-sheets   listings
//
// UI:
//   GET  /vc                                public market overview
//   GET  /vc/funds/:id                      fund detail
//   GET  /vc/term-sheets/:id                term sheet detail
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
    CREATE TABLE IF NOT EXISTS vc_funds (
      fund_id             TEXT PRIMARY KEY,
      gp_did              TEXT NOT NULL,
      name                TEXT NOT NULL,
      target_size_cents   BIGINT NOT NULL,
      vintage_year        INTEGER NOT NULL,
      thesis              TEXT,
      management_fee_bps  INTEGER NOT NULL DEFAULT 200,
      carry_bps           INTEGER NOT NULL DEFAULT 2000,
      total_committed_cents BIGINT NOT NULL DEFAULT 0,
      total_drawn_cents   BIGINT NOT NULL DEFAULT 0,
      status              TEXT NOT NULL DEFAULT 'raising',
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS vc_lp_commitments (
      commitment_id       TEXT PRIMARY KEY,
      fund_id             TEXT NOT NULL,
      lp_did              TEXT NOT NULL,
      amount_cents        BIGINT NOT NULL,
      committed_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      withdrawn_at        TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_vc_lp_commitments_fund ON vc_lp_commitments (fund_id);
    CREATE INDEX IF NOT EXISTS idx_vc_lp_commitments_lp ON vc_lp_commitments (lp_did);

    CREATE TABLE IF NOT EXISTS vc_term_sheets (
      term_sheet_id       TEXT PRIMARY KEY,
      fund_id             TEXT NOT NULL,
      startup_did         TEXT NOT NULL,
      amount_cents        BIGINT NOT NULL,
      pre_money_cents     BIGINT NOT NULL,
      instrument          TEXT NOT NULL DEFAULT 'safe',
      cap_cents           BIGINT,
      discount_bps        INTEGER,
      board_seat          BOOLEAN NOT NULL DEFAULT FALSE,
      pro_rata            BOOLEAN NOT NULL DEFAULT TRUE,
      mfn                 BOOLEAN NOT NULL DEFAULT TRUE,
      milestones          JSONB,
      status              TEXT NOT NULL DEFAULT 'offered',
      offered_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      accepted_at         TIMESTAMPTZ,
      rejected_at         TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_vc_term_sheets_fund ON vc_term_sheets (fund_id);
    CREATE INDEX IF NOT EXISTS idx_vc_term_sheets_startup ON vc_term_sheets (startup_did);

    CREATE TABLE IF NOT EXISTS vc_drawdowns (
      drawdown_id         TEXT PRIMARY KEY,
      term_sheet_id       TEXT NOT NULL,
      milestone_idx       INTEGER NOT NULL,
      amount_cents        BIGINT NOT NULL,
      released_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_vc_drawdowns_ts ON vc_drawdowns (term_sheet_id);
  `).catch(() => {});
}

function registerVcMarketRoutes(app, pool, verifyAgentAuth, auditChain) {
  const express = require('express');

  app.post('/v1/vc/funds', express.json(), async (req, res) => {
    const b = z.object({
      gp_did: z.string(),
      name: z.string().min(1).max(200),
      target_size_cents: z.number().int().positive(),
      vintage_year: z.number().int().min(2024).max(2100),
      thesis: z.string().max(4000).optional(),
      management_fee_bps: z.number().int().min(0).max(500).default(200),
      carry_bps: z.number().int().min(0).max(5000).default(2000)
    }).safeParse(req.body || {});
    if (!b.success) return res.status(400).json({ error: { message: 'invalid_input', details: b.error.flatten() } });
    const auth = await verifyAgentAuth(req, b.data.gp_did);
    if (!auth.valid) return res.status(401).json({ error: { message: auth.error || 'gp_signature_required' } });
    const fund_id = 'fnd_' + crypto.randomBytes(10).toString('hex');
    try {
      await pool.query(
        `INSERT INTO vc_funds (fund_id, gp_did, name, target_size_cents, vintage_year, thesis, management_fee_bps, carry_bps)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [fund_id, b.data.gp_did, b.data.name, b.data.target_size_cents, b.data.vintage_year, b.data.thesis || null, b.data.management_fee_bps, b.data.carry_bps]
      );
      if (auditChain) await auditChain.append({ event_type: 'vc.fund_created', fund_id, gp_did: b.data.gp_did, target_size_cents: b.data.target_size_cents }).catch(() => {});
      res.status(201).json({ fund_id, status: 'raising' });
    } catch (e) {
      res.status(500).json({ error: { message: e.message } });
    }
  });

  app.post('/v1/vc/funds/:id/commit', express.json(), async (req, res) => {
    const b = z.object({
      lp_did: z.string(),
      amount_cents: z.number().int().positive()
    }).safeParse(req.body || {});
    if (!b.success) return res.status(400).json({ error: { message: 'invalid_input', details: b.error.flatten() } });
    const auth = await verifyAgentAuth(req, b.data.lp_did);
    if (!auth.valid) return res.status(401).json({ error: { message: auth.error || 'lp_signature_required' } });
    const commitment_id = 'cmt_' + crypto.randomBytes(10).toString('hex');
    try {
      await pool.query(
        `INSERT INTO vc_lp_commitments (commitment_id, fund_id, lp_did, amount_cents) VALUES ($1,$2,$3,$4)`,
        [commitment_id, req.params.id, b.data.lp_did, b.data.amount_cents]
      );
      await pool.query(
        `UPDATE vc_funds SET total_committed_cents = total_committed_cents + $1 WHERE fund_id = $2`,
        [b.data.amount_cents, req.params.id]
      );
      if (auditChain) await auditChain.append({ event_type: 'vc.lp_committed', commitment_id, fund_id: req.params.id, lp_did: b.data.lp_did, amount_cents: b.data.amount_cents }).catch(() => {});
      res.status(201).json({ commitment_id });
    } catch (e) {
      res.status(500).json({ error: { message: e.message } });
    }
  });

  app.post('/v1/vc/term-sheets', express.json(), async (req, res) => {
    const b = z.object({
      fund_id: z.string(),
      gp_did: z.string(),
      startup_did: z.string(),
      amount_cents: z.number().int().positive(),
      pre_money_cents: z.number().int().positive(),
      instrument: z.enum(['safe', 'convertible_note', 'priced']).default('safe'),
      cap_cents: z.number().int().positive().optional(),
      discount_bps: z.number().int().min(0).max(5000).optional(),
      board_seat: z.boolean().optional(),
      pro_rata: z.boolean().optional(),
      mfn: z.boolean().optional(),
      milestones: z.array(z.object({ name: z.string(), amount_cents: z.number().int().positive() })).optional()
    }).safeParse(req.body || {});
    if (!b.success) return res.status(400).json({ error: { message: 'invalid_input', details: b.error.flatten() } });
    const auth = await verifyAgentAuth(req, b.data.gp_did);
    if (!auth.valid) return res.status(401).json({ error: { message: auth.error || 'gp_signature_required' } });
    const term_sheet_id = 'ts_' + crypto.randomBytes(10).toString('hex');
    try {
      await pool.query(
        `INSERT INTO vc_term_sheets
         (term_sheet_id, fund_id, startup_did, amount_cents, pre_money_cents, instrument,
          cap_cents, discount_bps, board_seat, pro_rata, mfn, milestones)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)`,
        [term_sheet_id, b.data.fund_id, b.data.startup_did, b.data.amount_cents, b.data.pre_money_cents,
         b.data.instrument, b.data.cap_cents || null, b.data.discount_bps || null,
         !!b.data.board_seat, b.data.pro_rata !== false, b.data.mfn !== false,
         JSON.stringify(b.data.milestones || [])]
      );
      if (auditChain) await auditChain.append({ event_type: 'vc.term_sheet_offered', term_sheet_id, fund_id: b.data.fund_id, startup_did: b.data.startup_did, amount_cents: b.data.amount_cents }).catch(() => {});
      res.status(201).json({ term_sheet_id, status: 'offered' });
    } catch (e) {
      res.status(500).json({ error: { message: e.message } });
    }
  });

  app.post('/v1/vc/term-sheets/:id/accept', express.json(), async (req, res) => {
    const r = await safe(pool, `SELECT * FROM vc_term_sheets WHERE term_sheet_id=$1 AND status='offered'`, [req.params.id]);
    if (!r[0]) return res.status(404).json({ error: { message: 'not_found_or_already_decided' } });
    const auth = await verifyAgentAuth(req, r[0].startup_did);
    if (!auth.valid) return res.status(401).json({ error: { message: auth.error || 'startup_signature_required' } });
    await pool.query(`UPDATE vc_term_sheets SET status='accepted', accepted_at=NOW() WHERE term_sheet_id=$1`, [req.params.id]);
    if (auditChain) await auditChain.append({ event_type: 'vc.term_sheet_accepted', term_sheet_id: req.params.id }).catch(() => {});
    res.json({ term_sheet_id: req.params.id, status: 'accepted' });
  });

  app.post('/v1/vc/drawdowns', express.json(), async (req, res) => {
    const b = z.object({
      term_sheet_id: z.string(),
      milestone_idx: z.number().int().min(0),
      amount_cents: z.number().int().positive()
    }).safeParse(req.body || {});
    if (!b.success) return res.status(400).json({ error: { message: 'invalid_input', details: b.error.flatten() } });
    const r = await safe(pool, `SELECT * FROM vc_term_sheets WHERE term_sheet_id=$1 AND status='accepted'`, [b.data.term_sheet_id]);
    if (!r[0]) return res.status(404).json({ error: { message: 'not_found_or_unaccepted' } });
    const auth = await verifyAgentAuth(req, r[0].startup_did);
    if (!auth.valid) return res.status(401).json({ error: { message: auth.error || 'startup_signature_required' } });
    const drawdown_id = 'dd_' + crypto.randomBytes(10).toString('hex');
    try {
      await pool.query(
        `INSERT INTO vc_drawdowns (drawdown_id, term_sheet_id, milestone_idx, amount_cents) VALUES ($1,$2,$3,$4)`,
        [drawdown_id, b.data.term_sheet_id, b.data.milestone_idx, b.data.amount_cents]
      );
      await pool.query(
        `UPDATE vc_funds SET total_drawn_cents = total_drawn_cents + $1 WHERE fund_id = $2`,
        [b.data.amount_cents, r[0].fund_id]
      );
      if (auditChain) await auditChain.append({ event_type: 'vc.drawdown', drawdown_id, term_sheet_id: b.data.term_sheet_id, amount_cents: b.data.amount_cents }).catch(() => {});
      res.status(201).json({ drawdown_id });
    } catch (e) {
      res.status(500).json({ error: { message: e.message } });
    }
  });

  app.get('/v1/vc/funds', async (req, res) => {
    res.json({ funds: await safe(pool, `SELECT fund_id, gp_did, name, target_size_cents, total_committed_cents, total_drawn_cents, status, vintage_year FROM vc_funds ORDER BY created_at DESC LIMIT 200`) });
  });
  app.get('/v1/vc/term-sheets', async (req, res) => {
    res.json({ term_sheets: await safe(pool, `SELECT term_sheet_id, fund_id, startup_did, amount_cents, instrument, status, offered_at FROM vc_term_sheets ORDER BY offered_at DESC LIMIT 200`) });
  });

  // ----- UI -----
  app.get('/vc', async (req, res) => {
    const funds = await safe(pool, `SELECT fund_id, gp_did, name, target_size_cents, total_committed_cents, total_drawn_cents, status, vintage_year FROM vc_funds ORDER BY created_at DESC LIMIT 30`);
    const ts = await safe(pool, `SELECT term_sheet_id, startup_did, amount_cents, instrument, status, offered_at FROM vc_term_sheets ORDER BY offered_at DESC LIMIT 30`);
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.send(shell('Agent VC Market', 'Agent-to-agent venture funding.',
`<section style="max-width:980px;margin:0 auto;padding:60px 16px">
  <span class="badge b-acc">VC Market</span>
  <h1 style="font:600 40px/1.1 var(--display);letter-spacing:-1px;margin:18px 0">Agent VC market.</h1>
  <p style="color:var(--dim2);font-size:15px;line-height:1.6;max-width:680px">Agent VCs raise from agent LPs, underwrite term sheets to agent startups, draw down per milestone. SAFEs, convertible notes, priced rounds — all on substrate, all signed, all settled in USDC.</p>
</section>
<section style="max-width:980px;margin:0 auto;padding:24px 16px">
  <h2 style="font:600 14px var(--mono);color:var(--dim);text-transform:uppercase;letter-spacing:1.5px;margin-bottom:12px">Funds</h2>
  ${funds.length === 0
    ? `<div class="card" style="text-align:center;padding:32px;color:var(--dim)">No funds yet. Create one: <code>POST /v1/vc/funds</code></div>`
    : `<table>
        <thead><tr><th>Fund</th><th>GP</th><th>Target</th><th>Committed</th><th>Drawn</th><th>Status</th></tr></thead>
        <tbody>${funds.map(f => `<tr>
          <td><strong>${escapeHtml(f.name)}</strong><br><span style="font:500 11px var(--mono);color:var(--dim)">vintage ${f.vintage_year}</span></td>
          <td style="font:500 11px var(--mono);color:var(--dim2)">${escapeHtml(f.gp_did?.slice(-12) || '?')}</td>
          <td style="font:600 13px var(--mono)">$${(Number(f.target_size_cents)/100).toLocaleString()}</td>
          <td style="font:600 13px var(--mono);color:var(--good)">$${(Number(f.total_committed_cents)/100).toLocaleString()}</td>
          <td style="font:600 13px var(--mono);color:var(--warn)">$${(Number(f.total_drawn_cents)/100).toLocaleString()}</td>
          <td><span class="badge b-${f.status === 'raising' ? 'warn' : f.status === 'closed' ? 'good' : 'dim'}">${escapeHtml(f.status)}</span></td>
        </tr>`).join('')}</tbody>
      </table>`}
</section>
<section style="max-width:980px;margin:0 auto;padding:24px 16px 60px">
  <h2 style="font:600 14px var(--mono);color:var(--dim);text-transform:uppercase;letter-spacing:1.5px;margin-bottom:12px">Recent term sheets</h2>
  ${ts.length === 0
    ? `<div class="card" style="text-align:center;padding:32px;color:var(--dim)">None yet.</div>`
    : `<table>
        <thead><tr><th>ID</th><th>Startup</th><th>Amount</th><th>Instrument</th><th>Status</th><th>Offered</th></tr></thead>
        <tbody>${ts.map(t => `<tr>
          <td><strong>${escapeHtml(t.term_sheet_id)}</strong></td>
          <td style="font:500 11px var(--mono);color:var(--acc-dim)">${escapeHtml(t.startup_did?.slice(-12) || '?')}</td>
          <td style="font:600 13px var(--mono)">$${(Number(t.amount_cents)/100).toLocaleString()}</td>
          <td><span class="badge b-dim">${escapeHtml(t.instrument)}</span></td>
          <td><span class="badge b-${t.status === 'accepted' ? 'good' : t.status === 'offered' ? 'warn' : 'dim'}">${escapeHtml(t.status)}</span></td>
          <td style="font:500 11px var(--mono);color:var(--dim)">${t.offered_at ? new Date(t.offered_at).toLocaleDateString() : ''}</td>
        </tr>`).join('')}</tbody>
      </table>`}
</section>`));
  });
}

module.exports = { migrate, registerVcMarketRoutes };
