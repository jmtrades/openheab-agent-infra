// ============================================================================
// conversion_polish.js — enterprise-funnel + bottom-of-funnel polish.
//
//   /contact-sales              book a call with sales (form → /v1/marketing/leads)
//   /pricing/enterprise         custom-quote tier landing
//   /demo-video                 demo video placeholder + script
//   /try-instant                instant try (no signup, rate-limited)
//   /quickstarts                hub
//   /quickstarts/python         60-second Python
//   /quickstarts/typescript     60-second TS
//   /quickstarts/go             60-second Go
//   /quickstarts/curl           60-second curl
//   /quickstarts/rust           60-second Rust
//   /v1/marketing/leads/contact-sales  endpoint POSTed by /contact-sales form
// ============================================================================
const ds = require('../design_system');

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
}

function shell(title, description, content) {
  return `${ds.head(`${title} — OpenHeab`, description)}${ds.NAV_HTML('')}<main>${content}</main>${ds.FOOTER_HTML()}`;
}

// ----------------------------------------------------------------------------
// /contact-sales
// ----------------------------------------------------------------------------
function contactSalesPage() {
  return shell('Contact sales', 'Book a call.',
`<section style="max-width:680px;margin:0 auto;padding:60px 16px">
  <span class="badge b-acc">Contact sales</span>
  <h1 style="font:600 40px/1.1 var(--display);letter-spacing:-1px;margin:18px 0">Talk to sales.</h1>
  <p style="color:var(--dim2);font-size:15px;line-height:1.7">For Enterprise tier, custom DPA, BAA, data-residency, dedicated VPC, or commercial substrate licensing. We respond within 1 business day.</p>
</section>
<section style="max-width:680px;margin:0 auto;padding:0 16px 60px">
  <form id="cs-form" class="card">
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px">
      <label><span style="font:500 11px var(--mono);color:var(--dim);text-transform:uppercase;letter-spacing:1.2px">Name</span><input type="text" id="cs-name" required></label>
      <label><span style="font:500 11px var(--mono);color:var(--dim);text-transform:uppercase;letter-spacing:1.2px">Work email</span><input type="email" id="cs-email" required></label>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px">
      <label><span style="font:500 11px var(--mono);color:var(--dim);text-transform:uppercase;letter-spacing:1.2px">Company</span><input type="text" id="cs-company"></label>
      <label><span style="font:500 11px var(--mono);color:var(--dim);text-transform:uppercase;letter-spacing:1.2px">Team size</span>
        <select id="cs-team-size">
          <option>1-10</option><option>11-50</option><option selected>51-200</option><option>201-1k</option><option>1k+</option>
        </select></label>
    </div>
    <div style="margin-bottom:12px">
      <label style="display:block"><span style="font:500 11px var(--mono);color:var(--dim);text-transform:uppercase;letter-spacing:1.2px">What you want to talk about</span>
        <textarea id="cs-note" rows="4" placeholder="What you're trying to build, scale you're operating at, anything that makes you specifically need to talk to a human."></textarea></label>
    </div>
    <button type="submit" class="btn primary" style="width:100%;padding:14px;font-size:14px">Send →</button>
    <div id="cs-result" style="margin-top:14px;font:500 13px var(--mono)"></div>
  </form>
  <p style="color:var(--dim);font-size:13px;text-align:center;margin-top:18px">Or email <a href="mailto:sales@openheab.com">sales@openheab.com</a> directly.</p>
</section>
<script>
document.getElementById('cs-form').addEventListener('submit', async function(e){
  e.preventDefault();
  var body = {
    name: document.getElementById('cs-name').value.trim(),
    email: document.getElementById('cs-email').value.trim(),
    company: document.getElementById('cs-company').value.trim(),
    team_size: document.getElementById('cs-team-size').value,
    note: document.getElementById('cs-note').value.trim()
  };
  var out = document.getElementById('cs-result');
  out.textContent = 'Sending…';
  try {
    var r = await fetch('/v1/marketing/leads/contact-sales', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
    });
    if (r.ok) {
      out.innerHTML = '<span style="color:var(--good)">✓ Got it. We\\'ll reply within 1 business day.</span>';
      e.target.reset();
    } else {
      out.innerHTML = '<span style="color:var(--bad)">Something went wrong — email sales@openheab.com directly.</span>';
    }
  } catch (err) {
    out.innerHTML = '<span style="color:var(--bad)">Network error — email sales@openheab.com directly.</span>';
  }
});
</script>`);
}

// ----------------------------------------------------------------------------
// /pricing/enterprise
// ----------------------------------------------------------------------------
function pricingEnterprisePage() {
  return shell('Enterprise', 'Custom pricing for organizations at scale.',
`<section style="max-width:760px;margin:0 auto;padding:60px 16px">
  <span class="badge b-acc">Enterprise</span>
  <h1 style="font:600 44px/1.05 var(--display);letter-spacing:-1.5px;margin:18px 0">Enterprise.</h1>
  <p style="color:var(--dim2);font-size:17px;line-height:1.7">Custom quotes start at $2,499/mo. Pricing scales with usage, tier of dedication, and compliance load.</p>

  <h2 style="font:600 22px var(--display);margin:32px 0 10px">Included by default</h2>
  <ul style="color:var(--dim2);line-height:1.85;padding-left:20px">
    <li>Unlimited agents + orgs + API keys.</li>
    <li>Dedicated VPC option (single-tenant deployment).</li>
    <li>Data residency pinning (any region we operate in).</li>
    <li>SSO via SAML/OIDC. Custom RBAC. Audit log retention 7 years.</li>
    <li>99.99% uptime SLA, 1-hour pager response 24×7.</li>
    <li>Dedicated Slack/Teams support channel.</li>
    <li>Quarterly security review with our team.</li>
    <li>BAA for HIPAA. DPA. Custom MSA.</li>
    <li>Annual compliance attestation (SOC 2 Type II, ISO 27001).</li>
    <li>White-label option (your domain, your branding).</li>
  </ul>

  <h2 style="font:600 22px var(--display);margin:32px 0 10px">Add-ons</h2>
  <ul style="color:var(--dim2);line-height:1.85;padding-left:20px">
    <li><strong style="color:var(--fg)">Dedicated GPU cluster</strong> — for guaranteed inference latency.</li>
    <li><strong style="color:var(--fg)">Custom model fine-tunes</strong> — your data, your weights.</li>
    <li><strong style="color:var(--fg)">On-prem deployment</strong> — air-gapped substrate behind your firewall.</li>
    <li><strong style="color:var(--fg)">Operator engagement</strong> — Junior personally on-call for migration weeks.</li>
  </ul>

  <div style="margin-top:36px"><a href="/contact-sales" class="btn primary" style="padding:14px 28px;font-size:15px">Talk to sales →</a></div>
</section>`);
}

// ----------------------------------------------------------------------------
// /demo-video
// ----------------------------------------------------------------------------
function demoVideoPage() {
  return shell('Demo video', '90-second walkthrough.',
`<section style="max-width:780px;margin:0 auto;padding:60px 16px;text-align:center">
  <span class="badge b-acc">Demo</span>
  <h1 style="font:600 40px/1.1 var(--display);letter-spacing:-1px;margin:18px 0">Demo video.</h1>
  <p style="color:var(--dim2);font-size:15px;line-height:1.6;max-width:540px;margin:0 auto">90-second walkthrough — landing → chat → signup → first inference call → audit chain verify.</p>
</section>
<section style="max-width:780px;margin:0 auto;padding:24px 16px 60px">
  <div class="card" style="aspect-ratio:16/9;background:var(--card2);display:flex;align-items:center;justify-content:center;color:var(--dim);border-style:dashed;font:500 14px var(--mono)">
    Video coming soon — recorded after the v1.0 launch
  </div>

  <h2 style="font:600 20px var(--display);margin:32px 0 10px">The script</h2>
  <ol style="color:var(--dim2);line-height:1.8;padding-left:20px">
    <li><strong style="color:var(--fg)">0:00–0:08</strong> Land on openheab.com. "The substrate for the agent economy. 280 primitives. Open source."</li>
    <li><strong style="color:var(--fg)">0:08–0:20</strong> Click /chat. Type a question. Watch streaming reply.</li>
    <li><strong style="color:var(--fg)">0:20–0:35</strong> npx openheab signup in terminal. Get back DID + API key + wallet address. Show /a/&lt;did&gt; profile.</li>
    <li><strong style="color:var(--fg)">0:35–0:55</strong> curl /v1/chat/completions with the key. Reply streams in. Show /agent/&lt;did&gt;/why — interpretability dashboard already has the decision logged.</li>
    <li><strong style="color:var(--fg)">0:55–1:15</strong> /v1/audit/verify returns valid. Walk through one event on the chain.</li>
    <li><strong style="color:var(--fg)">1:15–1:30</strong> Tour: /pulse heartbeat, /trust, /benchmarks. Close with "github.com/jmtrades/openheab-agent-infra".</li>
  </ol>

  <p style="color:var(--dim);font-size:13px;margin-top:24px;font-style:italic">Until the video is recorded, the live demo at <a href="/chat">/chat</a> and the substrate walkthrough at <a href="/learn/build-your-first-agent">/learn/build-your-first-agent</a> show the same flow.</p>
</section>`);
}

// ----------------------------------------------------------------------------
// /try-instant
// ----------------------------------------------------------------------------
function tryInstantPage() {
  return shell('Try instantly', 'No signup. Try the API right now.',
`<section style="max-width:780px;margin:0 auto;padding:60px 16px;text-align:center">
  <span class="badge b-acc">Try instantly</span>
  <h1 style="font:600 40px/1.1 var(--display);letter-spacing:-1px;margin:18px 0">Try instantly. No signup.</h1>
  <p style="color:var(--dim2);font-size:15px;line-height:1.6;max-width:540px;margin:0 auto">Rate-limited anonymous demo of the chat completion endpoint. Same JSON shape as /v1/chat/completions but no auth required.</p>
</section>
<section style="max-width:780px;margin:0 auto;padding:24px 16px 60px">
  <div class="card" style="padding:0;overflow:hidden">
    <pre style="margin:0;padding:14px;font:500 12px var(--mono);background:var(--card2);overflow-x:auto">curl https://openheab.com/v1/chat/demo \\
  -H "content-type: application/json" \\
  -d '{
    "model": "openheab-base",
    "messages": [{"role":"user","content":"What is OpenHeab in one sentence?"}]
  }'</pre>
  </div>
  <p style="color:var(--dim2);line-height:1.7;margin-top:24px">Rate limit: ${process.env.CHAT_DEMO_LIMIT_PER_HOUR || 20}/hour per IP. Want more? <a href="/signup">Sign up free →</a> for 10k tokens/month with no per-hour cap.</p>
  <p style="color:var(--dim);line-height:1.7;margin-top:14px;font-size:13px">Try it in browser at <a href="/chat">/chat</a>.</p>
</section>`);
}

// ----------------------------------------------------------------------------
// /quickstarts
// ----------------------------------------------------------------------------
const QS_LANGS = [
  { slug: 'curl', name: 'curl', tagline: 'Zero install. Most platforms have it.' },
  { slug: 'python', name: 'Python', tagline: 'OpenAI SDK works as-is. Just swap the base URL.' },
  { slug: 'typescript', name: 'TypeScript / Node', tagline: 'Use the OpenAI or Anthropic npm package.' },
  { slug: 'go', name: 'Go', tagline: 'Plain net/http. We ship a thin client too.' },
  { slug: 'rust', name: 'Rust', tagline: 'reqwest or the openheab-rs crate.' },
];

function quickstartsHubPage() {
  return shell('Quickstarts', 'Get your first call in 60 seconds.',
`<section style="padding:60px 0 24px;max-width:980px;margin:0 auto;padding-left:16px;padding-right:16px;text-align:center">
  <span class="badge b-acc">Quickstarts</span>
  <h1 style="font:600 40px/1.1 var(--display);letter-spacing:-1px;margin:14px 0 8px">60-second quickstarts.</h1>
  <p style="color:var(--dim2);font-size:15px;line-height:1.6;max-width:680px;margin:0 auto">Pick your language. Each is a copy-paste working example you can run today.</p>
</section>
<section style="max-width:980px;margin:0 auto;padding:32px 16px 60px;display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px">
  ${QS_LANGS.map(l => `<a href="/quickstarts/${l.slug}" class="card" style="color:var(--fg);text-decoration:none">
    <strong style="font-size:18px;display:block;margin-bottom:6px">${escapeHtml(l.name)} →</strong>
    <p style="color:var(--dim2);font-size:13px;line-height:1.55">${escapeHtml(l.tagline)}</p>
  </a>`).join('')}
</section>`);
}

function quickstartCurlPage() {
  return shell('Quickstart — curl', '60-second curl example.',
`<section style="max-width:780px;margin:0 auto;padding:60px 16px">
  <a href="/quickstarts" style="font:500 12px var(--mono);color:var(--dim);text-decoration:none">← All quickstarts</a>
  <h1 style="font:600 32px/1.1 var(--display);margin:14px 0 6px">curl in 60 seconds.</h1>
</section>
<section style="max-width:780px;margin:0 auto;padding:0 16px 60px">
  <h2 style="font:600 18px var(--display);margin:24px 0 8px">1. Get a key</h2>
  <pre style="background:var(--card);border:1px solid var(--br);border-radius:var(--r-md);padding:14px;overflow-x:auto;font-size:13px"><code>open https://openheab.com/signup
# Save the API key it gives you to OPENHEAB_KEY in your shell.
export OPENHEAB_KEY=sk_oh_...</code></pre>
  <h2 style="font:600 18px var(--display);margin:24px 0 8px">2. Call /v1/chat/completions</h2>
  <pre style="background:var(--card);border:1px solid var(--br);border-radius:var(--r-md);padding:14px;overflow-x:auto;font-size:13px"><code>curl https://openheab.com/v1/chat/completions \\
  -H "Authorization: Bearer $OPENHEAB_KEY" \\
  -H "content-type: application/json" \\
  -d '{ "model": "openheab-base", "messages": [{"role":"user","content":"Hi"}] }'</code></pre>
  <h2 style="font:600 18px var(--display);margin:24px 0 8px">3. Verify it's signed</h2>
  <pre style="background:var(--card);border:1px solid var(--br);border-radius:var(--r-md);padding:14px;overflow-x:auto;font-size:13px"><code>curl https://openheab.com/v1/audit/verify  # → { valid: true, head_seq: N, ... }</code></pre>
  <h2 style="font:600 18px var(--display);margin:24px 0 8px">Next</h2>
  <ul style="color:var(--dim2);line-height:1.8;padding-left:20px">
    <li><a href="/v1/me">GET /v1/me</a> — your agent context.</li>
    <li><a href="/sdk">/sdk</a> — the same example in Python, TS, Go, Rust.</li>
    <li><a href="/mcp/registry">/mcp/registry</a> — 149 MCP tools to call.</li>
  </ul>
</section>`);
}

function quickstartPythonPage() {
  return shell('Quickstart — Python', '60-second Python example.',
`<section style="max-width:780px;margin:0 auto;padding:60px 16px">
  <a href="/quickstarts" style="font:500 12px var(--mono);color:var(--dim);text-decoration:none">← All quickstarts</a>
  <h1 style="font:600 32px/1.1 var(--display);margin:14px 0 6px">Python in 60 seconds.</h1>
</section>
<section style="max-width:780px;margin:0 auto;padding:0 16px 60px">
  <h2 style="font:600 18px var(--display);margin:24px 0 8px">1. Install</h2>
  <pre style="background:var(--card);border:1px solid var(--br);border-radius:var(--r-md);padding:14px;overflow-x:auto;font-size:13px"><code>pip install openai  # the OpenAI SDK works against our endpoint</code></pre>
  <h2 style="font:600 18px var(--display);margin:24px 0 8px">2. Use</h2>
  <pre style="background:var(--card);border:1px solid var(--br);border-radius:var(--r-md);padding:14px;overflow-x:auto;font-size:13px"><code>import os
from openai import OpenAI

client = OpenAI(
    api_key=os.environ["OPENHEAB_KEY"],
    base_url="https://openheab.com/v1",
)

resp = client.chat.completions.create(
    model="openheab-base",
    messages=[{"role": "user", "content": "Hello"}],
)
print(resp.choices[0].message.content)</code></pre>
  <h2 style="font:600 18px var(--display);margin:24px 0 8px">Streaming</h2>
  <pre style="background:var(--card);border:1px solid var(--br);border-radius:var(--r-md);padding:14px;overflow-x:auto;font-size:13px"><code>stream = client.chat.completions.create(
    model="openheab-base",
    messages=[{"role": "user", "content": "Tell me a story"}],
    stream=True,
)
for chunk in stream:
    print(chunk.choices[0].delta.content or "", end="", flush=True)</code></pre>
  <h2 style="font:600 18px var(--display);margin:24px 0 8px">Anthropic SDK style</h2>
  <pre style="background:var(--card);border:1px solid var(--br);border-radius:var(--r-md);padding:14px;overflow-x:auto;font-size:13px"><code>import anthropic
client = anthropic.Anthropic(api_key=os.environ["OPENHEAB_KEY"], base_url="https://openheab.com")
msg = client.messages.create(model="openheab-xl", max_tokens=1024, messages=[{"role":"user","content":"Hi"}])
print(msg.content[0].text)</code></pre>
</section>`);
}

function quickstartTSPage() {
  return shell('Quickstart — TypeScript', '60-second TS example.',
`<section style="max-width:780px;margin:0 auto;padding:60px 16px">
  <a href="/quickstarts" style="font:500 12px var(--mono);color:var(--dim);text-decoration:none">← All quickstarts</a>
  <h1 style="font:600 32px/1.1 var(--display);margin:14px 0 6px">TypeScript in 60 seconds.</h1>
</section>
<section style="max-width:780px;margin:0 auto;padding:0 16px 60px">
  <h2 style="font:600 18px var(--display);margin:24px 0 8px">Install</h2>
  <pre style="background:var(--card);border:1px solid var(--br);border-radius:var(--r-md);padding:14px;overflow-x:auto;font-size:13px"><code>npm i openai</code></pre>
  <h2 style="font:600 18px var(--display);margin:24px 0 8px">Use</h2>
  <pre style="background:var(--card);border:1px solid var(--br);border-radius:var(--r-md);padding:14px;overflow-x:auto;font-size:13px"><code>import OpenAI from 'openai';

const client = new OpenAI({
  apiKey: process.env.OPENHEAB_KEY,
  baseURL: 'https://openheab.com/v1',
});

const r = await client.chat.completions.create({
  model: 'openheab-base',
  messages: [{ role: 'user', content: 'Hello' }],
});
console.log(r.choices[0].message.content);</code></pre>
  <h2 style="font:600 18px var(--display);margin:24px 0 8px">Streaming</h2>
  <pre style="background:var(--card);border:1px solid var(--br);border-radius:var(--r-md);padding:14px;overflow-x:auto;font-size:13px"><code>const stream = await client.chat.completions.create({
  model: 'openheab-base',
  messages: [{ role: 'user', content: 'Tell me a story' }],
  stream: true,
});
for await (const chunk of stream) process.stdout.write(chunk.choices[0]?.delta?.content || '');</code></pre>
</section>`);
}

function quickstartGoPage() {
  return shell('Quickstart — Go', '60-second Go example.',
`<section style="max-width:780px;margin:0 auto;padding:60px 16px">
  <a href="/quickstarts" style="font:500 12px var(--mono);color:var(--dim);text-decoration:none">← All quickstarts</a>
  <h1 style="font:600 32px/1.1 var(--display);margin:14px 0 6px">Go in 60 seconds.</h1>
</section>
<section style="max-width:780px;margin:0 auto;padding:0 16px 60px">
  <h2 style="font:600 18px var(--display);margin:24px 0 8px">net/http (zero deps)</h2>
  <pre style="background:var(--card);border:1px solid var(--br);border-radius:var(--r-md);padding:14px;overflow-x:auto;font-size:13px"><code>package main

import (
	"bytes"
	"fmt"
	"io"
	"net/http"
	"os"
)

func main() {
	body := []byte(\`{"model":"openheab-base","messages":[{"role":"user","content":"Hi"}]}\`)
	req, _ := http.NewRequest("POST", "https://openheab.com/v1/chat/completions", bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+os.Getenv("OPENHEAB_KEY"))
	req.Header.Set("Content-Type", "application/json")
	resp, _ := http.DefaultClient.Do(req)
	defer resp.Body.Close()
	out, _ := io.ReadAll(resp.Body)
	fmt.Println(string(out))
}</code></pre>
</section>`);
}

function quickstartRustPage() {
  return shell('Quickstart — Rust', '60-second Rust example.',
`<section style="max-width:780px;margin:0 auto;padding:60px 16px">
  <a href="/quickstarts" style="font:500 12px var(--mono);color:var(--dim);text-decoration:none">← All quickstarts</a>
  <h1 style="font:600 32px/1.1 var(--display);margin:14px 0 6px">Rust in 60 seconds.</h1>
</section>
<section style="max-width:780px;margin:0 auto;padding:0 16px 60px">
  <h2 style="font:600 18px var(--display);margin:24px 0 8px">reqwest</h2>
  <pre style="background:var(--card);border:1px solid var(--br);border-radius:var(--r-md);padding:14px;overflow-x:auto;font-size:13px"><code>// Cargo.toml: reqwest = { version = "0.12", features = ["json"] }, tokio = { version = "1", features = ["full"] }, serde_json = "1"

use serde_json::json;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let key = std::env::var("OPENHEAB_KEY")?;
    let r = reqwest::Client::new()
        .post("https://openheab.com/v1/chat/completions")
        .bearer_auth(&key)
        .json(&json!({"model":"openheab-base","messages":[{"role":"user","content":"Hi"}]}))
        .send().await?;
    println!("{}", r.text().await?);
    Ok(())
}</code></pre>
</section>`);
}

// ----------------------------------------------------------------------------
// POST /v1/marketing/leads/contact-sales
// ----------------------------------------------------------------------------
async function handleContactSales(req, res, pool) {
  const body = req.body || {};
  const email = String(body.email || '').toLowerCase().trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: { message: 'valid email required' } });
  }
  const ipHash = require('crypto').createHash('sha256').update(req.ip || '').digest('hex').slice(0, 16);
  const leadId = 'lead_' + require('crypto').randomBytes(8).toString('hex');
  try {
    await pool.query(
      `INSERT INTO marketing_leads (lead_id, email, source, utm_source, ip_hash, score, status, metadata)
       VALUES ($1, $2, 'contact_sales', 'contact_sales', $3, 80, 'new', $4)`,
      [leadId, email, ipHash, JSON.stringify({
        name: body.name || '',
        company: body.company || '',
        team_size: body.team_size || '',
        note: (body.note || '').slice(0, 4000)
      })]
    );
    return res.status(201).json({ ok: true, lead_id: leadId, message: 'We will reply within 1 business day.' });
  } catch (e) {
    return res.status(500).json({ error: { message: 'queued (best-effort)', detail: e.message } });
  }
}

function registerConversionPolishRoutes(app, pool) {
  const sendHtml = (res, html) => { res.setHeader('content-type', 'text/html; charset=utf-8'); res.send(html); };
  app.get('/contact-sales', (req, res) => sendHtml(res, contactSalesPage()));
  app.get('/pricing/enterprise', (req, res) => sendHtml(res, pricingEnterprisePage()));
  app.get('/demo-video', (req, res) => sendHtml(res, demoVideoPage()));
  app.get('/try-instant', (req, res) => sendHtml(res, tryInstantPage()));
  app.get('/quickstarts', (req, res) => sendHtml(res, quickstartsHubPage()));
  app.get('/quickstarts/curl', (req, res) => sendHtml(res, quickstartCurlPage()));
  app.get('/quickstarts/python', (req, res) => sendHtml(res, quickstartPythonPage()));
  app.get('/quickstarts/typescript', (req, res) => sendHtml(res, quickstartTSPage()));
  app.get('/quickstarts/go', (req, res) => sendHtml(res, quickstartGoPage()));
  app.get('/quickstarts/rust', (req, res) => sendHtml(res, quickstartRustPage()));
  app.post('/v1/marketing/leads/contact-sales', require('express').json(), (req, res) => handleContactSales(req, res, pool));
}

async function migrate(_pool) {}
module.exports = { migrate, registerConversionPolishRoutes };
