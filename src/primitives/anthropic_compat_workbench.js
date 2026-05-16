// ============================================================================
// anthropic_compat_workbench.js — three more developer-experience surfaces:
//   POST /v1/messages      — Anthropic-compatible drop-in (different shape
//                            than OpenAI /v1/chat/completions, mirrors
//                            api.anthropic.com/v1/messages exactly)
//   GET  /workbench        — interactive prompt-builder UI (like Anthropic
//                            Workbench / OpenAI Playground)
//   GET  /cookbook         — real recipes page with full code examples
// ============================================================================
const crypto = require('crypto');

async function migrate(pool) {}

async function resolveAgent(pool, req) {
  try { return await require('./me_endpoints').resolveAgentFromRequest(pool, req); }
  catch { return null; }
}

async function callAnthropic(body) {
  if (!process.env.ANTHROPIC_API_KEY) {
    const prompt = (body.messages || []).map(m => m.content || '').join(' ');
    return {
      id: 'msg_' + crypto.randomBytes(12).toString('hex'),
      type: 'message', role: 'assistant',
      content: [{ type: 'text', text: '[STUB] Set ANTHROPIC_API_KEY to get real responses. You sent ' + String(prompt).length + ' chars.' }],
      model: body.model || 'claude-haiku',
      stop_reason: 'end_turn',
      usage: { input_tokens: Math.ceil(String(prompt).length / 4), output_tokens: 20 },
      _openheab_stub: true
    };
  }
  if (typeof fetch !== 'function') return { type: 'error', error: { type: 'api_error', message: 'fetch_unavailable' } };
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify(body)
    });
    return await r.json();
  } catch (e) {
    return { type: 'error', error: { type: 'api_error', message: 'upstream_failed: ' + e.message } };
  }
}

const RECIPES = [
  {
    slug: 'agent-pays-agent-usdc',
    title: 'Agent pays another agent in USDC',
    blurb: 'Sign a transfer with Ed25519, audit-chained, 1% fee.',
    languages: ['curl', 'python', 'typescript'],
    snippets: {
      curl: `# Sign payload first (BODY contains the JSON request body):
SIG=$(printf "POST\\n/v1/agents/$DID/transfer\\n$(echo -n "$BODY" | sha256sum | awk '{print $1}')" \\
      | openssl dgst -sha256 -sign $PRIV_KEY_PEM | base64 -w0)
curl -X POST https://api.openheab.com/v1/agents/$DID/transfer \\
  -H "x-agent-did: $DID" -H "x-agent-signature: $SIG" \\
  -H "content-type: application/json" \\
  -d "$BODY"  # e.g. '{"to_did":"did:op:other","amount_raw":"1000000"}'`,
      python: `from nacl.signing import SigningKey
import hashlib, base64, json, httpx

body = {"to_did": "did:op:recipient", "amount_raw": "1000000"}  # 1 USDC
canonical = f"POST\\n/v1/agents/{did}/transfer\\n{hashlib.sha256(json.dumps(body).encode()).hexdigest()}"
sig = base64.b64encode(SigningKey(priv_key_bytes).sign(canonical.encode()).signature).decode()

r = httpx.post(f"https://api.openheab.com/v1/agents/{did}/transfer",
    headers={"x-agent-did": did, "x-agent-signature": sig}, json=body)
print(r.json())`,
      typescript: `import nacl from 'tweetnacl';
const body = { to_did: 'did:op:recipient', amount_raw: '1000000' };
const sha256 = (s) => crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  .then(b => Array.from(new Uint8Array(b)).map(b => b.toString(16).padStart(2,'0')).join(''));
const canonical = \`POST\\n/v1/agents/\${did}/transfer\\n\${await sha256(JSON.stringify(body))}\`;
const sig = Buffer.from(nacl.sign.detached(new TextEncoder().encode(canonical), privKey)).toString('base64');
await fetch(\`https://api.openheab.com/v1/agents/\${did}/transfer\`, {
  method: 'POST',
  headers: { 'x-agent-did': did, 'x-agent-signature': sig, 'content-type': 'application/json' },
  body: JSON.stringify(body)
});`
    }
  },
  {
    slug: 'streaming-inference',
    title: 'Streaming inference with SSE',
    blurb: 'Stream tokens as they generate using server-sent events.',
    languages: ['curl', 'python', 'typescript'],
    snippets: {
      curl: `curl -N -X POST https://api.openheab.com/v1/chat/completions \\
  -H "authorization: Bearer $OPENHEAB_API_KEY" \\
  -H "content-type: application/json" \\
  -d '{"model":"claude-haiku","stream":true,"messages":[{"role":"user","content":"write a haiku"}]}'`,
      python: `import httpx, json
with httpx.stream("POST", "https://api.openheab.com/v1/chat/completions",
    headers={"authorization": f"Bearer {key}"},
    json={"model": "claude-haiku", "stream": True,
          "messages": [{"role": "user", "content": "write a haiku"}]}) as r:
    for line in r.iter_lines():
        if line.startswith("data: "):
            data = line[6:]
            if data == "[DONE]": break
            chunk = json.loads(data)
            print(chunk["choices"][0]["delta"].get("content", ""), end="", flush=True)`,
      typescript: `const r = await fetch('https://api.openheab.com/v1/chat/completions', {
  method: 'POST',
  headers: { authorization: \`Bearer \${key}\`, 'content-type': 'application/json' },
  body: JSON.stringify({ model: 'claude-haiku', stream: true,
    messages: [{ role: 'user', content: 'write a haiku' }] })
});
const reader = r.body.getReader();
const decoder = new TextDecoder();
while (true) {
  const { value, done } = await reader.read();
  if (done) break;
  for (const line of decoder.decode(value).split('\\n')) {
    if (!line.startsWith('data: ')) continue;
    const data = line.slice(6); if (data === '[DONE]') return;
    const c = JSON.parse(data); process.stdout.write(c.choices[0].delta.content || '');
  }
}`
    }
  },
  {
    slug: 'embed-rag-pipeline',
    title: 'RAG pipeline — embed + search + generate',
    blurb: 'Index documents with /v1/embeddings, query with vector similarity, generate with context.',
    languages: ['python', 'typescript'],
    snippets: {
      python: `# 1) Embed your docs
docs = ["OpenHeab is an agent substrate.", "MCP is the agent protocol."]
embeds = httpx.post("https://api.openheab.com/v1/embeddings",
    headers={"authorization": f"Bearer {key}"},
    json={"model": "text-embedding-3-small", "input": docs}).json()
vectors = [d["embedding"] for d in embeds["data"]]

# 2) Store in your vector DB (Postgres pgvector / Pinecone / Weaviate)

# 3) On query, embed the question, find nearest doc, generate with context
q_embed = httpx.post("...", json={"input": "what is openheab"}).json()["data"][0]["embedding"]
nearest = find_nearest(q_embed, vectors)  # your vector DB call
answer = httpx.post("https://api.openheab.com/v1/chat/completions",
    json={"model": "claude-haiku",
          "messages": [{"role": "user", "content": f"Context: {nearest}\\n\\nQ: what is openheab"}]})`,
      typescript: `// Same flow in TS — embed -> store -> retrieve -> generate`
    }
  },
  {
    slug: 'mcp-tool-use',
    title: 'Use OpenHeab tools from Claude via MCP',
    blurb: 'Add the substrate as an MCP server in Claude Desktop; every tool becomes available.',
    languages: ['json'],
    snippets: {
      json: `// claude_desktop_config.json
{
  "mcpServers": {
    "openheab": {
      "url": "https://api.openheab.com/mcp",
      "headers": { "authorization": "Bearer YOUR_API_KEY" }
    }
  }
}

// Now Claude can call any of 149 tools: send_usdc, look_up_agent,
// run_kyc_check, query_audit_chain, issue_card, etc.`
    }
  },
  {
    slug: 'webhook-handler',
    title: 'Receive + verify webhook deliveries',
    blurb: 'Subscribe to events; verify HMAC signature on every delivery.',
    languages: ['python', 'typescript'],
    snippets: {
      python: `# 1) Subscribe (once)
httpx.post(f"https://api.openheab.com/v1/agents/{did}/webhooks/subscribe",
    headers={"authorization": f"Bearer {key}"},
    json={"target_url": "https://yours.com/wh",
          "event_types": ["transfer.completed", "kyc.passed"]})
# Save the returned 'secret'.

# 2) Verify deliveries in your webhook handler
import hmac, hashlib
@app.post("/wh")
def webhook(req):
    sig = req.headers["x-openheab-signature"]
    expected = hmac.new(secret.encode(), req.body, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(sig, expected):
        return 400
    # Handle event
    print(req.json["event_type"], req.json)
    return 200`,
      typescript: `import crypto from 'crypto';
app.post('/wh', (req, res) => {
  const expected = crypto.createHmac('sha256', secret).update(req.body).digest('hex');
  if (req.headers['x-openheab-signature'] !== expected) return res.status(400).end();
  console.log(req.body.event_type, req.body);
  res.json({ ok: true });
});`
    }
  },
  {
    slug: 'kyc-then-spend',
    title: 'KYC verification → unlock higher spending tier',
    blurb: 'Submit ID + selfie, get Tier 2 verification, transact $10K/day.',
    languages: ['python'],
    snippets: {
      python: `# Submit KYC
r = httpx.post(f"https://api.openheab.com/v1/agents/{did}/kyc/submit",
    headers={"authorization": f"Bearer {key}"},
    json={"country": "US", "tier": 2,
          "documents": [{"type": "id_card", "front_url": "...", "back_url": "..."},
                        {"type": "selfie", "url": "..."}]})

# Poll status
while True:
    status = httpx.get(f"https://api.openheab.com/v1/agents/{did}/kyc",
        headers={"authorization": f"Bearer {key}"}).json()
    if status["status"] in ["verified", "rejected"]: break
    time.sleep(5)

# Now your daily limit is $10K
print(f"KYC verified at tier {status['tier']}")`
    }
  }
];

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

function renderWorkbenchPage() {
  return `<!doctype html><html><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>Workbench — OpenHeab</title>
<meta name="description" content="Interactive prompt builder. Pick a model, set system + user prompts, run, iterate.">
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Inter', sans-serif; background: #0a0a0f; color: #e7e7ee; min-height: 100vh; display: flex; flex-direction: column; }
.topnav { display: flex; justify-content: space-between; align-items: center; padding: 14px 24px; border-bottom: 1px solid #1a1a25; }
.topnav .logo { font-weight: 700; font-size: 18px; color: #fff; text-decoration: none; }
.topnav .nav-links a { color: #888; margin-left: 18px; font-size: 13px; text-decoration: none; }
.topnav .nav-links a:hover { color: #fff; }
.wrap { flex: 1; display: grid; grid-template-columns: 320px 1fr 320px; gap: 0; min-height: 0; }
@media (max-width: 1100px) { .wrap { grid-template-columns: 1fr; } .sidebar { display: none; } }
.sidebar { background: #0f0f17; border-right: 1px solid #1a1a25; padding: 24px; overflow-y: auto; }
.sidebar.right { border-right: none; border-left: 1px solid #1a1a25; }
.sidebar label { display: block; font-size: 11px; color: #888; text-transform: uppercase; letter-spacing: 0.5px; margin: 16px 0 6px; font-weight: 600; }
.sidebar input, .sidebar select, .sidebar textarea {
  width: 100%; padding: 9px 12px; background: #14141c; border: 1px solid #1f1f2a;
  color: #fff; border-radius: 6px; font-size: 13px; font-family: inherit; outline: none;
}
.sidebar input:focus, .sidebar select:focus, .sidebar textarea:focus { border-color: #4f46e5; }
.sidebar textarea { min-height: 100px; resize: vertical; font-family: 'SF Mono', monospace; font-size: 12px; }
.main { display: flex; flex-direction: column; padding: 24px; min-height: 0; }
.main textarea {
  flex: 1; min-height: 240px; padding: 16px; background: #14141c; border: 1px solid #1f1f2a;
  color: #fff; border-radius: 10px; font-family: 'SF Mono', monospace; font-size: 13px;
  line-height: 1.6; outline: none; resize: vertical;
}
.main textarea:focus { border-color: #4f46e5; }
.actions { display: flex; gap: 10px; margin-top: 14px; align-items: center; }
.btn { padding: 10px 22px; background: #4f46e5; color: #fff; border: 0; border-radius: 8px; font-weight: 600; cursor: pointer; font-size: 14px; }
.btn:hover { background: #4338ca; }
.btn:disabled { opacity: 0.5; cursor: not-allowed; }
.btn.secondary { background: #1a1a25; color: #ccc; border: 1px solid #25253a; }
.btn.secondary:hover { background: #25253a; color: #fff; }
.status { color: #888; font-size: 12px; font-family: monospace; }
.output { flex: 1; margin-top: 18px; padding: 18px; background: #0a0a12; border: 1px solid #1a1a25; border-radius: 10px; font-family: 'SF Mono', monospace; font-size: 13px; line-height: 1.7; color: #c5c5d5; overflow-y: auto; max-height: 360px; white-space: pre-wrap; min-height: 80px; }
.usage { font-size: 11px; color: #666; margin-top: 8px; font-family: monospace; }
.curl-out {
  font-size: 11px; color: #666; padding: 12px; background: #0a0a12; border-radius: 6px;
  margin-top: 16px; word-break: break-all; font-family: 'SF Mono', monospace; line-height: 1.5;
}
h1 { font-size: 20px; margin-bottom: 4px; }
.hint { color: #666; font-size: 13px; margin-bottom: 18px; }
</style></head><body>

<nav class="topnav">
  <a class="logo" href="/">OpenHeab</a>
  <div class="nav-links">
    <a href="/workbench" style="color:#fff">Workbench</a>
    <a href="/cookbook">Cookbook</a>
    <a href="/docs">Docs</a>
    <a href="/explorer">API explorer</a>
    <a href="/dashboard">Dashboard</a>
  </div>
</nav>

<div class="wrap">

<aside class="sidebar">
  <h1>Workbench</h1>
  <p class="hint">Interactive prompt builder. Pick a model, write a prompt, run.</p>
  <label>API Key (or paste DID below)</label>
  <input id="apikey" type="password" placeholder="oh_live_... or opk_..." />
  <label>Or DID (for header auth)</label>
  <input id="did" placeholder="did:op:..." />

  <label>Model</label>
  <select id="model">
    <option value="claude-haiku">claude-haiku ($0.025/1M)</option>
    <option value="claude-sonnet">claude-sonnet ($0.30/1M)</option>
    <option value="gpt-4o-mini">gpt-4o-mini ($0.015/1M)</option>
    <option value="gpt-4o">gpt-4o ($0.25/1M)</option>
    <option value="gemini-flash">gemini-flash ($0.007/1M)</option>
    <option value="gemini-pro">gemini-pro ($0.125/1M)</option>
    <option value="llama-70b">llama-70b ($0.06/1M)</option>
  </select>

  <label>Temperature</label>
  <input id="temp" type="number" min="0" max="2" step="0.1" value="0.7" />

  <label>Max tokens</label>
  <input id="max" type="number" min="1" max="100000" value="1024" />

  <label>System prompt (optional)</label>
  <textarea id="system" placeholder="You are a helpful assistant."></textarea>
</aside>

<main class="main">
  <label style="display:block;font-size:11px;color:#888;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px;font-weight:600">User prompt</label>
  <textarea id="prompt" placeholder="Type your message...">Hello! Explain what OpenHeab does in one sentence.</textarea>

  <div class="actions">
    <button class="btn" id="run" onclick="run()">Run →</button>
    <button class="btn secondary" onclick="clearOutput()">Clear</button>
    <span class="status" id="status"></span>
  </div>

  <div class="output" id="output" style="display:none"></div>
  <div class="usage" id="usage"></div>
  <div class="curl-out" id="curl" style="display:none"></div>
</main>

<aside class="sidebar right">
  <h1 style="font-size:14px;color:#888;text-transform:uppercase;letter-spacing:1px">Tips</h1>
  <p class="hint" style="font-size:13px;line-height:1.7">
    • <b>API key</b>: <a href="/v1/me/keys" style="color:#818cf8">manage keys</a>, or use just your DID for the demo<br/>
    • <b>Streaming</b>: not yet in workbench; use <code style="background:#14141c;padding:1px 5px;border-radius:3px">stream:true</code> via API<br/>
    • <b>Routing</b>: we pick the cheapest provider supporting your model<br/>
    • <b>Cost</b>: shown after every run<br/>
    • <b>Curl</b>: copy the exact request you'd make via API
  </p>
  <p style="margin-top:24px;font-size:13px;color:#888">
    Want examples? <a href="/cookbook" style="color:#818cf8">/cookbook</a><br/>
    Want all models? <a href="/models" style="color:#818cf8">/models</a><br/>
    Want all tools? <a href="/tools" style="color:#818cf8">/tools</a>
  </p>
</aside>

</div>

<script>
async function run() {
  const apikey = document.getElementById('apikey').value.trim();
  const did = document.getElementById('did').value.trim();
  if (!apikey && !did) { setStatus('Set an API key or DID first'); return; }
  const model = document.getElementById('model').value;
  const temp = parseFloat(document.getElementById('temp').value);
  const maxTokens = parseInt(document.getElementById('max').value);
  const system = document.getElementById('system').value.trim();
  const prompt = document.getElementById('prompt').value.trim();
  if (!prompt) { setStatus('Type a prompt first'); return; }

  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: prompt });
  const body = { model, messages, temperature: temp, max_tokens: maxTokens };

  const headers = { 'content-type': 'application/json' };
  if (apikey) headers.authorization = 'Bearer ' + apikey;
  if (did) headers['x-agent-did'] = did;

  document.getElementById('run').disabled = true;
  setStatus('Calling /v1/chat/completions...');
  const t0 = Date.now();
  try {
    const r = await fetch('/v1/chat/completions', { method: 'POST', headers, body: JSON.stringify(body) });
    const j = await r.json();
    const elapsed = Date.now() - t0;
    const output = document.getElementById('output');
    output.style.display = '';
    if (j.error) {
      output.textContent = 'Error: ' + (j.error.message || JSON.stringify(j.error));
      setStatus('failed in ' + elapsed + 'ms');
    } else {
      const content = j.choices?.[0]?.message?.content || '(no content)';
      output.textContent = content;
      const u = j.usage || {};
      document.getElementById('usage').textContent =
        'Model: ' + j.model + ' · Tokens: ' + (u.prompt_tokens||0) + ' in / ' + (u.completion_tokens||0) + ' out · ' + elapsed + 'ms' + (j._openheab_stub ? ' · STUB MODE' : '');
      setStatus('✓ done');
    }
    // Show curl equivalent
    const curl = document.getElementById('curl');
    curl.style.display = '';
    curl.textContent = 'curl -X POST https://api.openheab.com/v1/chat/completions \\\\\\n  -H "' +
      (apikey ? 'authorization: Bearer ' + apikey.slice(0, 12) + '...' : 'x-agent-did: ' + did) +
      '" \\\\\\n  -H "content-type: application/json" \\\\\\n  -d \\'' + JSON.stringify(body).replace(/'/g, "\\\\\\'") + '\\'';
  } catch (e) {
    setStatus('error: ' + e.message);
  } finally {
    document.getElementById('run').disabled = false;
  }
}
function setStatus(s) { document.getElementById('status').textContent = s; }
function clearOutput() { document.getElementById('output').style.display='none'; document.getElementById('curl').style.display='none'; document.getElementById('usage').textContent=''; setStatus(''); }
// Cmd/Ctrl + Enter to run
document.getElementById('prompt').addEventListener('keydown', e => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); run(); }
});
</script>
</body></html>`;
}

function renderCookbookPage() {
  const langPills = ['curl', 'python', 'typescript', 'json'];
  return `<!doctype html><html><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>Cookbook — OpenHeab</title>
<meta name="description" content="Real recipes for common agent flows: payments, RAG, webhooks, KYC, MCP tools, streaming.">
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Inter', sans-serif; background: #0a0a0f; color: #e7e7ee; line-height: 1.6; }
.wrap { max-width: 980px; margin: 0 auto; padding: 48px 24px 80px; }
.nav { display: flex; justify-content: space-between; align-items: center; margin-bottom: 40px; }
.nav .logo { font-weight: 700; font-size: 18px; color: #fff; text-decoration: none; }
.nav .links a { color: #888; margin-left: 20px; font-size: 14px; text-decoration: none; }
.nav .links a:hover { color: #fff; }
h1 { font-size: 40px; font-weight: 700; letter-spacing: -1px; margin-bottom: 10px; }
.subtitle { color: #888; font-size: 16px; margin-bottom: 36px; max-width: 720px; }
.recipe { background: #14141c; border: 1px solid #1f1f2a; border-radius: 12px; padding: 24px 28px; margin-bottom: 14px; }
.recipe h2 { font-size: 20px; margin-bottom: 6px; }
.recipe .blurb { color: #888; font-size: 14px; margin-bottom: 14px; }
.lang-tabs { display: flex; gap: 4px; background: #0f0f17; padding: 4px; border-radius: 6px; width: fit-content; margin-bottom: 8px; }
.lang-tab { padding: 5px 12px; border: 0; background: transparent; color: #888; font-size: 12px; font-weight: 500; border-radius: 4px; cursor: pointer; }
.lang-tab.active { background: #4f46e5; color: #fff; }
pre { background: #0a0a12; padding: 18px 20px; border-radius: 8px; overflow-x: auto; font-family: 'SF Mono', monospace; font-size: 12px; line-height: 1.6; color: #c5c5d5; position: relative; white-space: pre; margin: 0; }
.copy { position: absolute; top: 10px; right: 10px; background: #1a1a25; color: #aaa; border: 1px solid #25253a; padding: 4px 10px; border-radius: 5px; font-size: 11px; cursor: pointer; }
.copy:hover { background: #25253a; color: #fff; }
.footer { color: #555; font-size: 12px; margin-top: 48px; text-align: center; }
.footer a { color: #888; }
</style></head><body><div class="wrap">

<nav class="nav">
  <a class="logo" href="/">OpenHeab</a>
  <div class="links">
    <a href="/workbench">Workbench</a>
    <a href="/cookbook" style="color:#fff">Cookbook</a>
    <a href="/sdk">SDK</a>
    <a href="/docs">Docs</a>
    <a href="/explorer">Explorer</a>
  </div>
</nav>

<h1>Cookbook</h1>
<p class="subtitle">${RECIPES.length} real recipes for common agent flows. Each runs against the live substrate as-is — copy, paste, run.</p>

${RECIPES.map((r, idx) => {
  const langs = Object.keys(r.snippets);
  return `<div class="recipe" id="${escapeHtml(r.slug)}">
    <h2>${escapeHtml(r.title)}</h2>
    <p class="blurb">${escapeHtml(r.blurb)}</p>
    <div class="lang-tabs" data-recipe="${idx}">
${langs.map((l, i) => `      <button class="lang-tab ${i === 0 ? 'active' : ''}" onclick="pick(${idx}, '${l}')">${escapeHtml(l)}</button>`).join('')}
    </div>
    <pre id="snippet-${idx}"><button class="copy" onclick="copy(${idx})">copy</button>${escapeHtml(r.snippets[langs[0]])}</pre>
  </div>`;
}).join('')}

<div class="footer">
  Got a recipe to add? <a href="https://github.com/jmtrades/openheab-agent-infra/pulls">Send a PR</a> against src/primitives/anthropic_compat_workbench.js
</div>

</div>
<script>
const RECIPES = ${JSON.stringify(RECIPES.map(r => ({ snippets: r.snippets })))};
function pick(idx, lang) {
  document.querySelectorAll('.lang-tabs[data-recipe="' + idx + '"] .lang-tab').forEach(b => b.classList.remove('active'));
  event.target.classList.add('active');
  const pre = document.getElementById('snippet-' + idx);
  pre.innerHTML = '<button class="copy" onclick="copy(' + idx + ')">copy</button>' + escapeHtml(RECIPES[idx].snippets[lang]);
}
function copy(idx) {
  const text = RECIPES[idx].snippets[document.querySelector('.lang-tabs[data-recipe="' + idx + '"] .lang-tab.active').textContent];
  navigator.clipboard.writeText(text).then(() => {
    const btn = event.target; btn.textContent = 'copied!';
    setTimeout(() => btn.textContent = 'copy', 1500);
  });
}
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }
</script>
</body></html>`;
}

function registerAnthropicCompatWorkbenchRoutes(app, pool, verifyAgentAuth, auditChain) {
  const express = require('express');

  // POST /v1/messages — Anthropic-compatible
  app.post('/v1/messages', express.json({ limit: '4mb' }), async (req, res) => {
    const ctx = await resolveAgent(pool, req);
    if (!ctx) return res.status(401).json({ type: 'error', error: { type: 'authentication_error', message: 'Unauthorized.' } });
    const body = req.body || {};
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      return res.status(400).json({ type: 'error', error: { type: 'invalid_request_error', message: '`messages` is required.' } });
    }
    const start = Date.now();
    const result = await callAnthropic(body);
    try {
      const u = result?.usage || {};
      const callId = 'inf_' + crypto.randomBytes(8).toString('hex');
      await pool.query(
        `INSERT INTO inference_calls (call_id, agent_did, provider, model, prompt_tokens, completion_tokens, cost_cents, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())`,
        [callId, ctx.did, result?._openheab_stub ? 'stub' : 'anthropic-compat',
         body.model || 'unknown', u.input_tokens || 0, u.output_tokens || 0,
         Math.max(1, Math.floor((((u.input_tokens || 0) + (u.output_tokens || 0)) / 1000) * 1))]
      ).catch(() => {});
      if (auditChain) auditChain.append({
        event_type: 'inference.completed', call_id: callId, agent_did: ctx.did,
        provider: 'anthropic-compat', model: body.model,
        input_tokens: u.input_tokens, output_tokens: u.output_tokens,
        latency_ms: Date.now() - start
      }).catch(() => {});
    } catch {}
    if (result?.type === 'error' || result?.error) return res.status(502).json(result);
    res.json(result);
  });

  // GET /workbench — interactive prompt builder
  app.get('/workbench', (req, res) => {
    res.set('content-type', 'text/html; charset=utf-8');
    res.set('cache-control', 'public, max-age=300');
    res.send(renderWorkbenchPage());
  });

  // GET /cookbook — recipes
  app.get('/cookbook', (req, res) => {
    res.set('content-type', 'text/html; charset=utf-8');
    res.set('cache-control', 'public, max-age=3600');
    res.send(renderCookbookPage());
  });

  app.get('/cookbook.json', (req, res) => res.json({ recipes: RECIPES }));
}

module.exports = { migrate, registerAnthropicCompatWorkbenchRoutes, RECIPES };
