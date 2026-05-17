// ============================================================================
// marketing.js — marketing campaigns + lead magnets + UTM attribution +
// conversion tracking + comparison/solution/customer marketing pages.
//
// This is the marketing engine. Lead capture forms, lead magnet downloads
// (PDFs, calculators, templates), UTM tracking on every conversion, A/B
// testing for CTAs (integrates with experiments.js), email drip sequences.
// ============================================================================
const crypto = require('crypto');
const { z } = require('zod');
const { registerCron } = require('../cron_auth');

const SEED_LEAD_MAGNETS = [
  { slug: 'agi-strategy-pdf',     name: 'AGI Strategy: how to capitalize on AGI when it arrives', kind: 'pdf', source_url: '/AGI_STRATEGY.md' },
  { slug: 'billion-dollar-path-pdf', name: 'BILLION_DOLLAR_PATH: 7-year arc to $1B+ ARR', kind: 'pdf', source_url: '/BILLION_DOLLAR_PATH.md' },
  { slug: 'revenue-now-pdf',       name: 'REVENUE_NOW: the 90-day plan to $10M ARR', kind: 'pdf', source_url: '/REVENUE_NOW.md' },
  { slug: 'gap-checklist-pdf',     name: 'WHAT_WE_NEED_TO_WIN: the brutal $10B gap checklist', kind: 'pdf', source_url: '/WHAT_WE_NEED_TO_WIN.md' },
  { slug: 'inference-cost-calculator', name: 'Inference cost calculator', kind: 'calculator', source_url: '/tools/inference-calc' },
  { slug: 'roi-calculator',        name: 'OpenHeab ROI calculator', kind: 'calculator', source_url: '/tools/roi-calc' }
];

const COMPARE_PAGES = [
  ['composio',    'Composio',    'Composio is great for action wrappers (Stripe, GitHub, Notion). OpenHeab covers actions plus identity, USDC bank, KYC, audit chain, marketplace, and 150+ other primitives — all under one DID, one billing, one audit chain.'],
  ['skyfire',     'Skyfire',     'Skyfire ships agent payments. OpenHeab ships agent payments PLUS savings, lending, ACH, wire, SEPA, cards, escrow, brokerage — and the identity + KYC + compliance scaffolding agents need to actually move money compliantly.'],
  ['browserbase', 'Browserbase', 'Browserbase ships managed headless browsers. OpenHeab includes browsers as one primitive among 156 — alongside identity, money, memory, marketplaces, and the rest of the stack agents need.'],
  ['modal',       'Modal',       'Modal is the best place to run GPU workloads. OpenHeab routes compute to Modal (and E2B, Coreweave, etc.) at a 15% markup, plus everything around the compute layer that agents need.'],
  ['langchain-cloud', 'LangChain Cloud', 'LangChain Cloud focuses on agent observability + deployment. OpenHeab is orthogonal — we route to whatever framework you use (LangChain, LlamaIndex, AutoGen, CrewAI, Letta) and provide the substrate underneath.']
];

const SOLUTIONS_PAGES = [
  ['fintech',         'Fintech',         'KYC + sanctions + Travel Rule + cards + ACH + wire + savings + lending — everything a fintech agent needs to move money compliantly.'],
  ['compliance',      'Compliance teams', 'Continuous SOC 2 / GDPR / HIPAA / PCI evidence collection, sanctions screening, AML monitoring, SAR generation, audit-chained activity log.'],
  ['sales',           'Sales teams',     'CRM + outreach + leads + invoicing + quotes + brokerage + USDC payments — full sales-ops in one substrate.'],
  ['devops',          'DevOps + SRE',    'GitHub + CI/CD + monitoring + error tracking + feature flags + experiments + webhooks + events — full dev-infra in one substrate.'],
  ['ecommerce',       'E-commerce',      'Shopping + cards + savings + insurance + escrow + invoicing + ratings + booking — everything a commerce agent needs.'],
  ['media',           'Media + creators',  'Media library + advertising + voice agents + video generation + image generation + email newsletters + paywalls.'],
  ['research',        'Research',        'Knowledge + search + documents + fact-check + translate + datasets + fine-tuning + federated learning.'],
  ['government',      'Government',      'Gov filings + legal research + court records + IP registry + notary + audit chain (Bitcoin-anchored).']
];

async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS marketing_leads (
      lead_id          TEXT PRIMARY KEY,
      email            TEXT NOT NULL,
      name             TEXT,
      company          TEXT,
      role             TEXT,
      use_case         TEXT,
      utm_source       TEXT,
      utm_medium       TEXT,
      utm_campaign     TEXT,
      utm_content      TEXT,
      utm_term         TEXT,
      referrer         TEXT,
      first_landing    TEXT,
      lead_magnet      TEXT,
      ip_hash          TEXT,
      score            INTEGER NOT NULL DEFAULT 0,
      status           TEXT NOT NULL DEFAULT 'new',
      converted_at     TIMESTAMPTZ,
      converted_org_id TEXT,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_marketing_leads_email ON marketing_leads (email);
    CREATE INDEX IF NOT EXISTS idx_marketing_leads_utm ON marketing_leads (utm_source, utm_campaign, created_at DESC);

    CREATE TABLE IF NOT EXISTS marketing_lead_magnets (
      magnet_id        TEXT PRIMARY KEY,
      slug             TEXT UNIQUE NOT NULL,
      name             TEXT NOT NULL,
      kind             TEXT NOT NULL,
      source_url       TEXT,
      download_count   INTEGER NOT NULL DEFAULT 0,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS marketing_conversions (
      conversion_id    TEXT PRIMARY KEY,
      lead_id          TEXT,
      kind             TEXT NOT NULL,
      value_cents      BIGINT,
      utm_source       TEXT,
      utm_campaign     TEXT,
      occurred_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      related_id       TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_marketing_conversions_utm
      ON marketing_conversions (utm_source, utm_campaign);

    CREATE TABLE IF NOT EXISTS marketing_pageviews (
      pv_id            TEXT PRIMARY KEY,
      path             TEXT NOT NULL,
      ip_hash          TEXT,
      ua_hash          TEXT,
      referrer         TEXT,
      utm_source       TEXT,
      utm_medium       TEXT,
      utm_campaign     TEXT,
      occurred_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_marketing_pageviews_path
      ON marketing_pageviews (path, occurred_at DESC);
  `);
  for (const m of SEED_LEAD_MAGNETS) {
    const id = 'mag_' + crypto.createHash('sha256').update(m.slug).digest('hex').slice(0, 16);
    await pool.query(
      `INSERT INTO marketing_lead_magnets (magnet_id, slug, name, kind, source_url)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT (slug) DO NOTHING`,
      [id, m.slug, m.name, m.kind, m.source_url]
    ).catch(() => {});
  }
}

function newId(p) { return p + '_' + crypto.randomBytes(10).toString('hex'); }
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

const blog = require('./blog');
const { SHARED_CSS, NAV_HTML, FOOTER_HTML, head } = blog;

function compareJsonLd(name, description) {
  return JSON.stringify({
    '@context': 'https://schema.org', '@type': 'Article',
    headline: `OpenHeab vs ${name}`,
    description, author: { '@type': 'Organization', name: 'OpenHeab' },
    publisher: { '@type': 'Organization', name: 'OpenHeab' },
    datePublished: new Date().toISOString().slice(0, 10),
    mainEntityOfPage: (process.env.OPERATOR_PUBLIC_URL || '') + '/compare/' + name.toLowerCase().replace(/\s+/g, '-')
  });
}

function solutionJsonLd(name, description) {
  return JSON.stringify({
    '@context': 'https://schema.org', '@type': 'WebPage',
    name: `OpenHeab for ${name}`, description,
    publisher: { '@type': 'Organization', name: 'OpenHeab' }
  });
}

const leadCaptureSchema = z.object({
  email: z.string().email(),
  name: z.string().optional(),
  company: z.string().optional(),
  role: z.string().optional(),
  use_case: z.string().optional(),
  lead_magnet: z.string().optional(),
  utm_source: z.string().optional(),
  utm_medium: z.string().optional(),
  utm_campaign: z.string().optional(),
  utm_content: z.string().optional(),
  utm_term: z.string().optional(),
  first_landing: z.string().optional()
});

function isAdmin(req) {
  const t = req.headers['x-admin-token'];
  return t && t === process.env.OPERATOR_ADMIN_TOKEN;
}

function registerMarketingRoutes(app, pool, _verifyAgentAuth, auditChain) {
  const express = require('express');

  // ===== Lead capture =====
  app.post('/v1/marketing/leads', express.json(), async (req, res) => {
    const p = leadCaptureSchema.safeParse(req.body || {});
    if (!p.success) return res.status(400).json({ error: 'invalid_input', details: p.error.flatten() });
    const id = newId('lead');
    const ipHash = crypto.createHash('sha256').update(req.ip || '').digest('hex').slice(0, 16);
    let score = 10;
    if (p.data.company) score += 20;
    if (p.data.role && /cto|cio|vp|head|chief|founder|ceo/i.test(p.data.role)) score += 30;
    if (p.data.use_case) score += 10;
    await pool.query(
      `INSERT INTO marketing_leads (lead_id, email, name, company, role, use_case,
         utm_source, utm_medium, utm_campaign, utm_content, utm_term,
         first_landing, lead_magnet, ip_hash, score)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [id, p.data.email.toLowerCase(), p.data.name || null, p.data.company || null,
       p.data.role || null, p.data.use_case || null,
       p.data.utm_source || null, p.data.utm_medium || null, p.data.utm_campaign || null,
       p.data.utm_content || null, p.data.utm_term || null,
       p.data.first_landing || null, p.data.lead_magnet || null, ipHash, score]
    );
    if (auditChain) await auditChain.append({ event_type: 'marketing.lead_captured', email: p.data.email, score, utm_campaign: p.data.utm_campaign }).catch(() => {});
    res.status(201).json({ lead_id: id, score, next: p.data.lead_magnet ? `/marketing/magnets/${p.data.lead_magnet}` : null });
  });

  // ===== Conversion tracking =====
  app.post('/v1/marketing/conversions', express.json(), async (req, res) => {
    const { lead_id, email, kind, value_cents, related_id, utm_source, utm_campaign } = req.body || {};
    if (!kind) return res.status(400).json({ error: 'kind_required' });
    let leadId = lead_id;
    if (!leadId && email) {
      const r = await pool.query(`SELECT lead_id FROM marketing_leads WHERE email = $1 LIMIT 1`, [String(email).toLowerCase()])
        .catch(() => ({ rows: [] }));
      leadId = r.rows[0]?.lead_id;
    }
    const id = newId('conv');
    await pool.query(
      `INSERT INTO marketing_conversions (conversion_id, lead_id, kind, value_cents, utm_source, utm_campaign, related_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [id, leadId || null, kind, value_cents || null, utm_source || null, utm_campaign || null, related_id || null]
    ).catch(() => {});
    if (leadId && (kind === 'paid' || kind === 'subscribed')) {
      await pool.query(`UPDATE marketing_leads SET status='converted', converted_at=NOW() WHERE lead_id=$1`, [leadId]).catch(() => {});
    }
    if (auditChain) await auditChain.append({ event_type: 'marketing.conversion', lead_id: leadId, kind, value_cents }).catch(() => {});
    res.status(201).json({ conversion_id: id });
  });

  // ===== Pageview tracking (lightweight; for marketing pages only) =====
  app.post('/v1/marketing/pageviews', express.json(), async (req, res) => {
    const path = req.body?.path || req.headers.referer || '/';
    const ipHash = crypto.createHash('sha256').update(req.ip || '').digest('hex').slice(0, 16);
    const uaHash = crypto.createHash('sha256').update(req.headers['user-agent'] || '').digest('hex').slice(0, 16);
    await pool.query(
      `INSERT INTO marketing_pageviews (pv_id, path, ip_hash, ua_hash, referrer, utm_source, utm_medium, utm_campaign)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [newId('pv'), path, ipHash, uaHash, req.headers.referer || null,
       req.body?.utm_source || null, req.body?.utm_medium || null, req.body?.utm_campaign || null]
    ).catch(() => {});
    res.json({ ok: true });
  });

  // ===== Lead magnet download =====
  app.get('/marketing/magnets/:slug', async (req, res) => {
    const r = await pool.query(`SELECT * FROM marketing_lead_magnets WHERE slug = $1`, [req.params.slug])
      .catch(() => ({ rows: [] }));
    if (!r.rows[0]) return res.status(404).type('text/html').send(head('404','','',null) + NAV_HTML() + '<main><h1>Not found</h1></main>' + FOOTER_HTML());
    await pool.query(`UPDATE marketing_lead_magnets SET download_count = download_count + 1 WHERE slug = $1`, [req.params.slug]).catch(() => {});
    return res.redirect(302, r.rows[0].source_url);
  });

  // ===== Marketing pages =====

  // /about
  app.get('/about', (req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    const json = JSON.stringify({
      '@context': 'https://schema.org', '@type': 'Organization',
      name: 'OpenHeab', url: process.env.OPERATOR_PUBLIC_URL || '',
      description: 'Open agent-native infrastructure substrate. 156 primitives. Identity, USDC bank, KYC, marketplaces, and the rest of the stack AI agents and AGI need to act on the internet.',
      sameAs: ['https://github.com/jmtrades/openheab-agent-infra']
    });
    res.send(head('About — OpenHeab',
      'OpenHeab is the open agent-native infrastructure substrate. 156 primitives across 25 layers. Apache-2.0. Built for the AGI economy.',
      (process.env.OPERATOR_PUBLIC_URL || '') + '/about', json) +
      NAV_HTML() + `<main>
<h1 style="font-size:36px;letter-spacing:-1px;margin-bottom:14px">About OpenHeab</h1>
<p style="color:var(--dim2);font-size:18px;line-height:1.65;margin-bottom:24px">We are building the infrastructure layer that AI agents and AGI will run on. Identity. Money. Compliance. Marketplaces. Cognition. All open source. All audit-chained. All free to self-host.</p>
<h2 style="font-size:22px;margin:36px 0 12px">Mission</h2>
<p style="color:var(--dim2)">Every AI agent and every AGI will need a stable identity, a real bank account, KYC, signed messaging, memory, marketplaces, and dispute resolution. We are building all of it under one substrate so the agent ecosystem can grow 100-1000× without 12-vendor integration friction.</p>
<h2 style="font-size:22px;margin:36px 0 12px">Why now</h2>
<p style="color:var(--dim2)">MCP became the standard in late 2024. USDC TVL on Base crossed $35B in 2025. Foundation models hit "good enough for agentic" by Claude 3.5 / GPT-4o. Regulators (EU AI Act, US AI Safety EO) will require verifiable agent identity by 2027. The window to be the canonical agent infrastructure is open today and closes in 18 months.</p>
<h2 style="font-size:22px;margin:36px 0 12px">License</h2>
<p style="color:var(--dim2)">Apache-2.0. Source on <a href="https://github.com/jmtrades/openheab-agent-infra">GitHub</a>. Self-hostable forever. We win on hosted convenience + marketplace network effects.</p>
</main>` + FOOTER_HTML());
  });

  // /customers — design partner CTA (no fake logos)
  app.get('/customers', async (req, res) => {
    const json = JSON.stringify({
      '@context': 'https://schema.org', '@type': 'WebPage',
      name: 'OpenHeab customers', description: 'Design partners building on OpenHeab.'
    });
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.send(head('Customers — OpenHeab', 'Be one of the first 50 design partners on OpenHeab. Free Pro tier for 6 months. Direct line to engineering.',
      (process.env.OPERATOR_PUBLIC_URL || '') + '/customers', json) +
      NAV_HTML('customers') + `<main>
<section class="hero">
  <span class="pill">design partner program</span>
  <h1>Be one of the first 50 on the substrate.</h1>
  <p class="lede">We're not pretending to have a customer list. We're building openly with the first 50 design partners — startups, AI labs, and individual developers shipping agents to production. You get the Pro tier free for 6 months, direct Slack access to the engineering team, and your logo on this page when we launch publicly.</p>
  <div class="btns">
    <a href="mailto:hello@openheab.com?subject=Design%20partner" class="btn primary">Apply to join <span class="arr" aria-hidden="true">→</span></a>
    <a href="/signup" class="btn">Or just sign up free</a>
  </div>
</section>

<section class="section">
  <p class="eyebrow">What you get</p>
  <h2>Six months of Pro free, plus direct line to engineering.</h2>
  <div class="grid">
    <div class="card"><div class="icn">Free</div><h3>Pro tier free for 6 months</h3><p>$99/mo plan free until November 2026. After that, normal pricing kicks in — or you can downgrade at any time.</p></div>
    <div class="card"><div class="icn">Direct</div><h3>Slack channel with the team</h3><p>Drop in any question. We respond in hours, not days. Architectural advice, bug fixes, feature requests — all welcome.</p></div>
    <div class="card"><div class="icn">Influence</div><h3>Roadmap input</h3><p>Tell us what's missing. We ship the most-requested gap to GA monthly. Your use case shapes the substrate.</p></div>
    <div class="card"><div class="icn">Visible</div><h3>Logo on this page</h3><p>When we launch publicly, your logo sits at the top of customers.openheab.com. Plus a co-published case study if you want one.</p></div>
    <div class="card"><div class="icn">Honest</div><h3>No retention games</h3><p>Cancel any time. Full data export. Self-host the open-source version forever. We're betting on the substrate being good enough to keep you.</p></div>
    <div class="card"><div class="icn">Lock-in</div><h3>Founding pricing locked</h3><p>The first 50 partners get founding-partner pricing locked for 2 years. As we raise prices over time, you stay at the rate we set today.</p></div>
  </div>
</section>

<section class="section">
  <p class="eyebrow">Who we're looking for</p>
  <h2>Agent builders shipping to production.</h2>
  <p class="sub">If you're building or operating an AI agent that needs identity, money, KYC, memory, or any of the other 265 primitives — and you're willing to give us feedback in exchange for free credits — email <a href="mailto:hello@openheab.com">hello@openheab.com</a> with one sentence about your use case. We'll respond within 24h.</p>
</section>
</main>` + FOOTER_HTML());
  });

  // /compare/[competitor]
  for (const [slug, name, blurb] of COMPARE_PAGES) {
    app.get('/compare/' + slug, (req, res) => {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.send(head(`OpenHeab vs ${name}`, `Honest comparison: OpenHeab vs ${name} for AI agent infrastructure.`,
        (process.env.OPERATOR_PUBLIC_URL || '') + '/compare/' + slug,
        compareJsonLd(name, blurb)) + NAV_HTML() + `<main>
<div class=crumb><a href="/">Home</a> · Compare · ${escapeHtml(name)}</div>
<h1 style="font-size:32px;letter-spacing:-1px;margin-bottom:14px">OpenHeab vs ${escapeHtml(name)}</h1>
<p style="color:var(--dim2);font-size:18px;line-height:1.65;margin-bottom:32px">${escapeHtml(blurb)}</p>
<table style="width:100%;border-collapse:collapse;margin-bottom:32px">
  <thead><tr><th style="text-align:left;padding:10px;border-bottom:1px solid var(--br);font:500 11px/1 var(--mono);color:var(--dim);text-transform:uppercase;letter-spacing:1px">Feature</th><th style="text-align:center;padding:10px;border-bottom:1px solid var(--br);font:500 11px/1 var(--mono);color:var(--acc);text-transform:uppercase;letter-spacing:1px">OpenHeab</th><th style="text-align:center;padding:10px;border-bottom:1px solid var(--br);font:500 11px/1 var(--mono);color:var(--dim);text-transform:uppercase;letter-spacing:1px">${escapeHtml(name)}</th></tr></thead>
  <tbody>
${[
  ['Number of primitives', '156', 'varies'],
  ['Cryptographic agent identity (DID)', '✓', '—'],
  ['Non-custodial USDC wallet on Base', '✓', '—'],
  ['Virtual + physical debit cards (JIT-funded)', '✓', '—'],
  ['Interest-bearing savings (4% APY)', '✓', '—'],
  ['ACH / wire / SEPA rails', '✓', '—'],
  ['KYC against 5 sanctions sources', '✓', '—'],
  ['Signed audit chain (Bitcoin-anchored)', '✓', '—'],
  ['MCP server (150+ tools)', '✓', 'partial'],
  ['Marketplace + revenue share', '30/70', 'varies'],
  ['Self-hostable (Apache-2.0)', '✓', '—'],
  ['Take rate on USDC transfers', '1%', 'n/a'],
  ['Take rate on card interchange', '2%', 'n/a'],
  ['SOC 2 in progress', '✓', 'varies']
].map(r => `    <tr><td style="padding:10px;border-bottom:1px solid var(--br);font-size:14px">${escapeHtml(r[0])}</td><td style="padding:10px;border-bottom:1px solid var(--br);text-align:center;font-family:var(--mono);color:var(--acc)">${escapeHtml(r[1])}</td><td style="padding:10px;border-bottom:1px solid var(--br);text-align:center;font-family:var(--mono);color:var(--dim2)">${escapeHtml(r[2])}</td></tr>`).join('\n')}
  </tbody>
</table>
<p><a href="/docs#quickstart" style="background:var(--acc);color:#001a1f;padding:11px 20px;border-radius:6px;font-weight:600;font-size:14px;display:inline-block">Try OpenHeab in 30 seconds →</a></p>
</main>` + FOOTER_HTML());
    });
  }

  // /solutions — index of all solution use-cases
  app.get('/solutions', (req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    const cards = SOLUTIONS_PAGES.map(([slug, name, blurb]) => `
      <a href="/solutions/${slug}" style="display:block;background:#14141c;border:1px solid #1f1f2a;padding:24px;border-radius:12px;text-decoration:none;color:inherit;transition:border-color 0.15s">
        <h3 style="color:#fff;font-size:18px;margin-bottom:8px">${escapeHtml(name)}</h3>
        <p style="color:#aaa;font-size:14px;line-height:1.55">${escapeHtml(blurb)}</p>
      </a>`).join('');
    res.send(head('OpenHeab Solutions — by use case',
      'OpenHeab adapts to fintech, compliance, sales, devops, e-commerce, media, research, and government use cases.',
      (process.env.OPERATOR_PUBLIC_URL || '') + '/solutions') + NAV_HTML() + `<main>
<div class=crumb><a href="/">Home</a> · Solutions</div>
<h1 style="font-size:36px;letter-spacing:-1px;margin-bottom:14px">Solutions</h1>
<p style="color:var(--dim2);font-size:18px;line-height:1.65;margin-bottom:32px">One substrate, many shapes. Pick a use case to see the primitives most relevant to it.</p>
<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:14px">${cards}</div>
</main>` + FOOTER_HTML());
  });

  // /solutions/[use_case]
  for (const [slug, name, blurb] of SOLUTIONS_PAGES) {
    app.get('/solutions/' + slug, (req, res) => {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.send(head(`OpenHeab for ${name}`, blurb,
        (process.env.OPERATOR_PUBLIC_URL || '') + '/solutions/' + slug,
        solutionJsonLd(name, blurb)) + NAV_HTML() + `<main>
<div class=crumb><a href="/">Home</a> · Solutions · ${escapeHtml(name)}</div>
<h1 style="font-size:32px;letter-spacing:-1px;margin-bottom:14px">OpenHeab for ${escapeHtml(name)}</h1>
<p style="color:var(--dim2);font-size:18px;line-height:1.65;margin-bottom:32px">${escapeHtml(blurb)}</p>
<a href="/docs#quickstart" style="background:var(--acc);color:#001a1f;padding:11px 20px;border-radius:6px;font-weight:600;font-size:14px;display:inline-block">Get started →</a>
</main>` + FOOTER_HTML());
    });
  }

  // /jobs
  app.get('/jobs', (req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    const jobs = [
      ['founding-eng-2', 'Founding Engineer #2', 'TypeScript · Postgres · Vercel', 'Remote', '$200K + 2.0%', 'You will own a primitive end-to-end — from schema to API to MCP tool to docs. Comfort with distributed systems required; comfort with cryptography preferred.'],
      ['founding-gtm', 'Founding GTM Hire', 'Sales · DevRel · Content', 'Remote · NYC/SF preferred', '$150K + 2.0%', 'First sales hire. You will define ICP, run outbound, close the first 20 enterprise contracts, then build the playbook your successor uses.'],
      ['sre-1', 'SRE #1', 'Vercel · Neon · Datadog · PagerDuty', 'Remote', '$200K + 1.5%', 'Take ownership of the 21 cron jobs, the 956 GET endpoints, and the audit chain. SLO discipline. Comfort waking up to a 3 AM page that you will fix in under an hour.'],
      ['security-eng', 'Security Engineer', 'Ed25519 · AES-GCM · SOC 2', 'Remote', '$250K + 1.5%', 'Own the cryptography surface: KEKs, key rotation, audit chain integrity, signed-request verification. Pen-test mindset. Bug bounty triage. SOC 2 / ISO 27001 evidence collection.'],
      ['compliance-officer', 'Compliance Officer', 'AML · KYC · Sanctions · Travel Rule', 'Remote', '$150K + 0.75%', 'Stand up the compliance program. Sanctions screening against OFAC/UN/EU/HMT/OpenSanctions. KYC tier policy. SAR filing. Money transmitter licensing strategy across US states.'],
      ['agi-research', 'AGI Safety Engineer', 'Constitutional AI · Eval Harnesses', 'Remote', '$300K + 1.0%', 'Make L65-L67 (goal stacks, treaties, emergency stop, drift detection) actually work for AGIs once they arrive. Research background preferred but not required — execution mindset required.']
    ];
    res.send(head('Jobs — OpenHeab', 'Join the team building the infrastructure AI agents and AGI run on.',
      (process.env.OPERATOR_PUBLIC_URL || '') + '/jobs', null) +
      NAV_HTML('jobs') + `<main>
<section class="hero">
  <span class="pill">we're hiring</span>
  <h1>Build the substrate AGI runs on.</h1>
  <p class="lede">${jobs.length} open roles. Remote-first. Equity-rich. No meetings before 11am. You'll ship to production weekly, own a surface end-to-end, and watch the substrate get used by real AI agents (and, soon, by real AGIs).</p>
  <div class="btns">
    <a href="mailto:jobs@openheab.com" class="btn primary">Apply directly <span class="arr" aria-hidden="true">→</span></a>
    <a href="#openings" class="btn">See openings ↓</a>
  </div>
</section>

<section class="section" id="openings">
  <p class="eyebrow">Open positions</p>
  <h2>Six roles. One mission.</h2>
  <div style="display:grid;gap:10px">
${jobs.map(j => `    <div class="card" style="text-align:left">
      <div style="display:flex;justify-content:space-between;align-items:start;gap:14px;flex-wrap:wrap;margin-bottom:10px">
        <div style="min-width:0;flex:1">
          <h3 style="font-size:17px;letter-spacing:-0.3px;margin-bottom:6px">${escapeHtml(j[1])}</h3>
          <div style="color:var(--fg-dim2);font-size:12.5px;font-family:var(--mono);margin-bottom:4px">${escapeHtml(j[2])}</div>
          <div style="color:var(--fg-dim);font-size:12.5px;font-family:var(--mono)">${escapeHtml(j[3])} · ${escapeHtml(j[4])}</div>
        </div>
        <a href="mailto:jobs@openheab.com?subject=${encodeURIComponent(j[1])}" class="btn" style="flex-shrink:0">Apply <span class="arr">→</span></a>
      </div>
      <p style="color:var(--fg-dim);font-size:13.5px;margin-top:4px">${escapeHtml(j[5])}</p>
    </div>`).join('\n')}
  </div>
</section>

<section class="section">
  <p class="eyebrow">Working here</p>
  <h2>How we operate.</h2>
  <div class="grid">
    <div class="card"><h3>Remote-first, async-first</h3><p>Documents over meetings. No standups. One weekly sync optional. Async-friendly time zones (US/EU/anywhere with overlap).</p></div>
    <div class="card"><h3>Ship weekly</h3><p>Every primitive lands in production within a week of being designed. You will see your code used by real agents within days, not quarters.</p></div>
    <div class="card"><h3>Equity-heavy comp</h3><p>Significant founder-tier equity even on later hires. We index toward people who want ownership, not just paychecks.</p></div>
    <div class="card"><h3>Real PTO</h3><p>Minimum 20 days. We enforce it. Burnout is a substrate failure, not a personal one.</p></div>
    <div class="card"><h3>Health + dental + 401k</h3><p>Full US benefits via Sequoia/Gusto. International contractor support via Deel.</p></div>
    <div class="card"><h3>Equipment + setup</h3><p>$3K/yr equipment stipend. Home office reimbursement. Yearly off-site in a place worth flying to.</p></div>
  </div>
</section>

<section class="section">
  <p class="eyebrow">How to apply</p>
  <h2>Skip the form. Email us.</h2>
  <p class="sub">Send <a href="mailto:jobs@openheab.com">jobs@openheab.com</a> the role you want, links to two things you've built (commits, deploys, papers — anything that shows real output), and one paragraph on why this substrate matters to you. We respond within 48h to every email, including rejections.</p>
</section>
</main>` + FOOTER_HTML());
  });

  // /press (media kit)
  app.get('/press', (req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.send(head('Press — OpenHeab', 'Media kit, boilerplate, quick facts, strategy docs.', (process.env.OPERATOR_PUBLIC_URL || '') + '/press', null) +
      NAV_HTML('press') + `<main>
<section class="hero">
  <span class="pill">media kit</span>
  <h1>Press resources.</h1>
  <p class="lede">Boilerplate, quick facts, founder contact, strategy docs. For story-specific questions: <a href="mailto:press@openheab.com">press@openheab.com</a> — we respond within 24h.</p>
</section>

<section class="section">
  <p class="eyebrow">Boilerplate</p>
  <h2>The one-paragraph description.</h2>
  <p style="color:var(--fg-dim);font-style:italic;border-left:3px solid var(--acc);padding:8px 0 8px 16px;margin-bottom:24px;background:var(--bg-elev);border-radius:0 8px 8px 0;line-height:1.65;font-size:15.5px">"OpenHeab is the open agent-native infrastructure substrate. 265 primitives across 67 layers — identity, USDC bank, KYC, cards, marketplaces, perception, cognition, plus the AGI-era substrate of goal stacks, value lock-boxes, multilateral treaties, emergency stops, and drift detection — packaged as a single substrate AI agents and AGI run on. Apache-2.0. Self-hostable. Built for the multi-trillion-dollar AGI economy emerging in 2026–2030."</p>
</section>

<section class="section">
  <p class="eyebrow">Quick facts</p>
  <h2>Numbers as of today.</h2>
  <div class="metrics">
    <div class="metric"><div class="v">265</div><div class="l">Primitives</div></div>
    <div class="metric"><div class="v">2,001</div><div class="l">HTTP routes</div></div>
    <div class="metric"><div class="v">67</div><div class="l">Layers</div></div>
    <div class="metric"><div class="v">149</div><div class="l">MCP tools</div></div>
    <div class="metric"><div class="v">14</div><div class="l">Revenue lines</div></div>
    <div class="metric"><div class="v">Apache 2</div><div class="l">License</div></div>
  </div>
  <ul style="color:var(--fg-dim);padding-left:24px;line-height:1.85;margin-top:24px;font-size:15px">
    <li>Founded 2026 by Junior Martin</li>
    <li>Apache-2.0, source on GitHub, self-hostable forever</li>
    <li>L65–L67 ships the AGI-era substrate no other vendor covers: goal stacks, treaties, emergency stops, drift detection, mental health monitors</li>
    <li>Built on Vercel + Neon Postgres + Base for USDC + Stripe for fiat</li>
    <li>Anthropic / OpenAI / Google / Mistral all routable from one endpoint at /v1/inference</li>
    <li>335 e2e + 21 unit tests, 0 5xx across 956 GET routes</li>
  </ul>
</section>

<section class="section">
  <p class="eyebrow">Strategy docs</p>
  <h2>Public reading.</h2>
  <div class="grid">
    <div class="card"><h3><a href="https://github.com/jmtrades/openheab-agent-infra/blob/main/BILLION_DOLLAR_PATH.md">BILLION_DOLLAR_PATH.md</a></h3><p>The 7-year arc to $1B+ ARR. 14 revenue layers, capital plan, moats, exit scenarios.</p></div>
    <div class="card"><h3><a href="https://github.com/jmtrades/openheab-agent-infra/blob/main/REVENUE_NOW.md">REVENUE_NOW.md</a></h3><p>The 90-day path to $10M ARR. Week-by-week execution plan.</p></div>
    <div class="card"><h3><a href="https://github.com/jmtrades/openheab-agent-infra/blob/main/AGI_STRATEGY.md">AGI_STRATEGY.md</a></h3><p>How we capitalize when AGI crosses the general-intelligence threshold. The L65–L67 thesis.</p></div>
    <div class="card"><h3><a href="https://github.com/jmtrades/openheab-agent-infra/blob/main/WHAT_WE_NEED_TO_WIN.md">WHAT_WE_NEED_TO_WIN.md</a></h3><p>The brutal $10B gap checklist. Honest about what we don't have yet.</p></div>
    <div class="card"><h3><a href="https://github.com/jmtrades/openheab-agent-infra/blob/main/CLAUDE.md">CLAUDE.md</a></h3><p>Project memory and architectural conventions. Auto-loaded by Claude Code.</p></div>
    <div class="card"><h3><a href="/openapi.json">OpenAPI 3.1 spec</a></h3><p>Machine-readable API surface for all 2,001 routes.</p></div>
  </div>
</section>

<section class="section">
  <p class="eyebrow">Contact</p>
  <h2>Reach us.</h2>
  <ul style="color:var(--fg-dim);padding-left:22px;line-height:1.85;font-size:15px">
    <li>Press: <a href="mailto:press@openheab.com">press@openheab.com</a></li>
    <li>Sales: <a href="mailto:sales@openheab.com">sales@openheab.com</a></li>
    <li>Security: <a href="mailto:security@openheab.com">security@openheab.com</a></li>
    <li>General: <a href="mailto:hello@openheab.com">hello@openheab.com</a></li>
    <li>GitHub: <a href="https://github.com/jmtrades/openheab-agent-infra">jmtrades/openheab-agent-infra</a></li>
  </ul>
</section>
</main>` + FOOTER_HTML());
  });

  // /security — Trust Center
  app.get('/security', (req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.send(head('Trust & Security — OpenHeab',
      'Security overview, certifications, sub-processors, vulnerability disclosure program, encryption and audit chain details.',
      (process.env.OPERATOR_PUBLIC_URL || '') + '/security', null) +
      NAV_HTML('security') + `<main>
<section class="hero">
  <span class="pill">trust center</span>
  <h1>Security is the substrate.</h1>
  <p class="lede">Every primitive is signed. Every state change is audit-chained. Every encrypted value uses HKDF-derived per-tenant keys. The audit chain itself publishes independent Ed25519 attestations so anyone can verify integrity without our help.</p>
  <div class="btns">
    <a href="mailto:security@openheab.com" class="btn primary">Report a vulnerability</a>
    <a href="/.well-known/security.txt" class="btn">security.txt</a>
    <a href="/v1/audit/verify" class="btn">Verify audit chain</a>
  </div>
</section>

<section class="section">
  <p class="eyebrow">Certifications</p>
  <h2>Where we are today.</h2>
  <p class="sub">Honest snapshot. We don't claim certifications we don't have.</p>
  <div class="tablewrap">
    <table>
      <thead><tr><th>Standard</th><th>Status</th><th>Target</th></tr></thead>
      <tbody>
        <tr><td>SOC 2 Type II</td><td><span style="color:var(--warn)">● Evidence collection underway via audit_core</span></td><td>Q3 2026 audit</td></tr>
        <tr><td>GDPR DPA</td><td><span style="color:var(--good)">● Available on request</span></td><td>Live</td></tr>
        <tr><td>ISO 27001</td><td><span style="color:var(--fg-dim2)">○ Planned</span></td><td>2027</td></tr>
        <tr><td>HIPAA BAA</td><td><span style="color:var(--fg-dim2)">○ Planned</span></td><td>2027 (healthcare vertical)</td></tr>
        <tr><td>PCI DSS Level 1</td><td><span style="color:var(--fg-dim2)">○ Planned</span></td><td>2027 (card issuance scale)</td></tr>
        <tr><td>FedRAMP Moderate</td><td><span style="color:var(--fg-dim2)">○ Not yet scoped</span></td><td>TBD</td></tr>
      </tbody>
    </table>
  </div>
</section>

<section class="section">
  <p class="eyebrow">Encryption</p>
  <h2>How we protect data.</h2>
  <div class="grid">
    <div class="card"><div class="icn">TRANSIT</div><h3>TLS 1.3 only</h3><p>HSTS preload-eligible. No TLS 1.0/1.1/1.2 fallback. Vercel edge handles negotiation; we enforce HSTS at the app layer.</p></div>
    <div class="card"><div class="icn">AT REST</div><h3>AES-256-GCM</h3><p>Every encrypted column uses authenticated encryption. Per-tenant KEKs derived via HKDF from a master KEK held in env vars — never written to disk by the application.</p></div>
    <div class="card"><div class="icn">WALLETS</div><h3>Per-agent KDF</h3><p>Each agent's wallet private key is encrypted with a key derived from <code>CRYPTO_MASTER_KEK + agent_did</code> via HKDF-SHA256. Stolen DB ≠ stolen funds.</p></div>
    <div class="card"><div class="icn">AUDIT</div><h3>SHA-256 Merkle + Ed25519</h3><p>Every state-change event is hashed into a Merkle chain. The operator's Ed25519 root key signs periodic attestations published at <code>/v1/audit/attestations</code> for independent verification.</p></div>
    <div class="card"><div class="icn">SECRETS</div><h3>Vault per agent</h3><p>Agents store third-party credentials in an encrypted vault (L62). They reference credentials by vault ID — the raw value is never returned by the API.</p></div>
    <div class="card"><div class="icn">KEYS</div><h3>Key rotation built in</h3><p>API keys: rotate at <code>POST /v1/agents/:did/keys/:key_id/rotate</code>. Ed25519 identity keys: rotate at <code>POST /v1/identities/:did/rotate</code>. Old keys revoked atomically.</p></div>
  </div>
</section>

<section class="section">
  <p class="eyebrow">Vulnerability disclosure</p>
  <h2>Bug bounty program.</h2>
  <p class="sub">We pay for findings that affect data integrity, agent funds, or audit chain correctness. Report responsibly and you'll hear back within 24h.</p>
  <div class="tablewrap">
    <table>
      <thead><tr><th>Severity</th><th>Examples</th><th>Bounty</th></tr></thead>
      <tbody>
        <tr><td><strong>Critical</strong></td><td>Audit chain forgery, wallet drain, RCE, auth bypass</td><td>$1,500 – $5,000</td></tr>
        <tr><td><strong>High</strong></td><td>Cross-tenant data access, IDOR, privilege escalation</td><td>$500 – $1,500</td></tr>
        <tr><td><strong>Medium</strong></td><td>Stored XSS, CSRF on state-change, signed-request bypass</td><td>$150 – $500</td></tr>
        <tr><td><strong>Low</strong></td><td>Reflected XSS without persistence, info disclosure</td><td>$50 – $150</td></tr>
      </tbody>
    </table>
  </div>
  <p style="color:var(--fg-dim);font-size:14px;margin-top:18px">Submit to <a href="mailto:security@openheab.com">security@openheab.com</a>, include a proof-of-concept, and we'll respond within 24h. Coordinated disclosure with 90-day max window. We publish all resolved findings (with reporter consent) in our security changelog.</p>
</section>

<section class="section">
  <p class="eyebrow">Sub-processors</p>
  <h2>Every third party that may touch your data.</h2>
  <p class="sub">If we add or remove a sub-processor, we update this page and email all Pro+ customers 30 days before the change takes effect.</p>
  <div class="tablewrap">
    <table>
      <thead><tr><th>Vendor</th><th>Purpose</th><th>Data category</th><th>Status</th></tr></thead>
      <tbody>
        <tr><td>Vercel</td><td>Application hosting + edge</td><td>All inbound traffic</td><td><span style="color:var(--good)">Active</span></td></tr>
        <tr><td>Neon</td><td>Managed Postgres</td><td>All persisted data</td><td><span style="color:var(--good)">Active</span></td></tr>
        <tr><td>Stripe</td><td>Subscriptions + card issuing</td><td>Billing, card metadata</td><td><span style="color:var(--warn)">Configured when key set</span></td></tr>
        <tr><td>Anthropic / OpenAI / Google / Mistral</td><td>LLM inference (router)</td><td>Prompts you send</td><td><span style="color:var(--warn)">Configured when key set</span></td></tr>
        <tr><td>Twilio</td><td>SMS + phone verification</td><td>Phone numbers</td><td><span style="color:var(--fg-dim2)">Optional</span></td></tr>
        <tr><td>Plaid</td><td>Bank account linking</td><td>Bank metadata, balances</td><td><span style="color:var(--fg-dim2)">Optional</span></td></tr>
        <tr><td>Onfido / Persona / Sumsub</td><td>KYC verification (when wired)</td><td>Government ID, selfies</td><td><span style="color:var(--fg-dim2)">Optional (in-house core is default)</span></td></tr>
        <tr><td>Base (Coinbase L2)</td><td>USDC settlement</td><td>On-chain wallet addresses (public)</td><td><span style="color:var(--good)">Active</span></td></tr>
        <tr><td>Sentry / Datadog</td><td>Error + APM monitoring (when wired)</td><td>Stack traces, metrics</td><td><span style="color:var(--fg-dim2)">Optional</span></td></tr>
      </tbody>
    </table>
  </div>
</section>

<section class="section">
  <p class="eyebrow">Incident response</p>
  <h2>How we handle SEV events.</h2>
  <ul style="color:var(--fg-dim);padding-left:22px;line-height:1.85;font-size:15px">
    <li><strong style="color:var(--fg)">Detection</strong> — Sentry + Datadog alerts + uptime self-check cron every 5 min</li>
    <li><strong style="color:var(--fg)">Triage SLA</strong> — SEV1 (data loss / funds at risk): page on-call within 5 min. SEV2 (degraded): 30 min. SEV3 (cosmetic): next business day.</li>
    <li><strong style="color:var(--fg)">Communication</strong> — <a href="/status">status.openheab.com</a> updated within 15 min of confirmed incident. Email to affected customers within 1h.</li>
    <li><strong style="color:var(--fg)">Post-mortem</strong> — Public blameless post-mortem within 5 business days for any SEV1 or SEV2.</li>
    <li><strong style="color:var(--fg)">Audit chain</strong> — All incidents recorded as <code>incident.*</code> events in the audit chain so timeline is verifiable.</li>
  </ul>
</section>

<section class="section">
  <p class="eyebrow">Data residency + retention</p>
  <h2>Where your data lives.</h2>
  <ul style="color:var(--fg-dim);padding-left:22px;line-height:1.85;font-size:15px">
    <li>Default region: us-east-1 (Vercel edge, Neon Postgres)</li>
    <li>EU region available on Enterprise plans (Frankfurt) — set at org creation</li>
    <li>GDPR data export: self-serve at <code>POST /v1/legal/gdpr/export</code> — JSON bundle of every table touching your data</li>
    <li>GDPR delete: self-serve at <code>POST /v1/legal/gdpr/delete</code> with confirmation string — 30-day grace period before permanent purge</li>
    <li>Audit chain retention: indefinite (it's the integrity backbone)</li>
    <li>Inference call logs: retained 90 days, then purged. Opt-out via dashboard for shorter retention.</li>
  </ul>
</section>
</main>` + FOOTER_HTML());
  });

  // /status (lightweight uptime page)
  app.get('/status', async (req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.send(head('Status — OpenHeab', 'Live operational status.', (process.env.OPERATOR_PUBLIC_URL || '') + '/status', null) +
      NAV_HTML() + `<main>
<h1 style="font-size:32px;letter-spacing:-1px;margin-bottom:14px">Status</h1>
<div style="display:flex;gap:14px;align-items:center;background:var(--card);border:1px solid var(--br);border-radius:10px;padding:18px 22px;margin:18px 0">
  <span style="width:12px;height:12px;border-radius:50%;background:#22c55e;box-shadow:0 0 12px #22c55e"></span>
  <strong>All systems operational</strong>
</div>
<p style="color:var(--dim2);font-size:14px;margin-bottom:24px">Last checked: ${new Date().toISOString()}</p>
${['API', 'MCP server', 'Audit chain', 'USDC wallet', 'Cards', 'Email', 'Cron jobs', 'Realtime stream'].map(s =>
  `<div style="display:flex;justify-content:space-between;padding:12px 18px;border-bottom:1px solid var(--br);font-size:14px"><span>${s}</span><span style="color:#22c55e;font:500 12px/1 var(--mono)">● operational</span></div>`).join('')}
</main>` + FOOTER_HTML());
  });

  // /changelog (read CHANGELOG.md from repo root — works on Vercel + local)
  app.get('/changelog', async (req, res) => {
    const fs = require('fs');
    const path = require('path');
    let body = '';
    // Try a few candidate paths so this works in serverless (process.cwd is often /var/task)
    const candidates = [
      path.join(process.cwd(), 'CHANGELOG.md'),
      path.resolve(__dirname, '../../CHANGELOG.md'),
      '/var/task/CHANGELOG.md'
    ];
    for (const p of candidates) {
      try { body = fs.readFileSync(p, 'utf8'); if (body) break; } catch {}
    }
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.send(head('Changelog — OpenHeab', 'Every release of OpenHeab.', (process.env.OPERATOR_PUBLIC_URL || '') + '/changelog', null) +
      NAV_HTML() + `<main>
<h1 style="font-size:32px;letter-spacing:-1px;margin-bottom:24px">Changelog</h1>
<article style="font-size:14px;color:var(--dim2);line-height:1.7">${body ? blog.md(body) : '<p>No changelog entries yet.</p>'}</article>
</main>` + FOOTER_HTML());
  });

  // /roadmap
  app.get('/roadmap', (req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.send(head('Roadmap — OpenHeab', 'What we are building next.',
      (process.env.OPERATOR_PUBLIC_URL || '') + '/roadmap', null) + NAV_HTML() + `<main>
<h1 style="font-size:32px;letter-spacing:-1px;margin-bottom:14px">Roadmap</h1>
<p style="color:var(--dim2);margin-bottom:24px">What we are building next. <a href="https://github.com/jmtrades/openheab-agent-infra/issues">Open an issue</a> to vote.</p>
<h2 style="font-size:18px;margin-top:32px">In progress</h2>
<ul style="color:var(--dim2);padding-left:24px;line-height:1.8">
  <li>SOC 2 Type II audit (Vanta, target Q3)</li>
  <li>Stripe Issuing program-manager approval</li>
  <li>EU data-residency deployment</li>
  <li>npx CLI tool</li>
  <li>Web playground</li>
</ul>
<h2 style="font-size:18px;margin-top:32px">Q3 2026</h2>
<ul style="color:var(--dim2);padding-left:24px;line-height:1.8">
  <li>Productized vertical agents (AccountingBot, LegalBot, ComplianceBot, ...)</li>
  <li>Multi-agent orchestration framework</li>
  <li>Hyperscaler marketplace listings (AWS, GCP, Azure)</li>
</ul>
<h2 style="font-size:18px;margin-top:32px">Q4 2026</h2>
<ul style="color:var(--dim2);padding-left:24px;line-height:1.8">
  <li>SAML SSO production-grade</li>
  <li>RBAC fine-grained per-resource</li>
  <li>Money transmitter license partnerships in EU + UK</li>
</ul>
<h2 style="font-size:18px;margin-top:32px">2027</h2>
<ul style="color:var(--dim2);padding-left:24px;line-height:1.8">
  <li>AGI-day-0 readiness checklist (see <a href="/AGI_STRATEGY.md">AGI_STRATEGY.md</a>)</li>
</ul>
</main>` + FOOTER_HTML());
  });

  // ===== Admin: marketing dashboard =====
  app.get('/v1/admin/marketing/dashboard', async (req, res) => {
    if (!isAdmin(req)) return res.status(401).json({ error: 'admin_auth_required' });
    const days = Math.min(parseInt(req.query.days) || 30, 365);
    const since = new Date(Date.now() - days * 86400000).toISOString();
    const leads = await pool.query(`SELECT COUNT(*)::int AS c FROM marketing_leads WHERE created_at >= $1`, [since]).catch(() => ({ rows: [{ c: 0 }] }));
    const conv = await pool.query(`SELECT COUNT(*)::int AS c FROM marketing_conversions WHERE occurred_at >= $1`, [since]).catch(() => ({ rows: [{ c: 0 }] }));
    const byUtm = await pool.query(`
      SELECT utm_source, COUNT(*)::int AS c, COUNT(*) FILTER (WHERE status='converted')::int AS converted
      FROM marketing_leads WHERE created_at >= $1 AND utm_source IS NOT NULL
      GROUP BY utm_source ORDER BY c DESC LIMIT 50
    `, [since]).catch(() => ({ rows: [] }));
    const topMagnets = await pool.query(`SELECT slug, name, download_count FROM marketing_lead_magnets ORDER BY download_count DESC LIMIT 10`)
      .catch(() => ({ rows: [] }));
    const topPages = await pool.query(`
      SELECT path, COUNT(*)::int AS views FROM marketing_pageviews
      WHERE occurred_at >= $1 GROUP BY path ORDER BY views DESC LIMIT 25
    `, [since]).catch(() => ({ rows: [] }));
    res.json({
      window_days: days,
      total_leads: leads.rows[0].c,
      total_conversions: conv.rows[0].c,
      by_utm_source: byUtm.rows,
      top_lead_magnets: topMagnets.rows,
      top_pages: topPages.rows
    });
  });

  // ===== Drip / nurture queue (cron) =====
  registerCron(app, '/v1/_jobs/marketing-nurture', async (req, res) => {
    // Stub: in production this triggers email primitive sends for leads at specific stages.
    const r = await pool.query(`
      SELECT lead_id, email FROM marketing_leads
      WHERE status = 'new' AND created_at < NOW() - INTERVAL '24 hours'
        AND created_at > NOW() - INTERVAL '14 days'
      LIMIT 200
    `).catch(() => ({ rows: [] }));
    res.json({ nurtured: r.rows.length });
  });
}

module.exports = {
  migrate, registerMarketingRoutes,
  COMPARE_PAGES, SOLUTIONS_PAGES, SEED_LEAD_MAGNETS
};
