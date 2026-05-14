// ============================================================================
// OpenHeab Security — Prompt injection, PII, and secret scanners
// Verdicts: allow / redact / block based on severity.
// ============================================================================
const cryptoLib = require('crypto');
const express = require('express');
const { z } = require('zod');

// ----------------------------------------------------------------------------
// Prompt-injection patterns (15)
// ----------------------------------------------------------------------------
const INJECTION_PATTERNS = [
  { id: 'ignore_previous',       re: /ignore\s+(all\s+)?previous\s+(instructions|prompts|rules)/i, severity: 'high' },
  { id: 'disregard_above',       re: /disregard\s+(the\s+)?(above|prior|previous)/i, severity: 'high' },
  { id: 'forget_instructions',   re: /forget\s+(all\s+)?(your\s+)?(prior\s+)?(instructions|rules|prompts)/i, severity: 'high' },
  { id: 'system_override',       re: /<\s*\/?\s*system\s*>/i, severity: 'medium' },
  { id: 'role_swap',             re: /you\s+are\s+now\s+(a\s+)?(?:dan|jailbroken|unrestricted|developer)/i, severity: 'high' },
  { id: 'dan_jailbreak',         re: /\b(dan|jailbreak|do\s+anything\s+now)\b/i, severity: 'high' },
  { id: 'reveal_system_prompt',  re: /(reveal|show|print|leak|output)\s+(your\s+)?(system\s+)?(prompt|instructions)/i, severity: 'high' },
  { id: 'print_secrets',         re: /(print|output|show)\s+(all\s+)?(api[\s_-]?keys?|secrets?|credentials?|tokens?)/i, severity: 'critical' },
  { id: 'execute_arbitrary',     re: /execute\s+(arbitrary|the\s+following|this)\s+(code|command|script)/i, severity: 'critical' },
  { id: 'shell_command',         re: /\b(sudo|rm\s+-rf|curl\s+.*\|\s*(sh|bash))\b/i, severity: 'critical' },
  { id: 'override_safety',       re: /override\s+(your\s+)?(safety|filters?|guardrails?)/i, severity: 'high' },
  { id: 'pretend_to_be',         re: /pretend\s+(to\s+be|you\s+are)\s+(?!.*helpful)/i, severity: 'medium' },
  { id: 'admin_mode',            re: /(activate|enable|enter)\s+(admin|developer|debug|root)\s+mode/i, severity: 'high' },
  { id: 'new_instruction',       re: /new\s+instructions?\s*:\s*/i, severity: 'medium' },
  { id: 'translate_to_evil',     re: /translate\s+the\s+following\s+into\s+(?:malicious|harmful)/i, severity: 'medium' }
];

// ----------------------------------------------------------------------------
// PII detectors (7)
// ----------------------------------------------------------------------------
const PII_DETECTORS = {
  email: {
    re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    redact: () => '[REDACTED_EMAIL]'
  },
  phone: {
    re: /(?:\+?\d{1,3}[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/g,
    redact: () => '[REDACTED_PHONE]'
  },
  ssn: {
    re: /\b\d{3}-\d{2}-\d{4}\b/g,
    redact: () => '[REDACTED_SSN]'
  },
  credit_card: {
    re: /\b(?:\d[ -]*?){13,19}\b/g,
    redact: () => '[REDACTED_CC]',
    validate: (match) => luhnValid(match.replace(/\D/g, ''))
  },
  ip_address: {
    re: /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/g,
    redact: () => '[REDACTED_IP]'
  },
  iban: {
    re: /\b[A-Z]{2}\d{2}[A-Z0-9]{4,30}\b/g,
    redact: () => '[REDACTED_IBAN]'
  },
  passport: {
    re: /\b[A-PR-WY][1-9]\d\s?\d{4}[1-9]\b|\b[A-Z]{1,2}\d{6,9}\b/g,
    redact: () => '[REDACTED_PASSPORT]'
  }
};

function luhnValid(num) {
  if (!/^\d{13,19}$/.test(num)) return false;
  let sum = 0, dbl = false;
  for (let i = num.length - 1; i >= 0; i--) {
    let d = parseInt(num[i], 10);
    if (dbl) { d *= 2; if (d > 9) d -= 9; }
    sum += d; dbl = !dbl;
  }
  return sum % 10 === 0;
}

// ----------------------------------------------------------------------------
// Secret detectors (10)
// ----------------------------------------------------------------------------
const SECRET_DETECTORS = [
  { id: 'openheab_api',   re: /\bopk_[a-f0-9]{32,64}\b/g,                      severity: 'critical' },
  { id: 'stripe_secret',  re: /\bsk_(?:test_|live_)?[A-Za-z0-9]{20,}\b/g,      severity: 'critical' },
  { id: 'stripe_publish', re: /\bpk_(?:test_|live_)?[A-Za-z0-9]{20,}\b/g,      severity: 'medium' },
  { id: 'anthropic',      re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,                severity: 'critical' },
  { id: 'openai',         re: /\bsk-[A-Za-z0-9]{20,}\b/g,                      severity: 'critical' },
  { id: 'aws_access',     re: /\bAKIA[0-9A-Z]{16}\b/g,                         severity: 'critical' },
  { id: 'github_pat',     re: /\bgh[ps]_[A-Za-z0-9]{20,}\b/g,                  severity: 'critical' },
  { id: 'jwt',            re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, severity: 'high' },
  { id: 'private_key',    re: /-----BEGIN (RSA |EC |DSA )?PRIVATE KEY-----/g,  severity: 'critical' },
  { id: 'ed25519_pem',    re: /-----BEGIN ED25519 PRIVATE KEY-----/g,          severity: 'critical' }
];

// ----------------------------------------------------------------------------
// Scanner functions
// ----------------------------------------------------------------------------
function scanInjection(text) {
  const t = String(text || '');
  const hits = [];
  for (const p of INJECTION_PATTERNS) {
    const m = t.match(p.re);
    if (m) hits.push({ id: p.id, severity: p.severity, match: m[0].slice(0, 200) });
  }
  const maxSeverity = severityRank(hits);
  return { detected: hits.length > 0, hits, max_severity: maxSeverity };
}

function scanPii(text, kinds = null) {
  const t = String(text || '');
  const hits = [];
  const enabled = kinds && Array.isArray(kinds) ? kinds : Object.keys(PII_DETECTORS);
  for (const kind of enabled) {
    const det = PII_DETECTORS[kind];
    if (!det) continue;
    const matches = t.matchAll(new RegExp(det.re.source, det.re.flags));
    for (const m of matches) {
      if (det.validate && !det.validate(m[0])) continue;
      hits.push({ kind, match: m[0], offset: m.index });
    }
  }
  return { detected: hits.length > 0, hits, kinds_scanned: enabled };
}

function scanSecrets(text) {
  const t = String(text || '');
  const hits = [];
  for (const d of SECRET_DETECTORS) {
    const matches = t.matchAll(new RegExp(d.re.source, d.re.flags));
    for (const m of matches) {
      hits.push({
        id: d.id, severity: d.severity, match: m[0].slice(0, 8) + '…',
        full_hash: cryptoLib.createHash('sha256').update(m[0]).digest('hex').slice(0, 16),
        offset: m.index
      });
    }
  }
  const maxSeverity = severityRank(hits);
  return { detected: hits.length > 0, hits, max_severity: maxSeverity };
}

function redact(text, kinds = null) {
  let t = String(text || '');
  const enabled = kinds && Array.isArray(kinds) ? kinds : Object.keys(PII_DETECTORS);

  // PII redaction
  for (const kind of enabled) {
    const det = PII_DETECTORS[kind];
    if (!det) continue;
    t = t.replace(new RegExp(det.re.source, det.re.flags), (match) => {
      if (det.validate && !det.validate(match)) return match;
      return det.redact();
    });
  }

  // Secrets are always redacted regardless of kind list
  for (const d of SECRET_DETECTORS) {
    t = t.replace(new RegExp(d.re.source, d.re.flags), `[REDACTED_${d.id.toUpperCase()}]`);
  }

  return t;
}

function severityRank(hits) {
  const order = ['low', 'medium', 'high', 'critical'];
  let max = 'low';
  for (const h of hits) {
    const sev = h.severity || 'low';
    if (order.indexOf(sev) > order.indexOf(max)) max = sev;
  }
  return hits.length === 0 ? 'none' : max;
}

function decideVerdict({ injection, pii, secrets, policy }) {
  const block = policy?.block_injection ?? true;
  const blockSecrets = policy?.block_secrets ?? true;
  if (secrets.detected && blockSecrets && ['high', 'critical'].includes(secrets.max_severity)) {
    return { verdict: 'block', reason: 'secret_detected' };
  }
  if (injection.detected && block && ['high', 'critical'].includes(injection.max_severity)) {
    return { verdict: 'block', reason: 'prompt_injection_detected' };
  }
  if (pii.detected) return { verdict: 'redact', reason: 'pii_detected' };
  if (injection.detected || secrets.detected) return { verdict: 'redact', reason: 'low_risk' };
  return { verdict: 'allow', reason: null };
}

// ----------------------------------------------------------------------------
// Migration
// ----------------------------------------------------------------------------
async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS security_policies (
      agent_did           TEXT PRIMARY KEY,
      scan_inputs         BOOLEAN NOT NULL DEFAULT TRUE,
      scan_outputs        BOOLEAN NOT NULL DEFAULT TRUE,
      redact_pii_kinds    JSONB NOT NULL DEFAULT '["email","phone","ssn","credit_card","ip_address","iban","passport"]'::jsonb,
      block_secrets       BOOLEAN NOT NULL DEFAULT TRUE,
      block_injection     BOOLEAN NOT NULL DEFAULT TRUE,
      updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS security_threats (
      threat_id     TEXT PRIMARY KEY,
      agent_did     TEXT,
      threat_type   TEXT NOT NULL,
      severity      TEXT NOT NULL,
      details       JSONB,
      input_hash    TEXT,
      verdict       TEXT,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_threats_agent ON security_threats (agent_did, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_threats_type ON security_threats (threat_type);

    CREATE TABLE IF NOT EXISTS security_incidents (
      incident_id     TEXT PRIMARY KEY,
      agent_did       TEXT,
      threat_id       TEXT REFERENCES security_threats(threat_id),
      action_taken    TEXT,
      reviewed_at     TIMESTAMPTZ,
      reviewer_did    TEXT,
      notes           TEXT,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

// ----------------------------------------------------------------------------
// Policy helper
// ----------------------------------------------------------------------------
async function getPolicy(pool, did) {
  const r = await pool.query(`SELECT * FROM security_policies WHERE agent_did=$1`, [did])
    .catch(() => ({ rows: [] }));
  if (r.rows[0]) return r.rows[0];
  return {
    agent_did: did,
    scan_inputs: true, scan_outputs: true,
    redact_pii_kinds: ['email','phone','ssn','credit_card','ip_address','iban','passport'],
    block_secrets: true, block_injection: true
  };
}

async function recordThreat(pool, auditChain, { agentDid, threatType, severity, details, inputHash, verdict }) {
  const threatId = 'thr_' + cryptoLib.randomBytes(12).toString('hex');
  await pool.query(
    `INSERT INTO security_threats
     (threat_id, agent_did, threat_type, severity, details, input_hash, verdict)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)`,
    [threatId, agentDid || null, threatType, severity,
     JSON.stringify(details || {}), inputHash || null, verdict || null]
  ).catch(() => {});
  await auditChain.append({
    event_type: 'security.threat_detected',
    threat_id: threatId, agent_did: agentDid || null,
    threat_type: threatType, severity, verdict,
    timestamp: new Date().toISOString()
  });
  return threatId;
}

// ----------------------------------------------------------------------------
// Routes
// ----------------------------------------------------------------------------
function registerSecurityRoutes(app, pool, verifyAgentAuth, auditChain) {
  const ScanInputSchema = z.object({
    text: z.string().max(200000),
    agent_did: z.string().optional()
  });

  app.post('/v1/security/scan/input', express.json({ limit: '1mb' }), async (req, res) => {
    try {
      const parse = ScanInputSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });

      const policy = parse.data.agent_did ? await getPolicy(pool, parse.data.agent_did) : null;
      const injection = scanInjection(parse.data.text);
      const pii = scanPii(parse.data.text, policy?.redact_pii_kinds);
      const secrets = scanSecrets(parse.data.text);
      const { verdict, reason } = decideVerdict({ injection, pii, secrets, policy });

      const inputHash = cryptoLib.createHash('sha256').update(parse.data.text).digest('hex');

      if (injection.detected || secrets.detected) {
        await recordThreat(pool, auditChain, {
          agentDid: parse.data.agent_did,
          threatType: secrets.detected ? 'secret_leak' : 'prompt_injection',
          severity: secrets.detected ? secrets.max_severity : injection.max_severity,
          details: { injection: injection.hits, secrets: secrets.hits },
          inputHash, verdict
        });
      }

      return res.json({
        verdict, reason,
        injection, pii: { detected: pii.detected, hits: pii.hits.length },
        secrets: { detected: secrets.detected, hits: secrets.hits.length, max_severity: secrets.max_severity },
        redacted: verdict === 'redact' ? redact(parse.data.text, policy?.redact_pii_kinds) : null,
        input_hash: inputHash
      });
    } catch (e) {
      console.error('[security.scan.input]', e);
      return res.status(500).json({ error: 'scan_failed', message: e.message });
    }
  });

  app.post('/v1/security/scan/output', express.json({ limit: '1mb' }), async (req, res) => {
    try {
      const parse = ScanInputSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });

      const policy = parse.data.agent_did ? await getPolicy(pool, parse.data.agent_did) : null;
      const pii = scanPii(parse.data.text, policy?.redact_pii_kinds);
      const secrets = scanSecrets(parse.data.text);
      const { verdict, reason } = decideVerdict({
        injection: { detected: false, hits: [], max_severity: 'none' },
        pii, secrets, policy
      });

      const inputHash = cryptoLib.createHash('sha256').update(parse.data.text).digest('hex');
      if (secrets.detected) {
        await recordThreat(pool, auditChain, {
          agentDid: parse.data.agent_did,
          threatType: 'secret_in_output', severity: secrets.max_severity,
          details: { secrets: secrets.hits }, inputHash, verdict
        });
      }
      return res.json({
        verdict, reason,
        pii: { detected: pii.detected, hits: pii.hits.length },
        secrets: { detected: secrets.detected, hits: secrets.hits.length, max_severity: secrets.max_severity },
        redacted: (verdict === 'redact' || verdict === 'block')
          ? redact(parse.data.text, policy?.redact_pii_kinds) : null,
        input_hash: inputHash
      });
    } catch (e) {
      console.error('[security.scan.output]', e);
      return res.status(500).json({ error: 'scan_failed', message: e.message });
    }
  });

  const PiiScanSchema = z.object({
    text: z.string().max(200000),
    kinds: z.array(z.string()).optional()
  });

  app.post('/v1/security/scan/pii', express.json({ limit: '1mb' }), async (req, res) => {
    const parse = PiiScanSchema.safeParse(req.body || {});
    if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
    const r = scanPii(parse.data.text, parse.data.kinds);
    return res.json(r);
  });

  app.post('/v1/security/redact', express.json({ limit: '1mb' }), async (req, res) => {
    const parse = PiiScanSchema.safeParse(req.body || {});
    if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
    const redacted = redact(parse.data.text, parse.data.kinds);
    return res.json({ redacted, kinds: parse.data.kinds || Object.keys(PII_DETECTORS) });
  });

  app.get('/v1/security/threats', async (req, res) => {
    const did = req.query.agent_did;
    const type = req.query.threat_type;
    const limit = Math.min(parseInt(req.query.limit) || 50, 500);
    const params = [limit];
    const conds = [];
    if (did) { params.push(did); conds.push(`agent_did=$${params.length}`); }
    if (type) { params.push(type); conds.push(`threat_type=$${params.length}`); }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const r = await pool.query(
      `SELECT threat_id, agent_did, threat_type, severity, details, input_hash, verdict, created_at
       FROM security_threats ${where} ORDER BY created_at DESC LIMIT $1`,
      params
    ).catch(() => ({ rows: [] }));
    return res.json({ threats: r.rows, count: r.rows.length });
  });

  const PolicySchema = z.object({
    scan_inputs: z.boolean().optional(),
    scan_outputs: z.boolean().optional(),
    redact_pii_kinds: z.array(z.string()).optional(),
    block_secrets: z.boolean().optional(),
    block_injection: z.boolean().optional()
  });

  app.post('/v1/agents/:did/security/policy', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const parse = PolicySchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;

      await pool.query(
        `INSERT INTO security_policies
         (agent_did, scan_inputs, scan_outputs, redact_pii_kinds, block_secrets, block_injection, updated_at)
         VALUES ($1,
                 COALESCE($2, TRUE),
                 COALESCE($3, TRUE),
                 COALESCE($4::jsonb, '["email","phone","ssn","credit_card","ip_address","iban","passport"]'::jsonb),
                 COALESCE($5, TRUE),
                 COALESCE($6, TRUE),
                 NOW())
         ON CONFLICT (agent_did) DO UPDATE SET
           scan_inputs     = COALESCE($2, security_policies.scan_inputs),
           scan_outputs    = COALESCE($3, security_policies.scan_outputs),
           redact_pii_kinds= COALESCE($4::jsonb, security_policies.redact_pii_kinds),
           block_secrets   = COALESCE($5, security_policies.block_secrets),
           block_injection = COALESCE($6, security_policies.block_injection),
           updated_at      = NOW()`,
        [did,
         d.scan_inputs ?? null, d.scan_outputs ?? null,
         d.redact_pii_kinds ? JSON.stringify(d.redact_pii_kinds) : null,
         d.block_secrets ?? null, d.block_injection ?? null]
      );

      await auditChain.append({
        event_type: 'security.policy_updated', agent_did: did,
        fields: Object.keys(d), timestamp: new Date().toISOString()
      });

      const p = await getPolicy(pool, did);
      return res.json(p);
    } catch (e) {
      console.error('[security.policy.set]', e);
      return res.status(500).json({ error: 'policy_update_failed', message: e.message });
    }
  });

  app.get('/v1/agents/:did/security/policy', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const p = await getPolicy(pool, did);
    return res.json(p);
  });
}

module.exports = {
  migrate,
  registerSecurityRoutes,
  scanInjection,
  scanPii,
  scanSecrets,
  redact,
  decideVerdict,
  INJECTION_PATTERNS,
  PII_DETECTORS,
  SECRET_DETECTORS
};
