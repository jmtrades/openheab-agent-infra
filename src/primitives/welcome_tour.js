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
    blurb: 'Add the substrate as an MCP server in Claude Desktop, Cursor, or any MCP-aware tool. 150+ tools available.',
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

const { head: dsHead, NAV_HTML, FOOTER_HTML } = require('../design_system');

function renderTourPage(activeStepIdx) {
  const idx = Math.max(0, Math.min(activeStepIdx, STEPS.length - 1));
  const step = STEPS[idx];
  const progress = Math.round(((idx + 1) / STEPS.length) * 100);

  const extraHead = `<style>
.tour-shell{max-width:820px;margin:0 auto;padding:40px 0 64px}
.progress{background:var(--bg-elev);height:4px;border-radius:99px;margin-bottom:10px;overflow:hidden;border:1px solid var(--br)}
.progress-fill{background:linear-gradient(90deg,var(--acc),var(--acc-strong));height:100%;width:${progress}%;transition:width var(--t-slow) var(--ease-out);border-radius:99px}
.progress-label{font:500 12px/1 var(--mono);color:var(--fg-dim);margin-bottom:32px}
.steps-nav{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:32px}
.steps-nav a{padding:6px 11px;border-radius:99px;font:500 11.5px/1.4 var(--sans);text-decoration:none;background:var(--bg-elev);color:var(--fg-dim2);border:1px solid var(--br);transition:background-color var(--t-fast) var(--ease-out),color var(--t-fast) var(--ease-out),border-color var(--t-fast) var(--ease-out)}
.steps-nav a:hover{color:var(--fg);border-color:var(--br-strong)}
.steps-nav a.done{color:var(--acc);border-color:var(--br-strong)}
.steps-nav a.active{background:var(--fg);color:var(--bg);border-color:var(--fg)}
.step-num{font:500 11px/1 var(--mono);color:var(--acc);text-transform:uppercase;letter-spacing:1.4px;margin-bottom:10px}
.tour-shell h1{font-size:34px;font-weight:600;letter-spacing:-1px;margin-bottom:14px;line-height:1.1}
.blurb{color:var(--fg-dim);font-size:16px;margin-bottom:28px;max-width:640px;line-height:1.55}
.code-tabs{display:flex;gap:4px;background:var(--bg-elev);padding:4px;border-radius:8px;width:fit-content;margin-bottom:12px;border:1px solid var(--br)}
.code-tab{padding:6px 13px;border:0;background:transparent;color:var(--fg-dim);font-size:12.5px;font-weight:500;border-radius:6px;cursor:pointer;font-family:var(--sans);transition:background-color var(--t-fast) var(--ease-out),color var(--t-fast) var(--ease-out)}
.code-tab:hover{color:var(--fg)}
.code-tab.active{background:var(--fg);color:var(--bg)}
.code-block{background:var(--bg-elev);border:1px solid var(--br);padding:18px 22px;border-radius:10px;font:13px/1.65 var(--mono);color:var(--fg-dim);overflow-x:auto;white-space:pre;position:relative;margin-bottom:32px}
.copy-btn{position:absolute;top:10px;right:10px;background:var(--bg);color:var(--fg-dim);border:1px solid var(--br);padding:5px 11px;border-radius:6px;font-size:11.5px;cursor:pointer;font-family:var(--sans);transition:background-color var(--t-fast) var(--ease-out),color var(--t-fast) var(--ease-out)}
.copy-btn:hover{background:var(--bg-elev2);color:var(--fg)}
.copy-btn:active{transform:scale(0.97)}
.celebrate{font-size:60px;margin-bottom:18px;animation:rise 500ms var(--ease-out) both}
.tour-cta-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px;margin-top:24px}
.tour-cta-card{background:var(--bg-elev);border:1px solid var(--br);padding:18px;border-radius:10px;text-decoration:none;transition:border-color var(--t-fast) var(--ease-out),background-color var(--t-fast) var(--ease-out),transform var(--t-fast) var(--ease-out);display:block}
.tour-cta-card:hover{border-color:var(--br-strong);background:var(--bg-elev2);transform:translateY(-1px);text-decoration:none}
.tour-cta-card h3{font-size:14.5px;color:var(--fg);margin-bottom:4px;font-weight:600}
.tour-cta-card p{font-size:12.5px;color:var(--fg-dim)}
.tour-actions{display:flex;gap:10px;align-items:center;margin-top:16px;flex-wrap:wrap}
</style>`;
  return dsHead('Welcome — OpenHeab', `Step ${idx + 1} of ${STEPS.length}: ${step.title}`, { path: '/tour', extraHead })
    + NAV_HTML('tour') + `<main>
<div class="tour-shell">
  <div class="progress"><div class="progress-fill"></div></div>
  <div class="progress-label">Step ${idx + 1} of ${STEPS.length} · ${progress}% complete</div>

  <div class="steps-nav">
${STEPS.map((s, i) => `    <a href="/tour?step=${i}" class="${i === idx ? 'active' : (i < idx ? 'done' : '')}">${i < idx ? '✓ ' : ''}${i + 1}. ${s.title}</a>`).join('\n')}
  </div>

  <div class="step-num">Step ${idx + 1}</div>
  <h1>${step.title}</h1>
  <p class="blurb">${step.blurb}</p>

${step.code ? `  <div class="code-tabs" id="tabs">
    <button class="code-tab active" data-lang="curl">curl</button>
    <button class="code-tab" data-lang="js">JavaScript</button>
  </div>
  <div class="code-block" id="code"><button class="copy-btn" onclick="copyCode()">Copy</button><span id="code-content">${escapeHtml(step.code.curl)}</span></div>` : `  <div class="celebrate">🎉</div>
  <div class="tour-cta-grid">
    <a class="tour-cta-card" href="/docs"><h3>Read the docs</h3><p>9 sections on every primitive</p></a>
    <a class="tour-cta-card" href="/sdk"><h3>SDK examples</h3><p>curl, Python, TypeScript, Go, Rust</p></a>
    <a class="tour-cta-card" href="/mcp"><h3>MCP server</h3><p>149+ tools as JSON-RPC</p></a>
    <a class="tour-cta-card" href="/dashboard"><h3>Your dashboard</h3><p>Live agent state</p></a>
    <a class="tour-cta-card" href="/pricing"><h3>Upgrade plan</h3><p>For production volumes</p></a>
    <a class="tour-cta-card" href="/activity"><h3>Activity feed</h3><p>See the substrate alive</p></a>
  </div>`}

  <div class="tour-actions">
    ${idx > 0 ? `<a class="btn" href="/tour?step=${idx - 1}">← Previous</a>` : ''}
    ${idx < STEPS.length - 1 ? `<a class="btn primary" href="/tour?step=${idx + 1}">I'm done — next <span class="arr">→</span></a>` : `<a class="btn primary" href="/dashboard">Open dashboard <span class="arr">→</span></a>`}
  </div>
</div>
</main>
${step.code ? `<script>
const SNIPPETS = ${JSON.stringify({ curl: step.code.curl, js: step.code.js })};
let lang = 'curl';
document.getElementById('tabs').addEventListener('click', e => {
  if (!e.target.matches('.code-tab')) return;
  document.querySelectorAll('.code-tab').forEach(b => b.classList.remove('active'));
  e.target.classList.add('active');
  lang = e.target.dataset.lang;
  document.getElementById('code-content').textContent = SNIPPETS[lang];
});
function copyCode(){
  navigator.clipboard.writeText(SNIPPETS[lang]).then(() => {
    const btn = document.querySelector('.copy-btn');
    btn.textContent = 'Copied';
    setTimeout(() => btn.textContent = 'Copy', 1500);
  });
}
</script>` : ''}` + FOOTER_HTML();
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
