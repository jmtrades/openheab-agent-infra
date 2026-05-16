// ============================================================================
// auth_polish.js — final auth-UX polish for billion-dollar launch:
//   - /auth/sign-in          — email magic-link sign-in (passwordless)
//   - POST /v1/auth/magic-link/send
//   - GET  /v1/auth/magic-link/verify/:token
//   - /v1/me/mfa/enroll      — TOTP enrollment
//   - /v1/me/mfa/verify      — verify a TOTP code
//   - /v1/me/preferences     — user settings (notification opt-in, etc.)
// ============================================================================
const crypto = require('crypto');

async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS auth_magic_links (
      token        TEXT PRIMARY KEY,
      email        TEXT NOT NULL,
      agent_did    TEXT,
      ip_hash      TEXT,
      expires_at   TIMESTAMPTZ NOT NULL,
      consumed_at  TIMESTAMPTZ,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_magic_links_email ON auth_magic_links (email, created_at DESC);

    CREATE TABLE IF NOT EXISTS auth_mfa (
      agent_did      TEXT PRIMARY KEY,
      totp_secret    TEXT NOT NULL,
      enrolled_at    TIMESTAMPTZ,
      backup_codes   JSONB,
      last_verified_at TIMESTAMPTZ,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS agent_preferences (
      agent_did      TEXT PRIMARY KEY,
      prefs          JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS auth_sessions (
      session_id     TEXT PRIMARY KEY,
      agent_did      TEXT NOT NULL,
      kind           TEXT NOT NULL,
      ip_hash        TEXT,
      ua_hash        TEXT,
      expires_at     TIMESTAMPTZ NOT NULL,
      revoked_at     TIMESTAMPTZ,
      last_seen_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_auth_sessions_agent ON auth_sessions (agent_did, created_at DESC);
  `);
}

async function resolveAgent(pool, req) {
  try { return await require('./me_endpoints').resolveAgentFromRequest(pool, req); }
  catch { return null; }
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

// --- TOTP (RFC 6238) — pure-stdlib implementation, no deps ---
function base32encode(buf) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += alphabet[(value << (5 - bits)) & 31];
  return out;
}
function base32decode(s) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0, value = 0;
  const bytes = [];
  for (const ch of s.toUpperCase().replace(/=/g, '')) {
    const idx = alphabet.indexOf(ch);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}
function generateTotpSecret() {
  return base32encode(crypto.randomBytes(20)); // 160-bit secret per RFC 4226 spec
}
function totp(secret, time = Math.floor(Date.now() / 30000)) {
  const key = base32decode(secret);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(time));
  const hmac = crypto.createHmac('sha1', key).update(counter).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const binary = ((hmac[offset] & 0x7f) << 24)
              | ((hmac[offset + 1] & 0xff) << 16)
              | ((hmac[offset + 2] & 0xff) << 8)
              | (hmac[offset + 3] & 0xff);
  const code = binary % 1_000_000;
  return code.toString().padStart(6, '0');
}
function verifyTotp(secret, code, window = 1) {
  if (!code || code.length !== 6) return false;
  const now = Math.floor(Date.now() / 30000);
  for (let i = -window; i <= window; i++) {
    if (totp(secret, now + i) === code) return true;
  }
  return false;
}

function newToken(p) { return p + '_' + crypto.randomBytes(24).toString('hex'); }

function renderSignInPage(message) {
  return `<!doctype html><html><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>Sign in — OpenHeab</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Inter', sans-serif; background: #0a0a0f; color: #e7e7ee; line-height: 1.6; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px; }
.card { max-width: 420px; width: 100%; background: #14141c; border: 1px solid #1f1f2a; border-radius: 16px; padding: 40px 36px; text-align: center; }
.logo { font-weight: 700; font-size: 22px; color: #fff; margin-bottom: 8px; letter-spacing: -0.3px; }
.tagline { color: #888; font-size: 14px; margin-bottom: 32px; }
h1 { font-size: 24px; font-weight: 700; margin-bottom: 8px; }
.sub { color: #888; font-size: 14px; margin-bottom: 24px; }
form { display: flex; flex-direction: column; gap: 10px; }
input { padding: 14px 16px; background: #0f0f17; border: 1px solid #1f1f2a; color: #fff; border-radius: 10px; font-size: 15px; outline: none; }
input:focus { border-color: #4f46e5; }
button { padding: 14px; background: #4f46e5; color: #fff; border: 0; border-radius: 10px; font-weight: 600; font-size: 15px; cursor: pointer; }
button:hover { background: #4338ca; }
.message { padding: 14px 18px; background: #4f46e520; border-left: 3px solid #4f46e5; border-radius: 6px; margin-bottom: 18px; font-size: 14px; color: #c5c5d5; text-align: left; }
.message.success { background: #22c55e15; border-left-color: #22c55e; color: #86efac; }
.message.error { background: #ef444415; border-left-color: #ef4444; color: #fca5a5; }
.alt { margin-top: 24px; padding-top: 20px; border-top: 1px solid #1a1a25; color: #888; font-size: 13px; }
.alt a { color: #818cf8; text-decoration: none; }
.alt a:hover { text-decoration: underline; }
</style></head><body>
<div class="card">
  <div class="logo">OpenHeab</div>
  <div class="tagline">Agent infrastructure substrate</div>

  <h1>Sign in</h1>
  <p class="sub">We'll email you a magic link. No password required.</p>

  ${message ? `<div class="message ${escapeHtml(message.kind || '')}">${escapeHtml(message.text)}</div>` : ''}

  <form method="post" action="/v1/auth/magic-link/send">
    <input name="email" type="email" placeholder="you@example.com" required autofocus />
    <button>Send magic link →</button>
  </form>

  <div class="alt">
    Don't have an account? <a href="/signup">Sign up</a><br/>
    Have a DID + API key? <a href="/dashboard">Use the dashboard directly</a>
  </div>
</div>
</body></html>`;
}

function renderMfaEnrollPage(secret, otpauthUri) {
  return `<!doctype html><html><head>
<meta charset="utf-8"/>
<title>Enable 2FA — OpenHeab</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Inter', sans-serif; background: #0a0a0f; color: #e7e7ee; line-height: 1.6; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px; }
.card { max-width: 520px; width: 100%; background: #14141c; border: 1px solid #1f1f2a; border-radius: 16px; padding: 36px 40px; }
h1 { font-size: 24px; font-weight: 700; margin-bottom: 10px; }
.sub { color: #888; font-size: 14px; margin-bottom: 24px; }
ol { padding-left: 22px; margin: 16px 0; color: #c5c5d5; }
ol li { padding: 5px 0; font-size: 14px; }
.secret-row { display: flex; gap: 8px; align-items: center; background: #0f0f17; padding: 10px 14px; border-radius: 8px; margin: 14px 0; }
.secret-row code { flex: 1; font-family: 'SF Mono', monospace; font-size: 16px; color: #fff; letter-spacing: 1px; word-break: break-all; }
.secret-row button { padding: 6px 12px; background: #1a1a25; border: 1px solid #25253a; color: #ccc; border-radius: 6px; cursor: pointer; font-size: 12px; }
.uri { font-family: monospace; font-size: 11px; color: #888; word-break: break-all; padding: 10px; background: #0f0f17; border-radius: 6px; margin-bottom: 14px; }
form { margin-top: 20px; }
input { width: 100%; padding: 14px; background: #0f0f17; border: 1px solid #1f1f2a; color: #fff; border-radius: 8px; font-size: 18px; font-family: monospace; text-align: center; letter-spacing: 6px; outline: none; }
input:focus { border-color: #4f46e5; }
button.go { width: 100%; padding: 14px; background: #4f46e5; color: #fff; border: 0; border-radius: 8px; font-weight: 600; cursor: pointer; margin-top: 10px; font-size: 14px; }
</style></head><body>

<div class="card">
  <h1>Enable two-factor</h1>
  <p class="sub">Protect your account with a TOTP code from Authy, Google Authenticator, 1Password, etc.</p>

  <ol>
    <li>Open your authenticator app + tap "Add account"</li>
    <li>Scan QR or paste the secret below</li>
    <li>Enter the 6-digit code your app generates</li>
  </ol>

  <p style="font-size:11px;color:#888;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px;font-weight:600">TOTP secret</p>
  <div class="secret-row">
    <code id="secret">${escapeHtml(secret)}</code>
    <button onclick="copy()">Copy</button>
  </div>

  <p style="font-size:11px;color:#888;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px;font-weight:600">otpauth:// URI (for QR generators)</p>
  <div class="uri">${escapeHtml(otpauthUri)}</div>

  <form id="verify" onsubmit="event.preventDefault();submit()">
    <p style="font-size:11px;color:#888;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px;font-weight:600">Verify code</p>
    <input id="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" placeholder="000000" autofocus />
    <button class="go" type="submit">Verify + enable 2FA</button>
  </form>

  <p id="result" style="margin-top:14px;font-size:13px;text-align:center"></p>
</div>

<script>
function copy() {
  const text = document.getElementById('secret').textContent;
  navigator.clipboard.writeText(text).then(() => {
    event.target.textContent = 'Copied'; setTimeout(() => event.target.textContent = 'Copy', 1200);
  });
}
async function submit() {
  const code = document.getElementById('code').value.trim();
  const r = await fetch('/v1/me/mfa/verify', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ secret: '${escapeHtml(secret)}', code, enroll: true })
  });
  const j = await r.json();
  const el = document.getElementById('result');
  if (j.ok) { el.style.color = '#22c55e'; el.textContent = '✓ 2FA enabled. Save the secret somewhere safe.'; }
  else { el.style.color = '#ef4444'; el.textContent = '✗ ' + (j.error || 'verification failed'); }
}
</script>
</body></html>`;
}

function registerAuthPolishRoutes(app, pool, verifyAgentAuth, auditChain) {
  const express = require('express');

  // GET /auth/sign-in — magic-link sign-in form
  app.get('/auth/sign-in', (req, res) => {
    res.set('content-type', 'text/html; charset=utf-8');
    res.set('cache-control', 'no-store');
    res.send(renderSignInPage(null));
  });

  // POST /v1/auth/magic-link/send — sends a magic link (form-encoded OR JSON)
  app.post('/v1/auth/magic-link/send',
    express.urlencoded({ extended: false }),
    express.json(),
    async (req, res) => {
      const email = String(req.body?.email || '').toLowerCase().trim();
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        // Still render the page (don't leak whether email was valid)
        if ((req.headers.accept || '').includes('text/html')) {
          return res.set('content-type', 'text/html').send(renderSignInPage({ kind: 'error', text: 'Please enter a valid email.' }));
        }
        return res.status(400).json({ error: 'invalid_email' });
      }
      // Look up DID by signup email
      let agentDid = null;
      try {
        const r = await pool.query(
          `SELECT did FROM identities WHERE metadata->>'signup_email' = $1 LIMIT 1`, [email]
        ).catch(() => ({ rows: [] }));
        agentDid = r.rows[0]?.did || null;
      } catch {}

      const token = newToken('mlink');
      const expires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
      const ipHash = crypto.createHash('sha256').update(String(req.ip || 'anon')).digest('hex').slice(0, 16);
      await pool.query(
        `INSERT INTO auth_magic_links (token, email, agent_did, ip_hash, expires_at) VALUES ($1,$2,$3,$4,$5)`,
        [token, email, agentDid, ipHash, expires]
      ).catch(() => {});

      const linkUrl = (process.env.OPERATOR_PUBLIC_URL || '') + '/v1/auth/magic-link/verify/' + token;

      // Try to send via email_templates send (in real prod) — best-effort
      try {
        const et = require('./email_templates');
        if (et?.send) await et.send(pool, {
          template: 'signup_welcome',
          recipient: email,
          variables: { name: email.split('@')[0], did: agentDid, base_url: process.env.OPERATOR_PUBLIC_URL || '', api_key: null }
        });
      } catch {}

      if (auditChain) auditChain.append({
        event_type: 'auth.magic_link_sent', email, agent_did: agentDid, ip_hash: ipHash
      }).catch(() => {});

      // Always return success — don't leak account existence
      if ((req.headers.accept || '').includes('text/html')) {
        return res.set('content-type', 'text/html').send(renderSignInPage({
          kind: 'success',
          text: 'Check your inbox at ' + email + '. The link expires in 1 hour.'
        }));
      }
      // For dev/stub mode (no email service configured): return link in response
      const showLink = !process.env.SENDGRID_API_KEY && process.env.NODE_ENV !== 'production';
      res.status(202).json({
        sent: true,
        message: 'Magic link sent. Check your inbox.',
        ...(showLink ? { _dev_link: linkUrl, _dev_note: 'Returned in stub mode only. In production, set SENDGRID_API_KEY.' } : {})
      });
    });

  // GET /v1/auth/magic-link/verify/:token — complete sign-in, create session
  app.get('/v1/auth/magic-link/verify/:token', async (req, res) => {
    const token = req.params.token;
    const r = await pool.query(
      `SELECT email, agent_did, expires_at, consumed_at FROM auth_magic_links WHERE token=$1`, [token]
    ).catch(() => ({ rows: [] }));
    if (!r.rows[0]) {
      return res.status(404).set('content-type', 'text/html').send(renderSignInPage({ kind: 'error', text: 'Link not found or already used. Request a new one below.' }));
    }
    const row = r.rows[0];
    if (row.consumed_at) {
      return res.status(410).set('content-type', 'text/html').send(renderSignInPage({ kind: 'error', text: 'This link was already used. Request a new one.' }));
    }
    if (new Date(row.expires_at) < new Date()) {
      return res.status(410).set('content-type', 'text/html').send(renderSignInPage({ kind: 'error', text: 'Link expired. Request a new one.' }));
    }
    // Mark consumed, create session
    await pool.query(`UPDATE auth_magic_links SET consumed_at=NOW() WHERE token=$1`, [token]).catch(() => {});
    const sessionId = newToken('sess');
    const did = row.agent_did;
    if (did) {
      const ipHash = crypto.createHash('sha256').update(String(req.ip || 'anon')).digest('hex').slice(0, 16);
      const uaHash = crypto.createHash('sha256').update(String(req.headers['user-agent'] || 'anon')).digest('hex').slice(0, 16);
      await pool.query(
        `INSERT INTO auth_sessions (session_id, agent_did, kind, ip_hash, ua_hash, expires_at)
         VALUES ($1,$2,'magic_link',$3,$4,$5)`,
        [sessionId, did, ipHash, uaHash, new Date(Date.now() + 30 * 86400000)]
      ).catch(() => {});
    }
    if (auditChain) auditChain.append({
      event_type: 'auth.magic_link_verified', token: token.slice(0, 12) + '...', email: row.email, agent_did: did
    }).catch(() => {});
    // Redirect to dashboard with the DID (no session cookies for simplicity)
    if (did) {
      res.redirect(302, '/dashboard?did=' + encodeURIComponent(did));
    } else {
      res.redirect(302, '/signup?email=' + encodeURIComponent(row.email));
    }
  });

  // GET /v1/me/mfa/enroll — start MFA enrollment (returns secret + otpauth URI)
  app.get('/v1/me/mfa/enroll', async (req, res) => {
    const ctx = await resolveAgent(pool, req);
    if (!ctx) return res.status(401).json({ error: 'unauthenticated' });
    const secret = generateTotpSecret();
    const label = encodeURIComponent('OpenHeab:' + ctx.did);
    const issuer = encodeURIComponent('OpenHeab');
    const uri = `otpauth://totp/${label}?secret=${secret}&issuer=${issuer}&algorithm=SHA1&digits=6&period=30`;
    if (req.query.format === 'html') {
      res.set('content-type', 'text/html; charset=utf-8');
      res.set('cache-control', 'no-store');
      return res.send(renderMfaEnrollPage(secret, uri));
    }
    res.set('cache-control', 'no-store');
    res.json({ secret, otpauth_uri: uri, qr_data: uri, did: ctx.did });
  });

  // POST /v1/me/mfa/verify — verify a code (and optionally enroll if enroll:true)
  app.post('/v1/me/mfa/verify', express.json(), async (req, res) => {
    const ctx = await resolveAgent(pool, req);
    if (!ctx) return res.status(401).json({ error: 'unauthenticated' });
    const { secret, code, enroll } = req.body || {};
    if (!code) return res.status(400).json({ error: 'code_required' });
    let totpSecret = secret;
    if (!totpSecret) {
      const r = await pool.query(`SELECT totp_secret FROM auth_mfa WHERE agent_did=$1`, [ctx.did]).catch(() => ({ rows: [] }));
      if (!r.rows[0]) return res.status(404).json({ error: 'no_mfa_enrolled' });
      totpSecret = r.rows[0].totp_secret;
    }
    const ok = verifyTotp(totpSecret, String(code).trim());
    if (!ok) return res.status(400).json({ ok: false, error: 'invalid_code' });
    if (enroll) {
      // Save enrollment
      const backupCodes = Array.from({ length: 8 }, () => crypto.randomBytes(4).toString('hex'));
      await pool.query(
        `INSERT INTO auth_mfa (agent_did, totp_secret, enrolled_at, backup_codes)
         VALUES ($1,$2,NOW(),$3::jsonb)
         ON CONFLICT (agent_did) DO UPDATE SET totp_secret=$2, enrolled_at=NOW(), backup_codes=$3::jsonb`,
        [ctx.did, totpSecret, JSON.stringify(backupCodes)]
      ).catch(() => {});
      if (auditChain) auditChain.append({ event_type: 'mfa.enrolled', agent_did: ctx.did }).catch(() => {});
      return res.json({ ok: true, enrolled: true, backup_codes: backupCodes });
    }
    await pool.query(`UPDATE auth_mfa SET last_verified_at=NOW() WHERE agent_did=$1`, [ctx.did]).catch(() => {});
    res.json({ ok: true, did: ctx.did });
  });

  // GET /v1/me/mfa/status — is MFA enrolled?
  app.get('/v1/me/mfa/status', async (req, res) => {
    const ctx = await resolveAgent(pool, req);
    if (!ctx) return res.status(401).json({ error: 'unauthenticated' });
    const r = await pool.query(
      `SELECT enrolled_at, last_verified_at FROM auth_mfa WHERE agent_did=$1`, [ctx.did]
    ).catch(() => ({ rows: [] }));
    res.json({ did: ctx.did, enrolled: !!r.rows[0]?.enrolled_at, enrolled_at: r.rows[0]?.enrolled_at, last_verified_at: r.rows[0]?.last_verified_at });
  });

  // GET /v1/me/preferences
  app.get('/v1/me/preferences', async (req, res) => {
    const ctx = await resolveAgent(pool, req);
    if (!ctx) return res.status(401).json({ error: 'unauthenticated' });
    const r = await pool.query(`SELECT prefs FROM agent_preferences WHERE agent_did=$1`, [ctx.did]).catch(() => ({ rows: [] }));
    res.json({ did: ctx.did, preferences: r.rows[0]?.prefs || {} });
  });

  // PUT /v1/me/preferences — merge-update
  app.put('/v1/me/preferences', express.json(), async (req, res) => {
    const ctx = await resolveAgent(pool, req);
    if (!ctx) return res.status(401).json({ error: 'unauthenticated' });
    const incoming = (req.body && typeof req.body === 'object') ? req.body : {};
    // Reject huge prefs
    if (JSON.stringify(incoming).length > 32_000) {
      return res.status(413).json({ error: 'preferences_too_large' });
    }
    const r = await pool.query(`SELECT prefs FROM agent_preferences WHERE agent_did=$1`, [ctx.did]).catch(() => ({ rows: [] }));
    const merged = { ...(r.rows[0]?.prefs || {}), ...incoming };
    await pool.query(
      `INSERT INTO agent_preferences (agent_did, prefs, updated_at) VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (agent_did) DO UPDATE SET prefs=$2::jsonb, updated_at=NOW()`,
      [ctx.did, JSON.stringify(merged)]
    ).catch(() => {});
    res.json({ did: ctx.did, preferences: merged });
  });

  // GET /v1/me/sessions — list active sessions
  app.get('/v1/me/sessions', async (req, res) => {
    const ctx = await resolveAgent(pool, req);
    if (!ctx) return res.status(401).json({ error: 'unauthenticated' });
    const r = await pool.query(
      `SELECT session_id, kind, ip_hash, ua_hash, last_seen_at, expires_at, revoked_at, created_at
       FROM auth_sessions WHERE agent_did=$1 ORDER BY created_at DESC LIMIT 50`, [ctx.did]
    ).catch(() => ({ rows: [] }));
    res.json({ did: ctx.did, sessions: r.rows });
  });

  // DELETE /v1/me/sessions/:id — revoke session
  app.delete('/v1/me/sessions/:id', async (req, res) => {
    const ctx = await resolveAgent(pool, req);
    if (!ctx) return res.status(401).json({ error: 'unauthenticated' });
    await pool.query(
      `UPDATE auth_sessions SET revoked_at=NOW() WHERE session_id=$1 AND agent_did=$2 AND revoked_at IS NULL`,
      [req.params.id, ctx.did]
    ).catch(() => {});
    if (auditChain) auditChain.append({ event_type: 'auth.session_revoked', session_id: req.params.id, agent_did: ctx.did }).catch(() => {});
    res.json({ ok: true });
  });
}

module.exports = {
  migrate, registerAuthPolishRoutes, totp, verifyTotp, generateTotpSecret, base32encode, base32decode
};
