// ============================================================================
// OpenHeab DNS — Agents owning + managing DNS records
// Tables: dns_zones, dns_records
// Registrars: cloudflare, godaddy, namecheap (Cloudflare API integrated; others stub)
// ============================================================================
const cryptoLib = require('crypto');
const express = require('express');
const { z } = require('zod');

const REGISTRARS = ['cloudflare', 'godaddy', 'namecheap'];
const RECORD_TYPES = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'SRV', 'NS'];
const RECORD_STATUSES = ['active', 'pending', 'failed'];

const REGISTRATION_COST_CENTS = parseInt(process.env.DNS_REGISTRATION_COST_CENTS || '1200');

// ----------------------------------------------------------------------------
// Migration
// ----------------------------------------------------------------------------
async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS dns_zones (
      zone_id          TEXT PRIMARY KEY,
      owner_did        TEXT NOT NULL,
      domain           TEXT NOT NULL UNIQUE,
      registrar        TEXT NOT NULL DEFAULT 'cloudflare',
      expires_at       TIMESTAMPTZ,
      auto_renew       BOOLEAN NOT NULL DEFAULT TRUE,
      dnssec_enabled   BOOLEAN NOT NULL DEFAULT FALSE,
      nameservers      TEXT[],
      external_zone_id TEXT,
      status           TEXT NOT NULL DEFAULT 'active',
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_dns_zones_owner ON dns_zones (owner_did);

    CREATE TABLE IF NOT EXISTS dns_records (
      record_id        TEXT PRIMARY KEY,
      zone_id          TEXT NOT NULL REFERENCES dns_zones(zone_id) ON DELETE CASCADE,
      name             TEXT NOT NULL,
      type             TEXT NOT NULL,
      value            TEXT NOT NULL,
      ttl              INTEGER NOT NULL DEFAULT 3600,
      priority         INTEGER,
      status           TEXT NOT NULL DEFAULT 'pending',
      external_record_id TEXT,
      last_synced_at   TIMESTAMPTZ,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_dns_records_zone ON dns_records (zone_id);
    CREATE INDEX IF NOT EXISTS idx_dns_records_type ON dns_records (zone_id, type);
  `);
}

function genZoneId() { return 'dnz_' + cryptoLib.randomBytes(12).toString('hex'); }
function genRecordId() { return 'dnr_' + cryptoLib.randomBytes(12).toString('hex'); }

// ----------------------------------------------------------------------------
// Cloudflare API integration (fallback to stub if no token)
// ----------------------------------------------------------------------------
async function cloudflareRequest(path, opts = {}) {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!token) return null;
  try {
    const fetch = global.fetch || require('node-fetch');
    const r = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
      ...opts,
      headers: {
        'authorization': `Bearer ${token}`,
        'content-type': 'application/json',
        ...(opts.headers || {})
      }
    });
    const j = await r.json();
    return j;
  } catch (e) {
    return { success: false, error: e.message };
  }
}

async function provisionZone(domain, registrar) {
  if (registrar === 'cloudflare' && process.env.CLOUDFLARE_API_TOKEN) {
    const account = process.env.CLOUDFLARE_ACCOUNT_ID;
    const r = await cloudflareRequest('/zones', {
      method: 'POST',
      body: JSON.stringify({
        name: domain,
        account: account ? { id: account } : undefined,
        type: 'full'
      })
    });
    if (r && r.success && r.result) {
      return {
        external_zone_id: r.result.id,
        nameservers: r.result.name_servers || [],
        status: r.result.status || 'pending'
      };
    }
  }
  // Stub: synthesize nameservers
  return {
    external_zone_id: null,
    nameservers: [`ns1.${registrar}.com`, `ns2.${registrar}.com`],
    status: 'pending'
  };
}

async function provisionRecord(zone, record) {
  if (zone.registrar === 'cloudflare' && process.env.CLOUDFLARE_API_TOKEN && zone.external_zone_id) {
    const body = {
      type: record.type,
      name: record.name,
      content: record.value,
      ttl: record.ttl || 3600
    };
    if (record.priority != null && (record.type === 'MX' || record.type === 'SRV')) {
      body.priority = record.priority;
    }
    const r = await cloudflareRequest(`/zones/${zone.external_zone_id}/dns_records`, {
      method: 'POST',
      body: JSON.stringify(body)
    });
    if (r && r.success && r.result) {
      return { external_record_id: r.result.id, status: 'active' };
    }
    return { external_record_id: null, status: 'failed' };
  }
  return { external_record_id: null, status: 'active' };
}

// ----------------------------------------------------------------------------
// Routes
// ----------------------------------------------------------------------------
function registerDnsRoutes(app, pool, verifyAgentAuth, auditChain) {
  // POST /v1/agents/:did/dns/zones — register a domain
  const ZoneSchema = z.object({
    domain: z.string().min(3).max(255).regex(/^[a-z0-9.-]+\.[a-z]{2,}$/i),
    registrar: z.enum(REGISTRARS).optional().default('cloudflare'),
    auto_renew: z.boolean().optional().default(true),
    dnssec_enabled: z.boolean().optional().default(false),
    years: z.number().int().min(1).max(10).optional().default(1)
  });

  app.post('/v1/agents/:did/dns/zones', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const parse = ZoneSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;

      const zoneId = genZoneId();
      const provision = await provisionZone(d.domain.toLowerCase(), d.registrar);
      const expiresAt = new Date(Date.now() + d.years * 365 * 24 * 3600 * 1000).toISOString();

      try {
        await pool.query(
          `INSERT INTO dns_zones
           (zone_id, owner_did, domain, registrar, expires_at, auto_renew,
            dnssec_enabled, nameservers, external_zone_id, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [zoneId, did, d.domain.toLowerCase(), d.registrar, expiresAt,
           d.auto_renew, d.dnssec_enabled, provision.nameservers,
           provision.external_zone_id, provision.status]
        );
      } catch (e) {
        if (e.code === '23505') return res.status(409).json({ error: 'domain_already_registered' });
        throw e;
      }

      try {
        const cost = require('./cost');
        await cost.recordCost(pool, {
          agent_did: did,
          resource_type: 'dns_registration',
          provider: d.registrar,
          amount_cents: REGISTRATION_COST_CENTS * d.years,
          units: d.years,
          unit_type: 'year',
          tags: { domain: d.domain, zone_id: zoneId },
          reference_id: `dns:${zoneId}`
        });
      } catch {}

      await auditChain.append({
        event_type: 'dns.zone_registered',
        zone_id: zoneId, owner_did: did, domain: d.domain.toLowerCase(),
        registrar: d.registrar, expires_at: expiresAt,
        timestamp: new Date().toISOString()
      });

      return res.status(201).json({
        zone_id: zoneId, owner_did: did, domain: d.domain.toLowerCase(),
        registrar: d.registrar, expires_at: expiresAt,
        auto_renew: d.auto_renew, dnssec_enabled: d.dnssec_enabled,
        nameservers: provision.nameservers, status: provision.status,
        cost_cents: REGISTRATION_COST_CENTS * d.years
      });
    } catch (e) {
      console.error('[dns.register]', e);
      return res.status(500).json({ error: 'zone_registration_failed', message: e.message });
    }
  });

  // GET /v1/agents/:did/dns/zones
  app.get('/v1/agents/:did/dns/zones', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });

    const r = await pool.query(
      `SELECT zone_id, domain, registrar, expires_at, auto_renew, dnssec_enabled,
              nameservers, status, created_at
       FROM dns_zones WHERE owner_did = $1
       ORDER BY created_at DESC`, [did]
    ).catch(() => ({ rows: [] }));
    return res.json({ zones: r.rows, count: r.rows.length });
  });

  // GET /v1/agents/:did/dns/zones/:id
  app.get('/v1/agents/:did/dns/zones/:id', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });

    const r = await pool.query(
      `SELECT * FROM dns_zones WHERE zone_id = $1 AND owner_did = $2`,
      [req.params.id, did]
    ).catch(() => ({ rows: [] }));
    if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
    return res.json(r.rows[0]);
  });

  // POST /v1/agents/:did/dns/zones/:id/records
  const RecordSchema = z.object({
    name: z.string().min(1).max(255),
    type: z.enum(RECORD_TYPES),
    value: z.string().min(1).max(4096),
    ttl: z.number().int().min(60).max(86400).optional().default(3600),
    priority: z.number().int().min(0).max(65535).optional()
  });

  app.post('/v1/agents/:did/dns/zones/:id/records', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const parse = RecordSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;

      const zr = await pool.query(
        `SELECT * FROM dns_zones WHERE zone_id = $1 AND owner_did = $2`,
        [req.params.id, did]
      ).catch(() => ({ rows: [] }));
      if (!zr.rows[0]) return res.status(404).json({ error: 'zone_not_found' });
      const zone = zr.rows[0];

      const recordId = genRecordId();
      const prov = await provisionRecord(zone, d);

      await pool.query(
        `INSERT INTO dns_records
         (record_id, zone_id, name, type, value, ttl, priority, status,
          external_record_id, last_synced_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())`,
        [recordId, zone.zone_id, d.name, d.type, d.value, d.ttl,
         d.priority ?? null, prov.status, prov.external_record_id]
      );

      await auditChain.append({
        event_type: 'dns.record_added',
        record_id: recordId, zone_id: zone.zone_id, owner_did: did,
        name: d.name, type: d.type, value: d.value,
        timestamp: new Date().toISOString()
      });

      return res.status(201).json({
        record_id: recordId, zone_id: zone.zone_id,
        name: d.name, type: d.type, value: d.value, ttl: d.ttl,
        priority: d.priority ?? null, status: prov.status
      });
    } catch (e) {
      console.error('[dns.add_record]', e);
      return res.status(500).json({ error: 'record_add_failed', message: e.message });
    }
  });

  // PUT /v1/agents/:did/dns/zones/:id/records/:rid
  const UpdateRecordSchema = z.object({
    value: z.string().max(4096).optional(),
    ttl: z.number().int().min(60).max(86400).optional(),
    priority: z.number().int().min(0).max(65535).optional()
  });

  app.put('/v1/agents/:did/dns/zones/:id/records/:rid', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const parse = UpdateRecordSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;

      const own = await pool.query(
        `SELECT z.zone_id FROM dns_zones z
         WHERE z.zone_id = $1 AND z.owner_did = $2`,
        [req.params.id, did]
      ).catch(() => ({ rows: [] }));
      if (!own.rows[0]) return res.status(404).json({ error: 'zone_not_found' });

      const r = await pool.query(
        `UPDATE dns_records
         SET value = COALESCE($1, value),
             ttl = COALESCE($2, ttl),
             priority = COALESCE($3, priority),
             status = 'pending',
             last_synced_at = NOW()
         WHERE record_id = $4 AND zone_id = $5
         RETURNING *`,
        [d.value ?? null, d.ttl ?? null, d.priority ?? null,
         req.params.rid, req.params.id]
      ).catch(() => ({ rows: [] }));
      if (!r.rows[0]) return res.status(404).json({ error: 'record_not_found' });

      await auditChain.append({
        event_type: 'dns.record_updated',
        record_id: req.params.rid, zone_id: req.params.id, owner_did: did,
        timestamp: new Date().toISOString()
      });
      return res.json(r.rows[0]);
    } catch (e) {
      console.error('[dns.update_record]', e);
      return res.status(500).json({ error: 'record_update_failed', message: e.message });
    }
  });

  // DELETE /v1/agents/:did/dns/zones/:id/records/:rid
  app.delete('/v1/agents/:did/dns/zones/:id/records/:rid', async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const own = await pool.query(
        `SELECT zone_id FROM dns_zones WHERE zone_id = $1 AND owner_did = $2`,
        [req.params.id, did]
      ).catch(() => ({ rows: [] }));
      if (!own.rows[0]) return res.status(404).json({ error: 'zone_not_found' });

      const r = await pool.query(
        `DELETE FROM dns_records WHERE record_id = $1 AND zone_id = $2 RETURNING record_id`,
        [req.params.rid, req.params.id]
      ).catch(() => ({ rows: [] }));
      if (!r.rows[0]) return res.status(404).json({ error: 'record_not_found' });

      await auditChain.append({
        event_type: 'dns.record_deleted',
        record_id: req.params.rid, zone_id: req.params.id, owner_did: did,
        timestamp: new Date().toISOString()
      });
      return res.json({ record_id: req.params.rid, deleted: true });
    } catch (e) {
      console.error('[dns.delete_record]', e);
      return res.status(500).json({ error: 'record_delete_failed', message: e.message });
    }
  });

  // GET /v1/agents/:did/dns/zones/:id/records
  app.get('/v1/agents/:did/dns/zones/:id/records', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });

    const own = await pool.query(
      `SELECT zone_id FROM dns_zones WHERE zone_id = $1 AND owner_did = $2`,
      [req.params.id, did]
    ).catch(() => ({ rows: [] }));
    if (!own.rows[0]) return res.status(404).json({ error: 'zone_not_found' });

    const r = await pool.query(
      `SELECT record_id, zone_id, name, type, value, ttl, priority, status,
              last_synced_at, created_at
       FROM dns_records WHERE zone_id = $1 ORDER BY created_at DESC`,
      [req.params.id]
    ).catch(() => ({ rows: [] }));
    return res.json({ records: r.rows, count: r.rows.length });
  });

  // POST /v1/agents/:did/dns/check — validate propagation
  const CheckSchema = z.object({
    domain: z.string().min(3),
    type: z.enum(RECORD_TYPES).optional().default('A')
  });

  app.post('/v1/agents/:did/dns/check', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const parse = CheckSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;

      const dns = require('dns').promises;
      const resolverMap = {
        A: 'resolve4', AAAA: 'resolve6', CNAME: 'resolveCname',
        MX: 'resolveMx', TXT: 'resolveTxt', SRV: 'resolveSrv', NS: 'resolveNs'
      };
      let values = [];
      let propagated = false;
      try {
        const fn = dns[resolverMap[d.type]];
        if (fn) {
          values = await fn.call(dns, d.domain);
          propagated = Array.isArray(values) && values.length > 0;
        }
      } catch (e) {
        propagated = false;
      }

      return res.json({
        domain: d.domain, type: d.type,
        propagated, values, checked_at: new Date().toISOString()
      });
    } catch (e) {
      console.error('[dns.check]', e);
      return res.status(500).json({ error: 'check_failed', message: e.message });
    }
  });
}

module.exports = {
  migrate,
  registerDnsRoutes,
  provisionZone,
  provisionRecord,
  REGISTRARS,
  RECORD_TYPES
};
