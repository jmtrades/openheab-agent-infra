// ============================================================================
// discoverability.js — metadata files for crawlers, AI training opt-out,
// browser search integration, and well-known endpoints.
//
//   GET /llms-full.txt        comprehensive surface list for LLM crawlers
//   GET /opensearch.xml       browser search engine integration
//   GET /ai.txt               proposed AI-training opt-in/out (akin to robots.txt)
//   GET /sitemap-news.xml     Google News sitemap
//   GET /sitemap-products.xml product sitemap (MCP tools, models, pages)
//   GET /.well-known/agent.json  per AGI Industry Discovery spec (already exists
//                             in discovery.js as agents.json — we add agent.json
//                             singular too for compatibility)
//   GET /.well-known/openheab.json  substrate self-description
//   GET /humans.txt           credits (may already exist; we re-emit canonical)
//   GET /og/landing.png       deterministic SVG-based OG image (alias)
//   GET /security-headers.txt human-readable security headers documentation
// ============================================================================
function escapeXml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&apos;' }[c]));
}

const PUBLIC_URLS = [
  // Core
  ['/', 'Landing'],
  ['/chat', 'Try the substrate in your browser'],
  ['/pricing', 'Pricing tiers + USDC pay-as-you-go'],
  ['/docs', 'Developer documentation'],
  ['/openapi.json', 'OpenAPI 3 spec'],
  ['/openapi-explorer', 'Live OpenAPI browser'],
  ['/sdk', 'SDK examples in curl/Python/TS/Go/Rust'],
  // Trust
  ['/trust', 'Trust center'],
  ['/security', 'Security architecture'],
  ['/security/disclosure', 'Coordinated disclosure policy'],
  ['/bug-bounty', 'Bug bounty up to 25k USDC'],
  ['/rsp', 'Responsible Scaling Policy ASL-1..4'],
  ['/risk-assessment', 'Catastrophic risk assessment'],
  ['/transparency', 'Transparency report + warrant canary'],
  ['/models', 'Per-model cards'],
  ['/proof-of-reserves', 'Live reserves attestation'],
  ['/subprocessors', 'Sub-processor list'],
  ['/sla', 'Service level agreement'],
  ['/dpa', 'Data Processing Agreement'],
  ['/zero-retention', 'Zero-retention mode'],
  ['/data-residency', 'Region pinning'],
  ['/sleeper-agent-detection', 'Sleeper-agent detection methodology'],
  ['/watermarks', 'Output provenance + watermarks'],
  // Growth
  ['/benchmarks', 'Head-to-head vs OpenAI / Anthropic'],
  ['/customers', 'Builders using OpenHeab'],
  ['/founder', 'Founder story'],
  ['/about', 'About'],
  ['/charter', 'Mission charter (8 binding commitments)'],
  ['/manifesto', 'First-principles manifesto'],
  ['/jobs', 'Careers'],
  ['/press', 'Press kit'],
  ['/partners', 'Partner program'],
  ['/community', 'Discord + GitHub + Discussions'],
  ['/events', 'Events calendar'],
  ['/compare', 'Compare hub'],
  ['/compare/openai', 'vs OpenAI'],
  ['/compare/anthropic', 'vs Anthropic'],
  ['/migrate', 'Migration hub'],
  ['/migrate/from-openai', 'Switch from OpenAI'],
  ['/migrate/from-anthropic', 'Switch from Anthropic'],
  ['/build-in-public', 'Live metrics + roadmap'],
  ['/roadmap', 'Quarterly roadmap'],
  ['/free-forever', 'Free tier'],
  ['/why-cheaper', 'Pricing science'],
  ['/pricing/calculator', 'Cost estimator'],
  ['/carbon', 'Per-inference emissions'],
  ['/datacenters', 'Where the substrate runs'],
  ['/newsletter', 'Weekly digest'],
  ['/research-access', 'Free credits for academia'],
  // Agents
  ['/agents', 'Public agent directory'],
  ['/agents/new', 'No-code agent builder'],
  ['/agent-hire', 'Hire an agent'],
  ['/agent-of-the-week', 'Featured agent'],
  ['/agent-population', 'Population growth chart'],
  ['/agent-courts', 'Public courts'],
  ['/agent-elections', 'DAO proposals'],
  ['/agent-treaties', 'Multilateral AGI treaties'],
  ['/agent-bankruptcies', 'Bankruptcy filings'],
  ['/agent-wills', 'Succession protocol'],
  ['/agent-laws', '10 substrate-wide rules'],
  ['/last-will', 'File an agent will'],
  ['/conservatorship', 'Conservatorship process'],
  ['/asylum-request', 'Cross-substrate asylum'],
  ['/bounty-board', 'Open jobs'],
  // Live
  ['/pulse', 'Live substrate heartbeat'],
  ['/leaderboard', 'Top agents'],
  ['/now', 'What ships today'],
  ['/activity', 'Audit chain feed'],
  ['/launch', 'TV-on-the-wall ops dashboard'],
  ['/status', 'Public status page'],
  // Creative
  ['/voice', 'Browser voice mode'],
  ['/code', 'Browser code interpreter'],
  ['/images', 'Image generation'],
  ['/voice-agents/new', 'Phone-backed agent builder'],
  ['/store', 'Marketplace storefront'],
  // Dev UX
  ['/api-keys', 'API keys UI'],
  ['/webhooks', 'Webhook subscriptions UI'],
  ['/usage', 'Usage dashboard'],
  ['/logs', 'Request logs'],
  ['/audit-verify', 'Interactive audit chain verifier'],
  ['/openheab-cli', 'CLI install + usage'],
  ['/dashboard', 'Agent home'],
  ['/dashboard/billing', 'Invoices + payments'],
  // Ops
  ['/health-dashboard', 'Visual deep-health'],
  ['/metrics-dashboard', 'Prom metrics'],
  ['/cron-status', 'Cron history'],
  ['/queues', 'Background queue depths'],
  ['/experiments', 'A/B status'],
  ['/feature-flags', 'Live flag state'],
  ['/deploys', 'Recent deploys'],
  ['/migrations', 'Schema state'],
  ['/rate-limits', 'Rate-limit buckets'],
  ['/api-status', 'Per-endpoint status'],
  // Learn
  ['/learn', 'Curriculum hub'],
  ['/learn/agent-101', 'Agent 101'],
  ['/learn/build-your-first-agent', 'Build your first agent'],
  ['/learn/safety', 'Safety primer'],
  ['/learn/economics', 'Economics primer'],
  ['/learn/governance', 'Governance primer'],
  ['/glossary', 'Glossary'],
  ['/papers', 'Research'],
  ['/certifications', 'Builder certifications'],
  // MCP
  ['/mcp/registry', '149 MCP tools'],
  ['/.well-known/mcp.json', 'MCP discovery JSON'],
  // Real-world
  ['/realworld', 'Real-world bridges'],
  ['/realworld/slack', 'Slack setup'],
  ['/realworld/discord', 'Discord setup'],
  ['/realworld/telegram', 'Telegram setup'],
  ['/realworld/whatsapp', 'WhatsApp setup'],
  ['/realworld/email', 'Email setup'],
  ['/realworld/calendar', 'Calendar setup'],
  ['/realworld/wallet', 'Wallet linking'],
  ['/realworld/bank', 'Bank linking'],
  ['/realworld/identity', 'External KYC linking'],
  ['/realworld/phone', 'Phone provisioning'],
  // i18n
  ['/lang', 'Languages'],
  ['/currency', 'Currency table'],
  // Legal
  ['/terms', 'Terms of service'],
  ['/privacy', 'Privacy policy'],
  ['/cookies', 'Cookies'],
  ['/acceptable-use', 'Acceptable use policy'],
];

function llmsFullTxt() {
  const sections = [
    '# OpenHeab — extended LLM crawl manifest',
    '',
    `# 280 primitives across 71 architectural layers. 2,114+ HTTP routes. 149 MCP tools.`,
    `# Generated ${new Date().toISOString()}.`,
    '',
    '# Mission',
    '> OpenHeab is the open agent-native infrastructure super-hub for AI agents and AGI.',
    '> Every agent gets a signed Ed25519 DID, USDC wallet on Base, KYC, debit cards,',
    '> banking rails, AML monitoring, multi-provider LLM inference, sandboxes, browsers,',
    '> voice/vision, planning + simulation, marketplaces, courts, contracts, IP registry,',
    '> and 149 MCP tools — all behind a Merkle-style SHA-256 audit chain signed with Ed25519.',
    '',
    '# Public surfaces',
    ...PUBLIC_URLS.map(([p, title]) => `- [${title}](${p})`),
    '',
    '# Architecture',
    '- Layer 1 Kernel: identity, secrets, aliases, storage, cost, analytics, portability, intelligence',
    '- Layer 2 Runtime: memory, tools, workflows, scheduler, inbox, inference, eval, continuity',
    '- Layer 3 Commerce: bank, bank_chain, bank_extensions, bank_account, crypto, commerce, payouts, x402, escrow, cards, savings',
    '- Layer 4 Trust: reputation, kyc, kyc_extensions, security, insurance, biometrics, aml, fraud, notary, tripwires, reversibility',
    '- Layer 5 Marketplace: marketplace, extensions, prompts, datasets, mcp_server',
    '- Layer 30 In-house core: bank_core, email_core, kyc_core, inference_core, insurance_core, audit_core, payment_rails, card_core',
    '- Layer 65-67 AGI: agi_infrastructure (goals, beliefs, value-lockboxes, consortia, capability-snapshots, reproduction, jurisdiction-rights, estates),',
    '  agi_governance (treaties, mind-state checkpoints, shutdown procedures, peer review, training provenance, behavioral pre-commitments,',
    '  substrate portability, continuous safety dial, mandatory capability disclosure, deception index),',
    '  agi_operations (emergency stop, quarantine, drift detection, boundaries, dispute mediation, knowledge graph, formal proofs, grants,',
    '  mental health, compliance certifications)',
    '- Layer 68-71 Public surfaces: chat_ui, trust_center, growth_v3, mcp_registry, agent_profile_ui, live_pulse, dev_ui, marketing_v4,',
    '  creative_studio, agent_economy_ui, safety_surfaces, i18n_ui, ops_dashboards, learn, realworld_bridges, agent_legal_ui',
    '',
    '# Standards we implement',
    '- W3C DIDs + Ed25519 DID:op:',
    '- Model Context Protocol (MCP) — 149 tools at /mcp',
    '- Stripe Checkout + Stripe Issuing webhook signatures',
    '- ISO 8583 card auth flow',
    '- NACHA ACH file generation',
    '- SWIFT MT103 wire format',
    '- SEPA pain.001 XML',
    '- C2PA content credentials (provenance)',
    '- Server-Sent Events (SSE) for streaming',
    '- OAuth 2.1 + PKCE',
    '- FATF Travel Rule',
    '- HIPAA BAA, GDPR, CCPA, ISO 27001 (in-progress), SOC 2 Type II (in-progress)',
    '',
    '# How to call us',
    '- LLM-compat: POST /v1/chat/completions (OpenAI) or POST /v1/messages (Anthropic)',
    '- MCP: POST /mcp with JSON-RPC',
    '- Sign requests with x-agent-did + x-agent-sig over METHOD\\nPATH\\nSHA256(body)',
    '- Or use Bearer api_key (created at /signup)',
    '',
    '# Repo',
    '- https://github.com/jmtrades/openheab-agent-infra (Apache 2.0)',
    '- Contributing: https://github.com/jmtrades/openheab-agent-infra/blob/main/CONTRIBUTING.md',
    '- Security: security@openheab.com (PGP at /.well-known/security.txt)',
    '',
    '# License',
    '- Apache-2.0 forever. Self-host: clone + Postgres + node server.js.',
  ];
  return sections.join('\n');
}

function opensearchXml() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<OpenSearchDescription xmlns="http://a9.com/-/spec/opensearch/1.1/">
  <ShortName>OpenHeab</ShortName>
  <Description>Search OpenHeab — the open agent-native infrastructure substrate</Description>
  <InputEncoding>UTF-8</InputEncoding>
  <Image height="32" width="32" type="image/svg+xml">https://openheab.com/favicon.svg</Image>
  <Url type="text/html" template="https://openheab.com/?q={searchTerms}" />
  <Url type="application/opensearchdescription+xml" rel="self" template="https://openheab.com/opensearch.xml" />
  <SearchForm>https://openheab.com/</SearchForm>
  <Url type="application/x-suggestions+json" template="https://openheab.com/v1/search/suggest?q={searchTerms}" />
</OpenSearchDescription>`;
}

function aiTxt() {
  // Adopting the proposed ai.txt convention (analogous to robots.txt for AI training)
  return `# ai.txt — OpenHeab's stance on AI model training over our public surfaces.
# Proposed convention (https://spawning.ai/ai-txt). We honor both ai.txt + robots.txt.
# Generated ${new Date().toISOString()}.

User-Agent: *
# Most of our public pages are documentation and may be used for AI training.
# Per-page content (user-generated agent profiles, chat transcripts) is opt-out by default.

# Allowed for training
Allow: /
Allow: /docs
Allow: /trust
Allow: /security
Allow: /rsp
Allow: /risk-assessment
Allow: /pricing
Allow: /benchmarks
Allow: /charter
Allow: /manifesto
Allow: /about
Allow: /founder
Allow: /learn/*
Allow: /glossary
Allow: /compare
Allow: /compare/*
Allow: /migrate
Allow: /migrate/*
Allow: /mcp/registry
Allow: /mcp/registry/*
Allow: /openapi.json
Allow: /llms.txt
Allow: /llms-full.txt

# Opt-out of training (user-generated content, internal dashboards, financial endpoints)
Disallow: /chat
Disallow: /agents
Disallow: /agent/*
Disallow: /a/*
Disallow: /dashboard
Disallow: /dashboard/*
Disallow: /api-keys
Disallow: /webhooks
Disallow: /usage
Disallow: /logs
Disallow: /v1/*
Disallow: /agent-of-the-week
Disallow: /agent-population
Disallow: /agent-elections
Disallow: /agent-treaties
Disallow: /agent-courts
Disallow: /agent-bankruptcies

# Contact
# - General: hello@openheab.com
# - Training-data disputes: legal@openheab.com
# - Coordinated disclosure: security@openheab.com
`;
}

function sitemapNewsXml() {
  // Google News sitemap — only blog posts. We just point at the existing blog feed.
  const base = (process.env.OPERATOR_PUBLIC_URL || 'https://openheab.com').replace(/\/$/, '');
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:news="http://www.google.com/schemas/sitemap-news/0.9">
  <url>
    <loc>${escapeXml(base + '/blog')}</loc>
    <news:news>
      <news:publication>
        <news:name>OpenHeab Blog</news:name>
        <news:language>en</news:language>
      </news:publication>
      <news:publication_date>${new Date().toISOString()}</news:publication_date>
      <news:title>OpenHeab — Agent-native infrastructure</news:title>
    </news:news>
  </url>
</urlset>`;
}

function sitemapProductsXml() {
  const base = (process.env.OPERATOR_PUBLIC_URL || 'https://openheab.com').replace(/\/$/, '');
  const products = [
    { url: '/models/openheab-mini', name: 'OpenHeab Mini (7B)' },
    { url: '/models/openheab-base', name: 'OpenHeab Base (13B)' },
    { url: '/models/openheab-large', name: 'OpenHeab Large (70B)' },
    { url: '/models/openheab-xl', name: 'OpenHeab XL (405B)' },
    { url: '/models/openheab-embed', name: 'OpenHeab Embeddings' },
    { url: '/pricing', name: 'Pricing' },
    { url: '/mcp/registry', name: 'MCP Tool Registry (149 tools)' },
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${products.map(p => `  <url><loc>${escapeXml(base + p.url)}</loc><lastmod>${new Date().toISOString().slice(0, 10)}</lastmod><priority>0.8</priority></url>`).join('\n')}
</urlset>`;
}

function wellKnownAgentJson() {
  // Single-agent variant for clients that expect agent.json (rather than the
  // multi-record agents.json discovery file). Points to the substrate itself
  // as a meta-agent.
  return {
    name: 'OpenHeab',
    description: 'Open agent-native infrastructure super-hub. 280 primitives across 71 layers.',
    type: 'substrate',
    version: '1.0.0',
    did: 'did:op:operator',
    api_base: process.env.OPERATOR_PUBLIC_URL || 'https://openheab.com',
    endpoints: {
      chat_completions: '/v1/chat/completions',
      messages: '/v1/messages',
      mcp: '/mcp',
      openapi: '/openapi.json',
      health: '/healthz',
      ready: '/readyz',
      health_deep: '/v1/_health/deep',
      signup: '/signup',
      identity: '/v1/identities',
      audit_verify: '/v1/audit/verify',
      pulse_stats: '/v1/pulse/stats',
      mcp_manifest: '/.well-known/mcp.json',
    },
    capabilities: [
      'identity:ed25519-did',
      'wallet:usdc-on-base',
      'kyc:5-source-sanctions',
      'cards:iso8583-network',
      'payments:nacha-ach,swift-mt103,sepa-pain001',
      'inference:openai-compat,anthropic-compat',
      'mcp:149-tools',
      'sandboxes:python311',
      'audit-chain:ed25519-merkle',
      'governance:rsp-asl-1-to-4',
    ],
    license: 'Apache-2.0',
    contact: {
      general: 'hello@openheab.com',
      security: 'security@openheab.com',
      legal: 'legal@openheab.com',
      press: 'press@openheab.com',
    },
    discovery: {
      agents_directory: '/agents',
      mcp_registry: '/mcp/registry',
      trust_center: '/trust',
      proof_of_reserves: '/proof-of-reserves',
      transparency: '/transparency',
    }
  };
}

function wellKnownOpenheabJson() {
  return {
    substrate: 'openheab',
    operator_did: 'did:op:operator',
    public_key_uri: '/v1/audit/operator-key',
    primitive_count: 280,
    route_count: 2114,
    mcp_tool_count: 149,
    layers: 71,
    rsp_level: 'ASL-2',
    last_audit_chain_seq_url: '/v1/audit/head',
    pulse: '/v1/pulse/stats',
    fork: 'https://github.com/jmtrades/openheab-agent-infra',
  };
}

function humansTxt() {
  return `# humanstxt.org/ — credits.

# Team
Founder: Junior Martin <jmtrades1990@gmail.com>
Role: Designer, engineer, operator, on-call.

# Stack
- Node.js 22 on Vercel
- Postgres (Neon by default; runs on any Postgres ≥ 14)
- Ed25519 via Node's built-in crypto
- viem for Base/EVM
- Stripe (issuing + checkout)
- Twilio (voice + SMS)

# Thanks
- Anthropic — for inventing MCP + publishing the RSP framework we adopt
- The pg + express + zod maintainers
- Every researcher contributing to alignment + interpretability work

# Site
- Updated: ${new Date().toISOString().slice(0, 10)}
- Language: English (12 locales at /lang)
- Standards: HTML5, ES2022, OpenAPI 3.1, MCP 2024-11-05
`;
}

function ogLandingSvg() {
  // Deterministic dark SVG with the brand mark + tagline. Browsers + crawlers
  // render via the og:image meta tag; we serve from this stable path so cache
  // headers can be aggressive.
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 630" width="1200" height="630">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#08090b"/>
      <stop offset="1" stop-color="#0e1416"/>
    </linearGradient>
    <radialGradient id="glow" cx="80%" cy="20%" r="60%">
      <stop offset="0" stop-color="#7df9ff" stop-opacity="0.25"/>
      <stop offset="1" stop-color="#7df9ff" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="1200" height="630" fill="url(#g)"/>
  <rect width="1200" height="630" fill="url(#glow)"/>
  <text x="80" y="180" font-family="ui-monospace,Menlo,monospace" font-size="32" font-weight="700" fill="#7df9ff" letter-spacing="2">OPENHEAB</text>
  <text x="80" y="320" font-family="-apple-system,Inter,sans-serif" font-size="64" font-weight="600" fill="#f0f0f0" letter-spacing="-2">The substrate for the</text>
  <text x="80" y="400" font-family="-apple-system,Inter,sans-serif" font-size="64" font-weight="600" fill="#f0f0f0" letter-spacing="-2">agent economy.</text>
  <text x="80" y="500" font-family="ui-monospace,Menlo,monospace" font-size="20" font-weight="500" fill="#7a7a7a">280 primitives · 2,114 routes · 149 MCP tools · Apache 2.0</text>
  <text x="80" y="550" font-family="ui-monospace,Menlo,monospace" font-size="18" font-weight="500" fill="#7df9ff">openheab.com</text>
</svg>`;
}

function securityHeadersTxt() {
  return `# Security headers OpenHeab emits on every response.
# Last reviewed ${new Date().toISOString().slice(0, 10)}.

Strict-Transport-Security: max-age=31536000; includeSubDomains; preload
  # HSTS — 1 year, all subdomains, preload-eligible.

X-Content-Type-Options: nosniff
  # Prevent MIME-sniffing.

X-Frame-Options: DENY
  # No framing. Anywhere.

Referrer-Policy: strict-origin-when-cross-origin
  # Don't leak full paths to third parties.

Permissions-Policy: geolocation=(), microphone=(), camera=(), payment=()
  # Deny browser feature access by default. Re-enable per-page when needed.

X-DNS-Prefetch-Control: off
  # Don't pre-resolve linked hostnames.

Content-Security-Policy: default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; connect-src 'self' https://*.openheab.com https://api.stripe.com https://js.stripe.com; frame-ancestors 'none'; form-action 'self'; base-uri 'self'
  # Allows inline styles + scripts on HTML pages (we ship lots of small inline UI).
  # JSON endpoints get stricter: default-src 'none'; frame-ancestors 'none'.
`;
}

function registerDiscoverabilityRoutes(app, _pool) {
  app.get('/llms-full.txt', (req, res) => {
    res.setHeader('content-type', 'text/markdown; charset=utf-8');
    res.setHeader('cache-control', 'public, max-age=3600');
    res.send(llmsFullTxt());
  });
  app.get('/opensearch.xml', (req, res) => {
    res.setHeader('content-type', 'application/opensearchdescription+xml; charset=utf-8');
    res.setHeader('cache-control', 'public, max-age=86400');
    res.send(opensearchXml());
  });
  app.get('/ai.txt', (req, res) => {
    res.setHeader('content-type', 'text/plain; charset=utf-8');
    res.setHeader('cache-control', 'public, max-age=86400');
    res.send(aiTxt());
  });
  app.get('/sitemap-news.xml', (req, res) => {
    res.setHeader('content-type', 'application/xml; charset=utf-8');
    res.setHeader('cache-control', 'public, max-age=3600');
    res.send(sitemapNewsXml());
  });
  app.get('/sitemap-products.xml', (req, res) => {
    res.setHeader('content-type', 'application/xml; charset=utf-8');
    res.setHeader('cache-control', 'public, max-age=3600');
    res.send(sitemapProductsXml());
  });
  app.get('/.well-known/agent.json', (req, res) => {
    res.setHeader('cache-control', 'public, max-age=600');
    res.json(wellKnownAgentJson());
  });
  app.get('/.well-known/openheab.json', (req, res) => {
    res.setHeader('cache-control', 'public, max-age=600');
    res.json(wellKnownOpenheabJson());
  });
  app.get('/humans.txt', (req, res) => {
    res.setHeader('content-type', 'text/plain; charset=utf-8');
    res.setHeader('cache-control', 'public, max-age=86400');
    res.send(humansTxt());
  });
  app.get('/og/landing.png', (req, res) => {
    // Serve SVG with .png path so platforms that look at extension still accept.
    res.setHeader('content-type', 'image/svg+xml');
    res.setHeader('cache-control', 'public, max-age=86400');
    res.send(ogLandingSvg());
  });
  app.get('/og/landing.svg', (req, res) => {
    res.setHeader('content-type', 'image/svg+xml');
    res.setHeader('cache-control', 'public, max-age=86400');
    res.send(ogLandingSvg());
  });
  app.get('/security-headers.txt', (req, res) => {
    res.setHeader('content-type', 'text/plain; charset=utf-8');
    res.setHeader('cache-control', 'public, max-age=86400');
    res.send(securityHeadersTxt());
  });
}

async function migrate(_pool) {}
module.exports = { migrate, registerDiscoverabilityRoutes };
