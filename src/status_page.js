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
  catch { return 233; }
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
      description: `Agent-native substrate API. ${prims} primitives across 37 layers. Apache-2.0.`,
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
<style>
:root{--bg:#0a0a0a;--fg:#f0f0f0;--dim:#7a7a7a;--dim2:#bdbdbd;--acc:#7df9ff;--card:#0f0f0f;--br:#1a1a1a;--mono:ui-monospace,'SF Mono','JetBrains Mono',Menlo,Consolas,monospace;--sans:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,system-ui,sans-serif}
*{box-sizing:border-box;margin:0;padding:0}
body{font:14px/1.55 var(--sans);background:var(--bg);color:var(--fg);padding:24px}
.wrap{max-width:1080px;margin:0 auto}
.head{margin-bottom:28px;display:flex;justify-content:space-between;align-items:flex-end;flex-wrap:wrap;gap:18px}
.head h1{font:600 28px/1 var(--mono);letter-spacing:-1px}
.head h1 .dot{color:var(--acc)}
.sub{color:var(--dim2);font-size:14px;margin-top:6px}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin-bottom:24px}
.kpi{background:var(--card);border:1px solid var(--br);border-radius:8px;padding:14px 18px}
.kpi .l{font:500 10px/1 var(--mono);color:var(--dim);text-transform:uppercase;letter-spacing:1.2px;margin-bottom:6px}
.kpi .v{font:700 22px/1 var(--mono);letter-spacing:-1px}
input.search{width:100%;background:var(--card);color:var(--fg);border:1px solid var(--br);border-radius:8px;padding:12px 16px;font:500 14px/1 var(--mono);outline:none;margin-bottom:18px}
input.search:focus{border-color:var(--acc)}
details{background:var(--card);border:1px solid var(--br);padding:0;margin:4px 0;border-radius:8px;overflow:hidden}
summary{cursor:pointer;padding:12px 18px;display:flex;justify-content:space-between;align-items:center;font:500 13px/1 var(--mono);color:var(--fg);user-select:none}
summary::-webkit-details-marker{display:none}
summary:hover{background:rgba(255,255,255,0.02)}
summary .count{color:var(--dim);font-size:11px;background:rgba(125,249,255,0.08);padding:3px 8px;border-radius:99px}
.routes{padding:8px 0;border-top:1px solid var(--br)}
.route{padding:6px 18px;display:flex;align-items:center;gap:12px;font-family:var(--mono);font-size:12px}
.route:hover{background:rgba(255,255,255,0.02)}
.verb{font:600 11px/1 var(--mono);min-width:54px;text-align:center;padding:3px 6px;border:1px solid currentColor;border-radius:4px}
.path{color:var(--dim2);word-break:break-all}
.foot{margin-top:30px;padding-top:18px;border-top:1px solid var(--br);color:var(--dim);font-size:12px;display:flex;gap:18px;flex-wrap:wrap}
.foot a{color:var(--acc);text-decoration:none}
.foot a:hover{text-decoration:underline}
@media (max-width:640px){body{padding:16px}.route{font-size:11px}.verb{min-width:48px}}
</style></head><body><div class=wrap>
<div class=head>
  <div>
    <h1>openheab<span class=dot>.</span> console</h1>
    <div class=sub>${routes.length} routes · ${familyCount} families · ${prims} primitives</div>
  </div>
  <div style="display:flex;gap:8px">
    <a href="/" style="color:var(--dim2);font-size:13px;padding:8px 12px;border:1px solid var(--br);border-radius:6px;text-decoration:none">← Home</a>
    <a href="/v1/dashboard" style="color:var(--dim2);font-size:13px;padding:8px 12px;border:1px solid var(--br);border-radius:6px;text-decoration:none">Dashboard</a>
    <a href="/openapi.json" style="background:var(--acc);color:#001a1f;font-size:13px;font-weight:600;padding:8px 12px;border-radius:6px;text-decoration:none">OpenAPI</a>
  </div>
</div>
<div class=kpis>
  <div class=kpi><div class=l>Primitives</div><div class=v>${prims}</div></div>
  <div class=kpi><div class=l>Routes</div><div class=v>${routes.length}</div></div>
  <div class=kpi><div class=l>Families</div><div class=v>${familyCount}</div></div>
  <div class=kpi><div class=l>Layers</div><div class=v>37</div></div>
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
      layer_count: 37,
      mcp_tool_count_approx: 145,
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
