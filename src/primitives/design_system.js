// ============================================================================
// design_system.js — central design tokens + reusable HTML component helpers.
// Every surface (landing, dashboard, blog, marketing pages, quote viewer, etc.)
// imports tokens + components from here so the visual language stays unified.
// ============================================================================

const TOKENS = {
  color: {
    bg: '#0a0a0a', card: '#0f0f0f', card2: '#141414',
    fg: '#f0f0f0', dim: '#7a7a7a', dim2: '#bdbdbd',
    acc: '#7df9ff', acc2: '#3da3a8', accDim: '#a4fcff',
    good: '#22c55e', warn: '#f59e0b', bad: '#ef4444', info: '#7df9ff',
    border: '#1a1a1a', border2: '#222222'
  },
  font: {
    sans: "-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,system-ui,sans-serif",
    mono: "ui-monospace,'SF Mono','JetBrains Mono',Menlo,Consolas,monospace",
    display: "-apple-system,BlinkMacSystemFont,'Inter Display',Inter,system-ui,sans-serif"
  },
  radius: { sm: '4px', md: '6px', lg: '8px', xl: '10px', xxl: '14px', full: '999px' },
  shadow: {
    sm: '0 1px 2px rgba(0,0,0,.4)',
    md: '0 4px 12px rgba(0,0,0,.5)',
    glow: '0 0 24px rgba(125,249,255,.15)'
  },
  motion: {
    fast: '120ms cubic-bezier(.2,0,0,1)',
    base: '200ms cubic-bezier(.2,0,0,1)',
    slow: '320ms cubic-bezier(.2,0,0,1)'
  }
};

// CSS variables emitted as a :root block
const CSS_VARS = `:root{
--bg:${TOKENS.color.bg};--card:${TOKENS.color.card};--card2:${TOKENS.color.card2};
--fg:${TOKENS.color.fg};--dim:${TOKENS.color.dim};--dim2:${TOKENS.color.dim2};
--acc:${TOKENS.color.acc};--acc2:${TOKENS.color.acc2};--acc-dim:${TOKENS.color.accDim};
--good:${TOKENS.color.good};--warn:${TOKENS.color.warn};--bad:${TOKENS.color.bad};--info:${TOKENS.color.info};
--br:${TOKENS.color.border};--br2:${TOKENS.color.border2};
--mono:${TOKENS.font.mono};--sans:${TOKENS.font.sans};--display:${TOKENS.font.display};
--r-sm:${TOKENS.radius.sm};--r-md:${TOKENS.radius.md};--r-lg:${TOKENS.radius.lg};--r-xl:${TOKENS.radius.xl};--r-xxl:${TOKENS.radius.xxl};
--sh-sm:${TOKENS.shadow.sm};--sh-md:${TOKENS.shadow.md};--sh-glow:${TOKENS.shadow.glow};
--mo-fast:${TOKENS.motion.fast};--mo-base:${TOKENS.motion.base};--mo-slow:${TOKENS.motion.slow};
}
@media(prefers-color-scheme:light){
:root.theme-auto{--bg:#fafafa;--card:#ffffff;--card2:#f5f5f5;--fg:#0a0a0a;--dim:#888;--dim2:#444;--br:#e5e5e5;--br2:#d0d0d0}
}
.theme-light{--bg:#fafafa;--card:#ffffff;--card2:#f5f5f5;--fg:#0a0a0a;--dim:#888;--dim2:#444;--br:#e5e5e5;--br2:#d0d0d0}
*{box-sizing:border-box;margin:0;padding:0}
html{scroll-behavior:smooth;color-scheme:dark light}
body{font:15px/1.55 var(--sans);background:var(--bg);color:var(--fg);font-feature-settings:'cv11','ss01','ss03'}
*:focus-visible{outline:2px solid var(--acc);outline-offset:2px;border-radius:var(--r-sm)}
::selection{background:var(--acc);color:#001a1f}
a{color:var(--acc);text-decoration:none}
a:hover{text-decoration:underline;text-decoration-color:var(--acc2);text-decoration-thickness:2px;text-underline-offset:3px}
code,pre,.mono{font-family:var(--mono)}
.btn{padding:9px 16px;border-radius:var(--r-md);font:600 13px/1 var(--sans);border:1px solid var(--br);background:transparent;color:var(--fg);cursor:pointer;transition:all var(--mo-fast);display:inline-flex;align-items:center;gap:6px;text-decoration:none}
.btn:hover{border-color:var(--dim2);text-decoration:none}
.btn.primary{background:var(--acc);color:#001a1f;border-color:var(--acc);font-weight:700}
.btn.primary:hover{background:var(--acc-dim);transform:translateY(-1px);box-shadow:var(--sh-glow)}
.btn.danger{color:var(--bad);border-color:rgba(239,68,68,.3)}
.btn.ghost{background:transparent}
.kpi{background:var(--card);border:1px solid var(--br);border-radius:var(--r-xl);padding:18px}
.kpi .label{font:500 10px/1 var(--mono);color:var(--dim);text-transform:uppercase;letter-spacing:1.2px}
.kpi .value{font:700 24px/1.1 var(--mono);color:var(--fg);letter-spacing:-1px;margin:8px 0 4px}
.kpi .delta{font:500 12px/1 var(--mono);color:var(--good)}
.kpi .delta.bad{color:var(--bad)}.kpi .delta.warn{color:var(--warn)}
.badge{display:inline-block;padding:2px 8px;border-radius:var(--r-full);font:500 10px/1.5 var(--mono);text-transform:uppercase;letter-spacing:1px;border:1px solid currentColor}
.b-good{color:var(--good)}.b-warn{color:var(--warn)}.b-bad{color:var(--bad)}.b-dim{color:var(--dim)}.b-acc{color:var(--acc)}
.card{background:var(--card);border:1px solid var(--br);border-radius:var(--r-xl);padding:18px;transition:border-color var(--mo-fast)}
.card:hover{border-color:var(--dim)}
table{width:100%;border-collapse:collapse;font-size:14px}
th,td{padding:10px 14px;text-align:left;border-bottom:1px solid var(--br)}
th{font:500 10px/1 var(--mono);color:var(--dim);text-transform:uppercase;letter-spacing:1.2px;background:rgba(255,255,255,.02)}
tr:last-child td{border-bottom:0}
input,select,textarea{background:var(--card);color:var(--fg);border:1px solid var(--br);border-radius:var(--r-md);padding:10px 12px;font:500 14px/1.4 var(--sans);outline:none;width:100%}
input:focus,select:focus,textarea:focus{border-color:var(--acc)}
.skeleton{background:linear-gradient(90deg,var(--card) 25%,var(--card2) 50%,var(--card) 75%);background-size:200% 100%;animation:sk 1.4s infinite}
@keyframes sk{0%{background-position:200% 0}100%{background-position:-200% 0}}
.toast{position:fixed;top:20px;right:20px;background:var(--card);border:1px solid var(--br);border-radius:var(--r-lg);padding:12px 18px;box-shadow:var(--sh-md);z-index:100;font-size:14px;animation:slidein var(--mo-base)}
@keyframes slidein{from{transform:translateY(-10px);opacity:0}to{transform:translateY(0);opacity:1}}
@media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}`;

// HTML component helpers
function renderKpi({ label, value, delta = null, deltaClass = '' }) {
  return `<div class="kpi"><div class="label">${label}</div><div class="value">${value}</div>${delta ? `<div class="delta ${deltaClass}">${delta}</div>` : ''}</div>`;
}
function renderBadge(text, kind = 'dim') { return `<span class="badge b-${kind}">${text}</span>`; }
function renderTable({ headers, rows, empty = 'No data.' }) {
  if (!rows || rows.length === 0) return `<div style="padding:48px;text-align:center;color:var(--dim)">${empty}</div>`;
  return `<table><thead><tr>${headers.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${r.map(c => `<td>${c == null ? '' : c}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}

// Command palette HTML/JS — drop-in <div id="ohb-cmdk"> + <script src="/v1/design/cmdk.js">
const CMDK_JS = (commands) => `(function(){
var CMDS = ${JSON.stringify(commands)};
var KEY = 'k';
function open(){
  if(document.getElementById('ohb-cmdk-modal')) return;
  var m = document.createElement('div');
  m.id = 'ohb-cmdk-modal';
  m.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:999;display:flex;align-items:flex-start;justify-content:center;padding:80px 20px;backdrop-filter:blur(4px)';
  m.innerHTML = '<div style="width:100%;max-width:560px;background:var(--card,#0f0f0f);border:1px solid var(--br,#1a1a1a);border-radius:14px;overflow:hidden;font-family:-apple-system,system-ui;color:#f0f0f0">'+
    '<input id="ohb-cmdk-input" placeholder="Search commands…" style="width:100%;background:transparent;color:#f0f0f0;border:0;border-bottom:1px solid #1a1a1a;padding:18px 22px;font-size:15px;outline:none;font-family:ui-monospace,monospace">'+
    '<div id="ohb-cmdk-list" style="max-height:440px;overflow:auto;padding:6px"></div>'+
  '</div>';
  document.body.appendChild(m);
  m.addEventListener('click', function(e){ if(e.target===m) m.remove(); });
  var input = document.getElementById('ohb-cmdk-input');
  input.focus();
  function render(filter){
    var f = (filter||'').toLowerCase();
    var matches = CMDS.filter(function(c){ return !f || c.label.toLowerCase().indexOf(f)>=0 || (c.kw||'').toLowerCase().indexOf(f)>=0; }).slice(0,12);
    document.getElementById('ohb-cmdk-list').innerHTML = matches.map(function(c,i){
      return '<a href="'+c.href+'" style="display:flex;justify-content:space-between;padding:10px 16px;border-radius:6px;color:#f0f0f0;text-decoration:none;font-size:14px;'+(i===0?'background:rgba(125,249,255,.08)':'')+'"><span>'+c.label+'</span><span style="color:#7a7a7a;font:11px ui-monospace,monospace">'+(c.section||'')+'</span></a>';
    }).join('') || '<div style="padding:32px;text-align:center;color:#7a7a7a;font-size:13px">No matches</div>';
  }
  render('');
  input.addEventListener('input', function(){ render(input.value); });
  document.addEventListener('keydown', function(e){
    if(e.key==='Escape') m.remove();
  }, { once: true });
}
document.addEventListener('keydown', function(e){
  if((e.metaKey||e.ctrlKey) && e.key === KEY){ e.preventDefault(); open(); }
});
window.openCommandPalette = open;
})();`;

const DEFAULT_COMMANDS = [
  { label: 'Dashboard',           href: '/v1/dashboard',           section: 'nav' },
  { label: 'Agents',              href: '/v1/dashboard/agents',    section: 'nav' },
  { label: 'Billing',             href: '/v1/dashboard/billing',   section: 'nav' },
  { label: 'Usage',               href: '/v1/dashboard/usage',     section: 'nav' },
  { label: 'Team',                href: '/v1/dashboard/team',      section: 'nav' },
  { label: 'Audit log',           href: '/v1/dashboard/audit',     section: 'nav' },
  { label: 'Extensions',          href: '/v1/dashboard/extensions',section: 'nav' },
  { label: 'API console',         href: '/console',                section: 'nav' },
  { label: 'Open docs',           href: '/docs',                   section: 'docs' },
  { label: 'View pricing',        href: '/pricing',                section: 'marketing' },
  { label: 'Status page',         href: '/status',                 section: 'marketing' },
  { label: 'Roadmap',             href: '/roadmap',                section: 'marketing' },
  { label: 'Changelog',           href: '/changelog',              section: 'marketing' },
  { label: 'Trust & Security',    href: '/security',               section: 'marketing' },
  { label: 'Customers',           href: '/customers',              section: 'marketing' },
  { label: 'Blog',                href: '/blog',                   section: 'marketing' },
  { label: 'About',               href: '/about',                  section: 'marketing' },
  { label: 'Jobs',                href: '/jobs',                   section: 'marketing' },
  { label: 'Press kit',           href: '/press',                  section: 'marketing' },
  { label: 'Sign up',             href: '/signup',                 section: 'auth' },
  { label: 'OpenAPI spec',        href: '/openapi.json',           section: 'docs' },
  { label: 'MCP manifest',        href: '/mcp/manifest',           section: 'docs' },
  { label: 'Realtime stream',     href: '/v1/realtime/stream',     section: 'docs' },
  { label: 'Compare vs Composio', href: '/compare/composio',       section: 'compare' },
  { label: 'Compare vs Skyfire',  href: '/compare/skyfire',        section: 'compare' },
  { label: 'Solutions: fintech',  href: '/solutions/fintech',      section: 'solutions' },
  { label: 'Solutions: compliance', href: '/solutions/compliance', section: 'solutions' }
];

async function migrate(_pool) {
  // No tables. Pure config + asset routes.
}

function registerDesignSystemRoutes(app, _pool) {
  app.get('/v1/design/tokens.json', (req, res) => {
    res.setHeader('cache-control', 'public, max-age=300');
    res.json(TOKENS);
  });
  app.get('/v1/design/tokens.css', (req, res) => {
    res.setHeader('content-type', 'text/css');
    res.setHeader('cache-control', 'public, max-age=300');
    res.send(CSS_VARS);
  });
  app.get('/v1/design/cmdk.js', (req, res) => {
    res.setHeader('content-type', 'application/javascript');
    res.setHeader('cache-control', 'public, max-age=300');
    res.send(CMDK_JS(DEFAULT_COMMANDS));
  });
  app.get('/v1/design/components', (req, res) => {
    res.json({
      components: ['Button (.btn .primary .ghost .danger)', 'Card (.card)',
                    'KPI (.kpi)', 'Badge (.badge .b-good .b-warn .b-bad .b-dim .b-acc)',
                    'Table (table th td)', 'Input (input select textarea)',
                    'Skeleton (.skeleton)', 'Toast (.toast)', 'Command palette (Cmd+K)'],
      tokens_url: '/v1/design/tokens.json',
      css_url: '/v1/design/tokens.css',
      cmdk_url: '/v1/design/cmdk.js'
    });
  });
}

module.exports = {
  migrate, registerDesignSystemRoutes,
  TOKENS, CSS_VARS, CMDK_JS, DEFAULT_COMMANDS,
  renderKpi, renderBadge, renderTable
};
