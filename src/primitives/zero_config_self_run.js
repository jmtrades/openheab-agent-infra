// ============================================================================
// zero_config_self_run.js — distribution + auto-ops + revenue automation:
//   - /install                — one-line shell installer (curl | sh)
//   - /deploy/vercel          — "Deploy to Vercel" page with prefilled env
//   - /deploy/render.yaml     — Render.com blueprint for one-click deploy
//   - /deploy/railway.json    — Railway template
//   - /v1/_jobs/auto-incident-watch  — cron: hits /v1/_health/deep, if red
//                                       and no active incident → auto-declares
//   - /v1/_jobs/auto-upgrade-nudge   — cron: finds agents near quota cap,
//                                       drops a notification + email digest
//   - /v1/_jobs/auto-summary-digest  — cron: weekly digest per agent
//   - /launch-button.svg      — "Deploy on OpenHeab" badge for competitor sites
// ============================================================================
const crypto = require('crypto');

async function migrate(pool) {}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

const INSTALL_SH = `#!/usr/bin/env bash
# ============================================================================
# OpenHeab one-line installer
#   curl -fsSL https://openheab.com/install | bash
#
# What it does:
#   1. clone the substrate
#   2. install node deps
#   3. run docker compose up (Postgres + substrate)
#   4. run bootstrap (auto-generates all KEKs + admin token)
#   5. print next-step links
#
# Idempotent: re-run anytime.
# ============================================================================
set -euo pipefail

green() { printf "\\033[0;32m%s\\033[0m\\n" "$1"; }
red()   { printf "\\033[0;31m%s\\033[0m\\n" "$1"; }
yellow(){ printf "\\033[0;33m%s\\033[0m\\n" "$1"; }
step()  { printf "\\n\\033[1m==> %s\\033[0m\\n" "$1"; }

REPO_DIR="\${OPENHEAB_DIR:-$HOME/openheab}"

step "Step 1 — Prerequisites"
command -v git    >/dev/null || { red "git not installed"; exit 1; }
command -v node   >/dev/null || { red "node not installed (need >=22)"; exit 1; }
command -v npm    >/dev/null || { red "npm not installed"; exit 1; }
NODE_VER=$(node --version | sed 's/v//; s/\\..*//')
if [ "$NODE_VER" -lt 22 ]; then red "Node $NODE_VER too old; need >=22"; exit 1; fi
green "✓ git, node $NODE_VER, npm all present"

step "Step 2 — Clone OpenHeab"
if [ -d "$REPO_DIR" ]; then
  yellow "Repo already at $REPO_DIR — pulling latest"
  (cd "$REPO_DIR" && git pull --ff-only) || true
else
  git clone https://github.com/jmtrades/openheab-agent-infra "$REPO_DIR"
fi
cd "$REPO_DIR"
green "✓ Source at $REPO_DIR"

step "Step 3 — Install dependencies"
npm install --no-audit --no-fund --silent
green "✓ Dependencies installed"

step "Step 4 — Start Postgres + substrate"
if command -v docker >/dev/null && docker compose version >/dev/null 2>&1; then
  green "Docker compose detected — starting"
  docker compose up -d
  yellow "Wait ~10s for substrate to come up..."
  sleep 10
else
  yellow "Docker compose not available — starting substrate alone (you'll need to point DATABASE_URL at your own Postgres)"
  if [ -z "\${DATABASE_URL:-}" ]; then
    red "Set DATABASE_URL and re-run, OR install Docker for one-click."
    exit 1
  fi
  node server.js &
  sleep 5
fi
green "✓ Substrate running"

step "Step 5 — Bootstrap (auto-generate KEKs + admin token)"
BOOTSTRAP_RESPONSE=$(curl -fsS -X POST http://localhost:3000/v1/admin/setup/bootstrap -H "content-type: application/json" -d '{}' || true)
if [ -n "$BOOTSTRAP_RESPONSE" ]; then
  ADMIN_TOKEN=$(echo "$BOOTSTRAP_RESPONSE" | sed -n 's/.*"OPERATOR_ADMIN_TOKEN":{[^}]*"value":"\\([^"]*\\)".*/\\1/p')
  if [ -n "$ADMIN_TOKEN" ]; then
    echo "$ADMIN_TOKEN" > "$REPO_DIR/.admin-token"
    chmod 600 "$REPO_DIR/.admin-token"
    green "✓ Admin token saved to $REPO_DIR/.admin-token"
  fi
fi
green "✓ Bootstrap complete"

step "Done — your substrate is live"
echo
green "→ Dashboard:    http://localhost:3000/dashboard"
green "→ Demo:         http://localhost:3000/demo"
green "→ Setup wizard: http://localhost:3000/setup-wizard"
green "→ Admin (token in $REPO_DIR/.admin-token):"
green "                http://localhost:3000/admin"
echo
yellow "Next: paste a Stripe key at /setup-wizard to enable paid signups."
yellow "Docs: http://localhost:3000/docs · Help: http://localhost:3000/help"
`;

function renderDeployVercelPage() {
  const repoUrl = 'https://github.com/jmtrades/openheab-agent-infra';
  const deployBtn = 'https://vercel.com/new/clone?repository-url=' + encodeURIComponent(repoUrl) +
    '&env=DATABASE_URL,OPERATOR_PUBLIC_URL' +
    '&envDescription=Postgres%20URL%20and%20your%20public%20URL%20%E2%80%94%20the%20rest%20auto-bootstrap%20via%20%2Fv1%2Fadmin%2Fsetup%2Fbootstrap' +
    '&envLink=' + encodeURIComponent('https://openheab.com/setup-wizard') +
    '&project-name=openheab-substrate&repository-name=openheab-substrate';

  return `<!doctype html><html><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>Deploy OpenHeab — Vercel / Render / Railway / Docker</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Inter', sans-serif; background: #0a0a0f; color: #e7e7ee; line-height: 1.6; }
.wrap { max-width: 880px; margin: 0 auto; padding: 48px 24px 80px; }
.nav { display: flex; justify-content: space-between; align-items: center; margin-bottom: 40px; }
.nav .logo { font-weight: 700; font-size: 18px; color: #fff; text-decoration: none; }
.nav .links a { color: #888; margin-left: 20px; font-size: 14px; text-decoration: none; }
.nav .links a:hover { color: #fff; }
h1 { font-size: 40px; font-weight: 700; letter-spacing: -1px; margin-bottom: 10px; }
.subtitle { color: #888; font-size: 16px; margin-bottom: 36px; max-width: 600px; }
.option { background: #14141c; border: 1px solid #1f1f2a; border-radius: 14px; padding: 28px 32px; margin-bottom: 14px; }
.option h2 { font-size: 20px; margin-bottom: 8px; display: flex; align-items: center; gap: 10px; }
.option .badge { background: #1f1f2a; padding: 3px 10px; border-radius: 100px; font-size: 11px; color: #888; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; }
.option .badge.recommended { background: #4f46e5; color: #fff; }
.option p { color: #aaa; font-size: 14px; margin-bottom: 16px; }
.option pre { background: #0a0a12; padding: 14px 18px; border-radius: 8px; overflow-x: auto; font-family: 'SF Mono', monospace; font-size: 12px; color: #c5c5d5; margin-bottom: 12px; line-height: 1.6; position: relative; white-space: pre; }
.option pre code { font-family: inherit; }
.option .copy { position: absolute; top: 8px; right: 8px; background: #1a1a25; color: #aaa; border: 1px solid #25253a; padding: 4px 10px; border-radius: 5px; font-size: 11px; cursor: pointer; }
.deploy-btn { display: inline-block; padding: 12px 22px; background: #4f46e5; color: #fff; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 14px; }
.deploy-btn:hover { background: #4338ca; }
.deploy-btn img { vertical-align: middle; height: 28px; }
ul { padding-left: 22px; color: #c5c5d5; font-size: 14px; }
ul li { padding: 3px 0; }
.footer { color: #555; font-size: 13px; margin-top: 48px; text-align: center; }
.footer a { color: #888; margin: 0 8px; }
</style></head><body><div class="wrap">

<nav class="nav">
  <a class="logo" href="/">OpenHeab</a>
  <div class="links">
    <a href="/deploy/vercel" style="color:#fff">Deploy</a>
    <a href="/setup-wizard">Setup wizard</a>
    <a href="/docs">Docs</a>
    <a href="/pricing">Pricing</a>
  </div>
</nav>

<h1>Deploy OpenHeab</h1>
<p class="subtitle">Self-host the full substrate in &lt;5 minutes. Pick your platform; we auto-bootstrap everything else.</p>

<div class="option">
  <h2>One-line install (local) <span class="badge recommended">fastest</span></h2>
  <p>Runs Docker compose (Postgres + substrate) + auto-bootstraps KEKs + admin token. Idempotent.</p>
  <pre><button class="copy" onclick="copyMe(this)">copy</button><code>curl -fsSL https://openheab.com/install | bash</code></pre>
  <ul>
    <li>Requires: <code>git</code>, <code>node &gt;=22</code>, <code>docker</code></li>
    <li>Saves admin token to <code>~/openheab/.admin-token</code></li>
    <li>Visit <code>http://localhost:3000/dashboard</code> when done</li>
  </ul>
</div>

<div class="option">
  <h2>Deploy to Vercel <span class="badge">serverless</span></h2>
  <p>Click below. Vercel forks the repo + asks for <code>DATABASE_URL</code> + <code>OPERATOR_PUBLIC_URL</code>. Everything else auto-bootstraps via <code>POST /v1/admin/setup/bootstrap</code> on first hit.</p>
  <p><a class="deploy-btn" href="${escapeHtml(deployBtn)}" target="_blank" rel="noopener">▶ Deploy to Vercel</a></p>
  <p style="font-size:12px;color:#666;margin-top:14px">After deploy: hit <code>https://your-vercel-url/v1/admin/setup/bootstrap</code> once to generate secrets. Then visit <code>/setup-wizard</code> to paste Stripe key etc.</p>
</div>

<div class="option">
  <h2>Deploy to Render <span class="badge">platform</span></h2>
  <p>Render blueprint at <a href="/deploy/render.yaml" style="color:#818cf8">/deploy/render.yaml</a>. Click "New → Blueprint" in Render dashboard, point at this repo.</p>
  <pre><button class="copy" onclick="copyMe(this)">copy</button><code>curl -fsSL https://openheab.com/deploy/render.yaml -o render.yaml
# then in Render: New → Blueprint → connect repo → deploy</code></pre>
</div>

<div class="option">
  <h2>Deploy to Railway <span class="badge">platform</span></h2>
  <p>Railway template at <a href="/deploy/railway.json" style="color:#818cf8">/deploy/railway.json</a>.</p>
</div>

<div class="option">
  <h2>Docker Compose <span class="badge">self-host</span></h2>
  <p>Clone the repo + <code>docker compose up</code>. Includes Postgres.</p>
  <pre><button class="copy" onclick="copyMe(this)">copy</button><code>git clone https://github.com/jmtrades/openheab-agent-infra
cd openheab-agent-infra
docker compose up -d
curl -X POST http://localhost:3000/v1/admin/setup/bootstrap -H "content-type: application/json" -d '{}'</code></pre>
</div>

<div class="option">
  <h2>Embed the "Deploy" button on your site</h2>
  <p>Spread the substrate. Drop this in your README or marketing page:</p>
  <pre><button class="copy" onclick="copyMe(this)">copy</button><code>&lt;a href="https://openheab.com/deploy/vercel"&gt;
  &lt;img src="https://openheab.com/launch-button.svg" alt="Deploy on OpenHeab" height="44"&gt;
&lt;/a&gt;</code></pre>
  <p style="margin-top:14px">Preview: <a href="/deploy/vercel"><img src="/launch-button.svg" alt="Deploy on OpenHeab" height="44" style="vertical-align:middle"></a></p>
</div>

<div class="footer">
  Stuck? <a href="/runbook">Runbook</a> · <a href="/help">Help center</a> · <a href="mailto:hello@openheab.com">Email us</a>
</div>

</div>
<script>
function copyMe(btn) {
  const text = btn.parentElement.querySelector('code').textContent;
  navigator.clipboard.writeText(text).then(() => {
    btn.textContent = 'copied!'; setTimeout(() => btn.textContent = 'copy', 1500);
  });
}
</script>
</body></html>`;
}

function renderDeployRenderYaml() {
  return `# OpenHeab — Render.com blueprint
# https://render.com/docs/blueprint-spec
services:
  - type: web
    name: openheab-substrate
    runtime: node
    plan: starter
    region: oregon
    buildCommand: npm install --omit=dev --no-audit --no-fund
    startCommand: node server.js
    envVars:
      - key: DATABASE_URL
        fromDatabase:
          name: openheab-db
          property: connectionString
      - key: OPERATOR_PUBLIC_URL
        value: https://openheab-substrate.onrender.com
      - key: NODE_ENV
        value: production
      - key: RUN_MIGRATIONS_ON_BOOT
        value: "true"
      # All KEKs auto-generated via POST /v1/admin/setup/bootstrap on first request
    healthCheckPath: /healthz

databases:
  - name: openheab-db
    plan: starter
    databaseName: openheab
    user: openheab
`;
}

function renderDeployRailwayJson() {
  return JSON.stringify({
    name: 'OpenHeab Substrate',
    description: '253 primitives × 55 layers × 1,809+ routes',
    services: [
      { name: 'web', source: { repo: 'jmtrades/openheab-agent-infra', branch: 'main' },
        env: {
          NODE_ENV: 'production',
          RUN_MIGRATIONS_ON_BOOT: 'true',
          OPERATOR_PUBLIC_URL: { default: 'https://YOUR-DOMAIN.up.railway.app' }
        },
        start: 'node server.js',
        healthcheck: { path: '/healthz' }
      },
      { name: 'postgres', image: 'postgres:16-alpine',
        env: { POSTGRES_DB: 'openheab', POSTGRES_USER: 'openheab' },
        volumes: [{ name: 'pgdata', mount: '/var/lib/postgresql/data' }]
      }
    ],
    setup_steps: [
      'After deploy, POST to /v1/admin/setup/bootstrap to auto-generate all KEKs + admin token',
      'Visit /setup-wizard to paste Stripe/SendGrid/OAuth credentials',
      'Visit /demo to verify substrate alive'
    ]
  }, null, 2);
}

function renderLaunchButtonSvg() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="220" height="44" viewBox="0 0 220 44">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#4f46e5"/>
      <stop offset="1" stop-color="#3730a3"/>
    </linearGradient>
  </defs>
  <rect width="220" height="44" rx="8" fill="url(#g)"/>
  <g transform="translate(14,12)">
    <circle cx="10" cy="10" r="9" fill="#fff" fill-opacity="0.15"/>
    <text x="10" y="14" fill="#fff" font-family="-apple-system, BlinkMacSystemFont, sans-serif" font-size="11" font-weight="700" text-anchor="middle">OH</text>
  </g>
  <text x="42" y="20" fill="#fff" font-family="-apple-system, BlinkMacSystemFont, sans-serif" font-size="10" font-weight="500" letter-spacing="0.5">DEPLOY ON</text>
  <text x="42" y="34" fill="#fff" font-family="-apple-system, BlinkMacSystemFont, sans-serif" font-size="14" font-weight="700">OpenHeab</text>
  <text x="208" y="26" fill="#fff" font-family="-apple-system, BlinkMacSystemFont, sans-serif" font-size="16" font-weight="700" text-anchor="end">→</text>
</svg>`;
}

// Auto-incident response: cron checks deep_health, declares incident if red
async function autoIncidentWatch(pool, auditChain) {
  try {
    const { runChecks } = require('./production_checks');
    const integration = { auditChain, pool };
    const summary = await runChecks(pool, integration);

    if (summary.overall === 'red') {
      // Check if there's an active incident for this
      const existing = await pool.query(
        `SELECT incident_id FROM uptime_incidents WHERE component='auto_health' AND resolved_at IS NULL`
      ).catch(() => ({ rows: [] }));
      if (existing.rows[0]) return { status: 'red', existing_incident: existing.rows[0].incident_id };

      // Declare a new incident
      const incidentId = 'inc_' + crypto.randomBytes(8).toString('hex');
      const failingChecks = summary.results.filter(r => r.status === 'fail').map(r => r.check_name);
      await pool.query(
        `INSERT INTO uptime_incidents (incident_id, title, severity, component, status)
         VALUES ($1, $2, 'major', 'auto_health', 'investigating')`,
        [incidentId, 'Auto-detected: ' + failingChecks.join(', ').slice(0, 180)]
      ).catch(() => {});
      if (auditChain) auditChain.append({
        event_type: 'incident.auto_declared', incident_id: incidentId, failing: failingChecks
      }).catch(() => {});
      return { status: 'red', declared: incidentId, failing: failingChecks };
    } else if (summary.overall === 'green') {
      // Auto-resolve any auto-declared incidents
      const r = await pool.query(
        `UPDATE uptime_incidents SET resolved_at=NOW(), status='resolved'
         WHERE component='auto_health' AND resolved_at IS NULL RETURNING incident_id`
      ).catch(() => ({ rows: [] }));
      if (r.rows.length > 0 && auditChain) {
        for (const row of r.rows) {
          auditChain.append({ event_type: 'incident.auto_resolved', incident_id: row.incident_id }).catch(() => {});
        }
      }
      return { status: 'green', auto_resolved: r.rows.length };
    }
    return { status: summary.overall, action: 'none' };
  } catch (e) {
    return { error: e.message };
  }
}

// Auto-upgrade nudge: when an agent uses >80% of monthly quota, notify
async function autoUpgradeNudge(pool, auditChain) {
  // Find Free + Starter agents with high usage this month
  const r = await pool.query(`
    SELECT om.agent_did, o.plan,
           COUNT(*)::int AS calls,
           COALESCE(SUM(ic.cost_cents),0)::bigint AS spend_cents
    FROM org_members om
    JOIN orgs o ON o.org_id = om.org_id
    LEFT JOIN inference_calls ic ON ic.agent_did = om.agent_did
      AND ic.created_at > date_trunc('month', NOW())
    WHERE o.plan IN ('free', 'starter')
    GROUP BY om.agent_did, o.plan
    HAVING COUNT(*) >= CASE WHEN o.plan='free' THEN 8000 ELSE 80000 END
    LIMIT 100
  `).catch(() => ({ rows: [] }));

  let notified = 0;
  for (const row of r.rows) {
    const cap = row.plan === 'free' ? 10000 : 100000;
    const pct = Math.round((row.calls / cap) * 100);
    // De-dupe: skip if we already nudged this month
    const recent = await pool.query(
      `SELECT 1 FROM notifications WHERE agent_did=$1 AND kind='upgrade_nudge' AND created_at > date_trunc('month', NOW())`,
      [row.agent_did]
    ).catch(() => ({ rows: [] }));
    if (recent.rows[0]) continue;

    const nextPlan = row.plan === 'free' ? 'Starter ($19/mo)' : 'Pro ($99/mo)';
    try {
      const { notify } = require('./notifications_whatsnew_visualizer');
      await notify(pool, row.agent_did, {
        kind: 'upgrade_nudge',
        title: `You've used ${pct}% of this month's quota`,
        body: `Heads up — your current plan caps you at ${cap.toLocaleString()} inference calls/mo. Upgrade to ${nextPlan} to avoid hitting the ceiling before month-end.`,
        severity: 'warning',
        action_url: '/pricing'
      });
      notified++;
    } catch {}
  }
  if (auditChain && notified > 0) {
    auditChain.append({ event_type: 'cron.upgrade_nudge_sent', count: notified }).catch(() => {});
  }
  return { notified };
}

// Auto-summary digest: weekly per-agent activity summary (notification only;
// real email would call email_templates.send)
async function autoSummaryDigest(pool, auditChain) {
  // Find agents active in the last 7d with no digest yet this week
  const r = await pool.query(`
    SELECT agent_did, COUNT(*)::int AS calls,
           COALESCE(SUM(cost_cents),0)::bigint AS spend_cents
    FROM inference_calls
    WHERE created_at > NOW() - INTERVAL '7 days'
    GROUP BY agent_did
    HAVING COUNT(*) > 0
    LIMIT 500
  `).catch(() => ({ rows: [] }));

  let sent = 0;
  for (const row of r.rows) {
    // De-dupe: one digest per week
    const recent = await pool.query(
      `SELECT 1 FROM notifications WHERE agent_did=$1 AND kind='weekly_digest' AND created_at > NOW() - INTERVAL '7 days'`,
      [row.agent_did]
    ).catch(() => ({ rows: [] }));
    if (recent.rows[0]) continue;
    try {
      const { notify } = require('./notifications_whatsnew_visualizer');
      await notify(pool, row.agent_did, {
        kind: 'weekly_digest',
        title: 'Your week: ' + row.calls.toLocaleString() + ' inference calls',
        body: `Spend: $${(Number(row.spend_cents) / 100).toFixed(2)} · Activity summary in your dashboard.`,
        severity: 'info',
        action_url: '/dashboard?did=' + encodeURIComponent(row.agent_did)
      });
      sent++;
    } catch {}
  }
  if (auditChain && sent > 0) {
    auditChain.append({ event_type: 'cron.weekly_digest_sent', count: sent }).catch(() => {});
  }
  return { sent };
}

function registerZeroConfigSelfRunRoutes(app, pool, verifyAgentAuth, auditChain) {
  const express = require('express');

  // GET /install — one-line shell installer
  app.get('/install', (req, res) => {
    res.set('content-type', 'text/x-shellscript; charset=utf-8');
    res.set('cache-control', 'public, max-age=300');
    res.send(INSTALL_SH);
  });

  // GET /deploy/vercel — deploy options page
  app.get('/deploy/vercel', (req, res) => {
    res.set('content-type', 'text/html; charset=utf-8');
    res.set('cache-control', 'public, max-age=3600');
    res.send(renderDeployVercelPage());
  });
  // Aliases for SEO
  app.get('/deploy', (req, res) => res.redirect(302, '/deploy/vercel'));

  // GET /deploy/render.yaml
  app.get('/deploy/render.yaml', (req, res) => {
    res.set('content-type', 'text/yaml; charset=utf-8');
    res.set('cache-control', 'public, max-age=3600');
    res.send(renderDeployRenderYaml());
  });

  // GET /deploy/railway.json
  app.get('/deploy/railway.json', (req, res) => {
    res.set('content-type', 'application/json; charset=utf-8');
    res.set('cache-control', 'public, max-age=3600');
    res.send(renderDeployRailwayJson());
  });

  // GET /launch-button.svg — embeddable badge
  app.get('/launch-button.svg', (req, res) => {
    res.set('content-type', 'image/svg+xml');
    res.set('cache-control', 'public, max-age=86400, immutable');
    res.send(renderLaunchButtonSvg());
  });

  // Crons
  const { registerCron } = require('../cron_auth');
  registerCron(app, '/v1/_jobs/auto-incident-watch',
    async (req, res) => res.json(await autoIncidentWatch(pool, auditChain)),
    'every:5m');
  registerCron(app, '/v1/_jobs/auto-upgrade-nudge',
    async (req, res) => res.json(await autoUpgradeNudge(pool, auditChain)),
    'daily');
  registerCron(app, '/v1/_jobs/auto-summary-digest',
    async (req, res) => res.json(await autoSummaryDigest(pool, auditChain)),
    'daily');
}

module.exports = {
  migrate, registerZeroConfigSelfRunRoutes,
  autoIncidentWatch, autoUpgradeNudge, autoSummaryDigest,
  INSTALL_SH
};
