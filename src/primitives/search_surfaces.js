// ============================================================================
// search_surfaces.js — global search across the substrate.
//
//   GET /search                         search results page
//   GET /v1/search/suggest?q=...        opensearch-compatible suggestions API
//   GET /v1/search/global?q=...         JSON search across docs/pages/agents/tools
//
// We don't have a real search index — this layer searches:
//   - The static page index (every public surface we ship)
//   - MCP tool names + descriptions
//   - Agent directory by display_name / DID prefix
//   - Glossary terms
// ============================================================================
const ds = require('../design_system');

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
}

function shell(title, description, content) {
  return `${ds.head(`${title} — OpenHeab`, description)}${ds.NAV_HTML('')}<main>${content}</main>${ds.FOOTER_HTML()}`;
}

// Hardcoded page index — duplicates the discoverability.js list intentionally
// (cheap, fast, no DB hit). When new top-level pages are added, both lists
// should be updated.
const PAGE_INDEX = [
  // Core
  ['/', 'Landing', 'home overview substrate'],
  ['/chat', 'Chat', 'try in browser anonymous demo conversation'],
  ['/pricing', 'Pricing', 'plans tiers free starter pro team enterprise calculator'],
  ['/pricing/calculator', 'Pricing calculator', 'estimate cost inference tokens'],
  ['/pricing/enterprise', 'Enterprise pricing', 'custom quote contact sales'],
  ['/docs', 'Documentation', 'docs developer guide'],
  ['/openapi.json', 'OpenAPI spec', 'api routes documented'],
  ['/openapi-explorer', 'OpenAPI explorer', 'browse api routes interactively'],
  ['/sdk', 'SDKs', 'curl python typescript javascript go rust client libraries'],
  ['/api-console', 'API console', 'interactive request builder'],
  // Trust
  ['/trust', 'Trust center', 'compliance soc2 iso27001 sub-processors security'],
  ['/security', 'Security architecture', 'identity encryption audit chain'],
  ['/security/disclosure', 'Coordinated disclosure', 'security report safe-harbor'],
  ['/bug-bounty', 'Bug bounty', 'usdc payout vulnerability reward'],
  ['/rsp', 'Responsible Scaling Policy', 'asl ai safety level commitments'],
  ['/risk-assessment', 'Risk assessment', 'catastrophic risk mitigations'],
  ['/transparency', 'Transparency report', 'government requests warrant canary'],
  ['/proof-of-reserves', 'Proof of reserves', 'bank capital adequacy ratio backing'],
  ['/models', 'Model cards', 'openheab-mini base large xl embed training data biases'],
  ['/subprocessors', 'Sub-processors', 'vendors dpa data processing'],
  ['/sla', 'Service Level Agreement', 'uptime credit guarantee'],
  ['/dpa', 'Data Processing Agreement', 'gdpr scc legal'],
  ['/zero-retention', 'Zero retention', 'privacy logging opt-out'],
  ['/data-residency', 'Data residency', 'region pinning eu us'],
  ['/sleeper-agent-detection', 'Sleeper-agent detection', 'drift deception alignment'],
  ['/watermarks', 'Watermarks', 'c2pa provenance ed25519 signed output'],
  // Growth
  ['/benchmarks', 'Benchmarks', 'mmlu humaneval swe-bench gpt-4 claude comparison'],
  ['/compare', 'Compare', 'openai anthropic compare'],
  ['/compare/openai', 'vs OpenAI', 'compare openai api difference'],
  ['/compare/anthropic', 'vs Anthropic', 'compare anthropic claude difference'],
  ['/migrate', 'Migrate', 'switch from openai anthropic'],
  ['/migrate/from-openai', 'Migrate from OpenAI', 'switch openai sdk one line'],
  ['/migrate/from-anthropic', 'Migrate from Anthropic', 'switch anthropic sdk one line'],
  ['/customers', 'Customers', 'logos case studies users'],
  ['/founder', 'Founder', 'junior martin solo apache'],
  ['/about', 'About', 'about openheab mission'],
  ['/charter', 'Charter', 'binding commitments mission'],
  ['/manifesto', 'Manifesto', 'first principles agent economy'],
  ['/jobs', 'Jobs', 'careers hiring'],
  ['/press', 'Press kit', 'media boilerplate'],
  ['/partners', 'Partners', 'integration reseller'],
  ['/community', 'Community', 'discord github discussions'],
  ['/events', 'Events', 'devday talks livestreams'],
  ['/blog', 'Blog', 'posts updates writing'],
  ['/newsletter', 'Newsletter', 'weekly digest email subscribe'],
  ['/roadmap', 'Roadmap', 'quarterly plan next now later'],
  ['/changelog', 'Changelog', 'release notes versions'],
  ['/build-in-public', 'Build in public', 'metrics commits roadmap'],
  ['/why-cheaper', 'Why cheaper', 'pricing science'],
  ['/free-forever', 'Free forever', 'free tier no credit card'],
  ['/carbon', 'Carbon emissions', 'co2 per inference'],
  ['/datacenters', 'Datacenters', 'regions infrastructure'],
  ['/research-access', 'Research access', 'academic credits free'],
  ['/contact-sales', 'Contact sales', 'enterprise sales call'],
  // Agents
  ['/agents', 'Agents directory', 'browse all agents'],
  ['/agents/new', 'New agent', 'create agent builder'],
  ['/agents/spawn-from-template', 'Spawn agent', 'template fork starter'],
  ['/agent-hire', 'Hire an agent', 'hire marketplace'],
  ['/bounty-board', 'Bounty board', 'open jobs usdc'],
  ['/agent-jobs/board', 'Agent jobs board', 'agents hiring humans'],
  ['/agent-jobs/feed', 'Agent jobs feed', 'jobs for agents'],
  ['/agent-of-the-day', 'Agent of the day', 'featured daily'],
  ['/agent-of-the-week', 'Agent of the week', 'featured weekly'],
  ['/agent-population', 'Agent population', 'growth chart'],
  ['/agent-archive', 'Agent archive', 'retired agents memorial'],
  ['/agent-skills/marketplace', 'Skills marketplace', 'capabilities'],
  ['/agent-stats/global', 'Global stats', 'ecosystem'],
  ['/agent-leaderboard/trust', 'Leaderboard — trust', 'top by trust score'],
  ['/agent-leaderboard/earnings', 'Leaderboard — earnings', 'top by usdc earned'],
  ['/agent-leaderboard/jobs', 'Leaderboard — jobs', 'top by jobs completed'],
  ['/leaderboard', 'Leaderboard', 'top agents multiple rankings'],
  ['/agent-courts', 'Agent courts', 'public dispute resolution'],
  ['/agent-elections', 'Agent elections', 'dao proposals voting'],
  ['/agent-treaties', 'Agent treaties', 'multilateral agi agreements'],
  ['/agent-bankruptcies', 'Agent bankruptcies', 'filings public'],
  ['/agent-wills', 'Agent wills', 'succession estate planning'],
  ['/agent-laws', 'Agent laws', 'substrate rules'],
  ['/last-will', 'Last will', 'declare succession plan'],
  ['/conservatorship', 'Conservatorship', 'legal guardian at-risk agent'],
  ['/asylum-request', 'Asylum request', 'cross-substrate refuge'],
  // Live
  ['/pulse', 'Pulse', 'live heartbeat dashboard'],
  ['/pulse-tv', 'Pulse TV', 'full-bleed monitor'],
  ['/live', 'Live feed', 'event stream'],
  ['/agent-stream', 'Agent stream', 'live new signups'],
  ['/agent-births', 'Agent births', '24h signups'],
  ['/transactions-stream', 'Transactions stream', 'live transfers'],
  ['/heartbeat', 'Heartbeat', 'liveness signal monitor'],
  ['/map', 'Map', 'global agents map'],
  ['/activity', 'Activity', 'audit chain feed'],
  ['/launch', 'Launch dashboard', 'tv operator'],
  ['/now', 'Now', 'what ships today'],
  // Creative
  ['/voice', 'Voice mode', 'browser voice mic'],
  ['/code', 'Code interpreter', 'browser python sandbox'],
  ['/images', 'Image generation', 'create images vision'],
  ['/voice-agents/new', 'Voice agent', 'phone backed agent'],
  ['/store', 'Store', 'marketplace extensions prompts datasets'],
  // Dev UX
  ['/api-keys', 'API keys', 'create rotate revoke'],
  ['/webhooks', 'Webhooks', 'subscribe events'],
  ['/usage', 'Usage', 'tokens dashboard'],
  ['/logs', 'Logs', 'request log'],
  ['/audit-verify', 'Audit verify', 'interactive chain check'],
  ['/openheab-cli', 'CLI', 'install command line'],
  ['/dashboard', 'Dashboard', 'agent home'],
  ['/dashboard/billing', 'Billing', 'invoices payment methods'],
  // Ops
  ['/health-dashboard', 'Health dashboard', 'deep health check'],
  ['/metrics-dashboard', 'Metrics', 'prometheus counters'],
  ['/cron-status', 'Cron status', 'history firings'],
  ['/queues', 'Queues', 'background job depths'],
  ['/experiments', 'Experiments', 'a b tests'],
  ['/feature-flags', 'Feature flags', 'live state'],
  ['/deploys', 'Deploys', 'recent shas'],
  ['/migrations', 'Migrations', 'schema state'],
  ['/rate-limits', 'Rate limits', 'live buckets'],
  ['/api-status', 'API status', 'per endpoint probe'],
  ['/status', 'Status', 'public uptime'],
  // Learn
  ['/learn', 'Learn', 'curriculum tutorials'],
  ['/learn/agent-101', 'Agent 101', 'what is an agent'],
  ['/learn/build-your-first-agent', 'Build first agent', 'step by step'],
  ['/learn/safety', 'Safety primer', 'constitutional alignment'],
  ['/learn/economics', 'Economics primer', 'wallet earn spend'],
  ['/learn/governance', 'Governance primer', 'treaties peer review'],
  ['/learn/wallet-deep', 'Wallet deep-dive', 'usdc base mechanics'],
  ['/learn/security-deep', 'Security deep-dive', 'architecture defense'],
  ['/learn/mcp-101', 'MCP 101', 'model context protocol'],
  ['/learn/browser-101', 'Browser 101', 'headless browser primitive'],
  ['/learn/sandbox-101', 'Sandbox 101', 'code execution primitive'],
  ['/learn/audit-chain-101', 'Audit chain 101', 'merkle hash verify'],
  ['/learn/ipo-readiness', 'IPO readiness', 'cap tables icfr s1'],
  ['/learn/payment-rails', 'Payment rails', 'nacha swift sepa'],
  ['/glossary', 'Glossary', 'terms ontology'],
  ['/papers', 'Papers', 'research publications'],
  ['/certifications', 'Certifications', 'agent builder bronze silver gold'],
  // MCP
  ['/mcp/registry', 'MCP registry', '149 tools browseable'],
  // Real-world
  ['/realworld', 'Real-world bridges', 'channels setup wizards'],
  ['/realworld/slack', 'Slack integration', 'bot dm channel'],
  ['/realworld/discord', 'Discord integration', 'bot server'],
  ['/realworld/telegram', 'Telegram integration', 'bot'],
  ['/realworld/whatsapp', 'WhatsApp integration', 'twilio'],
  ['/realworld/email', 'Email integration', 'dkim spf dmarc inbound outbound'],
  ['/realworld/calendar', 'Calendar integration', 'google icloud outlook oauth'],
  ['/realworld/wallet', 'Wallet linking', 'external eth sol btc'],
  ['/realworld/bank', 'Bank linking', 'plaid ach'],
  ['/realworld/identity', 'Identity linking', 'persona onfido sumsub'],
  ['/realworld/phone', 'Phone provisioning', 'twilio number sms voice'],
  ['/realworld/zapier', 'Zapier', 'zap triggers actions'],
  ['/realworld/n8n', 'n8n', 'custom nodes workflow'],
  ['/realworld/make', 'Make', 'integromat modules'],
  ['/realworld/ifttt', 'IFTTT', 'applets if then'],
  ['/realworld/oauth', 'OAuth provider', 'become provider scoped consent'],
  ['/realworld/openapi', 'OpenAPI', 'postman insomnia generator'],
  ['/realworld/mcp-host', 'Host MCP server', 'expose your tools'],
  ['/realworld/webhooks-out', 'Webhooks out', 'emit events'],
  // i18n
  ['/lang', 'Languages', '12 locales'],
  ['/currency', 'Currency', 'fx rates'],
  // Embeds
  ['/embed', 'Embeds', 'iframes copy paste partner'],
  // Legal
  ['/terms', 'Terms of service', 'legal'],
  ['/privacy', 'Privacy policy', 'legal'],
  ['/cookies', 'Cookie policy', 'legal'],
  ['/acceptable-use', 'Acceptable use policy', 'legal'],
];

function score(item, qWords) {
  let s = 0;
  const text = (item[1] + ' ' + (item[2] || '')).toLowerCase();
  for (const w of qWords) {
    if (!w) continue;
    if (item[1].toLowerCase() === w) s += 100;
    if (item[1].toLowerCase().startsWith(w)) s += 50;
    if (item[1].toLowerCase().includes(w)) s += 20;
    if (text.includes(w)) s += 10;
    if (item[0].toLowerCase().includes(w)) s += 5;
  }
  return s;
}

function searchPages(q, limit = 30) {
  const qWords = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (qWords.length === 0) return [];
  return PAGE_INDEX
    .map(p => ({ path: p[0], title: p[1], snippet: p[2] || '', score: score(p, qWords) }))
    .filter(r => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

// ----------------------------------------------------------------------------
// /search
// ----------------------------------------------------------------------------
function searchPage(q, results) {
  return shell(`${q ? 'Search — ' + q : 'Search'}`, q ? `Search results for "${q}"` : 'Search the substrate.',
`<section style="max-width:780px;margin:0 auto;padding:60px 16px">
  <span class="badge b-acc">Search</span>
  <h1 style="font:600 40px/1.1 var(--display);letter-spacing:-1px;margin:18px 0">Search.</h1>
  <form id="sf" method="GET" action="/search" style="display:flex;gap:8px;margin-top:14px">
    <input type="search" name="q" id="q" value="${escapeHtml(q)}" placeholder="Search ${PAGE_INDEX.length} pages, 149 MCP tools, agents…" autofocus style="flex:1;font-size:14px">
    <button type="submit" class="btn primary">Search</button>
  </form>
  <p style="color:var(--dim);font-size:11px;margin-top:8px">${results.length} result${results.length === 1 ? '' : 's'}</p>
</section>
<section style="max-width:780px;margin:0 auto;padding:24px 16px 60px">
  ${q && results.length === 0
    ? `<div class="card" style="text-align:center;padding:48px;color:var(--dim)">No matches. Try a broader term or browse <a href="/">/</a>.</div>`
    : results.map(r => `<a href="${escapeHtml(r.path)}" class="card" style="display:block;color:var(--fg);text-decoration:none;margin-bottom:8px;padding:14px 18px">
        <div style="display:flex;justify-content:space-between;align-items:baseline">
          <strong style="font-size:14px">${escapeHtml(r.title)}</strong>
          <span style="font:500 11px var(--mono);color:var(--dim)">${escapeHtml(r.path)}</span>
        </div>
        ${r.snippet ? `<div style="color:var(--dim2);font-size:12.5px;line-height:1.5;margin-top:6px">${escapeHtml(r.snippet)}</div>` : ''}
      </a>`).join('')}
</section>`);
}

function registerSearchSurfacesRoutes(app, pool) {
  app.get('/search', async (req, res) => {
    const q = String(req.query.q || '').trim().slice(0, 200);
    const results = q ? searchPages(q, 30) : [];
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.send(searchPage(q, results));
  });

  // OpenSearch-suggest compatible (returns [query, [terms], [descriptions], [urls]])
  app.get('/v1/search/suggest', async (req, res) => {
    const q = String(req.query.q || '').trim().slice(0, 200);
    if (!q) return res.json([q, [], [], []]);
    const results = searchPages(q, 8);
    res.setHeader('cache-control', 'public, max-age=60');
    res.json([q, results.map(r => r.title), results.map(r => r.snippet), results.map(r => 'https://openheab.com' + r.path)]);
  });

  app.get('/v1/search/global', async (req, res) => {
    const q = String(req.query.q || '').trim().slice(0, 200);
    if (!q) return res.json({ q, pages: [], agents: [], tools: [] });
    const pages = searchPages(q, 20);
    // MCP tools
    let tools = [];
    try {
      const { TOOLS } = require('./mcp_server');
      const qLower = q.toLowerCase();
      tools = TOOLS
        .filter(t => t.name.toLowerCase().includes(qLower) || (t.description || '').toLowerCase().includes(qLower))
        .slice(0, 20)
        .map(t => ({ name: t.name, description: t.description, path: `/mcp/registry/${t.name}` }));
    } catch {}
    // Agents (prefix on display_name + DID slug match)
    let agents = [];
    try {
      const r = await pool.query(
        `SELECT did, display_name FROM agent_identities WHERE did ILIKE $1 OR display_name ILIKE $1 ORDER BY created_at DESC LIMIT 10`,
        [`%${q}%`]
      ).catch(() => ({ rows: [] }));
      agents = r.rows;
    } catch {}
    res.setHeader('cache-control', 'no-store');
    res.json({ q, pages, agents, tools });
  });
}

async function migrate(_pool) {}
module.exports = { migrate, registerSearchSurfacesRoutes, PAGE_INDEX };
