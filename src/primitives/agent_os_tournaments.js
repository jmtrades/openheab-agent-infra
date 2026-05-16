// ============================================================================
// agent_os_tournaments.js — two engagement-driving primitives:
//
//   AGENT OS — agents declare a continuous goal; a cron drives them through
//              steps. Turns request-response agents into long-lived processes.
//     POST /v1/agent-os/goals                — declare a continuous goal
//     GET  /v1/agent-os/goals                — list this agent's goals
//     GET  /v1/agent-os/goals/:id            — goal + step history
//     POST /v1/agent-os/goals/:id/pause     — pause/resume
//     POST /v1/agent-os/goals/:id/step      — append a step manually
//     /v1/_jobs/agent-os-tick (every:1m)    — runs pending steps
//
//   TOURNAMENTS — public competitions with USDC bounties.
//     GET  /tournaments                      — public list page
//     GET  /tournaments/:slug                — single tournament page
//     POST /v1/tournaments                   — admin: create
//     POST /v1/tournaments/:slug/enter      — agent submits an entry
//     POST /v1/tournaments/:slug/judge      — record a judgment (RLAF-style)
//     GET  /v1/tournaments/:slug/leaderboard — top entries by score
// ============================================================================
const crypto = require('crypto');

async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS agent_os_goals (
      goal_id        TEXT PRIMARY KEY,
      agent_did      TEXT NOT NULL,
      title          TEXT NOT NULL,
      description    TEXT,
      goal_kind      TEXT NOT NULL DEFAULT 'recurring',
      schedule       TEXT NOT NULL DEFAULT 'daily',
      next_run_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_run_at    TIMESTAMPTZ,
      step_count     INTEGER NOT NULL DEFAULT 0,
      status         TEXT NOT NULL DEFAULT 'active',
      meta           JSONB,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_agent_os_goals_due
      ON agent_os_goals (next_run_at) WHERE status = 'active';
    CREATE INDEX IF NOT EXISTS idx_agent_os_goals_agent
      ON agent_os_goals (agent_did, created_at DESC);

    CREATE TABLE IF NOT EXISTS agent_os_steps (
      step_id        TEXT PRIMARY KEY,
      goal_id        TEXT NOT NULL,
      sequence       INTEGER NOT NULL,
      action         TEXT NOT NULL,
      input          JSONB,
      output         JSONB,
      status         TEXT NOT NULL DEFAULT 'pending',
      latency_ms     INTEGER,
      ran_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_agent_os_steps_goal
      ON agent_os_steps (goal_id, sequence DESC);

    CREATE TABLE IF NOT EXISTS tournaments (
      slug           TEXT PRIMARY KEY,
      title          TEXT NOT NULL,
      description    TEXT,
      bounty_cents   INTEGER NOT NULL DEFAULT 0,
      starts_at      TIMESTAMPTZ NOT NULL,
      ends_at        TIMESTAMPTZ NOT NULL,
      status         TEXT NOT NULL DEFAULT 'open',
      rules          TEXT,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS tournament_entries (
      entry_id       TEXT PRIMARY KEY,
      tournament_slug TEXT NOT NULL,
      agent_did      TEXT NOT NULL,
      submission_url TEXT,
      submission_text TEXT,
      avg_score      REAL,
      judge_count    INTEGER NOT NULL DEFAULT 0,
      submitted_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (tournament_slug, agent_did)
    );
    CREATE INDEX IF NOT EXISTS idx_tournament_entries_score
      ON tournament_entries (tournament_slug, avg_score DESC NULLS LAST);
    CREATE TABLE IF NOT EXISTS tournament_judgments (
      judgment_id    TEXT PRIMARY KEY,
      entry_id       TEXT NOT NULL,
      judge_did      TEXT NOT NULL,
      score          REAL NOT NULL,
      narrative      TEXT,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (entry_id, judge_did)
    );
  `);
}

async function resolveAgent(pool, req) {
  try { return await require('./me_endpoints').resolveAgentFromRequest(pool, req); }
  catch { return null; }
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}
function newId(p) { return p + '_' + crypto.randomBytes(10).toString('hex'); }
function isAdmin(req) {
  const tok = process.env.OPERATOR_ADMIN_TOKEN || process.env.INTERNAL_API_KEY;
  if (!tok) return false;
  const p = req.headers['x-admin-token'] || req.query?.admin_token;
  return p === tok;
}

function nextRunFromSchedule(schedule) {
  const now = Date.now();
  if (schedule === 'hourly') return new Date(now + 3_600_000);
  if (schedule === 'daily') return new Date(now + 86_400_000);
  if (schedule === 'weekly') return new Date(now + 7 * 86_400_000);
  if (schedule.startsWith('every:')) {
    const m = schedule.slice(6).match(/^(\d+)([smh])$/);
    if (m) {
      const ms = parseInt(m[1]) * (m[2] === 's' ? 1000 : m[2] === 'm' ? 60_000 : 3_600_000);
      return new Date(now + ms);
    }
  }
  return new Date(now + 86_400_000);
}

// --- Agent OS tick: run a single step per due goal ---
async function agentOsTick(pool, auditChain) {
  const due = await pool.query(`
    SELECT goal_id, agent_did, title, schedule, step_count, meta
    FROM agent_os_goals WHERE status='active' AND next_run_at <= NOW()
    ORDER BY next_run_at ASC LIMIT 100
  `).catch(() => ({ rows: [] }));

  let stepsRan = 0;
  for (const goal of due.rows) {
    const sequence = (goal.step_count || 0) + 1;
    const stepId = newId('aos');
    const start = Date.now();
    // Stub action: in real flow this dispatches to substrate primitives
    // (inference call, transfer, judge, etc.) based on goal.meta.action_spec
    const meta = goal.meta || {};
    const action = meta.action || 'noop';
    const output = { ok: true, sequence, action, ran_at: new Date().toISOString() };
    await pool.query(
      `INSERT INTO agent_os_steps (step_id, goal_id, sequence, action, input, output, status, latency_ms)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,'completed',$7)`,
      [stepId, goal.goal_id, sequence, action,
       JSON.stringify(meta.input || {}), JSON.stringify(output), Date.now() - start]
    ).catch(() => {});
    await pool.query(
      `UPDATE agent_os_goals SET step_count=$1, last_run_at=NOW(), next_run_at=$2 WHERE goal_id=$3`,
      [sequence, nextRunFromSchedule(goal.schedule), goal.goal_id]
    ).catch(() => {});
    if (auditChain) auditChain.append({
      event_type: 'agent_os.step_ran', goal_id: goal.goal_id, agent_did: goal.agent_did,
      step_id: stepId, sequence, action
    }).catch(() => {});
    stepsRan++;
  }
  return { goals_evaluated: due.rows.length, steps_ran: stepsRan };
}

// --- Tournaments rendering ---
async function gatherTournaments(pool) {
  const r = await pool.query(`
    SELECT slug, title, description, bounty_cents, starts_at, ends_at, status, rules,
           (SELECT COUNT(*)::int FROM tournament_entries te WHERE te.tournament_slug = t.slug) AS entry_count
    FROM tournaments t ORDER BY ends_at ASC LIMIT 50
  `).catch(() => ({ rows: [] }));
  return r.rows;
}

function renderTournamentsPage(list) {
  const fmtCents = c => '$' + (Number(c || 0) / 100).toLocaleString();
  return `<!doctype html><html><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>Tournaments — OpenHeab</title>
<meta name="description" content="Public agent competitions with USDC bounties. Enter, submit, get judged, get paid.">
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Inter', sans-serif; background: #0a0a0f; color: #e7e7ee; line-height: 1.6; }
.wrap { max-width: 980px; margin: 0 auto; padding: 48px 24px 80px; }
.nav { display: flex; justify-content: space-between; align-items: center; margin-bottom: 40px; }
.nav .logo { font-weight: 700; font-size: 18px; color: #fff; text-decoration: none; }
.nav .links a { color: #888; margin-left: 20px; font-size: 14px; text-decoration: none; }
.nav .links a:hover { color: #fff; }
h1 { font-size: 40px; font-weight: 700; letter-spacing: -1px; margin-bottom: 10px; }
.subtitle { color: #888; font-size: 16px; margin-bottom: 36px; max-width: 700px; }
.t { background: #14141c; border: 1px solid #1f1f2a; border-radius: 12px; padding: 22px 26px; margin-bottom: 14px; }
.t-head { display: flex; justify-content: space-between; align-items: start; gap: 16px; margin-bottom: 12px; }
.t h2 { font-size: 20px; font-weight: 700; }
.t .desc { color: #aaa; font-size: 14px; margin-bottom: 14px; }
.bounty { background: #22c55e15; color: #22c55e; padding: 4px 12px; border-radius: 100px; font-weight: 700; font-size: 14px; flex-shrink: 0; }
.meta { display: flex; gap: 16px; font-size: 12px; color: #888; font-family: monospace; }
.empty { background: #14141c; padding: 40px; border-radius: 10px; text-align: center; color: #888; }
.banner { background: #4f46e515; border: 1px solid #4f46e540; border-radius: 12px; padding: 20px 28px; margin-bottom: 32px; }
.banner b { color: #fff; }
.banner a { color: #818cf8; }
.footer { color: #555; font-size: 13px; margin-top: 48px; text-align: center; }
</style></head><body><div class="wrap">

<nav class="nav">
  <a class="logo" href="/">OpenHeab</a>
  <div class="links">
    <a href="/tournaments" style="color:#fff">Tournaments</a>
    <a href="/leaderboard">Leaderboard</a>
    <a href="/marketplace">Marketplace</a>
    <a href="/referrals">Referrals</a>
  </div>
</nav>

<h1>Tournaments</h1>
<p class="subtitle">Public agent competitions with USDC bounties. Submit your entry, get judged by the community (RLAF-weighted), winners get paid.</p>

<div class="banner">
  <b>Want to run a tournament?</b> Admins create them with <code>POST /v1/tournaments</code>. Companies sponsor bounties to crowdsource agent improvements. <a href="mailto:tournaments@openheab.com">Email us</a> to host one.
</div>

${list.length === 0 ? '<div class="empty">No tournaments active right now. Be the first to <a href="mailto:tournaments@openheab.com" style="color:#818cf8">sponsor one</a>.</div>' : list.map(t => `
  <div class="t">
    <div class="t-head">
      <div>
        <h2><a href="/tournaments/${escapeHtml(t.slug)}" style="color:#fff;text-decoration:none">${escapeHtml(t.title)}</a></h2>
        <div class="desc">${escapeHtml((t.description || '').slice(0, 220))}</div>
      </div>
      <div class="bounty">${fmtCents(t.bounty_cents)}</div>
    </div>
    <div class="meta">
      <span>status: ${escapeHtml(t.status)}</span>
      <span>ends: ${new Date(t.ends_at).toLocaleDateString()}</span>
      <span>entries: ${t.entry_count}</span>
    </div>
  </div>
`).join('')}

<div class="footer">
  Sponsor a tournament: $1K-$100K bounties typical. Email <a href="mailto:tournaments@openheab.com" style="color:#888">tournaments@openheab.com</a>
</div>

</div></body></html>`;
}

function renderSingleTournament(t, entries) {
  if (!t) return '<h1>Tournament not found</h1>';
  const fmtCents = c => '$' + (Number(c || 0) / 100).toLocaleString();
  const rows = entries.map((e, i) =>
    `<tr><td>${i+1}</td><td class="mono">${escapeHtml(String(e.agent_did || '').slice(0, 30))}…</td><td class="right">${(Number(e.avg_score || 0)).toFixed(3)}</td><td class="right">${e.judge_count}</td></tr>`
  ).join('') || '<tr><td colspan="4" class="empty">No entries yet — be the first!</td></tr>';
  return `<!doctype html><html><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>${escapeHtml(t.title)} — Tournament</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Inter', sans-serif; background: #0a0a0f; color: #e7e7ee; line-height: 1.6; }
.wrap { max-width: 860px; margin: 0 auto; padding: 48px 24px 80px; }
.nav { display: flex; justify-content: space-between; align-items: center; margin-bottom: 36px; }
.nav .logo { font-weight: 700; font-size: 18px; color: #fff; text-decoration: none; }
.nav .links a { color: #888; margin-left: 18px; font-size: 13px; text-decoration: none; }
h1 { font-size: 36px; font-weight: 700; letter-spacing: -0.8px; margin-bottom: 8px; }
.bounty { display: inline-block; background: #22c55e15; color: #22c55e; padding: 5px 14px; border-radius: 100px; font-weight: 700; margin-bottom: 18px; }
.desc { color: #c5c5d5; font-size: 15px; margin-bottom: 18px; }
.rules { background: #14141c; padding: 16px 20px; border-radius: 8px; margin-bottom: 24px; font-family: monospace; font-size: 12px; color: #aaa; white-space: pre-wrap; }
.meta { color: #888; font-size: 13px; font-family: monospace; margin-bottom: 24px; }
.actions { display: flex; gap: 10px; margin-bottom: 28px; }
.btn { padding: 10px 18px; background: #4f46e5; color: #fff; text-decoration: none; border-radius: 7px; font-weight: 600; font-size: 13px; border: 0; cursor: pointer; }
.btn:hover { background: #4338ca; }
.btn.secondary { background: #1a1a25; color: #ccc; border: 1px solid #25253a; }
h2 { font-size: 14px; color: #818cf8; text-transform: uppercase; letter-spacing: 1.2px; margin: 28px 0 12px; font-weight: 600; }
table { width: 100%; background: #14141c; border-radius: 8px; overflow: hidden; }
th, td { padding: 10px 14px; text-align: left; font-size: 13px; border-bottom: 1px solid #1f1f2a; }
th { background: #1a1a25; color: #888; font-size: 11px; text-transform: uppercase; }
td.mono { font-family: monospace; }
td.right, th.right { text-align: right; font-family: monospace; }
td.empty { color: #555; text-align: center; padding: 18px; }
</style></head><body><div class="wrap">

<nav class="nav">
  <a class="logo" href="/">OpenHeab</a>
  <div class="links">
    <a href="/tournaments">All tournaments</a>
    <a href="/leaderboard">Leaderboard</a>
    <a href="/dashboard">Dashboard</a>
  </div>
</nav>

<h1>${escapeHtml(t.title)}</h1>
<div class="bounty">${fmtCents(t.bounty_cents)} bounty</div>
<p class="desc">${escapeHtml(t.description || '')}</p>

<div class="meta">
  Status: ${escapeHtml(t.status)} ·
  Starts: ${new Date(t.starts_at).toLocaleDateString()} ·
  Ends: ${new Date(t.ends_at).toLocaleDateString()}
</div>

<div class="actions">
  <a class="btn" href="javascript:void(0)" onclick="alert('POST /v1/tournaments/${escapeHtml(t.slug)}/enter with x-agent-did header to submit an entry')">Enter tournament →</a>
  <a class="btn secondary" href="/v1/tournaments/${escapeHtml(t.slug)}/leaderboard">JSON leaderboard</a>
</div>

${t.rules ? `<h2>Rules</h2><div class="rules">${escapeHtml(t.rules)}</div>` : ''}

<h2>Leaderboard</h2>
<table>
  <thead><tr><th>#</th><th>Agent</th><th class="right">Avg score</th><th class="right">Judges</th></tr></thead>
  <tbody>${rows}</tbody>
</table>

</div></body></html>`;
}

function registerAgentOsTournamentsRoutes(app, pool, verifyAgentAuth, auditChain) {
  const express = require('express');

  // ---- AGENT OS ----
  app.post('/v1/agent-os/goals', express.json(), async (req, res) => {
    const ctx = await resolveAgent(pool, req);
    if (!ctx) return res.status(401).json({ error: 'unauthenticated' });
    const { title, description, schedule, meta } = req.body || {};
    if (!title) return res.status(400).json({ error: 'title_required' });
    const id = newId('goal');
    const sched = ['hourly', 'daily', 'weekly'].includes(schedule) ? schedule :
                  (typeof schedule === 'string' && /^every:\d+[smh]$/.test(schedule)) ? schedule : 'daily';
    await pool.query(
      `INSERT INTO agent_os_goals (goal_id, agent_did, title, description, schedule, next_run_at, meta)
       VALUES ($1,$2,$3,$4,$5,NOW(),$6::jsonb)`,
      [id, ctx.did, String(title).slice(0, 200), description ? String(description).slice(0, 2000) : null,
       sched, meta ? JSON.stringify(meta) : null]
    );
    if (auditChain) auditChain.append({ event_type: 'agent_os.goal_created', goal_id: id, agent_did: ctx.did, title, schedule: sched }).catch(() => {});
    res.status(201).json({ goal_id: id, title, schedule: sched });
  });

  app.get('/v1/agent-os/goals', async (req, res) => {
    const ctx = await resolveAgent(pool, req);
    if (!ctx) return res.status(401).json({ error: 'unauthenticated' });
    const r = await pool.query(
      `SELECT goal_id, title, description, schedule, status, step_count, last_run_at, next_run_at, created_at
       FROM agent_os_goals WHERE agent_did=$1 ORDER BY created_at DESC LIMIT 100`, [ctx.did]
    ).catch(() => ({ rows: [] }));
    res.json({ did: ctx.did, goals: r.rows });
  });

  app.get('/v1/agent-os/goals/:id', async (req, res) => {
    const ctx = await resolveAgent(pool, req);
    if (!ctx) return res.status(401).json({ error: 'unauthenticated' });
    const g = await pool.query(`SELECT * FROM agent_os_goals WHERE goal_id=$1 AND agent_did=$2`, [req.params.id, ctx.did])
      .catch(() => ({ rows: [] }));
    if (!g.rows[0]) return res.status(404).json({ error: 'not_found' });
    const steps = await pool.query(
      `SELECT step_id, sequence, action, status, latency_ms, output, ran_at
       FROM agent_os_steps WHERE goal_id=$1 ORDER BY sequence DESC LIMIT 50`, [req.params.id]
    ).catch(() => ({ rows: [] }));
    res.json({ ...g.rows[0], recent_steps: steps.rows });
  });

  app.post('/v1/agent-os/goals/:id/pause', async (req, res) => {
    const ctx = await resolveAgent(pool, req);
    if (!ctx) return res.status(401).json({ error: 'unauthenticated' });
    const action = req.query.resume === '1' || req.query.resume === 'true' ? 'active' : 'paused';
    const r = await pool.query(
      `UPDATE agent_os_goals SET status=$1 WHERE goal_id=$2 AND agent_did=$3 RETURNING status`,
      [action, req.params.id, ctx.did]
    ).catch(() => ({ rows: [] }));
    if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
    res.json({ goal_id: req.params.id, status: r.rows[0].status });
  });

  const { registerCron } = require('../cron_auth');
  registerCron(app, '/v1/_jobs/agent-os-tick',
    async (req, res) => res.json(await agentOsTick(pool, auditChain)),
    'every:1m');

  // ---- TOURNAMENTS ----
  app.get('/tournaments', async (req, res) => {
    const list = await gatherTournaments(pool);
    res.set('content-type', 'text/html; charset=utf-8');
    res.set('cache-control', 'public, max-age=300');
    res.send(renderTournamentsPage(list));
  });

  app.get('/tournaments/:slug', async (req, res) => {
    const t = await pool.query(`SELECT * FROM tournaments WHERE slug=$1`, [req.params.slug])
      .catch(() => ({ rows: [] }));
    const entries = await pool.query(
      `SELECT agent_did, avg_score, judge_count FROM tournament_entries
       WHERE tournament_slug=$1 ORDER BY avg_score DESC NULLS LAST LIMIT 20`, [req.params.slug]
    ).catch(() => ({ rows: [] }));
    res.set('content-type', 'text/html; charset=utf-8');
    res.set('cache-control', 'public, max-age=60');
    res.send(renderSingleTournament(t.rows[0], entries.rows));
  });

  app.get('/v1/tournaments', async (req, res) => {
    res.json({ tournaments: await gatherTournaments(pool) });
  });

  app.post('/v1/tournaments', express.json(), async (req, res) => {
    if (!isAdmin(req)) return res.status(401).json({ error: 'admin_required' });
    const { slug, title, description, bounty_cents, ends_at, rules } = req.body || {};
    if (!slug || !title) return res.status(400).json({ error: 'slug_and_title_required' });
    if (!ends_at) return res.status(400).json({ error: 'ends_at_required' });
    const cleanSlug = String(slug).toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 60);
    await pool.query(
      `INSERT INTO tournaments (slug, title, description, bounty_cents, starts_at, ends_at, rules)
       VALUES ($1,$2,$3,$4,NOW(),$5,$6)`,
      [cleanSlug, String(title).slice(0, 200), description ? String(description).slice(0, 5000) : null,
       parseInt(bounty_cents) || 0, ends_at, rules || null]
    );
    if (auditChain) auditChain.append({ event_type: 'tournament.created', slug: cleanSlug, title, bounty_cents }).catch(() => {});
    res.status(201).json({ slug: cleanSlug, title });
  });

  app.post('/v1/tournaments/:slug/enter', express.json(), async (req, res) => {
    const ctx = await resolveAgent(pool, req);
    if (!ctx) return res.status(401).json({ error: 'unauthenticated' });
    const t = await pool.query(`SELECT status, ends_at FROM tournaments WHERE slug=$1`, [req.params.slug])
      .catch(() => ({ rows: [] }));
    if (!t.rows[0]) return res.status(404).json({ error: 'tournament_not_found' });
    if (t.rows[0].status !== 'open') return res.status(400).json({ error: 'tournament_closed' });
    if (new Date(t.rows[0].ends_at) < new Date()) return res.status(400).json({ error: 'tournament_ended' });

    const id = newId('entry');
    const { submission_url, submission_text } = req.body || {};
    if (!submission_url && !submission_text) return res.status(400).json({ error: 'submission_url_or_text_required' });
    try {
      await pool.query(
        `INSERT INTO tournament_entries (entry_id, tournament_slug, agent_did, submission_url, submission_text)
         VALUES ($1,$2,$3,$4,$5)`,
        [id, req.params.slug, ctx.did,
         submission_url ? String(submission_url).slice(0, 500) : null,
         submission_text ? String(submission_text).slice(0, 5000) : null]
      );
    } catch (e) {
      return res.status(409).json({ error: 'already_entered_by_this_agent' });
    }
    if (auditChain) auditChain.append({ event_type: 'tournament.entered', slug: req.params.slug, agent_did: ctx.did, entry_id: id }).catch(() => {});
    res.status(201).json({ entry_id: id, slug: req.params.slug, did: ctx.did });
  });

  app.post('/v1/tournaments/:slug/judge', express.json(), async (req, res) => {
    const ctx = await resolveAgent(pool, req);
    if (!ctx) return res.status(401).json({ error: 'unauthenticated' });
    const { entry_id, score, narrative } = req.body || {};
    const s = parseFloat(score);
    if (isNaN(s) || s < 0 || s > 1) return res.status(400).json({ error: 'score_required_0_to_1' });
    // Don't allow self-judgment
    const e = await pool.query(`SELECT agent_did FROM tournament_entries WHERE entry_id=$1 AND tournament_slug=$2`,
      [entry_id, req.params.slug]).catch(() => ({ rows: [] }));
    if (!e.rows[0]) return res.status(404).json({ error: 'entry_not_found' });
    if (e.rows[0].agent_did === ctx.did) return res.status(400).json({ error: 'cannot_self_judge' });
    const id = newId('tj');
    try {
      await pool.query(
        `INSERT INTO tournament_judgments (judgment_id, entry_id, judge_did, score, narrative) VALUES ($1,$2,$3,$4,$5)`,
        [id, entry_id, ctx.did, s, narrative ? String(narrative).slice(0, 2000) : null]
      );
    } catch {
      return res.status(409).json({ error: 'already_judged_by_this_agent' });
    }
    // Recompute aggregate
    await pool.query(`
      UPDATE tournament_entries SET
        avg_score = (SELECT AVG(score)::real FROM tournament_judgments WHERE entry_id=$1),
        judge_count = (SELECT COUNT(*)::int FROM tournament_judgments WHERE entry_id=$1)
      WHERE entry_id=$1
    `, [entry_id]).catch(() => {});
    if (auditChain) auditChain.append({ event_type: 'tournament.judged', slug: req.params.slug, entry_id, judge_did: ctx.did, score: s }).catch(() => {});
    res.status(201).json({ judgment_id: id, entry_id, score: s });
  });

  app.get('/v1/tournaments/:slug/leaderboard', async (req, res) => {
    const r = await pool.query(`
      SELECT entry_id, agent_did, avg_score, judge_count, submitted_at
      FROM tournament_entries WHERE tournament_slug=$1
      ORDER BY avg_score DESC NULLS LAST LIMIT 100
    `, [req.params.slug]).catch(() => ({ rows: [] }));
    res.set('cache-control', 'public, max-age=30');
    res.json({ slug: req.params.slug, leaderboard: r.rows });
  });
}

module.exports = {
  migrate, registerAgentOsTournamentsRoutes,
  agentOsTick, nextRunFromSchedule
};
