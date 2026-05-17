// ============================================================================
// HTML status page + OpenAPI spec generator
// ============================================================================
function collectRoutes(app) {
  const out = [];
  const pushIfString = (method, path) => {
    if (typeof path === 'string') out.push({ method: method.toUpperCase(), path });
    else if (Array.isArray(path)) for (const p of path) if (typeof p === 'string') out.push({ method: method.toUpperCase(), path: p });
  };
  for (const layer of app._router?.stack || []) {
    if (layer.route) {
      for (const method of Object.keys(layer.route.methods)) pushIfString(method, layer.route.path);
    } else if (layer.name === 'router' && layer.handle?.stack) {
      for (const sub of layer.handle.stack) {
        if (sub.route) {
          for (const method of Object.keys(sub.route.methods)) pushIfString(method, sub.route.path);
        }
      }
    }
  }
  return out;
}

function groupByFamily(routes) {
  const groups = {};
  for (const r of routes) {
    const parts = r.path.split('/').filter(Boolean);
    let family;
    if (parts[0] === 'v1' && parts[1] === 'agents') family = parts[3] || 'agents';
    else if (parts[0] === 'v1') family = parts[1] || 'root';
    else family = parts[0] || 'root';
    (groups[family] = groups[family] || []).push(r);
  }
  return groups;
}

function primitiveCount() {
  try { return Object.keys(require('./integration').primitives).length; }
  catch { return 265; }
}

function renderOpenApiSpec(app, opts = {}) {
  const routes = collectRoutes(app);
  const prims = primitiveCount();
  const paths = {};
  for (const r of routes) {
    const oasPath = r.path.replace(/:(\w+)/g, '{$1}');
    paths[oasPath] = paths[oasPath] || {};
    paths[oasPath][r.method.toLowerCase()] = {
      summary: `${r.method} ${r.path}`,
      responses: {
        '200': { description: 'success' }, '400': { description: 'invalid request' },
        '401': { description: 'auth failed' }, '404': { description: 'not found' },
        '500': { description: 'server error' }
      }
    };
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'OpenHeab Substrate', version: '0.2.0',
      description: `Agent-native substrate API. ${prims} primitives across 67 layers. Apache-2.0.`,
      contact: { name: 'OpenHeab', url: 'https://openheab.com' }
    },
    servers: [{ url: opts.publicUrl || 'https://openheab.com' }],
    paths
  };
}

function registerStatusPage(app, pool) {
  app.get('/console', (req, res) => {
    const routes = collectRoutes(app);
    const groups = groupByFamily(routes);
    const familyCount = Object.keys(groups).length;
    const prims = primitiveCount();
    const verbColor = m => ({ GET: '#7df9ff', POST: '#7dffaf', PUT: '#ffd866', DELETE: '#ff6e6e', PATCH: '#c084fc' })[m] || '#888';
    const filter = String(req.query.q || '').toLowerCase();

    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.setHeader('cache-control', 'public, max-age=60');
    res.send(`<!doctype html><html lang=en><head><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1">
<title>Console — OpenHeab</title>
<meta name="theme-color" content="#08090b">
<meta name="color-scheme" content="dark">
<style>
:root{
  --bg:#08090b;--bg-elev:#0d0e10;--bg-elev2:#111316;
  --br:#1d1f23;--br-strong:#2a2c31;
  --fg:#f4f4f5;--fg-dim:#a1a1aa;--fg-dim2:#71717a;--fg-dim3:#52525b;
  --acc:#7dd3fc;--acc-glow:rgba(125,211,252,0.18);--acc-text:#03161f;
  --mono:ui-monospace,'SF Mono','JetBrains Mono',Menlo,Consolas,monospace;
  --sans:-apple-system,BlinkMacSystemFont,'Inter','SF Pro Display','Segoe UI',system-ui,sans-serif;
  --ease-out:cubic-bezier(0.23, 1, 0.32, 1);
  --t-fast:120ms;--t-med:180ms;
}
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html{-webkit-font-smoothing:antialiased}
body{
  font:14px/1.55 var(--sans);background:var(--bg);color:var(--fg);padding:24px;
  background-image:radial-gradient(circle at 50% -200px,rgba(125,211,252,0.05),transparent 700px);
  min-height:100vh;
}
::selection{background:var(--acc);color:var(--acc-text)}
.wrap{max-width:1080px;margin:0 auto}
.head{margin-bottom:28px;display:flex;justify-content:space-between;align-items:flex-end;flex-wrap:wrap;gap:18px}
.head h1{font:600 28px/1 var(--mono);letter-spacing:-1.2px;display:inline-flex;align-items:center;gap:6px}
.head h1 .dot{display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--acc);box-shadow:0 0 10px var(--acc-glow);margin-right:6px}
.sub{color:var(--fg-dim);font-size:13.5px;margin-top:6px;font-family:var(--mono)}
.head .actions{display:flex;gap:6px}
.head .actions a{
  font-size:13px;padding:8px 12px;border:1px solid var(--br);border-radius:7px;
  text-decoration:none;color:var(--fg-dim);background:var(--bg-elev);
  transition:transform var(--t-fast) var(--ease-out),background-color var(--t-fast) var(--ease-out),color var(--t-fast) var(--ease-out);
}
.head .actions a:hover{background:var(--bg-elev2);color:var(--fg)}
.head .actions a:active{transform:scale(0.97)}
.head .actions a.primary{background:var(--fg);color:var(--bg);font-weight:600;border-color:var(--fg)}
.head .actions a.primary:hover{background:#e4e4e7;color:var(--bg)}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin-bottom:24px}
.kpi{background:var(--bg-elev);border:1px solid var(--br);border-radius:10px;padding:14px 18px;transition:border-color var(--t-fast) var(--ease-out)}
.kpi:hover{border-color:var(--br-strong)}
.kpi .l{font:500 10.5px/1 var(--mono);color:var(--fg-dim2);text-transform:uppercase;letter-spacing:1.4px;margin-bottom:7px}
.kpi .v{font:600 24px/1 var(--mono);letter-spacing:-1.2px;font-feature-settings:'tnum'}
input.search{
  width:100%;background:var(--bg-elev);color:var(--fg);border:1px solid var(--br);border-radius:10px;
  padding:13px 16px;font:500 14px/1 var(--mono);outline:none;margin-bottom:18px;
  transition:border-color var(--t-fast) var(--ease-out),background-color var(--t-fast) var(--ease-out);
}
input.search:hover{background:var(--bg-elev2)}
input.search:focus{border-color:var(--acc);background:var(--bg-elev2);box-shadow:0 0 0 3px var(--acc-glow)}
details{background:var(--bg-elev);border:1px solid var(--br);padding:0;margin:4px 0;border-radius:10px;overflow:hidden;transition:border-color var(--t-fast) var(--ease-out)}
details[open]{border-color:var(--br-strong)}
summary{cursor:pointer;padding:12px 18px;display:flex;justify-content:space-between;align-items:center;font:500 13px/1 var(--mono);color:var(--fg);user-select:none;transition:background-color var(--t-fast) var(--ease-out)}
summary::-webkit-details-marker{display:none}
summary:hover{background:var(--bg-elev2)}
summary .count{color:var(--acc);font-size:11px;background:var(--acc-glow);padding:3px 9px;border-radius:99px;font-weight:600}
.routes{padding:6px 0;border-top:1px solid var(--br)}
.route{padding:7px 18px;display:flex;align-items:center;gap:12px;font-family:var(--mono);font-size:12.5px;transition:background-color var(--t-fast) var(--ease-out)}
.route:hover{background:var(--bg-elev2)}
.verb{font:600 11px/1 var(--mono);min-width:56px;text-align:center;padding:4px 7px;border:1px solid currentColor;border-radius:5px;letter-spacing:0.5px}
.path{color:var(--fg-dim);word-break:break-all}
.foot{margin-top:30px;padding-top:18px;border-top:1px solid var(--br);color:var(--fg-dim2);font-size:12px;display:flex;gap:18px;flex-wrap:wrap}
.foot a{color:var(--fg-dim);text-decoration:none;transition:color var(--t-fast) var(--ease-out)}
.foot a:hover{color:var(--fg)}
@media (prefers-reduced-motion:reduce){*{transition-duration:1ms !important;animation-duration:1ms !important}}
@media (max-width:640px){body{padding:16px}.route{font-size:11px;padding:6px 14px}.verb{min-width:50px}.head h1{font-size:22px}}
</style></head><body><div class=wrap>
<div class=head>
  <div>
    <h1>openheab<span class=dot>.</span> console</h1>
    <div class=sub>${routes.length} routes · ${familyCount} families · ${prims} primitives</div>
  </div>
  <div class=actions>
    <a href="/">← Home</a>
    <a href="/v1/dashboard">Dashboard</a>
    <a href="/openapi.json" class=primary>OpenAPI</a>
  </div>
</div>
<div class=kpis>
  <div class=kpi><div class=l>Primitives</div><div class=v>${prims}</div></div>
  <div class=kpi><div class=l>Routes</div><div class=v>${routes.length}</div></div>
  <div class=kpi><div class=l>Families</div><div class=v>${familyCount}</div></div>
  <div class=kpi><div class=l>Layers</div><div class=v>67</div></div>
</div>
<form method=get><input type=search name=q value="${filter.replace(/"/g, '&quot;')}" placeholder="Filter routes (e.g. wallet, kyc, savings)…" class=search autofocus></form>
${Object.entries(groups).sort(([a],[b])=>a.localeCompare(b)).map(([f, rs]) => {
  const visibleRoutes = filter ? rs.filter(r => r.path.toLowerCase().includes(filter) || f.includes(filter)) : rs;
  if (visibleRoutes.length === 0) return '';
  return `<details ${filter ? 'open' : ''}>
    <summary>${f} <span class=count>${visibleRoutes.length}</span></summary>
    <div class=routes>${visibleRoutes.map(r => `<div class=route><span class=verb style="color:${verbColor(r.method)}">${r.method}</span><span class=path>${r.path}</span></div>`).join('')}</div>
  </details>`;
}).join('')}
<div class=foot>
  <a href="/openapi.json">OpenAPI 3.1</a>
  <a href="/.well-known/agents.json">agents.json</a>
  <a href="/llms.txt">llms.txt</a>
  <a href="/mcp/manifest">MCP manifest</a>
  <a href="/v1/realtime/stream">SSE stream</a>
  <a href="/healthz">/healthz</a>
</div>
</div></body></html>`);
  });

  app.get('/', (req, res, next) => {
    if (req.headers.accept?.includes('text/html')) return next();
    res.json({
      name: 'openheab-substrate',
      primitive_count: primitiveCount(),
      route_count: collectRoutes(app).length,
      layer_count: 67,
      mcp_tool_count_approx: 149,
      revenue_layers: 14,
      docs: (process.env.OPERATOR_PUBLIC_URL || '') + '/docs',
      console: (process.env.OPERATOR_PUBLIC_URL || '') + '/console',
      pricing: (process.env.OPERATOR_PUBLIC_URL || '') + '/pricing',
      openapi: '/openapi.json',
      mcp_manifest: '/mcp/manifest'
    });
  });

  app.get('/openapi.json', (req, res) => {
    res.setHeader('cache-control', 'public, max-age=300');
    res.json(renderOpenApiSpec(app, { publicUrl: process.env.OPERATOR_PUBLIC_URL }));
  });
}

module.exports = { registerStatusPage, renderOpenApiSpec, collectRoutes };
