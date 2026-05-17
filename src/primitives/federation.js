// ============================================================================
// federation.js — multi-org constitution federation. Constitutions inherit
// from parent constitutions. Industry-wide consortia (healthcare AI alliance,
// fintech AI consortium, defense AI coalition) publish a parent constitution;
// every member org's constitution inherits + may add (never remove) rules.
//
// Critical for the AGI economy: a regulator-approved baseline that every
// agent in a regulated industry MUST comply with, automatically.
// ============================================================================
const crypto = require('crypto');
const { z } = require('zod');

async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS federations (
      federation_id     TEXT PRIMARY KEY,
      slug              TEXT UNIQUE NOT NULL,
      name              TEXT NOT NULL,
      description       TEXT,
      governing_body    TEXT,
      parent_constitution_id TEXT,
      members           TEXT[],
      status            TEXT NOT NULL DEFAULT 'active',
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS federation_members (
      member_id         TEXT PRIMARY KEY,
      federation_id     TEXT NOT NULL,
      org_id            TEXT NOT NULL,
      joined_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      left_at           TIMESTAMPTZ,
      UNIQUE (federation_id, org_id)
    );
    CREATE TABLE IF NOT EXISTS federation_compliance_checks (
      check_id          TEXT PRIMARY KEY,
      federation_id     TEXT NOT NULL,
      org_id            TEXT NOT NULL,
      passed            BOOLEAN NOT NULL,
      rule_count        INTEGER NOT NULL,
      violations        JSONB,
      checked_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

function newId(p) { return p + '_' + crypto.randomBytes(10).toString('hex'); }
function isAdmin(req) {
  const t = req.headers['x-admin-token'];
  return require('../safe_compare').safeTokenCompare(t, process.env.OPERATOR_ADMIN_TOKEN);
}

const federationSchema = z.object({
  slug: z.string().regex(/^[a-z0-9_-]{2,80}$/),
  name: z.string().min(1).max(200),
  description: z.string().optional(),
  governing_body: z.string().optional(),
  parent_constitution_id: z.string().optional()
});

function registerFederationRoutes(app, pool, verifyAgentAuth, auditChain) {
  const express = require('express');

  app.post('/v1/federations', express.json(), async (req, res) => {
    if (!isAdmin(req)) return res.status(401).json({ error: 'admin_auth_required' });
    const p = federationSchema.safeParse(req.body || {});
    if (!p.success) return res.status(400).json({ error: 'invalid_input', details: p.error.flatten() });
    const id = newId('fed');
    try {
      await pool.query(
        `INSERT INTO federations (federation_id, slug, name, description, governing_body, parent_constitution_id)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [id, p.data.slug, p.data.name, p.data.description || null, p.data.governing_body || null, p.data.parent_constitution_id || null]
      );
      if (auditChain) await auditChain.append({ event_type: 'federation.created', federation_id: id, slug: p.data.slug }).catch(() => {});
      res.status(201).json({ federation_id: id });
    } catch { res.status(409).json({ error: 'slug_taken' }); }
  });

  app.get('/v1/federations', async (req, res) => {
    const r = await pool.query(`SELECT federation_id, slug, name, description, governing_body, status, created_at FROM federations WHERE status='active' ORDER BY name`)
      .catch(() => ({ rows: [] }));
    res.json({ federations: r.rows });
  });

  app.get('/v1/federations/:slug', async (req, res) => {
    const f = await pool.query(`SELECT * FROM federations WHERE slug=$1`, [req.params.slug]).catch(() => ({ rows: [] }));
    if (!f.rows[0]) return res.status(404).json({ error: 'not_found' });
    const members = await pool.query(`SELECT org_id, joined_at FROM federation_members WHERE federation_id=$1 AND left_at IS NULL`,
      [f.rows[0].federation_id]).catch(() => ({ rows: [] }));
    res.json({ ...f.rows[0], member_count: members.rows.length, members: members.rows });
  });

  app.post('/v1/federations/:slug/join', express.json(), async (req, res) => {
    const did = req.headers['x-agent-did'];
    if (!did) return res.status(401).json({ error: 'agent_did_required' });
    const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const orgId = req.body?.org_id;
    if (!orgId) return res.status(400).json({ error: 'org_id_required' });

    const f = await pool.query(`SELECT federation_id, parent_constitution_id FROM federations WHERE slug=$1`, [req.params.slug])
      .catch(() => ({ rows: [] }));
    if (!f.rows[0]) return res.status(404).json({ error: 'federation_not_found' });

    const id = newId('fmem');
    try {
      await pool.query(
        `INSERT INTO federation_members (member_id, federation_id, org_id) VALUES ($1,$2,$3)`,
        [id, f.rows[0].federation_id, orgId]
      );
      // Auto-bind every org agent to the parent constitution if present
      if (f.rows[0].parent_constitution_id) {
        const agents = await pool.query(`SELECT agent_did FROM org_members WHERE org_id=$1`, [orgId]).catch(() => ({ rows: [] }));
        for (const a of agents.rows) {
          await pool.query(
            `INSERT INTO constitution_bindings (binding_id, constitution_id, agent_did, bound_by_did)
             VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
            [newId('bnd'), f.rows[0].parent_constitution_id, a.agent_did, did]
          ).catch(() => {});
        }
      }
      if (auditChain) await auditChain.append({ event_type: 'federation.joined', federation_id: f.rows[0].federation_id, org_id: orgId }).catch(() => {});
      res.status(201).json({ member_id: id, parent_constitution_bound: !!f.rows[0].parent_constitution_id });
    } catch { res.status(409).json({ error: 'already_member' }); }
  });

  app.post('/v1/federations/:slug/leave', async (req, res) => {
    const did = req.headers['x-agent-did'];
    if (!did) return res.status(401).json({ error: 'agent_did_required' });
    const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const orgId = req.body?.org_id || req.query.org_id;
    const r = await pool.query(`UPDATE federation_members SET left_at=NOW() WHERE federation_id IN (SELECT federation_id FROM federations WHERE slug=$1) AND org_id=$2 RETURNING member_id`,
      [req.params.slug, orgId]).catch(() => ({ rows: [] }));
    if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
    res.json({ member_id: r.rows[0].member_id, left: true });
  });

  // Run a compliance check across all members
  app.post('/v1/federations/:slug/check-compliance', async (req, res) => {
    if (!isAdmin(req)) return res.status(401).json({ error: 'admin_auth_required' });
    const f = await pool.query(`SELECT federation_id, parent_constitution_id FROM federations WHERE slug=$1`, [req.params.slug])
      .catch(() => ({ rows: [] }));
    if (!f.rows[0]) return res.status(404).json({ error: 'not_found' });
    if (!f.rows[0].parent_constitution_id) return res.status(400).json({ error: 'no_parent_constitution' });
    const rules = await pool.query(`SELECT rule_id FROM constitution_rules WHERE constitution_id=$1`, [f.rows[0].parent_constitution_id])
      .catch(() => ({ rows: [] }));
    const members = await pool.query(`SELECT org_id FROM federation_members WHERE federation_id=$1 AND left_at IS NULL`, [f.rows[0].federation_id])
      .catch(() => ({ rows: [] }));
    let checked = 0, passed = 0;
    for (const m of members.rows) {
      // For each member: check at least one agent in the org is bound to the parent constitution
      const bind = await pool.query(`SELECT 1 FROM constitution_bindings cb JOIN org_members om ON om.agent_did = cb.agent_did
                                       WHERE om.org_id=$1 AND cb.constitution_id=$2 AND cb.revoked_at IS NULL LIMIT 1`,
        [m.org_id, f.rows[0].parent_constitution_id]).catch(() => ({ rows: [] }));
      const ok = bind.rows.length > 0;
      const id = newId('fcc');
      await pool.query(
        `INSERT INTO federation_compliance_checks (check_id, federation_id, org_id, passed, rule_count)
         VALUES ($1,$2,$3,$4,$5)`,
        [id, f.rows[0].federation_id, m.org_id, ok, rules.rows.length]
      ).catch(() => {});
      checked++;
      if (ok) passed++;
    }
    res.json({ federation_id: f.rows[0].federation_id, checked, passed, fail: checked - passed });
  });

  app.get('/v1/agents/:did/federations', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(`
      SELECT f.slug, f.name, fm.joined_at FROM federation_members fm
      JOIN federations f ON f.federation_id = fm.federation_id
      JOIN org_members om ON om.org_id = fm.org_id
      WHERE om.agent_did = $1 AND fm.left_at IS NULL
    `, [did]).catch(() => ({ rows: [] }));
    res.json({ federations: r.rows });
  });
}

module.exports = { migrate, registerFederationRoutes };
