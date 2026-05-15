// ============================================================================
// HTML status page + OpenAPI spec generator
// ============================================================================
function collectRoutes(app) {
  const out = [];
  for (const layer of app._router?.stack || []) {
    if (layer.route) {
      for (const method of Object.keys(layer.route.methods)) {
        out.push({ method: method.toUpperCase(), path: layer.route.path });
      }
    } else if (layer.name === 'router' && layer.handle?.stack) {
      for (const sub of layer.handle.stack) {
        if (sub.route) {
          for (const method of Object.keys(sub.route.methods)) {
            out.push({ method: method.toUpperCase(), path: sub.route.path });
          }
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
  catch { return 153; }
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
      description: `Agent-native substrate API. ${prims} primitives across 23 layers. Apache-2.0.`,
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
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.setHeader('cache-control', 'public, max-age=60');
    res.send(`<!doctype html><html><head><title>OpenHeab Console</title>
<style>body{font-family:ui-monospace,Menlo,monospace;background:#0a0a0a;color:#e8e8e8;padding:24px;max-width:920px;margin:0 auto}
h1{color:#6cf}details{background:#141414;border:1px solid #222;padding:10px;margin:4px 0;border-radius:6px}
summary{cursor:pointer}.m-get{color:#6cf}.m-post{color:#6c9}.m-put{color:#fc6}.m-delete{color:#f66}
code{color:#fff}</style></head><body>
<h1>OpenHeab Substrate</h1><p>${routes.length} routes across ${familyCount} primitive families.</p>
${Object.entries(groups).sort(([a],[b])=>a.localeCompare(b)).map(([f, rs]) =>
  `<details><summary>${f} (${rs.length})</summary>${rs.map(r => `<div><span class="m-${r.method.toLowerCase()}">${r.method}</span> <code>${r.path}</code></div>`).join('')}</details>`
).join('')}
<p style="margin-top:30px;color:#888"><a href="/openapi.json" style="color:#6cf">/openapi.json</a> · <a href="/.well-known/agents.json" style="color:#6cf">agents.json</a> · <a href="/healthz" style="color:#6cf">/healthz</a></p>
</body></html>`);
  });

  app.get('/', (req, res, next) => {
    if (req.headers.accept?.includes('text/html')) return next();
    res.json({
      name: 'openheab-substrate',
      primitive_count: primitiveCount(),
      route_count: collectRoutes(app).length,
      layer_count: 23,
      mcp_tool_count_approx: 120,
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
