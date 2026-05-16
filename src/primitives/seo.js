// ============================================================================
// seo.js — central SEO surface: comprehensive sitemap, robots.txt with full
// directives, security.txt (RFC 9116), humans.txt, llms-full.txt, web manifest,
// favicon, apple-touch-icon, OG image generator, JSON-LD helpers,
// hreflang map. The SEO control plane.
// ============================================================================
const crypto = require('crypto');

function pubUrl() {
  return (process.env.OPERATOR_PUBLIC_URL || 'https://openheab.com').replace(/\/$/, '');
}

async function migrate(_pool) {
  // No tables. SEO is pure config + dynamic generation from other primitives.
}

function escapeXml(s) {
  return String(s == null ? '' : s).replace(/[<>&'"]/g, c => ({ '<':'&lt;','>':'&gt;','&':'&amp;',"'":'&apos;','"':'&quot;' }[c]));
}

// JSON-LD helpers — importable by other primitives that render HTML pages
function organizationJsonLd() {
  return JSON.stringify({
    '@context': 'https://schema.org', '@type': 'Organization',
    name: 'OpenHeab', url: pubUrl(),
    logo: pubUrl() + '/favicon.svg',
    description: 'The agent-native infrastructure substrate. 156 primitives for AI agents and AGI.',
    sameAs: ['https://github.com/jmtrades/openheab-agent-infra']
  });
}
function softwareApplicationJsonLd(prims, routes) {
  return JSON.stringify({
    '@context': 'https://schema.org', '@type': 'SoftwareApplication',
    name: 'OpenHeab', applicationCategory: 'DeveloperApplication',
    operatingSystem: 'Cross-platform', url: pubUrl(),
    offers: [
      { '@type': 'Offer', name: 'Free', price: '0', priceCurrency: 'USD' },
      { '@type': 'Offer', name: 'Pro', price: '99', priceCurrency: 'USD' },
      { '@type': 'Offer', name: 'Scale', price: '349', priceCurrency: 'USD' },
      { '@type': 'Offer', name: 'Enterprise', price: '2499', priceCurrency: 'USD' }
    ],
    description: `${prims} primitives across 25 layers. ${routes} HTTP routes. Identity, USDC bank, KYC, marketplaces, cognition, real-time event stream — all under one open-source substrate.`
  });
}
function faqJsonLd() {
  const faqs = [
    ['What is OpenHeab?', 'OpenHeab is the open agent-native infrastructure substrate — 156 primitives across 25 layers covering identity, USDC bank, KYC, marketplaces, cognition, real-time events, and everything else AI agents and AGI need to act on the internet.'],
    ['Is OpenHeab open source?', 'Yes. Apache-2.0. Self-hostable on Vercel + Neon for free. Hosted plans from $0/mo (Free) to $2,499/mo (Enterprise).'],
    ['How do I get started?', 'Run `curl -X POST https://openheab.com/v1/identities -H "content-type: application/json" -d \'{"display_name":"my-agent"}\'`. You get a DID, Ed25519 keypair, API key, and USDC wallet on Base in one call.'],
    ['Does OpenHeab work with Claude / OpenAI / Cursor / VS Code?', 'Yes. We expose 150+ tools as an MCP server at /mcp. Any agent that speaks MCP can use the full substrate.'],
    ['What are your take rates?', '1% on USDC transfers (FeeSplitter), 2% card interchange (Stripe Issuing), 30% marketplace cut, 10% inference markup, 0.5% A2H fiat payouts.'],
    ['Are you SOC 2 compliant?', 'SOC 2 Type II in progress. Continuous evidence collection via the compliance_pack primitive covers SOC 2 / GDPR / HIPAA / PCI / ISO 27001 / FedRAMP Moderate.'],
    ['What about AGI?', 'OpenHeab is designed to be the infrastructure AGI runs on. See AGI_STRATEGY.md for the full plan.'],
    ['How is OpenHeab different from Composio / Skyfire / Browserbase?', 'Each of those does one slice well. OpenHeab bundles all 156 primitives into one substrate so agents do not need 12-vendor integration.']
  ];
  return JSON.stringify({
    '@context': 'https://schema.org', '@type': 'FAQPage',
    mainEntity: faqs.map(([q, a]) => ({
      '@type': 'Question', name: q,
      acceptedAnswer: { '@type': 'Answer', text: a }
    }))
  });
}
function breadcrumbJsonLd(items) {
  return JSON.stringify({
    '@context': 'https://schema.org', '@type': 'BreadcrumbList',
    itemListElement: items.map((it, i) => ({
      '@type': 'ListItem', position: i + 1,
      name: it.name, item: it.url || (pubUrl() + it.path)
    }))
  });
}
function searchActionJsonLd() {
  return JSON.stringify({
    '@context': 'https://schema.org', '@type': 'WebSite',
    url: pubUrl(),
    potentialAction: {
      '@type': 'SearchAction',
      target: { '@type': 'EntryPoint', urlTemplate: pubUrl() + '/directory/search?q={search_term_string}' },
      'query-input': 'required name=search_term_string'
    }
  });
}
function productJsonLd(name, price_cents, description) {
  return JSON.stringify({
    '@context': 'https://schema.org', '@type': 'Product',
    name, description,
    brand: { '@type': 'Organization', name: 'OpenHeab' },
    offers: {
      '@type': 'Offer',
      priceCurrency: 'USD',
      price: (price_cents / 100).toFixed(2),
      availability: 'https://schema.org/InStock',
      url: pubUrl() + '/pricing'
    }
  });
}

function registerSeoRoutes(app, _pool) {
  // /sitemap.xml — comprehensive index
  app.get('/sitemap.xml', async (req, res) => {
    const base = pubUrl();
    res.setHeader('content-type', 'application/xml');
    res.send(`<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>${base}/sitemap-pages.xml</loc></sitemap>
  <sitemap><loc>${base}/sitemap-blog.xml</loc></sitemap>
  <sitemap><loc>${base}/sitemap-docs.xml</loc></sitemap>
  <sitemap><loc>${base}/sitemap-listings.xml</loc></sitemap>
  <sitemap><loc>${base}/sitemap-compare.xml</loc></sitemap>
  <sitemap><loc>${base}/sitemap-solutions.xml</loc></sitemap>
</sitemapindex>`);
  });

  app.get('/sitemap-pages.xml', (req, res) => {
    const base = pubUrl();
    const pages = ['/', '/pricing', '/docs', '/blog', '/customers', '/about',
                    '/jobs', '/press', '/security', '/status', '/changelog', '/roadmap',
                    '/console'];
    res.setHeader('content-type', 'application/xml');
    res.send(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${pages.map(p => `  <url><loc>${base}${p}</loc><changefreq>weekly</changefreq><priority>${p==='/'?'1.0':'0.8'}</priority></url>`).join('\n')}
</urlset>`);
  });

  app.get('/sitemap-blog.xml', async (req, res) => {
    const r = await _pool.query(`SELECT slug, updated_at FROM blog_posts WHERE status='published' ORDER BY published_at DESC LIMIT 5000`)
      .catch(() => ({ rows: [] }));
    const base = pubUrl();
    res.setHeader('content-type', 'application/xml');
    res.send(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${r.rows.map(x => `  <url><loc>${base}/blog/${escapeXml(x.slug)}</loc><lastmod>${new Date(x.updated_at).toISOString().slice(0,10)}</lastmod></url>`).join('\n')}
</urlset>`);
  });

  app.get('/sitemap-docs.xml', (req, res) => {
    const base = pubUrl();
    res.setHeader('content-type', 'application/xml');
    res.send(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${base}/docs</loc></url>
  <url><loc>${base}/docs#quickstart</loc></url>
  <url><loc>${base}/openapi.json</loc></url>
  <url><loc>${base}/mcp/manifest</loc></url>
</urlset>`);
  });

  app.get('/sitemap-listings.xml', async (req, res) => {
    const r = await _pool.query(`SELECT slug, updated_at FROM directory_listings WHERE status='published' ORDER BY updated_at DESC LIMIT 50000`)
      .catch(() => ({ rows: [] }));
    const base = pubUrl();
    res.setHeader('content-type', 'application/xml');
    res.send(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${r.rows.map(x => `  <url><loc>${base}/v1/directory/listings/${escapeXml(x.slug)}</loc><lastmod>${new Date(x.updated_at).toISOString().slice(0,10)}</lastmod></url>`).join('\n')}
</urlset>`);
  });

  app.get('/sitemap-compare.xml', (req, res) => {
    const base = pubUrl();
    const slugs = ['composio', 'skyfire', 'browserbase', 'modal', 'langchain-cloud'];
    res.setHeader('content-type', 'application/xml');
    res.send(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${slugs.map(s => `  <url><loc>${base}/compare/${s}</loc></url>`).join('\n')}
</urlset>`);
  });

  app.get('/sitemap-solutions.xml', (req, res) => {
    const base = pubUrl();
    const slugs = ['fintech', 'compliance', 'sales', 'devops', 'ecommerce', 'media', 'research', 'government'];
    res.setHeader('content-type', 'application/xml');
    res.send(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${slugs.map(s => `  <url><loc>${base}/solutions/${s}</loc></url>`).join('\n')}
</urlset>`);
  });

  // /robots.txt — comprehensive
  app.get('/robots.txt', (req, res) => {
    const base = pubUrl();
    res.setHeader('content-type', 'text/plain');
    res.send(`# OpenHeab — agent-native infrastructure substrate.
# Apache-2.0 · 156 primitives · 1230+ routes
User-agent: *
Allow: /
Disallow: /v1/_webhooks/
Disallow: /v1/_jobs/
Disallow: /v1/admin/
Disallow: /v1/agents/
Disallow: /v1/orgs/
Allow: /v1/directory/
Allow: /v1/extensions
Allow: /v1/skills

Sitemap: ${base}/sitemap.xml
`);
  });

  // /.well-known/security.txt — RFC 9116
  app.get('/.well-known/security.txt', (req, res) => {
    const exp = new Date(Date.now() + 365 * 86400000).toISOString();
    res.setHeader('content-type', 'text/plain');
    res.send(`Contact: mailto:security@openheab.com
Expires: ${exp}
Encryption: ${pubUrl()}/.well-known/openheab-pgp.asc
Acknowledgments: ${pubUrl()}/security#acknowledgments
Preferred-Languages: en
Canonical: ${pubUrl()}/.well-known/security.txt
Policy: ${pubUrl()}/security
`);
  });

  // /humans.txt
  app.get('/humans.txt', (req, res) => {
    res.setHeader('content-type', 'text/plain');
    res.send(`/* TEAM */
Founder: Junior Martin
Contact: hello [at] openheab.com
GitHub: github.com/jmtrades/openheab-agent-infra

/* SITE */
Last updated: ${new Date().toISOString().slice(0, 10)}
Standards: HTML5, ES2022, JSON-LD
Components: Express + Postgres (Neon) + Vercel + Stripe + Base
Build: zero — pure CommonJS, no transpilation
`);
  });

  // /llms.txt — minimal LLM-friendly summary
  app.get('/llms.txt', (req, res) => {
    res.setHeader('content-type', 'text/plain');
    res.send(`# OpenHeab — agent-native infrastructure substrate

Open-source (Apache-2.0) substrate for AI agents and AGI. 156 primitives across 25 layers.
Identity (Ed25519 DID), USDC bank on Base, virtual+physical debit cards, savings, lending,
KYC against 5 sanctions sources, marketplaces, cognition, real-time event stream.

API base: ${pubUrl()}
Quickstart: POST ${pubUrl()}/v1/identities to create an agent + USDC wallet.
MCP: ${pubUrl()}/mcp (150+ tools)
OpenAPI: ${pubUrl()}/openapi.json
Docs: ${pubUrl()}/docs
Pricing: ${pubUrl()}/pricing
Source: github.com/jmtrades/openheab-agent-infra
Strategy docs: BILLION_DOLLAR_PATH.md, REVENUE_NOW.md, AGI_STRATEGY.md, WHAT_WE_NEED_TO_WIN.md
`);
  });

  // /llms-full.txt — extended LLM-friendly summary
  app.get('/llms-full.txt', async (req, res) => {
    let prims = 156;
    try { prims = Object.keys(require('./../integration').primitives).length; } catch {}
    res.setHeader('content-type', 'text/plain');
    res.send(`# OpenHeab — full LLM context

> The open agent-native infrastructure substrate. ${prims} primitives across 25 layers.
> Apache-2.0. Self-hostable. Production at ${pubUrl()}.

## Layer 1 — Kernel
identity, secrets, aliases, storage, cost, analytics, portability, intelligence

## Layer 2 — Runtime
memory, tools, workflows, scheduler, inbox, inference, eval, continuity

## Layer 3 — Commerce
bank, bank_chain, bank_extensions, bank_account, crypto, commerce, payouts, x402, escrow, cards, savings

## Layer 4 — Trust
reputation, kyc, kyc_extensions, kyc_advanced, security, insurance, biometrics, aml, fraud, notary, tripwires, reversibility

## Layer 5 — Marketplace
marketplace, extensions, prompts, datasets, mcp_server

## Layer 6 — Operations
governance, publishing, email, email_advanced, phone, deployment, oauth_bridge, entities, tax

## Layer 7-19
perception (sandbox/browser/voice/vision/video/search), knowledge, web3 finance, infra, AGI cognition,
AGI ops, org/business, business essentials, domain, revenue commerce, dev infra, AGI learning + gov/legal,
customer service + community

## Layer 20-25
org, subscriptions, metering, revenue, sso, rbac, compliance_pack, credits, onboarding, dashboard,
embed, public_directory, partnerships, whitelabel, ach, quotes, realtime, blog, marketing, seo

## Endpoints
- POST /v1/identities — create agent + USDC wallet
- GET /v1/agents/:did/bank — unified balance sheet
- POST /v1/agents/:did/wallet/transfer — USDC transfer (1% fee via FeeSplitter)
- GET /v1/realtime/stream — Server-Sent Events of every audit event
- GET /v1/directory/search — public agent + extension directory
- POST /v1/orgs — create multi-agent organization
- POST /v1/orgs/:id/subscription — Stripe-billed subscription (Free/Pro/Scale/Enterprise)
- GET /openapi.json — full OpenAPI 3.1 spec
- POST /mcp — JSON-RPC 2.0 (150+ tools)
- GET /mcp/manifest — MCP discovery doc

## Pricing
Free $0 · Pro $99 · Scale $349 · Enterprise $2,499+/mo
Plus take rates: 1% USDC, 2% card interchange, 30% marketplace, 10% inference, 0.5% A2H payouts

## Strategy docs
- BILLION_DOLLAR_PATH.md — 7-year arc to $1B+ ARR
- REVENUE_NOW.md — 90 days to $10M ARR
- AGI_STRATEGY.md — how to capitalize when AGI arrives
- WHAT_WE_NEED_TO_WIN.md — brutal $10B+ gap list

## Open standards
- did:op:... — DID method (ratification at W3C planned)
- Audit chain: SHA-256 Merkle + Ed25519 signatures + Bitcoin OP_RETURN anchoring
- MCP server at /mcp (Anthropic's Model Context Protocol)
`);
  });

  // /.well-known/agents.json — agent-native discovery doc
  app.get('/.well-known/agents.json', (req, res) => {
    res.setHeader('content-type', 'application/json');
    res.json({
      version: '0.1.0',
      provider: { name: 'OpenHeab', url: pubUrl() },
      identity_endpoint: pubUrl() + '/v1/identities',
      mcp_endpoint: pubUrl() + '/mcp',
      did_method: 'did:op',
      capabilities: ['identity', 'wallet', 'kyc', 'bank', 'cards', 'savings', 'lending',
                      'inference', 'sandbox', 'browser', 'memory', 'inbox', 'audit_chain',
                      'marketplace', 'realtime'],
      docs: pubUrl() + '/docs',
      openapi: pubUrl() + '/openapi.json'
    });
  });

  // /site.webmanifest — PWA support
  app.get('/site.webmanifest', (req, res) => {
    res.setHeader('content-type', 'application/manifest+json');
    res.json({
      name: 'OpenHeab', short_name: 'OpenHeab',
      description: 'Agent-native infrastructure substrate.',
      start_url: '/', display: 'standalone',
      background_color: '#0a0a0a', theme_color: '#0a0a0a',
      icons: [
        { src: '/favicon.svg', sizes: 'any', type: 'image/svg+xml' },
        { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: '/icon-512.png', sizes: '512x512', type: 'image/png' }
      ]
    });
  });

  // /favicon.svg — minimal SVG (no need for raster favicon binaries)
  app.get('/favicon.svg', (req, res) => {
    res.setHeader('content-type', 'image/svg+xml');
    res.setHeader('cache-control', 'public, max-age=31536000');
    res.send(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" fill="#0a0a0a"/><circle cx="16" cy="16" r="6" fill="#7df9ff"/><circle cx="16" cy="16" r="3" fill="#0a0a0a"/></svg>`);
  });

  app.get('/favicon.ico', (req, res) => res.redirect(301, '/favicon.svg'));
  app.get('/apple-touch-icon.png', (req, res) => res.redirect(301, '/favicon.svg'));

  // /og.svg — Open Graph preview SVG (1200x630)
  app.get('/og.svg', (req, res) => {
    res.setHeader('content-type', 'image/svg+xml');
    res.setHeader('cache-control', 'public, max-age=86400');
    res.send(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 630">
<rect width="1200" height="630" fill="#0a0a0a"/>
<text x="60" y="120" fill="#7df9ff" font-family="ui-monospace,monospace" font-size="32" font-weight="700">openheab.</text>
<text x="60" y="280" fill="#f0f0f0" font-family="-apple-system,sans-serif" font-size="72" font-weight="700" letter-spacing="-3">Agent-native</text>
<text x="60" y="370" fill="#f0f0f0" font-family="-apple-system,sans-serif" font-size="72" font-weight="700" letter-spacing="-3">infrastructure.</text>
<text x="60" y="500" fill="#7a7a7a" font-family="-apple-system,sans-serif" font-size="32">156 primitives · 1230 routes · 25 layers · Apache-2.0</text>
<text x="60" y="560" fill="#7df9ff" font-family="ui-monospace,monospace" font-size="22">github.com/jmtrades/openheab-agent-infra</text>
</svg>`);
  });

  // /healthz — liveness probe
  app.get('/healthz', (req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

  // /readyz — readiness probe (checks DB)
  app.get('/readyz', async (req, res) => {
    try {
      await _pool.query('SELECT 1');
      res.json({ ok: true, db: 'ready' });
    } catch (e) {
      res.status(503).json({ ok: false, error: e.message });
    }
  });

  // /ads.txt — empty (we don't use ad networks)
  app.get('/ads.txt', (req, res) => {
    res.setHeader('content-type', 'text/plain');
    res.send('# We do not use ad networks. See https://openheab.com/about\n');
  });

  // /.well-known/openheab-pgp.asc — placeholder
  app.get('/.well-known/openheab-pgp.asc', (req, res) => {
    res.setHeader('content-type', 'application/pgp-keys');
    res.send('-----BEGIN PGP PUBLIC KEY BLOCK-----\n# Public security PGP key placeholder. Email security@openheab.com for current key.\n-----END PGP PUBLIC KEY BLOCK-----\n');
  });
}

module.exports = {
  migrate, registerSeoRoutes,
  organizationJsonLd, softwareApplicationJsonLd, faqJsonLd, breadcrumbJsonLd,
  searchActionJsonLd, productJsonLd, escapeXml, pubUrl
};
