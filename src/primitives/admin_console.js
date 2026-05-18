// ============================================================================
// admin_console.js — operator console for cross-cutting administration.
//
//   GET /admin                       index — primitives inventory + KPIs
//   GET /admin/primitives            full list with route counts
//   GET /admin/primitive/:name       per-primitive view (routes + tables)
//   GET /admin/registry              substrate self-description
//   GET /admin/secrets-status        which env vars are set (not values)
//
// All pages require x-admin-token header (or admin_token query param for
// browser convenience — only sent over HTTPS, only by operator, only for
// these read-only views).
// ============================================================================
const ds = require('../design_system');
const { safeTokenCompare } = require('../safe_compare');

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
}

function shell(title, description, content) {
  return `${ds.head(`${title} — OpenHeab Admin`, description)}${ds.NAV_HTML('')}<main>${content}</main>${ds.FOOTER_HTML()}`;
}

function isAdmin(req) {
  const tok = req.headers['x-admin-token'] || req.query.admin_token;
  return safeTokenCompare(tok, process.env.OPERATOR_ADMIN_TOKEN);
}

function unauthorized(req, res) {
  res.status(401);
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.send(shell('Admin — Unauthorized', 'Admin token required.', `
<section style="max-width:520px;margin:0 auto;padding:80px 16px;text-align:center">
  <span class="badge b-bad">401 unauthorized</span>
  <h1 style="font:600 32px var(--display);margin:14px 0">Admin token required.</h1>
  <p style="color:var(--dim2);font-size:14px;line-height:1.7;margin-bottom:24px">Set the <code>x-admin-token</code> header to <code>OPERATOR_ADMIN_TOKEN</code>, or open this page with <code>?admin_token=…</code> in the URL.</p>
  <form method="GET">
    <input type="password" name="admin_token" placeholder="OPERATOR_ADMIN_TOKEN" style="width:340px">
    <button class="btn primary" style="margin-left:6px">Enter</button>
  </form>
</section>`));
}

async function safe(pool, sql, params = []) {
  try { return (await pool.query(sql, params)).rows; }
  catch { return []; }
}

function listPrimitives() {
  let primitives = [];
  try {
    const int = require('../integration');
    primitives = int.PRIMITIVE_NAMES || Object.keys(int.primitives || {});
  } catch {}
  return primitives.sort();
}

function listRegisteredRoutes(app) {
  // Walk Express router stack
  const out = [];
  const walk = (stack, prefix = '') => {
    for (const layer of stack) {
      if (layer.route) {
        const path = prefix + layer.route.path;
        for (const m of Object.keys(layer.route.methods || {})) {
          out.push({ method: m.toUpperCase(), path });
        }
      } else if (layer.name === 'router' && layer.handle?.stack) {
        walk(layer.handle.stack, prefix);
      }
    }
  };
  if (app?._router?.stack) walk(app._router.stack);
  return out;
}

// ----------------------------------------------------------------------------
// /admin (dashboard)
// ----------------------------------------------------------------------------
async function adminIndexPage(app, pool) {
  const primitives = listPrimitives();
  const routes = listRegisteredRoutes(app);
  const agentsTotal = (await safe(pool, `SELECT COUNT(*)::int AS n FROM agent_identities`))[0]?.n || 0;
  const orgsTotal = (await safe(pool, `SELECT COUNT(*)::int AS n FROM orgs`))[0]?.n || 0;
  const chainLen = (await safe(pool, `SELECT COALESCE(MAX(seq),0)::bigint AS n FROM audit_chain_events`))[0]?.n || 0;
  const tables = (await safe(pool, `SELECT COUNT(*)::int AS n FROM information_schema.tables WHERE table_schema='public'`))[0]?.n || 0;
  return shell('Admin', 'Operator console.',
`<section style="max-width:1100px;margin:0 auto;padding:60px 16px">
  <span class="badge b-bad">Admin</span>
  <h1 style="font:600 40px/1.1 var(--display);letter-spacing:-1px;margin:18px 0">Operator console.</h1>
  <p style="color:var(--dim2);font-size:15px;line-height:1.6;max-width:680px">Cross-cutting view of substrate state. Read-only here — for mutations use the per-primitive admin APIs.</p>
</section>
<section style="max-width:1100px;margin:0 auto;padding:24px 16px 24px">
  <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px">
    <div class="kpi"><div class="label">Primitives</div><div class="value">${primitives.length}</div></div>
    <div class="kpi"><div class="label">Routes</div><div class="value">${routes.length}</div></div>
    <div class="kpi"><div class="label">DB tables</div><div class="value">${tables}</div></div>
    <div class="kpi"><div class="label">Audit chain</div><div class="value">${Number(chainLen).toLocaleString()}</div></div>
    <div class="kpi"><div class="label">Agents</div><div class="value">${agentsTotal.toLocaleString()}</div></div>
    <div class="kpi"><div class="label">Orgs</div><div class="value">${orgsTotal.toLocaleString()}</div></div>
  </div>
</section>
<section style="max-width:1100px;margin:0 auto;padding:24px 16px 60px;display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:14px">
  <a href="/admin/console/primitives" class="card" style="color:var(--fg);text-decoration:none"><strong>Primitives inventory →</strong><div style="color:var(--dim2);font-size:13px;margin-top:4px">All ${primitives.length} primitives, route counts, registrar status.</div></a>
  <a href="/admin/console/registry" class="card" style="color:var(--fg);text-decoration:none"><strong>Substrate registry →</strong><div style="color:var(--dim2);font-size:13px;margin-top:4px">Self-description, capability list.</div></a>
  <a href="/admin/console/secrets-status" class="card" style="color:var(--fg);text-decoration:none"><strong>Secrets status →</strong><div style="color:var(--dim2);font-size:13px;margin-top:4px">Which env vars are set (values redacted).</div></a>
  <a href="/launch" class="card" style="color:var(--fg);text-decoration:none"><strong>Launch dashboard →</strong><div style="color:var(--dim2);font-size:13px;margin-top:4px">TV-on-the-wall ops view.</div></a>
  <a href="/health-dashboard" class="card" style="color:var(--fg);text-decoration:none"><strong>Health dashboard →</strong><div style="color:var(--dim2);font-size:13px;margin-top:4px">Deep readiness check, 30s refresh.</div></a>
  <a href="/cron-status" class="card" style="color:var(--fg);text-decoration:none"><strong>Cron status →</strong><div style="color:var(--dim2);font-size:13px;margin-top:4px">Per-job last fired, OK/error counts.</div></a>
</section>`);
}

// ----------------------------------------------------------------------------
// /admin/primitives
// ----------------------------------------------------------------------------
function adminPrimitivesPage(app) {
  const primitives = listPrimitives();
  const routes = listRegisteredRoutes(app);
  return shell('Primitives inventory', 'All primitives, route counts.',
`<section style="max-width:1100px;margin:0 auto;padding:60px 16px">
  <a href="/admin/console" style="font:500 12px var(--mono);color:var(--dim);text-decoration:none">← Admin</a>
  <h1 style="font:600 32px var(--display);margin:14px 0">${primitives.length} primitives.</h1>
  <p style="color:var(--dim2);font-size:14px">Click any to see registered routes + state.</p>
</section>
<section style="max-width:1100px;margin:0 auto;padding:24px 16px 60px">
  <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:8px">
    ${primitives.map(p => `<a href="/admin/console/primitive/${encodeURIComponent(p)}?admin_token=${encodeURIComponent('REDACTED')}" class="card" style="padding:10px 14px;font:500 12px var(--mono);color:var(--acc-dim);text-decoration:none">${escapeHtml(p)}</a>`).join('')}
  </div>
  <p style="color:var(--dim);font-size:11px;margin-top:24px"><strong>Note:</strong> token redacted in links above — click and re-paste your token in the URL bar, or use the header instead.</p>
</section>`);
}

// ----------------------------------------------------------------------------
// /admin/primitive/:name
// ----------------------------------------------------------------------------
function adminPrimitivePage(app, name) {
  const primitives = listPrimitives();
  if (!primitives.includes(name)) {
    return shell(`Unknown primitive: ${name}`, '404',
`<section style="padding:120px 0;text-align:center"><h1>Not found</h1><p style="color:var(--dim2)"><a href="/admin/console/primitives">All primitives →</a></p></section>`);
  }
  // Find routes whose path starts with a primitive-name-like prefix. Heuristic.
  const routes = listRegisteredRoutes(app);
  const prefix = name.replace(/_/g, '-');
  const matching = routes.filter(r => r.path.includes(name) || r.path.includes(prefix));
  return shell(`Primitive — ${name}`, `Routes + state for ${name}.`,
`<section style="max-width:980px;margin:0 auto;padding:60px 16px">
  <a href="/admin/console/primitives" style="font:500 12px var(--mono);color:var(--dim);text-decoration:none">← All primitives</a>
  <h1 style="font:600 32px var(--mono);color:var(--acc-dim);margin:14px 0">${escapeHtml(name)}</h1>
  <p style="color:var(--dim2);font-size:13px">${matching.length} routes match path-prefix heuristic. Real source lives in <code>src/primitives/${escapeHtml(name)}.js</code>.</p>
</section>
<section style="max-width:980px;margin:0 auto;padding:24px 16px 60px">
  ${matching.length === 0
    ? `<div class="card" style="text-align:center;padding:32px;color:var(--dim)">No matching routes — this primitive may register pages or cron jobs not named after its module.</div>`
    : `<table>
        <thead><tr><th>Method</th><th>Path</th></tr></thead>
        <tbody>${matching.map(r => `<tr>
          <td><span class="badge b-${r.method === 'GET' ? 'acc' : r.method === 'POST' ? 'good' : r.method === 'DELETE' ? 'bad' : 'warn'}" style="font-size:10px">${r.method}</span></td>
          <td style="font:500 12px var(--mono);color:var(--acc-dim)">${escapeHtml(r.path)}</td>
        </tr>`).join('')}</tbody>
      </table>`}
</section>`);
}

// ----------------------------------------------------------------------------
// /admin/registry
// ----------------------------------------------------------------------------
function adminRegistryPage(app) {
  const primitives = listPrimitives();
  const routes = listRegisteredRoutes(app);
  const methods = routes.reduce((acc, r) => { acc[r.method] = (acc[r.method] || 0) + 1; return acc; }, {});
  return shell('Substrate registry', 'Self-description.',
`<section style="max-width:980px;margin:0 auto;padding:60px 16px">
  <a href="/admin/console" style="font:500 12px var(--mono);color:var(--dim);text-decoration:none">← Admin</a>
  <h1 style="font:600 32px var(--display);margin:14px 0">Substrate registry.</h1>
</section>
<section style="max-width:980px;margin:0 auto;padding:24px 16px 60px">
  <h2 style="font:600 14px var(--mono);color:var(--dim);text-transform:uppercase;letter-spacing:1.5px;margin-bottom:12px">By HTTP method</h2>
  <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin-bottom:32px">
    ${Object.entries(methods).map(([m, n]) => `<div class="kpi"><div class="label">${m}</div><div class="value">${n}</div></div>`).join('')}
  </div>
  <h2 style="font:600 14px var(--mono);color:var(--dim);text-transform:uppercase;letter-spacing:1.5px;margin-bottom:12px">Public discovery</h2>
  <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:8px">
    ${[
      ['/openapi.json', 'OpenAPI spec'],
      ['/.well-known/mcp.json', 'MCP discovery'],
      ['/.well-known/agent.json', 'Agent discovery'],
      ['/.well-known/openheab.json', 'Substrate self-description'],
      ['/.well-known/agents.json', 'Agents directory discovery'],
      ['/.well-known/security.txt', 'Security contact (RFC 9116)'],
      ['/sitemap.xml', 'Sitemap'],
      ['/sitemap-news.xml', 'News sitemap'],
      ['/sitemap-products.xml', 'Products sitemap'],
      ['/llms.txt', 'LLM crawler manifest'],
      ['/llms-full.txt', 'Full LLM crawler manifest'],
      ['/ai.txt', 'AI training opt-out'],
      ['/robots.txt', 'Robots'],
      ['/humans.txt', 'Credits'],
      ['/opensearch.xml', 'Browser search integration'],
    ].map(([p, t]) => `<a href="${p}" class="card" style="padding:10px 14px;color:var(--fg);text-decoration:none"><strong style="font-size:13px">${t}</strong><br><span style="font:500 11px var(--mono);color:var(--dim)">${p}</span></a>`).join('')}
  </div>
</section>`);
}

// ----------------------------------------------------------------------------
// /admin/secrets-status
// ----------------------------------------------------------------------------
function secretsStatusPage() {
  const SECRETS = [
    'DATABASE_URL', 'OPERATOR_PUBLIC_URL',
    'IDENTITY_MASTER_KEK', 'CRYPTO_MASTER_KEK', 'BANK_MASTER_KEK',
    'CARD_CORE_MASTER_KEK', 'ACH_MASTER_KEK', 'INTEGRATIONS_MASTER_KEK',
    'OPERATOR_ADMIN_TOKEN', 'CRON_SECRET', 'INTERNAL_API_KEY',
    'CARD_CORE_NETWORK_SECRET', 'EMAIL_CORE_MTA_SECRET', 'OPERATOR_ROOT_PRIVATE_KEY_PEM',
    'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'STRIPE_ISSUING_WEBHOOK_SECRET',
    'GITHUB_WEBHOOK_SECRET', 'PAYOUT_WEBHOOK_SECRET',
    'SLACK_SIGNING_SECRET', 'TWILIO_AUTH_TOKEN', 'ALCHEMY_WEBHOOK_SIGNING_KEY',
    'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GOOGLE_API_KEY',
    'TWILIO_ACCOUNT_SID', 'E2B_API_KEY', 'BROWSERBASE_API_KEY', 'BROWSERBASE_PROJECT_ID',
    'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_REGION',
    'CLOUDFLARE_API_TOKEN', 'NODE_ENV', 'DEMO_MODE', 'PG_INSECURE_TLS',
  ];
  return shell('Secrets status', 'Which env vars are set (values redacted).',
`<section style="max-width:780px;margin:0 auto;padding:60px 16px">
  <a href="/admin/console" style="font:500 12px var(--mono);color:var(--dim);text-decoration:none">← Admin</a>
  <h1 style="font:600 32px var(--display);margin:14px 0">Secrets status.</h1>
  <p style="color:var(--dim2);font-size:13px">Values redacted. Tells you what's configured, not what they are.</p>
</section>
<section style="max-width:780px;margin:0 auto;padding:24px 16px 60px">
  <table>
    <thead><tr><th>Env var</th><th>Set?</th><th>Length</th></tr></thead>
    <tbody>
      ${SECRETS.map(k => {
        const v = process.env[k];
        const set = !!v;
        return `<tr>
          <td><strong style="font:500 12px var(--mono)">${escapeHtml(k)}</strong></td>
          <td><span class="badge b-${set ? 'good' : 'dim'}">${set ? 'set' : 'unset'}</span></td>
          <td style="font:500 11px var(--mono);color:var(--dim)">${set ? v.length + ' chars' : '—'}</td>
        </tr>`;
      }).join('')}
    </tbody>
  </table>
</section>`);
}

// ----------------------------------------------------------------------------
// Register
// ----------------------------------------------------------------------------
function registerAdminConsoleRoutes(app, pool) {
  const sendHtml = (res, html) => { res.setHeader('content-type', 'text/html; charset=utf-8'); res.send(html); };
  const guard = (handler) => async (req, res) => {
    if (!isAdmin(req)) return unauthorized(req, res);
    try { await handler(req, res); } catch (e) { res.status(500).type('text/html').send(shell('Error', e.message, `<section style="padding:80px 0;text-align:center"><h1>Error</h1><p style="color:var(--bad)">${escapeHtml(e.message)}</p></section>`)); }
  };
  // Namespaced under /admin/console (the older /admin lives in admin_ui.js for
  // cross-tenant operator overview).
  app.get('/admin/console', guard(async (req, res) => sendHtml(res, await adminIndexPage(app, pool))));
  app.get('/admin/console/primitives', guard(async (req, res) => sendHtml(res, adminPrimitivesPage(app))));
  app.get('/admin/console/primitive/:name', guard(async (req, res) => sendHtml(res, adminPrimitivePage(app, req.params.name))));
  app.get('/admin/console/registry', guard(async (req, res) => sendHtml(res, adminRegistryPage(app))));
  app.get('/admin/console/secrets-status', guard(async (req, res) => sendHtml(res, secretsStatusPage())));
}

async function migrate(_pool) {}
module.exports = { migrate, registerAdminConsoleRoutes };
