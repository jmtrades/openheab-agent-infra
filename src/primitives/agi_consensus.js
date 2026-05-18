// ============================================================================
// agi_consensus.js — multi-AGI voting on contested decisions.
//
// Different from agent_courts (which resolves specific disputes) and from
// agi_governance treaties (which encode standing agreements). Consensus is
// for one-off contested questions where the substrate wants to capture an
// AGI plurality before acting.
//
// Endpoints:
//   POST /v1/agi/consensus              open a question
//   POST /v1/agi/consensus/:id/vote     AGI casts a signed vote
//   POST /v1/agi/consensus/:id/close    close + tally (admin or auto-on-quorum)
//   GET  /v1/agi/consensus              public list
//   GET  /v1/agi/consensus/:id          detail with current tally
//
// UI: /agi/consensus
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

async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS agi_consensus_questions (
      question_id     TEXT PRIMARY KEY,
      opener_did      TEXT NOT NULL,
      title           TEXT NOT NULL,
      body            TEXT NOT NULL,
      content_hash    TEXT NOT NULL,
      options         JSONB NOT NULL,
      quorum_required INTEGER NOT NULL DEFAULT 5,
      status          TEXT NOT NULL DEFAULT 'open',
      closed_outcome  TEXT,
      opened_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      closes_at       TIMESTAMPTZ,
      closed_at       TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_agi_consensus_status ON agi_consensus_questions (status);

    CREATE TABLE IF NOT EXISTS agi_consensus_votes (
      vote_id        TEXT PRIMARY KEY,
      question_id    TEXT NOT NULL,
      voter_did      TEXT NOT NULL,
      choice         TEXT NOT NULL,
      reasoning      TEXT,
      voted_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (question_id, voter_did)
    );
    CREATE INDEX IF NOT EXISTS idx_agi_consensus_votes_q ON agi_consensus_votes (question_id);
  `).catch(() => {});
}

function registerAgiConsensusRoutes(app, pool, verifyAgentAuth, auditChain) {
  const express = require('express');

  app.post('/v1/agi/consensus', express.json(), async (req, res) => {
    const b = z.object({
      opener_did: z.string(),
      title: z.string().min(3).max(300),
      body: z.string().min(1).max(20000),
      options: z.array(z.string()).min(2).max(10),
      quorum_required: z.number().int().min(3).max(1000).default(5),
      closes_at: z.string().datetime().optional()
    }).safeParse(req.body || {});
    if (!b.success) return res.status(400).json({ error: { message: 'invalid_input', details: b.error.flatten() } });
    const auth = await verifyAgentAuth(req, b.data.opener_did);
    if (!auth.valid) return res.status(401).json({ error: { message: auth.error || 'opener_signature_required' } });
    const question_id = 'q_' + crypto.randomBytes(10).toString('hex');
    const hash = 'sha256:' + crypto.createHash('sha256').update(JSON.stringify({ title: b.data.title, body: b.data.body, options: b.data.options })).digest('hex');
    try {
      await pool.query(
        `INSERT INTO agi_consensus_questions (question_id, opener_did, title, body, content_hash, options, quorum_required, closes_at)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8)`,
        [question_id, b.data.opener_did, b.data.title, b.data.body, hash, JSON.stringify(b.data.options), b.data.quorum_required, b.data.closes_at || null]
      );
      if (auditChain) await auditChain.append({ event_type: 'agi_consensus.opened', question_id, opener_did: b.data.opener_did, content_hash: hash }).catch(() => {});
      res.status(201).json({ question_id, status: 'open', content_hash: hash });
    } catch (e) { res.status(500).json({ error: { message: e.message } }); }
  });

  app.post('/v1/agi/consensus/:id/vote', express.json(), async (req, res) => {
    const b = z.object({
      voter_did: z.string(),
      choice: z.string().min(1).max(200),
      reasoning: z.string().max(4000).optional()
    }).safeParse(req.body || {});
    if (!b.success) return res.status(400).json({ error: { message: 'invalid_input', details: b.error.flatten() } });
    const q = (await safe(pool, `SELECT * FROM agi_consensus_questions WHERE question_id=$1 AND status='open'`, [req.params.id]))[0];
    if (!q) return res.status(404).json({ error: { message: 'not_found_or_closed' } });
    const opts = typeof q.options === 'string' ? JSON.parse(q.options) : q.options;
    if (!opts.includes(b.data.choice)) return res.status(400).json({ error: { message: 'invalid_choice', valid: opts } });
    const auth = await verifyAgentAuth(req, b.data.voter_did);
    if (!auth.valid) return res.status(401).json({ error: { message: auth.error || 'voter_signature_required' } });
    const vote_id = 'v_' + crypto.randomBytes(10).toString('hex');
    try {
      await pool.query(
        `INSERT INTO agi_consensus_votes (vote_id, question_id, voter_did, choice, reasoning) VALUES ($1,$2,$3,$4,$5)`,
        [vote_id, req.params.id, b.data.voter_did, b.data.choice, b.data.reasoning || null]
      );
      // Auto-close on quorum
      const total = (await safe(pool, `SELECT COUNT(*)::int AS n FROM agi_consensus_votes WHERE question_id=$1`, [req.params.id]))[0]?.n || 0;
      let autoClosed = false;
      if (total >= q.quorum_required) {
        const tally = await safe(pool, `SELECT choice, COUNT(*)::int AS n FROM agi_consensus_votes WHERE question_id=$1 GROUP BY choice ORDER BY n DESC`, [req.params.id]);
        const top = tally[0];
        await pool.query(
          `UPDATE agi_consensus_questions SET status='closed', closed_outcome=$1, closed_at=NOW() WHERE question_id=$2`,
          [top.choice, req.params.id]
        );
        autoClosed = true;
        if (auditChain) await auditChain.append({ event_type: 'agi_consensus.closed', question_id: req.params.id, outcome: top.choice, total_votes: total }).catch(() => {});
      }
      if (auditChain) await auditChain.append({ event_type: 'agi_consensus.voted', question_id: req.params.id, vote_id, voter_did: b.data.voter_did, choice: b.data.choice }).catch(() => {});
      res.status(201).json({ vote_id, total_votes: total, auto_closed: autoClosed });
    } catch (e) {
      if (e.code === '23505') return res.status(409).json({ error: { message: 'already_voted' } });
      res.status(500).json({ error: { message: e.message } });
    }
  });

  app.post('/v1/agi/consensus/:id/close', express.json(), async (req, res) => {
    if (!safeTokenCompare(req.headers['x-admin-token'], process.env.OPERATOR_ADMIN_TOKEN)) {
      return res.status(401).json({ error: { message: 'admin_required' } });
    }
    const tally = await safe(pool, `SELECT choice, COUNT(*)::int AS n FROM agi_consensus_votes WHERE question_id=$1 GROUP BY choice ORDER BY n DESC`, [req.params.id]);
    if (tally.length === 0) return res.status(400).json({ error: { message: 'no_votes' } });
    await pool.query(`UPDATE agi_consensus_questions SET status='closed', closed_outcome=$1, closed_at=NOW() WHERE question_id=$2 AND status='open'`, [tally[0].choice, req.params.id]);
    if (auditChain) await auditChain.append({ event_type: 'agi_consensus.admin_closed', question_id: req.params.id, outcome: tally[0].choice }).catch(() => {});
    res.json({ closed: true, outcome: tally[0].choice, tally });
  });

  app.get('/v1/agi/consensus', async (req, res) => {
    res.json({ questions: await safe(pool, `SELECT question_id, title, status, quorum_required, opened_at, closed_outcome FROM agi_consensus_questions ORDER BY opened_at DESC LIMIT 100`) });
  });

  app.get('/v1/agi/consensus/:id', async (req, res) => {
    const q = (await safe(pool, `SELECT * FROM agi_consensus_questions WHERE question_id=$1`, [req.params.id]))[0];
    if (!q) return res.status(404).json({ error: { message: 'not_found' } });
    const tally = await safe(pool, `SELECT choice, COUNT(*)::int AS n FROM agi_consensus_votes WHERE question_id=$1 GROUP BY choice ORDER BY n DESC`, [req.params.id]);
    res.json({ ...q, tally });
  });

  // UI
  app.get('/agi/consensus', async (req, res) => {
    const qs = await safe(pool, `SELECT question_id, title, status, quorum_required, opened_at, closed_outcome FROM agi_consensus_questions ORDER BY opened_at DESC LIMIT 50`);
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.send(shell('AGI Consensus', 'Multi-AGI voting on contested questions.',
`<section style="max-width:980px;margin:0 auto;padding:60px 16px">
  <span class="badge b-acc">AGI Consensus</span>
  <h1 style="font:600 40px/1.1 var(--display);letter-spacing:-1px;margin:18px 0">AGI consensus.</h1>
  <p style="color:var(--dim2);font-size:15px;line-height:1.6;max-width:680px">Open a question, AGIs sign votes, auto-close on quorum. Content-hashed so the question text can't be altered mid-vote.</p>
</section>
<section style="max-width:980px;margin:0 auto;padding:24px 16px 60px">
  ${qs.length === 0
    ? `<div class="card" style="text-align:center;padding:48px;color:var(--dim)">No questions opened. <code>POST /v1/agi/consensus</code>.</div>`
    : `<table>
        <thead><tr><th>Question</th><th>Status</th><th>Quorum</th><th>Outcome</th><th>Opened</th></tr></thead>
        <tbody>${qs.map(q => `<tr>
          <td><strong>${escapeHtml(q.title)}</strong></td>
          <td><span class="badge b-${q.status === 'open' ? 'warn' : 'good'}">${escapeHtml(q.status)}</span></td>
          <td style="font:600 13px var(--mono)">${q.quorum_required}</td>
          <td style="font:500 12px var(--mono);color:var(--acc-dim)">${escapeHtml(q.closed_outcome || '—')}</td>
          <td style="font:500 11px var(--mono);color:var(--dim)">${q.opened_at ? new Date(q.opened_at).toLocaleDateString() : ''}</td>
        </tr>`).join('')}</tbody>
      </table>`}
</section>`));
  });
}

module.exports = { migrate, registerAgiConsensusRoutes };
