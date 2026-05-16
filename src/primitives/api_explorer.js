// ============================================================================
// api_explorer.js — `/explorer` interactive OpenAPI spec browser. Uses
// Stoplight Elements via CDN (no npm dep). Lets visitors browse every route,
// see schemas, and "Try It" inline. Critical for developer adoption — the
// difference between "they read the docs" and "they actually call the API".
// ============================================================================

async function migrate(pool) {}

function renderExplorerPage() {
  return `<!doctype html><html><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>API Explorer — OpenHeab</title>
<meta name="description" content="Interactive OpenAPI 3.1 explorer for OpenHeab. Browse 1,724+ routes, see schemas, send live requests.">
<script type="module" src="https://unpkg.com/@stoplight/elements/web-components.min.js"></script>
<link rel="stylesheet" href="https://unpkg.com/@stoplight/elements/styles.min.css">
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Inter', sans-serif; background: #0a0a0f; color: #e7e7ee; }
.topnav {
  display: flex; justify-content: space-between; align-items: center;
  padding: 14px 24px; background: #0a0a0f; border-bottom: 1px solid #1a1a25;
  position: sticky; top: 0; z-index: 100;
}
.topnav .logo { font-weight: 700; font-size: 18px; color: #fff; text-decoration: none; letter-spacing: -0.3px; }
.topnav .nav-links a { color: #888; margin-left: 18px; font-size: 13px; text-decoration: none; }
.topnav .nav-links a:hover { color: #fff; }
.fallback {
  padding: 60px 24px; max-width: 760px; margin: 0 auto; text-align: center;
}
.fallback h1 { font-size: 32px; margin-bottom: 14px; }
.fallback p { color: #888; margin-bottom: 24px; }
.fallback a {
  display: inline-block; padding: 12px 22px; background: #4f46e5; color: #fff;
  text-decoration: none; border-radius: 8px; font-weight: 600; margin: 6px;
}
elements-api {
  --color-canvas: #ffffff;
  --color-canvas-pure: #ffffff;
  --color-canvas-dialog: #f7f7fa;
  display: block; min-height: calc(100vh - 60px);
}
</style></head><body>

<nav class="topnav">
  <a class="logo" href="/">OpenHeab</a>
  <div class="nav-links">
    <a href="/docs">Docs</a>
    <a href="/sdk">SDK</a>
    <a href="/models">Models</a>
    <a href="/tools">Tools</a>
    <a href="/explorer" style="color:#fff">Explorer</a>
    <a href="/openapi.json">Raw spec</a>
  </div>
</nav>

<elements-api
  apiDescriptionUrl="/openapi.json"
  router="hash"
  layout="sidebar"
  hideTryIt="false"
  hideSchemas="false"
></elements-api>

<noscript>
  <div class="fallback">
    <h1>OpenHeab API Explorer</h1>
    <p>This page requires JavaScript to render the interactive spec browser. The raw OpenAPI 3.1 spec is available without JavaScript:</p>
    <a href="/openapi.json">View raw OpenAPI 3.1 spec →</a>
    <a href="/docs">Read the docs →</a>
  </div>
</noscript>

</body></html>`;
}

function registerApiExplorerRoutes(app) {
  app.get('/explorer', (req, res) => {
    res.set('content-type', 'text/html; charset=utf-8');
    res.set('cache-control', 'public, max-age=3600');
    // Override CSP to allow the Stoplight CDN
    res.set('content-security-policy',
      "default-src 'self'; " +
      "style-src 'self' 'unsafe-inline' https://unpkg.com; " +
      "script-src 'self' 'unsafe-inline' https://unpkg.com; " +
      "img-src 'self' data: blob: https:; " +
      "font-src 'self' data: https://unpkg.com; " +
      "connect-src 'self' https://unpkg.com; " +
      "frame-ancestors 'none'");
    res.send(renderExplorerPage());
  });

  // Alias
  app.get('/api-explorer', (req, res) => res.redirect(301, '/explorer'));
}

module.exports = { migrate, registerApiExplorerRoutes };
