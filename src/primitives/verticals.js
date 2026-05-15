// ============================================================================
// verticals.js — industry-specific compliance + workflow shims for the highly
// regulated markets (healthcare, education, defense, government, finance,
// insurance, pharma, aviation). Each vertical = a 9- to 11-figure TAM.
// Without these we cannot legally take the deal.
// ============================================================================
const crypto = require('crypto');
const { z } = require('zod');

const VERTICALS = {
  healthcare: {
    label: 'Healthcare', frameworks: ['HIPAA', 'HITRUST', 'GDPR-Health'],
    required_disclosures: ['minimum_necessary', 'BAA_in_force', 'breach_notification'],
    pii_kinds: ['phi', 'mrn', 'icd10', 'cpt'], retention_days: 2557 // 7 years
  },
  education: {
    label: 'Education', frameworks: ['FERPA', 'COPPA', 'state-K12'],
    required_disclosures: ['directory_info', 'parental_consent_under_13'],
    pii_kinds: ['student_record', 'grade', 'discipline'], retention_days: 1827
  },
  defense: {
    label: 'Defense / Aerospace', frameworks: ['ITAR', 'EAR', 'CMMC-L3'],
    required_disclosures: ['dual_use', 'export_controlled'],
    pii_kinds: ['itar_data'], retention_days: null
  },
  government: {
    label: 'Government / Public sector', frameworks: ['FedRAMP-Moderate', 'StateRAMP', 'CJIS'],
    required_disclosures: ['data_residency_us_only'],
    pii_kinds: ['gov_id'], retention_days: 2557
  },
  finance: {
    label: 'Financial services', frameworks: ['FINRA', 'SEC-17a-4', 'GLBA', 'NYDFS-500'],
    required_disclosures: ['record_retention', 'wsp_in_force'],
    pii_kinds: ['ssn', 'tax_id', 'account_no'], retention_days: 2557
  },
  insurance: {
    label: 'Insurance', frameworks: ['NAIC-MDL', 'state-DOI', 'GLBA'],
    required_disclosures: ['claims_handling_sla', 'rebate_disclosure'],
    pii_kinds: ['policy_no', 'claim_no'], retention_days: 2557
  },
  pharma: {
    label: 'Pharma / Life sciences', frameworks: ['21-CFR-Part-11', 'GxP', 'HIPAA'],
    required_disclosures: ['e_signature', 'audit_trail_immutable'],
    pii_kinds: ['phi', 'trial_data'], retention_days: null
  },
  aviation: {
    label: 'Aviation', frameworks: ['FAA-145', 'FAA-43', 'EASA-Part-145'],
    required_disclosures: ['airworthiness', 'maintenance_record'],
    pii_kinds: ['airworthiness_cert'], retention_days: 1095
  },
  legal: {
    label: 'Legal / law firms', frameworks: ['ABA-Model-Rules', 'state-bar', 'attorney-client'],
    required_disclosures: ['privilege', 'conflict_check'],
    pii_kinds: ['client_secret'], retention_days: 2557
  },
  energy: {
    label: 'Energy / utilities', frameworks: ['NERC-CIP', 'FERC', 'TSA-pipeline'],
    required_disclosures: ['critical_infrastructure'],
    pii_kinds: ['scada_data'], retention_days: 2557
  }
};

async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS vertical_subscriptions (
      vsub_id           TEXT PRIMARY KEY,
      org_id            TEXT NOT NULL,
      vertical          TEXT NOT NULL,
      enabled_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      attestations      JSONB,
      data_residency    TEXT NOT NULL DEFAULT 'us',
      retention_days    INTEGER,
      baa_signed_at     TIMESTAMPTZ,
      audit_attested    BOOLEAN NOT NULL DEFAULT FALSE,
      UNIQUE (org_id, vertical)
    );
    CREATE TABLE IF NOT EXISTS vertical_audit_records (
      record_id         TEXT PRIMARY KEY,
      org_id            TEXT NOT NULL,
      vertical          TEXT NOT NULL,
      kind              TEXT NOT NULL,
      ref_id            TEXT,
      action            TEXT NOT NULL,
      actor_did         TEXT,
      payload           JSONB,
      occurred_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_vertical_audit_org ON vertical_audit_records (org_id, vertical, occurred_at DESC);
  `);
}
function newId(p) { return p + '_' + crypto.randomBytes(10).toString('hex'); }

function registerVerticalsRoutes(app, pool, verifyAgentAuth, auditChain) {
  const express = require('express');

  app.get('/v1/verticals', (req, res) => {
    res.json({ verticals: Object.entries(VERTICALS).map(([slug, v]) => ({ slug, ...v })) });
  });

  app.post('/v1/orgs/:id/verticals/enable', express.json(), async (req, res) => {
    const did = req.headers['x-agent-did'];
    if (!did) return res.status(401).json({ error: 'agent_did_required' });
    const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const v = req.body?.vertical;
    if (!v || !VERTICALS[v]) return res.status(400).json({ error: 'invalid_vertical' });
    const id = newId('vsub');
    await pool.query(
      `INSERT INTO vertical_subscriptions (vsub_id, org_id, vertical, attestations,
         data_residency, retention_days, baa_signed_at, audit_attested)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (org_id, vertical) DO UPDATE SET attestations = EXCLUDED.attestations,
         data_residency = EXCLUDED.data_residency, retention_days = EXCLUDED.retention_days,
         baa_signed_at = EXCLUDED.baa_signed_at, audit_attested = EXCLUDED.audit_attested`,
      [id, req.params.id, v, JSON.stringify(req.body?.attestations || {}),
       req.body?.data_residency || 'us', req.body?.retention_days || VERTICALS[v].retention_days,
       v === 'healthcare' ? new Date().toISOString() : null,
       !!req.body?.audit_attested]
    );
    if (auditChain) await auditChain.append({ event_type: 'vertical.enabled', org_id: req.params.id, vertical: v }).catch(() => {});
    res.status(201).json({ vsub_id: id, vertical: v, frameworks: VERTICALS[v].frameworks });
  });

  app.get('/v1/orgs/:id/verticals', async (req, res) => {
    const r = await pool.query(`SELECT * FROM vertical_subscriptions WHERE org_id=$1`, [req.params.id])
      .catch(() => ({ rows: [] }));
    res.json({ verticals: r.rows });
  });

  // Vertical-specific audit trail (e.g. healthcare PHI access log)
  app.post('/v1/orgs/:id/verticals/:v/audit', express.json(), async (req, res) => {
    const did = req.headers['x-agent-did'];
    if (!did) return res.status(401).json({ error: 'agent_did_required' });
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const id = newId('vrec');
    await pool.query(
      `INSERT INTO vertical_audit_records (record_id, org_id, vertical, kind, ref_id, action, actor_did, payload)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [id, req.params.id, req.params.v, req.body?.kind || 'access',
       req.body?.ref_id || null, req.body?.action || 'view', did,
       JSON.stringify(req.body?.payload || {})]
    );
    res.status(201).json({ record_id: id });
  });

  app.get('/v1/orgs/:id/verticals/:v/audit', async (req, res) => {
    const did = req.headers['x-agent-did'];
    if (!did) return res.status(401).json({ error: 'agent_did_required' });
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(`
      SELECT record_id, kind, ref_id, action, actor_did, occurred_at
      FROM vertical_audit_records WHERE org_id=$1 AND vertical=$2 ORDER BY occurred_at DESC LIMIT 500
    `, [req.params.id, req.params.v]).catch(() => ({ rows: [] }));
    res.json({ records: r.rows });
  });
}

module.exports = { migrate, registerVerticalsRoutes, VERTICALS };
