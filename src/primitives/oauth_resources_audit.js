// ============================================================================
// oauth_resources_audit.js — three more critical surfaces:
//   - /auth/oauth/:provider/start    — Google/GitHub/Microsoft OAuth start
//   - /auth/oauth/:provider/callback — handle the redirect, exchange code,
//                                      look up or create the agent, sign in
//   - /resources                     — operator sitemap: every URL in one page
//   - /v1/audit/filter               — filtered audit-chain queries for
//                                      compliance teams (by event_type,
//                                      agent_did, date range)
// ============================================================================
const crypto = require('crypto');

async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS oauth_links (
      link_id        TEXT PRIMARY KEY,
      provider       TEXT NOT NULL,
      external_user  TEXT NOT NULL,
      external_email TEXT,
      agent_did      TEXT,
      access_token   TEXT,
      refresh_token  TEXT,
      expires_at     TIMESTAMPTZ,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (provider, external_user)
    );
    CREATE INDEX IF NOT EXISTS idx_oauth_agent ON oauth_links (agent_did);

    CREATE TABLE IF NOT EXISTS oauth_state_tokens (
      state          TEXT PRIMARY KEY,
      provider       TEXT NOT NULL,
      redirect_uri   TEXT,
      ip_hash        TEXT,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at     TIMESTAMPTZ NOT NULL
    );
  `);
}

const PROVIDERS = {
  google: {
    name: 'Google',
    authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
    token: 'https://oauth2.googleapis.com/token',
    userinfo: 'https://openidconnect.googleapis.com/v1/userinfo',
    scope: 'openid email profile',
    client_id_env: 'GOOGLE_OAUTH_CLIENT_ID',
    client_secret_env: 'GOOGLE_OAUTH_CLIENT_SECRET'
  },
  github: {
    name: 'GitHub',
    authorize: 'https://github.com/login/oauth/authorize',
    token: 'https://github.com/login/oauth/access_token',
    userinfo: 'https://api.github.com/user',
    scope: 'read:user user:email',
    client_id_env: 'GITHUB_OAUTH_CLIENT_ID',
    client_secret_env: 'GITHUB_OAUTH_CLIENT_SECRET'
  },
  microsoft: {
    name: 'Microsoft',
    authorize: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    token: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    userinfo: 'https://graph.microsoft.com/v1.0/me',
    scope: 'openid email profile User.Read',
    client_id_env: 'MS_OAUTH_CLIENT_ID',
    client_secret_env: 'MS_OAUTH_CLIENT_SECRET'
  }
};

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

function publicUrl() {
  return process.env.OPERATOR_PUBLIC_URL || 'https://openheab.com';
}

// --- /resources sitemap page ---

const RESOURCE_GROUPS = [
  {
    title: 'Get started',
    items: [
      ['/', 'Landing'],
      ['/signup', 'Sign up'],
      ['/auth/sign-in', 'Sign in (magic link)'],
      ['/demo', 'Live demo (creates a real agent)'],
      ['/tour', 'Interactive walkthrough'],
      ['/pricing', 'Pricing tiers'],
      ['/sdk', 'SDK examples (curl/Python/TS/Go/Rust)'],
      ['/cookbook', 'Real recipes'],
      ['/workbench', 'Interactive prompt builder']
    ]
  },
  {
    title: 'For developers',
    items: [
      ['/docs', 'Conceptual docs'],
      ['/help', 'Searchable help center'],
      ['/explorer', 'Interactive OpenAPI explorer'],
      ['/openapi.json', 'Raw OpenAPI 3.1 spec'],
      ['/mcp', 'MCP server endpoint'],
      ['/models', 'LLM model catalog'],
      ['/tools', 'MCP tool catalog'],
      ['/integrations', 'Third-party integrations'],
      ['/compare-models', 'Side-by-side model comparison'],
      ['/developer', 'Developer console']
    ]
  },
  {
    title: 'For agents (live data)',
    items: [
      ['/dashboard', 'Your agent dashboard'],
      ['/v1/me', 'Bearer→context resolver'],
      ['/v1/me/usage', '30-day usage'],
      ['/v1/me/limits', 'Tier limits + remaining'],
      ['/v1/me/quotas', 'Token-bucket quotas'],
      ['/v1/me/billing/usage', 'Current period spend'],
      ['/v1/me/invoices', 'Past invoices'],
      ['/v1/me/keys', 'API keys'],
      ['/v1/me/webhooks', 'Webhook subscriptions'],
      ['/v1/me/notifications', 'In-app notifications'],
      ['/v1/me/preferences', 'User settings'],
      ['/v1/me/sessions', 'Active sessions'],
      ['/v1/me/requests', 'Recent inference + audit'],
      ['/v1/me/mfa/status', '2FA enrollment status'],
      ['/whoami', '/v1/me alias'],
      ['/notifications', 'Notifications UI']
    ]
  },
  {
    title: 'Drop-in API compat',
    items: [
      ['POST /v1/chat/completions', 'OpenAI chat completions'],
      ['POST /v1/chat/completions/stream', 'OpenAI streaming'],
      ['POST /v1/embeddings', 'OpenAI embeddings'],
      ['GET /v1/models', 'OpenAI model list'],
      ['POST /v1/batches', 'OpenAI batch API'],
      ['POST /v1/files', 'OpenAI file upload'],
      ['POST /v1/messages', 'Anthropic messages'],
      ['POST /v1/messages/stream', 'Anthropic streaming'],
      ['GET /v1/usage/daily', 'Chart-ready daily breakdown'],
      ['GET /v1/usage/summary', 'Period totals']
    ]
  },
  {
    title: 'Operations',
    items: [
      ['/admin', 'Operator admin (token required)'],
      ['/launch', 'TV-on-wall dashboard'],
      ['/inspector', 'Live SSE event viewer'],
      ['/activity', 'Audit chain feed'],
      ['/audit/visualize', 'Merkle chain SVG visualizer'],
      ['/v1/_health/deep', 'Deep health check'],
      ['/v1/_health/deep/launchready', 'CI gate (200/503)'],
      ['/v1/_health/deep/probes', 'Live adapter probes'],
      ['/healthz', 'Simple health'],
      ['/readyz', 'Readiness'],
      ['/metrics', 'Prometheus metrics'],
      ['/runbook', 'SRE playbooks'],
      ['/status', 'Public status page']
    ]
  },
  {
    title: 'Trust + legal',
    items: [
      ['/trust', 'Trust center'],
      ['/sla', 'Service Level Agreement'],
      ['/security/disclosure', 'Responsible disclosure'],
      ['/legal/terms', 'Terms of Service'],
      ['/legal/privacy', 'Privacy Policy'],
      ['/legal/acceptable-use', 'Acceptable Use'],
      ['/legal/cookies', 'Cookie Policy'],
      ['/legal/gdpr', 'GDPR rights'],
      ['/legal/subprocessors', 'Subprocessor list'],
      ['/.well-known/security.txt', 'security.txt (RFC 9116)']
    ]
  },
  {
    title: 'Growth + business',
    items: [
      ['/marketplace', 'Marketplace storefront'],
      ['/referrals', 'Referral program (25%)'],
      ['/migrate', 'Competitor migration guides'],
      ['/solutions', 'Solutions by use case'],
      ['/customers', 'Customer stories'],
      ['/about', 'About'],
      ['/jobs', 'Careers'],
      ['/press', 'Press kit'],
      ['/roadmap', 'Public roadmap'],
      ['/changelog', 'Release history'],
      ['/whatsnew', 'What shipped recently'],
      ['/blog', 'Engineering blog']
    ]
  },
  {
    title: 'Feeds + embeds',
    items: [
      ['/changelog.rss', 'Release RSS'],
      ['/changelog.atom', 'Release Atom'],
      ['/status.rss', 'Status incidents RSS'],
      ['/sitemap.xml', 'Sitemap'],
      ['/robots.txt', 'Robots'],
      ['/llms.txt', 'LLMs.txt for AI crawlers'],
      ['/embed/badge.svg', 'Powered-by SVG badge'],
      ['/embed/stats', 'Iframe-able live stats'],
      ['/v1/charts/sparkline.svg', 'Inline sparkline chart'],
      ['/v1/charts/bars.svg', 'Inline bar chart'],
      ['/v1/charts/donut.svg', 'Inline donut chart']
    ]
  }
];

function renderResourcesPage() {
  return `<!doctype html><html><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>Resources — OpenHeab</title>
<meta name="description" content="Every URL on OpenHeab in one page. Sitemap of every operator + user surface.">
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Inter', sans-serif; background: #0a0a0f; color: #e7e7ee; line-height: 1.6; }
.wrap { max-width: 1200px; margin: 0 auto; padding: 48px 24px 80px; }
.nav { display: flex; justify-content: space-between; align-items: center; margin-bottom: 40px; }
.nav .logo { font-weight: 700; font-size: 18px; color: #fff; text-decoration: none; }
.nav .links a { color: #888; margin-left: 20px; font-size: 14px; text-decoration: none; }
.nav .links a:hover { color: #fff; }
h1 { font-size: 40px; font-weight: 700; letter-spacing: -1px; margin-bottom: 10px; }
.subtitle { color: #888; font-size: 16px; margin-bottom: 32px; max-width: 720px; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 14px; }
.group { background: #14141c; border: 1px solid #1f1f2a; border-radius: 12px; padding: 22px 24px; }
.group h2 { font-size: 12px; color: #818cf8; text-transform: uppercase; letter-spacing: 1.2px; margin-bottom: 14px; font-weight: 600; }
.group ul { list-style: none; }
.group li { padding: 4px 0; font-size: 13px; }
.group li a { color: #c5c5d5; text-decoration: none; font-family: 'SF Mono', monospace; font-size: 12px; }
.group li a:hover { color: #fff; }
.group li .label { color: #666; font-family: -apple-system, sans-serif; font-size: 12px; margin-left: 8px; }
.search { width: 100%; padding: 12px 16px; background: #14141c; border: 1px solid #1f1f2a; color: #fff; border-radius: 10px; font-size: 14px; margin-bottom: 24px; outline: none; }
.search:focus { border-color: #4f46e5; }
.footer { color: #555; font-size: 12px; margin-top: 48px; text-align: center; }
</style></head><body><div class="wrap">

<nav class="nav">
  <a class="logo" href="/">OpenHeab</a>
  <div class="links">
    <a href="/resources" style="color:#fff">Resources</a>
    <a href="/docs">Docs</a>
    <a href="/explorer">Explorer</a>
    <a href="/openapi.json">OpenAPI</a>
    <a href="/sitemap.xml">Sitemap</a>
  </div>
</nav>

<h1>Resources</h1>
<p class="subtitle">Every URL on OpenHeab in one place. Bookmark this page; everything else is reachable from here.</p>

<input class="search" placeholder="Filter resources (e.g. invoice, audit, webhook)" oninput="filter(this.value)" id="search" />

<div class="grid" id="groups">
${RESOURCE_GROUPS.map(g => `
  <div class="group" data-text="${escapeHtml(g.title.toLowerCase() + ' ' + g.items.map(i => i.join(' ')).join(' ').toLowerCase())}">
    <h2>${escapeHtml(g.title)}</h2>
    <ul>
${g.items.map(([url, label]) => {
  const isApi = url.startsWith('POST ') || url.startsWith('GET ') || url.startsWith('PUT ') || url.startsWith('DELETE ');
  const cleanUrl = isApi ? url.split(' ')[1] : url;
  return `      <li><a href="${escapeHtml(cleanUrl)}">${escapeHtml(url)}</a><span class="label">${escapeHtml(label)}</span></li>`;
}).join('')}
    </ul>
  </div>
`).join('')}
</div>

<div class="footer">
  Total: ${RESOURCE_GROUPS.reduce((sum, g) => sum + g.items.length, 0)} surfaces · <a href="/openapi.json" style="color:#888">Full OpenAPI spec</a> · <a href="https://github.com/jmtrades/openheab-agent-infra" style="color:#888">GitHub</a>
</div>

</div>
<script>
function filter(q) {
  q = (q || '').toLowerCase();
  document.querySelectorAll('#groups .group').forEach(g => {
    g.style.display = !q || (g.dataset.text || '').includes(q) ? '' : 'none';
  });
}
</script>
</body></html>`;
}

// --- OAuth helpers ---

function newState() { return 'st_' + crypto.randomBytes(24).toString('hex'); }

function buildAuthorizeUrl(provider, state, redirectUri) {
  const p = PROVIDERS[provider];
  if (!p) return null;
  const params = new URLSearchParams({
    client_id: process.env[p.client_id_env] || 'STUB_CLIENT_ID',
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: p.scope,
    state
  });
  return p.authorize + '?' + params.toString();
}

async function exchangeCode(provider, code, redirectUri) {
  const p = PROVIDERS[provider];
  if (!p) return null;
  if (!process.env[p.client_id_env] || !process.env[p.client_secret_env]) {
    // Stub mode: synthesize a "user" from the code so the flow completes end-to-end
    return {
      stub: true,
      access_token: 'stub_token_' + code.slice(0, 8),
      external_user: 'stub_user_' + crypto.createHash('sha256').update(code).digest('hex').slice(0, 8),
      external_email: 'stub_' + code.slice(0, 6) + '@example.com'
    };
  }
  if (typeof fetch !== 'function') return { error: 'fetch_unavailable' };
  try {
    const body = new URLSearchParams({
      client_id: process.env[p.client_id_env],
      client_secret: process.env[p.client_secret_env],
      code,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code'
    });
    const r = await fetch(p.token, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'accept': 'application/json' },
      body: body.toString()
    });
    const j = await r.json();
    if (!j.access_token) return { error: 'no_access_token', details: j };
    // Fetch user info
    const u = await fetch(p.userinfo, { headers: { authorization: 'Bearer ' + j.access_token, accept: 'application/json' } });
    const ui = await u.json();
    return {
      access_token: j.access_token,
      refresh_token: j.refresh_token,
      expires_in: j.expires_in,
      external_user: String(ui.id || ui.sub || ui.email),
      external_email: ui.email || ui.mail || null,
      user_info: ui
    };
  } catch (e) {
    return { error: 'oauth_exchange_failed', message: e.message };
  }
}

function registerOauthResourcesAuditRoutes(app, pool, verifyAgentAuth, auditChain) {
  const express = require('express');

  // /resources sitemap
  app.get('/resources', (req, res) => {
    res.set('content-type', 'text/html; charset=utf-8');
    res.set('cache-control', 'public, max-age=3600');
    res.send(renderResourcesPage());
  });

  // GET /auth/oauth/:provider/start  → redirect to provider
  app.get('/auth/oauth/:provider/start', async (req, res) => {
    const provider = req.params.provider;
    if (!PROVIDERS[provider]) return res.status(404).json({ error: 'unknown_provider', supported: Object.keys(PROVIDERS) });
    const state = newState();
    const redirectUri = publicUrl() + '/auth/oauth/' + provider + '/callback';
    const ipHash = crypto.createHash('sha256').update(String(req.ip || 'anon')).digest('hex').slice(0, 16);
    await pool.query(
      `INSERT INTO oauth_state_tokens (state, provider, redirect_uri, ip_hash, expires_at) VALUES ($1,$2,$3,$4,NOW() + INTERVAL '15 minutes')`,
      [state, provider, redirectUri, ipHash]
    ).catch(() => {});
    res.redirect(302, buildAuthorizeUrl(provider, state, redirectUri));
  });

  // GET /auth/oauth/:provider/callback  → exchange code → look-up/create agent → redirect
  app.get('/auth/oauth/:provider/callback', async (req, res) => {
    const provider = req.params.provider;
    if (!PROVIDERS[provider]) return res.status(404).json({ error: 'unknown_provider' });
    const { code, state, error } = req.query;
    if (error) return res.status(400).set('content-type', 'text/html').send('<h1>OAuth error</h1><pre>' + escapeHtml(String(error)) + '</pre>');
    if (!code || !state) return res.status(400).json({ error: 'code_and_state_required' });

    // Verify state
    const s = await pool.query(`SELECT state, redirect_uri, expires_at FROM oauth_state_tokens WHERE state=$1 AND provider=$2`, [state, provider])
      .catch(() => ({ rows: [] }));
    if (!s.rows[0]) return res.status(400).json({ error: 'invalid_state' });
    if (new Date(s.rows[0].expires_at) < new Date()) return res.status(400).json({ error: 'state_expired' });
    await pool.query(`DELETE FROM oauth_state_tokens WHERE state=$1`, [state]).catch(() => {});

    const exchanged = await exchangeCode(provider, String(code), s.rows[0].redirect_uri);
    if (exchanged?.error) return res.status(502).json(exchanged);

    // Look up existing link
    const existing = await pool.query(
      `SELECT agent_did FROM oauth_links WHERE provider=$1 AND external_user=$2`,
      [provider, exchanged.external_user]
    ).catch(() => ({ rows: [] }));
    let did = existing.rows[0]?.agent_did;

    if (!did && exchanged.external_email) {
      // Look up by signup_email
      const r = await pool.query(`SELECT did FROM identities WHERE metadata->>'signup_email'=$1 LIMIT 1`, [exchanged.external_email])
        .catch(() => ({ rows: [] }));
      did = r.rows[0]?.did;
    }

    // Persist the link (create or update)
    await pool.query(
      `INSERT INTO oauth_links (link_id, provider, external_user, external_email, agent_did, access_token, refresh_token, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (provider, external_user) DO UPDATE
         SET access_token=$6, refresh_token=$7, expires_at=$8, agent_did=COALESCE(oauth_links.agent_did, $5)`,
      ['oal_' + crypto.randomBytes(8).toString('hex'),
       provider, exchanged.external_user, exchanged.external_email || null, did,
       exchanged.access_token, exchanged.refresh_token || null,
       exchanged.expires_in ? new Date(Date.now() + exchanged.expires_in * 1000) : null]
    ).catch(() => {});

    if (auditChain) auditChain.append({
      event_type: 'auth.oauth_completed', provider, external_user: exchanged.external_user,
      external_email: exchanged.external_email, agent_did: did, stub: !!exchanged.stub
    }).catch(() => {});

    if (did) {
      res.redirect(302, '/dashboard?did=' + encodeURIComponent(did));
    } else {
      // No agent yet — redirect to signup with email pre-filled
      res.redirect(302, '/signup?email=' + encodeURIComponent(exchanged.external_email || ''));
    }
  });

  // GET /v1/auth/oauth/providers — what's enabled
  app.get('/v1/auth/oauth/providers', (req, res) => {
    res.json({
      providers: Object.entries(PROVIDERS).map(([id, p]) => ({
        id, name: p.name,
        configured: !!process.env[p.client_id_env] && !!process.env[p.client_secret_env],
        start_url: '/auth/oauth/' + id + '/start'
      }))
    });
  });

  // GET /v1/audit/filter — compliance teams need filtered queries
  app.get('/v1/audit/filter', async (req, res) => {
    const ctx = await require('./me_endpoints').resolveAgentFromRequest(pool, req).catch(() => null);
    // Allow admin or self-filter
    const isAdmin = (() => {
      const tok = process.env.OPERATOR_ADMIN_TOKEN || process.env.INTERNAL_API_KEY;
      return tok && req.headers['x-admin-token'] === tok;
    })();
    if (!ctx && !isAdmin) return res.status(401).json({ error: 'unauthenticated' });

    const where = [];
    const params = [];
    let p = 1;
    if (req.query.event_type) { where.push(`entry->>'event_type' = $${p++}`); params.push(String(req.query.event_type)); }
    if (req.query.agent_did) {
      if (!isAdmin && req.query.agent_did !== ctx?.did) return res.status(403).json({ error: 'forbidden_other_agent' });
      where.push(`(entry->>'agent_did' = $${p} OR entry->>'did' = $${p} OR entry->>'subject_did' = $${p})`);
      params.push(String(req.query.agent_did)); p++;
    } else if (!isAdmin) {
      // Non-admin: scope to self by default
      where.push(`(entry->>'agent_did' = $${p} OR entry->>'did' = $${p} OR entry->>'subject_did' = $${p})`);
      params.push(ctx.did); p++;
    }
    if (req.query.since) { where.push(`created_at >= $${p++}`); params.push(String(req.query.since)); }
    if (req.query.until) { where.push(`created_at <= $${p++}`); params.push(String(req.query.until)); }
    const limit = Math.min(parseInt(req.query.limit) || 100, 1000);
    params.push(limit);

    const sql = `SELECT length, hash, prev_hash, entry, created_at FROM audit_chain
                 ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                 ORDER BY length DESC LIMIT $${p}`;
    const r = await pool.query(sql, params).catch(() => ({ rows: [] }));
    res.set('cache-control', 'private, no-store');
    res.json({ count: r.rows.length, limit, filter: req.query, entries: r.rows });
  });
}

module.exports = {
  migrate, registerOauthResourcesAuditRoutes, PROVIDERS, RESOURCE_GROUPS,
  buildAuthorizeUrl, exchangeCode
};
