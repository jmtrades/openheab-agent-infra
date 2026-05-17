// ============================================================================
// OpenHeab RBAC — Fine-grained role-based access control.
// Supports hierarchical permission strings (wildcards: 'wallet.*'), per-org
// roles, scoped assignments, expiring grants, and an audit log.
// ============================================================================
const cryptoLib = require('crypto');
const express = require('express');
const { z } = require('zod');

const SCOPE_KINDS = ['org', 'agent', 'extension', 'api', 'wildcard'];

function genId(prefix) { return `${prefix}_${cryptoLib.randomBytes(12).toString('hex')}`; }

// ----------------------------------------------------------------------------
// Migration
// ----------------------------------------------------------------------------
async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS rbac_roles (
      role_id      TEXT PRIMARY KEY,
      org_id       TEXT NOT NULL,
      name         TEXT NOT NULL,
      description  TEXT,
      permissions  TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
      is_system    BOOLEAN NOT NULL DEFAULT FALSE,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_rbac_roles_org_name ON rbac_roles (org_id, name);

    CREATE TABLE IF NOT EXISTS rbac_assignments (
      assignment_id    TEXT PRIMARY KEY,
      org_id           TEXT NOT NULL,
      role_id          TEXT NOT NULL,
      agent_did        TEXT NOT NULL,
      scope_kind       TEXT NOT NULL DEFAULT 'org',
      scope_id         TEXT,
      granted_by_did   TEXT,
      granted_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at       TIMESTAMPTZ,
      revoked_at       TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_rbac_assignments_did ON rbac_assignments (agent_did, org_id);
    CREATE INDEX IF NOT EXISTS idx_rbac_assignments_role ON rbac_assignments (role_id);

    CREATE TABLE IF NOT EXISTS rbac_audit (
      event_id          TEXT PRIMARY KEY,
      org_id            TEXT,
      agent_did         TEXT,
      action            TEXT NOT NULL,
      role_id           TEXT,
      scope_kind        TEXT,
      scope_id          TEXT,
      permission        TEXT,
      performed_by_did  TEXT,
      occurred_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_rbac_audit_org ON rbac_audit (org_id, occurred_at DESC);
    CREATE INDEX IF NOT EXISTS idx_rbac_audit_did ON rbac_audit (agent_did, occurred_at DESC);

    CREATE TABLE IF NOT EXISTS rbac_permission_templates (
      template_id  TEXT PRIMARY KEY,
      name         TEXT UNIQUE NOT NULL,
      permissions  TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
      description  TEXT,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `).catch(() => {});

  // Seed permission templates idempotently
  const templates = [
    { name: 'finance_only',     description: 'Finance team — wallet, billing, payouts',
      permissions: ['wallet.*', 'billing.*', 'payouts.*', 'invoicing.*', 'commerce.*.read'] },
    { name: 'read_only',        description: 'Read-only across all primitives',
      permissions: ['*.read'] },
    { name: 'developer',        description: 'Developer — inference, sandbox, deployment, tools',
      permissions: ['inference.*', 'sandbox.*', 'deployment.*', 'tools.*', 'github.*', 'ci_cd.*'] },
    { name: 'support',          description: 'Customer support — read profiles, tickets',
      permissions: ['support.*', 'crm.read', 'tickets.*', 'inbox.read'] },
    { name: 'security_officer', description: 'Security/compliance officer',
      permissions: ['kyc.*', 'aml.*', 'audit.read', 'sanctions.read', 'compliance.*', 'tripwires.*'] }
  ];
  for (const t of templates) {
    await pool.query(
      `INSERT INTO rbac_permission_templates (template_id, name, permissions, description)
       VALUES ($1, $2, $3::text[], $4)
       ON CONFLICT (name) DO UPDATE SET permissions = EXCLUDED.permissions,
                                        description  = EXCLUDED.description`,
      [genId('tpl'), t.name, t.permissions, t.description]
    ).catch(() => {});
  }
}

// ----------------------------------------------------------------------------
// Permission matching — wildcard tree using '.' separator and '*'
// 'wallet.*' matches 'wallet.transfer' and 'wallet.transfer.create'
// '*' alone matches everything
// '*.read' matches any permission ending in '.read' at any depth (single segment)
// ----------------------------------------------------------------------------
function permissionMatches(granted, required) {
  if (granted === '*' || granted === required) return true;
  const gParts = granted.split('.');
  const rParts = required.split('.');
  // Exact wildcard suffix: 'wallet.*' matches anything under wallet
  if (gParts[gParts.length - 1] === '*') {
    const prefix = gParts.slice(0, -1);
    if (rParts.length < prefix.length) return false;
    for (let i = 0; i < prefix.length; i++) {
      if (prefix[i] !== '*' && prefix[i] !== rParts[i]) return false;
    }
    return true;
  }
  // Segment-by-segment match with single-segment '*'
  if (gParts.length !== rParts.length) return false;
  for (let i = 0; i < gParts.length; i++) {
    if (gParts[i] !== '*' && gParts[i] !== rParts[i]) return false;
  }
  return true;
}

function permissionsContain(grantedList, required) {
  if (!Array.isArray(grantedList) || grantedList.length === 0) return false;
  for (const g of grantedList) {
    if (permissionMatches(g, required)) return true;
  }
  return false;
}

// ----------------------------------------------------------------------------
// System role seeding (per-org, on first interaction)
// ----------------------------------------------------------------------------
const SYSTEM_ROLES = [
  { name: 'owner',      description: 'Full ownership of the org',
    permissions: ['*'] },
  { name: 'admin',      description: 'Administrator — all except billing.delete',
    permissions: ['identity.*', 'org.*', 'rbac.*', 'wallet.*', 'kyc.*', 'aml.*',
                  'inference.*', 'sandbox.*', 'tools.*', 'extensions.*',
                  'inbox.*', 'audit.read', 'billing.read', 'billing.write', 'billing.update',
                  'payouts.*', 'invoicing.*', 'compliance.*', 'sso.*'] },
  { name: 'developer',  description: 'Developer access',
    permissions: ['inference.*', 'sandbox.*', 'deployment.*', 'tools.*',
                  'github.*', 'ci_cd.*', 'monitoring.*', 'logs.read'] },
  { name: 'finance',    description: 'Finance team',
    permissions: ['wallet.*', 'billing.*', 'payouts.*', 'invoicing.*',
                  'tax.*', 'audit.read'] },
  { name: 'compliance', description: 'Compliance/security officer',
    permissions: ['kyc.*', 'aml.*', 'audit.read', 'sanctions.read',
                  'compliance.*', 'tripwires.*', 'security.*'] },
  { name: 'viewer',     description: 'Read-only',
    permissions: ['*.read'] }
];

async function ensureSystemRoles(pool, orgId) {
  if (!orgId) return;
  for (const r of SYSTEM_ROLES) {
    const roleId = 'role_sys_' + cryptoLib.createHash('sha256')
      .update(`${orgId}:${r.name}`).digest('hex').slice(0, 20);
    await pool.query(
      `INSERT INTO rbac_roles (role_id, org_id, name, description, permissions, is_system)
       VALUES ($1, $2, $3, $4, $5::text[], TRUE)
       ON CONFLICT (org_id, name) DO NOTHING`,
      [roleId, orgId, r.name, r.description, r.permissions]
    ).catch(() => {});
  }
}

// ----------------------------------------------------------------------------
// Effective permissions for an agent (across all roles, all orgs or one)
// ----------------------------------------------------------------------------
async function getEffectivePermissions(pool, agentDid, orgId) {
  await ensureSystemRoles(pool, orgId).catch(() => {});
  const params = [agentDid];
  let sql = `
    SELECT a.org_id, a.scope_kind, a.scope_id, r.name AS role_name, r.permissions
      FROM rbac_assignments a
      JOIN rbac_roles r ON r.role_id = a.role_id
     WHERE a.agent_did = $1
       AND a.revoked_at IS NULL
       AND (a.expires_at IS NULL OR a.expires_at > NOW())`;
  if (orgId) { sql += ` AND a.org_id = $2`; params.push(orgId); }
  const r = await pool.query(sql, params).catch(() => ({ rows: [] }));
  const perms = new Set();
  const byRole = [];
  for (const row of r.rows) {
    const ps = Array.isArray(row.permissions) ? row.permissions : [];
    for (const p of ps) perms.add(p);
    byRole.push({
      org_id: row.org_id, role_name: row.role_name,
      scope_kind: row.scope_kind, scope_id: row.scope_id,
      permissions: ps
    });
  }
  return { permissions: [...perms], roles: byRole };
}

// ----------------------------------------------------------------------------
// Public helpers
// ----------------------------------------------------------------------------
async function checkPermission(pool, agentDid, permission, orgId) {
  if (!agentDid || !permission) return false;
  const { permissions } = await getEffectivePermissions(pool, agentDid, orgId);
  return permissionsContain(permissions, permission);
}

async function requirePermission(pool, agentDid, permission, orgId) {
  const allowed = await checkPermission(pool, agentDid, permission, orgId);
  if (!allowed) {
    const err = new Error(`permission_denied:${permission}`);
    err.code = 'PERMISSION_DENIED';
    err.status = 403;
    throw err;
  }
  return true;
}

async function logAudit(pool, evt) {
  await pool.query(
    `INSERT INTO rbac_audit
     (event_id, org_id, agent_did, action, role_id, scope_kind, scope_id, permission, performed_by_did)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [genId('rbev'), evt.org_id || null, evt.agent_did || null, evt.action,
     evt.role_id || null, evt.scope_kind || null, evt.scope_id || null,
     evt.permission || null, evt.performed_by_did || null]
  ).catch(() => {});
}

async function isOrgAdmin(pool, orgId, agentDid) {
  if (!orgId || !agentDid) return false;
  // Check via system roles — owner/admin
  const r = await pool.query(`
    SELECT r.name
      FROM rbac_assignments a
      JOIN rbac_roles r ON r.role_id = a.role_id
     WHERE a.agent_did=$1 AND a.org_id=$2
       AND a.revoked_at IS NULL
       AND (a.expires_at IS NULL OR a.expires_at > NOW())
       AND r.name IN ('owner','admin')
     LIMIT 1
  `, [agentDid, orgId]).catch(() => ({ rows: [] }));
  if (r.rows.length) return true;
  // Fallback: check orgs/org_members tables (org primitive may exist)
  const orgRow = await pool.query(`
    SELECT 1 FROM (
      SELECT 1 FROM org_members WHERE org_id=$1 AND agent_did=$2 AND role IN ('owner','admin')
      UNION ALL SELECT 1 FROM orgs WHERE org_id=$1 AND owner_did=$2
    ) t LIMIT 1
  `, [orgId, agentDid]).catch(() => ({ rows: [] }));
  return orgRow.rows.length > 0;
}

// ----------------------------------------------------------------------------
// Routes
// ----------------------------------------------------------------------------
function registerRbacRoutes(app, pool, verifyAgentAuth, auditChain) {

  // POST /v1/orgs/:id/rbac/roles
  const RoleSchema = z.object({
    name: z.string().min(1).max(80),
    description: z.string().max(500).optional(),
    permissions: z.array(z.string().min(1).max(120)).max(500).optional()
  });
  app.post('/v1/orgs/:id/rbac/roles', express.json(), async (req, res) => {
    try {
      const orgId = req.params.id;
      const did = req.headers['x-agent-did'];
      if (!did) return res.status(401).json({ error: 'missing_agent_did' });
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      await ensureSystemRoles(pool, orgId);
      if (!(await isOrgAdmin(pool, orgId, did))) {
        return res.status(403).json({ error: 'requires_org_admin' });
      }
      const parse = RoleSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;
      const roleId = genId('role');
      try {
        await pool.query(
          `INSERT INTO rbac_roles (role_id, org_id, name, description, permissions, is_system)
           VALUES ($1, $2, $3, $4, $5::text[], FALSE)`,
          [roleId, orgId, d.name, d.description || null, d.permissions || []]
        );
      } catch (e) {
        if (/duplicate|unique/i.test(e.message)) return res.status(409).json({ error: 'role_name_exists' });
        throw e;
      }
      await logAudit(pool, { org_id: orgId, action: 'granted', role_id: roleId,
        performed_by_did: did });
      await auditChain.append({
        event_type: 'rbac.role_created', org_id: orgId, role_id: roleId,
        name: d.name, performed_by: did, timestamp: new Date().toISOString()
      });
      return res.status(201).json({
        role_id: roleId, org_id: orgId, name: d.name,
        description: d.description || null, permissions: d.permissions || [],
        is_system: false
      });
    } catch (e) {
      console.error('[rbac.role_create]', e);
      return res.status(500).json({ error: e.message });
    }
  });

  // GET /v1/orgs/:id/rbac/roles
  app.get('/v1/orgs/:id/rbac/roles', async (req, res) => {
    try {
      const orgId = req.params.id;
      await ensureSystemRoles(pool, orgId).catch(() => {});
      const r = await pool.query(
        `SELECT role_id, org_id, name, description, permissions, is_system, created_at
         FROM rbac_roles WHERE org_id=$1 ORDER BY is_system DESC, name ASC`,
        [orgId]
      );
      return res.json({ roles: r.rows, count: r.rows.length });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  });

  // POST /v1/orgs/:id/rbac/roles/:rid/permissions (replaces array)
  const PermissionsSchema = z.object({
    permissions: z.array(z.string().min(1).max(120)).max(500)
  });
  app.post('/v1/orgs/:id/rbac/roles/:rid/permissions', express.json(), async (req, res) => {
    try {
      const { id: orgId, rid } = req.params;
      const did = req.headers['x-agent-did'];
      if (!did) return res.status(401).json({ error: 'missing_agent_did' });
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      if (!(await isOrgAdmin(pool, orgId, did))) {
        return res.status(403).json({ error: 'requires_org_admin' });
      }
      const parse = PermissionsSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });

      const r = await pool.query(
        `UPDATE rbac_roles SET permissions = $1::text[]
         WHERE role_id=$2 AND org_id=$3
         RETURNING role_id, org_id, name, permissions, is_system`,
        [parse.data.permissions, rid, orgId]
      );
      if (!r.rows[0]) return res.status(404).json({ error: 'role_not_found' });
      if (r.rows[0].is_system && r.rows[0].name === 'owner') {
        // Revert; owner role permissions are immutable
        await pool.query(
          `UPDATE rbac_roles SET permissions = ARRAY['*'] WHERE role_id=$1`, [rid]
        );
        return res.status(403).json({ error: 'owner_role_permissions_immutable' });
      }
      await logAudit(pool, { org_id: orgId, action: 'granted', role_id: rid,
        performed_by_did: did });
      await auditChain.append({
        event_type: 'rbac.role_permissions_updated',
        org_id: orgId, role_id: rid, performed_by: did,
        permission_count: parse.data.permissions.length,
        timestamp: new Date().toISOString()
      });
      return res.json(r.rows[0]);
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  });

  // POST /v1/orgs/:id/rbac/assignments
  const AssignSchema = z.object({
    role_id: z.string(),
    agent_did: z.string(),
    scope_kind: z.enum(SCOPE_KINDS).optional(),
    scope_id: z.string().optional(),
    expires_at: z.string().datetime().optional()
  });
  app.post('/v1/orgs/:id/rbac/assignments', express.json(), async (req, res) => {
    try {
      const orgId = req.params.id;
      const did = req.headers['x-agent-did'];
      if (!did) return res.status(401).json({ error: 'missing_agent_did' });
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      if (!(await isOrgAdmin(pool, orgId, did))) {
        return res.status(403).json({ error: 'requires_org_admin' });
      }
      const parse = AssignSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;

      // Verify role exists in org
      const roleR = await pool.query(
        `SELECT role_id FROM rbac_roles WHERE role_id=$1 AND org_id=$2`,
        [d.role_id, orgId]
      );
      if (!roleR.rows[0]) return res.status(404).json({ error: 'role_not_found_in_org' });

      // Idempotency: dedupe by (role_id, agent_did, scope_kind, scope_id)
      const existing = await pool.query(`
        SELECT assignment_id FROM rbac_assignments
         WHERE org_id=$1 AND role_id=$2 AND agent_did=$3
           AND COALESCE(scope_kind,'org') = $4
           AND COALESCE(scope_id,'') = $5
           AND revoked_at IS NULL
         LIMIT 1
      `, [orgId, d.role_id, d.agent_did, d.scope_kind || 'org', d.scope_id || '']);
      if (existing.rows[0]) {
        return res.status(200).json({ assignment_id: existing.rows[0].assignment_id, deduped: true });
      }

      const aid = genId('rbas');
      await pool.query(
        `INSERT INTO rbac_assignments
         (assignment_id, org_id, role_id, agent_did, scope_kind, scope_id,
          granted_by_did, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [aid, orgId, d.role_id, d.agent_did, d.scope_kind || 'org',
         d.scope_id || null, did, d.expires_at ? new Date(d.expires_at) : null]
      );
      await logAudit(pool, { org_id: orgId, agent_did: d.agent_did, action: 'granted',
        role_id: d.role_id, scope_kind: d.scope_kind || 'org', scope_id: d.scope_id,
        performed_by_did: did });
      await auditChain.append({
        event_type: 'rbac.assignment_granted',
        assignment_id: aid, org_id: orgId, role_id: d.role_id,
        agent_did: d.agent_did, granted_by: did,
        timestamp: new Date().toISOString()
      });
      return res.status(201).json({
        assignment_id: aid, org_id: orgId, role_id: d.role_id,
        agent_did: d.agent_did, scope_kind: d.scope_kind || 'org',
        scope_id: d.scope_id || null, expires_at: d.expires_at || null
      });
    } catch (e) {
      console.error('[rbac.assign]', e);
      return res.status(500).json({ error: e.message });
    }
  });

  // DELETE /v1/orgs/:id/rbac/assignments/:aid
  app.delete('/v1/orgs/:id/rbac/assignments/:aid', async (req, res) => {
    try {
      const { id: orgId, aid } = req.params;
      const did = req.headers['x-agent-did'];
      if (!did) return res.status(401).json({ error: 'missing_agent_did' });
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      if (!(await isOrgAdmin(pool, orgId, did))) {
        return res.status(403).json({ error: 'requires_org_admin' });
      }
      const r = await pool.query(
        `UPDATE rbac_assignments SET revoked_at = NOW()
         WHERE assignment_id=$1 AND org_id=$2 AND revoked_at IS NULL
         RETURNING assignment_id, agent_did, role_id, scope_kind, scope_id`,
        [aid, orgId]
      );
      if (!r.rows[0]) return res.status(404).json({ error: 'assignment_not_found' });
      const a = r.rows[0];
      await logAudit(pool, { org_id: orgId, agent_did: a.agent_did, action: 'revoked',
        role_id: a.role_id, scope_kind: a.scope_kind, scope_id: a.scope_id,
        performed_by_did: did });
      await auditChain.append({
        event_type: 'rbac.assignment_revoked',
        assignment_id: aid, org_id: orgId, agent_did: a.agent_did,
        revoked_by: did, timestamp: new Date().toISOString()
      });
      return res.json({ assignment_id: aid, revoked: true });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  });

  // GET /v1/orgs/:id/rbac/check?agent_did=...&permission=...
  app.get('/v1/orgs/:id/rbac/check', async (req, res) => {
    try {
      const orgId = req.params.id;
      const agentDid = req.query.agent_did;
      const permission = req.query.permission;
      if (!agentDid || !permission) return res.status(400).json({ error: 'missing_agent_did_or_permission' });
      const allowed = await checkPermission(pool, agentDid, permission, orgId);
      // Audit "checked" events at info level (best-effort, no slow path on every check)
      await logAudit(pool, { org_id: orgId, agent_did: agentDid,
        action: allowed ? 'checked' : 'denied', permission });
      return res.json({ allowed, agent_did: agentDid, permission, org_id: orgId });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  });

  // GET /v1/agents/:did/rbac/permissions  (effective across all orgs)
  app.get('/v1/agents/:did/rbac/permissions', async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) {
        // Allow admin token override
        const { safeTokenCompare } = require('../safe_compare');
        if (!safeTokenCompare(req.headers['x-admin-token'], process.env.OPERATOR_ADMIN_TOKEN)) {
          return res.status(401).json({ error: auth.error });
        }
      }
      const orgId = req.query.org_id || null;
      const eff = await getEffectivePermissions(pool, did, orgId);
      return res.json({ agent_did: did, org_id: orgId, ...eff });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  });

  // GET /v1/orgs/:id/rbac/audit
  app.get('/v1/orgs/:id/rbac/audit', async (req, res) => {
    try {
      const orgId = req.params.id;
      const did = req.headers['x-agent-did'];
      if (did) {
        const auth = await verifyAgentAuth(req, did);
        if (!auth.valid) return res.status(401).json({ error: auth.error });
        if (!(await isOrgAdmin(pool, orgId, did))) {
          return res.status(403).json({ error: 'requires_org_admin' });
        }
      } else {
        const { safeTokenCompare } = require('../safe_compare');
        if (!safeTokenCompare(req.headers['x-admin-token'], process.env.OPERATOR_ADMIN_TOKEN)) return res.status(401).json({ error: 'unauthorized' });
      }
      const limit = Math.min(parseInt(req.query.limit) || 100, 1000);
      const offset = Math.max(parseInt(req.query.offset) || 0, 0);
      const r = await pool.query(`
        SELECT event_id, org_id, agent_did, action, role_id, scope_kind, scope_id,
               permission, performed_by_did, occurred_at
          FROM rbac_audit WHERE org_id=$1 ORDER BY occurred_at DESC LIMIT $2 OFFSET $3
      `, [orgId, limit, offset]);
      return res.json({ events: r.rows, count: r.rows.length, limit, offset });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  });

  // GET /v1/rbac/permission-templates (public)
  app.get('/v1/rbac/permission-templates', async (req, res) => {
    const r = await pool.query(
      `SELECT template_id, name, permissions, description, created_at
       FROM rbac_permission_templates ORDER BY name ASC`
    ).catch(() => ({ rows: [] }));
    return res.json({ templates: r.rows, count: r.rows.length });
  });
}

module.exports = {
  migrate,
  registerRbacRoutes,
  // helpers
  checkPermission,
  requirePermission,
  permissionMatches,
  permissionsContain,
  ensureSystemRoles,
  getEffectivePermissions,
  isOrgAdmin,
  SYSTEM_ROLES
};
