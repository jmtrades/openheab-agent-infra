// ============================================================================
// OpenHeab Fraud — Fraud detection + transaction scoring
// ============================================================================
const express = require('express');
const cryptoLib = require('crypto');
const { z } = require('zod');

const RULE_KINDS = ['velocity', 'blacklist', 'anomaly', 'geo', 'device'];
const ACTIONS = ['allow', 'review', 'block'];
const BL_KINDS = ['did', 'address', 'email', 'ip', 'phone'];

async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS fraud_rules (
      rule_id      TEXT PRIMARY KEY,
      name         TEXT NOT NULL,
      kind         TEXT NOT NULL,
      conditions   JSONB NOT NULL DEFAULT '{}'::jsonb,
      action       TEXT NOT NULL DEFAULT 'review',
      weight       INTEGER NOT NULL DEFAULT 10,
      active       BOOLEAN NOT NULL DEFAULT TRUE,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_fraud_rules_active ON fraud_rules (active);

    CREATE TABLE IF NOT EXISTS fraud_checks (
      check_id          TEXT PRIMARY KEY,
      agent_did         TEXT,
      transaction_id    TEXT,
      ruleset_results   JSONB NOT NULL DEFAULT '[]'::jsonb,
      score             INTEGER NOT NULL DEFAULT 0,
      verdict           TEXT NOT NULL DEFAULT 'allow',
      factors           JSONB DEFAULT '{}'::jsonb,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_fraud_checks_agent ON fraud_checks (agent_did);
    CREATE INDEX IF NOT EXISTS idx_fraud_checks_verdict ON fraud_checks (verdict);

    CREATE TABLE IF NOT EXISTS fraud_blacklist (
      entry_id     TEXT PRIMARY KEY,
      kind         TEXT NOT NULL,
      value        TEXT NOT NULL,
      reason       TEXT,
      source       TEXT,
      added_by_did TEXT,
      expires_at   TIMESTAMPTZ,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (kind, value)
    );
    CREATE INDEX IF NOT EXISTS idx_fraud_blacklist_kind_value ON fraud_blacklist (kind, value);
  `).catch(() => {});
}

function genId(prefix) {
  return `${prefix}_${cryptoLib.randomBytes(12).toString('hex')}`;
}

function ruleMatches(rule, tx) {
  // Simple condition matcher: each condition key is a field path; matches if equal or comparator true
  const c = rule.conditions || {};
  try {
    if (rule.kind === 'blacklist') {
      // expects { match_field: 'email' } and the blacklist table will be consulted by caller
      return false; // blacklist handled outside
    }
    if (rule.kind === 'velocity') {
      // expects { max_per_min: N } — caller computes velocity externally; pass through if provided
      const vel = tx.recent_count_per_min || 0;
      return c.max_per_min !== undefined && vel > c.max_per_min;
    }
    if (rule.kind === 'anomaly') {
      // expects { min_amount_usd: X, max_amount_usd: Y }
      const amt = tx.amount_usd || 0;
      if (c.min_amount_usd !== undefined && amt < c.min_amount_usd) return false;
      if (c.max_amount_usd !== undefined && amt > c.max_amount_usd) return true;
      return false;
    }
    if (rule.kind === 'geo') {
      const country = tx.country;
      if (Array.isArray(c.block_countries) && c.block_countries.includes(country)) return true;
      if (Array.isArray(c.allow_countries) && country && !c.allow_countries.includes(country)) return true;
      return false;
    }
    if (rule.kind === 'device') {
      if (c.device_fingerprint && tx.device_fingerprint && c.device_fingerprint === tx.device_fingerprint) return true;
      return false;
    }
  } catch { return false; }
  return false;
}

async function checkBlacklist(pool, tx) {
  const hits = [];
  const checks = [
    { field: 'agent_did', kind: 'did' },
    { field: 'address', kind: 'address' },
    { field: 'email', kind: 'email' },
    { field: 'ip', kind: 'ip' },
    { field: 'phone', kind: 'phone' }
  ];
  for (const c of checks) {
    if (!tx[c.field]) continue;
    const r = await pool.query(
      `SELECT entry_id, reason FROM fraud_blacklist
       WHERE kind=$1 AND value=$2 AND (expires_at IS NULL OR expires_at > NOW())`,
      [c.kind, tx[c.field]]
    ).catch(() => ({ rows: [] }));
    if (r.rows[0]) hits.push({ kind: c.kind, value: tx[c.field], reason: r.rows[0].reason });
  }
  return hits;
}

function registerFraudRoutes(app, pool, verifyAgentAuth, auditChain) {
  app.post('/v1/fraud/check', express.json(), async (req, res) => {
    try {
      const body = z.object({
        agent_did: z.string().optional(),
        transaction_id: z.string().optional(),
        amount_usd: z.number().optional(),
        address: z.string().optional(),
        email: z.string().optional(),
        ip: z.string().optional(),
        phone: z.string().optional(),
        country: z.string().optional(),
        device_fingerprint: z.string().optional(),
        recent_count_per_min: z.number().optional()
      }).safeParse(req.body || {});
      if (!body.success) return res.status(400).json({ error: 'invalid_input', details: body.error.issues });
      const tx = body.data;
      const rules = await pool.query(`SELECT * FROM fraud_rules WHERE active=TRUE`).catch(() => ({ rows: [] }));
      const triggered = [];
      let score = 0;
      let topAction = 'allow';
      for (const rule of rules.rows) {
        if (ruleMatches(rule, tx)) {
          triggered.push({ rule_id: rule.rule_id, name: rule.name, kind: rule.kind, weight: rule.weight, action: rule.action });
          score = Math.min(100, score + rule.weight);
          if (rule.action === 'block') topAction = 'block';
          else if (rule.action === 'review' && topAction !== 'block') topAction = 'review';
        }
      }
      const blHits = await checkBlacklist(pool, tx);
      if (blHits.length) {
        triggered.push({ rule_id: 'blacklist', kind: 'blacklist', weight: 100, action: 'block', matches: blHits });
        score = 100; topAction = 'block';
      }
      const verdict = score >= 80 ? 'block' : (score >= 40 || topAction === 'review' ? 'review' : 'allow');
      const checkId = genId('chk');
      await pool.query(
        `INSERT INTO fraud_checks (check_id, agent_did, transaction_id, ruleset_results, score, verdict, factors)
         VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7::jsonb)`,
        [checkId, tx.agent_did || null, tx.transaction_id || null, JSON.stringify(triggered), score, verdict, JSON.stringify({ blacklist_hits: blHits })]
      );
      await auditChain.append({ event_type: 'fraud.checked', check_id: checkId, agent_did: tx.agent_did, verdict, score, timestamp: new Date().toISOString() });
      return res.json({ check_id: checkId, score, verdict, triggered_rules: triggered, blacklist_hits: blHits });
    } catch (e) { return res.status(500).json({ error: 'check_failed', message: e.message }); }
  });

  app.get('/v1/fraud/checks', async (req, res) => {
    const params = []; const conds = [];
    if (req.query.agent_did) { params.push(req.query.agent_did); conds.push(`agent_did=$${params.length}`); }
    if (req.query.verdict) { params.push(req.query.verdict); conds.push(`verdict=$${params.length}`); }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const r = await pool.query(`SELECT * FROM fraud_checks ${where} ORDER BY created_at DESC LIMIT 500`, params).catch(() => ({ rows: [] }));
    return res.json({ checks: r.rows, count: r.rows.length });
  });

  app.post('/v1/fraud/blacklist', express.json(), async (req, res) => {
    try {
      const did = req.headers['x-agent-did'] || 'did:op:admin';
      const body = z.object({
        kind: z.enum(BL_KINDS),
        value: z.string().min(1).max(500),
        reason: z.string().max(2000).optional(),
        source: z.string().max(200).optional(),
        expires_at: z.string().optional()
      }).safeParse(req.body || {});
      if (!body.success) return res.status(400).json({ error: 'invalid_input', details: body.error.issues });
      const d = body.data;
      const entryId = genId('bl');
      await pool.query(
        `INSERT INTO fraud_blacklist (entry_id, kind, value, reason, source, added_by_did, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (kind, value) DO UPDATE SET reason=EXCLUDED.reason, source=EXCLUDED.source, expires_at=EXCLUDED.expires_at`,
        [entryId, d.kind, d.value, d.reason || null, d.source || null, did, d.expires_at || null]
      );
      await auditChain.append({ event_type: 'fraud.blacklist_added', entry_id: entryId, kind: d.kind, value: d.value, by: did, timestamp: new Date().toISOString() });
      return res.status(201).json({ entry_id: entryId, kind: d.kind, value: d.value });
    } catch (e) { return res.status(500).json({ error: 'add_failed', message: e.message }); }
  });

  app.get('/v1/fraud/blacklist', async (req, res) => {
    const params = []; const conds = [];
    if (req.query.kind) { params.push(req.query.kind); conds.push(`kind=$${params.length}`); }
    if (req.query.value) { params.push(req.query.value); conds.push(`value=$${params.length}`); }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const r = await pool.query(`SELECT * FROM fraud_blacklist ${where} ORDER BY created_at DESC LIMIT 500`, params).catch(() => ({ rows: [] }));
    return res.json({ entries: r.rows, count: r.rows.length });
  });

  app.post('/v1/fraud/blacklist/:id/remove', async (req, res) => {
    const did = req.headers['x-agent-did'] || 'did:op:admin';
    const r = await pool.query(`DELETE FROM fraud_blacklist WHERE entry_id=$1 RETURNING entry_id`, [req.params.id]).catch(() => ({ rows: [] }));
    if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
    await auditChain.append({ event_type: 'fraud.blacklist_removed', entry_id: req.params.id, by: did, timestamp: new Date().toISOString() });
    return res.json({ removed: true, entry_id: req.params.id });
  });

  app.post('/v1/fraud/rules', express.json(), async (req, res) => {
    try {
      const token = req.headers['x-admin-token'];
      if (token !== process.env.OPERATOR_ADMIN_TOKEN) return res.status(401).json({ error: 'admin_required' });
      const body = z.object({
        name: z.string().min(1).max(300),
        kind: z.enum(RULE_KINDS),
        conditions: z.record(z.any()),
        action: z.enum(ACTIONS).optional(),
        weight: z.number().int().min(0).max(100).optional(),
        active: z.boolean().optional()
      }).safeParse(req.body || {});
      if (!body.success) return res.status(400).json({ error: 'invalid_input', details: body.error.issues });
      const d = body.data;
      const ruleId = genId('frule');
      await pool.query(
        `INSERT INTO fraud_rules (rule_id, name, kind, conditions, action, weight, active)
         VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7)`,
        [ruleId, d.name, d.kind, JSON.stringify(d.conditions), d.action || 'review', d.weight || 10, d.active !== false]
      );
      await auditChain.append({ event_type: 'fraud.rule_created', rule_id: ruleId, kind: d.kind, timestamp: new Date().toISOString() });
      return res.status(201).json({ rule_id: ruleId, name: d.name });
    } catch (e) { return res.status(500).json({ error: 'create_failed', message: e.message }); }
  });

  app.get('/v1/fraud/rules', async (req, res) => {
    const r = await pool.query(`SELECT * FROM fraud_rules ORDER BY created_at DESC`).catch(() => ({ rows: [] }));
    return res.json({ rules: r.rows, count: r.rows.length });
  });
}

module.exports = { migrate, registerFraudRoutes, RULE_KINDS, ACTIONS, ruleMatches, checkBlacklist };
