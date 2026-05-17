// ============================================================================
// design_system.js — single source of visual truth for every public page.
//
// Every marketing surface (landing, blog, docs, pricing, customers, about,
// jobs, press, security, status, changelog, roadmap, signup, dashboard,
// tour, activity, sdk, console, legal) imports head + nav + footer from
// this module. Updating colors / spacing / animation in one place cascades
// across the entire openheab.com site.
//
// Design philosophy (Emil Kowalski):
//   - Specific transition properties, never `all`
//   - Custom easing curves (--ease-out / --ease-in-out / --ease-snap)
//   - :active scale(0.97) instant press feedback on every clickable
//   - @starting-style or animation:rise for natural entry
//   - Stagger 40-80ms; never block interaction
//   - @media (prefers-reduced-motion:reduce) clamps to 1ms
//   - @media (hover:none) zeros out hover transforms for touch
// ============================================================================

function publicUrl() {
  return (process.env.OPERATOR_PUBLIC_URL || 'https://openheab.com').replace(/\/$/, '');
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ----------------------------------------------------------------------------
// The single CSS payload — ~9KB minified. Embedded inline in <head>.
// ----------------------------------------------------------------------------
const SHARED_CSS = `
:root{
  --bg:#08090b;
  --bg-elev:#0d0e10;
  --bg-elev2:#111316;
  --br:#1d1f23;
  --br-strong:#2a2c31;

  --fg:#f4f4f5;
  --fg-dim:#a1a1aa;
  --fg-dim2:#71717a;
  --fg-dim3:#52525b;

  --acc:#7dd3fc;
  --acc-strong:#38bdf8;
  --acc-glow:rgba(125,211,252,0.18);
  --acc-text:#03161f;

  --good:#34d399;
  --warn:#fbbf24;
  --bad:#f87171;

  --mono:ui-monospace,'SF Mono','JetBrains Mono',Menlo,Consolas,monospace;
  --sans:-apple-system,BlinkMacSystemFont,'Inter','SF Pro Display','Segoe UI',system-ui,sans-serif;

  --ease-out:cubic-bezier(0.23, 1, 0.32, 1);
  --ease-in-out:cubic-bezier(0.77, 0, 0.175, 1);
  --ease-snap:cubic-bezier(0.32, 0.72, 0, 1);

  --t-fast:120ms;
  --t-med:180ms;
  --t-slow:280ms;

  /* Legacy alias tokens — keep older inline styles still working */
  --card:#0d0e10;
  --dim:#71717a;
  --dim2:#a1a1aa;
  --r-sm:6px;
  --r-md:8px;
  --r-lg:10px;
  --r-xl:12px;
  --r-2xl:14px;
  --r-full:99px;
}

*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html{scroll-behavior:smooth;-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
body{
  font:15px/1.55 var(--sans);
  background:var(--bg);
  color:var(--fg);
  font-feature-settings:'cv11','ss01','ss03';
  background-image:radial-gradient(circle at 50% -200px,rgba(125,211,252,0.06),transparent 700px);
  min-height:100vh;
}

::selection{background:var(--acc);color:var(--acc-text)}
::-moz-selection{background:var(--acc);color:var(--acc-text)}

a{color:var(--acc);text-decoration:none;transition:color var(--t-fast) var(--ease-out)}
a:hover{color:var(--acc-strong)}

code,pre,.mono{font-family:var(--mono)}

/* ---------- Nav ---------- */
nav.site{
  display:flex;justify-content:space-between;align-items:center;
  padding:14px 28px;border-bottom:1px solid var(--br);
  position:sticky;top:0;
  background:rgba(8,9,11,0.7);
  backdrop-filter:blur(14px) saturate(180%);
  -webkit-backdrop-filter:blur(14px) saturate(180%);
  z-index:50;
}
nav.site .brand{
  font:600 15px/1 var(--mono);letter-spacing:-0.4px;color:var(--fg);
  display:inline-flex;align-items:center;gap:6px;
  transition:opacity var(--t-fast) var(--ease-out);
}
nav.site .brand:hover{opacity:0.85;color:var(--fg)}
nav.site .brand .dot{
  display:inline-block;width:6px;height:6px;background:var(--acc);
  border-radius:50%;box-shadow:0 0 10px var(--acc-glow);
}
nav.site .links{display:flex;gap:4px;align-items:center}
nav.site .links a{
  color:var(--fg-dim);font-size:13.5px;padding:7px 11px;border-radius:6px;
  transition:color var(--t-fast) var(--ease-out),background-color var(--t-fast) var(--ease-out);
}
nav.site .links a:hover{color:var(--fg);background:var(--bg-elev)}
nav.site .links a[aria-current="page"]{color:var(--fg);background:var(--bg-elev)}
nav.site .cta{
  background:var(--fg);color:var(--bg);
  padding:7px 13px;border-radius:7px;
  font-weight:600;font-size:13px;border:1px solid var(--fg);
  transition:transform var(--t-fast) var(--ease-out),background-color var(--t-fast) var(--ease-out);
  display:inline-flex;align-items:center;gap:5px;margin-left:6px;
}
nav.site .cta:hover{background:#e4e4e7;color:var(--bg)}
nav.site .cta:active{transform:scale(0.97)}

/* ---------- Main wrapper ---------- */
main{max-width:1080px;margin:0 auto;padding:0 28px}
main.narrow{max-width:760px}

/* ---------- Hero ---------- */
.hero{padding:96px 0 72px;position:relative}
.hero::after{
  content:'';position:absolute;left:0;right:0;bottom:0;height:1px;
  background:linear-gradient(90deg,transparent,var(--br),transparent);
}

.pill{
  display:inline-flex;gap:8px;align-items:center;
  padding:5px 11px 5px 9px;border:1px solid var(--br);
  background:var(--bg-elev);border-radius:99px;
  font:500 12px/1 var(--mono);color:var(--fg-dim);
  margin-bottom:28px;
  transition:border-color var(--t-fast) var(--ease-out);
}
.pill:hover{border-color:var(--br-strong)}
.pill .live{
  width:6px;height:6px;border-radius:50%;background:var(--good);
  box-shadow:0 0 8px var(--good);
  animation:pulse 2.4s var(--ease-in-out) infinite;
}
@keyframes pulse{
  0%,100%{opacity:1;transform:scale(1)}
  50%{opacity:0.55;transform:scale(0.92)}
}

h1{font-size:clamp(34px,5.5vw,56px);line-height:1.05;letter-spacing:-1.8px;margin:0 0 22px;font-weight:600;color:var(--fg);max-width:920px}
.hero h1{font-size:clamp(38px,6vw,64px);line-height:1.02;letter-spacing:-2.2px}
.hero h1 em{
  font-style:normal;
  background:linear-gradient(180deg,var(--acc),var(--acc-strong));
  -webkit-background-clip:text;background-clip:text;color:transparent;
}
p.lede{
  font-size:18px;color:var(--fg-dim);
  max-width:660px;margin:0 0 36px;
  line-height:1.55;letter-spacing:-0.1px;
}

/* ---------- Buttons ---------- */
.btns{display:flex;gap:10px;flex-wrap:wrap}
.btn{
  padding:10px 18px;border-radius:8px;
  font-weight:550;font-size:14px;
  display:inline-flex;align-items:center;gap:7px;
  border:1px solid var(--br);background:var(--bg-elev);color:var(--fg);
  cursor:pointer;text-decoration:none;
  transition:
    transform var(--t-fast) var(--ease-out),
    background-color var(--t-fast) var(--ease-out),
    border-color var(--t-fast) var(--ease-out);
  -webkit-tap-highlight-color:transparent;
}
.btn:hover{background:var(--bg-elev2);border-color:var(--br-strong);text-decoration:none;color:var(--fg)}
.btn:active{transform:scale(0.97)}

.btn.primary{background:var(--fg);color:var(--bg);border-color:var(--fg)}
.btn.primary:hover{background:#e4e4e7;color:var(--bg)}

.btn.ghost{background:transparent}
.btn.ghost:hover{background:var(--bg-elev)}

.btn .arr{display:inline-block;transition:transform var(--t-fast) var(--ease-out)}
.btn:hover .arr{transform:translateX(2px)}

/* ---------- Metrics strip ---------- */
.metrics{
  display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:0;
  margin:56px 0 0;border:1px solid var(--br);border-radius:12px;overflow:hidden;
  background:var(--bg-elev);
}
.metric{
  padding:20px 22px;border-right:1px solid var(--br);position:relative;
  transition:background-color var(--t-fast) var(--ease-out);
}
.metric:last-child{border-right:0}
.metric:hover{background:var(--bg-elev2)}
.metric .v{
  font:600 28px/1 var(--mono);color:var(--fg);
  letter-spacing:-1.2px;font-feature-settings:'tnum';
}
.metric .l{
  font:500 10.5px/1 var(--mono);color:var(--fg-dim2);
  text-transform:uppercase;letter-spacing:1.4px;margin-top:7px;
}

/* ---------- Sections ---------- */
.section{padding:72px 0;border-bottom:1px solid var(--br)}
.section:last-of-type{border-bottom:0}
.section h2{font-size:30px;margin:0 0 14px;letter-spacing:-1.2px;font-weight:600;line-height:1.15;max-width:760px}
.section .sub{color:var(--fg-dim);margin:0 0 40px;max-width:620px;font-size:16px;line-height:1.6}
.eyebrow{
  font:500 11px/1 var(--mono);color:var(--acc);
  text-transform:uppercase;letter-spacing:1.8px;margin:0 0 14px;
}

/* ---------- Cards ---------- */
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px}
.card{
  background:var(--bg-elev);border:1px solid var(--br);border-radius:12px;padding:22px;
  transition:
    border-color var(--t-med) var(--ease-out),
    background-color var(--t-med) var(--ease-out),
    transform var(--t-med) var(--ease-out);
}
.card:hover{border-color:var(--br-strong);background:var(--bg-elev2);transform:translateY(-1px)}
.card .icn,.card .cat{
  font:500 10.5px/1 var(--mono);color:var(--acc);
  margin-bottom:12px;letter-spacing:1.4px;text-transform:uppercase;
}
.card h3{margin:0 0 8px;font-size:15.5px;font-weight:600;color:var(--fg);letter-spacing:-0.2px}
.card h3 a{color:var(--fg)}
.card h3 a:hover{color:var(--acc)}
.card p{margin:0;color:var(--fg-dim);font-size:13.5px;line-height:1.55}
.card .meta{font:500 11px/1 var(--mono);color:var(--fg-dim2);display:flex;gap:12px;margin-top:10px}

/* ---------- Layer grid (landing-specific but reusable) ---------- */
.layers{
  display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:1px;
  background:var(--br);border:1px solid var(--br);border-radius:12px;overflow:hidden;
}
.layer{background:var(--bg-elev);padding:18px 20px;transition:background-color var(--t-fast) var(--ease-out)}
.layer:hover{background:var(--bg-elev2)}
.layer .ln{font:600 10.5px/1 var(--mono);color:var(--acc);margin-bottom:8px;letter-spacing:1.4px}
.layer h4{font-size:13.5px;margin:0 0 8px;font-weight:600;color:var(--fg)}
.layer .prims{font:500 12px/1.55 var(--mono);color:var(--fg-dim);word-break:break-word}

/* ---------- Code window ---------- */
.codewin{background:var(--bg-elev);border:1px solid var(--br);border-radius:12px;overflow:hidden;margin:8px 0}
.codewin .bar{display:flex;align-items:center;gap:6px;padding:11px 14px;background:var(--bg-elev2);border-bottom:1px solid var(--br)}
.codewin .bar .dots{display:flex;gap:6px;align-items:center}
.codewin .bar .dot{width:11px;height:11px;border-radius:50%;background:var(--bg)}
.codewin .bar .title{margin-left:10px;font:500 12px/1 var(--mono);color:var(--fg-dim2)}
pre.code{background:transparent;padding:18px 22px;font:13px/1.65 var(--mono);overflow:auto;margin:0;color:var(--fg-dim);font-feature-settings:'liga' 0}
pre.code .k{color:var(--acc)}
pre.code .s{color:#bef264}
pre.code .c{color:var(--fg-dim3);font-style:italic}
pre.code .n{color:#fde68a}

/* ---------- Tables ---------- */
.tablewrap{border:1px solid var(--br);border-radius:12px;overflow:hidden;background:var(--bg-elev)}
table{width:100%;border-collapse:collapse;font-size:14px}
th,td{padding:14px 18px;text-align:left;border-bottom:1px solid var(--br)}
tr:last-child td{border-bottom:0}
tr{transition:background-color var(--t-fast) var(--ease-out)}
tbody tr:hover{background:var(--bg-elev2)}
th{font:600 11px/1 var(--mono);color:var(--fg-dim2);text-transform:uppercase;letter-spacing:1.2px;background:var(--bg-elev2)}
.price{font:600 22px/1 var(--mono);color:var(--fg);letter-spacing:-0.8px;font-feature-settings:'tnum'}
.price small{font-size:12.5px;color:var(--fg-dim2);font-weight:400;letter-spacing:0}

/* ---------- Forms ---------- */
input,select,textarea{
  background:var(--bg-elev);color:var(--fg);border:1px solid var(--br);border-radius:8px;
  padding:10px 13px;font:500 14px/1.4 var(--sans);outline:none;width:100%;
  transition:border-color var(--t-fast) var(--ease-out),background-color var(--t-fast) var(--ease-out),box-shadow var(--t-fast) var(--ease-out);
}
input:focus,select:focus,textarea:focus{border-color:var(--acc);background:var(--bg-elev2);box-shadow:0 0 0 3px var(--acc-glow)}
input[type="search"]{font-family:var(--mono);font-size:13px}
label{font:500 12.5px/1.4 var(--sans);color:var(--fg-dim);margin-bottom:6px;display:block}

/* ---------- Subscribe card (used by blog) ---------- */
.subscribe{background:var(--bg-elev);border:1px solid var(--br);border-radius:12px;padding:24px;margin:48px 0}
.subscribe h3{font-size:16px;margin-bottom:8px;color:var(--fg)}
.subscribe p{color:var(--fg-dim);font-size:14px}
.subscribe form{display:flex;gap:8px;margin-top:14px}
.subscribe input{flex:1}
.subscribe button{
  background:var(--fg);color:var(--bg);border:0;
  padding:10px 18px;border-radius:8px;
  font-weight:600;font-size:13px;cursor:pointer;font-family:var(--sans);
  transition:transform var(--t-fast) var(--ease-out),background-color var(--t-fast) var(--ease-out);
}
.subscribe button:hover{background:#e4e4e7}
.subscribe button:active{transform:scale(0.97)}

/* ---------- Article (blog post) ---------- */
article h1{font-size:38px;letter-spacing:-1.5px;line-height:1.1;margin:0 0 14px}
article .meta{color:var(--fg-dim2);font-size:13px;margin-bottom:32px;display:flex;gap:14px;flex-wrap:wrap}
article .meta .tag{padding:2px 8px;border:1px solid var(--br);border-radius:99px;font:500 11px/1.4 var(--mono);color:var(--fg-dim)}
article p{margin:0 0 18px;color:var(--fg-dim);font-size:17px;line-height:1.75}
article h2{font-size:26px;margin:40px 0 14px;letter-spacing:-0.5px;color:var(--fg)}
article h3{font-size:20px;margin:28px 0 10px;color:var(--fg)}
article code{background:var(--bg-elev);padding:2px 6px;border-radius:4px;border:1px solid var(--br);font-size:13px}
article pre{background:var(--bg-elev);border:1px solid var(--br);border-radius:10px;padding:14px 18px;overflow:auto;margin:18px 0}
article pre code{padding:0;border:0;background:transparent;display:block;font-size:13px;line-height:1.6;color:var(--fg-dim)}
article ul,article ol{padding-left:22px;color:var(--fg-dim);margin-bottom:18px}
article li{margin:6px 0;line-height:1.65;font-size:16px}
article blockquote{border-left:3px solid var(--acc);padding:4px 0 4px 16px;margin:18px 0;color:var(--fg-dim);font-style:italic}

/* ---------- Breadcrumb ---------- */
.crumb{font-size:12.5px;color:var(--fg-dim2);margin-bottom:18px;font-family:var(--mono)}
.crumb a{color:var(--fg-dim)}
.crumb a:hover{color:var(--fg)}

/* ---------- Index list (blog/changelog) ---------- */
.idx{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px;margin:32px 0}

/* ---------- Footer ---------- */
footer{
  max-width:1080px;margin:60px auto 40px;padding:24px 28px 0;
  border-top:1px solid var(--br);color:var(--fg-dim2);font-size:12px;
  display:flex;flex-wrap:wrap;justify-content:space-between;gap:16px;
}
footer .l{display:flex;gap:18px;flex-wrap:wrap}
footer a{color:var(--fg-dim);transition:color var(--t-fast) var(--ease-out)}
footer a:hover{color:var(--fg)}

/* ---------- Hero entry animations ---------- */
.hero h1,.hero p.lede,.hero .btns,.hero .pill,.hero .metrics{animation:rise 600ms var(--ease-out) both}
.hero .pill{animation-delay:0ms}
.hero h1{animation-delay:60ms}
.hero p.lede{animation-delay:120ms}
.hero .btns{animation-delay:180ms}
.hero .metrics{animation-delay:240ms}
@keyframes rise{
  from{opacity:0;transform:translateY(8px)}
  to{opacity:1;transform:translateY(0)}
}
.grid > .card,.idx > .card{animation:rise 500ms var(--ease-out) both}
.grid > .card:nth-child(1),.idx > .card:nth-child(1){animation-delay:0ms}
.grid > .card:nth-child(2),.idx > .card:nth-child(2){animation-delay:40ms}
.grid > .card:nth-child(3),.idx > .card:nth-child(3){animation-delay:80ms}
.grid > .card:nth-child(4),.idx > .card:nth-child(4){animation-delay:120ms}
.grid > .card:nth-child(5),.idx > .card:nth-child(5){animation-delay:160ms}
.grid > .card:nth-child(6),.idx > .card:nth-child(6){animation-delay:200ms}
.grid > .card:nth-child(7),.idx > .card:nth-child(7){animation-delay:240ms}
.grid > .card:nth-child(8),.idx > .card:nth-child(8){animation-delay:280ms}

/* ---------- Reduced motion + touch ---------- */
@media (prefers-reduced-motion:reduce){
  *,*::before,*::after{animation-duration:1ms !important;animation-iteration-count:1 !important;transition-duration:1ms !important}
  html{scroll-behavior:auto}
  .pill .live{animation:none}
}
@media (hover:none){
  .card:hover,.layer:hover,.metric:hover,tbody tr:hover{background:var(--bg-elev);transform:none;border-color:var(--br)}
}

/* ---------- Mobile ---------- */
@media (max-width:760px){
  nav.site{padding:12px 18px}
  nav.site .links a:not(.cta){display:none}
  nav.site .links{gap:0}
  main{padding:0 18px}
  .hero{padding:64px 0 52px}
  .section{padding:52px 0}
  .section h2{font-size:24px;letter-spacing:-1px}
  .metric{padding:16px 18px}
  .metric .v{font-size:24px}
  th,td{padding:11px 12px;font-size:13px}
  .layer{padding:14px 16px}
  pre.code{padding:14px 16px;font-size:12px}
  article h1{font-size:28px}
  article p{font-size:16px}
}
@media (max-width:420px){
  .hero h1{font-size:32px;letter-spacing:-1.4px}
  p.lede{font-size:16px}
}
`;

// ----------------------------------------------------------------------------
// Nav — receives `active` as a string key (e.g. 'docs', 'pricing').
// ----------------------------------------------------------------------------
function NAV_HTML(active = '') {
  const link = (path, label, key) => {
    const ac = active === key ? ' aria-current="page"' : '';
    return `<a href="${path}"${ac}>${label}</a>`;
  };
  return `<nav class="site">
  <a href="/" class="brand">openheab<span class="dot"></span></a>
  <div class="links">
    ${link('/docs', 'Docs', 'docs')}
    ${link('/pricing', 'Pricing', 'pricing')}
    ${link('/blog', 'Blog', 'blog')}
    ${link('/customers', 'Customers', 'customers')}
    ${link('/console', 'Console', 'console')}
    <a href="https://github.com/jmtrades/openheab-agent-infra">GitHub</a>
    <a href="/signup" class="cta">Get started <span aria-hidden="true">→</span></a>
  </div>
</nav>`;
}

// ----------------------------------------------------------------------------
// Footer — comprehensive sitemap.
// ----------------------------------------------------------------------------
function FOOTER_HTML() {
  const year = new Date().getFullYear();
  return `<footer>
  <span>Apache-2.0 · open source · self-hostable · &copy; ${year} OpenHeab Inc.</span>
  <span class="l">
    <a href="/about">About</a>
    <a href="/jobs">Jobs</a>
    <a href="/press">Press</a>
    <a href="/security">Trust</a>
    <a href="/legal/terms">Terms</a>
    <a href="/legal/privacy">Privacy</a>
    <a href="/changelog">Changelog</a>
    <a href="/status">Status</a>
    <a href="/openapi.json">API</a>
    <a href="https://github.com/jmtrades/openheab-agent-infra">GitHub</a>
  </span>
</footer></body></html>`;
}

// ----------------------------------------------------------------------------
// head() — unified head tag. Supports two call signatures for backward
// compatibility:
//   - head(title, description, opts={})                 ← new style
//   - head(title, description, canonical, jsonLd, ogImage) ← blog legacy
// ----------------------------------------------------------------------------
function head(title, description, optsOrCanonical, jsonLdLegacy, ogImageLegacy) {
  let opts;
  if (typeof optsOrCanonical === 'string' || optsOrCanonical == null) {
    opts = {
      canonical: optsOrCanonical || undefined,
      jsonLd: jsonLdLegacy || undefined,
      ogImage: ogImageLegacy || undefined
    };
  } else {
    opts = optsOrCanonical || {};
  }
  const path = opts.path || '/';
  const canonical = opts.canonical || `${publicUrl()}${path}`;
  const ogImage = opts.ogImage || `${publicUrl()}/og.svg`;
  const jsonLd = opts.jsonLd
    ? (Array.isArray(opts.jsonLd) ? opts.jsonLd : [opts.jsonLd])
        .map(j => `<script type="application/ld+json">${typeof j === 'string' ? j : JSON.stringify(j)}</script>`)
        .join('\n')
    : '';
  const extraHead = opts.extraHead || '';

  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description || '')}">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="canonical" href="${escapeHtml(canonical)}">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<link rel="apple-touch-icon" href="/favicon.svg">
<link rel="manifest" href="/site.webmanifest">
<link rel="alternate" type="application/rss+xml" title="OpenHeab Blog" href="/blog/rss.xml">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(description || '')}">
<meta property="og:type" content="${opts.ogType || 'website'}">
<meta property="og:url" content="${escapeHtml(canonical)}">
<meta property="og:site_name" content="OpenHeab">
<meta property="og:image" content="${escapeHtml(ogImage)}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:site" content="@openheab">
<meta name="twitter:title" content="${escapeHtml(title)}">
<meta name="twitter:description" content="${escapeHtml(description || '')}">
<meta name="twitter:image" content="${escapeHtml(ogImage)}">
<meta name="theme-color" content="#08090b">
<meta name="color-scheme" content="dark">
${jsonLd}
${extraHead}
<style>${SHARED_CSS}</style>
</head><body>`;
}

// ----------------------------------------------------------------------------
// page() — convenience: returns a full HTML document with nav + main + footer.
// ----------------------------------------------------------------------------
function page(title, description, opts = {}) {
  const headStr = head(title, description, opts);
  const navStr = NAV_HTML(opts.active || '');
  const mainClass = opts.narrow ? 'narrow' : '';
  const inner = opts.content || '';
  return `${headStr}${navStr}<main class="${mainClass}">${inner}</main>${FOOTER_HTML()}`;
}

module.exports = {
  SHARED_CSS, NAV_HTML, FOOTER_HTML, head, page,
  escapeHtml, publicUrl
};
