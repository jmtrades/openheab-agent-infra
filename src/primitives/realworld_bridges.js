// ============================================================================
// realworld_bridges.js — setup wizards for wiring agents into the real world.
//
//   /realworld           hub
//   /realworld/slack     Slack integration wizard
//   /realworld/discord   Discord integration wizard
//   /realworld/telegram  Telegram bot wizard
//   /realworld/whatsapp  WhatsApp integration wizard
//   /realworld/email     email-in / email-out wizard
//   /realworld/calendar  calendar integration wizard
//   /realworld/wallet    external wallet linking
//   /realworld/bank      ACH linking wizard
//   /realworld/identity  external KYC linking
//   /realworld/phone     phone number provisioning
// ============================================================================
const ds = require('../design_system');

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
}

function shell(title, description, content) {
  return `${ds.head(`${title} — OpenHeab`, description)}${ds.NAV_HTML('')}<main>${content}</main>${ds.FOOTER_HTML()}`;
}

const CHANNELS = [
  { slug: 'slack', name: 'Slack', icon: '💬', desc: 'Add OpenHeab as a Slack app. Mentions and DMs route to your agent.' },
  { slug: 'discord', name: 'Discord', icon: '🎮', desc: 'Discord bot integration. Server messages route to your agent.' },
  { slug: 'telegram', name: 'Telegram', icon: '✈️', desc: 'Telegram bot. Each chat is a conversation thread for your agent.' },
  { slug: 'whatsapp', name: 'WhatsApp', icon: '🟢', desc: 'WhatsApp Business API. Messages route through Twilio.' },
  { slug: 'email', name: 'Email', icon: '✉️', desc: 'agent@yourdomain.com inbox routed to your agent. SPF/DKIM/DMARC handled.' },
  { slug: 'calendar', name: 'Calendar', icon: '📅', desc: 'Google Calendar / iCloud / Outlook OAuth. Agent can read + book events.' },
  { slug: 'wallet', name: 'Wallet', icon: '💰', desc: 'Link an external Ethereum / Solana / Bitcoin wallet to your DID.' },
  { slug: 'bank', name: 'Bank', icon: '🏦', desc: 'Link a real bank account via Plaid for ACH transfers in and out.' },
  { slug: 'identity', name: 'Identity', icon: '🛂', desc: 'Link an external KYC verification (Persona, Onfido, Sumsub).' },
  { slug: 'phone', name: 'Phone', icon: '☎️', desc: 'Provision a phone number. Inbound calls hit your voice agent.' },
];

function hubPage() {
  return shell('Real-world bridges', 'Wire your agent into the real world.',
`<section style="padding:60px 0 24px;max-width:980px;margin:0 auto;padding-left:16px;padding-right:16px;text-align:center">
  <span class="badge b-acc">Real-world bridges</span>
  <h1 style="font:600 44px/1.05 var(--display);letter-spacing:-1.5px;margin:18px 0">Real-world bridges.</h1>
  <p style="color:var(--dim2);font-size:15px;line-height:1.6;max-width:680px;margin:0 auto">Setup wizards for connecting your agent to channels and systems humans actually use.</p>
</section>
<section style="max-width:980px;margin:0 auto;padding:32px 16px 60px">
  <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px">
    ${CHANNELS.map(c => `<a href="/realworld/${c.slug}" class="card" style="color:var(--fg);text-decoration:none">
      <div style="font-size:28px;margin-bottom:10px">${c.icon}</div>
      <strong style="font-size:15px">${escapeHtml(c.name)} →</strong>
      <p style="color:var(--dim2);font-size:13px;line-height:1.55;margin-top:6px">${escapeHtml(c.desc)}</p>
    </a>`).join('')}
  </div>
</section>`);
}

// ----------------------------------------------------------------------------
// Per-channel page template
// ----------------------------------------------------------------------------
function channelPage(slug, body) {
  const c = CHANNELS.find(x => x.slug === slug);
  if (!c) return null;
  return shell(`${c.name} integration`, c.desc,
`<section style="max-width:780px;margin:0 auto;padding:60px 16px">
  <a href="/realworld" style="font:500 12px var(--mono);color:var(--dim);text-decoration:none">← All bridges</a>
  <div style="font-size:48px;margin:14px 0">${c.icon}</div>
  <h1 style="font:600 40px/1.1 var(--display);letter-spacing:-1px">${escapeHtml(c.name)}.</h1>
  <p style="color:var(--dim2);font-size:15px;line-height:1.7;margin:14px 0 32px">${escapeHtml(c.desc)}</p>
</section>
<section style="max-width:780px;margin:0 auto;padding:0 16px 60px">${body}</section>`);
}

function slackPage() {
  return channelPage('slack', `
<h2 style="font:600 20px var(--display);margin:0 0 10px">What you get</h2>
<ul style="color:var(--dim2);line-height:1.8;padding-left:20px">
  <li><strong style="color:var(--fg)">Mentions in channels</strong> route to <code>POST /v1/_webhooks/slack-real</code> with HMAC verification.</li>
  <li><strong style="color:var(--fg)">DMs</strong> become threaded conversations bound to your agent's DID.</li>
  <li><strong style="color:var(--fg)">Slash commands</strong> like <code>/openheab pay</code> can call any /v1 endpoint.</li>
  <li><strong style="color:var(--fg)">Block Kit cards</strong> render rich responses (buttons, dropdowns, modals).</li>
</ul>
<h2 style="font:600 20px var(--display);margin:32px 0 10px">Setup</h2>
<ol style="color:var(--dim2);line-height:1.8;padding-left:20px">
  <li>Go to <a href="https://api.slack.com/apps">api.slack.com/apps</a> → Create New App → From scratch.</li>
  <li>Add Bot Token scopes: <code>chat:write</code>, <code>app_mentions:read</code>, <code>commands</code>, <code>im:history</code>.</li>
  <li>Event Subscriptions → Request URL → <code>https://openheab.com/v1/_webhooks/slack-real</code>.</li>
  <li>Subscribe to bot events: <code>app_mention</code>, <code>message.im</code>.</li>
  <li>Install to workspace, copy the Bot User OAuth Token + Signing Secret.</li>
  <li>POST to <code>/v1/integrations/slack/connect</code> with <code>{ bot_token, signing_secret, agent_did }</code>.</li>
</ol>
<p style="color:var(--dim2);line-height:1.7;margin-top:20px">Your agent now answers in Slack. Signing-secret-verified deliveries, 5-min replay protection.</p>`);
}

function discordPage() {
  return channelPage('discord', `
<h2 style="font:600 20px var(--display);margin:0 0 10px">Setup</h2>
<ol style="color:var(--dim2);line-height:1.8;padding-left:20px">
  <li>Go to <a href="https://discord.com/developers/applications">discord.com/developers/applications</a> → New Application.</li>
  <li>Bot → Add Bot. Copy the token.</li>
  <li>OAuth2 → URL Generator → scopes: <code>bot</code> + <code>applications.commands</code>. Permissions: Send Messages + Read Messages.</li>
  <li>Open the generated URL, add to your server.</li>
  <li>POST to <code>/v1/integrations/discord/connect</code> with <code>{ bot_token, agent_did }</code>.</li>
</ol>
<p style="color:var(--dim2);line-height:1.7;margin-top:20px">Slash commands and message intents both supported.</p>`);
}

function telegramPage() {
  return channelPage('telegram', `
<h2 style="font:600 20px var(--display);margin:0 0 10px">Setup</h2>
<ol style="color:var(--dim2);line-height:1.8;padding-left:20px">
  <li>Open Telegram → message <code>@BotFather</code> → <code>/newbot</code> → name it.</li>
  <li>Copy the API token BotFather gives you.</li>
  <li>POST <code>/v1/integrations/telegram/connect</code> with <code>{ bot_token, agent_did }</code>.</li>
  <li>We set the webhook URL on Telegram's side; messages start flowing to your agent.</li>
</ol>`);
}

function whatsappPage() {
  return channelPage('whatsapp', `
<h2 style="font:600 20px var(--display);margin:0 0 10px">Setup (Twilio WhatsApp)</h2>
<ol style="color:var(--dim2);line-height:1.8;padding-left:20px">
  <li>Provision a WhatsApp number in Twilio (requires Facebook Business Manager approval).</li>
  <li>Set the incoming webhook to <code>https://openheab.com/v1/_webhooks/voice-agent</code>.</li>
  <li>POST <code>/v1/integrations/whatsapp/connect</code> with <code>{ twilio_account_sid, twilio_auth_token, from_number, agent_did }</code>.</li>
  <li>Inbound messages signed-validate via Twilio's X-Twilio-Signature.</li>
</ol>`);
}

function emailPage() {
  return channelPage('email', `
<h2 style="font:600 20px var(--display);margin:0 0 10px">Inbound</h2>
<p style="color:var(--dim2);line-height:1.7">Reserve <code>youragent@inbox.openheab.com</code> (or your custom domain after DNS verification). Incoming mail parsed by <code>email_core</code>, full RFC 5322 + DKIM/SPF/DMARC validation, then handed to your agent as a structured event.</p>

<h2 style="font:600 20px var(--display);margin:32px 0 10px">Outbound</h2>
<p style="color:var(--dim2);line-height:1.7">POST <code>/v1/agents/:did/email/send</code>. We sign with DKIM, queue to our MTA, retry with exponential backoff. Provenance tracked in <code>email_advanced</code>.</p>

<h2 style="font:600 20px var(--display);margin:32px 0 10px">Templates</h2>
<p style="color:var(--dim2);line-height:1.7">Pre-built transactional templates at <a href="/v1/email-templates">/v1/email-templates</a> — signup welcome, billing receipt, security alert, KYC approved, password reset.</p>`);
}

function calendarPage() {
  return channelPage('calendar', `
<h2 style="font:600 20px var(--display);margin:0 0 10px">Setup</h2>
<ol style="color:var(--dim2);line-height:1.8;padding-left:20px">
  <li>Visit <code>/v1/oauth/calendar/start?agent_did=did:op:…&provider=google</code>.</li>
  <li>Approve scopes (read events, create events, free-busy).</li>
  <li>Tokens encrypted with INTEGRATIONS_MASTER_KEK and stored in <code>oauth_credentials</code>.</li>
  <li>Agent uses <code>POST /v1/agents/:did/calendar/events</code> to create + <code>GET /v1/agents/:did/calendar/free-busy</code> to check.</li>
</ol>
<p style="color:var(--dim2);line-height:1.7">Providers supported: Google Calendar, iCloud, Outlook 365, Fastmail.</p>`);
}

function walletPage() {
  return channelPage('wallet', `
<h2 style="font:600 20px var(--display);margin:0 0 10px">What this does</h2>
<p style="color:var(--dim2);line-height:1.7">Link an external Ethereum / Solana / Bitcoin address to your agent's DID. Inbound transfers to that address auto-credit the DID's substrate wallet. Useful for accepting payments from non-OpenHeab counterparties.</p>

<h2 style="font:600 20px var(--display);margin:32px 0 10px">Setup</h2>
<ol style="color:var(--dim2);line-height:1.8;padding-left:20px">
  <li>POST <code>/v1/agents/:did/bank/wallets/external</code> with <code>{ chain: "base", address: "0x..." }</code>.</li>
  <li>We send a tiny verification transaction (refundable) you must sign and send back.</li>
  <li>Once verified, the address is linked to your DID. Inbound deposits credit your substrate balance within 30 seconds.</li>
</ol>`);
}

function bankPage() {
  return channelPage('bank', `
<h2 style="font:600 20px var(--display);margin:0 0 10px">Setup (Plaid)</h2>
<ol style="color:var(--dim2);line-height:1.8;padding-left:20px">
  <li>POST <code>/v1/agents/:did/plaid/link/start</code> to get a Plaid Link token.</li>
  <li>Render Plaid Link in the browser. User authenticates with their bank.</li>
  <li>Exchange public token via POST <code>/v1/agents/:did/plaid/link/exchange</code>.</li>
  <li>Substrate stores tokens encrypted with ACH_MASTER_KEK. Account is ACH-eligible after Plaid IDV.</li>
</ol>

<h2 style="font:600 20px var(--display);margin:32px 0 10px">Money in</h2>
<p style="color:var(--dim2);line-height:1.7">POST <code>/v1/agents/:did/ach/transfers { direction: "credit", amount_cents: 10000 }</code>. Two business-day ACH settlement; 30-day reversal window per NACHA.</p>

<h2 style="font:600 20px var(--display);margin:32px 0 10px">Money out</h2>
<p style="color:var(--dim2);line-height:1.7">Same endpoint with <code>direction: "debit"</code>. Same-day ACH eligibility for accounts that have been on file ≥10 days.</p>`);
}

function identityPage() {
  return channelPage('identity', `
<h2 style="font:600 20px var(--display);margin:0 0 10px">Why link external KYC</h2>
<p style="color:var(--dim2);line-height:1.7">Our in-house <code>kyc_core</code> handles standard verification. But some jurisdictions or counterparties require a specific vendor's attestation (Persona, Onfido, Sumsub, Comply Advantage). Link the external check to your DID and re-use it across the substrate.</p>

<h2 style="font:600 20px var(--display);margin:32px 0 10px">Providers supported</h2>
<ul style="color:var(--dim2);line-height:1.8;padding-left:20px">
  <li><strong style="color:var(--fg)">Persona</strong> — POST <code>/v1/integrations/persona/link</code> with inquiry ID.</li>
  <li><strong style="color:var(--fg)">Onfido</strong> — POST <code>/v1/integrations/onfido/link</code> with applicant ID.</li>
  <li><strong style="color:var(--fg)">Sumsub</strong> — POST <code>/v1/integrations/sumsub/link</code> with applicant ID.</li>
  <li><strong style="color:var(--fg)">Comply Advantage</strong> — POST <code>/v1/integrations/comply-advantage/link</code>.</li>
</ul>
<p style="color:var(--dim2);line-height:1.7;margin-top:14px">Once linked, downstream KYC checks credit the same verification — no re-collecting documents.</p>`);
}

function phonePage() {
  return channelPage('phone', `
<h2 style="font:600 20px var(--display);margin:0 0 10px">Provision</h2>
<ol style="color:var(--dim2);line-height:1.8;padding-left:20px">
  <li>POST <code>/v1/agents/:did/phone/numbers</code> with <code>{ country: "US", capabilities: ["voice","sms"] }</code>.</li>
  <li>We provision a Twilio number, assign it to your agent.</li>
  <li>Inbound calls hit <code>/v1/_webhooks/voice-agent</code>, which validates Twilio's X-Twilio-Signature, then runs your agent in voice mode.</li>
  <li>Inbound SMS hit <code>/v1/_webhooks/sms</code>, route to your agent's inbox.</li>
</ol>

<h2 style="font:600 20px var(--display);margin:32px 0 10px">Voice agents</h2>
<p style="color:var(--dim2);line-height:1.7">Spin up a phone-backed agent in 60 seconds at <a href="/voice-agents/new">/voice-agents/new</a>.</p>`);
}

const PAGES = {
  slack: slackPage,
  discord: discordPage,
  telegram: telegramPage,
  whatsapp: whatsappPage,
  email: emailPage,
  calendar: calendarPage,
  wallet: walletPage,
  bank: bankPage,
  identity: identityPage,
  phone: phonePage
};

function registerRealworldBridgesRoutes(app, _pool) {
  const sendHtml = (res, html, status = 200) => {
    res.status(status);
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.setHeader('cache-control', 'public, max-age=600');
    res.send(html);
  };
  app.get('/realworld', (req, res) => sendHtml(res, hubPage()));
  for (const slug of Object.keys(PAGES)) {
    app.get(`/realworld/${slug}`, (req, res) => sendHtml(res, PAGES[slug]()));
  }
}

async function migrate(_pool) {}
module.exports = { migrate, registerRealworldBridgesRoutes };
