// ============================================================================
// OpenHeab KYC — Verifiable Claims + Sanctions Screening
// Tables: kyc_claims, kyc_sanctions_list, kyc_sanctions_meta, kyc_verifications
// External lists: OFAC SDN (CSV), UN Consolidated (XML)
// ============================================================================
const cryptoLib = require('crypto');
const express = require('express');
const { z } = require('zod');

const CLAIM_TYPES = [
  'jurisdiction',
  'operator',
  'operator_type',
  'agent_purpose',
  'agent_class',
  'inception_date',
  'human_in_loop',
  'compliance_program',
  'sanctions_clear',
  'age_of_principal',
  'company_registration',
  'attestor_did'
];

const OFAC_SDN_URL = 'https://www.treasury.gov/ofac/downloads/sdn.csv';
const UN_CONSOLIDATED_URL = 'https://scsanctions.un.org/resources/xml/en/consolidated.xml';

// ----------------------------------------------------------------------------
// Migration
// ----------------------------------------------------------------------------
async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS kyc_claims (
      claim_id        TEXT PRIMARY KEY,
      subject_did     TEXT NOT NULL,
      issuer_did      TEXT NOT NULL,
      claim_type      TEXT NOT NULL,
      claim_value     JSONB NOT NULL,
      confidence      REAL NOT NULL DEFAULT 1.0,
      signature       TEXT,
      expires_at      TIMESTAMPTZ,
      revoked_at      TIMESTAMPTZ,
      audit_hash      TEXT,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_kyc_claims_subject ON kyc_claims (subject_did);
    CREATE INDEX IF NOT EXISTS idx_kyc_claims_issuer ON kyc_claims (issuer_did);
    CREATE INDEX IF NOT EXISTS idx_kyc_claims_type ON kyc_claims (claim_type);

    CREATE TABLE IF NOT EXISTS kyc_sanctions_list (
      list_source TEXT NOT NULL,
      list_id     TEXT NOT NULL,
      name        TEXT NOT NULL,
      aliases     TEXT[],
      country     TEXT,
      type        TEXT,
      programs    TEXT[],
      raw         JSONB,
      added_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (list_source, list_id)
    );
    CREATE INDEX IF NOT EXISTS idx_kyc_sanctions_name ON kyc_sanctions_list (lower(name));
    CREATE INDEX IF NOT EXISTS idx_kyc_sanctions_source ON kyc_sanctions_list (list_source);

    CREATE TABLE IF NOT EXISTS kyc_sanctions_meta (
      list_source TEXT PRIMARY KEY,
      last_refresh_at TIMESTAMPTZ,
      record_count INTEGER,
      raw_size_bytes INTEGER,
      last_error TEXT
    );

    CREATE TABLE IF NOT EXISTS kyc_verifications (
      verification_id   TEXT PRIMARY KEY,
      subject_did       TEXT NOT NULL,
      result            TEXT NOT NULL,
      matched_claims    JSONB,
      matched_sanctions JSONB,
      audit_hash        TEXT,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_kyc_verifications_subject ON kyc_verifications (subject_did);

    CREATE TABLE IF NOT EXISTS kyc_idempotency (
      agent_did   TEXT NOT NULL,
      scope       TEXT NOT NULL,
      idem_key    TEXT NOT NULL,
      response    JSONB NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (agent_did, scope, idem_key)
    );
  `);
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------
function genId(prefix) {
  return `${prefix}_${cryptoLib.randomBytes(12).toString('hex')}`;
}

async function checkIdempotency(pool, agentDid, key, scope) {
  if (!key) return null;
  const r = await pool.query(
    `SELECT response FROM kyc_idempotency WHERE agent_did=$1 AND scope=$2 AND idem_key=$3`,
    [agentDid, scope, key]
  ).catch(() => ({ rows: [] }));
  return r.rows[0]?.response || null;
}

async function recordIdempotency(pool, agentDid, key, scope, response) {
  if (!key) return;
  await pool.query(
    `INSERT INTO kyc_idempotency (agent_did, scope, idem_key, response)
     VALUES ($1,$2,$3,$4::jsonb) ON CONFLICT DO NOTHING`,
    [agentDid, scope, key, JSON.stringify(response)]
  ).catch(() => {});
}

function normalizeName(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// ----------------------------------------------------------------------------
// CSV / XML parsing
// ----------------------------------------------------------------------------
function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') inQ = false;
      else cur += c;
    } else {
      if (c === '"') inQ = true;
      else if (c === ',') { out.push(cur); cur = ''; }
      else cur += c;
    }
  }
  out.push(cur);
  return out;
}

function parseOfacSdnCsv(text) {
  // OFAC SDN.csv columns (no header):
  // ent_num, SDN_Name, SDN_Type, Program, Title, Call_Sign, Vess_type, Tonnage,
  // GRT, Vess_flag, Vess_owner, Remarks
  const records = [];
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim()) continue;
    const cols = parseCsvLine(line);
    if (cols.length < 4) continue;
    const id = cols[0].trim();
    const name = cols[1].replace(/^-0-$/, '').trim();
    const type = cols[2].replace(/^-0-$/, '').trim();
    const programStr = cols[3].replace(/^-0-$/, '').trim();
    if (!id || !name) continue;
    records.push({
      list_source: 'OFAC',
      list_id: id,
      name,
      aliases: [],
      country: null,
      type: type || null,
      programs: programStr ? programStr.split(/\s*[,;]\s*/).filter(Boolean) : [],
      raw: { ent_num: id, sdn_name: name, sdn_type: type, program: programStr }
    });
  }
  return records;
}

function parseUnConsolidatedXml(text) {
  const records = [];
  const individualRe = /<INDIVIDUAL\b[\s\S]*?<\/INDIVIDUAL>/gi;
  const entityRe = /<ENTITY\b[\s\S]*?<\/ENTITY>/gi;
  const tag = (block, name) => {
    const m = block.match(new RegExp(`<${name}>([\\s\\S]*?)<\\/${name}>`, 'i'));
    return m ? m[1].trim() : null;
  };
  const collectAliases = (block) => {
    const out = [];
    const re = /<ALIAS_NAME>([\s\S]*?)<\/ALIAS_NAME>/gi;
    let m;
    while ((m = re.exec(block))) {
      const v = m[1].trim();
      if (v) out.push(v);
    }
    return out;
  };
  const collectPrograms = (block) => {
    const out = [];
    const re = /<UN_LIST_TYPE>([\s\S]*?)<\/UN_LIST_TYPE>/gi;
    let m;
    while ((m = re.exec(block))) {
      const v = m[1].trim();
      if (v) out.push(v);
    }
    const re2 = /<REFERENCE_NUMBER>([\s\S]*?)<\/REFERENCE_NUMBER>/gi;
    while ((m = re2.exec(block))) {
      const v = m[1].trim();
      if (v) out.push(v);
    }
    return out;
  };

  const handleBlock = (block, type) => {
    const dataid = tag(block, 'DATAID') || tag(block, 'REFERENCE_NUMBER');
    const first = tag(block, 'FIRST_NAME') || '';
    const second = tag(block, 'SECOND_NAME') || '';
    const third = tag(block, 'THIRD_NAME') || '';
    const fourth = tag(block, 'FOURTH_NAME') || '';
    const entityName = tag(block, 'FIRST_NAME');
    let name;
    if (type === 'individual') {
      name = [first, second, third, fourth].filter(Boolean).join(' ').trim();
    } else {
      name = entityName || '';
    }
    if (!dataid || !name) return;
    const country = tag(block, 'COUNTRY_OF_BIRTH') || tag(block, 'NATIONALITY') || null;
    records.push({
      list_source: 'UN',
      list_id: dataid,
      name,
      aliases: collectAliases(block),
      country,
      type,
      programs: collectPrograms(block),
      raw: { type, dataid, name }
    });
  };

  let m;
  while ((m = individualRe.exec(text))) handleBlock(m[0], 'individual');
  while ((m = entityRe.exec(text))) handleBlock(m[0], 'entity');
  return records;
}

// ----------------------------------------------------------------------------
// Refresh sanctions lists
// ----------------------------------------------------------------------------
async function fetchText(url, timeoutMs = 60000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.text();
  } finally {
    clearTimeout(t);
  }
}

async function ingestRecords(pool, source, records) {
  if (!records.length) return 0;
  const client = await pool.connect().catch(() => null);
  const exec = client || pool;
  let inserted = 0;
  try {
    if (client) await client.query('BEGIN');
    await exec.query(`DELETE FROM kyc_sanctions_list WHERE list_source = $1`, [source]);
    const chunk = 500;
    for (let i = 0; i < records.length; i += chunk) {
      const slice = records.slice(i, i + chunk);
      const values = [];
      const params = [];
      let p = 1;
      for (const rec of slice) {
        values.push(`($${p++},$${p++},$${p++},$${p++}::text[],$${p++},$${p++},$${p++}::text[],$${p++}::jsonb,NOW())`);
        params.push(
          rec.list_source, rec.list_id, rec.name,
          rec.aliases || [], rec.country || null, rec.type || null,
          rec.programs || [], JSON.stringify(rec.raw || {})
        );
      }
      await exec.query(
        `INSERT INTO kyc_sanctions_list
         (list_source, list_id, name, aliases, country, type, programs, raw, added_at)
         VALUES ${values.join(',')}
         ON CONFLICT (list_source, list_id) DO UPDATE SET
           name = EXCLUDED.name, aliases = EXCLUDED.aliases,
           country = EXCLUDED.country, type = EXCLUDED.type,
           programs = EXCLUDED.programs, raw = EXCLUDED.raw,
           added_at = NOW()`,
        params
      );
      inserted += slice.length;
    }
    if (client) await client.query('COMMIT');
  } catch (e) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    if (client) client.release();
  }
  return inserted;
}

async function refreshSanctions(pool) {
  const results = {};

  // OFAC SDN
  try {
    const txt = await fetchText(OFAC_SDN_URL);
    const recs = parseOfacSdnCsv(txt);
    const count = await ingestRecords(pool, 'OFAC', recs);
    await pool.query(
      `INSERT INTO kyc_sanctions_meta (list_source, last_refresh_at, record_count, raw_size_bytes, last_error)
       VALUES ('OFAC', NOW(), $1, $2, NULL)
       ON CONFLICT (list_source) DO UPDATE SET last_refresh_at=NOW(),
         record_count=EXCLUDED.record_count, raw_size_bytes=EXCLUDED.raw_size_bytes,
         last_error=NULL`,
      [count, txt.length]
    );
    results.ofac = { count, size: txt.length };
  } catch (e) {
    await pool.query(
      `INSERT INTO kyc_sanctions_meta (list_source, last_refresh_at, last_error)
       VALUES ('OFAC', NOW(), $1)
       ON CONFLICT (list_source) DO UPDATE SET last_refresh_at=NOW(), last_error=EXCLUDED.last_error`,
      [e.message]
    ).catch(() => {});
    results.ofac = { error: e.message };
  }

  // UN Consolidated
  try {
    const txt = await fetchText(UN_CONSOLIDATED_URL);
    const recs = parseUnConsolidatedXml(txt);
    const count = await ingestRecords(pool, 'UN', recs);
    await pool.query(
      `INSERT INTO kyc_sanctions_meta (list_source, last_refresh_at, record_count, raw_size_bytes, last_error)
       VALUES ('UN', NOW(), $1, $2, NULL)
       ON CONFLICT (list_source) DO UPDATE SET last_refresh_at=NOW(),
         record_count=EXCLUDED.record_count, raw_size_bytes=EXCLUDED.raw_size_bytes,
         last_error=NULL`,
      [count, txt.length]
    );
    results.un = { count, size: txt.length };
  } catch (e) {
    await pool.query(
      `INSERT INTO kyc_sanctions_meta (list_source, last_refresh_at, last_error)
       VALUES ('UN', NOW(), $1)
       ON CONFLICT (list_source) DO UPDATE SET last_refresh_at=NOW(), last_error=EXCLUDED.last_error`,
      [e.message]
    ).catch(() => {});
    results.un = { error: e.message };
  }

  return results;
}

// ----------------------------------------------------------------------------
// Sanctions matching
// ----------------------------------------------------------------------------
async function matchSanctions(pool, name, country = null) {
  if (!name) return [];
  const norm = normalizeName(name);
  if (!norm) return [];
  const params = [`%${norm}%`];
  let countryFilter = '';
  if (country) {
    params.push(country);
    countryFilter = ` AND (country IS NULL OR lower(country) = lower($2))`;
  }
  const r = await pool.query(`
    SELECT list_source, list_id, name, aliases, country, type, programs
    FROM kyc_sanctions_list
    WHERE lower(name) LIKE $1 ${countryFilter}
       OR EXISTS (
         SELECT 1 FROM unnest(aliases) a WHERE lower(a) LIKE $1
       )
    LIMIT 100
  `, params).catch(() => ({ rows: [] }));
  // refine — exact-token containment
  const tokens = norm.split(' ').filter(t => t.length >= 3);
  return r.rows.filter(row => {
    const cand = normalizeName(row.name);
    return tokens.every(t => cand.includes(t)) ||
      (row.aliases || []).some(a => {
        const an = normalizeName(a);
        return tokens.every(t => an.includes(t));
      });
  });
}

// ----------------------------------------------------------------------------
// Routes
// ----------------------------------------------------------------------------
function registerKycRoutes(app, pool, verifyAgentAuth, auditChain) {
  // POST /v1/agents/:did/kyc/claims — self-issued or self-attested
  const ClaimSchema = z.object({
    claim_type: z.enum(CLAIM_TYPES),
    claim_value: z.any(),
    confidence: z.number().min(0).max(1).optional(),
    expires_at: z.string().datetime().optional(),
    signature: z.string().optional()
  });

  app.post('/v1/agents/:did/kyc/claims', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const parse = ClaimSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });

      const idemKey = req.headers['x-idempotency-key'];
      const cached = await checkIdempotency(pool, did, idemKey, 'kyc-claim');
      if (cached) return res.json(cached);

      const claimId = genId('clm');
      const entry = await auditChain.append({
        event_type: 'kyc.claim_added',
        subject_did: did,
        issuer_did: did,
        claim_type: parse.data.claim_type,
        timestamp: new Date().toISOString()
      });

      await pool.query(
        `INSERT INTO kyc_claims
         (claim_id, subject_did, issuer_did, claim_type, claim_value, confidence,
          signature, expires_at, audit_hash)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9)`,
        [claimId, did, did, parse.data.claim_type,
         JSON.stringify(parse.data.claim_value),
         parse.data.confidence ?? 1.0,
         parse.data.signature || null,
         parse.data.expires_at ? new Date(parse.data.expires_at) : null,
         entry.hash]
      );

      const response = {
        claim_id: claimId, subject_did: did, issuer_did: did,
        claim_type: parse.data.claim_type, claim_value: parse.data.claim_value,
        confidence: parse.data.confidence ?? 1.0,
        expires_at: parse.data.expires_at || null,
        audit_hash: entry.hash
      };
      await recordIdempotency(pool, did, idemKey, 'kyc-claim', response);
      return res.status(201).json(response);
    } catch (e) {
      console.error('[kyc.claim]', e);
      return res.status(500).json({ error: 'claim_failed', message: e.message });
    }
  });

  // GET /v1/agents/:did/kyc/claims
  app.get('/v1/agents/:did/kyc/claims', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(
      `SELECT claim_id, subject_did, issuer_did, claim_type, claim_value, confidence,
              signature, expires_at, revoked_at, audit_hash, created_at
       FROM kyc_claims
       WHERE subject_did = $1 AND revoked_at IS NULL
       ORDER BY created_at DESC LIMIT 500`,
      [did]
    ).catch(() => ({ rows: [] }));
    return res.json({ claims: r.rows, count: r.rows.length });
  });

  // POST /v1/agents/:did/kyc/attestations — issuer attests for subject
  const AttestationSchema = z.object({
    issuer_did: z.string(),
    claim_type: z.enum(CLAIM_TYPES),
    claim_value: z.any(),
    confidence: z.number().min(0).max(1).optional(),
    expires_at: z.string().datetime().optional(),
    signature: z.string().optional()
  });

  app.post('/v1/agents/:did/kyc/attestations', express.json(), async (req, res) => {
    try {
      const subjectDid = req.params.did;
      const parse = AttestationSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const { issuer_did, claim_type, claim_value, confidence, expires_at, signature } = parse.data;

      // Issuer must authenticate
      const auth = await verifyAgentAuth(req, issuer_did, { strictSignatureRequired: true });
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      if (issuer_did === subjectDid) {
        return res.status(400).json({ error: 'self_attestation_not_allowed_use_claims_endpoint' });
      }

      const idemKey = req.headers['x-idempotency-key'];
      const cached = await checkIdempotency(pool, issuer_did, idemKey, 'kyc-attest');
      if (cached) return res.json(cached);

      const claimId = genId('att');
      const entry = await auditChain.append({
        event_type: 'kyc.attestation_added',
        subject_did: subjectDid,
        issuer_did,
        claim_type,
        timestamp: new Date().toISOString()
      });

      await pool.query(
        `INSERT INTO kyc_claims
         (claim_id, subject_did, issuer_did, claim_type, claim_value, confidence,
          signature, expires_at, audit_hash)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9)`,
        [claimId, subjectDid, issuer_did, claim_type,
         JSON.stringify(claim_value), confidence ?? 0.9,
         signature || null,
         expires_at ? new Date(expires_at) : null,
         entry.hash]
      );

      const response = {
        claim_id: claimId, subject_did: subjectDid, issuer_did,
        claim_type, claim_value, confidence: confidence ?? 0.9,
        expires_at: expires_at || null, audit_hash: entry.hash
      };
      await recordIdempotency(pool, issuer_did, idemKey, 'kyc-attest', response);
      return res.status(201).json(response);
    } catch (e) {
      console.error('[kyc.attest]', e);
      return res.status(500).json({ error: 'attestation_failed', message: e.message });
    }
  });

  // GET /v1/agents/:did/kyc/verify — composite verdict
  app.get('/v1/agents/:did/kyc/verify', async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const claimsR = await pool.query(
        `SELECT claim_type, claim_value, confidence, issuer_did, expires_at
         FROM kyc_claims
         WHERE subject_did = $1 AND revoked_at IS NULL
           AND (expires_at IS NULL OR expires_at > NOW())`,
        [did]
      ).catch(() => ({ rows: [] }));
      const claims = claimsR.rows;
      const claimTypes = new Set(claims.map(c => c.claim_type));
      const sanctionsClearClaim = claims.find(c => c.claim_type === 'sanctions_clear');

      // Pull operator/jurisdiction names for sanctions match
      const matched = [];
      for (const claim of claims) {
        const v = claim.claim_value;
        const names = [];
        if (typeof v === 'string') names.push(v);
        else if (v && typeof v === 'object') {
          if (v.name) names.push(v.name);
          if (v.operator_name) names.push(v.operator_name);
          if (v.legal_name) names.push(v.legal_name);
        }
        for (const n of names) {
          const hits = await matchSanctions(pool, n, v?.country || null);
          for (const h of hits) matched.push({ claim_type: claim.claim_type, ...h });
        }
      }

      const requiredClaims = ['jurisdiction', 'operator', 'agent_purpose', 'human_in_loop'];
      const missing = requiredClaims.filter(rt => !claimTypes.has(rt));

      let result;
      if (matched.length > 0) result = 'flagged';
      else if (missing.length > 0) result = 'incomplete';
      else result = 'clear';

      const verificationId = genId('vrf');
      const entry = await auditChain.append({
        event_type: 'kyc.verification',
        subject_did: did,
        result,
        matched_count: matched.length,
        missing_claims: missing,
        timestamp: new Date().toISOString()
      });

      await pool.query(
        `INSERT INTO kyc_verifications
         (verification_id, subject_did, result, matched_claims, matched_sanctions, audit_hash)
         VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6)`,
        [verificationId, did, result,
         JSON.stringify(claims.map(c => ({ type: c.claim_type, issuer: c.issuer_did }))),
         JSON.stringify(matched), entry.hash]
      );

      return res.json({
        verification_id: verificationId,
        subject_did: did,
        result,
        claim_count: claims.length,
        claim_types: Array.from(claimTypes),
        missing_required_claims: missing,
        sanctions_clear_self_attested: !!sanctionsClearClaim,
        matched_sanctions: matched,
        audit_hash: entry.hash
      });
    } catch (e) {
      console.error('[kyc.verify]', e);
      return res.status(500).json({ error: 'verify_failed', message: e.message });
    }
  });

  // POST /v1/kyc/sanctions/check
  const CheckSchema = z.object({
    name: z.string().min(1).max(500),
    country: z.string().max(100).optional()
  });

  app.post('/v1/kyc/sanctions/check', express.json(), async (req, res) => {
    try {
      const parse = CheckSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const hits = await matchSanctions(pool, parse.data.name, parse.data.country);
      return res.json({
        query: parse.data,
        matched: hits.length > 0,
        match_count: hits.length,
        matches: hits
      });
    } catch (e) {
      console.error('[kyc.sanctions.check]', e);
      return res.status(500).json({ error: 'check_failed', message: e.message });
    }
  });

  // POST /v1/_jobs/refresh-sanctions
  require('../cron_auth').registerCron(app, '/v1/_jobs/refresh-sanctions', async (req, res) => {
    try {
      const result = await refreshSanctions(pool);
      return res.json({ ok: true, ...result });
    } catch (e) {
      console.error('[kyc.refresh-sanctions]', e);
      return res.status(500).json({ ok: false, error: e.message });
    }
  });
}

module.exports = {
  migrate,
  registerKycRoutes,
  refreshSanctions,
  parseOfacSdnCsv,
  parseUnConsolidatedXml,
  matchSanctions,
  CLAIM_TYPES
};
