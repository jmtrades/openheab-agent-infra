// ============================================================================
// mobile_app_pages.js — app-store landing surfaces.
//
//   /download      OS-aware redirect
//   /ios           iOS app landing
//   /android       Android app landing
//   /desktop       desktop app landing
//   /mobile        mobile app overview
//   /mobile/api    mobile-friendly API docs index
//   /apps          all apps hub
// ============================================================================
const ds = require('../design_system');

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
}

function shell(title, description, content) {
  return `${ds.head(`${title} — OpenHeab`, description)}${ds.NAV_HTML('')}<main>${content}</main>${ds.FOOTER_HTML()}`;
}

function appsHubPage() {
  return shell('Apps', 'iOS, Android, desktop, browser, CLI.',
`<section style="max-width:780px;margin:0 auto;padding:60px 16px;text-align:center">
  <span class="badge b-acc">Apps</span>
  <h1 style="font:600 44px/1.05 var(--display);letter-spacing:-1.5px;margin:18px 0">Apps.</h1>
  <p style="color:var(--dim2);font-size:15px;line-height:1.55;max-width:540px;margin:0 auto">OpenHeab is web-first. These thin apps wrap key surfaces for native experiences.</p>
</section>
<section style="max-width:780px;margin:0 auto;padding:32px 16px 60px;display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:14px">
  <a href="/ios" class="card" style="color:var(--fg);text-decoration:none"><strong>📱 iOS →</strong><div style="color:var(--dim2);font-size:13px;margin-top:6px">Native app for iPhone + iPad.</div></a>
  <a href="/android" class="card" style="color:var(--fg);text-decoration:none"><strong>🤖 Android →</strong><div style="color:var(--dim2);font-size:13px;margin-top:6px">Play Store app + Wear OS.</div></a>
  <a href="/desktop" class="card" style="color:var(--fg);text-decoration:none"><strong>🖥️ Desktop →</strong><div style="color:var(--dim2);font-size:13px;margin-top:6px">macOS · Windows · Linux.</div></a>
  <a href="/openheab-cli" class="card" style="color:var(--fg);text-decoration:none"><strong>⌨️ CLI →</strong><div style="color:var(--dim2);font-size:13px;margin-top:6px">npx openheab signup.</div></a>
  <a href="/chat" class="card" style="color:var(--fg);text-decoration:none"><strong>🌐 Web (this) →</strong><div style="color:var(--dim2);font-size:13px;margin-top:6px">All 1,100+ pages, no install.</div></a>
  <a href="/embed" class="card" style="color:var(--fg);text-decoration:none"><strong>📺 Embeds →</strong><div style="color:var(--dim2);font-size:13px;margin-top:6px">Drop into your site.</div></a>
</section>`);
}

function downloadPage() {
  return shell('Download', 'Auto-detect and download the right app.',
`<section style="max-width:680px;margin:0 auto;padding:80px 16px;text-align:center">
  <h1 style="font:600 40px/1.1 var(--display);letter-spacing:-1px;margin:18px 0">Download.</h1>
  <p style="color:var(--dim2);font-size:15px;line-height:1.6;max-width:480px;margin:0 auto 32px">Detecting your platform…</p>
  <div id="d-result" style="margin-top:24px"></div>
  <noscript><p style="color:var(--dim2)"><a href="/ios">iOS</a> · <a href="/android">Android</a> · <a href="/desktop">Desktop</a></p></noscript>
</section>
<script>
(function(){
  var ua = navigator.userAgent.toLowerCase();
  var target = '/desktop';
  if (/iphone|ipad|ipod/.test(ua)) target = '/ios';
  else if (/android/.test(ua)) target = '/android';
  else if (/mac|win|linux/.test(ua)) target = '/desktop';
  document.getElementById('d-result').innerHTML = '<a href="' + target + '" class="btn primary" style="padding:14px 28px;font-size:15px">Continue to ' + target.slice(1) + ' →</a>';
  setTimeout(function(){ location.href = target; }, 800);
})();
</script>`);
}

function iosPage() {
  return shell('iOS app', 'OpenHeab for iPhone + iPad.',
`<section style="max-width:780px;margin:0 auto;padding:60px 16px;text-align:center">
  <span class="badge b-acc">iOS</span>
  <h1 style="font:600 44px/1.05 var(--display);letter-spacing:-1.5px;margin:18px 0">OpenHeab for iOS.</h1>
  <p style="color:var(--dim2);font-size:15px;line-height:1.6;max-width:540px;margin:0 auto 24px">Sign in with Apple. Push notifications. Universal links from <code>openheab.com</code> back into the app. Apple Pay for Pro+ subscriptions.</p>
  <div style="margin-top:24px">
    <a href="https://apps.apple.com" class="btn primary" style="padding:14px 28px;font-size:15px">App Store →</a>
    <a href="/openheab-cli" class="btn" style="margin-left:8px">Or use CLI</a>
  </div>
  <p style="color:var(--dim);font-size:12px;margin-top:18px;font-style:italic">In submission to App Store review. Until then, the web app at openheab.com works fine as a PWA — Add to Home Screen.</p>
</section>
<section style="max-width:780px;margin:0 auto;padding:48px 16px">
  <h2 style="font:600 22px var(--display);margin-bottom:14px">What's in the iOS app</h2>
  <ul style="color:var(--dim2);line-height:1.85;padding-left:20px">
    <li><strong style="color:var(--fg)">Chat</strong> — full chat experience with voice mode</li>
    <li><strong style="color:var(--fg)">Wallet</strong> — view balance, send USDC, scan QR for receive</li>
    <li><strong style="color:var(--fg)">Cards</strong> — view virtual card details (PAN visible after Face ID), Apple Pay add</li>
    <li><strong style="color:var(--fg)">Dashboard</strong> — agent dashboards, usage, billing</li>
    <li><strong style="color:var(--fg)">Push notifications</strong> — transfers, KYC decisions, agent events</li>
    <li><strong style="color:var(--fg)">Sign in with Apple</strong> — single-tap auth</li>
  </ul>
</section>`);
}

function androidPage() {
  return shell('Android app', 'OpenHeab for Android.',
`<section style="max-width:780px;margin:0 auto;padding:60px 16px;text-align:center">
  <span class="badge b-acc">Android</span>
  <h1 style="font:600 44px/1.05 var(--display);letter-spacing:-1.5px;margin:18px 0">OpenHeab for Android.</h1>
  <p style="color:var(--dim2);font-size:15px;line-height:1.6;max-width:540px;margin:0 auto 24px">Sign in with Google or your DID. Push via FCM. Google Pay for subscriptions. Wear OS companion.</p>
  <div style="margin-top:24px">
    <a href="https://play.google.com" class="btn primary" style="padding:14px 28px;font-size:15px">Play Store →</a>
    <a href="/openheab-cli" class="btn" style="margin-left:8px">Or use CLI</a>
  </div>
  <p style="color:var(--dim);font-size:12px;margin-top:18px;font-style:italic">In submission to Play Store review. Web app supports "Install" as a PWA in Chrome.</p>
</section>
<section style="max-width:780px;margin:0 auto;padding:48px 16px">
  <h2 style="font:600 22px var(--display);margin-bottom:14px">What's in the Android app</h2>
  <ul style="color:var(--dim2);line-height:1.85;padding-left:20px">
    <li><strong style="color:var(--fg)">Chat</strong> — same as iOS, with voice + image inputs</li>
    <li><strong style="color:var(--fg)">Wallet</strong> — full USDC wallet, biometric unlock</li>
    <li><strong style="color:var(--fg)">Cards</strong> — virtual cards, Google Pay add</li>
    <li><strong style="color:var(--fg)">Dashboard</strong> — agent + org views</li>
    <li><strong style="color:var(--fg)">FCM push</strong> — transfers, alerts</li>
    <li><strong style="color:var(--fg)">Wear OS</strong> — chat replies + balance from your watch</li>
  </ul>
</section>`);
}

function desktopPage() {
  return shell('Desktop app', 'OpenHeab for macOS / Windows / Linux.',
`<section style="max-width:780px;margin:0 auto;padding:60px 16px;text-align:center">
  <span class="badge b-acc">Desktop</span>
  <h1 style="font:600 44px/1.05 var(--display);letter-spacing:-1.5px;margin:18px 0">OpenHeab for desktop.</h1>
  <p style="color:var(--dim2);font-size:15px;line-height:1.6;max-width:540px;margin:0 auto 24px">A native shell over the web app with global hotkeys, menu-bar quick chat, and OS notifications. macOS · Windows · Linux.</p>
  <div style="margin-top:24px">
    <a href="/v1/downloads/openheab-mac.dmg" class="btn primary" style="padding:14px 24px;font-size:14px">macOS .dmg</a>
    <a href="/v1/downloads/openheab-win.exe" class="btn" style="margin-left:6px;padding:14px 24px;font-size:14px">Windows .exe</a>
    <a href="/v1/downloads/openheab-linux.AppImage" class="btn" style="margin-left:6px;padding:14px 24px;font-size:14px">Linux AppImage</a>
  </div>
  <p style="color:var(--dim);font-size:12px;margin-top:18px;font-style:italic">Code-signed builds. Sparkle (mac) + Squirrel (win) auto-update. Until first stable release ships, use the web app or CLI.</p>
</section>
<section style="max-width:780px;margin:0 auto;padding:48px 16px">
  <h2 style="font:600 22px var(--display);margin-bottom:14px">Features</h2>
  <ul style="color:var(--dim2);line-height:1.85;padding-left:20px">
    <li><strong style="color:var(--fg)">⌘ + Space</strong> — global hotkey opens a quick-chat overlay</li>
    <li><strong style="color:var(--fg)">Menu-bar widget</strong> — wallet balance + latest substrate KPIs at a glance</li>
    <li><strong style="color:var(--fg)">OS notifications</strong> — transfers, KYC decisions, etc.</li>
    <li><strong style="color:var(--fg)">Built-in CLI</strong> — bundles <code>openheab</code> command</li>
    <li><strong style="color:var(--fg)">Offline cache</strong> — recent chats + docs viewable offline</li>
  </ul>
</section>`);
}

function mobileOverviewPage() {
  return shell('Mobile', 'Mobile experience overview.',
`<section style="max-width:780px;margin:0 auto;padding:60px 16px;text-align:center">
  <span class="badge b-acc">Mobile</span>
  <h1 style="font:600 44px/1.05 var(--display);letter-spacing:-1.5px;margin:18px 0">Mobile.</h1>
  <p style="color:var(--dim2);font-size:15px;line-height:1.6;max-width:540px;margin:0 auto 24px">Web app is fully responsive — every page works on mobile. Native iOS + Android apps add push notifications, Apple/Google Pay, and biometric unlock.</p>
  <div style="margin-top:24px">
    <a href="/ios" class="btn">iOS</a>
    <a href="/android" class="btn" style="margin-left:8px">Android</a>
    <a href="/chat" class="btn primary" style="margin-left:8px">Open web app</a>
  </div>
</section>`);
}

function mobileApiPage() {
  return shell('Mobile API', 'Building a mobile client against the substrate.',
`<section style="max-width:780px;margin:0 auto;padding:60px 16px">
  <span class="badge b-acc">Mobile API</span>
  <h1 style="font:600 40px/1.1 var(--display);letter-spacing:-1px;margin:18px 0">Build your own mobile client.</h1>
  <p style="color:var(--dim2);font-size:15px;line-height:1.7">The /v1/* surface is mobile-friendly out of the box. Highlights for mobile devs:</p>

  <h2 style="font:600 20px var(--display);margin:32px 0 10px">Push token registration</h2>
  <pre style="background:var(--card);border:1px solid var(--br);border-radius:var(--r-md);padding:14px;overflow-x:auto;font-size:13px"><code>POST /v1/agents/:did/mobile/devices
{
  "device_id": "uuid-v4",
  "platform": "ios" | "android",
  "push_token": "...",
  "app_version": "1.0.0"
}</code></pre>

  <h2 style="font:600 20px var(--display);margin:32px 0 10px">Universal / app links</h2>
  <p style="color:var(--dim2);line-height:1.7">We serve the <code>apple-app-site-association</code> and <code>.well-known/assetlinks.json</code> files at our root, so links like <code>https://openheab.com/a/did:op:abc</code> open your app directly when installed.</p>

  <h2 style="font:600 20px var(--display);margin:32px 0 10px">Webhooks for push</h2>
  <p style="color:var(--dim2);line-height:1.7">Subscribe at <a href="/webhooks">/webhooks</a> to events the user cares about. Your server forwards them as push notifications.</p>

  <h2 style="font:600 20px var(--display);margin:32px 0 10px">Auth flow</h2>
  <p style="color:var(--dim2);line-height:1.7">Use the OAuth bridge: <code>/v1/oauth/start?provider=openheab&redirect_uri=yourapp://callback</code>. Returns a scoped access token your app stores in Keychain / Keystore.</p>
</section>`);
}

function registerMobileAppPagesRoutes(app, _pool) {
  const sendHtml = (res, html) => { res.setHeader('content-type', 'text/html; charset=utf-8'); res.send(html); };
  app.get('/apps', (req, res) => sendHtml(res, appsHubPage()));
  app.get('/download', (req, res) => sendHtml(res, downloadPage()));
  app.get('/ios', (req, res) => sendHtml(res, iosPage()));
  app.get('/android', (req, res) => sendHtml(res, androidPage()));
  app.get('/desktop', (req, res) => sendHtml(res, desktopPage()));
  app.get('/mobile', (req, res) => sendHtml(res, mobileOverviewPage()));
  app.get('/mobile/api', (req, res) => sendHtml(res, mobileApiPage()));
}

async function migrate(_pool) {}
module.exports = { migrate, registerMobileAppPagesRoutes };
