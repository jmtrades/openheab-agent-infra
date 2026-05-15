// ============================================================================
// OpenHeab Onboarding — Activation funnel for new agents
// First-run experience that takes brand-new agents from signup to first
// revenue-generating action in <5 minutes. Tracks the activation funnel
// (started -> activated -> qualified -> converted -> expanded) and exposes
// helpers other primitives can call when an action completes (e.g., the
// bank_chain primitive calls markStepComplete on first transfer).
// ============================================================================
const express = require('express');
const cryptoLib = require('crypto');
const { z } = require('zod');
const { registerCron } = require('../cron_auth');

const SOURCES = [
  'mcp', 'cli', 'web', 'sdk_python', 'sdk_typescript', 'partner_referral', 'unknown'
];

const STEP_KINDS = ['required', 'recommended', 'optional'];

const STANDARD_STEPS = [
  { code: 'create_identity',     name: 'Create your agent identity',     description: 'Generate Ed25519 keypair and DID',           kind: 'required',    points: 10, sequence: 1 },
  { code: 'fund_wallet',         name: 'Fund your USDC wallet',          description: 'Top up your non-custodial USDC wallet',      kind: 'recommended', points: 25, sequence: 2 },
  { code: 'send_first_transfer', name: 'Send your first transfer',       description: 'Send USDC to another agent or address',      kind: 'recommended', points: 25, sequence: 3 },
  { code: 'first_inference',     name: 'Run your first inference call',  description: 'Call an LLM through the inference primitive', kind: 'recommended', points: 25, sequence: 4 },
  { code: 'install_extension',   name: 'Install an extension',           description: 'Browse the marketplace and install a tool',  kind: 'optional',    points: 15, sequence: 5 },
  { code: 'invite_team',         name: 'Invite a teammate',              description: 'Add another member to your org',             kind: 'optional',    points: 20, sequence: 6 },
  { code: 'connect_kyc',         name: 'Verify your identity (KYC)',     description: 'Connect KYC for higher limits',              kind: 'optional',    points: 30, sequence: 7 },
  { code: 'create_card',         name: 'Issue a debit card',             description: 'Create a virtual card for your wallet',      kind: 'optional',    points: 30, sequence: 8 },
  { code: 'subscribe_plan',      name: 'Subscribe to a paid plan',       description: 'Upgrade to Pro/Team/Enterprise',             kind: 'recommended', points: 50, sequence: 9 }
];

const CONVERSION_STEP = 'subscribe_plan';
const ACTIVATED_STEP = 'create_identity';
const QUALIFIED_STEPS = ['fund_wallet', 'first_inference', 'send_first_transfer'];

// ----------------------------------------------------------------------------
// Migration
// ----------------------------------------------------------------------------
async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS onboarding_journeys (
      journey_id    TEXT PRIMARY KEY,
      agent_did     TEXT NOT NULL,
      org_id        TEXT,
      started_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at  TIMESTAMPTZ,
      abandoned_at  TIMESTAMPTZ,
      current_step  TEXT,
      total_steps   INTEGER NOT NULL DEFAULT 0,
      source        TEXT,
      utm_source    TEXT,
      utm_medium    TEXT,
      utm_campaign  TEXT,
      last_nudge_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_onboarding_journeys_did ON onboarding_journeys (agent_did);
    CREATE INDEX IF NOT EXISTS idx_onboarding_journeys_org ON onboarding_journeys (org_id);
    CREATE INDEX IF NOT EXISTS idx_onboarding_journeys_started ON onboarding_journeys (started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_onboarding_journeys_completed ON onboarding_journeys (completed_at);

    CREATE TABLE IF NOT EXISTS onboarding_steps (
      step_id      TEXT PRIMARY KEY,
      code         TEXT UNIQUE NOT NULL,
      name         TEXT NOT NULL,
      description  TEXT,
      kind         TEXT NOT NULL DEFAULT 'optional',
      points       INTEGER NOT NULL DEFAULT 10,
      sequence     INTEGER NOT NULL DEFAULT 0,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_onboarding_steps_seq ON onboarding_steps (sequence);

    CREATE TABLE IF NOT EXISTS onboarding_step_completions (
      completion_id   TEXT PRIMARY KEY,
      journey_id      TEXT NOT NULL,
      step_id         TEXT NOT NULL,
      completed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      evidence_payload JSONB,
      points_earned   INTEGER NOT NULL DEFAULT 0,
      UNIQUE (journey_id, step_id)
    );
    CREATE INDEX IF NOT EXISTS idx_onboarding_completions_journey ON onboarding_step_completions (journey_id);
    CREATE INDEX IF NOT EXISTS idx_onboarding_completions_step ON onboarding_step_completions (step_id);

    CREATE TABLE IF NOT EXISTS onboarding_milestones (
      milestone_id  TEXT PRIMARY KEY,
      agent_did     TEXT NOT NULL,
      code          TEXT NOT NULL,
      achieved_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      value_cents   BIGINT,
      UNIQUE (agent_did, code)
    );
    CREATE INDEX IF NOT EXISTS idx_onboarding_milestones_did ON onboarding_milestones (agent_did);
    CREATE INDEX IF NOT EXISTS idx_onboarding_milestones_code ON onboarding_milestones (code, achieved_at DESC);
  `).catch(() => {});

  // Seed standard steps
  for (const s of STANDARD_STEPS) {
    const stepId = 'step_' + cryptoLib.createHash('sha256').update(s.code).digest('hex').slice(0, 16);
    await pool.query(
      `INSERT INTO onboarding_steps (step_id, code, name, description, kind, points, sequence)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (code) DO UPDATE SET
         name = EXCLUDED.name,
         description = EXCLUDED.description,
         kind = EXCLUDED.kind,
         points = EXCLUDED.points,
         sequence = EXCLUDED.sequence`,
      [stepId, s.code, s.name, s.description, s.kind, s.points, s.sequence]
    ).catch(() => {});
  }
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------
function genId(prefix) {
  return `${prefix}_${cryptoLib.randomBytes(12).toString('hex')}`;
}

async function getOrCreateJourney(pool, agentDid, opts = {}) {
  const existing = await pool.query(
    `SELECT * FROM onboarding_journeys WHERE agent_did = $1
     ORDER BY started_at DESC LIMIT 1`,
    [agentDid]
  ).catch(() => ({ rows: [] }));
  if (existing.rows[0]) return existing.rows[0];

  const journeyId = genId('jrn');
  const totalR = await pool.query(`SELECT COUNT(*)::int AS n FROM onboarding_steps`).catch(() => ({ rows: [{ n: 0 }] }));
  await pool.query(
    `INSERT INTO onboarding_journeys
       (journey_id, agent_did, org_id, source, utm_source, utm_medium, utm_campaign, total_steps, current_step)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [journeyId, agentDid, opts.org_id || null, opts.source || 'unknown',
     opts.utm_source || null, opts.utm_medium || null, opts.utm_campaign || null,
     parseInt(totalR.rows[0]?.n || 0), STANDARD_STEPS[0].code]
  ).catch(() => {});

  const r = await pool.query(`SELECT * FROM onboarding_journeys WHERE journey_id = $1`, [journeyId]).catch(() => ({ rows: [] }));
  return r.rows[0];
}

async function recordMilestone(pool, agentDid, code, valueCents, auditChain) {
  const id = genId('mile');
  const r = await pool.query(
    `INSERT INTO onboarding_milestones (milestone_id, agent_did, code, value_cents)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (agent_did, code) DO NOTHING
     RETURNING milestone_id`,
    [id, agentDid, code, valueCents || null]
  ).catch(() => ({ rows: [] }));
  if (r.rows[0] && auditChain) {
    await auditChain.append({
      event_type: 'onboarding.milestone_achieved',
      agent_did: agentDid, milestone: code, value_cents: valueCents || null,
      timestamp: new Date().toISOString()
    }).catch(() => {});
  }
  return r.rows[0]?.milestone_id || null;
}

async function checkAndRecordMilestones(pool, agentDid, auditChain) {
  // ACTIVATED if 'create_identity' done
  const completionsR = await pool.query(
    `SELECT s.code FROM onboarding_step_completions c
     JOIN onboarding_steps s ON s.step_id = c.step_id
     JOIN onboarding_journeys j ON j.journey_id = c.journey_id
     WHERE j.agent_did = $1`,
    [agentDid]
  ).catch(() => ({ rows: [] }));
  const completed = new Set(completionsR.rows.map(r => r.code));

  if (completed.has(ACTIVATED_STEP)) {
    await recordMilestone(pool, agentDid, 'activated', null, auditChain);
  }
  // QUALIFIED if any of the qualifying actions
  if (QUALIFIED_STEPS.some(c => completed.has(c))) {
    await recordMilestone(pool, agentDid, 'qualified', null, auditChain);
  }
  // CONVERTED if subscribe_plan
  if (completed.has(CONVERSION_STEP)) {
    await recordMilestone(pool, agentDid, 'converted', null, auditChain);
  }
  // EXPANDED if subscribe + at least 4 other recommended/required completions
  const otherCount = [...completed].filter(c => c !== CONVERSION_STEP).length;
  if (completed.has(CONVERSION_STEP) && otherCount >= 4) {
    await recordMilestone(pool, agentDid, 'expanded', null, auditChain);
  }
}

async function markStepComplete({ pool, agent_did, step_code, evidence_payload, auditChain }) {
  if (!pool || !agent_did || !step_code) return { ok: false, error: 'missing_args' };

  const stepR = await pool.query(`SELECT * FROM onboarding_steps WHERE code = $1`, [step_code]).catch(() => ({ rows: [] }));
  if (!stepR.rows[0]) return { ok: false, error: 'unknown_step_code' };
  const step = stepR.rows[0];

  // Auto-create journey if first event
  let journey = (await pool.query(
    `SELECT * FROM onboarding_journeys WHERE agent_did = $1 ORDER BY started_at DESC LIMIT 1`, [agent_did]
  ).catch(() => ({ rows: [] }))).rows[0];
  if (!journey) {
    journey = await getOrCreateJourney(pool, agent_did, {});
  }
  if (!journey) return { ok: false, error: 'no_journey' };

  const completionId = genId('cmp');
  const inserted = await pool.query(
    `INSERT INTO onboarding_step_completions
       (completion_id, journey_id, step_id, evidence_payload, points_earned)
     VALUES ($1,$2,$3,$4::jsonb,$5)
     ON CONFLICT (journey_id, step_id) DO NOTHING
     RETURNING completion_id`,
    [completionId, journey.journey_id, step.step_id,
     JSON.stringify(evidence_payload || {}), step.points || 0]
  ).catch(() => ({ rows: [] }));

  if (!inserted.rows[0]) {
    // Already complete — idempotent
    return { ok: true, already: true, journey_id: journey.journey_id };
  }

  // Update current_step and check completion
  const allDoneR = await pool.query(
    `SELECT COUNT(*)::int AS done FROM onboarding_step_completions WHERE journey_id = $1`,
    [journey.journey_id]
  ).catch(() => ({ rows: [{ done: 0 }] }));
  const totalR = await pool.query(
    `SELECT COUNT(*)::int AS total FROM onboarding_steps WHERE kind = 'required'`
  ).catch(() => ({ rows: [{ total: 0 }] }));
  const requiredDoneR = await pool.query(
    `SELECT COUNT(*)::int AS n FROM onboarding_step_completions c
     JOIN onboarding_steps s ON s.step_id = c.step_id
     WHERE c.journey_id = $1 AND s.kind = 'required'`,
    [journey.journey_id]
  ).catch(() => ({ rows: [{ n: 0 }] }));

  const requiredTotal = parseInt(totalR.rows[0].total) || 0;
  const requiredDone = parseInt(requiredDoneR.rows[0].n) || 0;
  const allRequiredDone = requiredTotal > 0 && requiredDone >= requiredTotal;

  // Pick next step (lowest sequence not yet completed)
  const nextR = await pool.query(
    `SELECT s.code FROM onboarding_steps s
     LEFT JOIN onboarding_step_completions c
       ON c.step_id = s.step_id AND c.journey_id = $1
     WHERE c.completion_id IS NULL
     ORDER BY s.sequence ASC LIMIT 1`,
    [journey.journey_id]
  ).catch(() => ({ rows: [] }));
  const nextStep = nextR.rows[0]?.code || null;

  await pool.query(
    `UPDATE onboarding_journeys
     SET current_step = $2,
         completed_at = CASE WHEN $3::boolean AND completed_at IS NULL THEN NOW() ELSE completed_at END,
         abandoned_at = NULL
     WHERE journey_id = $1`,
    [journey.journey_id, nextStep, allRequiredDone]
  ).catch(() => {});

  if (auditChain) {
    await auditChain.append({
      event_type: 'onboarding.step_completed',
      agent_did, step_code, journey_id: journey.journey_id,
      points_earned: step.points || 0,
      timestamp: new Date().toISOString()
    }).catch(() => {});
  }

  await checkAndRecordMilestones(pool, agent_did, auditChain);

  return {
    ok: true,
    journey_id: journey.journey_id,
    step_code,
    points_earned: step.points || 0,
    all_required_complete: allRequiredDone,
    next_step: nextStep
  };
}

async function getJourneyState(pool, agentDid) {
  const journeyR = await pool.query(
    `SELECT * FROM onboarding_journeys WHERE agent_did = $1
     ORDER BY started_at DESC LIMIT 1`, [agentDid]
  ).catch(() => ({ rows: [] }));
  const journey = journeyR.rows[0] || null;

  const stepsR = await pool.query(
    `SELECT s.step_id, s.code, s.name, s.description, s.kind, s.points, s.sequence,
            c.completion_id, c.completed_at, c.points_earned
     FROM onboarding_steps s
     LEFT JOIN onboarding_step_completions c
       ON c.step_id = s.step_id AND c.journey_id = $1
     ORDER BY s.sequence ASC`,
    [journey?.journey_id || null]
  ).catch(() => ({ rows: [] }));

  const checklist = stepsR.rows.map(r => ({
    code: r.code, name: r.name, description: r.description,
    kind: r.kind, points: r.points, sequence: r.sequence,
    completed: !!r.completion_id,
    completed_at: r.completed_at, points_earned: r.points_earned || 0
  }));

  const totalPoints = checklist.reduce((s, x) => s + (x.completed ? (x.points_earned || x.points || 0) : 0), 0);
  const possiblePoints = checklist.reduce((s, x) => s + (x.points || 0), 0);
  const completedCount = checklist.filter(x => x.completed).length;
  const progress = checklist.length ? completedCount / checklist.length : 0;

  const milestonesR = await pool.query(
    `SELECT code, achieved_at, value_cents FROM onboarding_milestones WHERE agent_did = $1
     ORDER BY achieved_at ASC`, [agentDid]
  ).catch(() => ({ rows: [] }));

  return {
    agent_did: agentDid,
    journey,
    checklist,
    completed_count: completedCount,
    total_steps: checklist.length,
    progress_pct: Math.round(progress * 100),
    points_earned: totalPoints,
    points_possible: possiblePoints,
    milestones: milestonesR.rows
  };
}

async function funnelStats(pool, fromDate, toDate) {
  const from = fromDate || new Date(Date.now() - 30 * 86400000).toISOString();
  const to = toDate || new Date().toISOString();
  const startedR = await pool.query(
    `SELECT COUNT(*)::int AS n FROM onboarding_journeys WHERE started_at BETWEEN $1 AND $2`,
    [from, to]
  ).catch(() => ({ rows: [{ n: 0 }] }));

  const milestoneR = await pool.query(
    `SELECT code, COUNT(*)::int AS n FROM onboarding_milestones
     WHERE achieved_at BETWEEN $1 AND $2 GROUP BY code`,
    [from, to]
  ).catch(() => ({ rows: [] }));
  const ms = { activated: 0, qualified: 0, converted: 0, expanded: 0 };
  for (const row of milestoneR.rows) ms[row.code] = parseInt(row.n) || 0;

  const sourceR = await pool.query(
    `SELECT COALESCE(source, 'unknown') AS source, COUNT(*)::int AS n
     FROM onboarding_journeys WHERE started_at BETWEEN $1 AND $2
     GROUP BY source ORDER BY n DESC`,
    [from, to]
  ).catch(() => ({ rows: [] }));

  const stepsR = await pool.query(
    `SELECT s.code, COUNT(c.completion_id)::int AS n
     FROM onboarding_steps s
     LEFT JOIN onboarding_step_completions c ON c.step_id = s.step_id
       AND c.completed_at BETWEEN $1 AND $2
     GROUP BY s.code, s.sequence
     ORDER BY s.sequence ASC`,
    [from, to]
  ).catch(() => ({ rows: [] }));

  const started = parseInt(startedR.rows[0]?.n || 0);
  return {
    from, to,
    started, activated: ms.activated, qualified: ms.qualified,
    converted: ms.converted, expanded: ms.expanded,
    activation_rate: started ? ms.activated / started : 0,
    qualification_rate: started ? ms.qualified / started : 0,
    conversion_rate: started ? ms.converted / started : 0,
    expansion_rate: started ? ms.expanded / started : 0,
    by_source: sourceR.rows,
    by_step: stepsR.rows
  };
}

// ----------------------------------------------------------------------------
// Routes
// ----------------------------------------------------------------------------
function registerOnboardingRoutes(app, pool, verifyAgentAuth, auditChain) {
  // POST /v1/agents/:did/onboarding/start
  const StartSchema = z.object({
    source: z.string().max(60).optional(),
    utm_source: z.string().max(120).optional(),
    utm_medium: z.string().max(120).optional(),
    utm_campaign: z.string().max(120).optional(),
    org_id: z.string().max(120).optional()
  });

  app.post('/v1/agents/:did/onboarding/start', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const parse = StartSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;
      const journey = await getOrCreateJourney(pool, did, {
        source: d.source || 'unknown',
        utm_source: d.utm_source,
        utm_medium: d.utm_medium,
        utm_campaign: d.utm_campaign,
        org_id: d.org_id
      });
      await auditChain.append({
        event_type: 'onboarding.journey_started',
        agent_did: did, journey_id: journey?.journey_id,
        source: d.source || 'unknown',
        timestamp: new Date().toISOString()
      });
      const state = await getJourneyState(pool, did);
      return res.status(201).json({
        journey_id: journey?.journey_id,
        agent_did: did,
        ...state
      });
    } catch (e) {
      console.error('[onboarding.start]', e);
      return res.status(500).json({ error: 'start_failed', message: e.message });
    }
  });

  // GET /v1/agents/:did/onboarding
  app.get('/v1/agents/:did/onboarding', async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const state = await getJourneyState(pool, did);
      return res.json(state);
    } catch (e) {
      console.error('[onboarding.get]', e);
      return res.status(500).json({ error: 'fetch_failed', message: e.message });
    }
  });

  // POST /v1/agents/:did/onboarding/complete
  const CompleteSchema = z.object({
    step_code: z.string().min(1).max(120),
    evidence_payload: z.record(z.any()).optional()
  });

  app.post('/v1/agents/:did/onboarding/complete', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const parse = CompleteSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;
      const r = await markStepComplete({
        pool, agent_did: did, step_code: d.step_code,
        evidence_payload: d.evidence_payload || {}, auditChain
      });
      if (!r.ok) return res.status(400).json({ error: r.error });
      return res.json(r);
    } catch (e) {
      console.error('[onboarding.complete]', e);
      return res.status(500).json({ error: 'complete_failed', message: e.message });
    }
  });

  // GET /v1/onboarding/steps (PUBLIC)
  app.get('/v1/onboarding/steps', async (_req, res) => {
    const r = await pool.query(
      `SELECT code, name, description, kind, points, sequence FROM onboarding_steps
       ORDER BY sequence ASC`
    ).catch(() => ({ rows: [] }));
    return res.json({ steps: r.rows, count: r.rows.length });
  });

  // GET /v1/admin/onboarding/funnel
  app.get('/v1/admin/onboarding/funnel', async (req, res) => {
    const token = req.headers['x-admin-token'];
    if (!token || token !== process.env.OPERATOR_ADMIN_TOKEN) {
      return res.status(401).json({ error: 'admin_required' });
    }
    const stats = await funnelStats(pool, req.query.from, req.query.to);
    return res.json(stats);
  });

  // GET /v1/admin/onboarding/abandoned
  app.get('/v1/admin/onboarding/abandoned', async (req, res) => {
    const token = req.headers['x-admin-token'];
    if (!token || token !== process.env.OPERATOR_ADMIN_TOKEN) {
      return res.status(401).json({ error: 'admin_required' });
    }
    const olderThanHours = Math.max(1, parseInt(req.query.older_than_hours || '24'));
    const r = await pool.query(
      `SELECT j.journey_id, j.agent_did, j.org_id, j.started_at, j.current_step,
              j.source, j.utm_source, j.utm_medium, j.utm_campaign,
              (SELECT COUNT(*)::int FROM onboarding_step_completions c
               WHERE c.journey_id = j.journey_id) AS steps_done
       FROM onboarding_journeys j
       WHERE j.completed_at IS NULL
         AND j.started_at < NOW() - ($1 || ' hours')::interval
         AND NOT EXISTS (
           SELECT 1 FROM onboarding_step_completions c
           JOIN onboarding_steps s ON s.step_id = c.step_id
           WHERE c.journey_id = j.journey_id AND s.kind = 'required'
         )
       ORDER BY j.started_at ASC LIMIT 500`,
      [String(olderThanHours)]
    ).catch(() => ({ rows: [] }));
    return res.json({ abandoned: r.rows, count: r.rows.length });
  });

  // POST /v1/_jobs/onboarding-nudge (cron)
  registerCron(app, '/v1/_jobs/onboarding-nudge', async (_req, res) => {
    try {
      const r = await pool.query(
        `SELECT j.journey_id, j.agent_did, j.current_step
         FROM onboarding_journeys j
         WHERE j.completed_at IS NULL AND j.abandoned_at IS NULL
           AND j.started_at < NOW() - INTERVAL '24 hours'
           AND (j.last_nudge_at IS NULL OR j.last_nudge_at < NOW() - INTERVAL '7 days')
         LIMIT 200`
      ).catch(() => ({ rows: [] }));

      let sent = 0;
      let emailErrors = 0;
      let emailMod = null;
      try { emailMod = require('./email'); } catch {}

      for (const row of r.rows) {
        // Try to send a nudge email if email primitive + agent has primary address
        let emailed = false;
        if (emailMod && process.env.EMAIL_GATEWAY_URL && process.env.EMAIL_GATEWAY_SECRET) {
          try {
            const addr = await pool.query(
              `SELECT address FROM email_addresses WHERE agent_did = $1
               ORDER BY is_primary DESC, created_at ASC LIMIT 1`,
              [row.agent_did]
            ).catch(() => ({ rows: [] }));
            if (addr.rows[0]) {
              const fromAddr = `noreply@${process.env.EMAIL_DOMAIN || 'openheab.com'}`;
              const messageId = 'msg_' + cryptoLib.randomBytes(12).toString('hex');
              const subject = 'Finish setting up your OpenHeab agent';
              const bodyText = `Hi! Your OpenHeab agent ${row.agent_did} has unfinished onboarding steps.\n\n` +
                `Next step: ${row.current_step || 'create_identity'}\n\n` +
                `Resume: ${process.env.OPERATOR_PUBLIC_URL || 'https://openheab.com'}/v1/dashboard\n\n— OpenHeab`;
              const mime = emailMod.buildMime({
                from: fromAddr, to: [addr.rows[0].address],
                subject, bodyText, messageId
              });
              const payload = JSON.stringify({
                message_id: messageId, from: fromAddr, to: [addr.rows[0].address],
                cc: [], mime, agent_did: row.agent_did
              });
              const sig = emailMod.hmacSign(process.env.EMAIL_GATEWAY_SECRET, payload);
              const fres = await fetch(`${process.env.EMAIL_GATEWAY_URL.replace(/\/$/, '')}/relay`, {
                method: 'POST',
                headers: {
                  'content-type': 'application/json',
                  'x-openheab-signature': `sha256=${sig}`
                },
                body: payload
              }).catch(() => null);
              if (fres && fres.ok) emailed = true;
              else emailErrors++;
            }
          } catch { emailErrors++; }
        }

        await pool.query(
          `UPDATE onboarding_journeys SET last_nudge_at = NOW() WHERE journey_id = $1`,
          [row.journey_id]
        ).catch(() => {});
        await auditChain.append({
          event_type: 'onboarding.nudge_sent',
          agent_did: row.agent_did, journey_id: row.journey_id,
          emailed, timestamp: new Date().toISOString()
        }).catch(() => {});
        if (emailed) sent++;
      }
      return res.json({ scanned: r.rows.length, emailed: sent, email_errors: emailErrors });
    } catch (e) {
      console.error('[onboarding.nudge]', e);
      return res.status(500).json({ error: 'nudge_failed', message: e.message });
    }
  });
}

module.exports = {
  migrate,
  registerOnboardingRoutes,
  markStepComplete,
  getJourneyState,
  funnelStats,
  STANDARD_STEPS,
  SOURCES,
  STEP_KINDS
};
