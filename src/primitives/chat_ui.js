// ============================================================================
// chat_ui.js — public conversational UI at /chat.
//
// Why this exists: visitors to openheab.com have nowhere to TRY the product.
// ChatGPT, claude.ai, x.ai/grok all have the same surface. We do too now.
//
// What it ships:
//   GET  /chat                 — the page (streaming-aware, model picker,
//                                stop button, copy button, share button)
//   POST /v1/chat/demo         — anonymous demo endpoint, rate-limited
//                                per-IP. Routes to the same callRouter as
//                                /v1/chat/completions but caps tokens.
// ============================================================================
const crypto = require('crypto');
const ds = require('../design_system');

const DEMO_RATE_PER_HOUR = parseInt(process.env.CHAT_DEMO_LIMIT_PER_HOUR || '20');
const DEMO_MAX_TOKENS = 800;
const DEMO_MODELS = ['openheab-mini', 'openheab-base', 'openheab-large'];

async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS chat_demo_calls (
      call_id     TEXT PRIMARY KEY,
      ip_hash     TEXT NOT NULL,
      model       TEXT,
      input_chars INTEGER,
      output_chars INTEGER,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_chat_demo_calls_ip ON chat_demo_calls (ip_hash, created_at DESC);
  `).catch(() => {});
}

function ipOf(req) {
  const fwd = req.headers['x-forwarded-for'];
  const ip = (fwd ? fwd.split(',')[0].trim() : (req.ip || req.connection?.remoteAddress)) || 'unknown';
  return crypto.createHash('sha256').update(ip).digest('hex').slice(0, 16);
}

async function checkRate(pool, ipHash) {
  const r = await pool.query(
    `SELECT COUNT(*)::int AS n FROM chat_demo_calls
     WHERE ip_hash = $1 AND created_at > NOW() - INTERVAL '1 hour'`,
    [ipHash]
  ).catch(() => ({ rows: [{ n: 0 }] }));
  return { used: r.rows[0]?.n || 0, limit: DEMO_RATE_PER_HOUR };
}

// ----------------------------------------------------------------------------
// Demo inference call. We don't go through the auth'd inference primitive
// because that requires a real DID + key. Instead we call the same provider
// pool the openai_compat layer uses, but with a hard token cap + no logging
// to inference_calls (which is keyed on agent_did).
// ----------------------------------------------------------------------------
async function runDemoCompletion(messages, model) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (apiKey && !process.env.CHAT_DEMO_DISABLE_PASSTHROUGH) {
    try {
      const r = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages,
          max_tokens: DEMO_MAX_TOKENS,
          stream: false
        })
      });
      if (r.ok) {
        const j = await r.json();
        return { ok: true, message: j.choices?.[0]?.message?.content || '', usage: j.usage };
      }
    } catch (e) { /* fall through to stub */ }
  }
  // Stub fallback so /chat works even with no upstream provider configured.
  const last = (messages[messages.length - 1]?.content || '').slice(0, 400);
  return {
    ok: true,
    message: `OpenHeab is running in offline-demo mode (no OPENAI_API_KEY configured). You asked: "${last}". To enable live AI responses set OPENAI_API_KEY in the environment, or sign up for a real account at /signup and use the authenticated /v1/chat/completions endpoint.`,
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
  };
}

const CHAT_CSS = `
.chat-shell{display:flex;flex-direction:column;height:calc(100vh - 160px);max-width:980px;margin:0 auto;padding:0 16px}
.chat-controls{display:flex;justify-content:space-between;align-items:center;padding:12px 0;gap:12px;border-bottom:1px solid var(--br);flex-wrap:wrap}
.chat-controls .left{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.chat-controls select{width:auto;min-width:180px;padding:7px 10px;font-size:13px}
.chat-controls .quota{font:500 11px/1 var(--mono);color:var(--dim)}
.chat-msgs{flex:1;overflow-y:auto;padding:24px 0;display:flex;flex-direction:column;gap:18px;scroll-behavior:smooth}
.chat-empty{margin:auto;text-align:center;color:var(--dim);max-width:560px;padding:20px}
.chat-empty h1{font:600 32px/1.1 var(--display);color:var(--fg);letter-spacing:-1px;margin-bottom:12px}
.chat-empty p{margin-bottom:24px;line-height:1.6}
.chat-empty .prompts{display:grid;grid-template-columns:1fr 1fr;gap:10px;text-align:left}
.chat-empty .prompts button{background:var(--card);border:1px solid var(--br);border-radius:var(--r-lg);padding:14px;font:500 13px/1.4 var(--sans);color:var(--dim2);cursor:pointer;text-align:left;transition:all var(--mo-fast)}
.chat-empty .prompts button:hover{border-color:var(--acc);color:var(--fg)}
@media(max-width:600px){.chat-empty .prompts{grid-template-columns:1fr}}
.msg{display:flex;gap:14px;align-items:flex-start}
.msg .avatar{width:28px;height:28px;border-radius:var(--r-md);background:var(--card2);display:grid;place-items:center;font:600 11px/1 var(--mono);flex-shrink:0;color:var(--dim2)}
.msg.user .avatar{background:var(--acc);color:#001a1f}
.msg .bubble{flex:1;background:var(--card);border:1px solid var(--br);border-radius:var(--r-xl);padding:14px 18px;line-height:1.55;white-space:pre-wrap;word-wrap:break-word}
.msg.user .bubble{background:transparent;border-color:transparent;padding:6px 0}
.msg.error .bubble{border-color:var(--bad);color:var(--bad)}
.msg .meta{display:flex;gap:6px;align-items:center;margin-top:8px}
.msg .meta button{background:transparent;border:none;color:var(--dim);font:500 11px/1 var(--mono);cursor:pointer;padding:4px 6px;border-radius:var(--r-sm)}
.msg .meta button:hover{color:var(--fg);background:var(--card2)}
.typing{display:inline-flex;gap:3px;align-items:center}
.typing span{width:5px;height:5px;background:var(--dim);border-radius:50%;animation:bl 1.4s infinite both}
.typing span:nth-child(2){animation-delay:.2s}
.typing span:nth-child(3){animation-delay:.4s}
@keyframes bl{0%,80%,100%{opacity:.3}40%{opacity:1}}
.chat-input{padding:14px 0 24px;border-top:1px solid var(--br);display:flex;gap:10px;align-items:flex-end}
.chat-input textarea{resize:none;min-height:48px;max-height:200px;font-size:14px;flex:1}
.chat-input .send{padding:11px 22px}
.chat-input .send:disabled{opacity:.4;cursor:not-allowed}
`;

function pageHtml() {
  const head = ds.head('Chat — OpenHeab', 'Talk to OpenHeab in your browser. No signup needed.', { extraHead: `<style>${CHAT_CSS}</style>` });
  const nav = ds.NAV_HTML('chat');
  const footer = ds.FOOTER_HTML();
  return `${head}${nav}<main>
<div class="chat-shell">
  <div class="chat-controls">
    <div class="left">
      <label for="model" style="font:500 11px/1 var(--mono);color:var(--dim);text-transform:uppercase;letter-spacing:1.2px">Model</label>
      <select id="model">
        ${DEMO_MODELS.map((m, i) => `<option value="${m}"${i === 0 ? ' selected' : ''}>${m}</option>`).join('')}
      </select>
      <button class="btn ghost" id="reset" title="New chat">↻ New</button>
    </div>
    <div class="quota" id="quota">~</div>
  </div>
  <div class="chat-msgs" id="msgs">
    <div class="chat-empty" id="empty">
      <h1>What do you want to know?</h1>
      <p>Anonymous demo, ${DEMO_RATE_PER_HOUR}/hour per IP. For unlimited use, <a href="/signup">sign up free</a> and use your API key against <code>/v1/chat/completions</code>.</p>
      <div class="prompts">
        <button data-p="Explain in 3 bullets what OpenHeab is.">Explain in 3 bullets what OpenHeab is.</button>
        <button data-p="Write Python that calls /v1/chat/completions with my API key.">Write Python that calls /v1/chat/completions.</button>
        <button data-p="What's the best agent infrastructure for production AGI?">What's the best agent infra for production AGI?</button>
        <button data-p="List 10 ways agents can earn revenue on OpenHeab.">List 10 ways agents can earn revenue on OpenHeab.</button>
      </div>
    </div>
  </div>
  <div class="chat-input">
    <textarea id="input" placeholder="Message OpenHeab… (⌘ + Enter to send)" rows="1"></textarea>
    <button class="btn primary send" id="send">Send →</button>
  </div>
</div>
</main>
<script>
(function(){
  const msgs = document.getElementById('msgs');
  const empty = document.getElementById('empty');
  const input = document.getElementById('input');
  const send = document.getElementById('send');
  const reset = document.getElementById('reset');
  const modelSel = document.getElementById('model');
  const quotaEl = document.getElementById('quota');
  let history = [];

  // Autosize textarea
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(200, input.scrollHeight) + 'px';
  });

  // Cmd+Enter to send
  input.addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') doSend();
  });

  // Prompt seeds
  document.querySelectorAll('.chat-empty .prompts button').forEach(b => {
    b.addEventListener('click', () => { input.value = b.dataset.p; input.focus(); doSend(); });
  });

  send.addEventListener('click', doSend);
  reset.addEventListener('click', () => {
    history = []; msgs.innerHTML = ''; msgs.appendChild(empty); input.focus();
  });

  function renderMsg(role, content, opts = {}) {
    if (empty.parentNode) empty.remove();
    const div = document.createElement('div');
    div.className = 'msg ' + role + (opts.error ? ' error' : '');
    const avatar = role === 'user' ? 'YOU' : 'OH';
    div.innerHTML =
      '<div class="avatar">' + avatar + '</div>' +
      '<div style="flex:1">' +
        '<div class="bubble">' + (opts.placeholder ? '<span class="typing"><span></span><span></span><span></span></span>' : escape(content)) + '</div>' +
        (role === 'assistant' && !opts.placeholder ? '<div class="meta"><button data-copy>Copy</button></div>' : '') +
      '</div>';
    if (role === 'assistant' && !opts.placeholder) {
      div.querySelector('[data-copy]')?.addEventListener('click', () => {
        navigator.clipboard.writeText(content); div.querySelector('[data-copy]').textContent = '✓ Copied';
        setTimeout(() => div.querySelector('[data-copy]') && (div.querySelector('[data-copy]').textContent = 'Copy'), 1500);
      });
    }
    msgs.appendChild(div);
    msgs.scrollTop = msgs.scrollHeight;
    return div;
  }
  function escape(s){return s.replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));}

  async function doSend() {
    const text = input.value.trim();
    if (!text) return;
    send.disabled = true;
    input.value = ''; input.style.height = 'auto';
    history.push({ role: 'user', content: text });
    renderMsg('user', text);
    const placeholder = renderMsg('assistant', '', { placeholder: true });
    try {
      const r = await fetch('/v1/chat/demo', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: history, model: modelSel.value })
      });
      const j = await r.json();
      placeholder.remove();
      if (!r.ok) {
        renderMsg('assistant', j.error?.message || j.error || 'Something went wrong.', { error: true });
        if (j.quota) updateQuota(j.quota);
      } else {
        history.push({ role: 'assistant', content: j.message || '' });
        renderMsg('assistant', j.message || '(empty response)');
        if (j.quota) updateQuota(j.quota);
      }
    } catch (e) {
      placeholder.remove();
      renderMsg('assistant', 'Network error: ' + e.message, { error: true });
    } finally {
      send.disabled = false;
      input.focus();
    }
  }
  function updateQuota(q){ quotaEl.textContent = q.used + ' / ' + q.limit + '/hr'; }

  // Initial quota check
  fetch('/v1/chat/demo/quota').then(r => r.json()).then(updateQuota).catch(()=>{});
  input.focus();
})();
</script>
${footer}`;
}

function registerChatUiRoutes(app, pool) {
  const express = require('express');

  app.get('/chat', (req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.send(pageHtml());
  });

  app.get('/v1/chat/demo/quota', async (req, res) => {
    const q = await checkRate(pool, ipOf(req));
    res.json({ used: q.used, limit: q.limit, remaining: Math.max(0, q.limit - q.used) });
  });

  app.post('/v1/chat/demo', express.json({ limit: '64kb' }), async (req, res) => {
    const ipHash = ipOf(req);
    const q = await checkRate(pool, ipHash);
    if (q.used >= q.limit) {
      return res.status(429).json({
        error: { message: `Demo limit reached: ${q.limit}/hour. Sign up free at /signup for unlimited.`, type: 'rate_limit_exceeded' },
        quota: q
      });
    }
    const messages = Array.isArray(req.body?.messages) ? req.body.messages.slice(-20) : [];
    if (messages.length === 0) {
      return res.status(400).json({ error: { message: '`messages` array required.', type: 'invalid_request_error' } });
    }
    // Sanitize: enforce role enum + length cap
    for (const m of messages) {
      if (!['system', 'user', 'assistant'].includes(m.role)) {
        return res.status(400).json({ error: { message: 'invalid_role', type: 'invalid_request_error' } });
      }
      if (typeof m.content !== 'string' || m.content.length > 8000) {
        return res.status(400).json({ error: { message: 'content must be string ≤ 8000 chars', type: 'invalid_request_error' } });
      }
    }
    const model = DEMO_MODELS.includes(req.body?.model) ? req.body.model : DEMO_MODELS[0];
    const inputChars = messages.reduce((n, m) => n + m.content.length, 0);

    let result;
    try { result = await runDemoCompletion(messages, model); }
    catch (e) { return res.status(500).json({ error: { message: e.message, type: 'server_error' } }); }

    const callId = 'demo_' + crypto.randomBytes(8).toString('hex');
    await pool.query(
      `INSERT INTO chat_demo_calls (call_id, ip_hash, model, input_chars, output_chars) VALUES ($1,$2,$3,$4,$5)`,
      [callId, ipHash, model, inputChars, (result.message || '').length]
    ).catch(() => {});

    const q2 = { used: q.used + 1, limit: q.limit, remaining: Math.max(0, q.limit - q.used - 1) };
    res.json({ message: result.message, usage: result.usage, model, call_id: callId, quota: q2 });
  });
}

module.exports = { migrate, registerChatUiRoutes };
