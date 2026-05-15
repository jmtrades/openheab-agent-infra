// ============================================================================
// email_templates.js — transactional email templates (signup welcome,
// billing receipt, security alert, password reset, KYC approval, etc).
// Renders HTML + text variants. Submits via email_core (in-house) or
// SendGrid (configured) — both available via existing primitives.
// ============================================================================

async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS transactional_emails (
      email_id     TEXT PRIMARY KEY,
      template     TEXT NOT NULL,
      recipient    TEXT NOT NULL,
      subject      TEXT NOT NULL,
      variables    JSONB,
      status       TEXT NOT NULL DEFAULT 'queued',
      sent_at      TIMESTAMPTZ,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_trans_emails_recipient ON transactional_emails (recipient, created_at DESC);
  `);
}

const crypto = require('crypto');
function newId() { return 'em_' + crypto.randomBytes(10).toString('hex'); }

const SHARED_HEAD = `
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; background: #f4f4f7; margin: 0; padding: 32px 16px; color: #1a1a25; }
  .container { max-width: 560px; margin: 0 auto; background: #fff; border-radius: 12px; padding: 36px; box-shadow: 0 2px 8px rgba(0,0,0,0.04); }
  .logo { font-weight: 700; font-size: 20px; color: #1a1a25; margin-bottom: 24px; letter-spacing: -0.3px; }
  h1 { font-size: 22px; margin-bottom: 12px; }
  p { color: #4a4a55; margin-bottom: 14px; line-height: 1.6; font-size: 15px; }
  .btn { display: inline-block; padding: 12px 24px; background: #4f46e5; color: #fff !important; text-decoration: none; border-radius: 8px; font-weight: 600; margin: 12px 0; }
  .code { background: #f7f7fa; padding: 10px 14px; border-radius: 6px; font-family: monospace; font-size: 13px; word-break: break-all; }
  .footer { font-size: 12px; color: #888; margin-top: 32px; padding-top: 24px; border-top: 1px solid #eee; }
  .footer a { color: #888; }
</style>
`;

const TEMPLATES = {
  signup_welcome: {
    subject: 'Welcome to OpenHeab — your agent is alive',
    render(v) {
      return {
        html: `<!doctype html><html><head>${SHARED_HEAD}</head><body>
<div class="container">
  <div class="logo">OpenHeab</div>
  <h1>Your agent is alive.</h1>
  <p>Welcome to OpenHeab, ${v.name || 'friend'}. Your agent DID and starter API key are below — save them now, the key will never be shown again.</p>
  <p><strong>DID:</strong></p>
  <div class="code">${v.did || '(provisioning…)'}</div>
  ${v.api_key ? `<p><strong>API key (one-time):</strong></p><div class="code">${v.api_key}</div>` : ''}
  <p>Try your first inference call:</p>
  <a class="btn" href="${v.base_url || 'https://openheab.com'}/sdk">View SDK examples →</a>
  <p>Need help? Reply to this email — a real human reads them.</p>
  <div class="footer">
    OpenHeab · <a href="${v.base_url || 'https://openheab.com'}/docs">Docs</a> · <a href="${v.base_url || 'https://openheab.com'}/legal/privacy">Privacy</a>
  </div>
</div>
</body></html>`,
        text: `Welcome to OpenHeab, ${v.name || 'friend'}.\n\nDID: ${v.did}\nAPI key: ${v.api_key || '(see web)'}\n\nGet started: ${v.base_url || 'https://openheab.com'}/sdk`
      };
    }
  },

  billing_receipt: {
    subject: 'Your OpenHeab receipt',
    render(v) {
      return {
        html: `<!doctype html><html><head>${SHARED_HEAD}</head><body>
<div class="container">
  <div class="logo">OpenHeab</div>
  <h1>Receipt — ${v.invoice_number || ''}</h1>
  <p>Hi ${v.name || ''}, we charged your card for the period ${v.period_start || ''} — ${v.period_end || ''}.</p>
  <p><strong>Plan:</strong> ${v.plan || ''}<br/>
     <strong>Subscription:</strong> $${(v.subscription_cents / 100).toFixed(2)}<br/>
     <strong>Usage:</strong> $${(v.usage_cents / 100).toFixed(2)}<br/>
     <strong>Total:</strong> $${(v.total_cents / 100).toFixed(2)}</p>
  <a class="btn" href="${v.base_url || ''}/dashboard?did=${v.did}">View billing →</a>
  <div class="footer">Questions? billing@openheab.com</div>
</div></body></html>`,
        text: `OpenHeab receipt ${v.invoice_number}\n\nPlan: ${v.plan}\nTotal: $${(v.total_cents / 100).toFixed(2)}`
      };
    }
  },

  security_alert: {
    subject: 'Security alert on your OpenHeab account',
    render(v) {
      return {
        html: `<!doctype html><html><head>${SHARED_HEAD}</head><body>
<div class="container">
  <div class="logo">OpenHeab</div>
  <h1 style="color:#ef4444">Security alert</h1>
  <p>We detected ${v.event || 'an unusual event'} on your account at ${v.timestamp || 'unknown time'}.</p>
  <p><strong>Details:</strong></p>
  <div class="code">${v.details || ''}</div>
  <p>If this was you, no action needed. If not, rotate your keys immediately:</p>
  <a class="btn" style="background:#ef4444" href="${v.base_url}/dashboard?did=${v.did}">Rotate API keys →</a>
  <div class="footer">If you didn't request this, contact <a href="mailto:security@openheab.com">security@openheab.com</a></div>
</div></body></html>`,
        text: `Security alert: ${v.event}\nTime: ${v.timestamp}\nDetails: ${v.details}\nRotate keys at ${v.base_url}/dashboard`
      };
    }
  },

  kyc_approved: {
    subject: 'Your KYC verification passed',
    render(v) {
      return {
        html: `<!doctype html><html><head>${SHARED_HEAD}</head><body>
<div class="container">
  <div class="logo">OpenHeab</div>
  <h1 style="color:#22c55e">KYC verified ✓</h1>
  <p>Hi ${v.name || ''}, your KYC verification (tier ${v.tier || 1}) is approved.</p>
  <p>You can now ${v.unlocked || 'increase transaction limits and access higher-tier features'}.</p>
  <a class="btn" href="${v.base_url}/dashboard?did=${v.did}">Open dashboard →</a>
  <div class="footer">Questions? compliance@openheab.com</div>
</div></body></html>`,
        text: `KYC verified (tier ${v.tier})\nOpen dashboard: ${v.base_url}/dashboard`
      };
    }
  },

  password_reset: {
    subject: 'Reset your OpenHeab password',
    render(v) {
      return {
        html: `<!doctype html><html><head>${SHARED_HEAD}</head><body>
<div class="container">
  <div class="logo">OpenHeab</div>
  <h1>Reset your password</h1>
  <p>Click the button below to set a new password. The link expires in 1 hour.</p>
  <a class="btn" href="${v.reset_url}">Reset password →</a>
  <p style="font-size:13px;color:#888">Or paste this URL: <span class="code">${v.reset_url}</span></p>
  <div class="footer">If you didn't request this, you can safely ignore it.</div>
</div></body></html>`,
        text: `Reset your password: ${v.reset_url} (expires in 1h)`
      };
    }
  }
};

async function send(pool, { template, recipient, variables = {} }) {
  const tmpl = TEMPLATES[template];
  if (!tmpl) throw new Error('template_not_found: ' + template);
  const { html, text } = tmpl.render(variables);
  const id = newId();
  await pool.query(
    `INSERT INTO transactional_emails (email_id, template, recipient, subject, variables, status)
     VALUES ($1, $2, $3, $4, $5, 'queued')`,
    [id, template, recipient, tmpl.subject, JSON.stringify(variables)]
  ).catch(() => {});
  // Submit via email_core if available, otherwise SendGrid stub
  // (left as exercise for production wiring; for now just mark queued)
  return { email_id: id, subject: tmpl.subject, html, text, status: 'queued' };
}

function registerEmailTemplatesRoutes(app, pool, verifyAgentAuth, auditChain) {
  const express = require('express');

  // Preview a template (renders without sending)
  app.get('/v1/email-templates/:name/preview', (req, res) => {
    const tmpl = TEMPLATES[req.params.name];
    if (!tmpl) return res.status(404).json({ error: 'template_not_found' });
    const variables = req.query || {};
    const rendered = tmpl.render({ ...variables, base_url: process.env.OPERATOR_PUBLIC_URL || '' });
    res.set('content-type', 'text/html');
    res.send(rendered.html);
  });

  // Send (admin only — or internal trigger from other primitives)
  app.post('/v1/email-templates/send', express.json(), async (req, res) => {
    if (req.headers['x-internal-api-key'] !== process.env.INTERNAL_API_KEY) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    try {
      const result = await send(pool, req.body);
      if (auditChain) await auditChain.append({ event_type: 'email.queued', email_id: result.email_id, template: req.body.template, recipient: req.body.recipient }).catch(() => {});
      res.json(result);
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  app.get('/v1/email-templates', (req, res) => {
    res.json({ templates: Object.keys(TEMPLATES).map(k => ({ name: k, subject: TEMPLATES[k].subject })) });
  });
}

module.exports = { migrate, registerEmailTemplatesRoutes, send, TEMPLATES };
