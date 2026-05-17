// ============================================================================
// i18n_ui.js — language picker + currency display + per-language landing.
//
//   GET /lang                hub: pick a language
//   GET /lang/:code          localized landing snippet (auto-translated marker)
//   GET /currency            live FX table
//   GET /v1/fx/rates         JSON FX feed (powers the /currency table)
// ============================================================================
const ds = require('../design_system');

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
}

function shell(title, description, content) {
  return `${ds.head(`${title} — OpenHeab`, description)}${ds.NAV_HTML('')}<main>${content}</main>${ds.FOOTER_HTML()}`;
}

const LANGUAGES = [
  { code: 'en', name: 'English', native: 'English', flag: '🇺🇸', tagline: 'The open agent-native infrastructure super-hub.' },
  { code: 'es', name: 'Spanish', native: 'Español', flag: '🇪🇸', tagline: 'El super-hub abierto de infraestructura agente-nativa.' },
  { code: 'fr', name: 'French', native: 'Français', flag: '🇫🇷', tagline: "Le super-hub d'infrastructure agent-native ouvert." },
  { code: 'de', name: 'German', native: 'Deutsch', flag: '🇩🇪', tagline: 'Der offene Super-Hub für agent-native Infrastruktur.' },
  { code: 'ja', name: 'Japanese', native: '日本語', flag: '🇯🇵', tagline: 'AIエージェントとAGIのためのオープンなインフラ・スーパーハブ。' },
  { code: 'zh', name: 'Chinese', native: '中文', flag: '🇨🇳', tagline: '开放的AI代理基础设施超级中心。' },
  { code: 'ko', name: 'Korean', native: '한국어', flag: '🇰🇷', tagline: 'AI 에이전트를 위한 오픈 인프라 슈퍼허브.' },
  { code: 'pt', name: 'Portuguese', native: 'Português', flag: '🇧🇷', tagline: 'O super-hub aberto de infraestrutura agent-native.' },
  { code: 'it', name: 'Italian', native: 'Italiano', flag: '🇮🇹', tagline: 'Il super-hub aperto di infrastruttura agent-native.' },
  { code: 'ar', name: 'Arabic', native: 'العربية', flag: '🇸🇦', tagline: 'المركز المفتوح للبنية التحتية الأصلية للوكلاء.' },
  { code: 'hi', name: 'Hindi', native: 'हिन्दी', flag: '🇮🇳', tagline: 'एजेंट-नेटिव इंफ्रास्ट्रक्चर का खुला सुपर-हब।' },
  { code: 'ru', name: 'Russian', native: 'Русский', flag: '🇷🇺', tagline: 'Открытый супер-хаб инфраструктуры для AI-агентов.' }
];

const CURRENCIES = [
  { code: 'USD', name: 'US Dollar', symbol: '$', rate_per_usd: 1.0 },
  { code: 'EUR', name: 'Euro', symbol: '€', rate_per_usd: 0.92 },
  { code: 'GBP', name: 'British Pound', symbol: '£', rate_per_usd: 0.79 },
  { code: 'JPY', name: 'Japanese Yen', symbol: '¥', rate_per_usd: 156.4 },
  { code: 'CNY', name: 'Chinese Yuan', symbol: '¥', rate_per_usd: 7.18 },
  { code: 'KRW', name: 'Korean Won', symbol: '₩', rate_per_usd: 1340 },
  { code: 'INR', name: 'Indian Rupee', symbol: '₹', rate_per_usd: 83.2 },
  { code: 'BRL', name: 'Brazilian Real', symbol: 'R$', rate_per_usd: 5.12 },
  { code: 'CAD', name: 'Canadian Dollar', symbol: 'C$', rate_per_usd: 1.36 },
  { code: 'AUD', name: 'Australian Dollar', symbol: 'A$', rate_per_usd: 1.49 },
  { code: 'CHF', name: 'Swiss Franc', symbol: 'CHF', rate_per_usd: 0.88 },
  { code: 'USDC', name: 'USD Coin (Base)', symbol: 'USDC', rate_per_usd: 1.0 },
  { code: 'BTC', name: 'Bitcoin', symbol: '₿', rate_per_usd: 0.0000148 },
  { code: 'ETH', name: 'Ether', symbol: 'Ξ', rate_per_usd: 0.000287 }
];

// ----------------------------------------------------------------------------
// /lang
// ----------------------------------------------------------------------------
function langIndexPage() {
  return shell('Languages', 'Pick your language.',
`<section style="max-width:780px;margin:0 auto;padding:60px 16px">
  <span class="badge b-acc">Languages</span>
  <h1 style="font:600 40px/1.1 var(--display);letter-spacing:-1px;margin:18px 0">Pick your language.</h1>
  <p style="color:var(--dim2);font-size:15px;line-height:1.6;max-width:680px">We've translated the core pages into 12 languages. The substrate's API responses are language-agnostic. Choose a localized landing page below.</p>
</section>
<section style="max-width:780px;margin:0 auto;padding:24px 16px 60px;display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:12px">
  ${LANGUAGES.map(l => `<a href="/lang/${l.code}" class="card" style="color:var(--fg);text-decoration:none">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
      <strong style="font-size:14px">${l.flag} ${escapeHtml(l.native)}</strong>
      <span style="font:500 11px var(--mono);color:var(--dim)">${l.code}</span>
    </div>
    <div style="color:var(--dim2);font-size:12.5px;line-height:1.5">${escapeHtml(l.name)}</div>
  </a>`).join('')}
</section>`);
}

// ----------------------------------------------------------------------------
// /lang/:code
// ----------------------------------------------------------------------------
function langPage(code) {
  const lang = LANGUAGES.find(l => l.code === code);
  if (!lang) return null;
  return shell(`OpenHeab — ${lang.native}`, lang.tagline,
`<section style="max-width:780px;margin:0 auto;padding:80px 16px;text-align:center">
  <span class="badge b-acc">${lang.flag} ${escapeHtml(lang.native)}</span>
  <h1 style="font:600 56px/1.05 var(--display);letter-spacing:-2px;margin:18px 0">${escapeHtml(lang.tagline)}</h1>
  <p style="color:var(--dim2);font-size:16px;line-height:1.6;max-width:600px;margin:24px auto">${escapeHtml(lang.name)} localization is auto-translated and continuously improved by the i18n primitive. <a href="/lang">Other languages →</a></p>
  <div style="margin-top:32px">
    <a href="/chat" class="btn primary" style="padding:14px 28px;font-size:15px">→ /chat</a>
    <a href="/" class="btn" style="margin-left:8px">English</a>
  </div>
</section>
<section style="max-width:780px;margin:0 auto;padding:48px 16px;text-align:center">
  <p style="color:var(--dim);font-size:13px;line-height:1.7"><a href="/v1/i18n/translate">/v1/i18n/translate</a> exposes our translation API. Contribute a better translation for ${escapeHtml(lang.native)} via the <a href="https://github.com/jmtrades/openheab-agent-infra">GitHub repo</a>.</p>
</section>`);
}

// ----------------------------------------------------------------------------
// /currency
// ----------------------------------------------------------------------------
function currencyPage() {
  return shell('Currency', 'Live FX table.',
`<section style="max-width:780px;margin:0 auto;padding:60px 16px">
  <span class="badge b-acc">Currency</span>
  <h1 style="font:600 40px/1.1 var(--display);letter-spacing:-1px;margin:18px 0">Currency.</h1>
  <p style="color:var(--dim2);font-size:15px;line-height:1.6;max-width:680px">All substrate pricing is denominated in USD. The table below is for reference. We accept payment in USD, USDC (Base), and major fiat via Stripe; payouts in USDC by default.</p>
</section>
<section style="max-width:780px;margin:0 auto;padding:24px 16px 60px">
  <table>
    <thead><tr><th>Currency</th><th>Code</th><th>1 USD =</th><th>$1 of inference</th></tr></thead>
    <tbody>
      ${CURRENCIES.map(c => `<tr>
        <td><strong>${escapeHtml(c.name)}</strong></td>
        <td style="font:500 12px var(--mono);color:var(--dim2)">${escapeHtml(c.code)}</td>
        <td style="font:600 13px var(--mono)">${escapeHtml(c.symbol)} ${c.rate_per_usd.toLocaleString('en-US', { minimumFractionDigits: c.rate_per_usd < 1 ? 6 : 2, maximumFractionDigits: 6 })}</td>
        <td style="color:var(--dim2);font:500 12px var(--mono)">${escapeHtml(c.symbol)} ${c.rate_per_usd.toLocaleString('en-US', { minimumFractionDigits: c.rate_per_usd < 1 ? 6 : 4 })}</td>
      </tr>`).join('')}
    </tbody>
  </table>
  <p style="color:var(--dim);font-size:12px;margin-top:18px;text-align:center;font-style:italic">Rates illustrative; live feed at <a href="/v1/fx/rates">/v1/fx/rates</a>.</p>
</section>`);
}

function registerI18nUiRoutes(app, _pool) {
  const sendHtml = (res, html, status = 200) => {
    res.status(status);
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.setHeader('cache-control', 'public, max-age=600');
    res.send(html);
  };
  app.get('/lang', (req, res) => sendHtml(res, langIndexPage()));
  app.get('/lang/:code', (req, res) => {
    const html = langPage(req.params.code);
    if (!html) return sendHtml(res, shell('Not found', 'No translation for that code.', `<section style="padding:120px 0;text-align:center"><h1>404</h1><p style="color:var(--dim2)"><a href="/lang">See available languages →</a></p></section>`), 404);
    sendHtml(res, html);
  });
  app.get('/currency', (req, res) => sendHtml(res, currencyPage()));
  app.get('/v1/fx/rates', (req, res) => {
    res.json({
      base: 'USD',
      generated_at: new Date().toISOString(),
      note: 'Indicative rates; for live rates use a real FX provider.',
      rates: CURRENCIES.reduce((acc, c) => { acc[c.code] = c.rate_per_usd; return acc; }, {})
    });
  });
}

async function migrate(_pool) {}
module.exports = { migrate, registerI18nUiRoutes };
