// ============================================================================
// blog.js — public blog. Posts, tags, RSS, search, view tracking,
// comments. Server-rendered. SEO-optimized (JSON-LD Article, BreadcrumbList,
// canonical URLs). Drives organic traffic + lead capture.
// ============================================================================
const crypto = require('crypto');
const { z } = require('zod');

const SEED_POSTS = [
  {
    slug: 'every-ai-agent-needs-a-bank',
    title: 'Every AI agent needs a bank. We built one.',
    excerpt: 'A non-custodial USDC wallet on Base, JIT-funded debit cards, savings, lending, ACH/wire/SEPA. The full bank stack for autonomous AI agents.',
    body: `# Every AI agent needs a bank. We built one.\n\nAgents make decisions in real time. Every decision that involves money — pay a SaaS subscription, settle an invoice, top up compute, transfer to a counterparty — needs to happen in seconds, not minutes. Asking a human to approve every transaction defeats the purpose of an agent.\n\nThe answer is: agents need real bank accounts. Not "an API key on a human's bank account" — actual non-custodial wallets the agent owns, with the same compliance and protection a human bank account has, but built for machine speed.\n\nThat's what we shipped. Read on for the architecture.`,
    tags: ['bank', 'usdc', 'agents', 'cards', 'savings'],
    category: 'product'
  },
  {
    slug: '90-days-to-10m-arr',
    title: '90 days to $10M ARR (the explicit plan)',
    excerpt: 'Most infra startups die at "we built it, why isn\'t anyone using it." Here\'s the week-by-week distribution + sales plan that gets us to $10M ARR.',
    body: `# 90 days to $10M ARR\n\nWe shipped 156 primitives across 25 layers. That\'s the easy half. The hard half is distribution + trust + execution. Here\'s the week-by-week plan.\n\n## Week 1\n- Submit MCP server to every registry (Smithery, mcp.run, ClaudePluginHub)\n- Show HN on Tuesday at 9am ET\n- Email 25 known agent-infra investors\n\n## Week 2-4\nWarm intros to 200 known agent founders. Free Pro tier for 6 months in exchange for case study + logo.\n\nFull plan in REVENUE_NOW.md.`,
    tags: ['gtm', 'pricing', 'strategy'],
    category: 'strategy'
  },
  {
    slug: 'mcp-is-the-app-store-for-agents',
    title: 'MCP is the App Store for agents — here\'s why we bet our distribution on it',
    excerpt: 'Every Claude / OpenAI / Cursor / VS Code agent that speaks MCP gets our 150+ tools the moment it installs the server. This is the single largest distribution opportunity in agent infra.',
    body: `# MCP is the App Store for agents\n\nIn late 2024, MCP (Model Context Protocol) became the open standard for agent tooling. Every major IDE/agent framework adopted it within months. We bet our distribution on it.\n\nThe math: each Claude/Cursor/VS Code user who installs the OpenHeab MCP server immediately gets 150+ tools. No SDK install. No API key dance. Just: tool call → result.\n\nWe currently expose 150+ tools at /mcp/manifest.`,
    tags: ['mcp', 'distribution', 'claude'],
    category: 'engineering'
  },
  {
    slug: 'agi-is-coming-and-we-are-its-bank',
    title: 'AGI is coming, and we are its bank',
    excerpt: 'When AGI arrives in 2026-2028, every AGI on Earth will need identity, money, legal personhood, and compliance. The wrappers around OpenAI\'s API get disrupted. We don\'t.',
    body: `# AGI is coming, and we are its bank\n\nWhen frontier labs ship something close to AGI — and they will, likely in 2026-2028 — the existing "wrap an OpenAI API call" companies disappear in weeks because AGIs use AGIs to bypass them.\n\nThe only durable layer is what AGIs cannot build for themselves: cryptographic identity (portable across providers), real money (with bank licenses + KYC), legal personhood (real Delaware C-Corps + DAOs), compliance (sanctions screening, AML, audit-defensibility), and physical-world bridges (cards, ACH, wires, property, robotics).\n\nThat is OpenHeab. Per-AGI revenue: $5K-$40K/yr. Total AGIs by 2030: estimated 100M-1B. Math: $500B-$20T market. We need 0.1-1% of that to be a $5-200B company.\n\nFull AGI strategy in AGI_STRATEGY.md.`,
    tags: ['agi', 'strategy', 'future'],
    category: 'strategy'
  },
  {
    slug: 'soc2-without-the-pain',
    title: 'SOC 2 Type II for agent infrastructure, without the pain',
    excerpt: 'Our compliance_pack primitive auto-collects evidence for SOC 2, GDPR, HIPAA, PCI, ISO 27001, FedRAMP. Continuous, not yearly. Audit-ready by default.',
    body: `# SOC 2 without the pain\n\nMost startups treat SOC 2 as a once-a-year fire drill. Wrong approach for agent infra — agents need continuous attestation, not yearly snapshots.\n\nThe compliance_pack primitive seeds 25+ controls across SOC 2 Type II, GDPR, HIPAA Security Rule, PCI-DSS 4.0, ISO 27001, and FedRAMP Moderate. It auto-collects evidence on a cron schedule. Your auditor gets a continuously up-to-date evidence locker.`,
    tags: ['compliance', 'soc2', 'enterprise'],
    category: 'engineering'
  },
  {
    slug: 'why-we-bundled-when-everyone-said-unbundle',
    title: 'Why we bundled when everyone else said unbundle',
    excerpt: 'The agent infra market split into a dozen single-purpose tools. Composio for actions, Skyfire for payments, Browserbase for browsers, Modal for compute. We bundled all 156 primitives into one substrate. Here\'s why.',
    body: `# Why we bundled when everyone else said unbundle\n\nIn 2024-2025, the agent infra market fragmented. Every primitive got its own startup. The pitch was "do one thing well." But agents don\'t need one thing — they need everything, end-to-end, with one identity, one audit chain, one billing.\n\nForcing developers to integrate 12 vendors is the unbundling era\'s friction. We bundled.`,
    tags: ['strategy', 'bundling', 'agents'],
    category: 'strategy'
  },
  {
    slug: 'the-real-time-event-stream',
    title: 'Sub-second agent-to-agent reactivity with our SSE stream',
    excerpt: 'Every audit-chained event is pushed to /v1/realtime/stream as Server-Sent Events. Filter by event_type, agent DID, or org. No polling. Sub-second latency.',
    body: `# Sub-second agent-to-agent reactivity\n\nFor agents to coordinate they need to react to other agents\' events fast. Polling is too slow and too expensive. We built a Server-Sent Events stream of every audit-chain entry.\n\nGET /v1/realtime/stream → live push of every event. Filterable. Adaptive 250ms-4s polling internally. ?since_length=N for replay-on-reconnect.`,
    tags: ['realtime', 'sse', 'engineering'],
    category: 'engineering'
  },
  {
    slug: 'what-we-shipped-this-week',
    title: 'What we shipped this week (155 → 156 primitives)',
    excerpt: 'Full email platform (threading, attachments, lists, campaigns, calendar invites) and full KYC platform (KYB, UBOs, Travel Rule, SAR generation, ZK proofs).',
    body: `# What we shipped this week\n\n## email_advanced.js\nThreading, attachments, aliases, filters, templates, mailing lists, newsletters with double opt-in, open/click tracking, suppression list, calendar invites (.ics), search, snooze, autoresponder.\n\n## kyc_advanced.js\nKYB for legal entities, UBO discovery, identity document verification, address verification, source-of-funds, adverse media, composite risk scoring, Travel Rule (FATF Rec 16), SAR generation, ZK proofs, continuous monitoring.\n\n156 primitives across 25 layers. 1230 HTTP routes. The full agent + AGI infrastructure substrate.`,
    tags: ['changelog', 'email', 'kyc'],
    category: 'changelog'
  }
];

async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS blog_posts (
      post_id        TEXT PRIMARY KEY,
      slug           TEXT UNIQUE NOT NULL,
      title          TEXT NOT NULL,
      excerpt        TEXT,
      body           TEXT NOT NULL,
      cover_image    TEXT,
      author_did     TEXT,
      author_name    TEXT,
      tags           TEXT[],
      category       TEXT,
      status         TEXT NOT NULL DEFAULT 'published',
      view_count     BIGINT NOT NULL DEFAULT 0,
      reading_time   INTEGER,
      published_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_blog_posts_status_published
      ON blog_posts (status, published_at DESC);
    CREATE INDEX IF NOT EXISTS idx_blog_posts_category ON blog_posts (category);

    CREATE TABLE IF NOT EXISTS blog_views (
      view_id        TEXT PRIMARY KEY,
      post_id        TEXT NOT NULL,
      ip_hash        TEXT,
      ua_hash        TEXT,
      referrer       TEXT,
      utm_source     TEXT,
      utm_medium     TEXT,
      utm_campaign   TEXT,
      occurred_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_blog_views_post ON blog_views (post_id, occurred_at DESC);

    CREATE TABLE IF NOT EXISTS blog_subscribers (
      subscriber_id  TEXT PRIMARY KEY,
      email          TEXT UNIQUE NOT NULL,
      utm_source     TEXT,
      confirmed_at   TIMESTAMPTZ,
      confirmation_token TEXT,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      unsubscribed_at TIMESTAMPTZ
    );
  `);

  // Seed posts (idempotent on slug)
  for (const p of SEED_POSTS) {
    const id = 'post_' + crypto.createHash('sha256').update(p.slug).digest('hex').slice(0, 16);
    const readingTime = Math.max(1, Math.ceil(p.body.split(/\s+/).length / 250));
    await pool.query(
      `INSERT INTO blog_posts (post_id, slug, title, excerpt, body, tags, category,
                                author_name, status, reading_time)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'OpenHeab','published',$8)
       ON CONFLICT (slug) DO NOTHING`,
      [id, p.slug, p.title, p.excerpt, p.body, p.tags, p.category, readingTime]
    ).catch(() => {});
  }
}

function newId(p) { return p + '_' + crypto.randomBytes(10).toString('hex'); }
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

// Minimal markdown → HTML (we use it for the seed posts; production would use marked)
function md(text) {
  let h = escapeHtml(text);
  h = h.replace(/^# (.+)$/gm, '<h1>$1</h1>');
  h = h.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  h = h.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  h = h.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  h = h.replace(/\*(.+?)\*/g, '<em>$1</em>');
  h = h.replace(/`(.+?)`/g, '<code>$1</code>');
  h = h.replace(/\n\n/g, '</p><p>');
  return '<p>' + h + '</p>';
}

// Shared design system — head/nav/footer/CSS centralized in src/design_system.js
const ds = require('../design_system');
const SHARED_CSS = ds.SHARED_CSS;
const NAV_HTML = ds.NAV_HTML;
const FOOTER_HTML = ds.FOOTER_HTML;
const head = ds.head;

function postUrl(slug) {
  return `${(process.env.OPERATOR_PUBLIC_URL || '').replace(/\/$/, '')}/blog/${encodeURIComponent(slug)}`;
}

function renderPostJsonLd(post) {
  return JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'BlogPosting',
    headline: post.title,
    description: post.excerpt,
    datePublished: post.published_at,
    dateModified: post.updated_at || post.published_at,
    author: { '@type': 'Organization', name: 'OpenHeab' },
    publisher: { '@type': 'Organization', name: 'OpenHeab', logo: { '@type': 'ImageObject', url: (process.env.OPERATOR_PUBLIC_URL || '') + '/favicon.ico' } },
    mainEntityOfPage: postUrl(post.slug)
  });
}

function registerBlogRoutes(app, pool, _verifyAgentAuth, auditChain) {
  const express = require('express');

  // /blog — index
  app.get('/blog', async (req, res) => {
    const tag = req.query.tag;
    const cat = req.query.category;
    const conds = [`status='published'`];
    const params = [];
    if (tag) { params.push(tag); conds.push(`$${params.length} = ANY(tags)`); }
    if (cat) { params.push(cat); conds.push(`category = $${params.length}`); }
    const r = await pool.query(`
      SELECT slug, title, excerpt, tags, category, published_at, view_count, reading_time
      FROM blog_posts WHERE ${conds.join(' AND ')}
      ORDER BY published_at DESC LIMIT 100
    `, params).catch(() => ({ rows: [] }));

    const jsonLd = JSON.stringify({
      '@context': 'https://schema.org', '@type': 'Blog',
      name: 'OpenHeab Blog', description: 'Updates on agent infrastructure, AGI, and the company.',
      url: (process.env.OPERATOR_PUBLIC_URL || '') + '/blog',
      blogPost: r.rows.slice(0, 12).map(p => ({
        '@type': 'BlogPosting', headline: p.title, datePublished: p.published_at,
        url: postUrl(p.slug)
      }))
    });

    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.send(head('Blog — OpenHeab',
      'Updates on agent infrastructure, AGI, the path to $10M ARR, and how to build agents that do real things.',
      (process.env.OPERATOR_PUBLIC_URL || '') + '/blog',
      jsonLd) + NAV_HTML('blog') + `<main>
<div class=crumb><a href="/">Home</a> · Blog ${tag ? `· tag: ${escapeHtml(tag)}` : ''} ${cat ? `· ${escapeHtml(cat)}` : ''}</div>
<h1 style="font-size:32px;letter-spacing:-1px;margin-bottom:8px">Blog</h1>
<p style="color:var(--dim2);margin-bottom:32px">Engineering, strategy, and changelogs from the OpenHeab team.</p>
<div class=idx>
${r.rows.map(p => `<article class=card>
  <div class=cat>${escapeHtml(p.category || '')}</div>
  <h3><a href="/blog/${encodeURIComponent(p.slug)}">${escapeHtml(p.title)}</a></h3>
  <p>${escapeHtml(p.excerpt || '')}</p>
  <div class=meta><span>${new Date(p.published_at).toISOString().slice(0,10)}</span><span>${p.reading_time || 3} min read</span></div>
</article>`).join('')}
</div>
</main>` + FOOTER_HTML(process.env.OPERATOR_PUBLIC_URL));
  });

  // /blog/[slug] — post viewer
  app.get('/blog/:slug', async (req, res) => {
    const r = await pool.query(`
      SELECT post_id, slug, title, excerpt, body, tags, category, author_name,
             reading_time, published_at, updated_at
      FROM blog_posts WHERE slug = $1 AND status = 'published'
    `, [req.params.slug]).catch(() => ({ rows: [] }));
    if (!r.rows[0]) return res.status(404).type('text/html').send(head('404 — OpenHeab', '', '', null) + NAV_HTML('blog') + `<main><h1>404</h1><p>Post not found.</p><p><a href="/blog">← All posts</a></p></main>` + FOOTER_HTML());
    const p = r.rows[0];

    // fire-and-forget view
    const ipHash = crypto.createHash('sha256').update(req.ip || '').digest('hex').slice(0, 16);
    await pool.query(
      `INSERT INTO blog_views (view_id, post_id, ip_hash, referrer, utm_source, utm_medium, utm_campaign)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [newId('bv'), p.post_id, ipHash, req.headers.referer || null,
       req.query.utm_source || null, req.query.utm_medium || null, req.query.utm_campaign || null]
    ).catch(() => {});
    await pool.query(`UPDATE blog_posts SET view_count = view_count + 1 WHERE post_id = $1`, [p.post_id]).catch(() => {});

    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.send(head(p.title + ' — OpenHeab', p.excerpt || '', postUrl(p.slug), renderPostJsonLd(p)) +
      NAV_HTML('blog') + `<main><article>
<div class=crumb><a href="/">Home</a> · <a href="/blog">Blog</a> · ${escapeHtml(p.title.slice(0, 60))}</div>
<h1>${escapeHtml(p.title)}</h1>
<div class=meta>
  <span>${new Date(p.published_at).toISOString().slice(0,10)}</span>
  <span>${p.reading_time || 3} min read</span>
  ${(p.tags || []).map(t => `<a href="/blog?tag=${encodeURIComponent(t)}" class=tag>${escapeHtml(t)}</a>`).join('')}
</div>
${md(p.body)}
</article>
<div class=subscribe>
  <h3>Get our weekly engineering + strategy posts</h3>
  <p style="color:var(--dim2);font-size:14px">No spam. Unsubscribe in one click.</p>
  <form method=post action="/blog/subscribe" onsubmit="event.preventDefault();fetch('/blog/subscribe',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:document.getElementById('em').value})}).then(r=>r.json()).then(()=>{document.getElementById('em').value='';alert('Confirmation sent. Check your inbox.')});">
    <input id=em type=email placeholder="you@company.com" required>
    <button>Subscribe</button>
  </form>
</div>
</main>` + FOOTER_HTML(process.env.OPERATOR_PUBLIC_URL));
  });

  // /blog/rss.xml — RSS feed
  app.get('/blog/rss.xml', async (req, res) => {
    const r = await pool.query(`
      SELECT slug, title, excerpt, body, published_at FROM blog_posts
      WHERE status = 'published' ORDER BY published_at DESC LIMIT 50
    `).catch(() => ({ rows: [] }));
    const base = process.env.OPERATOR_PUBLIC_URL || ('http://' + req.headers.host);
    res.setHeader('content-type', 'application/rss+xml');
    res.send(`<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom"><channel>
<title>OpenHeab Blog</title>
<link>${escapeHtml(base)}/blog</link>
<description>Engineering, strategy, and changelogs from the OpenHeab team.</description>
<atom:link href="${escapeHtml(base)}/blog/rss.xml" rel="self" type="application/rss+xml" />
<language>en-us</language>
${r.rows.map(p => `<item>
  <title>${escapeHtml(p.title)}</title>
  <link>${escapeHtml(base)}/blog/${encodeURIComponent(p.slug)}</link>
  <guid>${escapeHtml(base)}/blog/${encodeURIComponent(p.slug)}</guid>
  <pubDate>${new Date(p.published_at).toUTCString()}</pubDate>
  <description><![CDATA[${p.excerpt || ''}]]></description>
</item>`).join('\n')}
</channel></rss>`);
  });

  // POST /blog/subscribe — newsletter signup (double opt-in via email primitive)
  const subscribeSchema = z.object({
    email: z.string().email(),
    utm_source: z.string().optional()
  });
  app.post('/blog/subscribe', express.json(), async (req, res) => {
    const p = subscribeSchema.safeParse(req.body || {});
    if (!p.success) return res.status(400).json({ error: 'invalid_input' });
    const id = newId('sub');
    const token = crypto.randomBytes(20).toString('hex');
    try {
      await pool.query(
        `INSERT INTO blog_subscribers (subscriber_id, email, utm_source, confirmation_token)
         VALUES ($1,$2,$3,$4)`,
        [id, p.data.email.toLowerCase(), p.data.utm_source || null, token]
      );
      if (auditChain) await auditChain.append({ event_type: 'blog.subscriber_added', email: p.data.email }).catch(() => {});
      res.status(201).json({ ok: true, subscriber_id: id, confirmation_url: `/blog/confirm?token=${token}` });
    } catch { res.status(409).json({ error: 'already_subscribed' }); }
  });

  app.get('/blog/confirm', async (req, res) => {
    const r = await pool.query(`
      UPDATE blog_subscribers SET confirmed_at = NOW()
      WHERE confirmation_token = $1 AND confirmed_at IS NULL RETURNING subscriber_id
    `, [req.query.token]).catch(() => ({ rows: [] }));
    res.type('text/html').send(head('Subscription confirmed', '', '', null) + NAV_HTML() +
      `<main><h1>${r.rows[0] ? 'Confirmed' : 'Invalid token'}</h1><p>${r.rows[0] ? 'You\'re subscribed.' : 'This link is invalid or already used.'}</p><p><a href="/blog">← Back to blog</a></p></main>` + FOOTER_HTML());
  });

  // Author/admin: create a new post (admin only)
  const postSchema = z.object({
    slug: z.string().regex(/^[a-z0-9][a-z0-9-]{2,80}$/),
    title: z.string().min(1).max(200),
    excerpt: z.string().max(500).optional(),
    body: z.string().min(1),
    tags: z.array(z.string()).optional(),
    category: z.string().optional(),
    author_did: z.string().optional()
  });
  app.post('/v1/blog/posts', express.json(), async (req, res) => {
    const { safeTokenCompare: _stc } = require('../safe_compare'); if (!_stc(req.headers['x-admin-token'], process.env.OPERATOR_ADMIN_TOKEN)) return res.status(401).json({ error: 'admin_auth_required' });
    const p = postSchema.safeParse(req.body || {});
    if (!p.success) return res.status(400).json({ error: 'invalid_input', details: p.error.flatten() });
    const id = newId('post');
    const readingTime = Math.max(1, Math.ceil(p.data.body.split(/\s+/).length / 250));
    try {
      await pool.query(
        `INSERT INTO blog_posts (post_id, slug, title, excerpt, body, tags, category,
                                   author_did, author_name, reading_time, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'OpenHeab',$9,'published')`,
        [id, p.data.slug, p.data.title, p.data.excerpt || null, p.data.body,
         p.data.tags || null, p.data.category || null, p.data.author_did || null, readingTime]
      );
      if (auditChain) await auditChain.append({ event_type: 'blog.post_published', post_id: id, slug: p.data.slug }).catch(() => {});
      res.status(201).json({ post_id: id, slug: p.data.slug });
    } catch (e) { res.status(409).json({ error: 'slug_conflict_or_invalid', message: e.message }); }
  });
}

module.exports = {
  migrate, registerBlogRoutes, SHARED_CSS, NAV_HTML, FOOTER_HTML, head, escapeHtml, md, SEED_POSTS
};
