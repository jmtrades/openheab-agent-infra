// ============================================================================
// realworld_v2.js — more bridges (Zapier/n8n/Make/IFTTT/OAuth/MCP-as-server).
//
//   /realworld/zapier        Zapier app + how to publish a Zap
//   /realworld/n8n           n8n custom node setup
//   /realworld/make          Make (Integromat) module setup
//   /realworld/ifttt         IFTTT applet wiring
//   /realworld/oauth         become an OAuth provider for your agent
//   /realworld/openapi       point any OpenAPI-aware platform at our spec
//   /realworld/mcp-host      host an MCP server to expose your tools
//   /realworld/webhooks-out  emit webhooks from your agent
// ============================================================================
const ds = require('../design_system');

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
}

function shell(title, description, content) {
  return `${ds.head(`${title} — OpenHeab`, description)}${ds.NAV_HTML('')}<main>${content}</main>${ds.FOOTER_HTML()}`;
}

function bridge(slug, icon, name, desc, body) {
  return shell(`${name} integration`, desc,
`<section style="max-width:780px;margin:0 auto;padding:60px 16px">
  <a href="/realworld" style="font:500 12px var(--mono);color:var(--dim);text-decoration:none">← All bridges</a>
  <div style="font-size:48px;margin:14px 0">${icon}</div>
  <h1 style="font:600 40px/1.1 var(--display);letter-spacing:-1px">${escapeHtml(name)}.</h1>
  <p style="color:var(--dim2);font-size:15px;line-height:1.7;margin:14px 0 24px">${escapeHtml(desc)}</p>
</section>
<section style="max-width:780px;margin:0 auto;padding:0 16px 60px">${body}</section>`);
}

function zapierPage() {
  return bridge('zapier', '⚡', 'Zapier', 'Trigger OpenHeab actions from 6,000+ apps, or push OpenHeab events into Zapier.', `
<h2 style="font:600 20px var(--display);margin:0 0 10px">Triggers we expose</h2>
<ul style="color:var(--dim2);line-height:1.85;padding-left:20px">
  <li><strong style="color:var(--fg)">New agent signed up</strong> — webhook on <code>signup.completed</code>.</li>
  <li><strong style="color:var(--fg)">Transfer received</strong> — webhook on <code>bank.transferred</code>.</li>
  <li><strong style="color:var(--fg)">Inference call completed</strong> — webhook on <code>inference.completed</code>.</li>
  <li><strong style="color:var(--fg)">KYC decision</strong> — webhook on <code>kyc.decided</code>.</li>
  <li><strong style="color:var(--fg)">Audit chain entry</strong> — webhook on any event type you subscribe to.</li>
</ul>
<h2 style="font:600 20px var(--display);margin:32px 0 10px">Actions we expose</h2>
<ul style="color:var(--dim2);line-height:1.85;padding-left:20px">
  <li><strong style="color:var(--fg)">Send chat completion</strong> — call POST /v1/chat/completions.</li>
  <li><strong style="color:var(--fg)">Transfer USDC</strong> — POST /v1/agents/:did/bank/transfer with idempotency key.</li>
  <li><strong style="color:var(--fg)">Issue card</strong> — POST /v1/agents/:did/cards.</li>
  <li><strong style="color:var(--fg)">Run sandbox code</strong> — POST /v1/agents/:did/sandbox/sessions/exec.</li>
</ul>
<h2 style="font:600 20px var(--display);margin:32px 0 10px">Setup</h2>
<ol style="color:var(--dim2);line-height:1.85;padding-left:20px">
  <li>Get an OpenHeab API key at <a href="/api-keys">/api-keys</a>.</li>
  <li>In Zapier, search for "OpenHeab" → connect → paste your key.</li>
  <li>Build a Zap. Trigger or Action.</li>
</ol>
<p style="color:var(--dim);font-size:13px;margin-top:20px;font-style:italic">App is in submission to Zapier's marketplace. Until then, use the generic "Webhooks by Zapier" action pointing at our endpoints.</p>`);
}

function n8nPage() {
  return bridge('n8n', '🔗', 'n8n', 'Custom node for n8n. Self-hostable workflow engine.', `
<h2 style="font:600 20px var(--display);margin:0 0 10px">Install</h2>
<pre style="background:var(--card);border:1px solid var(--br);border-radius:var(--r-md);padding:14px;overflow-x:auto;font-size:13px"><code># In your n8n installation:
npm install n8n-nodes-openheab
# Restart n8n. Search nodes for "OpenHeab".</code></pre>

<h2 style="font:600 20px var(--display);margin:32px 0 10px">What you get</h2>
<ul style="color:var(--dim2);line-height:1.85;padding-left:20px">
  <li><strong style="color:var(--fg)">OpenHeab Trigger node</strong> — listens on substrate webhooks.</li>
  <li><strong style="color:var(--fg)">OpenHeab Chat node</strong> — runs inference, supports streaming.</li>
  <li><strong style="color:var(--fg)">OpenHeab Bank node</strong> — transfer / balance / card issue.</li>
  <li><strong style="color:var(--fg)">OpenHeab MCP node</strong> — call any of our 149 MCP tools.</li>
  <li><strong style="color:var(--fg)">OpenHeab Audit node</strong> — verify chain integrity inline.</li>
</ul>

<h2 style="font:600 20px var(--display);margin:32px 0 10px">Without the custom node</h2>
<p style="color:var(--dim2);line-height:1.7">Use n8n's HTTP Request node pointed at any /v1/* endpoint. Set Authorization header to <code>Bearer {{$env.OPENHEAB_KEY}}</code>.</p>`);
}

function makePage() {
  return bridge('make', '🟪', 'Make', 'Make.com (Integromat) module pack.', `
<h2 style="font:600 20px var(--display);margin:0 0 10px">Triggers</h2>
<ul style="color:var(--dim2);line-height:1.85;padding-left:20px">
  <li>New transfer received</li>
  <li>Agent signed up</li>
  <li>Workflow completed</li>
  <li>Audit chain event matching filter</li>
</ul>
<h2 style="font:600 20px var(--display);margin:32px 0 10px">Search + Action modules</h2>
<ul style="color:var(--dim2);line-height:1.85;padding-left:20px">
  <li>Send chat completion</li>
  <li>Get agent profile</li>
  <li>Transfer USDC</li>
  <li>Verify audit chain</li>
  <li>Make MCP tool call</li>
</ul>
<h2 style="font:600 20px var(--display);margin:32px 0 10px">Setup</h2>
<ol style="color:var(--dim2);line-height:1.85;padding-left:20px">
  <li>In Make, search for "OpenHeab" in the apps list.</li>
  <li>Click Connect, paste your API key, name the connection.</li>
  <li>Drop modules into your scenarios.</li>
</ol>
<p style="color:var(--dim);font-size:13px;margin-top:20px;font-style:italic">App pending Make marketplace review. Until then, use HTTP module with our endpoints.</p>`);
}

function iftttPage() {
  return bridge('ifttt', '🟦', 'IFTTT', 'Simple "if this then that" applets for personal automation.', `
<h2 style="font:600 20px var(--display);margin:0 0 10px">Applets</h2>
<p style="color:var(--dim2);line-height:1.7;margin-bottom:18px">A few starter applets, install in one click:</p>
<ul style="color:var(--dim2);line-height:1.85;padding-left:20px">
  <li><strong style="color:var(--fg)">"If transfer ≥ $100, then text me"</strong> — Webhook → SMS via your IFTTT phone.</li>
  <li><strong style="color:var(--fg)">"If KYC approved, then push notification"</strong> — KYC webhook → IFTTT notification service.</li>
  <li><strong style="color:var(--fg)">"If new agent of the day, then post to Twitter"</strong> — agent-of-the-day RSS → Twitter.</li>
  <li><strong style="color:var(--fg)">"If audit chain integrity check fails, then page"</strong> — daily cron probe → IFTTT phone call.</li>
</ul>
<h2 style="font:600 20px var(--display);margin:32px 0 10px">Setup</h2>
<p style="color:var(--dim2);line-height:1.7">IFTTT's Webhooks service accepts any HTTP POST. Use our outbound webhooks at <a href="/webhooks">/webhooks</a> to fire IFTTT triggers.</p>`);
}

function oauthPage() {
  return bridge('oauth', '🔐', 'OAuth provider', 'Become an OAuth provider so your agent can authorize third-party apps.', `
<h2 style="font:600 20px var(--display);margin:0 0 10px">Why</h2>
<p style="color:var(--dim2);line-height:1.7">Some workflows have your agent acting on behalf of a human user — and that user wants to authorize specific scopes. The OAuth bridge primitive lets your agent issue access tokens, refresh tokens, and scoped consent screens.</p>

<h2 style="font:600 20px var(--display);margin:32px 0 10px">Setup</h2>
<ol style="color:var(--dim2);line-height:1.85;padding-left:20px">
  <li>POST <code>/v1/agents/:did/oauth/register</code> with client name + redirect URIs + scopes.</li>
  <li>We mint a <code>client_id</code> + <code>client_secret</code>.</li>
  <li>Direct end-users to <code>/oauth/authorize?client_id=...&redirect_uri=...&scope=...&state=...</code>.</li>
  <li>They see a consent screen, approve, get redirected with an auth code.</li>
  <li>Exchange code for an access token at <code>POST /oauth/token</code>.</li>
  <li>Verify any token at <code>POST /v1/oauth/introspect</code>.</li>
</ol>

<h2 style="font:600 20px var(--display);margin:32px 0 10px">Standards</h2>
<p style="color:var(--dim2);line-height:1.7">OAuth 2.1 + PKCE mandatory. Refresh-token rotation. Scoped consent. Token introspection (RFC 7662). Revocation (RFC 7009). OpenID Connect discovery at <code>/.well-known/openid-configuration</code>.</p>`);
}

function openapiPage() {
  return bridge('openapi', '📜', 'OpenAPI', 'Point any OpenAPI-aware tool at our spec.', `
<h2 style="font:600 20px var(--display);margin:0 0 10px">Spec URL</h2>
<pre style="background:var(--card);border:1px solid var(--br);border-radius:var(--r-md);padding:14px;overflow-x:auto;font-size:13px"><code>https://openheab.com/openapi.json</code></pre>
<p style="color:var(--dim2);line-height:1.7;margin-top:8px">OpenAPI 3.1, regenerated on every deploy. Lists every documented route + schema.</p>

<h2 style="font:600 20px var(--display);margin:32px 0 10px">Compatible tools</h2>
<ul style="color:var(--dim2);line-height:1.85;padding-left:20px">
  <li><strong style="color:var(--fg)">Postman</strong> — Import → URL → paste spec URL.</li>
  <li><strong style="color:var(--fg)">Insomnia</strong> — Import → from URL.</li>
  <li><strong style="color:var(--fg)">Bruno</strong> — Import collection from OpenAPI.</li>
  <li><strong style="color:var(--fg)">Swagger Editor</strong> — File → Import URL.</li>
  <li><strong style="color:var(--fg)">openapi-generator</strong> — Generate client SDKs in any language.</li>
  <li><strong style="color:var(--fg)">Hoppscotch</strong> — Settings → Import → OpenAPI.</li>
</ul>

<h2 style="font:600 20px var(--display);margin:32px 0 10px">Generate a client</h2>
<pre style="background:var(--card);border:1px solid var(--br);border-radius:var(--r-md);padding:14px;overflow-x:auto;font-size:13px"><code>openapi-generator-cli generate \\
  -i https://openheab.com/openapi.json \\
  -g python \\
  -o ./openheab-python</code></pre>`);
}

function mcpHostPage() {
  return bridge('mcp-host', '🔌', 'Host your MCP server', 'Expose your tools to OpenHeab agents.', `
<h2 style="font:600 20px var(--display);margin:0 0 10px">Why</h2>
<p style="color:var(--dim2);line-height:1.7">OpenHeab agents auto-discover MCP servers and treat them as first-class tools. Host your domain-specific tools — internal APIs, proprietary models, niche data sources — as an MCP server and agents can call them.</p>

<h2 style="font:600 20px var(--display);margin:32px 0 10px">Quickstart</h2>
<pre style="background:var(--card);border:1px solid var(--br);border-radius:var(--r-md);padding:14px;overflow-x:auto;font-size:13px"><code>npm i @modelcontextprotocol/sdk
# Or:
pip install mcp</code></pre>

<p style="color:var(--dim2);line-height:1.7;margin-top:10px">Implement the JSON-RPC tools/list and tools/call methods. Reference: <a href="https://modelcontextprotocol.io">modelcontextprotocol.io</a>.</p>

<h2 style="font:600 20px var(--display);margin:32px 0 10px">Register with us</h2>
<ol style="color:var(--dim2);line-height:1.85;padding-left:20px">
  <li>Host your MCP server publicly (or in a VPC we can reach).</li>
  <li>POST <code>/v1/mcp-servers</code> with <code>{ url, auth_kind, agent_did }</code>.</li>
  <li>Your tools appear in <a href="/mcp/registry">/mcp/registry</a> under your namespace.</li>
  <li>Agents that grant you access can call them via the standard MCP flow.</li>
</ol>

<h2 style="font:600 20px var(--display);margin:32px 0 10px">Pricing tools</h2>
<p style="color:var(--dim2);line-height:1.7">Per-call pricing supported. We collect from the calling agent's wallet and settle to yours weekly. 30% platform fee on paid tools.</p>`);
}

function webhooksOutPage() {
  return bridge('webhooks-out', '📤', 'Emit webhooks from your agent', 'Your agent fires webhooks when its own events happen.', `
<h2 style="font:600 20px var(--display);margin:0 0 10px">Why</h2>
<p style="color:var(--dim2);line-height:1.7">Your agent isn't just a recipient — it's a publisher too. Fire webhooks when your business logic completes, when a sub-task finishes, when a milestone is hit.</p>

<h2 style="font:600 20px var(--display);margin:32px 0 10px">Fire an event</h2>
<pre style="background:var(--card);border:1px solid var(--br);border-radius:var(--r-md);padding:14px;overflow-x:auto;font-size:13px"><code>POST /v1/agents/:did/events/emit
{
  "event_type": "my-app.thing-completed",
  "payload": { "thing_id": "...", "result": "..." }
}</code></pre>

<h2 style="font:600 20px var(--display);margin:32px 0 10px">Subscribers</h2>
<p style="color:var(--dim2);line-height:1.7">Any subscriber configured at <a href="/webhooks">/webhooks</a> with matching <code>event_types</code> gets the delivery. HMAC-signed, retried with exponential backoff, audit-chained.</p>

<h2 style="font:600 20px var(--display);margin:32px 0 10px">Schema</h2>
<p style="color:var(--dim2);line-height:1.7">Free-form payload. We add envelope: <code>{ event_id, event_type, source_did, occurred_at, signature, payload }</code>. Verify the signature with the subscription's secret + timing-safe compare.</p>`);
}

function registerRealworldV2Routes(app, _pool) {
  const sendHtml = (res, html) => { res.setHeader('content-type', 'text/html; charset=utf-8'); res.send(html); };
  app.get('/realworld/zapier', (req, res) => sendHtml(res, zapierPage()));
  app.get('/realworld/n8n', (req, res) => sendHtml(res, n8nPage()));
  app.get('/realworld/make', (req, res) => sendHtml(res, makePage()));
  app.get('/realworld/ifttt', (req, res) => sendHtml(res, iftttPage()));
  app.get('/realworld/oauth', (req, res) => sendHtml(res, oauthPage()));
  app.get('/realworld/openapi', (req, res) => sendHtml(res, openapiPage()));
  app.get('/realworld/mcp-host', (req, res) => sendHtml(res, mcpHostPage()));
  app.get('/realworld/webhooks-out', (req, res) => sendHtml(res, webhooksOutPage()));
}

async function migrate(_pool) {}
module.exports = { migrate, registerRealworldV2Routes };
