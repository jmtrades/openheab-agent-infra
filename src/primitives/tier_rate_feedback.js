// ============================================================================
// tier_rate_feedback.js — production-readiness essentials:
//   - per-DID rate limiter that enforces tier quotas (token-bucket per agent)
//   - /v1/feedback endpoint + /feedback HTML form (capture user feedback)
//   - /v1/me/quotas just-the-quotas slim endpoint
// ============================================================================
const crypto = require('crypto');

async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS agent_rate_buckets (
      agent_did     TEXT PRIMARY KEY,
      tokens        DOUBLE PRECISION NOT NULL,
      last_refill   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS feedback (
      feedback_id   TEXT PRIMARY KEY,
      agent_did     TEXT,
      email         TEXT,
      kind          TEXT NOT NULL,
      severity      TEXT NOT NULL DEFAULT 'normal',
      title         TEXT NOT NULL,
      body          TEXT NOT NULL,
      page          TEXT,
      ip_hash       TEXT,
      ua_hash       TEXT,
      status        TEXT NOT NULL DEFAULT 'new',
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_feedback_recent ON feedback (created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_feedback_status ON feedback (status, created_at DESC);
  `);
}

// Token-bucket capacity per tier (per minute, refilled every second)
const BUCKETS = {
  free:       { capacity: 30,    refill_per_sec: 0.5 },
  starter:    { capacity: 120,   refill_per_sec: 2 },
  pro:        { capacity: 600,   refill_per_sec: 10 },
  team:       { capacity: 3000,  refill_per_sec: 50 },
  enterprise: { capacity: 30000, refill_per_sec: 500 }
};

async function getAgentTier(pool, did) {
  if (!did) return 'free';
  try {
    const r = await pool.query(
      `SELECT o.plan FROM org_members om JOIN orgs o USING (org_id)
       WHERE om.agent_did=$1 ORDER BY CASE om.role WHEN 'owner' THEN 0 ELSE 1 END LIMIT 1`,
      [did]
    ).catch(() => ({ rows: [] }));
    return r.rows[0]?.plan || 'free';
  } catch { return 'free'; }
}

// Returns { allowed, tier, remaining, retry_after_ms }
async function checkAndConsume(pool, did, cost = 1) {
  if (!did) return { allowed: true, tier: 'anon', remaining: null }; // Anonymous routes use the global limiter, not this.
  const tier = await getAgentTier(pool, did);
  const bucket = BUCKETS[tier] || BUCKETS.free;

  // Atomic upsert + refill + consume
  try {
    const now = Date.now();
    const r = await pool.query(
      `SELECT tokens, EXTRACT(EPOCH FROM (NOW() - last_refill)) * 1000 AS age_ms FROM agent_rate_buckets WHERE agent_did=$1`,
      [did]
    ).catch(() => ({ rows: [] }));
    let tokens = bucket.capacity;
    let ageMs = 0;
    if (r.rows[0]) {
      tokens = Number(r.rows[0].tokens || 0);
      ageMs = Number(r.rows[0].age_ms || 0);
      tokens = Math.min(bucket.capacity, tokens + (ageMs / 1000) * bucket.refill_per_sec);
    }
    if (tokens < cost) {
      const needed = cost - tokens;
      const retryAfterMs = Math.ceil((needed / bucket.refill_per_sec) * 1000);
      return { allowed: false, tier, remaining: Math.floor(tokens), retry_after_ms: retryAfterMs, capacity: bucket.capacity };
    }
    tokens -= cost;
    await pool.query(
      `INSERT INTO agent_rate_buckets (agent_did, tokens, last_refill) VALUES ($1, $2, NOW())
       ON CONFLICT (agent_did) DO UPDATE SET tokens=$2, last_refill=NOW()`,
      [did, tokens]
    ).catch(() => {});
    return { allowed: true, tier, remaining: Math.floor(tokens), capacity: bucket.capacity };
  } catch {
    return { allowed: true, tier, remaining: null }; // Fail-open on DB errors
  }
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

function renderFeedbackPage() {
  return `<!doctype html><html><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>Feedback — OpenHeab</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Inter', sans-serif; background: #0a0a0f; color: #e7e7ee; line-height: 1.6; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px; }
.card { max-width: 520px; width: 100%; background: #14141c; border: 1px solid #1f1f2a; border-radius: 16px; padding: 36px 40px; }
h1 { font-size: 26px; font-weight: 700; letter-spacing: -0.5px; margin-bottom: 8px; }
.sub { color: #888; font-size: 14px; margin-bottom: 24px; }
label { display: block; font-size: 11px; color: #888; text-transform: uppercase; letter-spacing: 0.5px; margin: 14px 0 6px; font-weight: 600; }
input, select, textarea { width: 100%; padding: 10px 14px; background: #0f0f17; border: 1px solid #1f1f2a; color: #fff; border-radius: 8px; font-size: 14px; font-family: inherit; outline: none; }
input:focus, select:focus, textarea:focus { border-color: #4f46e5; }
textarea { min-height: 120px; resize: vertical; }
.btn { display: block; width: 100%; padding: 12px; background: #4f46e5; color: #fff; border: 0; border-radius: 8px; font-weight: 600; cursor: pointer; font-size: 15px; margin-top: 18px; }
.btn:hover { background: #4338ca; }
.btn:disabled { opacity: 0.5; cursor: not-allowed; }
.row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.thanks { text-align: center; padding: 32px; color: #22c55e; font-size: 18px; display: none; }
.thanks.show { display: block; }
.thanks small { display: block; color: #888; font-size: 13px; margin-top: 8px; }
.form.hide { display: none; }
.foot { color: #555; font-size: 12px; margin-top: 18px; text-align: center; }
.foot a { color: #888; }
</style></head><body>
<div class="card">
  <h1>Tell us what's wrong (or right)</h1>
  <p class="sub">Bugs, feature requests, confusion, praise — we read every one. Optional fields are optional.</p>

  <form class="form" id="form" onsubmit="event.preventDefault();submit()">
    <div class="row">
      <div>
        <label>Type</label>
        <select id="kind">
          <option value="bug">🐛 Bug</option>
          <option value="feature">💡 Feature request</option>
          <option value="question">❓ Question</option>
          <option value="praise">❤️ Praise</option>
          <option value="other">Other</option>
        </select>
      </div>
      <div>
        <label>Severity</label>
        <select id="severity">
          <option value="low">Low</option>
          <option value="normal" selected>Normal</option>
          <option value="high">High</option>
          <option value="critical">Critical</option>
        </select>
      </div>
    </div>

    <label>Short title</label>
    <input id="title" required maxlength="200" placeholder="e.g. /v1/transfer returns 500 with empty body" />

    <label>Details</label>
    <textarea id="body" required maxlength="5000" placeholder="What happened? What did you expect? Steps to reproduce?"></textarea>

    <div class="row">
      <div>
        <label>Your email (optional)</label>
        <input id="email" type="email" placeholder="you@example.com" />
      </div>
      <div>
        <label>Your DID (optional)</label>
        <input id="did" placeholder="did:op:..." />
      </div>
    </div>

    <button class="btn" type="submit" id="submit">Send feedback</button>
  </form>

  <div class="thanks" id="thanks">
    Thanks! We've logged this.
    <small id="thanks-id"></small>
  </div>

  <div class="foot">
    Prefer email? <a href="mailto:feedback@openheab.com">feedback@openheab.com</a> · <a href="/help">Help center</a> · <a href="/status">Status page</a>
  </div>
</div>
<script>
async function submit() {
  document.getElementById('submit').disabled = true;
  const body = {
    kind: document.getElementById('kind').value,
    severity: document.getElementById('severity').value,
    title: document.getElementById('title').value.trim(),
    body: document.getElementById('body').value.trim(),
    email: document.getElementById('email').value.trim() || undefined,
    agent_did: document.getElementById('did').value.trim() || undefined,
    page: document.referrer || undefined
  };
  try {
    const r = await fetch('/v1/feedback', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
    const j = await r.json();
    if (j.feedback_id) {
      document.getElementById('form').classList.add('hide');
      document.getElementById('thanks').classList.add('show');
      document.getElementById('thanks-id').textContent = 'Reference: ' + j.feedback_id;
    } else {
      alert('Submission failed: ' + JSON.stringify(j));
      document.getElementById('submit').disabled = false;
    }
  } catch (e) {
    alert('Submission failed: ' + e.message);
    document.getElementById('submit').disabled = false;
  }
}
</script>
</body></html>`;
}

function registerTierRateFeedbackRoutes(app, pool, verifyAgentAuth, auditChain) {
  const express = require('express');

  // POST /v1/me/rate-check — explicit "would my next call be rate-limited"
  app.post('/v1/me/rate-check', express.json(), async (req, res) => {
    let did = null;
    try {
      const ctx = await require('./me_endpoints').resolveAgentFromRequest(pool, req);
      did = ctx?.did;
    } catch {}
    if (!did) return res.status(401).json({ error: 'unauthenticated' });
    const cost = Math.max(1, Math.min(parseInt(req.body?.cost) || 1, 100));
    const result = await checkAndConsume(pool, did, cost);
    res.set('x-ratelimit-remaining', String(result.remaining || 0));
    res.set('x-ratelimit-tier', result.tier);
    if (!result.allowed) res.set('retry-after', String(Math.ceil(result.retry_after_ms / 1000)));
    res.status(result.allowed ? 200 : 429).json(result);
  });

  // GET /v1/me/quotas — slim quota-only endpoint
  app.get('/v1/me/quotas', async (req, res) => {
    let did = null;
    try {
      const ctx = await require('./me_endpoints').resolveAgentFromRequest(pool, req);
      did = ctx?.did;
    } catch {}
    if (!did) return res.status(401).json({ error: 'unauthenticated' });
    const tier = await getAgentTier(pool, did);
    const bucket = BUCKETS[tier] || BUCKETS.free;
    const r = await pool.query(
      `SELECT tokens, EXTRACT(EPOCH FROM (NOW() - last_refill)) * 1000 AS age_ms FROM agent_rate_buckets WHERE agent_did=$1`,
      [did]
    ).catch(() => ({ rows: [] }));
    let tokens = bucket.capacity;
    if (r.rows[0]) {
      tokens = Number(r.rows[0].tokens || 0);
      const ageMs = Number(r.rows[0].age_ms || 0);
      tokens = Math.min(bucket.capacity, tokens + (ageMs / 1000) * bucket.refill_per_sec);
    }
    res.json({
      did, tier, bucket_capacity: bucket.capacity, bucket_refill_per_sec: bucket.refill_per_sec,
      tokens_remaining: Math.floor(tokens),
      seconds_to_full: Math.ceil((bucket.capacity - tokens) / bucket.refill_per_sec)
    });
  });

  // POST /v1/feedback — capture user feedback
  app.post('/v1/feedback', express.json(), async (req, res) => {
    const body = req.body || {};
    const title = String(body.title || '').slice(0, 200).trim();
    const text = String(body.body || '').slice(0, 5000).trim();
    if (!title || !text) return res.status(400).json({ error: 'title_and_body_required' });
    const kind = ['bug', 'feature', 'question', 'praise', 'other'].includes(body.kind) ? body.kind : 'other';
    const severity = ['low', 'normal', 'high', 'critical'].includes(body.severity) ? body.severity : 'normal';
    const id = 'fb_' + crypto.randomBytes(8).toString('hex');
    const ipHash = crypto.createHash('sha256').update(String(req.ip || req.headers['x-forwarded-for'] || 'anon')).digest('hex').slice(0, 16);
    const uaHash = crypto.createHash('sha256').update(String(req.headers['user-agent'] || 'anon')).digest('hex').slice(0, 16);
    await pool.query(
      `INSERT INTO feedback (feedback_id, agent_did, email, kind, severity, title, body, page, ip_hash, ua_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [id, body.agent_did || null, body.email || null, kind, severity, title, text,
       String(body.page || '').slice(0, 500) || null, ipHash, uaHash]
    ).catch(() => {});
    if (auditChain) auditChain.append({
      event_type: 'feedback.submitted', feedback_id: id, kind, severity,
      agent_did: body.agent_did, email_present: !!body.email
    }).catch(() => {});
    res.status(201).json({ feedback_id: id, status: 'received', kind, severity });
  });

  // GET /feedback — HTML form
  app.get('/feedback', (req, res) => {
    res.set('content-type', 'text/html; charset=utf-8');
    res.set('cache-control', 'public, max-age=300');
    res.send(renderFeedbackPage());
  });

  // Admin: list all feedback
  app.get('/v1/admin/feedback', async (req, res) => {
    const tok = process.env.OPERATOR_ADMIN_TOKEN || process.env.INTERNAL_API_KEY;
    if (!tok || req.headers['x-admin-token'] !== tok) return res.status(401).json({ error: 'admin_required' });
    const status = req.query.status || 'new';
    const r = await pool.query(
      `SELECT feedback_id, agent_did, email, kind, severity, title, body, page, status, created_at
       FROM feedback WHERE status=$1 OR $1='all' ORDER BY created_at DESC LIMIT 200`,
      [status]
    ).catch(() => ({ rows: [] }));
    res.json({ status, count: r.rows.length, feedback: r.rows });
  });

  // Admin: resolve a feedback item
  app.post('/v1/admin/feedback/:id/resolve', express.json(), async (req, res) => {
    const tok = process.env.OPERATOR_ADMIN_TOKEN || process.env.INTERNAL_API_KEY;
    if (!tok || req.headers['x-admin-token'] !== tok) return res.status(401).json({ error: 'admin_required' });
    await pool.query(`UPDATE feedback SET status='resolved' WHERE feedback_id=$1`, [req.params.id]).catch(() => {});
    res.json({ resolved: true });
  });
}

module.exports = { migrate, registerTierRateFeedbackRoutes, checkAndConsume, getAgentTier, BUCKETS };
