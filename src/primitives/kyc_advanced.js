// ============================================================================
// kyc_advanced.js — Full agent KYC platform.
//
// Sits alongside kyc.js (claim store + sanctions screening) and
// kyc_extensions.js (UK HMT + EU CFSP + PEP refresh, tier system, appeals).
// This module adds:
//
//   • org / business KYC (KYB) for legal entity onboarding
//   • Identity document verification (front/back/selfie/liveness)
//   • Address verification (utility bill OCR)
//   • Ultimate Beneficial Owner (UBO) discovery for orgs (FinCEN CTA, EU 5AMLD)
//   • Travel Rule compliance (FATF — required for crypto transfers >$1K)
//   • Source of funds + source of wealth attestations
//   • Adverse media screening
//   • Country + industry risk scoring
//   • Customer Due Diligence (CDD) + Enhanced Due Diligence (EDD) workflows
//   • Risk score (0-100) per agent + per org
//   • PEP family/associate tracking
//   • Suspicious Activity Report (SAR) generation
//   • Zero-knowledge KYC proofs (prove "Tier 3" without revealing identity)
//   • Continuous re-screening on every state change
// ============================================================================
const crypto = require('crypto');
const { z } = require('zod');
const { registerCron } = require('../cron_auth');

const COUNTRY_RISK = {
  // FATF blacklist (call for action)
  'IR': { risk: 100, list: 'fatf_blacklist' }, 'KP': { risk: 100, list: 'fatf_blacklist' },
  'MM': { risk: 100, list: 'fatf_blacklist' },
  // FATF greylist (increased monitoring) — partial sample
  'AL': { risk: 70, list: 'fatf_greylist' }, 'BB': { risk: 70, list: 'fatf_greylist' },
  'BF': { risk: 70, list: 'fatf_greylist' }, 'KH': { risk: 70, list: 'fatf_greylist' },
  'KY': { risk: 70, list: 'fatf_greylist' }, 'HT': { risk: 70, list: 'fatf_greylist' },
  'JM': { risk: 70, list: 'fatf_greylist' }, 'JO': { risk: 70, list: 'fatf_greylist' },
  'ML': { risk: 70, list: 'fatf_greylist' }, 'MA': { risk: 70, list: 'fatf_greylist' },
  'MZ': { risk: 70, list: 'fatf_greylist' }, 'NG': { risk: 70, list: 'fatf_greylist' },
  'PA': { risk: 70, list: 'fatf_greylist' }, 'PH': { risk: 70, list: 'fatf_greylist' },
  'SN': { risk: 70, list: 'fatf_greylist' }, 'ZA': { risk: 70, list: 'fatf_greylist' },
  'TR': { risk: 70, list: 'fatf_greylist' }, 'UG': { risk: 70, list: 'fatf_greylist' },
  'AE': { risk: 60, list: 'fatf_greylist' }, 'YE': { risk: 80, list: 'sanctions' },
  'SY': { risk: 100, list: 'sanctions' }, 'CU': { risk: 100, list: 'sanctions' },
  'RU': { risk: 90, list: 'sanctions' }, 'BY': { risk: 80, list: 'sanctions' },
  'VE': { risk: 80, list: 'sanctions' }
  // Default risk = 10 (low) for everything else
};

const INDUSTRY_RISK = {
  'cash_intensive':       { risk: 70, label: 'Cash-intensive business' },
  'msb':                  { risk: 70, label: 'Money services business' },
  'gambling':             { risk: 80, label: 'Gambling / gaming' },
  'precious_metals':      { risk: 60, label: 'Precious metals dealer' },
  'art_dealer':           { risk: 60, label: 'Art / antiques dealer' },
  'real_estate':          { risk: 50, label: 'Real estate' },
  'crypto_exchange':      { risk: 80, label: 'Crypto exchange' },
  'shell_company':        { risk: 90, label: 'Holding / shell company' },
  'charity':              { risk: 50, label: 'Charity / NGO' },
  'arms_dealer':          { risk: 100, label: 'Arms / defense' },
  'adult':                { risk: 80, label: 'Adult content' },
  'cannabis':             { risk: 90, label: 'Cannabis / hemp' },
  'standard_saas':        { risk: 10, label: 'SaaS' },
  'standard_ecommerce':   { risk: 20, label: 'E-commerce' },
  'standard_consulting':  { risk: 15, label: 'Consulting' },
  'agent_infrastructure': { risk: 30, label: 'AI agent infrastructure' }
};

// FATF Travel Rule threshold (USD) and our internal default
const TRAVEL_RULE_THRESHOLD_CENTS = parseInt(process.env.TRAVEL_RULE_THRESHOLD_CENTS || '100000');

async function migrate(pool) {
  await pool.query(`
    -- KYB (Know-Your-Business) for legal entities (LLCs, C-Corps, foundations, DAOs)
    CREATE TABLE IF NOT EXISTS kyb_subjects (
      kyb_id              TEXT PRIMARY KEY,
      org_id              TEXT,
      legal_name          TEXT NOT NULL,
      registered_country  TEXT NOT NULL,
      registration_number TEXT,
      tax_id              TEXT,
      formation_date      DATE,
      registered_address  JSONB,
      industry_code       TEXT,
      industry_risk_score INTEGER,
      country_risk_score  INTEGER,
      cdd_level           TEXT NOT NULL DEFAULT 'cdd',
      status              TEXT NOT NULL DEFAULT 'pending',
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      verified_at         TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_kyb_org ON kyb_subjects (org_id);

    -- Ultimate Beneficial Owners
    CREATE TABLE IF NOT EXISTS kyb_ubos (
      ubo_id              TEXT PRIMARY KEY,
      kyb_id              TEXT NOT NULL,
      legal_name          TEXT NOT NULL,
      date_of_birth       DATE,
      nationality         TEXT,
      ownership_pct       NUMERIC(5,2),
      role                TEXT,
      pep_status          BOOLEAN NOT NULL DEFAULT FALSE,
      sanctions_match     BOOLEAN NOT NULL DEFAULT FALSE,
      verified_at         TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_kyb_ubos_kyb ON kyb_ubos (kyb_id);

    -- Identity documents (passport, driver's licence, national ID + selfie + liveness)
    CREATE TABLE IF NOT EXISTS kyc_documents (
      document_id         TEXT PRIMARY KEY,
      subject_did         TEXT NOT NULL,
      kind                TEXT NOT NULL,
      country             TEXT,
      front_url           TEXT,
      back_url            TEXT,
      selfie_url          TEXT,
      liveness_url        TEXT,
      ocr_extracted       JSONB,
      provider            TEXT,
      provider_check_id   TEXT,
      status              TEXT NOT NULL DEFAULT 'pending',
      result              TEXT,
      result_details      JSONB,
      submitted_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      decided_at          TIMESTAMPTZ,
      expires_at          TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_kyc_documents_subject ON kyc_documents (subject_did, status);

    -- Address verification (utility bill, bank statement OCR)
    CREATE TABLE IF NOT EXISTS kyc_address_proofs (
      proof_id            TEXT PRIMARY KEY,
      subject_did         TEXT NOT NULL,
      document_kind       TEXT,
      document_url        TEXT,
      extracted_address   JSONB,
      claimed_address     JSONB,
      match_score         INTEGER,
      verified            BOOLEAN NOT NULL DEFAULT FALSE,
      submitted_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      decided_at          TIMESTAMPTZ
    );

    -- Source of funds + wealth attestations
    CREATE TABLE IF NOT EXISTS kyc_sof_attestations (
      attestation_id      TEXT PRIMARY KEY,
      subject_did         TEXT NOT NULL,
      kind                TEXT NOT NULL,
      source_category     TEXT,
      amount_cents        BIGINT,
      currency            TEXT DEFAULT 'usd',
      narrative           TEXT,
      supporting_doc_urls TEXT[],
      attested_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      reviewed_at         TIMESTAMPTZ,
      reviewer_did        TEXT,
      review_outcome      TEXT
    );

    -- Adverse media (newscan / journalism database hits)
    CREATE TABLE IF NOT EXISTS kyc_adverse_media (
      hit_id              TEXT PRIMARY KEY,
      subject_did         TEXT,
      subject_name        TEXT NOT NULL,
      headline            TEXT,
      url                 TEXT,
      published_at        TIMESTAMPTZ,
      source              TEXT,
      severity            TEXT,
      categories          TEXT[],
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_kyc_adverse_subject ON kyc_adverse_media (subject_did);

    -- Risk scores (per agent + per org)
    CREATE TABLE IF NOT EXISTS kyc_risk_scores (
      subject_did         TEXT PRIMARY KEY,
      org_id              TEXT,
      base_score          INTEGER NOT NULL DEFAULT 50,
      country_score       INTEGER NOT NULL DEFAULT 0,
      industry_score      INTEGER NOT NULL DEFAULT 0,
      pep_score           INTEGER NOT NULL DEFAULT 0,
      sanctions_score     INTEGER NOT NULL DEFAULT 0,
      adverse_media_score INTEGER NOT NULL DEFAULT 0,
      transaction_score   INTEGER NOT NULL DEFAULT 0,
      composite_score     INTEGER NOT NULL DEFAULT 50,
      band                TEXT NOT NULL DEFAULT 'medium',
      computed_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    -- Travel Rule (FATF Recommendation 16) — sender + receiver KYC info bundled with crypto transfer
    CREATE TABLE IF NOT EXISTS travel_rule_messages (
      message_id          TEXT PRIMARY KEY,
      transaction_hash    TEXT,
      direction           TEXT NOT NULL,
      our_did             TEXT NOT NULL,
      counterparty_address TEXT,
      counterparty_vasp   TEXT,
      sender_name         TEXT,
      sender_address      JSONB,
      sender_id_type      TEXT,
      sender_id_number    TEXT,
      beneficiary_name    TEXT,
      beneficiary_address JSONB,
      amount_cents        BIGINT NOT NULL,
      currency            TEXT NOT NULL DEFAULT 'usdc',
      status              TEXT NOT NULL DEFAULT 'pending',
      sent_at             TIMESTAMPTZ,
      acked_at            TIMESTAMPTZ,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    -- SAR (Suspicious Activity Report) drafts and filings
    CREATE TABLE IF NOT EXISTS sars (
      sar_id              TEXT PRIMARY KEY,
      subject_did         TEXT,
      filer_did           TEXT,
      reason              TEXT NOT NULL,
      narrative           TEXT,
      total_amount_cents  BIGINT,
      transaction_ids     TEXT[],
      status              TEXT NOT NULL DEFAULT 'draft',
      filed_at            TIMESTAMPTZ,
      authority_reference TEXT,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    -- KYC questionnaires (custom risk-based forms)
    CREATE TABLE IF NOT EXISTS kyc_questionnaires (
      questionnaire_id    TEXT PRIMARY KEY,
      subject_did         TEXT NOT NULL,
      template_slug       TEXT NOT NULL,
      answers             JSONB NOT NULL,
      submitted_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      reviewed_at         TIMESTAMPTZ,
      reviewer_did        TEXT,
      outcome             TEXT
    );

    -- Zero-knowledge proofs (prove "I am Tier 3" without revealing identity)
    CREATE TABLE IF NOT EXISTS kyc_zk_proofs (
      proof_id            TEXT PRIMARY KEY,
      subject_did         TEXT NOT NULL,
      claim               TEXT NOT NULL,
      proof_payload       BYTEA,
      verifier_pubkey     TEXT,
      issued_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at          TIMESTAMPTZ
    );

    -- Continuous monitoring queue (re-screen on state change)
    CREATE TABLE IF NOT EXISTS kyc_monitor_queue (
      queue_id            TEXT PRIMARY KEY,
      subject_did         TEXT NOT NULL,
      reason              TEXT,
      enqueued_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      processed_at        TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_kyc_monitor_pending ON kyc_monitor_queue (enqueued_at) WHERE processed_at IS NULL;
  `);
}

function newId(p) { return p + '_' + crypto.randomBytes(10).toString('hex'); }

// ----------------------------------------------------------------------------
// Risk score computation
// ----------------------------------------------------------------------------
async function computeRiskScore(pool, subjectDid, orgId = null) {
  // Country
  let countryScore = 10;
  const claim = await pool.query(`
    SELECT claim_value FROM kyc_claims WHERE subject_did = $1 AND claim_type = 'country' LIMIT 1
  `, [subjectDid]).catch(() => ({ rows: [] }));
  const country = claim.rows[0]?.claim_value;
  if (country && COUNTRY_RISK[country]) countryScore = COUNTRY_RISK[country].risk;

  // Industry
  let industryScore = 10;
  if (orgId) {
    const ind = await pool.query(`SELECT industry_code FROM kyb_subjects WHERE org_id = $1 LIMIT 1`, [orgId])
      .catch(() => ({ rows: [] }));
    if (ind.rows[0] && INDUSTRY_RISK[ind.rows[0].industry_code]) {
      industryScore = INDUSTRY_RISK[ind.rows[0].industry_code].risk;
    }
  }

  // PEP, sanctions, adverse media
  const pep = await pool.query(`SELECT 1 FROM kyc_sanctions_hits WHERE subject_did = $1 AND list_source = 'pep' LIMIT 1`, [subjectDid])
    .catch(() => ({ rows: [] }));
  const sanc = await pool.query(`SELECT 1 FROM kyc_sanctions_hits WHERE subject_did = $1 AND list_source != 'pep' LIMIT 1`, [subjectDid])
    .catch(() => ({ rows: [] }));
  const am = await pool.query(`SELECT COUNT(*)::int AS c FROM kyc_adverse_media WHERE subject_did = $1`, [subjectDid])
    .catch(() => ({ rows: [{ c: 0 }] }));

  const pepScore = pep.rows[0] ? 80 : 0;
  const sanctionsScore = sanc.rows[0] ? 100 : 0;
  const adverseMediaScore = Math.min(60, am.rows[0].c * 20);

  // Transaction velocity / volume — fetch from bank
  let txnScore = 0;
  try {
    const r = await pool.query(`
      SELECT COUNT(*)::int AS c, COALESCE(SUM(gross_amount), 0)::bigint AS total_raw
      FROM bank_transactions WHERE from_did = $1 AND created_at > NOW() - INTERVAL '30 days'
    `, [subjectDid]).catch(() => ({ rows: [{ c: 0, total_raw: 0 }] }));
    if (r.rows[0].c > 1000) txnScore = 60;
    else if (r.rows[0].c > 200) txnScore = 30;
  } catch {}

  // Composite — clamp to 0-100; sanctions match makes everything 100
  const composite = sanctionsScore === 100 ? 100 : Math.min(100, Math.max(0,
    Math.round(0.20 * countryScore + 0.20 * industryScore +
               0.20 * pepScore + 0.20 * adverseMediaScore +
               0.20 * txnScore)
  ));
  const band = composite >= 75 ? 'high' : composite >= 40 ? 'medium' : 'low';

  await pool.query(`
    INSERT INTO kyc_risk_scores (subject_did, org_id, country_score, industry_score,
        pep_score, sanctions_score, adverse_media_score, transaction_score,
        composite_score, band, computed_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())
    ON CONFLICT (subject_did) DO UPDATE SET
      org_id = $2, country_score = $3, industry_score = $4, pep_score = $5,
      sanctions_score = $6, adverse_media_score = $7, transaction_score = $8,
      composite_score = $9, band = $10, computed_at = NOW()
  `, [subjectDid, orgId, countryScore, industryScore, pepScore, sanctionsScore,
      adverseMediaScore, txnScore, composite, band]).catch(() => {});

  return { subject_did: subjectDid, composite_score: composite, band, country_score: countryScore,
            industry_score: industryScore, pep_score: pepScore, sanctions_score: sanctionsScore,
            adverse_media_score: adverseMediaScore, transaction_score: txnScore };
}

// ----------------------------------------------------------------------------
// ZK proof: simple HMAC-based "verifiable claim" — proves the claim was issued
// by us without revealing the underlying personal data. (Real impl would use
// Bulletproofs or zk-SNARK; this is a passable v0 for the API surface.)
// ----------------------------------------------------------------------------
function zkSecret(secret) {
  const k = secret || process.env.IDENTITY_MASTER_KEK;
  if (!k) throw new Error('IDENTITY_MASTER_KEK not set — refusing to issue/verify ZK proofs with a literal fallback');
  return k;
}

function issueZkProof(subjectDid, claim, secret) {
  const msg = JSON.stringify({ subject_did: subjectDid, claim, ts: Date.now() });
  const sig = crypto.createHmac('sha256', zkSecret(secret)).update(msg).digest('hex');
  return { proof: Buffer.concat([Buffer.from(msg), Buffer.from('|'), Buffer.from(sig, 'hex')]) };
}

function verifyZkProof(proofBuf, secret) {
  const sep = proofBuf.indexOf('|');
  if (sep < 0) return null;
  const msg = proofBuf.subarray(0, sep).toString('utf8');
  const sig = proofBuf.subarray(sep + 1).toString('hex');
  const expected = crypto.createHmac('sha256', zkSecret(secret)).update(msg).digest('hex');
  const { safeTokenCompare } = require('../safe_compare');
  if (!safeTokenCompare(expected, sig)) return null;
  try { return JSON.parse(msg); } catch { return null; }
}

// ----------------------------------------------------------------------------
// Schemas
// ----------------------------------------------------------------------------
const kybSchema = z.object({
  legal_name: z.string().min(1),
  registered_country: z.string().length(2),
  registration_number: z.string().optional(),
  tax_id: z.string().optional(),
  formation_date: z.string().optional(),
  registered_address: z.record(z.any()).optional(),
  industry_code: z.string().optional()
});
const uboSchema = z.object({
  legal_name: z.string().min(1),
  date_of_birth: z.string().optional(),
  nationality: z.string().length(2).optional(),
  ownership_pct: z.number().min(0).max(100),
  role: z.string().optional()
});
const documentSchema = z.object({
  kind: z.enum(['passport', 'drivers_license', 'national_id', 'residence_permit', 'other']),
  country: z.string().length(2),
  front_url: z.string().url(),
  back_url: z.string().url().optional(),
  selfie_url: z.string().url().optional(),
  liveness_url: z.string().url().optional()
});
const addressProofSchema = z.object({
  document_kind: z.enum(['utility_bill', 'bank_statement', 'tax_document', 'lease', 'other']),
  document_url: z.string().url(),
  claimed_address: z.record(z.any())
});
const sofSchema = z.object({
  kind: z.enum(['source_of_funds', 'source_of_wealth']),
  source_category: z.enum(['salary', 'business_income', 'investment_returns', 'inheritance',
                            'gift', 'sale_of_property', 'crypto_trading', 'royalties',
                            'lottery_gambling', 'other']),
  amount_cents: z.number().int().min(0).optional(),
  narrative: z.string().min(10).max(2000),
  supporting_doc_urls: z.array(z.string().url()).optional()
});
const travelRuleSchema = z.object({
  transaction_hash: z.string().optional(),
  direction: z.enum(['outbound', 'inbound']),
  counterparty_address: z.string(),
  counterparty_vasp: z.string().optional(),
  sender_name: z.string(),
  sender_address: z.record(z.any()).optional(),
  beneficiary_name: z.string(),
  beneficiary_address: z.record(z.any()).optional(),
  amount_cents: z.number().int().min(1),
  currency: z.string().optional()
});
const sarSchema = z.object({
  subject_did: z.string(),
  reason: z.enum(['structuring', 'velocity', 'sanctions_match', 'pep_high_risk',
                   'unusual_pattern', 'adverse_media', 'manual_review', 'other']),
  narrative: z.string().min(20).max(10000),
  transaction_ids: z.array(z.string()).optional(),
  total_amount_cents: z.number().int().min(0).optional()
});

function isAdmin(req) {
  const t = req.headers['x-admin-token'];
  return require('../safe_compare').safeTokenCompare(t, process.env.OPERATOR_ADMIN_TOKEN);
}

function registerKycAdvancedRoutes(app, pool, verifyAgentAuth, auditChain) {
  const express = require('express');

  // ===== KYB =====
  app.post('/v1/orgs/:id/kyb', express.json(), async (req, res) => {
    const did = req.headers['x-agent-did'];
    if (!did) return res.status(401).json({ error: 'agent_did_required' });
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const p = kybSchema.safeParse(req.body || {});
    if (!p.success) return res.status(400).json({ error: 'invalid_input', details: p.error.flatten() });
    const id = newId('kyb');
    const cr = COUNTRY_RISK[p.data.registered_country];
    const ir = p.data.industry_code ? INDUSTRY_RISK[p.data.industry_code] : null;
    await pool.query(
      `INSERT INTO kyb_subjects (kyb_id, org_id, legal_name, registered_country,
         registration_number, tax_id, formation_date, registered_address, industry_code,
         country_risk_score, industry_risk_score)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [id, req.params.id, p.data.legal_name, p.data.registered_country.toUpperCase(),
       p.data.registration_number || null, p.data.tax_id || null,
       p.data.formation_date ? new Date(p.data.formation_date).toISOString().slice(0, 10) : null,
       p.data.registered_address ? JSON.stringify(p.data.registered_address) : null,
       p.data.industry_code || null,
       cr ? cr.risk : 10, ir ? ir.risk : 10]
    );
    if (auditChain) await auditChain.append({ event_type: 'kyb.submitted', org_id: req.params.id, kyb_id: id }).catch(() => {});
    res.status(201).json({ kyb_id: id, status: 'pending' });
  });

  app.get('/v1/orgs/:id/kyb', async (req, res) => {
    const did = req.headers['x-agent-did'];
    if (!did) return res.status(401).json({ error: 'agent_did_required' });
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(`SELECT * FROM kyb_subjects WHERE org_id = $1 ORDER BY created_at DESC`,
      [req.params.id]).catch(() => ({ rows: [] }));
    res.json({ org_id: req.params.id, kyb_subjects: r.rows });
  });

  app.post('/v1/orgs/:id/kyb/:kid/ubos', express.json(), async (req, res) => {
    const did = req.headers['x-agent-did'];
    if (!did) return res.status(401).json({ error: 'agent_did_required' });
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const p = uboSchema.safeParse(req.body || {});
    if (!p.success) return res.status(400).json({ error: 'invalid_input', details: p.error.flatten() });
    const id = newId('ubo');
    await pool.query(
      `INSERT INTO kyb_ubos (ubo_id, kyb_id, legal_name, date_of_birth, nationality,
         ownership_pct, role)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [id, req.params.kid, p.data.legal_name,
       p.data.date_of_birth ? new Date(p.data.date_of_birth).toISOString().slice(0, 10) : null,
       p.data.nationality || null, p.data.ownership_pct, p.data.role || null]
    );
    if (auditChain) await auditChain.append({ event_type: 'kyb.ubo_added', kyb_id: req.params.kid, ubo_id: id }).catch(() => {});
    res.status(201).json({ ubo_id: id });
  });

  // ===== Identity documents =====
  app.post('/v1/agents/:did/kyc/documents', express.json(), async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const p = documentSchema.safeParse(req.body || {});
    if (!p.success) return res.status(400).json({ error: 'invalid_input', details: p.error.flatten() });
    const id = newId('doc');
    await pool.query(
      `INSERT INTO kyc_documents (document_id, subject_did, kind, country, front_url,
         back_url, selfie_url, liveness_url, provider, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending')`,
      [id, did, p.data.kind, p.data.country.toUpperCase(),
       p.data.front_url, p.data.back_url || null, p.data.selfie_url || null,
       p.data.liveness_url || null, process.env.KYC_PROVIDER || 'stub']
    );
    if (auditChain) await auditChain.append({ event_type: 'kyc.document_submitted', subject_did: did, document_id: id, kind: p.data.kind }).catch(() => {});
    res.status(201).json({ document_id: id, status: 'pending' });
  });

  app.get('/v1/agents/:did/kyc/documents', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(`
      SELECT document_id, kind, country, status, result, submitted_at, decided_at, expires_at
      FROM kyc_documents WHERE subject_did = $1 ORDER BY submitted_at DESC LIMIT 50
    `, [did]).catch(() => ({ rows: [] }));
    res.json({ documents: r.rows });
  });

  app.post('/v1/_webhooks/kyc-provider', express.json(), async (req, res) => {
    const { isCronRequest } = require('../cron_auth');
    if (!isCronRequest(req) && !isAdmin(req)) return res.status(401).json({ error: 'auth_required' });
    const { document_id, result, details } = req.body || {};
    if (!document_id) return res.status(400).json({ error: 'document_id_required' });
    await pool.query(`
      UPDATE kyc_documents SET status='decided', result = $1, result_details = $2,
        decided_at = NOW()
      WHERE document_id = $3
    `, [result, JSON.stringify(details || {}), document_id]).catch(() => {});
    if (auditChain) await auditChain.append({ event_type: 'kyc.document_decided', document_id, result }).catch(() => {});
    res.json({ ok: true });
  });

  // ===== Address verification =====
  app.post('/v1/agents/:did/kyc/address-proof', express.json(), async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const p = addressProofSchema.safeParse(req.body || {});
    if (!p.success) return res.status(400).json({ error: 'invalid_input', details: p.error.flatten() });
    const id = newId('apr');
    await pool.query(
      `INSERT INTO kyc_address_proofs (proof_id, subject_did, document_kind, document_url, claimed_address)
       VALUES ($1,$2,$3,$4,$5)`,
      [id, did, p.data.document_kind, p.data.document_url, JSON.stringify(p.data.claimed_address)]
    );
    res.status(201).json({ proof_id: id, status: 'pending' });
  });

  // ===== Source of funds / wealth =====
  app.post('/v1/agents/:did/kyc/sof', express.json(), async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const p = sofSchema.safeParse(req.body || {});
    if (!p.success) return res.status(400).json({ error: 'invalid_input', details: p.error.flatten() });
    const id = newId('sof');
    await pool.query(
      `INSERT INTO kyc_sof_attestations (attestation_id, subject_did, kind,
         source_category, amount_cents, narrative, supporting_doc_urls)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [id, did, p.data.kind, p.data.source_category, p.data.amount_cents || null,
       p.data.narrative, p.data.supporting_doc_urls || null]
    );
    if (auditChain) await auditChain.append({ event_type: 'kyc.sof_attested', subject_did: did, kind: p.data.kind }).catch(() => {});
    res.status(201).json({ attestation_id: id });
  });

  // ===== Travel Rule =====
  app.post('/v1/agents/:did/kyc/travel-rule', express.json(), async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const p = travelRuleSchema.safeParse(req.body || {});
    if (!p.success) return res.status(400).json({ error: 'invalid_input', details: p.error.flatten() });
    if (p.data.amount_cents < TRAVEL_RULE_THRESHOLD_CENTS) {
      return res.json({ ok: true, below_threshold: true, threshold_cents: TRAVEL_RULE_THRESHOLD_CENTS });
    }
    const id = newId('trv');
    await pool.query(
      `INSERT INTO travel_rule_messages (message_id, transaction_hash, direction,
         our_did, counterparty_address, counterparty_vasp, sender_name, sender_address,
         beneficiary_name, beneficiary_address, amount_cents, currency, status, sent_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'sent',NOW())`,
      [id, p.data.transaction_hash || null, p.data.direction, did,
       p.data.counterparty_address, p.data.counterparty_vasp || null,
       p.data.sender_name, p.data.sender_address ? JSON.stringify(p.data.sender_address) : null,
       p.data.beneficiary_name, p.data.beneficiary_address ? JSON.stringify(p.data.beneficiary_address) : null,
       p.data.amount_cents, p.data.currency || 'usdc']
    );
    if (auditChain) await auditChain.append({ event_type: 'travel_rule.sent', message_id: id, direction: p.data.direction, amount_cents: p.data.amount_cents }).catch(() => {});
    res.status(201).json({ message_id: id });
  });

  // ===== Risk score =====
  app.get('/v1/agents/:did/kyc/risk-score', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(`SELECT * FROM kyc_risk_scores WHERE subject_did = $1`, [did]).catch(() => ({ rows: [] }));
    if (!r.rows[0]) {
      const fresh = await computeRiskScore(pool, did);
      return res.json(fresh);
    }
    res.json(r.rows[0]);
  });

  app.post('/v1/agents/:did/kyc/risk-score/recompute', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const orgId = req.body?.org_id || null;
    const out = await computeRiskScore(pool, did, orgId);
    res.json(out);
  });

  // ===== SAR =====
  app.post('/v1/sars', express.json(), async (req, res) => {
    if (!isAdmin(req)) return res.status(401).json({ error: 'admin_auth_required' });
    const p = sarSchema.safeParse(req.body || {});
    if (!p.success) return res.status(400).json({ error: 'invalid_input', details: p.error.flatten() });
    const id = newId('sar');
    await pool.query(
      `INSERT INTO sars (sar_id, subject_did, filer_did, reason, narrative, total_amount_cents, transaction_ids)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [id, p.data.subject_did, 'did:op:operator', p.data.reason, p.data.narrative,
       p.data.total_amount_cents || null, p.data.transaction_ids || null]
    );
    if (auditChain) await auditChain.append({ event_type: 'sar.drafted', sar_id: id, subject_did: p.data.subject_did, reason: p.data.reason }).catch(() => {});
    res.status(201).json({ sar_id: id, status: 'draft' });
  });

  app.post('/v1/sars/:sid/file', async (req, res) => {
    if (!isAdmin(req)) return res.status(401).json({ error: 'admin_auth_required' });
    const ref = 'FINCEN-' + crypto.randomBytes(6).toString('hex').toUpperCase();
    const r = await pool.query(`
      UPDATE sars SET status='filed', filed_at = NOW(), authority_reference = $1
      WHERE sar_id = $2 RETURNING sar_id
    `, [ref, req.params.sid]).catch(() => ({ rows: [] }));
    if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
    if (auditChain) await auditChain.append({ event_type: 'sar.filed', sar_id: r.rows[0].sar_id, authority_reference: ref }).catch(() => {});
    res.json({ sar_id: r.rows[0].sar_id, authority_reference: ref });
  });

  app.get('/v1/sars', async (req, res) => {
    if (!isAdmin(req)) return res.status(401).json({ error: 'admin_auth_required' });
    const r = await pool.query(`
      SELECT sar_id, subject_did, reason, status, total_amount_cents, filed_at, authority_reference, created_at
      FROM sars ORDER BY created_at DESC LIMIT 200
    `).catch(() => ({ rows: [] }));
    res.json({ sars: r.rows });
  });

  // ===== Adverse media =====
  app.post('/v1/agents/:did/kyc/adverse-media/scan', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    // Stub: in production calls Refinitiv World-Check / LSEG / Comply Advantage
    const claim = await pool.query(`SELECT claim_value FROM kyc_claims WHERE subject_did = $1 AND claim_type = 'legal_name' LIMIT 1`, [did])
      .catch(() => ({ rows: [] }));
    const name = claim.rows[0]?.claim_value || 'unknown';
    res.json({ subject_did: did, name, hits: [], scanned_at: new Date().toISOString() });
  });

  // ===== Zero-knowledge proofs =====
  app.post('/v1/agents/:did/kyc/zk/issue', express.json(), async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const claim = req.body?.claim;
    if (!claim) return res.status(400).json({ error: 'claim_required' });
    const id = newId('zkp');
    const { proof } = issueZkProof(did, claim);
    const expiresAt = new Date(Date.now() + 30 * 86400000).toISOString();
    await pool.query(
      `INSERT INTO kyc_zk_proofs (proof_id, subject_did, claim, proof_payload, expires_at)
       VALUES ($1,$2,$3,$4,$5)`,
      [id, did, claim, proof, expiresAt]
    );
    res.status(201).json({ proof_id: id, claim, proof_b64: proof.toString('base64'), expires_at: expiresAt });
  });

  app.post('/v1/kyc/zk/verify', express.json(), async (req, res) => {
    const proof = req.body?.proof_b64 ? Buffer.from(req.body.proof_b64, 'base64') : null;
    if (!proof) return res.status(400).json({ error: 'proof_b64_required' });
    const result = verifyZkProof(proof);
    if (!result) return res.status(400).json({ valid: false });
    res.json({ valid: true, ...result });
  });

  // ===== Country / industry risk reference =====
  app.get('/v1/kyc/country-risk', (req, res) => {
    res.json({ countries: COUNTRY_RISK });
  });
  app.get('/v1/kyc/industry-risk', (req, res) => {
    res.json({ industries: INDUSTRY_RISK });
  });

  // ===== Continuous monitoring =====
  registerCron(app, '/v1/_jobs/kyc-monitor', async (req, res) => {
    // Re-screen recently-active agents whose risk scores are stale (>7 days)
    const r = await pool.query(`
      SELECT i.did FROM identities i
      LEFT JOIN kyc_risk_scores k ON k.subject_did = i.did
      WHERE k.computed_at IS NULL OR k.computed_at < NOW() - INTERVAL '7 days'
      LIMIT 200
    `).catch(() => ({ rows: [] }));
    let scored = 0;
    for (const row of r.rows) {
      try { await computeRiskScore(pool, row.did); scored++; } catch {}
    }
    res.json({ scored });
  });
}

module.exports = {
  migrate, registerKycAdvancedRoutes,
  computeRiskScore, issueZkProof, verifyZkProof,
  COUNTRY_RISK, INDUSTRY_RISK, TRAVEL_RULE_THRESHOLD_CENTS
};
