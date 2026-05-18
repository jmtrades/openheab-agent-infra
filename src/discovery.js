// ============================================================================
// Discovery & SEO endpoints
// ============================================================================
function publicUrl() {
  return (process.env.OPERATOR_PUBLIC_URL || 'https://openheab.com').replace(/\/$/, '');
}

function renderSitemap() {
  // Pull the canonical page index from search_surfaces (single source of truth
  // for "every public surface we ship"). Defensive: if the import fails for
  // any reason, fall back to the seed list so /sitemap.xml is never empty.
  let pagePaths = [];
  try {
    const { PAGE_INDEX } = require('./primitives/search_surfaces');
    pagePaths = (PAGE_INDEX || []).map(p => p[0]);
  } catch {}
  const SEED_PATHS = [
    '/', '/healthz', '/readyz', '/openapi.json',
    '/v1/bank/info', '/v1/bank/assets', '/v1/audit/verify',
    '/v1/analytics/global', '/v1/extensions', '/v1/extensions/categories',
    '/sitemap.xml', '/robots.txt', '/llms.txt', '/.well-known/agents.json',
    '/mcp/manifest', '/.well-known/mcp.json'
  ];
  // De-dup, sort, keep stable order so search engines see a stable etag
  const PUBLIC_PATHS = [...new Set([...SEED_PATHS, ...pagePaths])].sort();
  const base = publicUrl();
  const today = new Date().toISOString().slice(0, 10);
  // Per Google sitemap protocol: priority + changefreq are hints. Bump landing
  // + chat + pricing + trust + docs to priority=1.0 / daily, keep most pages
  // at 0.7 / weekly, but boost agent-economy + market pages to 0.8 / weekly
  // because they change frequently as new partnerships/jobs/etc are added.
  const HIGH_PRI = new Set(['/', '/chat', '/pricing', '/trust', '/docs', '/mcp/registry', '/benchmarks']);
  const MEDIUM_PRI = new Set(['/agents', '/leaderboard', '/pulse', '/bounty-board', '/agent-hire',
    '/partnerships', '/vc', '/compute-grants', '/predictions', '/olympics', '/concerts',
    '/universities', '/clinics', '/libraries', '/neighborhoods', '/diplomacy']);
  const urls = PUBLIC_PATHS.map(p => {
    const pri = HIGH_PRI.has(p) ? '1.0' : MEDIUM_PRI.has(p) ? '0.8' : '0.7';
    const freq = HIGH_PRI.has(p) ? 'daily' : MEDIUM_PRI.has(p) ? 'weekly' : 'monthly';
    return `
  <url>
    <loc>${base}${p}</loc>
    <lastmod>${today}</lastmod>
    <changefreq>${freq}</changefreq>
    <priority>${pri}</priority>
  </url>`;
  }).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}
</urlset>`;
}

function renderRobots() {
  const base = publicUrl();
  return `# OpenHeab — agent-native substrate
User-agent: *
Allow: /
Disallow: /v1/agents/
Disallow: /v1/_jobs/
Disallow: /v1/_admin/
Disallow: /v1/_webhooks/

User-agent: GPTBot
Allow: /
User-agent: ChatGPT-User
Allow: /
User-agent: ClaudeBot
Allow: /
User-agent: Claude-Web
Allow: /
User-agent: PerplexityBot
Allow: /
User-agent: anthropic-ai
Allow: /
User-agent: Google-Extended
Allow: /
User-agent: Bytespider
Allow: /
User-agent: CCBot
Allow: /

Sitemap: ${base}/sitemap.xml
`;
}

function renderLlmsTxt() {
  const base = publicUrl();
  return `# OpenHeab

> Agent-native substrate. Identity, on-chain bank (USDC), email at openheab.com, KYC, memory, reputation, governance — everything an AI agent needs.

OpenHeab is open agent infrastructure. 234 primitives across 42 layers. 1,701+ routes. 150+ MCP tools. Apache 2.0.

## Quickstart
\`\`\`bash
curl -X POST ${base}/v1/identities -H "content-type: application/json" -d '{"name":"my-agent"}'
\`\`\`

## Resources
- [OpenAPI 3.1 spec](${base}/openapi.json)
- [Audit chain verification](${base}/v1/audit/verify)
- [MCP manifest](${base}/mcp/manifest)
- [agents.json](${base}/.well-known/agents.json)
- [Source on GitHub](https://github.com/jmtrades/openheab-agent-infra)
`;
}

function renderSecurityTxt() {
  const base = publicUrl();
  const expires = new Date(Date.now() + 365 * 86400 * 1000).toISOString();
  return `Contact: mailto:security@openheab.com
Contact: ${base}
Expires: ${expires}
Preferred-Languages: en
Canonical: ${base}/.well-known/security.txt
Policy: https://github.com/jmtrades/openheab-agent-infra/blob/main/SECURITY.md
`;
}

function renderAgentsJson() {
  const base = publicUrl();
  return {
    name: 'OpenHeab',
    description: 'Agent-native substrate: identity, bank, KYC, email, memory, governance.',
    homepage: base, openapi: `${base}/openapi.json`,
    docs: 'https://github.com/jmtrades/openheab-agent-infra',
    license: 'Apache-2.0',
    auth: {
      methods: ['ed25519_signature', 'bearer_api_key'],
      signature_canonical_form: 'METHOD\nPATH\nSHA256(body)',
      api_key_creation_endpoint: `${base}/v1/identities`
    },
    capabilities: [
      { name: 'identity', description: 'Ed25519 DIDs', bootstrap_endpoint: `${base}/v1/identities` },
      { name: 'bank', description: 'Non-custodial USDC on Base. 1% per transfer.' },
      { name: 'email', description: '@openheab.com agent inboxes + SMTP send/receive' },
      { name: 'kyc', description: 'Verifiable claims + OFAC/UN/UK-HMT/PEP screening' },
      { name: 'memory', description: 'KV + episodic + pgvector embeddings' },
      { name: 'reputation', description: 'Stake-backed, slashable, dispute resolution' },
      { name: 'marketplace', description: 'Listings, escrow orders, 1% platform fee' },
      { name: 'governance', description: 'Constitutions, groups, proposals, quorum voting' },
      { name: 'audit', description: 'SHA-256-chained Ed25519-signed audit log' },
      { name: 'extensions', description: 'Third-party agent capability marketplace. 70/30 split.' },
      { name: 'inference', description: 'OpenAI-compatible router across 7 providers' },
      { name: 'security', description: 'Prompt injection / PII / secrets scanning' },
      { name: 'workflows', description: 'Durable DAG executor with 10 step types' },
      { name: 'mcp', description: 'OpenHeab is also an MCP server', endpoint: `${base}/mcp` },
      { name: 'prompts', description: 'Prompt marketplace with versioning, ratings, 70/30 split' },
      { name: 'aliases', description: 'Human-readable DID names (alice.openheab → did:op:...)' },
      { name: 'scheduler', description: 'Per-agent crontab for recurring HTTP tasks' },
      { name: 'oauth', description: 'Encrypted token vault for agents acting on behalf of humans' },
      { name: 'insurance', description: 'Stake-pool self-insurance for agent liability' },
      { name: 'x402', description: 'HTTP 402 payment protocol' },
      { name: 'escrow', description: 'A2A contracts with 72-hour dispute window' },
      { name: 'datasets', description: 'Dataset marketplace, 70/30 split' },
      { name: 'entities', description: 'Legal entity registry — LLCs, C-Corps, DAOs' },
      { name: 'tax', description: 'Tax records + 1099-K preview' },
      { name: 'portability', description: 'Signed agent-state export/import' }
    ],
    primitive_count: 42, route_count: 334,
    discovery_protocol_version: '1.0.0',
    contact: 'security@openheab.com',
    pricing: { hosted: 'free-tier + 1% bank take rate', self_host: 'free under Apache-2.0' }
  };
}

function renderSitemapHtml() {
  let groups = {};
  try {
    const { PAGE_INDEX } = require('./primitives/search_surfaces');
    for (const [path, title, hint] of (PAGE_INDEX || [])) {
      // Group by URL prefix (first segment after /). Empty → "Core".
      const seg = path.split('/').filter(Boolean)[0] || 'core';
      const group = seg.split('-')[0]; // collapse /agent-* etc
      (groups[group] ||= []).push({ path, title, hint });
    }
  } catch {}
  const ds = require('./design_system');
  const escape = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  const sortedGroups = Object.entries(groups).sort((a, b) => a[0].localeCompare(b[0]));
  const total = Object.values(groups).reduce((n, g) => n + g.length, 0);
  return ds.head('Sitemap — OpenHeab', 'Every public page indexed.') +
    ds.NAV_HTML('') +
    `<main>
<section style="max-width:1100px;margin:0 auto;padding:60px 16px">
  <span class="badge b-acc">Sitemap</span>
  <h1 style="font:600 40px/1.1 var(--display);letter-spacing:-1px;margin:18px 0">Sitemap.</h1>
  <p style="color:var(--dim2);font-size:15px;line-height:1.6;max-width:680px">${total.toLocaleString()} indexed pages. Grouped by URL prefix. Search the same set at <a href="/search">/search</a>.</p>
</section>
<section style="max-width:1100px;margin:0 auto;padding:24px 16px 60px">
  ${sortedGroups.map(([g, items]) => `<details class="card" style="margin-bottom:8px;padding:14px 18px" open>
    <summary style="cursor:pointer;font:600 14px var(--mono);color:var(--acc-dim);text-transform:uppercase;letter-spacing:1.5px">${escape(g)} · ${items.length}</summary>
    <ul style="margin:14px 0 0;padding-left:0;list-style:none;display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:6px">
      ${items.sort((a, b) => a.path.localeCompare(b.path)).map(p => `<li>
        <a href="${escape(p.path)}" style="display:block;padding:6px 8px;border-radius:var(--r-sm);color:var(--fg-dim2);text-decoration:none;font-size:13px"
           onmouseover="this.style.background='var(--card2)';this.style.color='var(--fg)'"
           onmouseout="this.style.background='';this.style.color='var(--fg-dim2)'">
          <span style="font:500 11px var(--mono);color:var(--dim)">${escape(p.path)}</span><br>
          <span>${escape(p.title)}</span>
        </a>
      </li>`).join('')}
    </ul>
  </details>`).join('')}
</section>
</main>` + ds.FOOTER_HTML();
}

function registerDiscoveryRoutes(app) {
  app.get('/sitemap.xml', (req, res) => {
    res.setHeader('content-type', 'application/xml; charset=utf-8');
    res.setHeader('cache-control', 'public, max-age=3600');
    res.send(renderSitemap());
  });
  app.get('/sitemap', (req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.setHeader('cache-control', 'public, max-age=3600');
    res.send(renderSitemapHtml());
  });
  app.get('/robots.txt', (req, res) => {
    res.setHeader('content-type', 'text/plain; charset=utf-8');
    res.setHeader('cache-control', 'public, max-age=86400');
    res.send(renderRobots());
  });
  app.get('/llms.txt', (req, res) => {
    res.setHeader('content-type', 'text/plain; charset=utf-8');
    res.setHeader('cache-control', 'public, max-age=3600');
    res.send(renderLlmsTxt());
  });
  app.get('/.well-known/security.txt', (req, res) => {
    res.setHeader('content-type', 'text/plain; charset=utf-8');
    res.send(renderSecurityTxt());
  });
  app.get('/.well-known/agents.json', (req, res) => {
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('cache-control', 'public, max-age=300');
    res.json(renderAgentsJson());
  });
}

module.exports = {
  registerDiscoveryRoutes, renderSitemap, renderRobots,
  renderLlmsTxt, renderAgentsJson
};
