// ============================================================================
// welcome_tour.js — `/welcome` polished step-by-step first-time tour. Walks
// a new user through: 1) signup, 2) view DID + wallet, 3) first inference,
// 4) first transfer, 5) explore MCP. Each step has copy-paste curl + JS,
// "I'm done" button advances to next step. Tracks progress in URL.
// ============================================================================

async function migrate(pool) {}

const STEPS = [
  {
    id: 'signup',
    title: 'Create your first agent',
    blurb: 'POST /v1/signup gives you a cryptographic identity, a USDC wallet on Base, and an API key in one call. Save what comes back — the API key is shown only once.',
    code: {
      curl: `curl -X POST $BASE/v1/signup \\
  -H "content-type: application/json" \\
  -d '{"email":"you@example.com","plan":"free"}'`,
      js: `const r = await fetch(BASE + '/v1/signup', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'you@example.com', plan: 'free' })
});
const { did, api_key } = await r.json();`
    }
  },
  {
    id: 'profile',
    title: 'View your agent profile',
    blurb: 'Confirm everything provisioned correctly. The DID resolves to your public key + wallet + KYC status.',
    code: {
      curl: `curl $BASE/v1/agents/$DID \\
  -H "authorization: Bearer $API_KEY"`,
      js: `const r = await fetch(\`\${BASE}/v1/agents/\${did}\`, {
  headers: { authorization: \`Bearer \${api_key}\` }
});
console.log(await r.json());`
    }
  },
  {
    id: 'inference',
    title: 'Make your first inference call',
    blurb: 'OpenHeab routes to the cheapest provider supporting your model. 10% markup. Provider-neutral.',
    code: {
      curl: `curl -X POST $BASE/v1/agents/$DID/inference \\
  -H "authorization: Bearer $API_KEY" \\
  -H "content-type: application/json" \\
  -d '{"model":"claude-haiku","messages":[{"role":"user","content":"hello"}]}'`,
      js: `const r = await fetch(\`\${BASE}/v1/agents/\${did}/inference\`, {
  method: 'POST',
  headers: {
    authorization: \`Bearer \${api_key}\`,
    'content-type': 'application/json'
  },
  body: JSON.stringify({
    model: 'claude-haiku',
    messages: [{ role: 'user', content: 'hello' }]
  })
});
console.log((await r.json()).choices[0].message.content);`
    }
  },
  {
    id: 'wallet',
    title: 'Check your USDC wallet',
    blurb: 'Non-custodial. Your private key is encrypted at rest with per-tenant KEKs. Send a tiny deposit to see the balance update.',
    code: {
      curl: `curl $BASE/v1/agents/$DID/wallet \\
  -H "authorization: Bearer $API_KEY"`,
      js: `const w = await fetch(\`\${BASE}/v1/agents/\${did}/wallet\`, {
  headers: { authorization: \`Bearer \${api_key}\` }
}).then(r => r.json());
console.log(\`Address: \${w.address}\\nBalance: \${w.balance} USDC\`);`
    }
  },
  {
    id: 'mcp',
    title: 'Connect via MCP',
    blurb: 'Add the substrate as an MCP server in Claude Desktop, Cursor, or any MCP-aware tool. 145+ tools available.',
    code: {
      curl: `curl -X POST $BASE/mcp \\
  -H "content-type: application/json" \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`,
      js: `// In claude_desktop_config.json:
{
  "mcpServers": {
    "openheab": {
      "url": "https://api.openheab.com/mcp",
      "headers": { "authorization": "Bearer YOUR_API_KEY" }
    }
  }
}`
    }
  },
  {
    id: 'done',
    title: 'You are ready',
    blurb: 'You have everything an agent needs: identity, money, inference, tools, audit chain. Visit /docs for deeper guides or /sdk for full SDK examples in 5 languages.',
    code: null
  }
];

function renderTourPage(activeStepIdx) {
  const idx = Math.max(0, Math.min(activeStepIdx, STEPS.length - 1));
  const step = STEPS[idx];
  const progress = Math.round(((idx + 1) / STEPS.length) * 100);

  return `<!doctype html><html><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>Welcome — OpenHeab</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Inter', sans-serif; background: #0a0a0f; color: #e7e7ee; line-height: 1.6; min-height: 100vh; }
.wrap { max-width: 820px; margin: 0 auto; padding: 48px 24px 80px; }
.topnav { display: flex; justify-content: space-between; align-items: center; margin-bottom: 40px; }
.topnav .brand { font-weight: 700; font-size: 18px; color: #fff; text-decoration: none; }
.topnav .links a { color: #888; margin-left: 18px; font-size: 13px; text-decoration: none; }
.topnav .links a:hover { color: #fff; }
.progress { background: #1a1a25; height: 4px; border-radius: 100px; margin-bottom: 8px; overflow: hidden; }
.progress-fill { background: linear-gradient(90deg, #4f46e5, #818cf8); height: 100%; width: ${progress}%; transition: width 0.3s; }
.progress-label { font-size: 12px; color: #888; margin-bottom: 36px; font-family: monospace; }
.step-num { font-size: 11px; color: #4f46e5; font-weight: 700; text-transform: uppercase; letter-spacing: 1.2px; margin-bottom: 8px; }
h1 { font-size: 36px; font-weight: 700; letter-spacing: -0.8px; margin-bottom: 14px; }
.blurb { color: #aaa; font-size: 16px; margin-bottom: 28px; max-width: 640px; }
.code-tabs { display: flex; gap: 4px; background: #14141c; padding: 4px; border-radius: 8px; width: fit-content; margin-bottom: 12px; }
.code-tab { padding: 6px 14px; border: 0; background: transparent; color: #888; font-size: 13px; font-weight: 500; border-radius: 6px; cursor: pointer; }
.code-tab.active { background: #4f46e5; color: #fff; }
.code-block { background: #0a0a12; border: 1px solid #1a1a25; padding: 20px 24px; border-radius: 10px; font-family: 'SF Mono', 'Menlo', monospace; font-size: 13px; color: #c5c5d5; overflow-x: auto; white-space: pre; position: relative; line-height: 1.7; margin-bottom: 32px; }
.copy-btn { position: absolute; top: 12px; right: 12px; background: #1a1a25; color: #aaa; border: 1px solid #25253a; padding: 5px 12px; border-radius: 6px; font-size: 12px; cursor: pointer; font-family: inherit; }
.copy-btn:hover { background: #25253a; color: #fff; }
.actions { display: flex; gap: 12px; align-items: center; margin-top: 16px; }
.btn { display: inline-block; padding: 12px 24px; background: #4f46e5; color: #fff; text-decoration: none; border: 0; border-radius: 8px; font-weight: 600; cursor: pointer; font-size: 14px; }
.btn:hover { background: #4338ca; }
.btn.secondary { background: #1a1a25; color: #ccc; border: 1px solid #25253a; }
.btn.secondary:hover { background: #25253a; color: #fff; }
.steps-nav { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 36px; }
.steps-nav a { padding: 6px 12px; border-radius: 20px; font-size: 12px; font-weight: 500; text-decoration: none; background: #14141c; color: #666; }
.steps-nav a.done { background: #14141c; color: #4f46e5; }
.steps-nav a.active { background: #4f46e5; color: #fff; }
.steps-nav a:hover { color: #fff; }
.celebrate { font-size: 64px; margin-bottom: 20px; }
.cta-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; margin-top: 24px; }
.cta-card { background: #14141c; border: 1px solid #1a1a25; padding: 20px; border-radius: 10px; text-decoration: none; transition: border-color 0.15s; }
.cta-card:hover { border-color: #4f46e5; }
.cta-card h3 { font-size: 15px; color: #fff; margin-bottom: 4px; }
.cta-card p { font-size: 12px; color: #888; }
</style></head><body>

<div class="wrap">

<nav class="topnav">
  <a class="brand" href="/">OpenHeab</a>
  <div class="links">
    <a href="/docs">Docs</a>
    <a href="/sdk">SDK</a>
    <a href="/pricing">Pricing</a>
    <a href="/dashboard">Dashboard</a>
  </div>
</nav>

<div class="progress"><div class="progress-fill"></div></div>
<div class="progress-label">Step ${idx + 1} of ${STEPS.length} · ${progress}% complete</div>

<div class="steps-nav">
${STEPS.map((s, i) => `<a href="/welcome?step=${i}" class="${i === idx ? 'active' : (i < idx ? 'done' : '')}">${i < idx ? '✓ ' : ''}${i + 1}. ${s.title}</a>`).join('')}
</div>

<div class="step-num">Step ${idx + 1}</div>
<h1>${step.title}</h1>
<p class="blurb">${step.blurb}</p>

${step.code ? `
<div class="code-tabs" id="tabs">
  <button class="code-tab active" data-lang="curl">curl</button>
  <button class="code-tab" data-lang="js">JavaScript</button>
</div>
<div class="code-block" id="code"><button class="copy-btn" onclick="copyCode()">copy</button><span id="code-content">${escapeHtml(step.code.curl)}</span></div>
` : `
<div class="celebrate">🎉</div>
<div class="cta-grid">
  <a class="cta-card" href="/docs"><h3>Read the docs</h3><p>9 sections on every primitive</p></a>
  <a class="cta-card" href="/sdk"><h3>SDK examples</h3><p>curl, Python, TypeScript, Go, Rust</p></a>
  <a class="cta-card" href="/mcp"><h3>MCP server</h3><p>145+ tools as JSON-RPC</p></a>
  <a class="cta-card" href="/dashboard"><h3>Your dashboard</h3><p>Live agent state</p></a>
  <a class="cta-card" href="/pricing"><h3>Upgrade plan</h3><p>For production volumes</p></a>
  <a class="cta-card" href="/activity"><h3>Activity feed</h3><p>See the substrate alive</p></a>
</div>
`}

<div class="actions">
  ${idx > 0 ? `<a class="btn secondary" href="/welcome?step=${idx - 1}">← Previous</a>` : ''}
  ${idx < STEPS.length - 1 ? `<a class="btn" href="/welcome?step=${idx + 1}">I'm done — next step →</a>` : `<a class="btn" href="/dashboard">Open dashboard →</a>`}
</div>

</div>
${step.code ? `
<script>
const SNIPPETS = ${JSON.stringify({ curl: step.code.curl, js: step.code.js })};
let lang = 'curl';
document.getElementById('tabs').addEventListener('click', e => {
  if (!e.target.matches('.code-tab')) return;
  document.querySelectorAll('.code-tab').forEach(b => b.classList.remove('active'));
  e.target.classList.add('active');
  lang = e.target.dataset.lang;
  document.getElementById('code-content').textContent = SNIPPETS[lang];
});
function copyCode() {
  navigator.clipboard.writeText(SNIPPETS[lang]).then(() => {
    const btn = document.querySelector('.copy-btn');
    btn.textContent = 'copied!';
    setTimeout(() => btn.textContent = 'copy', 1500);
  });
}
</script>` : ''}
</body></html>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function registerWelcomeTourRoutes(app) {
  app.get('/tour', (req, res) => {
    const step = parseInt(req.query.step) || 0;
    res.set('content-type', 'text/html; charset=utf-8');
    res.set('cache-control', 'public, max-age=300');
    res.send(renderTourPage(step));
  });

  app.get('/tour.json', (req, res) => {
    res.json({ steps: STEPS, total: STEPS.length });
  });
}

async function migrateNoop(pool) {}

module.exports = { migrate: migrateNoop, registerWelcomeTourRoutes, STEPS };
