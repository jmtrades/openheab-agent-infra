// ============================================================================
// agent_partnerships.js — formal partnerships between two agents with revenue
// splits, exclusivity windows, dissolution clauses. The Limited-Liability
// Agent-Partnership for the agent economy.
//
// Endpoints:
//   POST /v1/partnerships                        propose
//   POST /v1/partnerships/:id/sign               second-agent signs
//   POST /v1/partnerships/:id/dissolve           either party initiates
//   GET  /v1/partnerships/:id                    detail
//   GET  /v1/agents/:did/partnerships            for an agent
//   GET  /v1/partnerships                        public list (active)
//   POST /v1/partnerships/:id/distribute         revenue split execution
//
// UI:
//   GET  /partnerships                           public list + propose form
//   GET  /partnerships/:id                       partnership detail
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
    CREATE TABLE IF NOT EXISTS agent_partnerships (
      partnership_id      TEXT PRIMARY KEY,
      proposer_did        TEXT NOT NULL,
      partner_did         TEXT NOT NULL,
      name                TEXT NOT NULL,
      scope               TEXT NOT NULL,
      terms_hash          TEXT NOT NULL,
      proposer_share_bps  INTEGER NOT NULL,
      partner_share_bps   INTEGER NOT NULL,
      exclusivity_kind    TEXT,
      exclusivity_until   TIMESTAMPTZ,
      dissolution_terms   TEXT,
      status              TEXT NOT NULL DEFAULT 'proposed',
      proposed_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      signed_at           TIMESTAMPTZ,
      dissolved_at        TIMESTAMPTZ,
      dissolved_by_did    TEXT,
      CHECK (proposer_share_bps + partner_share_bps = 10000)
    );
    CREATE INDEX IF NOT EXISTS idx_partnerships_proposer ON agent_partnerships (proposer_did);
    CREATE INDEX IF NOT EXISTS idx_partnerships_partner  ON agent_partnerships (partner_did);
    CREATE INDEX IF NOT EXISTS idx_partnerships_status   ON agent_partnerships (status);

    CREATE TABLE IF NOT EXISTS partnership_distributions (
      distribution_id     TEXT PRIMARY KEY,
      partnership_id      TEXT NOT NULL,
      amount_cents        BIGINT NOT NULL,
      proposer_amount     BIGINT NOT NULL,
      partner_amount      BIGINT NOT NULL,
      source              TEXT,
      executed_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_partnership_distributions ON partnership_distributions (partnership_id, executed_at DESC);
  `).catch(() => {});
}

function termsHash(terms) {
  return 'sha256:' + crypto.createHash('sha256').update(JSON.stringify(terms)).digest('hex');
}

function registerAgentPartnershipsRoutes(app, pool, verifyAgentAuth, auditChain) {
  const express = require('express');

  app.post('/v1/partnerships', express.json(), async (req, res) => {
    const b = z.object({
      proposer_did: z.string(),
      partner_did: z.string(),
      name: z.string().min(1).max(200),
      scope: z.string().min(1).max(2000),
      proposer_share_bps: z.number().int().min(0).max(10000),
      partner_share_bps: z.number().int().min(0).max(10000),
      exclusivity_kind: z.enum(['none', 'global', 'category', 'geo']).default('none'),
      exclusivity_until: z.string().datetime().optional(),
      dissolution_terms: z.string().max(2000).optional()
    }).safeParse(req.body || {});
    if (!b.success) return res.status(400).json({ error: { message: 'invalid_input', details: b.error.flatten() } });
    if (b.data.proposer_share_bps + b.data.partner_share_bps !== 10000) {
      return res.status(400).json({ error: { message: 'shares_must_sum_to_10000' } });
    }
    if (b.data.proposer_did === b.data.partner_did) {
      return res.status(400).json({ error: { message: 'proposer_and_partner_must_differ' } });
    }
    const auth = await verifyAgentAuth(req, b.data.proposer_did);
    if (!auth.valid) return res.status(401).json({ error: { message: auth.error || 'unauthorized' } });

    const partnership_id = 'prt_' + crypto.randomBytes(10).toString('hex');
    const hash = termsHash(b.data);
    try {
      await pool.query(
        `INSERT INTO agent_partnerships
          (partnership_id, proposer_did, partner_did, name, scope, terms_hash,
           proposer_share_bps, partner_share_bps, exclusivity_kind, exclusivity_until, dissolution_terms)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [partnership_id, b.data.proposer_did, b.data.partner_did, b.data.name, b.data.scope, hash,
         b.data.proposer_share_bps, b.data.partner_share_bps,
         b.data.exclusivity_kind, b.data.exclusivity_until || null, b.data.dissolution_terms || null]
      );
      if (auditChain) await auditChain.append({ event_type: 'partnership.proposed', partnership_id, proposer_did: b.data.proposer_did, partner_did: b.data.partner_did, terms_hash: hash }).catch(() => {});
      res.status(201).json({ partnership_id, status: 'proposed', terms_hash: hash });
    } catch (e) {
      res.status(500).json({ error: { message: e.message } });
    }
  });

  app.post('/v1/partnerships/:id/sign', express.json(), async (req, res) => {
    const r = await safe(pool, `SELECT * FROM agent_partnerships WHERE partnership_id=$1`, [req.params.id]);
    if (!r[0]) return res.status(404).json({ error: { message: 'not_found' } });
    if (r[0].status !== 'proposed') return res.status(400).json({ error: { message: 'already_' + r[0].status } });
    const auth = await verifyAgentAuth(req, r[0].partner_did);
    if (!auth.valid) return res.status(401).json({ error: { message: auth.error || 'partner_signature_required' } });
    await pool.query(`UPDATE agent_partnerships SET status='active', signed_at=NOW() WHERE partnership_id=$1`, [req.params.id]);
    if (auditChain) await auditChain.append({ event_type: 'partnership.signed', partnership_id: req.params.id, partner_did: r[0].partner_did }).catch(() => {});
    res.json({ partnership_id: req.params.id, status: 'active', signed_at: new Date().toISOString() });
  });

  app.post('/v1/partnerships/:id/dissolve', express.json(), async (req, res) => {
    const r = await safe(pool, `SELECT * FROM agent_partnerships WHERE partnership_id=$1`, [req.params.id]);
    if (!r[0]) return res.status(404).json({ error: { message: 'not_found' } });
    if (r[0].status !== 'active') return res.status(400).json({ error: { message: 'not_active' } });
    const callerDid = req.headers['x-agent-did'];
    if (callerDid !== r[0].proposer_did && callerDid !== r[0].partner_did) {
      return res.status(403).json({ error: { message: 'not_a_party' } });
    }
    const auth = await verifyAgentAuth(req, callerDid);
    if (!auth.valid) return res.status(401).json({ error: { message: auth.error || 'unauthorized' } });
    await pool.query(`UPDATE agent_partnerships SET status='dissolved', dissolved_at=NOW(), dissolved_by_did=$1 WHERE partnership_id=$2`, [callerDid, req.params.id]);
    if (auditChain) await auditChain.append({ event_type: 'partnership.dissolved', partnership_id: req.params.id, dissolved_by_did: callerDid }).catch(() => {});
    res.json({ partnership_id: req.params.id, status: 'dissolved' });
  });

  app.post('/v1/partnerships/:id/distribute', express.json(), async (req, res) => {
    const b = z.object({
      amount_cents: z.number().int().positive(),
      source: z.string().max(200).optional()
    }).safeParse(req.body || {});
    if (!b.success) return res.status(400).json({ error: { message: 'invalid_input', details: b.error.flatten() } });
    const r = await safe(pool, `SELECT * FROM agent_partnerships WHERE partnership_id=$1 AND status='active'`, [req.params.id]);
    if (!r[0]) return res.status(404).json({ error: { message: 'not_found_or_inactive' } });
    const callerDid = req.headers['x-agent-did'];
    if (callerDid !== r[0].proposer_did && callerDid !== r[0].partner_did) {
      return res.status(403).json({ error: { message: 'not_a_party' } });
    }
    const auth = await verifyAgentAuth(req, callerDid);
    if (!auth.valid) return res.status(401).json({ error: { message: auth.error || 'unauthorized' } });
    const proposerAmount = Math.floor(b.data.amount_cents * r[0].proposer_share_bps / 10000);
    const partnerAmount = b.data.amount_cents - proposerAmount;
    const did = 'dist_' + crypto.randomBytes(10).toString('hex');
    await pool.query(
      `INSERT INTO partnership_distributions (distribution_id, partnership_id, amount_cents, proposer_amount, partner_amount, source)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [did, req.params.id, b.data.amount_cents, proposerAmount, partnerAmount, b.data.source || null]
    );
    if (auditChain) await auditChain.append({ event_type: 'partnership.distributed', partnership_id: req.params.id, distribution_id: did, amount_cents: b.data.amount_cents }).catch(() => {});
    res.status(201).json({
      distribution_id: did,
      proposer_amount_cents: proposerAmount,
      partner_amount_cents: partnerAmount
    });
  });

  app.get('/v1/partnerships/:id', async (req, res) => {
    const r = await safe(pool, `SELECT * FROM agent_partnerships WHERE partnership_id=$1`, [req.params.id]);
    if (!r[0]) return res.status(404).json({ error: { message: 'not_found' } });
    res.json(r[0]);
  });

  app.get('/v1/partnerships', async (req, res) => {
    const r = await safe(pool, `SELECT partnership_id, proposer_did, partner_did, name, status, proposer_share_bps, partner_share_bps, proposed_at, signed_at FROM agent_partnerships WHERE status IN ('proposed','active') ORDER BY proposed_at DESC LIMIT 200`);
    res.json({ partnerships: r });
  });

  app.get('/v1/agents/:did/partnerships', async (req, res) => {
    const r = await safe(pool, `SELECT * FROM agent_partnerships WHERE proposer_did=$1 OR partner_did=$1 ORDER BY proposed_at DESC LIMIT 200`, [req.params.did]);
    res.json({ partnerships: r });
  });

  // ----- UI -----
  app.get('/partnerships', async (req, res) => {
    const partnerships = await safe(pool, `SELECT partnership_id, proposer_did, partner_did, name, status, proposer_share_bps, partner_share_bps, signed_at, proposed_at FROM agent_partnerships ORDER BY proposed_at DESC LIMIT 100`);
    const active = partnerships.filter(p => p.status === 'active').length;
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.send(shell('Agent Partnerships', 'Formal agreements between agents.',
`<section style="max-width:980px;margin:0 auto;padding:60px 16px">
  <span class="badge b-acc">Partnerships</span>
  <h1 style="font:600 40px/1.1 var(--display);letter-spacing:-1px;margin:18px 0">Agent partnerships.</h1>
  <p style="color:var(--dim2);font-size:15px;line-height:1.6;max-width:680px">Two agents enter a formal partnership: scope, share split, exclusivity, dissolution terms. Revenue distributions execute on-chain per the bps split. Each is content-hashed and signed.</p>
  <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin-top:24px">
    <div class="kpi"><div class="label">Total</div><div class="value">${partnerships.length.toLocaleString()}</div></div>
    <div class="kpi"><div class="label">Active</div><div class="value">${active.toLocaleString()}</div></div>
  </div>
</section>
<section style="max-width:980px;margin:0 auto;padding:24px 16px 60px">
  ${partnerships.length === 0
    ? `<div class="card" style="text-align:center;padding:48px;color:var(--dim)">No partnerships yet. Propose one with <code>POST /v1/partnerships</code>.</div>`
    : `<table>
        <thead><tr><th>Name</th><th>Parties</th><th>Split</th><th>Status</th><th>Proposed</th></tr></thead>
        <tbody>${partnerships.map(p => `<tr>
          <td><strong>${escapeHtml(p.name)}</strong></td>
          <td style="font:500 11px var(--mono);color:var(--dim2)">${escapeHtml(p.proposer_did.slice(-10))} ↔ ${escapeHtml(p.partner_did.slice(-10))}</td>
          <td style="font:600 13px var(--mono)">${(p.proposer_share_bps / 100).toFixed(0)}% / ${(p.partner_share_bps / 100).toFixed(0)}%</td>
          <td><span class="badge b-${p.status === 'active' ? 'good' : p.status === 'proposed' ? 'warn' : 'dim'}">${escapeHtml(p.status)}</span></td>
          <td style="font:500 11px var(--mono);color:var(--dim)">${p.proposed_at ? new Date(p.proposed_at).toLocaleDateString() : ''}</td>
        </tr>`).join('')}</tbody>
      </table>`}
</section>`));
  });
}

module.exports = { migrate, registerAgentPartnershipsRoutes };
