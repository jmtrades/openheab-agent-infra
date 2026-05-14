// ============================================================================
// OpenHeab KYC Extensions — Tiered KYC, PEP, UK HMT, EU CFSP, Appeals, Re-screening
// Tables: kyc_tiers, kyc_pep_list, kyc_appeals, kyc_rescreen_log
// External lists: UK HMT (XML), EU CFSP (XML), OpenSanctions PEP (CSV)
// ============================================================================
const cryptoLib = require('crypto');
const express = require('express');
const { z } = require('zod');

const TIER_LIMITS = {
  0: { daily: '100000000', monthly: '1000000000' },
  1: { daily: '1000000000', monthly: '10000000000' },
  2: { daily: '10000000000', monthly: '100000000000' },
  3: { daily: '100000000000', monthly: '1000000000000' },
  4: { daily: null, monthly: null }
};

const UK_HMT_URL = 'https://ofsistorage.blob.core.windows.net/publishlive/2022format/ConList.xml';
const EU_CFSP_URL = 'https://webgate.ec.europa.eu/fsd/fsf/public/files/xmlFullSanctionsList_1_1/content?token=dG9rZW4tMjAxNw';
const OPEN_SANCTIONS_PEP_URL = 'https://data.opensanctions.org/datasets/latest/peps/targets.simple.csv';

// ----------------------------------------------------------------------------
// Migration
// ----------------------------------------------------------------------------
async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS kyc_tiers (
      agent_did      TEXT PRIMARY KEY,
      tier           SMALLINT NOT NULL DEFAULT 0,
      reason         TEXT,
      upgraded_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      reviewed_by    TEXT,
      next_review_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS kyc_pep_list (
      id             TEXT PRIMARY KEY,
      name           TEXT NOT NULL,
      aliases        TEXT[],
      country        TEXT,
      position       TEXT,
      categories     TEXT[],
      last_seen      TIMESTAMPTZ,
      raw            JSONB,
      ingested_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_kyc_pep_name ON kyc_pep_list (lower(name));

    CREATE TABLE IF NOT EXISTS kyc_appeals (
      appeal_id        TEXT PRIMARY KEY,
      agent_did        TEXT NOT NULL,
      verification_id  TEXT,
      reason           TEXT NOT NULL,
      evidence         JSONB,
      status           TEXT NOT NULL DEFAULT 'pending',
      reviewer_did     TEXT,
      review_notes     TEXT,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      resolved_at      TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_kyc_appeals_agent ON kyc_appeals (agent_did);
    CREATE INDEX IF NOT EXISTS idx_kyc_appeals_status ON kyc_appeals (status);

    CREATE TABLE IF NOT EXISTS kyc_rescreen_log (
      log_id       TEXT PRIMARY KEY,
      agent_did    TEXT NOT NULL,
      result       TEXT NOT NULL,
      delta        JSONB,
      audit_hash   TEXT,
      ran_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_kyc_rescreen_agent ON kyc_rescreen_log (agent_did, ran_at DESC);

    CREATE TABLE IF NOT EXISTS kyc_ext_idempotency (
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

function normalizeName(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

async function checkIdempotency(pool, agentDid, key, scope) {
  if (!key) return null;
  const r = await pool.query(
    `SELECT response FROM kyc_ext_idempotency WHERE agent_did=$1 AND scope=$2 AND idem_key=$3`,
    [agentDid, scope, key]
  ).catch(() => ({ rows: [] }));
  return r.rows[0]?.response || null;
}

async function recordIdempotency(pool, agentDid, key, scope, response) {
  if (!key) return;
  await pool.query(
    `INSERT INTO kyc_ext_idempotency (agent_did, scope, idem_key, response)
     VALUES ($1,$2,$3,$4::jsonb) ON CONFLICT DO NOTHING`,
    [agentDid, scope, key, JSON.stringify(response)]
  ).catch(() => {});
}

async function fetchText(url, timeoutMs = 120000) {
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

// ----------------------------------------------------------------------------
// UK HMT parser (ConList.xml)
// ----------------------------------------------------------------------------
function parseUkHmtXml(text) {
  const records = [];
  const re = /<FinancialSanctionsTarget\b[\s\S]*?<\/FinancialSanctionsTarget>/gi;
  const tag = (block, name) => {
    const m = block.match(new RegExp(`<${name}>([\\s\\S]*?)<\\/${name}>`, 'i'));
    return m ? m[1].trim() : null;
  };
  let m;
  while ((m = re.exec(text))) {
    const block = m[0];
    const id = tag(block, 'GroupID') || tag(block, 'TargetID') ||
               cryptoLib.createHash('sha256').update(block).digest('hex').slice(0, 24);
    const name1 = tag(block, 'Name6') || tag(block, 'Name1') || '';
    const surname = tag(block, 'Name6') || '';
    const first = tag(block, 'Name1') || '';
    const second = tag(block, 'Name2') || '';
    const third = tag(block, 'Name3') || '';
    const orgName = tag(block, 'Name1');
    const grpType = (tag(block, 'GroupTypeDescription') || '').toLowerCase();
    let name;
    if (grpType.includes('entity') || grpType.includes('organisation')) {
      name = orgName || name1;
    } else {
      name = [first, second, third, surname].filter(Boolean).join(' ').trim() || name1;
    }
    if (!name) continue;
    const country = tag(block, 'CountryOfBirth') || tag(block, 'Nationality') || null;
    const regimeStr = tag(block, 'RegimeName') || tag(block, 'Regime') || '';
    records.push({
      list_source: 'UK_HMT',
      list_id: id,
      name,
      aliases: [],
      country,
      type: grpType.includes('entity') ? 'entity' : 'individual',
      programs: regimeStr ? [regimeStr] : [],
      raw: { regime: regimeStr, group_type: grpType }
    });
  }
  return records;
}

// ----------------------------------------------------------------------------
// EU CFSP parser (xmlFullSanctionsList_1_1)
// ----------------------------------------------------------------------------
function parseEuCfspXml(text) {
  const records = [];
  const re = /<sanctionEntity\b[\s\S]*?<\/sanctionEntity>/gi;
  const idRe = /logicalId="(\d+)"/;
  const nameRe = /<nameAlias[^>]*\bwholeName="([^"]+)"/gi;
  const countryRe = /<citizenship[^>]*\bcountryDescription="([^"]+)"/i;
  const programRe = /<regulation[^>]*\bprogramme="([^"]+)"/gi;
  let m;
  while ((m = re.exec(text))) {
    const block = m[0];
    const idMatch = idRe.exec(block);
    const id = idMatch ? idMatch[1] : cryptoLib.createHash('sha256').update(block).digest('hex').slice(0, 24);
    const names = [];
    let nm;
    nameRe.lastIndex = 0;
    while ((nm = nameRe.exec(block))) names.push(nm[1]);
    if (!names.length) continue;
    const name = names[0];
    const aliases = names.slice(1);
    const country = (countryRe.exec(block) || [])[1] || null;
    const programs = [];
    let pm;
    programRe.lastIndex = 0;
    while ((pm = programRe.exec(block))) programs.push(pm[1]);
    const type = /subjectType="P"/i.test(block) ? 'individual' : 'entity';
    records.push({
      list_source: 'EU_CFSP',
      list_id: id,
      name,
      aliases,
      country,
      type,
      programs,
      raw: { logical_id: id, type, names_count: names.length }
    });
  }
  return records;
}

// ----------------------------------------------------------------------------
// OpenSanctions PEP parser (targets.simple.csv)
// ----------------------------------------------------------------------------
function parseOpenSanctionsPepCsv(text) {
  const records = [];
  const lines = text.split(/\r?\n/);
  if (!lines.length) return records;
  const header = parseCsvLine(lines[0]).map(s => s.trim().toLowerCase());
  const idxOf = (name) => header.indexOf(name);
  const iId = idxOf('id');
  const iName = idxOf('name');
  const iAliases = idxOf('aliases');
  const iCountry = idxOf('countries');
  const iCategories = idxOf('topics');
  const iPosition = idxOf('positions');
  const iLastSeen = idxOf('last_seen');

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const cols = parseCsvLine(line);
    if (cols.length < 2) continue;
    const id = (iId >= 0 ? cols[iId] : `pep-${i}`).trim();
    const name = (iName >= 0 ? cols[iName] : cols[0]).trim();
    if (!id || !name) continue;
    const aliasesStr = iAliases >= 0 ? cols[iAliases] : '';
    const countryStr = iCountry >= 0 ? cols[iCountry] : '';
    const categoriesStr = iCategories >= 0 ? cols[iCategories] : '';
    const position = iPosition >= 0 ? cols[iPosition] : '';
    const lastSeen = iLastSeen >= 0 ? cols[iLastSeen] : '';
    records.push({
      id,
      name,
      aliases: aliasesStr ? aliasesStr.split(/\s*;\s*/).filter(Boolean) : [],
      country: countryStr || null,
      position: position || null,
      categories: categoriesStr ? categoriesStr.split(/\s*;\s*/).filter(Boolean) : [],
      last_seen: lastSeen || null,
      raw: { id, name }
    });
  }
  return records;
}

// ----------------------------------------------------------------------------
// Ingestion (kyc_sanctions_list)
// ----------------------------------------------------------------------------
async function ingestSanctions(pool, source, records) {
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

  await pool.query(
    `INSERT INTO kyc_sanctions_meta (list_source, last_refresh_at, record_count, raw_size_bytes, last_error)
     VALUES ($1, NOW(), $2, $3, NULL)
     ON CONFLICT (list_source) DO UPDATE SET last_refresh_at=NOW(),
       record_count=EXCLUDED.record_count, raw_size_bytes=EXCLUDED.raw_size_bytes,
       last_error=NULL`,
    [source, inserted, null]
  ).catch(() => {});

  return inserted;
}

async function ingestPep(pool, records) {
  if (!records.length) return 0;
  const client = await pool.connect().catch(() => null);
  const exec = client || pool;
  let inserted = 0;
  try {
    if (client) await client.query('BEGIN');
    await exec.query(`DELETE FROM kyc_pep_list`);
    const chunk = 500;
    for (let i = 0; i < records.length; i += chunk) {
      const slice = records.slice(i, i + chunk);
      const values = [];
      const params = [];
      let p = 1;
      for (const rec of slice) {
        values.push(`($${p++},$${p++},$${p++}::text[],$${p++},$${p++},$${p++}::text[],$${p++},$${p++}::jsonb,NOW())`);
        params.push(
          rec.id, rec.name, rec.aliases || [],
          rec.country || null, rec.position || null,
          rec.categories || [], rec.last_seen ? new Date(rec.last_seen) : null,
          JSON.stringify(rec.raw || {})
        );
      }
      await exec.query(
        `INSERT INTO kyc_pep_list
         (id, name, aliases, country, position, categories, last_seen, raw, ingested_at)
         VALUES ${values.join(',')}
         ON CONFLICT (id) DO UPDATE SET
           name=EXCLUDED.name, aliases=EXCLUDED.aliases, country=EXCLUDED.country,
           position=EXCLUDED.position, categories=EXCLUDED.categories,
           last_seen=EXCLUDED.last_seen, raw=EXCLUDED.raw, ingested_at=NOW()`,
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

async function refreshUkHmt(pool) {
  const txt = await fetchText(UK_HMT_URL);
  const recs = parseUkHmtXml(txt);
  const count = await ingestSanctions(pool, 'UK_HMT', recs);
  return { source: 'UK_HMT', count, size: txt.length };
}

async function refreshEu(pool) {
  const txt = await fetchText(EU_CFSP_URL);
  const recs = parseEuCfspXml(txt);
  const count = await ingestSanctions(pool, 'EU_CFSP', recs);
  return { source: 'EU_CFSP', count, size: txt.length };
}

async function refreshPep(pool) {
  const txt = await fetchText(OPEN_SANCTIONS_PEP_URL);
  const recs = parseOpenSanctionsPepCsv(txt);
  const count = await ingestPep(pool, recs);
  return { source: 'OPENSANCTIONS_PEP', count, size: txt.length };
}

// ----------------------------------------------------------------------------
// Tier computation
// ----------------------------------------------------------------------------
async function computeTier(pool, agentDid) {
  const claimsR = await pool.query(
    `SELECT claim_type, issuer_did
     FROM kyc_claims
     WHERE subject_did = $1 AND revoked_at IS NULL
       AND (expires_at IS NULL OR expires_at > NOW())`,
    [agentDid]
  ).catch(() => ({ rows: [] }));
  const claims = claimsR.rows;
  const totalClaims = claims.length;
  const thirdParty = claims.filter(c => c.issuer_did && c.issuer_did !== agentDid).length;
  const hasSanctionsClear = claims.some(c => c.claim_type === 'sanctions_clear');

  // Sanctions hits?
  const verR = await pool.query(
    `SELECT result, matched_sanctions FROM kyc_verifications
     WHERE subject_did = $1 ORDER BY created_at DESC LIMIT 1`,
    [agentDid]
  ).catch(() => ({ rows: [] }));
  const latest = verR.rows[0];
  const flagged = latest && latest.result === 'flagged';

  if (flagged) return 0;
  if (totalClaims === 0) return 0;

  let tier = 0;
  // Tier 1: at least 3 self-claims
  if (totalClaims >= 3) tier = 1;
  // Tier 2: + 1 third-party attestation
  if (totalClaims >= 3 && thirdParty >= 1) tier = 2;
  // Tier 3: + 2 third-party attestations + sanctions_clear
  if (totalClaims >= 5 && thirdParty >= 2 && hasSanctionsClear) tier = 3;
  // Tier 4: + many claims + many attestors + clear verification
  if (totalClaims >= 8 && thirdParty >= 3 && hasSanctionsClear &&
      latest && latest.result === 'clear') tier = 4;
  return tier;
}

// ----------------------------------------------------------------------------
// Periodic re-screening
// ----------------------------------------------------------------------------
async function rescreenAgents(pool, auditChain, { limit = 100 } = {}) {
  // Pick agents with oldest last verification (or no verification)
  const candR = await pool.query(`
    SELECT DISTINCT i.did AS agent_did
    FROM identities i
    LEFT JOIN (
      SELECT subject_did, MAX(created_at) AS last_ver
      FROM kyc_verifications GROUP BY subject_did
    ) v ON v.subject_did = i.did
    WHERE v.last_ver IS NULL OR v.last_ver < NOW() - INTERVAL '30 days'
    ORDER BY v.last_ver NULLS FIRST
    LIMIT $1
  `, [limit]).catch(() => ({ rows: [] }));

  let processed = 0;
  const results = [];
  for (const row of candR.rows) {
    const agentDid = row.agent_did;
    try {
      const claimsR = await pool.query(
        `SELECT claim_type, claim_value FROM kyc_claims
         WHERE subject_did = $1 AND revoked_at IS NULL
           AND (expires_at IS NULL OR expires_at > NOW())`,
        [agentDid]
      );
      const matched = [];
      for (const c of claimsR.rows) {
        const v = c.claim_value;
        const names = [];
        if (typeof v === 'string') names.push(v);
        else if (v && typeof v === 'object') {
          if (v.name) names.push(v.name);
          if (v.operator_name) names.push(v.operator_name);
          if (v.legal_name) names.push(v.legal_name);
        }
        for (const n of names) {
          if (!n) continue;
          const norm = normalizeName(n);
          const hits = await pool.query(`
            SELECT list_source, list_id, name FROM kyc_sanctions_list
            WHERE lower(name) LIKE $1
            LIMIT 5
          `, [`%${norm}%`]).catch(() => ({ rows: [] }));
          for (const h of hits.rows) matched.push({ claim_type: c.claim_type, ...h });
        }
      }
      const result = matched.length > 0 ? 'flagged' : 'clear';
      const logId = genId('rsc');
      const entry = await auditChain.append({
        event_type: 'kyc.rescreen',
        agent_did: agentDid,
        result, match_count: matched.length,
        timestamp: new Date().toISOString()
      });
      await pool.query(
        `INSERT INTO kyc_rescreen_log (log_id, agent_did, result, delta, audit_hash)
         VALUES ($1,$2,$3,$4::jsonb,$5)`,
        [logId, agentDid, result, JSON.stringify({ matched }), entry.hash]
      );
      processed++;
      results.push({ agent_did: agentDid, result, hits: matched.length });
    } catch (e) {
      results.push({ agent_did: agentDid, error: e.message });
    }
  }
  return { processed, results };
}

// ----------------------------------------------------------------------------
// Routes
// ----------------------------------------------------------------------------
function registerKycExtensionRoutes(app, pool, verifyAgentAuth, auditChain) {
  // GET /v1/agents/:did/kyc/tier
  app.get('/v1/agents/:did/kyc/tier', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });

    const r = await pool.query(
      `SELECT agent_did, tier, reason, upgraded_at, reviewed_by, next_review_at
       FROM kyc_tiers WHERE agent_did = $1`, [did]
    ).catch(() => ({ rows: [] }));
    let row = r.rows[0];
    if (!row) {
      const computed = await computeTier(pool, did);
      row = { agent_did: did, tier: computed, reason: 'computed',
              upgraded_at: null, reviewed_by: null, next_review_at: null };
    }
    return res.json({
      ...row,
      limits: TIER_LIMITS[row.tier] || TIER_LIMITS[0]
    });
  });

  // POST /v1/agents/:did/kyc/tier — request recompute or admin override
  const TierSchema = z.object({
    tier: z.number().int().min(0).max(4).optional(),
    reason: z.string().max(500).optional(),
    reviewed_by: z.string().optional(),
    next_review_at: z.string().datetime().optional()
  });

  app.post('/v1/agents/:did/kyc/tier', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const parse = TierSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });

      const idemKey = req.headers['x-idempotency-key'];
      const cached = await checkIdempotency(pool, did, idemKey, 'tier-set');
      if (cached) return res.json(cached);

      // Recompute unless explicit tier supplied by admin
      const isAdmin = req.headers['x-admin-token'] === process.env.OPERATOR_ADMIN_TOKEN;
      let tier;
      if (parse.data.tier !== undefined && isAdmin) {
        tier = parse.data.tier;
      } else {
        tier = await computeTier(pool, did);
      }
      const reason = parse.data.reason || (isAdmin ? 'admin_override' : 'computed');
      const nextReview = parse.data.next_review_at
        ? new Date(parse.data.next_review_at)
        : new Date(Date.now() + 90 * 24 * 3600 * 1000);

      await pool.query(`
        INSERT INTO kyc_tiers (agent_did, tier, reason, upgraded_at, reviewed_by, next_review_at)
        VALUES ($1,$2,$3,NOW(),$4,$5)
        ON CONFLICT (agent_did) DO UPDATE SET
          tier = EXCLUDED.tier, reason = EXCLUDED.reason,
          upgraded_at = NOW(), reviewed_by = EXCLUDED.reviewed_by,
          next_review_at = EXCLUDED.next_review_at
      `, [did, tier, reason, parse.data.reviewed_by || null, nextReview]);

      await auditChain.append({
        event_type: 'kyc.tier_changed',
        agent_did: did, tier, reason,
        timestamp: new Date().toISOString()
      });

      const response = {
        agent_did: did, tier, reason,
        upgraded_at: new Date().toISOString(),
        next_review_at: nextReview.toISOString(),
        limits: TIER_LIMITS[tier]
      };
      await recordIdempotency(pool, did, idemKey, 'tier-set', response);
      return res.json(response);
    } catch (e) {
      console.error('[kyc.tier]', e);
      return res.status(500).json({ error: 'tier_failed', message: e.message });
    }
  });

  // POST /v1/agents/:did/kyc/appeal
  const AppealSchema = z.object({
    verification_id: z.string().optional(),
    reason: z.string().min(1).max(5000),
    evidence: z.any().optional()
  });

  app.post('/v1/agents/:did/kyc/appeal', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const parse = AppealSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });

      const idemKey = req.headers['x-idempotency-key'];
      const cached = await checkIdempotency(pool, did, idemKey, 'kyc-appeal');
      if (cached) return res.json(cached);

      const appealId = genId('apl');
      const entry = await auditChain.append({
        event_type: 'kyc.appeal_filed',
        agent_did: did,
        verification_id: parse.data.verification_id || null,
        timestamp: new Date().toISOString()
      });

      await pool.query(
        `INSERT INTO kyc_appeals
         (appeal_id, agent_did, verification_id, reason, evidence, status)
         VALUES ($1,$2,$3,$4,$5::jsonb,'pending')`,
        [appealId, did, parse.data.verification_id || null,
         parse.data.reason, JSON.stringify(parse.data.evidence || {})]
      );

      const response = {
        appeal_id: appealId, agent_did: did, status: 'pending',
        verification_id: parse.data.verification_id || null,
        reason: parse.data.reason, audit_hash: entry.hash
      };
      await recordIdempotency(pool, did, idemKey, 'kyc-appeal', response);
      return res.status(201).json(response);
    } catch (e) {
      console.error('[kyc.appeal]', e);
      return res.status(500).json({ error: 'appeal_failed', message: e.message });
    }
  });

  // GET /v1/agents/:did/kyc/appeals
  app.get('/v1/agents/:did/kyc/appeals', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(
      `SELECT appeal_id, agent_did, verification_id, reason, evidence, status,
              reviewer_did, review_notes, created_at, resolved_at
       FROM kyc_appeals WHERE agent_did = $1
       ORDER BY created_at DESC LIMIT 200`,
      [did]
    ).catch(() => ({ rows: [] }));
    return res.json({ appeals: r.rows, count: r.rows.length });
  });

  // Crons
  const { registerCron } = require('../cron_auth');

  registerCron(app, '/v1/_jobs/refresh-uk-hmt', async (req, res) => {
    try {
      const result = await refreshUkHmt(pool);
      return res.json({ ok: true, ...result });
    } catch (e) {
      console.error('[kyc.uk-hmt]', e);
      return res.status(500).json({ ok: false, error: e.message });
    }
  });

  registerCron(app, '/v1/_jobs/refresh-eu', async (req, res) => {
    try {
      const result = await refreshEu(pool);
      return res.json({ ok: true, ...result });
    } catch (e) {
      console.error('[kyc.eu]', e);
      return res.status(500).json({ ok: false, error: e.message });
    }
  });

  registerCron(app, '/v1/_jobs/refresh-pep', async (req, res) => {
    try {
      const result = await refreshPep(pool);
      return res.json({ ok: true, ...result });
    } catch (e) {
      console.error('[kyc.pep]', e);
      return res.status(500).json({ ok: false, error: e.message });
    }
  });

  registerCron(app, '/v1/_jobs/rescreen-agents', async (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit) || 100, 1000);
      const result = await rescreenAgents(pool, auditChain, { limit });
      return res.json({ ok: true, ...result });
    } catch (e) {
      console.error('[kyc.rescreen]', e);
      return res.status(500).json({ ok: false, error: e.message });
    }
  });
}

module.exports = {
  migrate,
  registerKycExtensionRoutes,
  computeTier,
  refreshUkHmt,
  refreshEu,
  refreshPep,
  rescreenAgents,
  parseUkHmtXml,
  parseEuCfspXml,
  parseOpenSanctionsPepCsv,
  TIER_LIMITS
};
