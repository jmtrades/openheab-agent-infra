// ============================================================================
// OpenHeab Hosting — Static sites + edge functions for agents
// Tables: hosting_sites, hosting_deployments, hosting_edge_functions
// Subdomain template: <name>.openheab.app
// Stores static content via storage primitive blobs.
// ============================================================================
const cryptoLib = require('crypto');
const express = require('express');
const { z } = require('zod');

const FRAMEWORKS = ['static', 'nextjs', 'astro', 'edge'];
const SITE_STATUSES = ['deploying', 'active', 'failed'];
const DEPLOY_STATUSES = ['building', 'active', 'failed', 'rolled_back'];
const RUNTIMES = ['nodejs', 'python', 'deno'];
const HOST_DOMAIN = process.env.HOSTING_DOMAIN || 'openheab.app';

// ----------------------------------------------------------------------------
// Migration
// ----------------------------------------------------------------------------
async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS hosting_sites (
      site_id          TEXT PRIMARY KEY,
      owner_did        TEXT NOT NULL,
      name             TEXT NOT NULL,
      subdomain        TEXT NOT NULL UNIQUE,
      custom_domain    TEXT,
      framework        TEXT NOT NULL DEFAULT 'static',
      status           TEXT NOT NULL DEFAULT 'deploying',
      build_command    TEXT,
      output_dir       TEXT NOT NULL DEFAULT 'public',
      framework_preset TEXT,
      env_vars         JSONB,
      active_deployment_id TEXT,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_hosting_sites_owner ON hosting_sites (owner_did);

    CREATE TABLE IF NOT EXISTS hosting_deployments (
      deployment_id    TEXT PRIMARY KEY,
      site_id          TEXT NOT NULL REFERENCES hosting_sites(site_id) ON DELETE CASCADE,
      agent_did        TEXT NOT NULL,
      commit_sha       TEXT,
      deployed_blob_id TEXT,
      build_log        TEXT,
      status           TEXT NOT NULL DEFAULT 'building',
      url              TEXT,
      deployed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_hosting_deploys_site ON hosting_deployments (site_id, deployed_at DESC);

    CREATE TABLE IF NOT EXISTS hosting_edge_functions (
      function_id      TEXT PRIMARY KEY,
      site_id          TEXT NOT NULL REFERENCES hosting_sites(site_id) ON DELETE CASCADE,
      name             TEXT NOT NULL,
      code             TEXT NOT NULL,
      runtime          TEXT NOT NULL DEFAULT 'nodejs',
      routes           TEXT[],
      env              JSONB,
      last_deployed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_hosting_fn_site ON hosting_edge_functions (site_id);
  `);
}

function genSiteId() { return 'site_' + cryptoLib.randomBytes(12).toString('hex'); }
function genDeployId() { return 'dpl_' + cryptoLib.randomBytes(12).toString('hex'); }
function genFunctionId() { return 'edg_' + cryptoLib.randomBytes(12).toString('hex'); }

function sanitizeSubdomain(name) {
  const s = String(name || '').toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '');
  return s.slice(0, 63);
}

// ----------------------------------------------------------------------------
// Routes
// ----------------------------------------------------------------------------
function registerHostingRoutes(app, pool, verifyAgentAuth, auditChain) {
  // POST /v1/agents/:did/hosting/sites — provision new site
  const SiteSchema = z.object({
    name: z.string().min(1).max(128),
    subdomain: z.string().max(63).optional(),
    custom_domain: z.string().max(255).optional(),
    framework: z.enum(FRAMEWORKS).optional().default('static'),
    build_command: z.string().max(512).optional(),
    output_dir: z.string().max(256).optional().default('public'),
    framework_preset: z.string().max(64).optional(),
    env_vars: z.record(z.string()).optional()
  });

  app.post('/v1/agents/:did/hosting/sites', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const parse = SiteSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;

      const subdomain = sanitizeSubdomain(d.subdomain || d.name);
      if (!subdomain) return res.status(400).json({ error: 'invalid_subdomain' });

      const siteId = genSiteId();
      try {
        await pool.query(
          `INSERT INTO hosting_sites
           (site_id, owner_did, name, subdomain, custom_domain, framework,
            status, build_command, output_dir, framework_preset, env_vars)
           VALUES ($1,$2,$3,$4,$5,$6,'active',$7,$8,$9,$10::jsonb)`,
          [siteId, did, d.name, subdomain, d.custom_domain || null,
           d.framework, d.build_command || null, d.output_dir || 'public',
           d.framework_preset || null,
           d.env_vars ? JSON.stringify(d.env_vars) : null]
        );
      } catch (e) {
        if (e.code === '23505') return res.status(409).json({ error: 'subdomain_taken', subdomain });
        throw e;
      }

      await auditChain.append({
        event_type: 'hosting.site_provisioned',
        site_id: siteId, owner_did: did, subdomain, framework: d.framework,
        timestamp: new Date().toISOString()
      });

      return res.status(201).json({
        site_id: siteId, owner_did: did, name: d.name,
        subdomain, url: `https://${subdomain}.${HOST_DOMAIN}`,
        custom_domain: d.custom_domain || null,
        framework: d.framework, status: 'active',
        output_dir: d.output_dir || 'public'
      });
    } catch (e) {
      console.error('[hosting.create]', e);
      return res.status(500).json({ error: 'site_create_failed', message: e.message });
    }
  });

  // GET /v1/agents/:did/hosting/sites
  app.get('/v1/agents/:did/hosting/sites', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });

    const r = await pool.query(
      `SELECT site_id, name, subdomain, custom_domain, framework, status,
              output_dir, framework_preset, active_deployment_id,
              created_at, updated_at
       FROM hosting_sites WHERE owner_did = $1 ORDER BY created_at DESC`,
      [did]
    ).catch(() => ({ rows: [] }));
    const sites = r.rows.map(s => ({ ...s, url: `https://${s.subdomain}.${HOST_DOMAIN}` }));
    return res.json({ sites, count: sites.length });
  });

  // POST /v1/agents/:did/hosting/sites/:id/deploy
  const DeploySchema = z.object({
    blob_id: z.string().min(1).optional(),
    commit_sha: z.string().max(64).optional(),
    build_log: z.string().max(65536).optional()
  });

  app.post('/v1/agents/:did/hosting/sites/:id/deploy', express.json({ limit: '1mb' }), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const parse = DeploySchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;

      const sr = await pool.query(
        `SELECT * FROM hosting_sites WHERE site_id = $1 AND owner_did = $2`,
        [req.params.id, did]
      ).catch(() => ({ rows: [] }));
      if (!sr.rows[0]) return res.status(404).json({ error: 'site_not_found' });
      const site = sr.rows[0];

      // Verify blob exists if provided
      if (d.blob_id) {
        const br = await pool.query(
          `SELECT blob_id FROM storage_blobs WHERE blob_id = $1 AND deleted_at IS NULL`,
          [d.blob_id]
        ).catch(() => ({ rows: [] }));
        if (!br.rows[0]) return res.status(400).json({ error: 'blob_not_found' });
      }

      const deploymentId = genDeployId();
      const url = `https://${site.subdomain}.${HOST_DOMAIN}`;

      await pool.query(
        `INSERT INTO hosting_deployments
         (deployment_id, site_id, agent_did, commit_sha, deployed_blob_id,
          build_log, status, url)
         VALUES ($1,$2,$3,$4,$5,$6,'active',$7)`,
        [deploymentId, site.site_id, did, d.commit_sha || null,
         d.blob_id || null, d.build_log || null, url]
      );

      await pool.query(
        `UPDATE hosting_sites
         SET active_deployment_id = $1, status = 'active', updated_at = NOW()
         WHERE site_id = $2`,
        [deploymentId, site.site_id]
      );

      await auditChain.append({
        event_type: 'hosting.deployed',
        deployment_id: deploymentId, site_id: site.site_id, agent_did: did,
        commit_sha: d.commit_sha || null, blob_id: d.blob_id || null,
        timestamp: new Date().toISOString()
      });

      return res.status(201).json({
        deployment_id: deploymentId, site_id: site.site_id,
        commit_sha: d.commit_sha || null, deployed_blob_id: d.blob_id || null,
        status: 'active', url, deployed_at: new Date().toISOString()
      });
    } catch (e) {
      console.error('[hosting.deploy]', e);
      return res.status(500).json({ error: 'deploy_failed', message: e.message });
    }
  });

  // POST /v1/agents/:did/hosting/sites/:id/rollback
  const RollbackSchema = z.object({
    deployment_id: z.string().optional()
  });

  app.post('/v1/agents/:did/hosting/sites/:id/rollback', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const parse = RollbackSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;

      const sr = await pool.query(
        `SELECT * FROM hosting_sites WHERE site_id = $1 AND owner_did = $2`,
        [req.params.id, did]
      ).catch(() => ({ rows: [] }));
      if (!sr.rows[0]) return res.status(404).json({ error: 'site_not_found' });
      const site = sr.rows[0];

      let target;
      if (d.deployment_id) {
        const tr = await pool.query(
          `SELECT * FROM hosting_deployments WHERE deployment_id = $1 AND site_id = $2`,
          [d.deployment_id, site.site_id]
        ).catch(() => ({ rows: [] }));
        target = tr.rows[0];
      } else {
        const tr = await pool.query(
          `SELECT * FROM hosting_deployments
           WHERE site_id = $1 AND deployment_id != $2 AND status = 'active'
           ORDER BY deployed_at DESC LIMIT 1`,
          [site.site_id, site.active_deployment_id || '']
        ).catch(() => ({ rows: [] }));
        target = tr.rows[0];
      }
      if (!target) return res.status(404).json({ error: 'no_previous_deployment' });

      // Mark current as rolled_back
      if (site.active_deployment_id) {
        await pool.query(
          `UPDATE hosting_deployments SET status = 'rolled_back'
           WHERE deployment_id = $1`, [site.active_deployment_id]
        ).catch(() => {});
      }
      await pool.query(
        `UPDATE hosting_sites
         SET active_deployment_id = $1, updated_at = NOW() WHERE site_id = $2`,
        [target.deployment_id, site.site_id]
      );

      await auditChain.append({
        event_type: 'hosting.rolled_back',
        site_id: site.site_id, owner_did: did,
        previous_deployment_id: site.active_deployment_id,
        deployment_id: target.deployment_id,
        timestamp: new Date().toISOString()
      });

      return res.json({
        site_id: site.site_id, active_deployment_id: target.deployment_id,
        rolled_back: true
      });
    } catch (e) {
      console.error('[hosting.rollback]', e);
      return res.status(500).json({ error: 'rollback_failed', message: e.message });
    }
  });

  // POST /v1/agents/:did/hosting/sites/:id/functions — add edge function
  const FnSchema = z.object({
    name: z.string().min(1).max(128),
    code: z.string().min(1).max(1024 * 1024),
    runtime: z.enum(RUNTIMES).optional().default('nodejs'),
    routes: z.array(z.string().max(512)).optional().default([]),
    env: z.record(z.string()).optional()
  });

  app.post('/v1/agents/:did/hosting/sites/:id/functions', express.json({ limit: '2mb' }), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const parse = FnSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;

      const sr = await pool.query(
        `SELECT site_id FROM hosting_sites WHERE site_id = $1 AND owner_did = $2`,
        [req.params.id, did]
      ).catch(() => ({ rows: [] }));
      if (!sr.rows[0]) return res.status(404).json({ error: 'site_not_found' });

      const fnId = genFunctionId();
      await pool.query(
        `INSERT INTO hosting_edge_functions
         (function_id, site_id, name, code, runtime, routes, env, last_deployed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,NOW())`,
        [fnId, req.params.id, d.name, d.code, d.runtime,
         d.routes || [], d.env ? JSON.stringify(d.env) : null]
      );

      await auditChain.append({
        event_type: 'hosting.edge_function_deployed',
        function_id: fnId, site_id: req.params.id, owner_did: did,
        name: d.name, runtime: d.runtime,
        timestamp: new Date().toISOString()
      });

      return res.status(201).json({
        function_id: fnId, site_id: req.params.id,
        name: d.name, runtime: d.runtime, routes: d.routes || [],
        last_deployed_at: new Date().toISOString()
      });
    } catch (e) {
      console.error('[hosting.fn_create]', e);
      return res.status(500).json({ error: 'function_create_failed', message: e.message });
    }
  });

  // GET /v1/agents/:did/hosting/sites/:id/deployments
  app.get('/v1/agents/:did/hosting/sites/:id/deployments', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });

    const own = await pool.query(
      `SELECT site_id FROM hosting_sites WHERE site_id = $1 AND owner_did = $2`,
      [req.params.id, did]
    ).catch(() => ({ rows: [] }));
    if (!own.rows[0]) return res.status(404).json({ error: 'site_not_found' });

    const limit = Math.min(parseInt(req.query.limit) || 50, 500);
    const r = await pool.query(
      `SELECT deployment_id, agent_did, commit_sha, deployed_blob_id,
              status, url, deployed_at
       FROM hosting_deployments WHERE site_id = $1
       ORDER BY deployed_at DESC LIMIT $2`,
      [req.params.id, limit]
    ).catch(() => ({ rows: [] }));
    return res.json({ deployments: r.rows, count: r.rows.length });
  });
}

module.exports = {
  migrate,
  registerHostingRoutes,
  FRAMEWORKS,
  SITE_STATUSES,
  DEPLOY_STATUSES,
  RUNTIMES
};
