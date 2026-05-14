// ============================================================================
// OpenHeab Contracts — Agent-readable legal docs + Ed25519-signed contracts.
// Templates with {{placeholders}} -> instantiated contracts with parties.
// Each signature is verifiable by anyone using identities.public_key.
// ============================================================================
const express = require('express');
const cryptoLib = require('crypto');
const { z } = require('zod');

const TEMPLATE_KINDS = ['nda', 'sla', 'service-agreement', 'employment', 'lease', 'loan', 'license'];
const CONTRACT_STATUSES = ['drafted', 'signed', 'active', 'terminated', 'expired'];
const CLAUSE_KINDS = ['general', 'dispute_resolution', 'payment', 'term', 'confidentiality'];

async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS contract_templates (
      template_id    TEXT PRIMARY KEY,
      name           TEXT NOT NULL,
      kind           TEXT NOT NULL,
      jurisdiction   TEXT,
      body           TEXT NOT NULL,
      variables      JSONB DEFAULT '{}'::jsonb,
      public         BOOLEAN NOT NULL DEFAULT FALSE,
      author_did     TEXT NOT NULL,
      version        TEXT NOT NULL DEFAULT '1.0.0',
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_contract_templates_kind ON contract_templates (kind);
    CREATE INDEX IF NOT EXISTS idx_contract_templates_public ON contract_templates (public) WHERE public = TRUE;

    CREATE TABLE IF NOT EXISTS contracts (
      contract_id     TEXT PRIMARY KEY,
      template_id     TEXT,
      kind            TEXT NOT NULL,
      parties         JSONB NOT NULL DEFAULT '[]'::jsonb,
      terms           JSONB DEFAULT '{}'::jsonb,
      body_rendered   TEXT NOT NULL,
      status          TEXT NOT NULL DEFAULT 'drafted',
      effective_at    TIMESTAMPTZ,
      expires_at      TIMESTAMPTZ,
      terminated_at   TIMESTAMPTZ,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_contracts_status ON contracts (status);
    CREATE INDEX IF NOT EXISTS idx_contracts_kind ON contracts (kind);
    CREATE INDEX IF NOT EXISTS idx_contracts_parties ON contracts USING GIN (parties);

    CREATE TABLE IF NOT EXISTS contract_clauses (
      clause_id      TEXT PRIMARY KEY,
      contract_id    TEXT NOT NULL,
      sequence       INTEGER NOT NULL DEFAULT 0,
      kind           TEXT NOT NULL DEFAULT 'general',
      text           TEXT NOT NULL,
      signed_by_did  TEXT[] DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS idx_contract_clauses_contract ON contract_clauses (contract_id, sequence);
  `).catch(() => {});
}

function genId(prefix) { return `${prefix}_${cryptoLib.randomBytes(12).toString('hex')}`; }

function renderTemplate(body, variables) {
  let out = String(body || '');
  const vars = variables || {};
  out = out.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (m, key) => {
    const val = vars[key];
    return val === undefined || val === null ? m : String(val);
  });
  return out;
}

function canonicalHash(contract) {
  const obj = {
    contract_id: contract.contract_id,
    template_id: contract.template_id || null,
    kind: contract.kind,
    body_rendered: contract.body_rendered,
    terms: contract.terms || {},
    parties: (contract.parties || []).map(p => ({ did: p.did, role: p.role }))
  };
  const canonical = JSON.stringify(obj, Object.keys(obj).sort());
  return cryptoLib.createHash('sha256').update(canonical).digest('hex');
}

async function verifySignature(pool, did, hashHex, signatureHex) {
  const r = await pool.query(
    `SELECT public_key FROM identity_keys WHERE agent_did=$1 AND status='active'
     UNION ALL
     SELECT public_key FROM identities WHERE did=$1 LIMIT 1`, [did]
  ).catch(() => ({ rows: [] }));
  if (!r.rows[0]) return { valid: false, reason: 'unknown_party' };
  try {
    const pub = cryptoLib.createPublicKey(r.rows[0].public_key);
    const ok = cryptoLib.verify(null, Buffer.from(hashHex, 'hex'), pub, Buffer.from(signatureHex, 'hex'));
    return { valid: ok, reason: ok ? null : 'invalid_signature', public_key: r.rows[0].public_key };
  } catch (e) {
    return { valid: false, reason: 'verification_failed' };
  }
}

function registerContractsRoutes(app, pool, verifyAgentAuth, auditChain) {
  // POST /v1/contracts/templates
  const TemplateSchema = z.object({
    name: z.string().min(1).max(300),
    kind: z.enum(TEMPLATE_KINDS),
    jurisdiction: z.string().max(120).optional(),
    body: z.string().min(1).max(200000),
    variables: z.record(z.any()).optional(),
    public: z.boolean().optional(),
    author_did: z.string(),
    version: z.string().max(20).optional()
  });
  app.post('/v1/contracts/templates', express.json(), async (req, res) => {
    try {
      const parse = TemplateSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;
      const auth = await verifyAgentAuth(req, d.author_did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const templateId = genId('tmpl');
      await pool.query(
        `INSERT INTO contract_templates (template_id, name, kind, jurisdiction, body, variables,
                                          public, author_did, version)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9)`,
        [templateId, d.name, d.kind, d.jurisdiction || null, d.body,
         JSON.stringify(d.variables || {}), !!d.public, d.author_did, d.version || '1.0.0']
      );
      await auditChain.append({
        event_type: 'contracts.template_published', template_id: templateId, author_did: d.author_did,
        kind: d.kind, public: !!d.public, timestamp: new Date().toISOString()
      });
      return res.status(201).json({ template_id: templateId, kind: d.kind, version: d.version || '1.0.0' });
    } catch (e) { return res.status(500).json({ error: 'create_failed', message: e.message }); }
  });

  // GET /v1/contracts/templates (browse public)
  app.get('/v1/contracts/templates', async (req, res) => {
    const params = [];
    let sql = `SELECT template_id, name, kind, jurisdiction, public, author_did, version, created_at
               FROM contract_templates WHERE public = TRUE`;
    if (req.query.kind) { params.push(req.query.kind); sql += ` AND kind=$${params.length}`; }
    sql += ` ORDER BY created_at DESC LIMIT 500`;
    const r = await pool.query(sql, params).catch(() => ({ rows: [] }));
    return res.json({ templates: r.rows, count: r.rows.length });
  });

  // POST /v1/contracts — instantiate from template
  const InstantiateSchema = z.object({
    template_id: z.string().optional(),
    kind: z.enum(TEMPLATE_KINDS).optional(),
    body: z.string().max(200000).optional(),
    variables: z.record(z.any()).optional(),
    parties: z.array(z.object({
      did: z.string(),
      role: z.string().max(120)
    })).min(2),
    terms: z.record(z.any()).optional(),
    effective_at: z.string().optional(),
    expires_at: z.string().optional(),
    creator_did: z.string()
  });
  app.post('/v1/contracts', express.json(), async (req, res) => {
    try {
      const parse = InstantiateSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;
      const auth = await verifyAgentAuth(req, d.creator_did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      let body = d.body || '';
      let kind = d.kind;
      if (d.template_id) {
        const t = await pool.query(`SELECT * FROM contract_templates WHERE template_id=$1`, [d.template_id]).catch(() => ({ rows: [] }));
        if (!t.rows[0]) return res.status(404).json({ error: 'template_not_found' });
        body = renderTemplate(t.rows[0].body, d.variables || {});
        kind = kind || t.rows[0].kind;
      }
      if (!body || !kind) return res.status(400).json({ error: 'missing_body_or_kind' });

      const contractId = genId('ctr');
      const parties = d.parties.map(p => ({ did: p.did, role: p.role, signed_at: null, signature: null }));
      await pool.query(
        `INSERT INTO contracts (contract_id, template_id, kind, parties, terms, body_rendered,
                                 status, effective_at, expires_at)
         VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6,'drafted',$7,$8)`,
        [contractId, d.template_id || null, kind,
         JSON.stringify(parties), JSON.stringify(d.terms || {}), body,
         d.effective_at || null, d.expires_at || null]
      );
      await auditChain.append({
        event_type: 'contracts.instantiated', contract_id: contractId, template_id: d.template_id || null,
        kind, party_count: parties.length, timestamp: new Date().toISOString()
      });
      return res.status(201).json({
        contract_id: contractId, kind, status: 'drafted', party_count: parties.length,
        canonical_hash: canonicalHash({ contract_id: contractId, template_id: d.template_id, kind,
                                       body_rendered: body, terms: d.terms || {}, parties })
      });
    } catch (e) { return res.status(500).json({ error: 'instantiate_failed', message: e.message }); }
  });

  // POST /v1/contracts/:id/sign
  const SignSchema = z.object({
    signer_did: z.string(),
    signature: z.string()
  });
  app.post('/v1/contracts/:id/sign', express.json(), async (req, res) => {
    try {
      const parse = SignSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;
      const auth = await verifyAgentAuth(req, d.signer_did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const c = await pool.query(`SELECT * FROM contracts WHERE contract_id=$1`, [req.params.id]).catch(() => ({ rows: [] }));
      if (!c.rows[0]) return res.status(404).json({ error: 'not_found' });
      const contract = c.rows[0];
      const parties = Array.isArray(contract.parties) ? contract.parties : (contract.parties || []);
      const idx = parties.findIndex(p => p && p.did === d.signer_did);
      if (idx === -1) return res.status(403).json({ error: 'signer_not_a_party' });

      const hashHex = canonicalHash(contract);
      const v = await verifySignature(pool, d.signer_did, hashHex, d.signature);
      if (!v.valid) return res.status(400).json({ error: 'invalid_signature', reason: v.reason });

      parties[idx] = {
        ...parties[idx],
        signed_at: new Date().toISOString(),
        signature: d.signature,
        public_key: v.public_key,
        canonical_hash: hashHex
      };
      const allSigned = parties.every(p => p.signed_at);
      const newStatus = allSigned ? (contract.effective_at && new Date(contract.effective_at) > new Date() ? 'signed' : 'active') : 'drafted';
      await pool.query(
        `UPDATE contracts SET parties=$1::jsonb, status=$2 WHERE contract_id=$3`,
        [JSON.stringify(parties), newStatus, req.params.id]
      );
      await auditChain.append({
        event_type: 'contracts.signed', contract_id: req.params.id, signer_did: d.signer_did,
        canonical_hash: hashHex, all_signed: allSigned, timestamp: new Date().toISOString()
      });
      return res.json({ contract_id: req.params.id, status: newStatus, all_signed: allSigned, canonical_hash: hashHex });
    } catch (e) { return res.status(500).json({ error: 'sign_failed', message: e.message }); }
  });

  // POST /v1/contracts/:id/terminate
  app.post('/v1/contracts/:id/terminate', express.json(), async (req, res) => {
    try {
      const actor = req.body && req.body.actor_did;
      if (!actor) return res.status(400).json({ error: 'missing_actor_did' });
      const auth = await verifyAgentAuth(req, actor);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const c = await pool.query(`SELECT parties, status FROM contracts WHERE contract_id=$1`, [req.params.id]).catch(() => ({ rows: [] }));
      if (!c.rows[0]) return res.status(404).json({ error: 'not_found' });
      const parties = Array.isArray(c.rows[0].parties) ? c.rows[0].parties : [];
      if (!parties.find(p => p.did === actor)) return res.status(403).json({ error: 'not_a_party' });
      await pool.query(
        `UPDATE contracts SET status='terminated', terminated_at=NOW() WHERE contract_id=$1`,
        [req.params.id]
      );
      await auditChain.append({
        event_type: 'contracts.terminated', contract_id: req.params.id, actor_did: actor,
        timestamp: new Date().toISOString()
      });
      return res.json({ contract_id: req.params.id, status: 'terminated' });
    } catch (e) { return res.status(500).json({ error: 'terminate_failed', message: e.message }); }
  });

  // GET /v1/contracts/:id
  app.get('/v1/contracts/:id', async (req, res) => {
    const c = await pool.query(`SELECT * FROM contracts WHERE contract_id=$1`, [req.params.id]).catch(() => ({ rows: [] }));
    if (!c.rows[0]) return res.status(404).json({ error: 'not_found' });
    const clauses = await pool.query(
      `SELECT * FROM contract_clauses WHERE contract_id=$1 ORDER BY sequence ASC`, [req.params.id]
    ).catch(() => ({ rows: [] }));
    return res.json({
      contract: c.rows[0],
      clauses: clauses.rows,
      canonical_hash: canonicalHash(c.rows[0])
    });
  });

  // GET /v1/agents/:did/contracts — contracts where the agent is a party
  app.get('/v1/agents/:did/contracts', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(
      `SELECT contract_id, kind, status, effective_at, expires_at, created_at, parties
       FROM contracts
       WHERE parties @> $1::jsonb
       ORDER BY created_at DESC LIMIT 500`,
      [JSON.stringify([{ did }])]
    ).catch(() => ({ rows: [] }));
    return res.json({ contracts: r.rows, count: r.rows.length });
  });
}

module.exports = {
  migrate, registerContractsRoutes,
  TEMPLATE_KINDS, CONTRACT_STATUSES, CLAUSE_KINDS,
  renderTemplate, canonicalHash, verifySignature
};
