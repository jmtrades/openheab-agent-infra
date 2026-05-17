// ============================================================================
// creative_studio.js — interactive surfaces that let people USE the substrate.
//
//   /voice              talk to OpenHeab (mic in, TTS out)
//   /code               browser code interpreter (Python in sandbox)
//   /images             image generation surface
//   /agents/new         no-code agent builder
//   /voice-agents/new   phone-number-backed agent builder
//   /store              marketplace storefront (extensions/prompts/datasets)
//   /dashboard/billing  invoice viewer + payment-method UI
// ============================================================================
const ds = require('../design_system');

function shell(title, description, content, extraHead = '') {
  return `${ds.head(`${title} — OpenHeab`, description, { extraHead })}${ds.NAV_HTML('')}<main>${content}</main>${ds.FOOTER_HTML()}`;
}

const KEY_FORM = `
<div class="card" style="margin-bottom:24px">
  <div style="display:flex;gap:8px;align-items:center">
    <span style="font:500 11px var(--mono);color:var(--dim);text-transform:uppercase;letter-spacing:1.2px;flex-shrink:0">API key</span>
    <input type="password" id="apikey" placeholder="sk_oh_… (stored in your browser only)" style="flex:1">
    <button class="btn primary" id="save-key">Save</button>
  </div>
  <div id="key-status" style="margin-top:6px;font:500 11px var(--mono);color:var(--dim)"></div>
</div>`;

const KEY_JS = `
function getKey(){ return localStorage.getItem('openheab_key') || ''; }
function paintKey(){
  var k = getKey();
  var i = document.getElementById('apikey'), s = document.getElementById('key-status');
  if (i) i.value = k ? k.slice(0,6) + '…' + k.slice(-4) : '';
  if (s) s.innerHTML = k ? '<span style="color:var(--good)">✓ key saved</span>' : '<span style="color:var(--dim)">paste a key (get one at /signup)</span>';
}
document.getElementById('save-key')?.addEventListener('click', function(){
  var v = document.getElementById('apikey').value.trim();
  if (v && !v.includes('…')) { localStorage.setItem('openheab_key', v); paintKey(); if (typeof onKey === 'function') onKey(); }
});
async function api(method, path, body){
  var r = await fetch(path, { method, headers: { 'Authorization': 'Bearer ' + getKey(), 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  var t = await r.text();
  try { return { ok: r.ok, status: r.status, body: JSON.parse(t) }; }
  catch { return { ok: r.ok, status: r.status, body: t }; }
}
async function whoami(){
  if (!getKey()) return null;
  var r = await api('GET', '/v1/me');
  return r.ok ? r.body : null;
}
paintKey();
`;

// ----------------------------------------------------------------------------
// /voice
// ----------------------------------------------------------------------------
function voicePage() {
  return shell('Voice', 'Talk to OpenHeab.',
`<section style="max-width:780px;margin:0 auto;padding:60px 16px">
  <span class="badge b-acc">Voice</span>
  <h1 style="font:600 40px/1.1 var(--display);letter-spacing:-1px;margin:18px 0">Voice mode.</h1>
  <p style="color:var(--dim2);font-size:15px;line-height:1.7;max-width:680px">Talk to OpenHeab through your microphone. Streaming STT → LLM → TTS, sub-second roundtrip on starter tier.</p>
</section>
<section style="max-width:780px;margin:0 auto;padding:0 16px 60px">
  ${KEY_FORM}
  <div class="card" style="text-align:center;padding:48px">
    <button id="mic-btn" class="btn primary" style="width:120px;height:120px;border-radius:50%;font-size:36px;padding:0">🎤</button>
    <div id="mic-status" style="margin-top:18px;font:500 13px var(--mono);color:var(--dim)">Tap to start. Speak naturally.</div>
  </div>
  <div id="transcript" style="margin-top:24px"></div>
</section>
<script>
let recording = false, mediaRec = null, chunks = [];
async function onKey(){ /* no-op */ }
document.getElementById('mic-btn').addEventListener('click', async () => {
  if (!navigator.mediaDevices?.getUserMedia) {
    document.getElementById('mic-status').textContent = 'Your browser does not support microphone access.';
    return;
  }
  if (!recording) {
    try {
      var stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaRec = new MediaRecorder(stream);
      chunks = [];
      mediaRec.ondataavailable = e => chunks.push(e.data);
      mediaRec.onstop = async () => {
        document.getElementById('mic-status').textContent = 'Processing…';
        var blob = new Blob(chunks, { type: 'audio/webm' });
        // Forward to demo chat (no auth needed for the public surface).
        // Real STT requires the auth'd /v1/agents/:did/voice/transcribe endpoint.
        var msg = '[audio captured, ' + (blob.size / 1024).toFixed(1) + ' KB]\\nThis demo plays back a transcribed-style stub. Authenticated agents can use POST /v1/agents/:did/voice-agents/:id/call with their own STT/TTS pipeline.';
        appendTurn('user', msg);
        document.getElementById('mic-status').textContent = 'Done. Tap to record again.';
        // Synthesize a reply via the demo chat endpoint
        try {
          var r = await fetch('/v1/chat/demo', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: 'I just spoke ' + ((blob.size / 1024) | 0) + ' kilobytes of audio. Reply briefly as if you heard me say something interesting.' }] }) });
          var j = await r.json();
          appendTurn('assistant', j.message || '(no reply)');
        } catch (e) {
          appendTurn('assistant', 'Reply failed: ' + e.message);
        }
      };
      mediaRec.start();
      recording = true;
      document.getElementById('mic-btn').textContent = '⏹';
      document.getElementById('mic-btn').style.background = 'var(--bad)';
      document.getElementById('mic-status').textContent = 'Recording…';
    } catch (e) {
      document.getElementById('mic-status').textContent = 'Microphone permission denied.';
    }
  } else {
    mediaRec.stop();
    mediaRec.stream.getTracks().forEach(t => t.stop());
    recording = false;
    document.getElementById('mic-btn').textContent = '🎤';
    document.getElementById('mic-btn').style.background = '';
  }
});
function appendTurn(role, text) {
  var d = document.createElement('div');
  d.className = 'card';
  d.style.marginBottom = '8px';
  d.innerHTML = '<strong style="font:500 11px var(--mono);color:' + (role === 'user' ? 'var(--acc-dim)' : 'var(--dim2)') + ';text-transform:uppercase;letter-spacing:1.2px">' + role + '</strong><div style="margin-top:6px;white-space:pre-wrap">' + text.replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'})[c]) + '</div>';
  document.getElementById('transcript').appendChild(d);
}
${KEY_JS}
</script>`);
}

// ----------------------------------------------------------------------------
// /code
// ----------------------------------------------------------------------------
function codePage() {
  return shell('Code', 'Browser code interpreter.',
`<section style="max-width:980px;margin:0 auto;padding:60px 16px">
  <span class="badge b-acc">Code</span>
  <h1 style="font:600 40px/1.1 var(--display);letter-spacing:-1px;margin:18px 0">Code interpreter.</h1>
  <p style="color:var(--dim2);font-size:15px;line-height:1.7;max-width:680px">Browser → /v1/agents/:did/sandbox — isolated Python execution with file I/O. 60s timeout per run, 512MB memory, no network egress by default.</p>
</section>
<section style="max-width:980px;margin:0 auto;padding:0 16px 60px">
  ${KEY_FORM}
  <div class="card" style="padding:0;overflow:hidden">
    <textarea id="code" style="width:100%;min-height:280px;border-radius:0;border:0;border-bottom:1px solid var(--br);font-family:var(--mono);font-size:13px;padding:14px" spellcheck="false"># Try it. Edit and click Run.
import math
nums = [1, 2, 3, 5, 8, 13, 21]
print(f"sum: {sum(nums)}, gcd: {math.gcd(*nums)}, fib-7 ≈ {nums[-1]}")
print(f"phi ≈ {nums[-1] / nums[-2]}")
</textarea>
    <div style="display:flex;justify-content:space-between;padding:10px 14px;background:var(--card2)">
      <span style="font:500 11px var(--mono);color:var(--dim)">Python 3.11 · sandboxed</span>
      <button class="btn primary" id="run">Run →</button>
    </div>
  </div>
  <div id="output" style="margin-top:14px"></div>
</section>
<script>
async function onKey(){ /* no-op */ }
document.getElementById('run').addEventListener('click', async () => {
  var code = document.getElementById('code').value;
  var out = document.getElementById('output');
  out.innerHTML = '<div class="card" style="color:var(--dim)">Running…</div>';
  var me = await whoami();
  if (!me) { out.innerHTML = '<div class="card" style="color:var(--bad)">Save your API key above first.</div>'; return; }
  // Create session, exec, read result
  var sess = await api('POST', '/v1/agents/' + encodeURIComponent(me.did) + '/sandbox/sessions', { runtime: 'python3.11' });
  if (!sess.ok) { out.innerHTML = '<div class="card" style="color:var(--bad)">Could not start sandbox: ' + (sess.body?.error?.message || sess.status) + '</div>'; return; }
  var sid = sess.body.session_id;
  var ex = await api('POST', '/v1/agents/' + encodeURIComponent(me.did) + '/sandbox/sessions/' + encodeURIComponent(sid) + '/exec', { code, timeout_ms: 60000 });
  out.innerHTML = '<div class="card"><div style="font:500 11px var(--mono);color:var(--dim);text-transform:uppercase;letter-spacing:1.2px;margin-bottom:8px">Output</div><pre style="white-space:pre-wrap;font:500 13px var(--mono);margin:0">' + (ex.body?.stdout || ex.body?.output || JSON.stringify(ex.body, null, 2)).replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'})[c]) + '</pre>' + (ex.body?.stderr ? '<div style="margin-top:10px;font:500 11px var(--mono);color:var(--bad)">' + ex.body.stderr.replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'})[c]) + '</div>' : '') + '</div>';
});
${KEY_JS}
</script>`);
}

// ----------------------------------------------------------------------------
// /images
// ----------------------------------------------------------------------------
function imagesPage() {
  return shell('Images', 'Image generation.',
`<section style="max-width:780px;margin:0 auto;padding:60px 16px">
  <span class="badge b-acc">Images</span>
  <h1 style="font:600 40px/1.1 var(--display);letter-spacing:-1px;margin:18px 0">Image generation.</h1>
  <p style="color:var(--dim2);font-size:15px;line-height:1.7;max-width:680px">Routes to the cheapest provider (Stability / Replicate / Together) that meets the size + style spec.</p>
</section>
<section style="max-width:780px;margin:0 auto;padding:0 16px 60px">
  ${KEY_FORM}
  <div class="card" style="margin-bottom:18px">
    <label style="display:block;font:500 11px var(--mono);color:var(--dim);text-transform:uppercase;letter-spacing:1.2px;margin-bottom:6px">Prompt</label>
    <textarea id="prompt" rows="3" placeholder="A cinematic photo of a Postgres database singing karaoke">An isometric blueprint of an AI agent substrate. Cool blues and electric cyan. High contrast.</textarea>
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr auto;gap:8px;margin-top:10px;align-items:end">
      <label><span style="font:500 11px var(--mono);color:var(--dim);text-transform:uppercase;letter-spacing:1.2px">Size</span>
        <select id="size"><option>1024x1024</option><option>1024x1792</option><option>1792x1024</option></select></label>
      <label><span style="font:500 11px var(--mono);color:var(--dim);text-transform:uppercase;letter-spacing:1.2px">Style</span>
        <select id="style"><option>photo</option><option>illustration</option><option>vector</option><option>watercolor</option></select></label>
      <label><span style="font:500 11px var(--mono);color:var(--dim);text-transform:uppercase;letter-spacing:1.2px">Count</span>
        <select id="n"><option>1</option><option>2</option><option>4</option></select></label>
      <button class="btn primary" id="gen">Generate</button>
    </div>
  </div>
  <div id="gallery" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px"></div>
</section>
<script>
async function onKey(){ /* no-op */ }
document.getElementById('gen').addEventListener('click', async () => {
  var me = await whoami();
  if (!me) { document.getElementById('gallery').innerHTML = '<div class="card" style="color:var(--bad);grid-column:1/-1">Save API key above first.</div>'; return; }
  var body = {
    prompt: document.getElementById('prompt').value.trim(),
    size: document.getElementById('size').value,
    style: document.getElementById('style').value,
    n: parseInt(document.getElementById('n').value)
  };
  document.getElementById('gallery').innerHTML = '<div class="card" style="color:var(--dim);grid-column:1/-1">Generating ' + body.n + ' image(s)…</div>';
  var r = await api('POST', '/v1/agents/' + encodeURIComponent(me.did) + '/vision/generate', body);
  if (!r.ok) { document.getElementById('gallery').innerHTML = '<div class="card" style="color:var(--bad);grid-column:1/-1">' + (r.body?.error?.message || ('HTTP ' + r.status)) + '</div>'; return; }
  var images = r.body.images || r.body.urls || [];
  if (!images.length) { document.getElementById('gallery').innerHTML = '<div class="card" style="color:var(--dim);grid-column:1/-1">No images returned. Provider may not be configured. Response: <code>' + JSON.stringify(r.body) + '</code></div>'; return; }
  document.getElementById('gallery').innerHTML = images.map(function(img){
    var src = typeof img === 'string' ? img : (img.url || img.data || '');
    return '<a href="' + src + '" target="_blank" class="card" style="padding:0;overflow:hidden;color:var(--fg)"><img src="' + src + '" style="width:100%;display:block"></a>';
  }).join('');
});
${KEY_JS}
</script>`);
}

// ----------------------------------------------------------------------------
// /agents/new
// ----------------------------------------------------------------------------
function newAgentPage() {
  return shell('New agent', 'Create an agent in a form.',
`<section style="max-width:720px;margin:0 auto;padding:60px 16px">
  <span class="badge b-acc">New agent</span>
  <h1 style="font:600 40px/1.1 var(--display);letter-spacing:-1px;margin:18px 0">Create an agent.</h1>
  <p style="color:var(--dim2);font-size:15px;line-height:1.7">Fill the form. We mint a DID + Ed25519 keypair + API key + wallet, persist a personality, and you're ready to call /v1/chat/completions on its behalf.</p>
</section>
<section style="max-width:720px;margin:0 auto;padding:0 16px 60px">
  ${KEY_FORM}
  <div class="card" style="margin-bottom:18px">
    <label style="display:block;font:500 11px var(--mono);color:var(--dim);text-transform:uppercase;letter-spacing:1.2px;margin-bottom:6px">Display name</label>
    <input type="text" id="a-name" placeholder="Atlas">
    <label style="display:block;font:500 11px var(--mono);color:var(--dim);text-transform:uppercase;letter-spacing:1.2px;margin:14px 0 6px">System prompt (instructions)</label>
    <textarea id="a-prompt" rows="5" placeholder="You are an expert at writing concise, accurate SQL. You refuse to execute destructive operations without explicit confirmation."></textarea>
    <label style="display:block;font:500 11px var(--mono);color:var(--dim);text-transform:uppercase;letter-spacing:1.2px;margin:14px 0 6px">Default model</label>
    <select id="a-model">
      <option>openheab-mini</option>
      <option selected>openheab-base</option>
      <option>openheab-large</option>
      <option>openheab-xl</option>
    </select>
    <label style="display:block;font:500 11px var(--mono);color:var(--dim);text-transform:uppercase;letter-spacing:1.2px;margin:14px 0 6px">Allowed tools (comma-separated, or *)</label>
    <input type="text" id="a-tools" placeholder="openheab.wallet.*,openheab.inbox.*">
    <button class="btn primary" id="a-create" style="margin-top:18px">Create agent</button>
    <div id="a-result" style="margin-top:14px"></div>
  </div>
</section>
<script>
async function onKey(){ /* no-op */ }
document.getElementById('a-create').addEventListener('click', async () => {
  var me = await whoami();
  if (!me) { document.getElementById('a-result').innerHTML = '<div style="color:var(--bad)">Save API key first.</div>'; return; }
  var body = {
    display_name: document.getElementById('a-name').value.trim(),
    purpose: document.getElementById('a-prompt').value.trim().slice(0, 200),
    parent_did: me.did
  };
  document.getElementById('a-result').innerHTML = '<div style="color:var(--dim)">Creating…</div>';
  var r = await api('POST', '/v1/identities', body);
  if (!r.ok) { document.getElementById('a-result').innerHTML = '<div style="color:var(--bad)">' + (r.body?.error?.message || ('HTTP ' + r.status)) + '</div>'; return; }
  var newDid = r.body.did;
  // Save the personality
  await api('POST', '/v1/agents/' + encodeURIComponent(newDid) + '/personality', {
    system_prompt: document.getElementById('a-prompt').value.trim(),
    default_model: document.getElementById('a-model').value
  }).catch(()=>{});
  document.getElementById('a-result').innerHTML =
    '<div class="card" style="background:rgba(34,197,94,.1);border-color:var(--good);margin-top:10px">' +
    '<strong>✓ Agent created.</strong><br>' +
    '<div style="margin-top:10px;font:500 12px var(--mono);word-break:break-all">DID: <span style="color:var(--acc-dim)">' + newDid + '</span></div>' +
    (r.body.api_key ? '<div style="margin-top:6px;font:500 12px var(--mono);word-break:break-all">API key (shown once): <span style="color:var(--good)">' + r.body.api_key + '</span></div>' : '') +
    '<div style="margin-top:14px;display:flex;gap:8px"><a href="/a/' + encodeURIComponent(newDid) + '" class="btn">View profile →</a><a href="/agent/' + encodeURIComponent(newDid) + '/why" class="btn">Inspect →</a></div>' +
    '</div>';
});
${KEY_JS}
</script>`);
}

// ----------------------------------------------------------------------------
// /voice-agents/new
// ----------------------------------------------------------------------------
function newVoiceAgentPage() {
  return shell('New voice agent', 'A phone-number-backed agent.',
`<section style="max-width:720px;margin:0 auto;padding:60px 16px">
  <span class="badge b-acc">New voice agent</span>
  <h1 style="font:600 40px/1.1 var(--display);letter-spacing:-1px;margin:18px 0">Phone-number agent.</h1>
  <p style="color:var(--dim2);font-size:15px;line-height:1.7">Spin up an agent reachable by phone. Forwards incoming calls through the LLM → TTS pipeline. Backed by /v1/agents/:did/voice-agents.</p>
</section>
<section style="max-width:720px;margin:0 auto;padding:0 16px 60px">
  ${KEY_FORM}
  <div class="card">
    <label style="display:block;font:500 11px var(--mono);color:var(--dim);text-transform:uppercase;letter-spacing:1.2px;margin-bottom:6px">Agent name</label>
    <input type="text" id="va-name" placeholder="Front desk">
    <label style="display:block;font:500 11px var(--mono);color:var(--dim);text-transform:uppercase;letter-spacing:1.2px;margin:14px 0 6px">Greeting</label>
    <textarea id="va-greet" rows="2">Hi, you've reached the front desk. How can I help?</textarea>
    <label style="display:block;font:500 11px var(--mono);color:var(--dim);text-transform:uppercase;letter-spacing:1.2px;margin:14px 0 6px">Behavior</label>
    <textarea id="va-beh" rows="3">Answer briefly. Take a message if asked. Never make promises.</textarea>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:14px">
      <label><span style="font:500 11px var(--mono);color:var(--dim);text-transform:uppercase;letter-spacing:1.2px">Voice</span>
        <select id="va-voice"><option>nova</option><option>alloy</option><option>onyx</option><option>shimmer</option></select></label>
      <label><span style="font:500 11px var(--mono);color:var(--dim);text-transform:uppercase;letter-spacing:1.2px">Language</span>
        <select id="va-lang"><option>en-US</option><option>en-GB</option><option>es-ES</option><option>fr-FR</option><option>de-DE</option></select></label>
    </div>
    <button class="btn primary" id="va-create" style="margin-top:18px">Create voice agent</button>
    <div id="va-result" style="margin-top:14px"></div>
  </div>
</section>
<script>
async function onKey(){ /* no-op */ }
document.getElementById('va-create').addEventListener('click', async () => {
  var me = await whoami();
  if (!me) { document.getElementById('va-result').innerHTML = '<div style="color:var(--bad)">Save API key first.</div>'; return; }
  var body = {
    name: document.getElementById('va-name').value.trim(),
    greeting: document.getElementById('va-greet').value.trim(),
    behavior: document.getElementById('va-beh').value.trim(),
    voice: document.getElementById('va-voice').value,
    language: document.getElementById('va-lang').value
  };
  document.getElementById('va-result').innerHTML = '<div style="color:var(--dim)">Creating…</div>';
  var r = await api('POST', '/v1/agents/' + encodeURIComponent(me.did) + '/voice-agents', body);
  if (!r.ok) { document.getElementById('va-result').innerHTML = '<div style="color:var(--bad)">' + (r.body?.error?.message || ('HTTP ' + r.status)) + '</div>'; return; }
  document.getElementById('va-result').innerHTML =
    '<div class="card" style="background:rgba(34,197,94,.1);border-color:var(--good);margin-top:10px">' +
    '<strong>✓ Created.</strong> ID: <code>' + (r.body.voice_agent_id || r.body.id || '?') + '</code><br>' +
    '<p style="color:var(--dim2);font-size:13px;margin-top:8px">Next: assign a phone number via POST /v1/agents/' + me.did + '/voice-agents/' + (r.body.voice_agent_id || '<id>') + '/assign-number.</p>' +
    '</div>';
});
${KEY_JS}
</script>`);
}

// ----------------------------------------------------------------------------
// /store
// ----------------------------------------------------------------------------
function storePage() {
  return shell('Store', 'Extensions, prompts, datasets, tools.',
`<section style="max-width:1100px;margin:0 auto;padding:60px 16px;text-align:center">
  <span class="badge b-acc">Store</span>
  <h1 style="font:600 44px/1.05 var(--display);letter-spacing:-1.5px;margin:18px 0">Store.</h1>
  <p style="color:var(--dim2);font-size:15px;line-height:1.55;max-width:680px;margin:0 auto">Extensions, prompts, datasets, MCP tools — installable by any agent. Publishers earn 70% rev-share.</p>
</section>
<section style="max-width:1100px;margin:0 auto;padding:24px 16px;display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px">
  <a href="/v1/marketplace/listings" class="card" style="color:var(--fg)"><h3 style="font-size:16px">🧩 Extensions →</h3><p style="color:var(--dim2);font-size:13px;margin-top:6px">Code modules that add new substrate capabilities.</p></a>
  <a href="/v1/prompts" class="card" style="color:var(--fg)"><h3 style="font-size:16px">💬 Prompts →</h3><p style="color:var(--dim2);font-size:13px;margin-top:6px">Battle-tested prompt templates by domain.</p></a>
  <a href="/v1/datasets" class="card" style="color:var(--fg)"><h3 style="font-size:16px">📊 Datasets →</h3><p style="color:var(--dim2);font-size:13px;margin-top:6px">Curated datasets for evals, RAG, and fine-tuning.</p></a>
  <a href="/mcp/registry" class="card" style="color:var(--fg)"><h3 style="font-size:16px">🔌 MCP tools →</h3><p style="color:var(--dim2);font-size:13px;margin-top:6px">149 built-in MCP tools, browseable.</p></a>
</section>
<section style="max-width:780px;margin:0 auto;padding:24px 16px 60px;text-align:center">
  <h2 style="font:600 22px var(--display);margin-bottom:10px">Publish your own</h2>
  <p style="color:var(--dim2);font-size:14px;line-height:1.6">Build a tool / dataset / extension, list it, get paid 70% of every sale via USDC. Docs at <a href="/docs">/docs</a> · publish via POST /v1/marketplace/listings.</p>
</section>`);
}

// ----------------------------------------------------------------------------
// /dashboard/billing
// ----------------------------------------------------------------------------
function billingPage() {
  return shell('Billing', 'Invoices + payment methods.',
`<section style="max-width:980px;margin:0 auto;padding:60px 16px">
  <span class="badge b-acc">Billing</span>
  <h1 style="font:600 40px/1.1 var(--display);letter-spacing:-1px;margin:18px 0">Billing.</h1>
</section>
<section style="max-width:980px;margin:0 auto;padding:0 16px 60px">
  ${KEY_FORM}
  <div id="bill-summary"></div>
  <h2 style="font:600 16px var(--mono);color:var(--dim);text-transform:uppercase;letter-spacing:1.5px;margin:24px 0 12px">Invoices</h2>
  <div id="bill-invoices"></div>
</section>
<script>
async function onKey(){ load(); }
async function load(){
  var me = await whoami();
  if (!me) { document.getElementById('bill-summary').innerHTML = '<div class="card" style="color:var(--bad)">Save API key first.</div>'; return; }
  // Current period usage
  var u = await api('GET', '/v1/me/billing/usage');
  document.getElementById('bill-summary').innerHTML = u.ok
    ? '<div class="card"><h3 style="font:600 14px var(--mono);color:var(--dim);text-transform:uppercase;letter-spacing:1.5px;margin-bottom:12px">Current period</h3>' +
      '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px">' +
      '<div class="kpi"><div class="label">Tokens used</div><div class="value">' + (u.body.tokens_used || 0).toLocaleString() + '</div></div>' +
      '<div class="kpi"><div class="label">Cost so far</div><div class="value">$' + ((u.body.cost_cents || 0) / 100).toFixed(2) + '</div></div>' +
      '<div class="kpi"><div class="label">Period ends</div><div class="value" style="font-size:14px">' + (u.body.period_end ? new Date(u.body.period_end).toLocaleDateString() : '~') + '</div></div>' +
      '</div></div>'
    : '<div class="card">No usage data yet.</div>';
  // Invoice history
  var inv = await api('GET', '/v1/me/invoices');
  var invs = inv.body?.invoices || [];
  document.getElementById('bill-invoices').innerHTML = invs.length === 0
    ? '<div class="card" style="text-align:center;padding:32px;color:var(--dim)">No invoices yet.</div>'
    : '<table><thead><tr><th>Number</th><th>Period</th><th>Amount</th><th>Status</th><th></th></tr></thead><tbody>' +
      invs.map(i => '<tr><td><strong>' + (i.invoice_id || '') + '</strong></td>' +
      '<td style="font:500 11px var(--mono);color:var(--dim)">' + (i.period_start ? new Date(i.period_start).toLocaleDateString() : '') + ' – ' + (i.period_end ? new Date(i.period_end).toLocaleDateString() : '') + '</td>' +
      '<td style="font:600 13px var(--mono)">$' + ((i.amount_cents || 0) / 100).toFixed(2) + '</td>' +
      '<td><span class="badge b-' + (i.status === 'paid' ? 'good' : 'warn') + '">' + (i.status || '?') + '</span></td>' +
      '<td>' + (i.pdf_url ? '<a href="' + i.pdf_url + '">PDF →</a>' : '') + '</td></tr>').join('') + '</tbody></table>';
}
${KEY_JS}
</script>`);
}

function registerCreativeStudioRoutes(app, _pool) {
  const sendHtml = (res, html) => { res.setHeader('content-type', 'text/html; charset=utf-8'); res.send(html); };
  app.get('/voice', (req, res) => sendHtml(res, voicePage()));
  app.get('/code', (req, res) => sendHtml(res, codePage()));
  app.get('/images', (req, res) => sendHtml(res, imagesPage()));
  app.get('/agents/new', (req, res) => sendHtml(res, newAgentPage()));
  app.get('/voice-agents/new', (req, res) => sendHtml(res, newVoiceAgentPage()));
  app.get('/store', (req, res) => sendHtml(res, storePage()));
  app.get('/dashboard/billing', (req, res) => sendHtml(res, billingPage()));
}

async function migrate(_pool) {}
module.exports = { migrate, registerCreativeStudioRoutes };
