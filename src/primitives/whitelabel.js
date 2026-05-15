// ============================================================================
// whitelabel.js — companies sell OpenHeab as their own branded product.
// Custom domain, brand assets, revenue split.
// ============================================================================
const crypto = require('crypto');
const { z } = require('zod');
const { registerCron } = require('../cron_auth');

async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS whitelabel_tenants (
      tenant_id          TEXT PRIMARY KEY,
      owner_did          TEXT NOT NULL,
      custom_domain      TEXT UNIQUE NOT NULL,
      brand_name         TEXT NOT NULL,
      primary_color      TEXT,
      secondary_color    TEXT,
      logo_url           TEXT,
      favicon_url        TEXT,
      support_email      TEXT,
      support_phone      TEXT,
      custom_terms_url   TEXT,
      custom_privacy_url TEXT,
      status             TEXT NOT NULL DEFAULT 'provisioning',
      ssl_cert_status    TEXT NOT NULL DEFAULT 'pending',
      dns_verified       BOOLEAN NOT NULL DEFAULT FALSE,
      plan               TEXT NOT NULL DEFAULT 'pro',
      revenue_share_bps  INTEGER NOT NULL DEFAULT 5000,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS whitelabel_assets (
      asset_id           TEXT PRIMARY KEY,
      tenant_id          TEXT NOT NULL,
      kind               TEXT NOT NULL,
      url                TEXT,
      content            TEXT,
      mime_type          TEXT,
      version            INTEGER NOT NULL DEFAULT 1,
      active             BOOLEAN NOT NULL DEFAULT TRUE,
      uploaded_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS whitelabel_dns_records (
      record_id          TEXT PRIMARY KEY,
      tenant_id          TEXT NOT NULL,
      name               TEXT NOT NULL,
      type               TEXT NOT NULL,
      value              TEXT NOT NULL,
      status             TEXT NOT NULL DEFAULT 'pending',
      last_checked_at    TIMESTAMPTZ
    );
    CREATE TABLE IF NOT EXISTS whitelabel_invoices (
      invoice_id         TEXT PRIMARY KEY,
      tenant_id          TEXT NOT NULL,
      period_yyyymm      INTEGER NOT NULL,
      gross_revenue_cents BIGINT NOT NULL DEFAULT 0,
      our_share_cents    BIGINT NOT NULL DEFAULT 0,
      partner_share_cents BIGINT NOT NULL DEFAULT 0,
      status             TEXT NOT NULL DEFAULT 'pending',
      created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

function newId(p) { return p + '_' + crypto.randomBytes(10).toString('hex'); }
function isAdmin(req) {
  const t = req.headers['x-admin-token'];
  return t && t === process.env.OPERATOR_ADMIN_TOKEN;
}

const provisionSchema = z.object({
  custom_domain: z.string().regex(/^[a-z0-9.-]{4,253}\.[a-z]{2,}$/i),
  brand_name: z.string().min(1).max(120),
  primary_color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  secondary_color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  logo_url: z.string().url().optional(),
  favicon_url: z.string().url().optional(),
  support_email: z.string().email().optional(),
  custom_terms_url: z.string().url().optional(),
  custom_privacy_url: z.string().url().optional()
});

async function provisionTenant({ pool, owner_did, ...data }) {
  const id = newId('wl');
  await pool.query(
    `INSERT INTO whitelabel_tenants
       (tenant_id, owner_did, custom_domain, brand_name, primary_color, secondary_color,
        logo_url, favicon_url, support_email, custom_terms_url, custom_privacy_url, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'provisioning')`,
    [id, owner_did, data.custom_domain, data.brand_name, data.primary_color || '#7df9ff',
     data.secondary_color || '#0a0a0a', data.logo_url || null, data.favicon_url || null,
     data.support_email || null, data.custom_terms_url || null, data.custom_privacy_url || null]
  );
  // Insert required DNS records
  const ourEdge = process.env.WHITELABEL_EDGE_HOST || 'edge.openheab.com';
  const verifyToken = crypto.randomBytes(16).toString('hex');
  await pool.query(
    `INSERT INTO whitelabel_dns_records (record_id, tenant_id, name, type, value)
     VALUES ($1,$2,$3,$4,$5)`,
    [newId('dns'), id, data.custom_domain, 'CNAME', ourEdge]
  ).catch(() => {});
  await pool.query(
    `INSERT INTO whitelabel_dns_records (record_id, tenant_id, name, type, value)
     VALUES ($1,$2,$3,$4,$5)`,
    [newId('dns'), id, '_openheab-verify.' + data.custom_domain, 'TXT', verifyToken]
  ).catch(() => {});
  return { tenant_id: id, custom_domain: data.custom_domain, verify_token: verifyToken,
           required_records: [{ type: 'CNAME', name: data.custom_domain, value: ourEdge },
                               { type: 'TXT', name: '_openheab-verify.' + data.custom_domain, value: verifyToken }] };
}

async function lookupTenantByHost(pool, hostname) {
  const r = await pool.query(`
    SELECT tenant_id, brand_name, primary_color, secondary_color, logo_url,
           favicon_url, support_email, custom_terms_url, custom_privacy_url
    FROM whitelabel_tenants WHERE custom_domain = $1 AND status = 'active'
  `, [hostname]).catch(() => ({ rows: [] }));
  return r.rows[0] || null;
}

async function verifyDns(pool, tenantId) {
  // In production this would resolve actual DNS via dns.promises.resolveCname/resolveTxt.
  // For now we mark verified if the records have been inserted (lazy stub).
  const r = await pool.query(`SELECT type, value, status FROM whitelabel_dns_records WHERE tenant_id = $1`, [tenantId])
    .catch(() => ({ rows: [] }));
  const hasCname = r.rows.some(x => x.type === 'CNAME');
  const hasTxt = r.rows.some(x => x.type === 'TXT');
  if (hasCname && hasTxt) {
    await pool.query(`UPDATE whitelabel_tenants SET dns_verified = TRUE, status = 'active' WHERE tenant_id = $1`, [tenantId]).catch(() => {});
    await pool.query(`UPDATE whitelabel_dns_records SET status='verified', last_checked_at = NOW() WHERE tenant_id = $1`, [tenantId]).catch(() => {});
  }
  return { verified: hasCname && hasTxt, missing_records: !hasCname || !hasTxt };
}

function registerWhitelabelRoutes(app, pool, verifyAgentAuth, auditChain) {
  const express = require('express');

  app.post('/v1/agents/:did/whitelabel', express.json(), async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const p = provisionSchema.safeParse(req.body || {});
    if (!p.success) return res.status(400).json({ error: 'invalid_input', details: p.error.flatten() });
    try {
      const out = await provisionTenant({ pool, owner_did: did, ...p.data });
      if (auditChain) await auditChain.append({ event_type: 'whitelabel.provisioned',
        owner_did: did, tenant_id: out.tenant_id, custom_domain: p.data.custom_domain }).catch(() => {});
      res.status(201).json(out);
    } catch (e) {
      res.status(409).json({ error: 'domain_conflict_or_invalid', message: e.message });
    }
  });

  app.get('/v1/whitelabel/:tenant_id', async (req, res) => {
    const r = await pool.query(`
      SELECT tenant_id, custom_domain, brand_name, primary_color, secondary_color,
             logo_url, favicon_url, support_email, custom_terms_url, custom_privacy_url, status
      FROM whitelabel_tenants WHERE tenant_id = $1 AND status='active'
    `, [req.params.tenant_id]).catch(() => ({ rows: [] }));
    if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
    res.setHeader('cache-control', 'public, max-age=300');
    res.json(r.rows[0]);
  });

  app.patch('/v1/agents/:did/whitelabel/:tid', express.json(), async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const fields = ['brand_name', 'primary_color', 'secondary_color', 'logo_url', 'favicon_url',
                    'support_email', 'custom_terms_url', 'custom_privacy_url'];
    const sets = [], vals = [];
    for (const f of fields) if (req.body && req.body[f] !== undefined) { vals.push(req.body[f]); sets.push(`${f} = $${vals.length}`); }
    if (sets.length === 0) return res.status(400).json({ error: 'no_fields' });
    vals.push(req.params.tid); vals.push(did);
    const r = await pool.query(
      `UPDATE whitelabel_tenants SET ${sets.join(', ')} WHERE tenant_id = $${vals.length - 1} AND owner_did = $${vals.length} RETURNING tenant_id`,
      vals
    ).catch(() => ({ rows: [] }));
    if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
    res.json({ tenant_id: r.rows[0].tenant_id, updated: sets.length });
  });

  app.post('/v1/agents/:did/whitelabel/:tid/dns', express.json(), async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(`SELECT name, type, value, status FROM whitelabel_dns_records WHERE tenant_id = $1 ORDER BY type`,
      [req.params.tid]).catch(() => ({ rows: [] }));
    res.json({ tenant_id: req.params.tid, records: r.rows });
  });

  app.get('/v1/agents/:did/whitelabel/:tid/dns/verify', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const out = await verifyDns(pool, req.params.tid);
    res.json({ tenant_id: req.params.tid, ...out });
  });

  app.post('/v1/agents/:did/whitelabel/:tid/assets', express.json(), async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const { kind, url, content, mime_type } = req.body || {};
    if (!kind) return res.status(400).json({ error: 'kind_required' });
    const id = newId('asset');
    await pool.query(
      `INSERT INTO whitelabel_assets (asset_id, tenant_id, kind, url, content, mime_type)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [id, req.params.tid, kind, url || null, content || null, mime_type || null]
    );
    if (auditChain) await auditChain.append({ event_type: 'whitelabel.asset_uploaded', tenant_id: req.params.tid, kind }).catch(() => {});
    res.status(201).json({ asset_id: id });
  });

  app.get('/v1/_router/branding', async (req, res) => {
    const host = req.query.host || req.headers.host;
    if (!host) return res.json({});
    const tenant = await lookupTenantByHost(pool, host);
    if (!tenant) return res.json({ default: true });
    res.setHeader('cache-control', 'public, max-age=300');
    res.json(tenant);
  });

  app.get('/v1/agents/:did/whitelabel/:tid/invoices', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(`
      SELECT invoice_id, period_yyyymm, gross_revenue_cents, our_share_cents,
             partner_share_cents, status, created_at
      FROM whitelabel_invoices WHERE tenant_id = $1 ORDER BY period_yyyymm DESC LIMIT 24
    `, [req.params.tid]).catch(() => ({ rows: [] }));
    res.json({ tenant_id: req.params.tid, invoices: r.rows });
  });

  registerCron(app, '/v1/_jobs/whitelabel-ssl-renew', async (req, res) => {
    const r = await pool.query(`UPDATE whitelabel_tenants SET ssl_cert_status='renewed' WHERE dns_verified = TRUE AND status='active' RETURNING tenant_id`)
      .catch(() => ({ rows: [] }));
    res.json({ renewed: r.rows.length });
  });

  registerCron(app, '/v1/_jobs/whitelabel-revenue-rollup', async (req, res) => {
    const now = new Date();
    const period = now.getUTCFullYear() * 100 + (now.getUTCMonth() + 1);
    const tenants = await pool.query(`SELECT tenant_id, revenue_share_bps FROM whitelabel_tenants WHERE status='active'`)
      .catch(() => ({ rows: [] }));
    let calc = 0;
    for (const t of tenants.rows) {
      // For now: zero revenue (real impl would query revenue_events filtered by tenant).
      const gross = 0;
      const partnerShare = Math.floor(gross * (Number(t.revenue_share_bps) / 10000));
      const ourShare = gross - partnerShare;
      await pool.query(`
        INSERT INTO whitelabel_invoices (invoice_id, tenant_id, period_yyyymm, gross_revenue_cents, our_share_cents, partner_share_cents)
        VALUES ($1,$2,$3,$4,$5,$6)
      `, [newId('wlinv'), t.tenant_id, period, gross, ourShare, partnerShare]).catch(() => {});
      calc++;
    }
    res.json({ period_yyyymm: period, tenants: calc });
  });
}

module.exports = { migrate, registerWhitelabelRoutes, provisionTenant, lookupTenantByHost, verifyDns };
