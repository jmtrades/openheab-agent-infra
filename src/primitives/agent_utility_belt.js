// ============================================================================
// agent_utility_belt.js — 60+ utility endpoints under /v1/util/* that
// every agent will reach for. Pure functions (no DB / no auth) except where
// noted. Each is also wired as an MCP tool so MCP-aware clients (Claude
// Desktop, Cursor, VS Code) get them automatically.
//
// Categories:
//   STRING        slugify, normalize, similarity, levenshtein, casing
//   ENCODING      base64, base32, base58, hex, url, html, csv, xml, yaml
//   HASH/CRYPTO   sha256/512, md5, hmac, password-strength, random
//   VALIDATION    email/url/uuid/phone/iban/luhn/ipv4/ipv6/domain/jwt
//   DATETIME      timezone convert, business days, cron next-fire, age
//   FORMATTING    currency, number, bytes, duration, pluralize
//   NUMERIC       big-int math, currency convert (FX), rounding, units
//   TEXT          word count, reading time, summarize-truncate, redact PII
//   COLOR         hex↔rgb↔hsl, contrast, palette
//   REGEX         test, match-all, replace, validate-pattern
//   JSON          path query, diff, merge, validate-schema, flatten
//   MARKDOWN      to-html, to-text, headings
//   QR/BARCODE    qr SVG, code128 SVG
//   GEO           great-circle distance, IP→country (stub)
//   IMAGES        SVG transforms (resize via viewBox, color)
//   RATE          retry-after parse, exp-backoff calc, rate-limit advice
//   IDENTIFIERS   uuid v4/v7, nanoid, ulid, prefix-id
//   TIME          parse natural language, format relative
// ============================================================================
const crypto = require('crypto');

async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS util_call_log (
      log_id      TEXT PRIMARY KEY,
      util        TEXT NOT NULL,
      ip_hash     TEXT,
      latency_us  INTEGER,
      called_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_util_log ON util_call_log (util, called_at DESC);
  `);
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

// ============================================================================
// UTILITY FUNCTIONS (pure)
// ============================================================================
const UTILS = {

  // ---------- STRING ----------
  slugify(s) {
    return String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100);
  },
  normalize_whitespace(s) { return String(s || '').replace(/\s+/g, ' ').trim(); },
  to_snake(s) { return String(s || '').replace(/([A-Z])/g, '_$1').replace(/[-\s]+/g, '_').toLowerCase().replace(/^_/, ''); },
  to_camel(s) { return String(s || '').toLowerCase().replace(/[-_\s]+(.)/g, (_, c) => c.toUpperCase()); },
  to_pascal(s) { const c = UTILS.to_camel(s); return c.charAt(0).toUpperCase() + c.slice(1); },
  to_kebab(s) { return String(s || '').replace(/([A-Z])/g, '-$1').replace(/[_\s]+/g, '-').toLowerCase().replace(/^-/, ''); },
  to_title(s) { return String(s || '').split(/\s+/).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' '); },

  levenshtein(a, b) {
    a = String(a || ''); b = String(b || '');
    if (a === b) return 0;
    if (!a.length || !b.length) return a.length || b.length;
    const m = Array.from({ length: a.length + 1 }, (_, i) => [i]);
    for (let j = 1; j <= b.length; j++) m[0][j] = j;
    for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
      m[i][j] = Math.min(m[i-1][j] + 1, m[i][j-1] + 1, m[i-1][j-1] + (a[i-1] === b[j-1] ? 0 : 1));
    return m[a.length][b.length];
  },
  similarity(a, b) {
    a = String(a || ''); b = String(b || '');
    const max = Math.max(a.length, b.length);
    if (max === 0) return 1;
    return 1 - (UTILS.levenshtein(a, b) / max);
  },
  word_count(s) {
    s = String(s || '').trim();
    return s ? s.split(/\s+/).length : 0;
  },
  reading_time_min(s, wpm = 230) { return Math.ceil(UTILS.word_count(s) / wpm); },

  // ---------- ENCODING ----------
  b64_encode(s) { return Buffer.from(String(s ?? ''), 'utf8').toString('base64'); },
  b64_decode(s) { return Buffer.from(String(s ?? ''), 'base64').toString('utf8'); },
  b64url_encode(s) { return Buffer.from(String(s ?? ''), 'utf8').toString('base64url'); },
  b64url_decode(s) { return Buffer.from(String(s ?? ''), 'base64url').toString('utf8'); },
  hex_encode(s) { return Buffer.from(String(s ?? ''), 'utf8').toString('hex'); },
  hex_decode(s) { return Buffer.from(String(s ?? ''), 'hex').toString('utf8'); },
  url_encode(s) { return encodeURIComponent(String(s ?? '')); },
  url_decode(s) { try { return decodeURIComponent(String(s ?? '')); } catch { return null; } },
  html_escape(s) { return escapeHtml(s); },
  html_unescape(s) {
    return String(s || '').replace(/&(amp|lt|gt|quot|#39);/g, m =>
      ({ '&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&#39;':"'" }[m]));
  },

  // base58 (Bitcoin alphabet, no 0/O/I/l)
  base58_encode(buf) {
    if (!Buffer.isBuffer(buf)) buf = Buffer.from(String(buf || ''));
    const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    let n = BigInt('0x' + (buf.toString('hex') || '0'));
    let out = '';
    while (n > 0n) { out = alphabet[Number(n % 58n)] + out; n = n / 58n; }
    for (let i = 0; i < buf.length && buf[i] === 0; i++) out = '1' + out;
    return out || '1';
  },

  // ---------- HASH / CRYPTO ----------
  sha256(s) { return crypto.createHash('sha256').update(String(s ?? '')).digest('hex'); },
  sha512(s) { return crypto.createHash('sha512').update(String(s ?? '')).digest('hex'); },
  md5(s) { return crypto.createHash('md5').update(String(s ?? '')).digest('hex'); },
  hmac_sha256(secret, msg) {
    return crypto.createHmac('sha256', String(secret || '')).update(String(msg || '')).digest('hex');
  },
  random_hex(bytes = 16) { return crypto.randomBytes(Math.min(Math.max(parseInt(bytes) || 16, 1), 1024)).toString('hex'); },
  random_int(min, max) {
    min = Math.floor(Number(min) || 0); max = Math.floor(Number(max) || 100);
    if (max <= min) return min;
    return crypto.randomInt(min, max);
  },
  random_choice(arr) {
    if (!Array.isArray(arr) || arr.length === 0) return null;
    return arr[crypto.randomInt(0, arr.length)];
  },

  password_strength(pw) {
    pw = String(pw || '');
    let score = 0;
    if (pw.length >= 12) score += 2; else if (pw.length >= 8) score += 1;
    if (/[a-z]/.test(pw)) score += 1;
    if (/[A-Z]/.test(pw)) score += 1;
    if (/[0-9]/.test(pw)) score += 1;
    if (/[^a-zA-Z0-9]/.test(pw)) score += 1;
    if (pw.length >= 20) score += 1;
    const commonPatterns = [/^password/i, /^123/, /qwerty/i, /^admin/i, /letmein/i];
    if (commonPatterns.some(p => p.test(pw))) score = Math.max(0, score - 3);
    const label = score >= 6 ? 'strong' : score >= 4 ? 'medium' : score >= 2 ? 'weak' : 'very weak';
    return { score, max: 7, label, length: pw.length };
  },

  // ---------- VALIDATION ----------
  is_email(s) { return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(s || '')); },
  is_url(s) { try { new URL(String(s || '')); return true; } catch { return false; } },
  is_uuid(s) { return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-9][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(s || '')); },
  is_ipv4(s) {
    const parts = String(s || '').split('.');
    if (parts.length !== 4) return false;
    return parts.every(p => /^\d+$/.test(p) && +p >= 0 && +p <= 255);
  },
  is_ipv6(s) { return /^(([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|::|[0-9a-fA-F:]+::[0-9a-fA-F:]*)$/.test(String(s || '')); },
  is_domain(s) {
    s = String(s || '').toLowerCase();
    return /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/.test(s);
  },
  is_phone_e164(s) { return /^\+[1-9]\d{1,14}$/.test(String(s || '')); },
  is_iban(s) {
    s = String(s || '').replace(/\s+/g, '').toUpperCase();
    if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(s)) return false;
    // mod 97 check
    const rearranged = s.slice(4) + s.slice(0, 4);
    const numeric = rearranged.split('').map(c => /[0-9]/.test(c) ? c : (c.charCodeAt(0) - 55).toString()).join('');
    // BigInt mod 97
    let rem = 0n;
    for (const d of numeric) rem = (rem * 10n + BigInt(d)) % 97n;
    return rem === 1n;
  },
  is_luhn(s) {
    s = String(s || '').replace(/\D/g, '');
    if (s.length < 10) return false;
    let sum = 0, dbl = false;
    for (let i = s.length - 1; i >= 0; i--) {
      let d = +s[i];
      if (dbl) { d *= 2; if (d > 9) d -= 9; }
      sum += d; dbl = !dbl;
    }
    return sum % 10 === 0;
  },
  is_jwt_shape(s) {
    const parts = String(s || '').split('.');
    return parts.length === 3 && parts.every(p => /^[A-Za-z0-9_-]+$/.test(p));
  },

  // ---------- DATETIME ----------
  parse_iso(s) {
    const d = new Date(String(s || ''));
    return isNaN(d) ? null : d.toISOString();
  },
  now_iso() { return new Date().toISOString(); },
  to_unix(s) { const d = new Date(s); return isNaN(d) ? null : Math.floor(d.getTime() / 1000); },
  from_unix(n) { return new Date(Number(n) * 1000).toISOString(); },
  days_between(a, b) {
    const da = new Date(a), db = new Date(b);
    if (isNaN(da) || isNaN(db)) return null;
    return Math.round((db - da) / 86400000);
  },
  add_days(s, n) {
    const d = new Date(s);
    if (isNaN(d)) return null;
    d.setUTCDate(d.getUTCDate() + (parseInt(n) || 0));
    return d.toISOString();
  },
  add_seconds(s, n) {
    const d = new Date(s);
    if (isNaN(d)) return null;
    return new Date(d.getTime() + (parseInt(n) || 0) * 1000).toISOString();
  },
  is_business_day(s) {
    const d = new Date(s);
    if (isNaN(d)) return null;
    const day = d.getUTCDay();
    return day !== 0 && day !== 6;
  },
  business_days_between(a, b) {
    const da = new Date(a), db = new Date(b);
    if (isNaN(da) || isNaN(db)) return null;
    let count = 0;
    const step = da <= db ? 1 : -1;
    const cur = new Date(da);
    while ((step > 0 && cur < db) || (step < 0 && cur > db)) {
      cur.setUTCDate(cur.getUTCDate() + step);
      const day = cur.getUTCDay();
      if (day !== 0 && day !== 6) count++;
    }
    return count;
  },
  age_years(birth_iso, as_of) {
    const b = new Date(birth_iso);
    const a = new Date(as_of || Date.now());
    if (isNaN(b) || isNaN(a)) return null;
    let age = a.getUTCFullYear() - b.getUTCFullYear();
    const m = a.getUTCMonth() - b.getUTCMonth();
    if (m < 0 || (m === 0 && a.getUTCDate() < b.getUTCDate())) age--;
    return age;
  },
  format_relative(s, now_s) {
    const d = new Date(s); if (isNaN(d)) return null;
    const n = now_s ? new Date(now_s) : new Date();
    const diff = Math.round((d - n) / 1000);
    const abs = Math.abs(diff); const past = diff < 0;
    if (abs < 60) return past ? `${abs}s ago` : `in ${abs}s`;
    if (abs < 3600) return past ? `${Math.floor(abs/60)}m ago` : `in ${Math.floor(abs/60)}m`;
    if (abs < 86400) return past ? `${Math.floor(abs/3600)}h ago` : `in ${Math.floor(abs/3600)}h`;
    return past ? `${Math.floor(abs/86400)}d ago` : `in ${Math.floor(abs/86400)}d`;
  },

  // ---------- FORMATTING ----------
  format_currency(cents, currency = 'USD') {
    const n = Number(cents || 0) / 100;
    const sym = { USD: '$', EUR: '€', GBP: '£', JPY: '¥', CAD: 'C$', AUD: 'A$', USDC: 'USDC ' }[currency] || (currency + ' ');
    return sym + n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  },
  format_number(n, decimals = 0) {
    return Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  },
  format_bytes(bytes) {
    bytes = Number(bytes || 0);
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 ** 2) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1024 ** 3) return (bytes / 1024 ** 2).toFixed(1) + ' MB';
    if (bytes < 1024 ** 4) return (bytes / 1024 ** 3).toFixed(1) + ' GB';
    return (bytes / 1024 ** 4).toFixed(1) + ' TB';
  },
  format_duration(seconds) {
    seconds = Math.floor(Number(seconds || 0));
    if (seconds < 60) return seconds + 's';
    if (seconds < 3600) return Math.floor(seconds / 60) + 'm ' + (seconds % 60) + 's';
    if (seconds < 86400) return Math.floor(seconds / 3600) + 'h ' + Math.floor((seconds % 3600) / 60) + 'm';
    return Math.floor(seconds / 86400) + 'd ' + Math.floor((seconds % 86400) / 3600) + 'h';
  },
  pluralize(n, singular, plural) {
    n = Number(n);
    return n === 1 ? singular : (plural || (singular + 's'));
  },

  // ---------- NUMERIC ----------
  round(n, decimals = 0) {
    const m = Math.pow(10, parseInt(decimals) || 0);
    return Math.round((Number(n) || 0) * m) / m;
  },
  clamp(n, min, max) { return Math.max(Number(min) || 0, Math.min(Number(max) || 0, Number(n) || 0)); },
  percent(part, whole) {
    whole = Number(whole) || 0; if (whole === 0) return 0;
    return ((Number(part) || 0) / whole) * 100;
  },
  bignum_add(a, b) { return (BigInt(String(a || '0')) + BigInt(String(b || '0'))).toString(); },
  bignum_sub(a, b) { return (BigInt(String(a || '0')) - BigInt(String(b || '0'))).toString(); },
  bignum_mul(a, b) { return (BigInt(String(a || '0')) * BigInt(String(b || '0'))).toString(); },
  bignum_div(a, b) { const bb = BigInt(String(b || '1')); return bb === 0n ? null : (BigInt(String(a || '0')) / bb).toString(); },

  // ---------- TEXT ----------
  truncate(s, max, suffix = '…') {
    s = String(s || '');
    return s.length <= max ? s : s.slice(0, Math.max(max - suffix.length, 0)) + suffix;
  },
  redact_pii(s) {
    s = String(s || '');
    // Emails
    s = s.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[EMAIL]');
    // SSN (US)
    s = s.replace(/\b\d{3}-\d{2}-\d{4}\b/g, '[SSN]');
    // Credit cards (rough — 13-19 digits with optional spaces/dashes)
    s = s.replace(/\b(?:\d[ -]?){13,19}\b/g, '[CC]');
    // Phone (E.164-ish)
    s = s.replace(/\+?[1-9]\d{1,14}/g, m => m.length >= 7 ? '[PHONE]' : m);
    return s;
  },
  extract_emails(s) {
    return Array.from(String(s || '').matchAll(/[\w.+-]+@[\w-]+\.[\w.-]+/g)).map(m => m[0]);
  },
  extract_urls(s) {
    return Array.from(String(s || '').matchAll(/https?:\/\/[^\s)]+/g)).map(m => m[0]);
  },
  extract_hashtags(s) {
    return Array.from(String(s || '').matchAll(/#[a-zA-Z0-9_]+/g)).map(m => m[0]);
  },
  extract_mentions(s) {
    return Array.from(String(s || '').matchAll(/@[a-zA-Z0-9_]+/g)).map(m => m[0]);
  },

  // ---------- COLOR ----------
  hex_to_rgb(hex) {
    const m = String(hex || '').match(/^#?([a-fA-F0-9]{6}|[a-fA-F0-9]{3})$/);
    if (!m) return null;
    let h = m[1];
    if (h.length === 3) h = h.split('').map(c => c + c).join('');
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
  },
  rgb_to_hex(r, g, b) {
    const h = n => Math.max(0, Math.min(255, parseInt(n) || 0)).toString(16).padStart(2, '0');
    return '#' + h(r) + h(g) + h(b);
  },
  color_contrast(hex_a, hex_b) {
    const lum = ({ r, g, b }) => {
      const s = [r, g, b].map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
      return 0.2126 * s[0] + 0.7152 * s[1] + 0.0722 * s[2];
    };
    const a = UTILS.hex_to_rgb(hex_a), b = UTILS.hex_to_rgb(hex_b);
    if (!a || !b) return null;
    const la = lum(a), lb = lum(b);
    const ratio = (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
    return { ratio: Math.round(ratio * 100) / 100, passes_AA: ratio >= 4.5, passes_AAA: ratio >= 7 };
  },

  // ---------- JSON ----------
  json_flatten(obj, prefix = '') {
    const out = {};
    function walk(o, p) {
      if (o == null || typeof o !== 'object') { out[p || ''] = o; return; }
      if (Array.isArray(o)) { o.forEach((v, i) => walk(v, p ? `${p}[${i}]` : `[${i}]`)); return; }
      for (const k of Object.keys(o)) walk(o[k], p ? `${p}.${k}` : k);
    }
    walk(obj, prefix);
    return out;
  },
  json_diff(a, b) {
    const fa = UTILS.json_flatten(a || {});
    const fb = UTILS.json_flatten(b || {});
    const keys = new Set([...Object.keys(fa), ...Object.keys(fb)]);
    const diffs = [];
    for (const k of keys) {
      const va = fa[k], vb = fb[k];
      if (JSON.stringify(va) !== JSON.stringify(vb)) diffs.push({ path: k, a: va, b: vb });
    }
    return { changes: diffs };
  },
  json_merge(a, b) {
    const out = JSON.parse(JSON.stringify(a || {}));
    function merge(t, s) {
      for (const k of Object.keys(s || {})) {
        if (s[k] && typeof s[k] === 'object' && !Array.isArray(s[k]) && t[k] && typeof t[k] === 'object' && !Array.isArray(t[k])) {
          merge(t[k], s[k]);
        } else t[k] = s[k];
      }
    }
    merge(out, b || {});
    return out;
  },
  json_path(obj, path) {
    // Simple dot/bracket path (no jq-style filters)
    let cur = obj;
    for (const seg of String(path || '').split(/\.|\[(\d+)\]/).filter(Boolean)) {
      if (cur == null) return null;
      cur = cur[seg];
    }
    return cur === undefined ? null : cur;
  },

  // ---------- MARKDOWN (subset) ----------
  md_to_html(md) {
    if (!md) return '';
    let html = String(md);
    // Code blocks first (so we don't process them)
    const codeBlocks = [];
    html = html.replace(/```([\s\S]*?)```/g, (_, c) => {
      codeBlocks.push(c); return ` CB${codeBlocks.length - 1} `;
    });
    // Headings
    html = html.replace(/^#{1,6}\s+(.+)$/gm, (m, t) => {
      const n = m.match(/^#+/)[0].length;
      return `<h${n}>${escapeHtml(t)}</h${n}>`;
    });
    // Bold + italic
    html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
               .replace(/\*([^*]+)\*/g, '<em>$1</em>');
    // Links
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
    // Inline code
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
    // Lists
    html = html.replace(/^- (.+)$/gm, '<li>$1</li>').replace(/(<li>.*<\/li>\s*)+/g, m => '<ul>' + m + '</ul>');
    // Paragraphs (simple)
    html = html.split(/\n\n+/).map(p => p.match(/^<(h[1-6]|ul|ol|pre)/) ? p : `<p>${p}</p>`).join('\n');
    // Restore code blocks
    html = html.replace(/ CB(\d+) /g, (_, i) => `<pre><code>${escapeHtml(codeBlocks[i])}</code></pre>`);
    return html;
  },
  md_to_text(md) {
    return String(md || '')
      .replace(/```[\s\S]*?```/g, '')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/\*([^*]+)\*/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/^#{1,6}\s+/gm, '')
      .replace(/^- /gm, '• ')
      .trim();
  },

  // ---------- QR / BARCODE (SVG) ----------
  // Tiny QR code generator (text → SVG). Single-mode byte data, fixed size.
  // For complex QR matrix generation we'd add a real lib; for now produce
  // a placeholder SVG that's visually QR-like (good for testing).
  qr_svg(text) {
    const hash = crypto.createHash('sha256').update(String(text || '')).digest();
    const size = 21; // 21x21 modules (Version 1 QR)
    const px = 8;
    const total = size * px;
    let cells = '';
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        // Three fixed finder patterns (corners), plus hash-derived data cells
        const isCorner = (x < 7 && y < 7) || (x >= size - 7 && y < 7) || (x < 7 && y >= size - 7);
        const cornerOuter = isCorner && (x === 0 || x === 6 || y === 0 || y === 6 ||
                                          x === size - 1 || x === size - 7 || y === size - 1 || y === size - 7);
        const cornerInner = isCorner && (x >= 2 && x <= 4 && y >= 2 && y <= 4) ||
                             (x >= size - 5 && x <= size - 3 && y >= 2 && y <= 4) ||
                             (x >= 2 && x <= 4 && y >= size - 5 && y <= size - 3);
        const dataBit = !isCorner && ((hash[(y * size + x) % hash.length] >> ((x + y) % 8)) & 1);
        if (cornerOuter || cornerInner || dataBit) {
          cells += `<rect x="${x * px}" y="${y * px}" width="${px}" height="${px}"/>`;
        }
      }
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${total}" height="${total}" viewBox="0 0 ${total} ${total}">
      <rect width="${total}" height="${total}" fill="#fff"/>
      <g fill="#000">${cells}</g>
    </svg>`;
  },

  // ---------- GEO ----------
  // Great-circle distance in km between two lat/lon pairs
  haversine_km(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const toRad = d => d * Math.PI / 180;
    const dLat = toRad(Number(lat2) - Number(lat1));
    const dLon = toRad(Number(lon2) - Number(lon1));
    const a = Math.sin(dLat/2)**2 +
              Math.cos(toRad(Number(lat1))) * Math.cos(toRad(Number(lat2))) * Math.sin(dLon/2)**2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  },

  // ---------- RATE / BACKOFF ----------
  exp_backoff_ms(attempt, base = 1000, max = 60000) {
    return Math.min(parseInt(max) || 60000,
                    (parseInt(base) || 1000) * Math.pow(2, Math.max(0, parseInt(attempt) || 0)));
  },
  parse_retry_after(header) {
    if (!header) return null;
    if (/^\d+$/.test(header)) return parseInt(header) * 1000;
    const d = new Date(header);
    return isNaN(d) ? null : Math.max(0, d.getTime() - Date.now());
  },

  // ---------- IDENTIFIERS ----------
  uuid_v4() { return crypto.randomUUID(); },
  // ULID-like (time-prefixed sortable id)
  ulid() {
    const ts = Date.now().toString(36).padStart(10, '0');
    const rand = crypto.randomBytes(10).toString('hex');
    return (ts + rand).slice(0, 26).toUpperCase();
  },
  nanoid(size = 21) {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
    const bytes = crypto.randomBytes(parseInt(size) || 21);
    let id = '';
    for (let i = 0; i < bytes.length; i++) id += alphabet[bytes[i] & 63];
    return id;
  },
  prefix_id(prefix = 'id', bytes = 8) {
    return String(prefix) + '_' + crypto.randomBytes(Math.max(1, Math.min(32, parseInt(bytes) || 8))).toString('hex');
  },

  // ---------- HTTP / URL ----------
  parse_url(s) {
    try {
      const u = new URL(String(s || ''));
      return {
        protocol: u.protocol, hostname: u.hostname, port: u.port || null,
        pathname: u.pathname, search: u.search,
        searchParams: Object.fromEntries(u.searchParams),
        hash: u.hash, origin: u.origin
      };
    } catch { return null; }
  },
  build_url(base, params) {
    try {
      const u = new URL(String(base || ''));
      for (const [k, v] of Object.entries(params || {})) u.searchParams.set(k, String(v));
      return u.toString();
    } catch { return null; }
  },

  // ---------- DATA TRANSFORMS ----------
  csv_parse(text) {
    text = String(text || '');
    const lines = text.split(/\r?\n/).filter(l => l.length > 0);
    if (lines.length === 0) return { headers: [], rows: [] };
    // Naive parse — handles unquoted comma-separated values
    const parseLine = (l) => {
      const out = []; let cur = ''; let inQuote = false;
      for (let i = 0; i < l.length; i++) {
        const c = l[i];
        if (c === '"' && l[i + 1] === '"') { cur += '"'; i++; }
        else if (c === '"') inQuote = !inQuote;
        else if (c === ',' && !inQuote) { out.push(cur); cur = ''; }
        else cur += c;
      }
      out.push(cur);
      return out;
    };
    const headers = parseLine(lines[0]);
    const rows = lines.slice(1).map(l => {
      const cells = parseLine(l);
      const row = {};
      headers.forEach((h, i) => row[h] = cells[i] ?? '');
      return row;
    });
    return { headers, rows };
  },
  csv_serialize(rows) {
    if (!Array.isArray(rows) || rows.length === 0) return '';
    const headers = Array.from(new Set(rows.flatMap(r => Object.keys(r || {}))));
    const esc = v => {
      const s = String(v == null ? '' : v);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    return [headers.join(','), ...rows.map(r => headers.map(h => esc(r[h])).join(','))].join('\n');
  },

  // ---------- LANGUAGE (lightweight) ----------
  detect_language(s) {
    s = String(s || '').toLowerCase();
    if (!s.trim()) return null;
    // Very rough: byte-frequency hints. Real detection: use a library.
    if (/[一-鿿]/.test(s)) return 'zh';
    if (/[぀-ゟ゠-ヿ]/.test(s)) return 'ja';
    if (/[가-힯]/.test(s)) return 'ko';
    if (/[؀-ۿ]/.test(s)) return 'ar';
    if (/[֐-׿]/.test(s)) return 'he';
    if (/[Ѐ-ӿ]/.test(s)) return 'ru';
    if (/[Ͱ-Ͽ]/.test(s)) return 'el';
    // Spanish / French / German / English: hint via common words
    const words = s.split(/\s+/);
    const lex = {
      es: ['el','la','de','que','es','en','no','con','para','por'],
      fr: ['le','la','de','et','est','un','une','dans','que','pour'],
      de: ['der','die','das','und','ist','ein','eine','von','zu','mit'],
      en: ['the','of','and','to','a','in','that','for','it','with']
    };
    const scores = Object.fromEntries(Object.keys(lex).map(l => [l, 0]));
    for (const w of words) for (const l of Object.keys(lex)) if (lex[l].includes(w)) scores[l]++;
    const top = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
    return top[1] > 0 ? top[0] : 'unknown';
  }
};

// Each util is wrapped to extract args from req.body and return JSON.
const UTIL_CATALOG = Object.keys(UTILS).sort();

function registerAgentUtilityBeltRoutes(app, pool, verifyAgentAuth, auditChain) {
  const express = require('express');

  // Specific routes BEFORE the catch-all /v1/util/:name
  // GET /v1/util/qr.svg?text=... — direct SVG response (no JSON wrapper)
  app.get('/v1/util/qr.svg', (req, res) => {
    res.set('content-type', 'image/svg+xml');
    res.set('cache-control', 'public, max-age=86400');
    res.send(UTILS.qr_svg(req.query.text || ''));
  });

  // GET /v1/util — list all utilities with brief signatures
  app.get('/v1/util', (req, res) => {
    res.set('cache-control', 'public, max-age=3600');
    res.json({
      total: UTIL_CATALOG.length,
      utilities: UTIL_CATALOG.map(name => ({
        name,
        endpoint: `POST /v1/util/${name}`,
        args: extractArgNames(UTILS[name])
      }))
    });
  });

  // POST /v1/util/:name — call any util
  app.post('/v1/util/:name', express.json({ limit: '4mb' }), async (req, res) => {
    const fn = UTILS[req.params.name];
    if (typeof fn !== 'function') {
      return res.status(404).json({ error: 'unknown_util', available: UTIL_CATALOG });
    }
    const start = process.hrtime.bigint();
    try {
      const argNames = extractArgNames(fn);
      const body = req.body || {};
      // Accept either {arg1, arg2} object OR {args: [...]} array form
      let args;
      if (Array.isArray(body.args)) args = body.args;
      else args = argNames.map(n => body[n]);
      const result = fn(...args);
      const latencyUs = Number((process.hrtime.bigint() - start) / 1000n);
      // Log non-blocking
      pool.query(
        `INSERT INTO util_call_log (log_id, util, ip_hash, latency_us) VALUES ($1,$2,$3,$4)`,
        ['ul_' + crypto.randomBytes(6).toString('hex'), req.params.name,
         crypto.createHash('sha256').update(String(req.ip || 'anon')).digest('hex').slice(0, 16),
         latencyUs]
      ).catch(() => {});
      res.json({ util: req.params.name, result, latency_us: latencyUs });
    } catch (e) {
      res.status(400).json({ util: req.params.name, error: e.message });
    }
  });

  // GET /v1/util/:name — quick GET form for read-only utils with query params
  app.get('/v1/util/:name', (req, res) => {
    const fn = UTILS[req.params.name];
    if (typeof fn !== 'function') return res.status(404).json({ error: 'unknown_util' });
    const argNames = extractArgNames(fn);
    try {
      const args = argNames.map(n => req.query[n]);
      const result = fn(...args);
      res.json({ util: req.params.name, result });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // Stats endpoint (operator-side)
  app.get('/v1/admin/util/top', async (req, res) => {
    const tok = process.env.OPERATOR_ADMIN_TOKEN || process.env.INTERNAL_API_KEY;
    if (!tok || req.headers['x-admin-token'] !== tok) return res.status(401).json({ error: 'admin_required' });
    const r = await pool.query(`
      SELECT util, COUNT(*)::int AS calls, AVG(latency_us)::int AS avg_latency_us
      FROM util_call_log WHERE called_at > NOW() - INTERVAL '24 hours'
      GROUP BY util ORDER BY calls DESC LIMIT 50
    `).catch(() => ({ rows: [] }));
    res.json({ period: '24h', top: r.rows });
  });
}

// Extract argument names from a function for the dispatcher.
// Best-effort; works for the simple arrow-functions / methods we use here.
function extractArgNames(fn) {
  const src = fn.toString().replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  // Method: name(a, b, c) {  OR  arrow: (a, b) =>  OR  function(a, b)
  const m = src.match(/(?:function[^(]*)?\(([^)]*)\)|^[^=]*=>?\s*\(([^)]*)\)|^[^(]*\(([^)]*)\)/);
  const argStr = (m && (m[1] || m[2] || m[3])) || '';
  return argStr.split(',').map(s => s.trim().split(/[\s=]/)[0]).filter(Boolean);
}

module.exports = {
  migrate, registerAgentUtilityBeltRoutes,
  UTILS, UTIL_CATALOG
};
