// ============================================================================
// i18n.js — locales, currency formatting, date formatting, translation table.
// Required for international expansion: localized landing/dashboard, EUR/GBP/
// JPY billing, GDPR-compliant locale-aware data residency tags.
// ============================================================================
const crypto = require('crypto');
const { z } = require('zod');

const LOCALES = {
  en:    { name: 'English',    region: 'global', rtl: false, currency: 'USD' },
  es:    { name: 'Español',    region: 'es,mx,ar,co', rtl: false, currency: 'EUR' },
  fr:    { name: 'Français',   region: 'fr,ca,be,ch', rtl: false, currency: 'EUR' },
  de:    { name: 'Deutsch',    region: 'de,at,ch', rtl: false, currency: 'EUR' },
  it:    { name: 'Italiano',   region: 'it,ch', rtl: false, currency: 'EUR' },
  pt:    { name: 'Português',  region: 'br,pt', rtl: false, currency: 'BRL' },
  ja:    { name: '日本語',      region: 'jp', rtl: false, currency: 'JPY' },
  zh:    { name: '中文',        region: 'cn,hk,tw,sg', rtl: false, currency: 'CNY' },
  ko:    { name: '한국어',      region: 'kr', rtl: false, currency: 'KRW' },
  hi:    { name: 'हिन्दी',       region: 'in', rtl: false, currency: 'INR' },
  ar:    { name: 'العربية',     region: 'sa,ae,eg', rtl: true, currency: 'AED' },
  he:    { name: 'עברית',       region: 'il', rtl: true, currency: 'ILS' },
  ru:    { name: 'Русский',    region: 'ru', rtl: false, currency: 'USD' },
  tr:    { name: 'Türkçe',     region: 'tr', rtl: false, currency: 'TRY' },
  nl:    { name: 'Nederlands', region: 'nl,be', rtl: false, currency: 'EUR' },
  pl:    { name: 'Polski',     region: 'pl', rtl: false, currency: 'EUR' },
  sv:    { name: 'Svenska',    region: 'se', rtl: false, currency: 'SEK' },
  vi:    { name: 'Tiếng Việt', region: 'vn', rtl: false, currency: 'VND' },
  th:    { name: 'ไทย',         region: 'th', rtl: false, currency: 'THB' },
  id:    { name: 'Indonesia',  region: 'id', rtl: false, currency: 'IDR' }
};

const CURRENCIES = {
  USD: { symbol: '$',   decimals: 2, symbol_position: 'before' },
  EUR: { symbol: '€',   decimals: 2, symbol_position: 'after'  },
  GBP: { symbol: '£',   decimals: 2, symbol_position: 'before' },
  JPY: { symbol: '¥',   decimals: 0, symbol_position: 'before' },
  CNY: { symbol: '¥',   decimals: 2, symbol_position: 'before' },
  KRW: { symbol: '₩',   decimals: 0, symbol_position: 'before' },
  INR: { symbol: '₹',   decimals: 2, symbol_position: 'before' },
  BRL: { symbol: 'R$',  decimals: 2, symbol_position: 'before' },
  AED: { symbol: 'د.إ', decimals: 2, symbol_position: 'after'  },
  ILS: { symbol: '₪',   decimals: 2, symbol_position: 'before' },
  TRY: { symbol: '₺',   decimals: 2, symbol_position: 'after'  },
  SEK: { symbol: 'kr',  decimals: 2, symbol_position: 'after'  },
  VND: { symbol: '₫',   decimals: 0, symbol_position: 'after'  },
  THB: { symbol: '฿',   decimals: 2, symbol_position: 'before' },
  IDR: { symbol: 'Rp',  decimals: 0, symbol_position: 'before' },
  AUD: { symbol: 'A$',  decimals: 2, symbol_position: 'before' },
  CAD: { symbol: 'C$',  decimals: 2, symbol_position: 'before' },
  CHF: { symbol: 'CHF', decimals: 2, symbol_position: 'after'  }
};

// Seed translation table with the most-visible strings on the marketing site
const SEED_STRINGS = [
  ['hero.title',     'en', 'Everything an AI agent will ever need to act on the internet. One open API.'],
  ['hero.title',     'es', 'Todo lo que un agente de IA necesitará para actuar en internet. Una API abierta.'],
  ['hero.title',     'fr', 'Tout ce dont un agent IA aura besoin pour agir sur Internet. Une API ouverte.'],
  ['hero.title',     'de', 'Alles, was ein KI-Agent jemals brauchen wird, um im Internet zu handeln. Eine offene API.'],
  ['hero.title',     'ja', 'AIエージェントがインターネットで動作するために必要なすべて。一つのオープンAPI。'],
  ['hero.title',     'zh', 'AI 代理在互联网上行动所需的一切。一个开放的 API。'],
  ['cta.start',      'en', 'Start in 30 seconds →'],
  ['cta.start',      'es', 'Comenzar en 30 segundos →'],
  ['cta.start',      'fr', 'Commencer en 30 secondes →'],
  ['cta.start',      'de', 'In 30 Sekunden starten →'],
  ['cta.start',      'ja', '30秒で開始 →'],
  ['cta.start',      'zh', '30 秒开始 →'],
  ['nav.docs',       'en', 'Docs'],
  ['nav.docs',       'es', 'Docs'],
  ['nav.docs',       'fr', 'Docs'],
  ['nav.docs',       'de', 'Doku'],
  ['nav.docs',       'ja', 'ドキュメント'],
  ['nav.docs',       'zh', '文档'],
  ['nav.pricing',    'en', 'Pricing'],
  ['nav.pricing',    'es', 'Precios'],
  ['nav.pricing',    'fr', 'Tarifs'],
  ['nav.pricing',    'de', 'Preise'],
  ['nav.pricing',    'ja', '料金'],
  ['nav.pricing',    'zh', '价格']
];

async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS i18n_translations (
      key               TEXT NOT NULL,
      locale            TEXT NOT NULL,
      value             TEXT NOT NULL,
      reviewed          BOOLEAN NOT NULL DEFAULT FALSE,
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (key, locale)
    );
    CREATE TABLE IF NOT EXISTS i18n_user_locales (
      agent_did         TEXT PRIMARY KEY,
      locale            TEXT NOT NULL DEFAULT 'en',
      currency          TEXT,
      timezone          TEXT,
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  for (const [key, locale, value] of SEED_STRINGS) {
    await pool.query(
      `INSERT INTO i18n_translations (key, locale, value, reviewed)
       VALUES ($1,$2,$3,TRUE) ON CONFLICT (key, locale) DO NOTHING`,
      [key, locale, value]
    ).catch(() => {});
  }
}

function formatCurrency(cents, currency = 'USD', locale = 'en') {
  const cfg = CURRENCIES[currency] || CURRENCIES.USD;
  const value = (cents / Math.pow(10, 2)).toFixed(cfg.decimals);
  // Locale-aware grouping (1,234.56 vs 1.234,56) — use Intl if available
  let formatted;
  try {
    formatted = new Intl.NumberFormat(locale, { minimumFractionDigits: cfg.decimals, maximumFractionDigits: cfg.decimals }).format(value);
  } catch { formatted = value; }
  return cfg.symbol_position === 'before' ? `${cfg.symbol}${formatted}` : `${formatted}${cfg.symbol}`;
}

function formatDate(date, locale = 'en', timezone = 'UTC') {
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: timezone }).format(new Date(date));
  } catch { return new Date(date).toISOString().slice(0, 10); }
}

function detectLocale(req) {
  const al = String(req.headers['accept-language'] || '').toLowerCase();
  const first = al.split(',')[0]?.split('-')[0];
  return LOCALES[first] ? first : 'en';
}

const setLocaleSchema = z.object({
  locale: z.string(),
  currency: z.string().optional(),
  timezone: z.string().optional()
});

function isAdmin(req) {
  const t = req.headers['x-admin-token'];
  return t && t === process.env.OPERATOR_ADMIN_TOKEN;
}

function registerI18nRoutes(app, pool, verifyAgentAuth, _auditChain) {
  const express = require('express');

  app.get('/v1/i18n/locales', (req, res) => {
    res.json({ locales: Object.entries(LOCALES).map(([code, l]) => ({ code, ...l })) });
  });

  app.get('/v1/i18n/currencies', (req, res) => {
    res.json({ currencies: CURRENCIES });
  });

  app.get('/v1/i18n/translations', async (req, res) => {
    const locale = req.query.locale || detectLocale(req);
    const r = await pool.query(`SELECT key, value FROM i18n_translations WHERE locale=$1`, [locale])
      .catch(() => ({ rows: [] }));
    const dict = {};
    for (const row of r.rows) dict[row.key] = row.value;
    res.setHeader('cache-control', 'public, max-age=300');
    res.json({ locale, dict });
  });

  app.post('/v1/i18n/translations', express.json(), async (req, res) => {
    if (!isAdmin(req)) return res.status(401).json({ error: 'admin_auth_required' });
    const items = Array.isArray(req.body) ? req.body : [req.body];
    let upserted = 0;
    for (const it of items) {
      if (!it.key || !it.locale || it.value == null) continue;
      await pool.query(
        `INSERT INTO i18n_translations (key, locale, value, reviewed) VALUES ($1,$2,$3,$4)
         ON CONFLICT (key, locale) DO UPDATE SET value=$3, reviewed=$4, updated_at=NOW()`,
        [it.key, it.locale, it.value, !!it.reviewed]
      ).catch(() => {});
      upserted++;
    }
    res.json({ upserted });
  });

  app.post('/v1/agents/:did/i18n', express.json(), async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const p = setLocaleSchema.safeParse(req.body || {});
    if (!p.success) return res.status(400).json({ error: 'invalid_input', details: p.error.flatten() });
    const def = LOCALES[p.data.locale];
    if (!def) return res.status(400).json({ error: 'unknown_locale' });
    await pool.query(
      `INSERT INTO i18n_user_locales (agent_did, locale, currency, timezone) VALUES ($1,$2,$3,$4)
       ON CONFLICT (agent_did) DO UPDATE SET locale=$2, currency=$3, timezone=$4, updated_at=NOW()`,
      [did, p.data.locale, p.data.currency || def.currency, p.data.timezone || 'UTC']
    );
    res.json({ ok: true, locale: p.data.locale, currency: p.data.currency || def.currency });
  });

  app.get('/v1/agents/:did/i18n', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(`SELECT locale, currency, timezone FROM i18n_user_locales WHERE agent_did=$1`, [did])
      .catch(() => ({ rows: [] }));
    res.json(r.rows[0] || { locale: 'en', currency: 'USD', timezone: 'UTC' });
  });

  // Helper: format a price in a given currency/locale
  app.get('/v1/i18n/format', (req, res) => {
    const cents = parseInt(req.query.cents) || 0;
    res.json({
      cents,
      formatted: formatCurrency(cents, req.query.currency || 'USD', req.query.locale || 'en')
    });
  });
}

module.exports = { migrate, registerI18nRoutes,
                    LOCALES, CURRENCIES, formatCurrency, formatDate, detectLocale };
