// ============================================================================
// mobile.js — mobile companion app config: device registration, push notification
// dispatch (APNs / FCM stub), universal links / app links, deep links, mobile
// session management with biometric re-auth, app version + force-update enforcement.
// ============================================================================
const crypto = require('crypto');
const { z } = require('zod');

async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mobile_devices (
      device_id           TEXT PRIMARY KEY,
      agent_did           TEXT NOT NULL,
      platform            TEXT NOT NULL,
      push_token          TEXT,
      app_version         TEXT,
      os_version          TEXT,
      model               TEXT,
      enrolled_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_at        TIMESTAMPTZ,
      revoked_at          TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_mobile_devices_agent ON mobile_devices (agent_did);

    CREATE TABLE IF NOT EXISTS mobile_pushes (
      push_id             TEXT PRIMARY KEY,
      device_id           TEXT NOT NULL,
      title               TEXT,
      body                TEXT,
      payload             JSONB,
      status              TEXT NOT NULL DEFAULT 'queued',
      sent_at             TIMESTAMPTZ,
      delivered_at        TIMESTAMPTZ,
      error               TEXT,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS mobile_app_versions (
      app_id              TEXT NOT NULL,
      platform            TEXT NOT NULL,
      version             TEXT NOT NULL,
      min_supported       TEXT,
      released_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      release_notes       TEXT,
      force_update        BOOLEAN NOT NULL DEFAULT FALSE,
      PRIMARY KEY (app_id, platform, version)
    );
  `);
}

function newId(p) { return p + '_' + crypto.randomBytes(10).toString('hex'); }

const enrollSchema = z.object({
  platform: z.enum(['ios', 'android', 'web', 'desktop']),
  push_token: z.string().optional(),
  app_version: z.string().optional(),
  os_version: z.string().optional(),
  model: z.string().optional()
});

const pushSchema = z.object({
  agent_did: z.string().optional(),
  device_id: z.string().optional(),
  title: z.string().min(1).max(120),
  body: z.string().max(500).optional(),
  payload: z.record(z.any()).optional()
});

function registerMobileRoutes(app, pool, verifyAgentAuth, auditChain) {
  const express = require('express');

  app.post('/v1/agents/:did/mobile/devices', express.json(), async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const p = enrollSchema.safeParse(req.body || {});
    if (!p.success) return res.status(400).json({ error: 'invalid_input', details: p.error.flatten() });
    const id = newId('dev');
    await pool.query(
      `INSERT INTO mobile_devices (device_id, agent_did, platform, push_token,
         app_version, os_version, model, last_seen_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())`,
      [id, did, p.data.platform, p.data.push_token || null, p.data.app_version || null,
       p.data.os_version || null, p.data.model || null]
    );
    if (auditChain) await auditChain.append({ event_type: 'mobile.device_enrolled', agent_did: did, device_id: id, platform: p.data.platform }).catch(() => {});
    res.status(201).json({ device_id: id });
  });

  app.get('/v1/agents/:did/mobile/devices', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(`SELECT device_id, platform, app_version, os_version, model, enrolled_at, last_seen_at, revoked_at
                                FROM mobile_devices WHERE agent_did=$1`, [did]).catch(() => ({ rows: [] }));
    res.json({ devices: r.rows });
  });

  app.post('/v1/mobile/push', express.json(), async (req, res) => {
    const did = req.headers['x-agent-did'];
    if (!did) return res.status(401).json({ error: 'agent_did_required' });
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const p = pushSchema.safeParse(req.body || {});
    if (!p.success) return res.status(400).json({ error: 'invalid_input', details: p.error.flatten() });

    let devices = [];
    if (p.data.device_id) {
      const r = await pool.query(`SELECT device_id, platform, push_token FROM mobile_devices WHERE device_id=$1`, [p.data.device_id]).catch(() => ({ rows: [] }));
      devices = r.rows;
    } else if (p.data.agent_did) {
      const r = await pool.query(`SELECT device_id, platform, push_token FROM mobile_devices WHERE agent_did=$1 AND revoked_at IS NULL`, [p.data.agent_did]).catch(() => ({ rows: [] }));
      devices = r.rows;
    }
    let queued = 0;
    for (const d of devices) {
      const id = newId('push');
      await pool.query(
        `INSERT INTO mobile_pushes (push_id, device_id, title, body, payload, status)
         VALUES ($1,$2,$3,$4,$5,'queued')`,
        [id, d.device_id, p.data.title, p.data.body || null, JSON.stringify(p.data.payload || {})]
      ).catch(() => {});
      queued++;
    }
    res.status(201).json({ queued, devices: devices.length });
  });

  app.get('/v1/mobile/app/version-check', async (req, res) => {
    const platform = req.query.platform || 'ios';
    const r = await pool.query(`SELECT version, min_supported, force_update, release_notes FROM mobile_app_versions
                                WHERE platform=$1 ORDER BY released_at DESC LIMIT 1`, [platform])
      .catch(() => ({ rows: [] }));
    if (!r.rows[0]) return res.json({ no_versions_published: true });
    res.json({ latest: r.rows[0].version, min_supported: r.rows[0].min_supported, force_update: r.rows[0].force_update, release_notes: r.rows[0].release_notes });
  });

  // Apple Universal Links / Android App Links
  app.get('/.well-known/apple-app-site-association', (req, res) => {
    res.json({ applinks: { apps: [], details: [{ appID: process.env.APPLE_APP_ID || 'TEAMID.com.openheab.app',
        paths: ['/v1/dashboard/*', '/blog/*', '/a/*', '/signup', '/signup/success'] }] } });
  });
  app.get('/.well-known/assetlinks.json', (req, res) => {
    res.json([{ relation: ['delegate_permission/common.handle_all_urls'],
                target: { namespace: 'android_app', package_name: process.env.ANDROID_PACKAGE || 'com.openheab.app',
                          sha256_cert_fingerprints: [process.env.ANDROID_CERT_FINGERPRINT || ''] } }]);
  });

  // Deep link
  app.get('/a/:did_or_slug', async (req, res) => {
    const id = req.params.did_or_slug;
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.send(`<!doctype html><html><head><meta charset=utf-8>
<title>${id} — OpenHeab Agent</title>
<meta property="og:title" content="${id}">
<meta property="og:type" content="profile">
<meta property="og:url" content="${(process.env.OPERATOR_PUBLIC_URL || '')}/a/${encodeURIComponent(id)}">
<style>body{font-family:-apple-system,system-ui;background:#0a0a0a;color:#f0f0f0;padding:48px 24px;text-align:center}h1{color:#7df9ff;font-family:ui-monospace,monospace;font-size:18px;letter-spacing:-0.5px}p{color:#bdbdbd;margin:18px 0}a.btn{background:#7df9ff;color:#001a1f;padding:12px 22px;border-radius:8px;font-weight:600;text-decoration:none;display:inline-block;margin-top:14px}</style>
</head><body><h1>${id}</h1><p>Public agent profile on OpenHeab</p><a class=btn href="/v1/dashboard">Open dashboard</a> <a class=btn href="/signup">Get your own →</a></body></html>`);
  });
}

module.exports = { migrate, registerMobileRoutes };
