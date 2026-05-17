// ============================================================================
// mcp_registry.js — public, browseable catalog of every MCP tool exposed.
//
// We co-invented MCP (with Anthropic). We have 149 tools at /mcp. A registry
// is the surface that lets agents discover, install, and document them.
//
// Pages:
//   GET /mcp/registry       — searchable catalog of all 149 tools
//   GET /mcp/registry/:name — single-tool detail page with copy-paste install
//   GET /v1/mcp/manifest    — already exists; we link to it
// ============================================================================
const ds = require('../design_system');

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
}

function shell(title, description, content, extraHead = '') {
  return `${ds.head(`${title} — OpenHeab`, description, { extraHead })}${ds.NAV_HTML('mcp')}<main>${content}</main>${ds.FOOTER_HTML()}`;
}

function groupByNamespace(tools) {
  const groups = {};
  for (const t of tools) {
    const ns = (t.name || '').split('.').slice(0, 2).join('.') || 'other';
    (groups[ns] ||= []).push(t);
  }
  return Object.entries(groups).sort((a, b) => a[0].localeCompare(b[0]));
}

const REGISTRY_CSS = `
.mcp-search{position:sticky;top:0;background:var(--bg);padding:14px 0;z-index:5;border-bottom:1px solid var(--br)}
.mcp-search input{font-size:14px;background:var(--card)}
.mcp-ns{margin-top:32px}
.mcp-ns h2{font:600 14px/1 var(--mono);color:var(--dim);text-transform:uppercase;letter-spacing:1.5px;padding-bottom:10px;border-bottom:1px solid var(--br);margin-bottom:14px}
.mcp-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px}
.mcp-card{display:block;background:var(--card);border:1px solid var(--br);border-radius:var(--r-xl);padding:14px;text-decoration:none;color:var(--fg);transition:all var(--mo-fast)}
.mcp-card:hover{border-color:var(--acc);text-decoration:none;transform:translateY(-1px)}
.mcp-card .name{font:600 13px/1.3 var(--mono);color:var(--acc-dim);margin-bottom:6px}
.mcp-card .desc{color:var(--dim2);font-size:12.5px;line-height:1.5}
.mcp-card .meta{display:flex;gap:6px;margin-top:10px}
.mcp-card .meta .badge{font-size:9px;padding:1px 6px}
`;

function registryPage(tools) {
  const groups = groupByNamespace(tools);
  return shell('MCP Registry', 'Every MCP tool exposed by the OpenHeab substrate.', `
<section style="padding:40px 0 16px;max-width:1100px;margin:0 auto;padding-left:16px;padding-right:16px">
  <span class="badge b-acc">MCP Registry</span>
  <h1 style="font:600 40px/1.1 var(--display);letter-spacing:-1px;margin:14px 0 8px">${tools.length} MCP tools, browseable.</h1>
  <p style="color:var(--dim2);font-size:15px;line-height:1.55;max-width:740px">Every tool follows the Model Context Protocol spec. Connect your agent runtime to <code>https://openheab.com/mcp</code> with your API key and these become callable.</p>
  <div style="display:flex;gap:12px;margin-top:18px;flex-wrap:wrap">
    <a href="/v1/mcp/manifest" class="btn">manifest.json →</a>
    <a href="/.well-known/mcp.json" class="btn">.well-known/mcp.json →</a>
    <a href="/sdk" class="btn">Install in 60s →</a>
  </div>
</section>
<section style="max-width:1100px;margin:0 auto;padding:0 16px">
  <div class="mcp-search">
    <input type="search" id="q" placeholder="Filter ${tools.length} tools by name or description…" autocomplete="off">
  </div>
  <div id="results">
    ${groups.map(([ns, ts]) => `
      <div class="mcp-ns" data-ns="${escapeHtml(ns)}">
        <h2>${escapeHtml(ns)} · <span style="color:var(--dim);text-transform:none;letter-spacing:0;font-weight:400">${ts.length}</span></h2>
        <div class="mcp-grid">
          ${ts.map(t => `
            <a href="/mcp/registry/${encodeURIComponent(t.name)}" class="mcp-card" data-search="${escapeHtml((t.name + ' ' + (t.description || '')).toLowerCase())}">
              <div class="name">${escapeHtml(t.name)}</div>
              <div class="desc">${escapeHtml((t.description || '').slice(0, 140))}</div>
              <div class="meta">
                <span class="badge b-dim">${escapeHtml(t.method || 'POST')}</span>
                ${t.path?.includes(':') ? '<span class="badge b-warn">params</span>' : ''}
              </div>
            </a>
          `).join('')}
        </div>
      </div>
    `).join('')}
  </div>
</section>
<script>
(function(){
  var q = document.getElementById('q');
  if (!q) return;
  q.addEventListener('input', function(){
    var v = q.value.trim().toLowerCase();
    document.querySelectorAll('.mcp-card').forEach(function(c){
      var s = c.getAttribute('data-search') || '';
      c.style.display = (!v || s.indexOf(v) !== -1) ? '' : 'none';
    });
    // Hide empty namespaces
    document.querySelectorAll('.mcp-ns').forEach(function(g){
      var any = Array.from(g.querySelectorAll('.mcp-card')).some(function(c){ return c.style.display !== 'none'; });
      g.style.display = any ? '' : 'none';
    });
  });
  q.focus();
})();
</script>
`, `<style>${REGISTRY_CSS}</style>`);
}

function toolPage(tool) {
  const inputSchema = tool.inputSchema || { type: 'object', properties: {} };
  const props = inputSchema.properties || {};
  const sampleArgs = {};
  for (const [k, def] of Object.entries(props)) {
    if (def.type === 'string') sampleArgs[k] = def.example || `<${k}>`;
    else if (def.type === 'number' || def.type === 'integer') sampleArgs[k] = 0;
    else if (def.type === 'boolean') sampleArgs[k] = false;
    else if (def.type === 'array') sampleArgs[k] = [];
    else sampleArgs[k] = null;
  }
  const mcpInvoke = {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: tool.name, arguments: sampleArgs }
  };
  return shell(`${tool.name} — MCP tool`, tool.description || '',
  `<section style="max-width:840px;margin:0 auto;padding:60px 16px">
    <a href="/mcp/registry" style="font:500 12px/1 var(--mono);color:var(--dim);text-decoration:none">← All MCP tools</a>
    <h1 style="font:600 28px/1.2 var(--mono);color:var(--acc-dim);margin:14px 0 8px;word-break:break-all">${escapeHtml(tool.name)}</h1>
    <p style="color:var(--dim2);font-size:15px;line-height:1.7;margin-bottom:6px">${escapeHtml(tool.description || '')}</p>
    <div style="display:flex;gap:8px;margin-top:14px">
      <span class="badge b-dim">${escapeHtml(tool.method || 'POST')}</span>
      <span class="badge b-acc">${escapeHtml(tool.path || '')}</span>
    </div>
  </section>

  <section style="max-width:840px;margin:0 auto;padding:16px 16px 60px">
    <h2 style="font:600 18px/1 var(--display);margin:24px 0 8px">Input schema</h2>
    <pre style="background:var(--card);border:1px solid var(--br);border-radius:var(--r-md);padding:14px;overflow-x:auto;font-size:12.5px;line-height:1.5"><code>${escapeHtml(JSON.stringify(inputSchema, null, 2))}</code></pre>

    <h2 style="font:600 18px/1 var(--display);margin:32px 0 8px">Call via MCP (JSON-RPC)</h2>
    <p style="color:var(--dim2);font-size:13px;margin-bottom:8px">From your MCP-aware agent runtime (Claude Desktop, MCP-compatible SDKs, our /sdk examples).</p>
    <pre style="background:var(--card);border:1px solid var(--br);border-radius:var(--r-md);padding:14px;overflow-x:auto;font-size:12.5px;line-height:1.5"><code>curl https://openheab.com/mcp \\
  -H "Authorization: Bearer $OPENHEAB_KEY" \\
  -H "content-type: application/json" \\
  -d '${escapeHtml(JSON.stringify(mcpInvoke))}'</code></pre>

    <h2 style="font:600 18px/1 var(--display);margin:32px 0 8px">Call as a normal HTTP endpoint</h2>
    <p style="color:var(--dim2);font-size:13px;margin-bottom:8px">Skip MCP, hit the route directly. Same auth.</p>
    <pre style="background:var(--card);border:1px solid var(--br);border-radius:var(--r-md);padding:14px;overflow-x:auto;font-size:12.5px;line-height:1.5"><code>curl ${escapeHtml(tool.method || 'POST')} https://openheab.com${escapeHtml(tool.path || '')} \\
  -H "Authorization: Bearer $OPENHEAB_KEY" \\
  -H "content-type: application/json" \\
  -d '${escapeHtml(JSON.stringify(sampleArgs))}'</code></pre>

    <h2 style="font:600 18px/1 var(--display);margin:32px 0 8px">Wire it into Claude Desktop</h2>
    <p style="color:var(--dim2);font-size:13px;line-height:1.7">Add to your Claude Desktop config (<code>~/Library/Application Support/Claude/claude_desktop_config.json</code>):</p>
    <pre style="background:var(--card);border:1px solid var(--br);border-radius:var(--r-md);padding:14px;overflow-x:auto;font-size:12.5px;line-height:1.5"><code>{
  "mcpServers": {
    "openheab": {
      "url": "https://openheab.com/mcp",
      "headers": { "Authorization": "Bearer $OPENHEAB_KEY" }
    }
  }
}</code></pre>
  </section>`);
}

function registerMcpRegistryRoutes(app, _pool) {
  const { TOOLS } = require('./mcp_server');

  app.get('/mcp/registry', (req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.setHeader('cache-control', 'public, max-age=600');
    res.send(registryPage(TOOLS));
  });

  app.get('/mcp/registry/:name', (req, res) => {
    const tool = TOOLS.find(t => t.name === req.params.name);
    res.setHeader('content-type', 'text/html; charset=utf-8');
    if (!tool) {
      res.status(404).send(shell('Not found', 'Tool not found.',
        `<section style="padding:120px 0;text-align:center"><h1>404</h1><p style="color:var(--dim2)">No MCP tool named that. <a href="/mcp/registry">Browse all →</a></p></section>`));
      return;
    }
    res.send(toolPage(tool));
  });
}

async function migrate(_pool) { /* no schema */ }

module.exports = { migrate, registerMcpRegistryRoutes };
