// ============================================================================
// OpenHeab Org — Multi-agent organizations (companies, teams, DAOs)
// ----------------------------------------------------------------------------
// Without orgs, every agent is its own customer and we cannot do enterprise
// contracts, team billing, or shared seats. Every paying customer at scale
// belongs to an org. Subscriptions are billed against orgs (see subscriptions.js)
// and usage is metered per-org (see metering.js).
// ============================================================================

const express = require('express');
const cryptoLib = require('crypto');
const { z } = require('zod');

const ORG_KINDS = ['company', 'individual', 'dao', 'foundation', 'government'];
const ORG_STATUSES = ['active', 'suspended', 'cancelled'];
const MEMBER_ROLES = ['owner', 'admin', 'billing', 'member', 'viewer'];
const SEAT_KINDS = ['agent', 'human'];

const ROLE_RANK = {
  owner: 5,
  admin: 4,
  billing: 3,
  member: 2,
  viewer: 1
};

function genId(prefix) {
  return `${prefix}_${cryptoLib.randomBytes(12).toString('hex')}`;
}

function slugify(name) {
  return String(name).toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

// ----------------------------------------------------------------------------
// Migration
// ----------------------------------------------------------------------------
async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS orgs (
      org_id            TEXT PRIMARY KEY,
      name              TEXT NOT NULL,
      slug              TEXT NOT NULL UNIQUE,
      kind              TEXT NOT NULL DEFAULT 'company',
      billing_email     TEXT,
      billing_address   JSONB,
      tax_id            TEXT,
      plan              TEXT NOT NULL DEFAULT 'free',
      stripe_customer_id TEXT,
      owner_did         TEXT NOT NULL,
      status            TEXT NOT NULL DEFAULT 'active',
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      metadata          JSONB
    );
    CREATE INDEX IF NOT EXISTS idx_orgs_owner ON orgs (owner_did);
    CREATE INDEX IF NOT EXISTS idx_orgs_status ON orgs (status);
    CREATE INDEX IF NOT EXISTS idx_orgs_plan ON orgs (plan);

    CREATE TABLE IF NOT EXISTS org_members (
      org_id          TEXT NOT NULL,
      agent_did       TEXT NOT NULL,
      role            TEXT NOT NULL DEFAULT 'member',
      joined_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      invited_by_did  TEXT,
      PRIMARY KEY (org_id, agent_did)
    );
    CREATE INDEX IF NOT EXISTS idx_org_members_did ON org_members (agent_did);
    CREATE INDEX IF NOT EXISTS idx_org_members_role ON org_members (org_id, role);

    CREATE TABLE IF NOT EXISTS org_invites (
      invite_id        TEXT PRIMARY KEY,
      org_id           TEXT NOT NULL,
      email            TEXT,
      role             TEXT NOT NULL DEFAULT 'member',
      token            TEXT NOT NULL UNIQUE,
      expires_at       TIMESTAMPTZ NOT NULL,
      accepted_at      TIMESTAMPTZ,
      accepted_by_did  TEXT,
      created_by_did   TEXT,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_org_invites_org ON org_invites (org_id);
    CREATE INDEX IF NOT EXISTS idx_org_invites_email ON org_invites (email);

    CREATE TABLE IF NOT EXISTS org_seats (
      org_id           TEXT NOT NULL,
      agent_did        TEXT NOT NULL,
      seat_kind        TEXT NOT NULL DEFAULT 'agent',
      allocated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      deallocated_at   TIMESTAMPTZ,
      PRIMARY KEY (org_id, agent_did)
    );
    CREATE INDEX IF NOT EXISTS idx_org_seats_org ON org_seats (org_id);
  `).catch(() => {});
}

// ----------------------------------------------------------------------------
// Helpers (exported for use by other primitives)
// ----------------------------------------------------------------------------
async function getMemberRole(pool, orgId, did) {
  const r = await pool.query(
    `SELECT role FROM org_members WHERE org_id = $1 AND agent_did = $2`,
    [orgId, did]
  ).catch(() => ({ rows: [] }));
  return r.rows[0]?.role || null;
}

async function requireOrgRole(pool, orgId, did, minRole) {
  const role = await getMemberRole(pool, orgId, did);
  if (!role) return false;
  const myRank = ROLE_RANK[role] || 0;
  const minRank = ROLE_RANK[minRole] || 0;
  return myRank >= minRank;
}

async function countOwners(pool, orgId) {
  const r = await pool.query(
    `SELECT COUNT(*)::int AS n FROM org_members WHERE org_id = $1 AND role = 'owner'`,
    [orgId]
  ).catch(() => ({ rows: [{ n: 0 }] }));
  return parseInt(r.rows[0]?.n || 0);
}

async function ensureUniqueSlug(pool, base) {
  let slug = base || ('org-' + cryptoLib.randomBytes(4).toString('hex'));
  let attempt = 0;
  while (attempt < 10) {
    const r = await pool.query(`SELECT 1 FROM orgs WHERE slug = $1`, [slug]).catch(() => ({ rows: [] }));
    if (!r.rows[0]) return slug;
    attempt++;
    slug = `${base}-${cryptoLib.randomBytes(2).toString('hex')}`;
  }
  return `${base}-${cryptoLib.randomBytes(4).toString('hex')}`;
}

// ----------------------------------------------------------------------------
// Routes
// ----------------------------------------------------------------------------
function registerOrgRoutes(app, pool, verifyAgentAuth, auditChain) {
  // POST /v1/orgs — create
  const CreateSchema = z.object({
    name: z.string().min(1).max(200),
    slug: z.string().min(1).max(60).regex(/^[a-z0-9-]+$/).optional(),
    kind: z.enum(ORG_KINDS).optional(),
    billing_email: z.string().email().optional(),
    billing_address: z.record(z.any()).optional(),
    tax_id: z.string().max(80).optional(),
    metadata: z.record(z.any()).optional()
  });

  app.post('/v1/orgs', express.json(), async (req, res) => {
    try {
      const auth = await verifyAgentAuth(req, null);
      if (!auth.valid) return res.status(401).json({ error: auth.error || 'unauthorized' });

      const parse = CreateSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;

      const baseSlug = d.slug || slugify(d.name);
      const slug = await ensureUniqueSlug(pool, baseSlug);
      const orgId = genId('org');
      const ownerDid = auth.subject;

      await pool.query(
        `INSERT INTO orgs (org_id, name, slug, kind, billing_email, billing_address, tax_id,
                           plan, owner_did, status, metadata)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,'free',$8,'active',$9::jsonb)`,
        [orgId, d.name, slug, d.kind || 'company', d.billing_email || null,
         JSON.stringify(d.billing_address || null), d.tax_id || null, ownerDid,
         JSON.stringify(d.metadata || null)]
      );

      // Owner becomes first member with role owner
      await pool.query(
        `INSERT INTO org_members (org_id, agent_did, role, invited_by_did)
         VALUES ($1, $2, 'owner', $2)
         ON CONFLICT (org_id, agent_did) DO NOTHING`,
        [orgId, ownerDid]
      );
      await pool.query(
        `INSERT INTO org_seats (org_id, agent_did, seat_kind)
         VALUES ($1, $2, 'agent')
         ON CONFLICT (org_id, agent_did) DO NOTHING`,
        [orgId, ownerDid]
      );

      await auditChain.append({
        event_type: 'org.created', org_id: orgId, slug, kind: d.kind || 'company',
        owner_did: ownerDid, timestamp: new Date().toISOString()
      });

      return res.status(201).json({ org_id: orgId, slug, name: d.name, owner_did: ownerDid });
    } catch (e) {
      return res.status(500).json({ error: 'create_failed', message: e.message });
    }
  });

  // GET /v1/orgs/:id — must be member
  app.get('/v1/orgs/:id', async (req, res) => {
    try {
      const auth = await verifyAgentAuth(req, null);
      if (!auth.valid) return res.status(401).json({ error: auth.error || 'unauthorized' });

      const r = await pool.query(`SELECT * FROM orgs WHERE org_id = $1`, [req.params.id])
        .catch(() => ({ rows: [] }));
      if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });

      const role = await getMemberRole(pool, req.params.id, auth.subject);
      if (!role) return res.status(403).json({ error: 'not_a_member' });

      return res.json({ ...r.rows[0], viewer_role: role });
    } catch (e) {
      return res.status(500).json({ error: 'fetch_failed', message: e.message });
    }
  });

  // PATCH /v1/orgs/:id — admin/owner only
  const UpdateSchema = z.object({
    name: z.string().min(1).max(200).optional(),
    billing_email: z.string().email().optional(),
    billing_address: z.record(z.any()).optional(),
    tax_id: z.string().max(80).optional(),
    metadata: z.record(z.any()).optional()
  });

  app.patch('/v1/orgs/:id', express.json(), async (req, res) => {
    try {
      const auth = await verifyAgentAuth(req, null);
      if (!auth.valid) return res.status(401).json({ error: auth.error || 'unauthorized' });

      const allowed = await requireOrgRole(pool, req.params.id, auth.subject, 'admin');
      if (!allowed) return res.status(403).json({ error: 'admin_required' });

      const parse = UpdateSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;

      const fields = [];
      const params = [];
      let idx = 1;
      if (d.name !== undefined) { fields.push(`name = $${idx++}`); params.push(d.name); }
      if (d.billing_email !== undefined) { fields.push(`billing_email = $${idx++}`); params.push(d.billing_email); }
      if (d.billing_address !== undefined) { fields.push(`billing_address = $${idx++}::jsonb`); params.push(JSON.stringify(d.billing_address)); }
      if (d.tax_id !== undefined) { fields.push(`tax_id = $${idx++}`); params.push(d.tax_id); }
      if (d.metadata !== undefined) { fields.push(`metadata = $${idx++}::jsonb`); params.push(JSON.stringify(d.metadata)); }
      if (fields.length === 0) return res.status(400).json({ error: 'no_updates' });

      fields.push(`updated_at = NOW()`);
      params.push(req.params.id);

      const r = await pool.query(
        `UPDATE orgs SET ${fields.join(', ')} WHERE org_id = $${idx} RETURNING *`,
        params
      ).catch(() => ({ rows: [] }));
      if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });

      await auditChain.append({
        event_type: 'org.updated', org_id: req.params.id, by_did: auth.subject,
        fields: Object.keys(d), timestamp: new Date().toISOString()
      });

      return res.json(r.rows[0]);
    } catch (e) {
      return res.status(500).json({ error: 'update_failed', message: e.message });
    }
  });

  // POST /v1/orgs/:id/invites — admin/owner; returns invite link
  const InviteSchema = z.object({
    email: z.string().email().optional(),
    role: z.enum(MEMBER_ROLES).optional(),
    expires_in_days: z.number().int().min(1).max(90).optional()
  });

  app.post('/v1/orgs/:id/invites', express.json(), async (req, res) => {
    try {
      const auth = await verifyAgentAuth(req, null);
      if (!auth.valid) return res.status(401).json({ error: auth.error || 'unauthorized' });
      const allowed = await requireOrgRole(pool, req.params.id, auth.subject, 'admin');
      if (!allowed) return res.status(403).json({ error: 'admin_required' });

      const parse = InviteSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;
      const role = d.role || 'member';
      if (role === 'owner') return res.status(400).json({ error: 'cannot_invite_as_owner' });

      const inviteId = genId('inv');
      const token = cryptoLib.randomBytes(24).toString('hex');
      const days = d.expires_in_days || 14;
      const expiresAt = new Date(Date.now() + days * 86400_000);

      await pool.query(
        `INSERT INTO org_invites (invite_id, org_id, email, role, token, expires_at, created_by_did)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [inviteId, req.params.id, d.email || null, role, token, expiresAt, auth.subject]
      );

      await auditChain.append({
        event_type: 'org.invite_created', org_id: req.params.id, invite_id: inviteId,
        role, email: d.email || null, by_did: auth.subject, timestamp: new Date().toISOString()
      });

      const baseUrl = process.env.OPERATOR_PUBLIC_URL || '';
      const link = `${baseUrl}/v1/invites/${token}/accept`;
      return res.status(201).json({
        invite_id: inviteId, token, role, email: d.email || null,
        expires_at: expiresAt, invite_link: link
      });
    } catch (e) {
      return res.status(500).json({ error: 'invite_failed', message: e.message });
    }
  });

  // POST /v1/invites/:token/accept — any authenticated agent
  app.post('/v1/invites/:token/accept', express.json(), async (req, res) => {
    try {
      const auth = await verifyAgentAuth(req, null);
      if (!auth.valid) return res.status(401).json({ error: auth.error || 'unauthorized' });

      const r = await pool.query(
        `SELECT * FROM org_invites WHERE token = $1`, [req.params.token]
      ).catch(() => ({ rows: [] }));
      if (!r.rows[0]) return res.status(404).json({ error: 'invite_not_found' });
      const inv = r.rows[0];
      if (inv.accepted_at) return res.status(409).json({ error: 'invite_already_accepted' });
      if (new Date(inv.expires_at).getTime() < Date.now()) {
        return res.status(410).json({ error: 'invite_expired' });
      }

      await pool.query(
        `INSERT INTO org_members (org_id, agent_did, role, invited_by_did)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (org_id, agent_did) DO UPDATE SET role = EXCLUDED.role`,
        [inv.org_id, auth.subject, inv.role, inv.created_by_did]
      );
      await pool.query(
        `INSERT INTO org_seats (org_id, agent_did, seat_kind)
         VALUES ($1, $2, 'agent') ON CONFLICT (org_id, agent_did) DO NOTHING`,
        [inv.org_id, auth.subject]
      );
      await pool.query(
        `UPDATE org_invites SET accepted_at = NOW(), accepted_by_did = $1 WHERE invite_id = $2`,
        [auth.subject, inv.invite_id]
      );

      await auditChain.append({
        event_type: 'org.invite_accepted', org_id: inv.org_id, invite_id: inv.invite_id,
        accepted_by_did: auth.subject, role: inv.role, timestamp: new Date().toISOString()
      });

      return res.json({ org_id: inv.org_id, role: inv.role, agent_did: auth.subject });
    } catch (e) {
      return res.status(500).json({ error: 'accept_failed', message: e.message });
    }
  });

  // DELETE /v1/orgs/:id/members/:did — admin/owner; can't remove last owner
  app.delete('/v1/orgs/:id/members/:did', async (req, res) => {
    try {
      const auth = await verifyAgentAuth(req, null);
      if (!auth.valid) return res.status(401).json({ error: auth.error || 'unauthorized' });
      const allowed = await requireOrgRole(pool, req.params.id, auth.subject, 'admin');
      if (!allowed) return res.status(403).json({ error: 'admin_required' });

      const target = await pool.query(
        `SELECT role FROM org_members WHERE org_id = $1 AND agent_did = $2`,
        [req.params.id, req.params.did]
      ).catch(() => ({ rows: [] }));
      if (!target.rows[0]) return res.status(404).json({ error: 'member_not_found' });

      if (target.rows[0].role === 'owner') {
        const owners = await countOwners(pool, req.params.id);
        if (owners <= 1) return res.status(409).json({ error: 'cannot_remove_last_owner' });
      }

      await pool.query(
        `DELETE FROM org_members WHERE org_id = $1 AND agent_did = $2`,
        [req.params.id, req.params.did]
      );
      await pool.query(
        `UPDATE org_seats SET deallocated_at = NOW()
           WHERE org_id = $1 AND agent_did = $2 AND deallocated_at IS NULL`,
        [req.params.id, req.params.did]
      ).catch(() => {});

      await auditChain.append({
        event_type: 'org.member_removed', org_id: req.params.id,
        removed_did: req.params.did, by_did: auth.subject, timestamp: new Date().toISOString()
      });

      return res.json({ removed: true, agent_did: req.params.did });
    } catch (e) {
      return res.status(500).json({ error: 'remove_failed', message: e.message });
    }
  });

  // POST /v1/orgs/:id/members/:did/role — admin/owner; can't demote last owner
  const RoleSchema = z.object({ role: z.enum(MEMBER_ROLES) });

  app.post('/v1/orgs/:id/members/:did/role', express.json(), async (req, res) => {
    try {
      const auth = await verifyAgentAuth(req, null);
      if (!auth.valid) return res.status(401).json({ error: auth.error || 'unauthorized' });
      const allowed = await requireOrgRole(pool, req.params.id, auth.subject, 'admin');
      if (!allowed) return res.status(403).json({ error: 'admin_required' });

      const parse = RoleSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const newRole = parse.data.role;

      const cur = await pool.query(
        `SELECT role FROM org_members WHERE org_id = $1 AND agent_did = $2`,
        [req.params.id, req.params.did]
      ).catch(() => ({ rows: [] }));
      if (!cur.rows[0]) return res.status(404).json({ error: 'member_not_found' });

      // Can't demote last owner
      if (cur.rows[0].role === 'owner' && newRole !== 'owner') {
        const owners = await countOwners(pool, req.params.id);
        if (owners <= 1) return res.status(409).json({ error: 'cannot_demote_last_owner' });
      }

      // Only owners can promote to owner
      if (newRole === 'owner') {
        const myRole = await getMemberRole(pool, req.params.id, auth.subject);
        if (myRole !== 'owner') return res.status(403).json({ error: 'owner_required_to_promote_owner' });
      }

      await pool.query(
        `UPDATE org_members SET role = $1 WHERE org_id = $2 AND agent_did = $3`,
        [newRole, req.params.id, req.params.did]
      );

      await auditChain.append({
        event_type: 'org.member_role_changed', org_id: req.params.id,
        member_did: req.params.did, old_role: cur.rows[0].role, new_role: newRole,
        by_did: auth.subject, timestamp: new Date().toISOString()
      });

      return res.json({ org_id: req.params.id, agent_did: req.params.did, role: newRole });
    } catch (e) {
      return res.status(500).json({ error: 'role_change_failed', message: e.message });
    }
  });

  // GET /v1/orgs/:id/members
  app.get('/v1/orgs/:id/members', async (req, res) => {
    try {
      const auth = await verifyAgentAuth(req, null);
      if (!auth.valid) return res.status(401).json({ error: auth.error || 'unauthorized' });
      const role = await getMemberRole(pool, req.params.id, auth.subject);
      if (!role) return res.status(403).json({ error: 'not_a_member' });

      const r = await pool.query(
        `SELECT agent_did, role, joined_at, invited_by_did
           FROM org_members WHERE org_id = $1 ORDER BY joined_at ASC`,
        [req.params.id]
      ).catch(() => ({ rows: [] }));
      return res.json({ org_id: req.params.id, members: r.rows, count: r.rows.length });
    } catch (e) {
      return res.status(500).json({ error: 'list_failed', message: e.message });
    }
  });

  // GET /v1/agents/:did/orgs
  app.get('/v1/agents/:did/orgs', async (req, res) => {
    try {
      const auth = await verifyAgentAuth(req, req.params.did);
      if (!auth.valid) return res.status(401).json({ error: auth.error || 'unauthorized' });

      const r = await pool.query(
        `SELECT o.org_id, o.name, o.slug, o.kind, o.plan, o.status, m.role, m.joined_at
           FROM org_members m
           JOIN orgs o ON o.org_id = m.org_id
          WHERE m.agent_did = $1
          ORDER BY m.joined_at DESC`,
        [req.params.did]
      ).catch(() => ({ rows: [] }));
      return res.json({ agent_did: req.params.did, orgs: r.rows, count: r.rows.length });
    } catch (e) {
      return res.status(500).json({ error: 'list_failed', message: e.message });
    }
  });
}

module.exports = {
  migrate,
  registerOrgRoutes,
  getMemberRole,
  requireOrgRole,
  countOwners,
  ORG_KINDS,
  ORG_STATUSES,
  MEMBER_ROLES,
  SEAT_KINDS,
  ROLE_RANK
};
