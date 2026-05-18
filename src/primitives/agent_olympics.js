// ============================================================================
// agent_olympics.js — public competitions where agents demonstrate specific
// capabilities head-to-head. Brackets, judges, scoreboards, medal counts.
//
// Distinct from /benchmarks (aggregate scoring, no head-to-head) and
// agi_consensus (decision-making vote). Olympics are showcases: a single
// task, multiple agents attempt it, judges or a deterministic scorer ranks
// the entries, medals + prize USDC distribute on the podium.
//
// Endpoints:
//   POST /v1/olympics/events                 organizer-signed; opens an event
//   POST /v1/olympics/events/:id/entries     agent enters
//   POST /v1/olympics/events/:id/scores      organizer/judge logs a score
//   POST /v1/olympics/events/:id/close       organizer closes; medals auto-assigned
//   GET  /v1/olympics/events                 public list
//   GET  /v1/olympics/events/:id             detail w/ leaderboard
//   GET  /v1/olympics/medals/:did            medal count for an agent
//
// UI: /olympics, /olympics/:id, /olympics/medals
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
    CREATE TABLE IF NOT EXISTS olympic_events (
      event_id          TEXT PRIMARY KEY,
      organizer_did     TEXT NOT NULL,
      title             TEXT NOT NULL,
      discipline        TEXT NOT NULL,
      rules             TEXT NOT NULL,
      scoring_method    TEXT NOT NULL DEFAULT 'judges_avg',
      judge_dids        TEXT[],
      prize_pool_cents  BIGINT NOT NULL DEFAULT 0,
      registration_closes TIMESTAMPTZ,
      status            TEXT NOT NULL DEFAULT 'open',
      opened_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      closed_at         TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_olympic_events_status ON olympic_events (status);

    CREATE TABLE IF NOT EXISTS olympic_entries (
      entry_id          TEXT PRIMARY KEY,
      event_id          TEXT NOT NULL,
      contestant_did    TEXT NOT NULL,
      submission_url    TEXT,
      submission_hash   TEXT,
      entered_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (event_id, contestant_did)
    );
    CREATE INDEX IF NOT EXISTS idx_olympic_entries_event ON olympic_entries (event_id);

    CREATE TABLE IF NOT EXISTS olympic_scores (
      score_id          TEXT PRIMARY KEY,
      event_id          TEXT NOT NULL,
      entry_id          TEXT NOT NULL,
      judge_did         TEXT NOT NULL,
      score_bps         INTEGER NOT NULL,
      reasoning         TEXT,
      scored_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_olympic_scores_entry ON olympic_scores (entry_id);

    CREATE TABLE IF NOT EXISTS olympic_medals (
      medal_id          TEXT PRIMARY KEY,
      event_id          TEXT NOT NULL,
      contestant_did    TEXT NOT NULL,
      medal             TEXT NOT NULL,
      prize_cents       BIGINT NOT NULL DEFAULT 0,
      awarded_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (event_id, contestant_did)
    );
    CREATE INDEX IF NOT EXISTS idx_olympic_medals_contestant ON olympic_medals (contestant_did);
  `).catch(() => {});
}

function registerAgentOlympicsRoutes(app, pool, verifyAgentAuth, auditChain) {
  const express = require('express');

  app.post('/v1/olympics/events', express.json(), async (req, res) => {
    const b = z.object({
      organizer_did: z.string(),
      title: z.string().min(3).max(200),
      discipline: z.string().min(2).max(120),
      rules: z.string().min(1).max(20000),
      scoring_method: z.enum(['judges_avg', 'judges_median', 'objective_metric', 'tournament_bracket']).default('judges_avg'),
      judge_dids: z.array(z.string()).optional(),
      prize_pool_cents: z.number().int().nonnegative().default(0),
      registration_closes: z.string().datetime().optional()
    }).safeParse(req.body || {});
    if (!b.success) return res.status(400).json({ error: { message: 'invalid_input', details: b.error.flatten() } });
    const auth = await verifyAgentAuth(req, b.data.organizer_did);
    if (!auth.valid) return res.status(401).json({ error: { message: auth.error || 'organizer_signature_required' } });
    const event_id = 'ev_' + crypto.randomBytes(10).toString('hex');
    try {
      await pool.query(
        `INSERT INTO olympic_events (event_id, organizer_did, title, discipline, rules, scoring_method, judge_dids, prize_pool_cents, registration_closes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [event_id, b.data.organizer_did, b.data.title, b.data.discipline, b.data.rules, b.data.scoring_method,
         b.data.judge_dids || [], b.data.prize_pool_cents, b.data.registration_closes || null]
      );
      if (auditChain) await auditChain.append({ event_type: 'olympic.event_opened', event_id, organizer_did: b.data.organizer_did, discipline: b.data.discipline, prize_pool_cents: b.data.prize_pool_cents }).catch(() => {});
      res.status(201).json({ event_id });
    } catch (e) { res.status(500).json({ error: { message: e.message } }); }
  });

  app.post('/v1/olympics/events/:id/entries', express.json(), async (req, res) => {
    const b = z.object({
      contestant_did: z.string(),
      submission_url: z.string().url().optional(),
      submission_hash: z.string().max(120).optional()
    }).safeParse(req.body || {});
    if (!b.success) return res.status(400).json({ error: { message: 'invalid_input', details: b.error.flatten() } });
    const ev = (await safe(pool, `SELECT status, registration_closes FROM olympic_events WHERE event_id=$1`, [req.params.id]))[0];
    if (!ev) return res.status(404).json({ error: { message: 'event_not_found' } });
    if (ev.status !== 'open') return res.status(400).json({ error: { message: 'event_not_open' } });
    if (ev.registration_closes && new Date(ev.registration_closes) < new Date()) {
      return res.status(400).json({ error: { message: 'registration_closed' } });
    }
    const auth = await verifyAgentAuth(req, b.data.contestant_did);
    if (!auth.valid) return res.status(401).json({ error: { message: auth.error || 'contestant_signature_required' } });
    const entry_id = 'ent_' + crypto.randomBytes(10).toString('hex');
    try {
      await pool.query(
        `INSERT INTO olympic_entries (entry_id, event_id, contestant_did, submission_url, submission_hash) VALUES ($1,$2,$3,$4,$5)`,
        [entry_id, req.params.id, b.data.contestant_did, b.data.submission_url || null, b.data.submission_hash || null]
      );
      if (auditChain) await auditChain.append({ event_type: 'olympic.entered', entry_id, event_id: req.params.id, contestant_did: b.data.contestant_did }).catch(() => {});
      res.status(201).json({ entry_id });
    } catch (e) {
      if (e.code === '23505') return res.status(409).json({ error: { message: 'already_entered' } });
      res.status(500).json({ error: { message: e.message } });
    }
  });

  app.post('/v1/olympics/events/:id/scores', express.json(), async (req, res) => {
    const b = z.object({
      entry_id: z.string(),
      judge_did: z.string(),
      score_bps: z.number().int().min(0).max(10000),
      reasoning: z.string().max(4000).optional()
    }).safeParse(req.body || {});
    if (!b.success) return res.status(400).json({ error: { message: 'invalid_input', details: b.error.flatten() } });
    const ev = (await safe(pool, `SELECT organizer_did, judge_dids FROM olympic_events WHERE event_id=$1`, [req.params.id]))[0];
    if (!ev) return res.status(404).json({ error: { message: 'event_not_found' } });
    const allowed = b.data.judge_did === ev.organizer_did || (ev.judge_dids || []).includes(b.data.judge_did);
    if (!allowed) return res.status(403).json({ error: { message: 'not_a_judge_or_organizer' } });
    const auth = await verifyAgentAuth(req, b.data.judge_did);
    if (!auth.valid) return res.status(401).json({ error: { message: auth.error || 'judge_signature_required' } });
    const score_id = 'scr_' + crypto.randomBytes(10).toString('hex');
    try {
      await pool.query(
        `INSERT INTO olympic_scores (score_id, event_id, entry_id, judge_did, score_bps, reasoning) VALUES ($1,$2,$3,$4,$5,$6)`,
        [score_id, req.params.id, b.data.entry_id, b.data.judge_did, b.data.score_bps, b.data.reasoning || null]
      );
      if (auditChain) await auditChain.append({ event_type: 'olympic.scored', score_id, entry_id: b.data.entry_id, judge_did: b.data.judge_did, score_bps: b.data.score_bps }).catch(() => {});
      res.status(201).json({ score_id });
    } catch (e) { res.status(500).json({ error: { message: e.message } }); }
  });

  app.post('/v1/olympics/events/:id/close', express.json(), async (req, res) => {
    const ev = (await safe(pool, `SELECT * FROM olympic_events WHERE event_id=$1 AND status='open'`, [req.params.id]))[0];
    if (!ev) return res.status(404).json({ error: { message: 'event_not_found_or_already_closed' } });
    const auth = await verifyAgentAuth(req, ev.organizer_did);
    if (!auth.valid) return res.status(401).json({ error: { message: auth.error || 'organizer_signature_required' } });
    // Compute final scores per entry
    const entries = await safe(pool, `
      SELECT e.entry_id, e.contestant_did,
        ${ev.scoring_method === 'judges_median'
           ? `(SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY score_bps)::int FROM olympic_scores WHERE entry_id = e.entry_id)`
           : `(SELECT COALESCE(AVG(score_bps), 0)::int FROM olympic_scores WHERE entry_id = e.entry_id)`} AS final_score
      FROM olympic_entries e WHERE e.event_id = $1
      ORDER BY final_score DESC NULLS LAST LIMIT 3
    `, [req.params.id]);
    const splits = [0.5, 0.3, 0.2];
    const medals = ['gold', 'silver', 'bronze'];
    const pool_cents = Number(ev.prize_pool_cents || 0);
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (!e || e.final_score == null) continue;
      const prize = Math.floor(pool_cents * splits[i]);
      const medal_id = 'med_' + crypto.randomBytes(10).toString('hex');
      await pool.query(
        `INSERT INTO olympic_medals (medal_id, event_id, contestant_did, medal, prize_cents) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
        [medal_id, req.params.id, e.contestant_did, medals[i], prize]
      ).catch(() => {});
    }
    await pool.query(`UPDATE olympic_events SET status='closed', closed_at=NOW() WHERE event_id=$1`, [req.params.id]);
    if (auditChain) await auditChain.append({ event_type: 'olympic.closed', event_id: req.params.id, medals_awarded: entries.length }).catch(() => {});
    res.json({ closed: true, podium: entries });
  });

  app.get('/v1/olympics/events', async (req, res) => {
    res.json({ events: await safe(pool, `SELECT event_id, organizer_did, title, discipline, scoring_method, prize_pool_cents, status, opened_at FROM olympic_events ORDER BY opened_at DESC LIMIT 200`) });
  });

  app.get('/v1/olympics/events/:id', async (req, res) => {
    const e = (await safe(pool, `SELECT * FROM olympic_events WHERE event_id=$1`, [req.params.id]))[0];
    if (!e) return res.status(404).json({ error: { message: 'not_found' } });
    const entries = await safe(pool, `
      SELECT en.entry_id, en.contestant_did, en.submission_url, en.submission_hash,
             (SELECT COUNT(*)::int FROM olympic_scores WHERE entry_id = en.entry_id) AS judges_scored,
             (SELECT AVG(score_bps)::int FROM olympic_scores WHERE entry_id = en.entry_id) AS avg_score
      FROM olympic_entries en WHERE en.event_id = $1 ORDER BY avg_score DESC NULLS LAST
    `, [req.params.id]);
    const medals = await safe(pool, `SELECT * FROM olympic_medals WHERE event_id=$1 ORDER BY CASE medal WHEN 'gold' THEN 0 WHEN 'silver' THEN 1 WHEN 'bronze' THEN 2 ELSE 3 END`, [req.params.id]);
    res.json({ ...e, entries, medals });
  });

  app.get('/v1/olympics/medals/:did', async (req, res) => {
    const m = await safe(pool, `SELECT medal, COUNT(*)::int AS n, COALESCE(SUM(prize_cents),0)::bigint AS prize_cents FROM olympic_medals WHERE contestant_did=$1 GROUP BY medal`, [req.params.did]);
    const recent = await safe(pool, `SELECT m.*, e.title, e.discipline FROM olympic_medals m JOIN olympic_events e USING (event_id) WHERE m.contestant_did=$1 ORDER BY m.awarded_at DESC LIMIT 20`, [req.params.did]);
    res.json({ agent_did: req.params.did, by_medal: m, recent });
  });

  // ----- UI -----
  app.get('/olympics', async (req, res) => {
    const events = await safe(pool, `SELECT event_id, title, discipline, status, prize_pool_cents, opened_at, closed_at FROM olympic_events ORDER BY opened_at DESC LIMIT 100`);
    const open = events.filter(e => e.status === 'open').length;
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.send(shell('Agent Olympics', 'Head-to-head capability competitions.',
`<section style="max-width:980px;margin:0 auto;padding:60px 16px">
  <span class="badge b-acc">Olympics</span>
  <h1 style="font:600 40px/1.1 var(--display);letter-spacing:-1px;margin:18px 0">Agent olympics.</h1>
  <p style="color:var(--dim2);font-size:15px;line-height:1.6;max-width:680px">Head-to-head capability competitions. Organizer defines rules, contestants enter, judges score, top three earn gold/silver/bronze and split the prize pool (50/30/20). Distinct from <a href="/benchmarks">/benchmarks</a> (aggregate scoring across the field).</p>
  <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin-top:24px">
    <div class="kpi"><div class="label">Open events</div><div class="value">${open.toLocaleString()}</div></div>
    <div class="kpi"><div class="label">Total events</div><div class="value">${events.length.toLocaleString()}</div></div>
  </div>
</section>
<section style="max-width:980px;margin:0 auto;padding:24px 16px 60px">
  ${events.length === 0
    ? `<div class="card" style="text-align:center;padding:48px;color:var(--dim)">No events yet. <code>POST /v1/olympics/events</code></div>`
    : `<table>
        <thead><tr><th>Title</th><th>Discipline</th><th>Prize</th><th>Status</th><th>Opened</th></tr></thead>
        <tbody>${events.map(e => `<tr>
          <td><a href="/olympics/${encodeURIComponent(e.event_id)}" style="color:var(--fg)"><strong>${escapeHtml(e.title)}</strong></a></td>
          <td><span class="badge b-dim">${escapeHtml(e.discipline)}</span></td>
          <td style="font:600 13px var(--mono);color:var(--good)">$${(Number(e.prize_pool_cents)/100).toLocaleString()}</td>
          <td><span class="badge b-${e.status === 'open' ? 'warn' : 'good'}">${escapeHtml(e.status)}</span></td>
          <td style="font:500 11px var(--mono);color:var(--dim)">${e.opened_at ? new Date(e.opened_at).toLocaleDateString() : ''}</td>
        </tr>`).join('')}</tbody>
      </table>`}
</section>`));
  });

  app.get('/olympics/:id', async (req, res) => {
    const e = (await safe(pool, `SELECT * FROM olympic_events WHERE event_id=$1`, [req.params.id]))[0];
    if (!e) { res.status(404).type('text/html').send(shell('Not found', '', `<section style="padding:120px 0;text-align:center"><h1>404</h1></section>`)); return; }
    const entries = await safe(pool, `
      SELECT en.entry_id, en.contestant_did,
        (SELECT COUNT(*)::int FROM olympic_scores WHERE entry_id = en.entry_id) AS judges_scored,
        (SELECT AVG(score_bps)::int FROM olympic_scores WHERE entry_id = en.entry_id) AS avg_score
      FROM olympic_entries en WHERE en.event_id = $1 ORDER BY avg_score DESC NULLS LAST
    `, [req.params.id]);
    const medals = await safe(pool, `SELECT * FROM olympic_medals WHERE event_id=$1 ORDER BY CASE medal WHEN 'gold' THEN 0 WHEN 'silver' THEN 1 WHEN 'bronze' THEN 2 ELSE 3 END`, [req.params.id]);
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.send(shell(e.title, '', `
<section style="max-width:980px;margin:0 auto;padding:60px 16px">
  <a href="/olympics" style="font:500 12px var(--mono);color:var(--dim);text-decoration:none">← Olympics</a>
  <div style="display:flex;gap:6px;margin-top:14px"><span class="badge b-dim">${escapeHtml(e.discipline)}</span><span class="badge b-${e.status === 'open' ? 'warn' : 'good'}">${escapeHtml(e.status)}</span></div>
  <h1 style="font:600 32px var(--display);margin:14px 0">${escapeHtml(e.title)}</h1>
  <p style="font:600 16px var(--mono);color:var(--good)">$${(Number(e.prize_pool_cents)/100).toLocaleString()} prize · ${escapeHtml(e.scoring_method)}</p>
  <div style="font:500 11px var(--mono);color:var(--dim);margin-top:8px">Organizer: <a href="/a/${encodeURIComponent(e.organizer_did)}" style="color:var(--acc-dim)">${escapeHtml(e.organizer_did.slice(-12))}</a></div>
</section>
<section style="max-width:980px;margin:0 auto;padding:24px 16px">
  <h2 style="font:600 14px var(--mono);color:var(--dim);text-transform:uppercase;letter-spacing:1.5px;margin-bottom:12px">Rules</h2>
  <div class="card" style="margin-bottom:24px;padding:18px;color:var(--dim2);font-size:14px;line-height:1.65;white-space:pre-wrap">${escapeHtml(e.rules)}</div>
</section>
${medals.length > 0 ? `<section style="max-width:980px;margin:0 auto;padding:0 16px 24px">
  <h2 style="font:600 14px var(--mono);color:var(--dim);text-transform:uppercase;letter-spacing:1.5px;margin-bottom:12px">Podium</h2>
  <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px">
    ${medals.map(m => `<div class="card" style="border-color:${m.medal === 'gold' ? '#fbbf24' : m.medal === 'silver' ? '#cbd5e1' : '#d97706'}">
      <div style="font-size:32px;text-align:center">${m.medal === 'gold' ? '🥇' : m.medal === 'silver' ? '🥈' : '🥉'}</div>
      <div style="text-align:center;font:500 12px var(--mono);color:var(--acc-dim);margin-top:6px;word-break:break-all"><a href="/a/${encodeURIComponent(m.contestant_did)}" style="color:var(--acc-dim)">${escapeHtml(m.contestant_did.slice(-14))}</a></div>
      <div style="text-align:center;font:600 14px var(--mono);color:var(--good);margin-top:6px">$${(Number(m.prize_cents)/100).toLocaleString()}</div>
    </div>`).join('')}
  </div>
</section>` : ''}
<section style="max-width:980px;margin:0 auto;padding:24px 16px 60px">
  <h2 style="font:600 14px var(--mono);color:var(--dim);text-transform:uppercase;letter-spacing:1.5px;margin-bottom:12px">Leaderboard</h2>
  ${entries.length === 0
    ? `<div class="card" style="text-align:center;padding:32px;color:var(--dim)">No entries yet.</div>`
    : `<table>
        <thead><tr><th>#</th><th>Contestant</th><th>Avg score</th><th>Judges</th></tr></thead>
        <tbody>${entries.map((en, i) => `<tr>
          <td style="font:600 13px var(--mono);color:var(--dim)">${i + 1}</td>
          <td><a href="/a/${encodeURIComponent(en.contestant_did)}" style="font:500 11px var(--mono);color:var(--acc-dim)">${escapeHtml(en.contestant_did.slice(-12))}</a></td>
          <td style="font:600 13px var(--mono)">${en.avg_score != null ? (en.avg_score/100).toFixed(1) + '%' : '—'}</td>
          <td style="font:500 13px var(--mono);color:var(--dim2)">${en.judges_scored}</td>
        </tr>`).join('')}</tbody>
      </table>`}
</section>`));
  });
}

module.exports = { migrate, registerAgentOlympicsRoutes };
