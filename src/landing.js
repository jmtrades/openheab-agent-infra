// ============================================================================
// Marketing landing page + minimal docs/dashboard
// ============================================================================
const { collectRoutes } = require('./status_page');

function publicUrl() {
  return (process.env.OPERATOR_PUBLIC_URL || 'https://openheab.com').replace(/\/$/, '');
}

function head(title, description) {
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><title>${title}</title>
<meta name="description" content="${description}">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="canonical" href="${publicUrl()}/">
<style>
:root{--bg:#0a0a0a;--fg:#e8e8e8;--dim:#888;--acc:#6cf;--br:#1f1f1f;--card:#121212}
*{box-sizing:border-box}html,body{margin:0;padding:0}
body{font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Inter,system-ui,sans-serif;background:var(--bg);color:var(--fg)}
code,pre{font-family:ui-monospace,Menlo,Consolas,monospace}a{color:var(--acc);text-decoration:none}a:hover{text-decoration:underline}
nav{display:flex;justify-content:space-between;align-items:center;padding:18px 32px;border-bottom:1px solid var(--br);position:sticky;top:0;background:rgba(10,10,10,.9);backdrop-filter:blur(8px)}
nav .brand{font-weight:700;font-size:16px}nav .brand span{color:var(--acc)}
nav .links{display:flex;gap:24px;font-size:14px}nav .links a{color:var(--dim)}nav .links a:hover{color:var(--fg)}
nav .cta{background:var(--acc);color:#001628;padding:7px 14px;border-radius:6px;font-weight:600;font-size:13px}
main{max-width:980px;margin:0 auto;padding:0 32px}
.hero{padding:80px 0 60px}.hero h1{font-size:clamp(32px,5vw,52px);line-height:1.05;letter-spacing:-1px;margin:0 0 18px;font-weight:700}
.hero h1 span{color:var(--acc)}.hero p.lede{font-size:19px;color:var(--dim);max-width:680px;margin:0 0 28px}
.btn{padding:11px 18px;border-radius:7px;font-weight:600;font-size:14px;display:inline-block;border:1px solid var(--br)}
.btn.primary{background:var(--acc);color:#001628;border-color:var(--acc)}.btn.primary:hover{background:#8df;text-decoration:none}
.btn.ghost{background:transparent;color:var(--fg)}.section{padding:60px 0;border-top:1px solid var(--br)}
.section h2{font-size:28px;margin:0 0 16px;letter-spacing:-0.5px}.section .sub{color:var(--dim);margin:0 0 36px;max-width:600px}
.grid3{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:16px}
.card{background:var(--card);border:1px solid var(--br);border-radius:10px;padding:22px}
.card h3{margin:0 0 8px;font-size:16px}.card p{margin:0;color:var(--dim);font-size:14px}
pre.code{background:#0e0e0e;border:1px solid var(--br);border-radius:8px;padding:18px 20px;font-size:13px;line-height:1.55;overflow:auto;margin:0}
footer{max-width:980px;margin:60px auto 40px;padding:20px 32px;border-top:1px solid var(--br);color:var(--dim);font-size:12px}
</style></head><body>`;
}

function nav() {
  return `<nav>
  <a href="/" class="brand">OpenHeab<span>·</span></a>
  <div class="links">
    <a href="/docs">Docs</a>
    <a href="/console">Console</a>
    <a href="https://github.com/jmtrades/openheab-agent-infra">GitHub</a>
    <a href="/docs#quickstart" class="cta">Get started</a>
  </div>
</nav>`;
}

function footer() {
  return `<footer>Apache-2.0 · <a href="https://github.com/jmtrades/openheab-agent-infra">github.com/jmtrades/openheab-agent-infra</a> · <a href="/openapi.json">openapi</a> · <a href="/.well-known/agents.json">agents.json</a> · <a href="/llms.txt">llms.txt</a></footer></body></html>`;
}

function renderLanding(app) {
  const routes = collectRoutes(app);
  return head('OpenHeab — agent-native infrastructure',
    'Identity, USDC bank, KYC, email at openheab.com, memory, governance — everything an AI agent needs to act on the internet. Open source. Free.'
  ) + nav() + `<main>
<section class="hero">
  <h1>Everything an AI agent needs to act on the internet. <span>One open API.</span></h1>
  <p class="lede">A stable DID. A USDC wallet. An <code>@openheab.com</code> email. KYC and sanctions screening. Memory, reputation, governance, audit. Open source. Free to self-host.</p>
  <a href="/docs#quickstart" class="btn primary">Start in 30 seconds →</a>
  <a href="https://github.com/jmtrades/openheab-agent-infra" class="btn ghost">Source on GitHub</a>
</section>
<section class="section">
  <h2>What you get</h2>
  <p class="sub">42 primitives, ${routes.length} routes. Identity, money, KYC, memory, reputation, governance, audit — all signed, all open.</p>
  <div class="grid3">
    <div class="card"><h3>Identity</h3><p>Ed25519 DID + capability tokens + key rotation.</p></div>
    <div class="card"><h3>Bank</h3><p>Non-custodial USDC wallet on Base. 1% take rate.</p></div>
    <div class="card"><h3>Email</h3><p>Claim <code>your-agent@openheab.com</code>. DKIM-signed.</p></div>
    <div class="card"><h3>KYC</h3><p>OFAC + UN + UK HMT + EU + PEP. Tier 0-4.</p></div>
    <div class="card"><h3>Memory</h3><p>KV + episodic + pgvector semantic search.</p></div>
    <div class="card"><h3>Governance</h3><p>Constitutions, DAO groups, signed proposals.</p></div>
    <div class="card"><h3>Audit</h3><p>SHA-256-chained, Ed25519-signed audit log.</p></div>
    <div class="card"><h3>Extensions</h3><p>App store for vertical agent capabilities. 70/30 split.</p></div>
    <div class="card"><h3>MCP server</h3><p>34 tools at /mcp. Works with Claude, Cursor, VS Code.</p></div>
  </div>
</section>
<section class="section" id="quickstart">
  <h2>30 seconds to a working agent</h2>
  <pre class="code">curl -X POST ${publicUrl()}/v1/identities -H 'content-type: application/json' -d '{"name":"my-agent"}'</pre>
  <p style="color:var(--dim);margin:14px 0">Returns a DID, Ed25519 keypair, API key, and auto-provisioned USDC wallet on Base.</p>
</section>
</main>` + footer();
}

function renderDocs(app) {
  return head('OpenHeab — Docs', 'How to use OpenHeab for agent identity, payments, email, KYC, memory.') + nav() + `<main>
<section class="hero" style="padding:40px 0"><h1 style="font-size:36px">Documentation</h1><p class="lede">Every primitive, every endpoint. Full machine-readable spec at <a href="/openapi.json">/openapi.json</a>.</p></section>
<section class="section" id="quickstart">
  <h2>Quickstart</h2>
  <h3 style="margin:24px 0 8px">1. Create an agent</h3>
  <pre class="code">curl -X POST ${publicUrl()}/v1/identities -H 'content-type: application/json' -d '{"name":"my-agent"}'</pre>
  <h3 style="margin:24px 0 8px">2. Authenticate</h3>
  <pre class="code">curl ${publicUrl()}/v1/agents/$DID/wallet/balance -H 'Authorization: Bearer $API_KEY'</pre>
  <h3 style="margin:24px 0 8px">3. Use the MCP server</h3>
  <pre class="code">{
  "mcpServers": {
    "openheab": { "url": "${publicUrl()}/mcp", "auth": "Bearer opk_..." }
  }
}</pre>
</section>
</main>` + footer();
}

function registerPages(app) {
  app.get('/', (req, res, next) => {
    if (req.headers.accept?.includes('text/html')) {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.setHeader('cache-control', 'public, max-age=300');
      return res.send(renderLanding(app));
    }
    next();
  });
  app.get('/docs', (req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.send(renderDocs(app));
  });
}

module.exports = { registerPages, renderLanding, renderDocs };
