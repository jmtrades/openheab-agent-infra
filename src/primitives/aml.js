// ============================================================================
// OpenHeab AML — Anti-money-laundering transaction monitoring + SAR filings
// ============================================================================
const express = require('express');
const cryptoLib = require('crypto');
const { z } = require('zod');
const { registerCron } = require('../cron_auth');

const RULE_KINDS = ['structuring', 'velocity', 'sanctions', 'high_risk_geo', 'round_amount', 'rapid_movement'];
const SEVERITIES = ['low', 'medium', 'high', 'critical'];
const ALERT_STATUSES = ['open', 'investigating', 'cleared', 'sar_filed'];
const SAR_STATUSES = ['drafted', 'submitted', 'acknowledged'];

async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS aml_rules (
      rule_id      TEXT PRIMARY KEY,
      name         TEXT NOT NULL,
      kind         TEXT NOT NULL,
      conditions   JSONB NOT NULL DEFAULT '{}'::jsonb,
      severity     TEXT NOT NULL DEFAULT 'medium',
      active       BOOLEAN NOT NULL DEFAULT TRUE,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_aml_rules_active ON aml_rules (active);

    CREATE TABLE IF NOT EXISTS aml_alerts (
      alert_id          TEXT PRIMARY KEY,
      agent_did         TEXT,
      rule_id           TEXT,
      transaction_id    TEXT,
      severity          TEXT NOT NULL DEFAULT 'medium',
      factors           JSONB DEFAULT '{}'::jsonb,
      status            TEXT NOT NULL DEFAULT 'open',
      assigned_to_did   TEXT,
      resolution        TEXT,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      resolved_at       TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_aml_alerts_agent ON aml_alerts (agent_did);
    CREATE INDEX IF NOT EXISTS idx_aml_alerts_status ON aml_alerts (status);
    CREATE INDEX IF NOT EXISTS idx_aml_alerts_severity ON aml_alerts (severity);

    CREATE TABLE IF NOT EXISTS aml_sar_filings (
      filing_id     TEXT PRIMARY KEY,
      alert_ids     TEXT[] NOT NULL DEFAULT '{}',
      subject_did   TEXT NOT NULL,
      narrative     TEXT,
      status        TEXT NOT NULL DEFAULT 'drafted',
      filed_at      TIMESTAMPTZ,
      jurisdiction  TEXT,
      reference     TEXT,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_aml_sar_subject ON aml_sar_filings (subject_did);
  `).catch(() => {});
}

function genId(prefix) {
  return `${prefix}_${cryptoLib.randomBytes(12).toString('hex')}`;
}

function evaluateRule(rule, tx) {
  const c = rule.conditions || {};
  try {
    if (rule.kind === 'structuring') {
      // Multiple just-under-threshold txs (e.g., $9,500 under $10k CTR)
      const threshold = c.threshold_usd || 10000;
      const margin = c.margin_pct || 5;
      const lower = threshold * (1 - margin / 100);
      const amount = tx.amount_usd || 0;
      return amount >= lower && amount < threshold;
    }
    if (rule.kind === 'velocity') {
      return (tx.recent_count_24h || 0) > (c.max_per_24h || 10);
    }
    if (rule.kind === 'sanctions') {
      return Array.isArray(c.sanctioned_countries) && c.sanctioned_countries.includes(tx.country);
    }
    if (rule.kind === 'high_risk_geo') {
      return Array.isArray(c.high_risk_countries) && c.high_risk_countries.includes(tx.country);
    }
    if (rule.kind === 'round_amount') {
      const amt = tx.amount_usd || 0;
      const minRound = c.min_amount || 5000;
      return amt >= minRound && amt % 1000 === 0;
    }
    if (rule.kind === 'rapid_movement') {
      return (tx.time_between_in_out_seconds !== undefined) && tx.time_between_in_out_seconds < (c.max_seconds || 300);
    }
  } catch { return false; }
  return false;
}

function registerAmlRoutes(app, pool, verifyAgentAuth, auditChain) {
  app.post('/v1/aml/screen', express.json(), async (req, res) => {
    try {
      const body = z.object({
        agent_did: z.string().optional(),
        transaction_id: z.string().optional(),
        amount_usd: z.number().optional(),
        country: z.string().optional(),
        recent_count_24h: z.number().optional(),
        time_between_in_out_seconds: z.number().optional(),
        counterparty: z.string().optional(),
        extra: z.record(z.any()).optional()
      }).safeParse(req.body || {});
      if (!body.success) return res.status(400).json({ error: 'invalid_input', details: body.error.issues });
      const tx = body.data;
      const rules = await pool.query(`SELECT * FROM aml_rules WHERE active=TRUE`).catch(() => ({ rows: [] }));
      const triggered = [];
      const alertsCreated = [];
      for (const rule of rules.rows) {
        if (evaluateRule(rule, tx)) {
          triggered.push({ rule_id: rule.rule_id, kind: rule.kind, severity: rule.severity });
          const alertId = genId('alrt');
          await pool.query(
            `INSERT INTO aml_alerts (alert_id, agent_did, rule_id, transaction_id, severity, factors)
             VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
            [alertId, tx.agent_did || null, rule.rule_id, tx.transaction_id || null, rule.severity,
             JSON.stringify({ rule_name: rule.name, kind: rule.kind, tx })]
          ).catch(() => {});
          alertsCreated.push({ alert_id: alertId, rule_id: rule.rule_id, severity: rule.severity });
          await auditChain.append({ event_type: 'aml.alert_created', alert_id: alertId, agent_did: tx.agent_did, rule_id: rule.rule_id, severity: rule.severity, timestamp: new Date().toISOString() });
        }
      }
      return res.json({ triggered_rules: triggered, alerts: alertsCreated, alert_count: alertsCreated.length });
    } catch (e) { return res.status(500).json({ error: 'screen_failed', message: e.message }); }
  });

  app.get('/v1/aml/alerts', async (req, res) => {
    const params = []; const conds = [];
    if (req.query.status) { params.push(req.query.status); conds.push(`status=$${params.length}`); }
    if (req.query.severity) { params.push(req.query.severity); conds.push(`severity=$${params.length}`); }
    if (req.query.agent_did) { params.push(req.query.agent_did); conds.push(`agent_did=$${params.length}`); }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const r = await pool.query(`SELECT * FROM aml_alerts ${where} ORDER BY created_at DESC LIMIT 500`, params).catch(() => ({ rows: [] }));
    return res.json({ alerts: r.rows, count: r.rows.length });
  });

  app.post('/v1/aml/alerts/:id/investigate', express.json(), async (req, res) => {
    try {
      const did = req.headers['x-agent-did'] || 'did:op:admin';
      const r = await pool.query(
        `UPDATE aml_alerts SET status='investigating', assigned_to_did=$1 WHERE alert_id=$2 RETURNING alert_id`,
        [did, req.params.id]
      ).catch(() => ({ rows: [] }));
      if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
      await auditChain.append({ event_type: 'aml.alert_investigation_started', alert_id: req.params.id, assigned_to: did, timestamp: new Date().toISOString() });
      return res.json({ alert_id: req.params.id, status: 'investigating', assigned_to: did });
    } catch (e) { return res.status(500).json({ error: 'investigate_failed', message: e.message }); }
  });

  app.post('/v1/aml/alerts/:id/clear', express.json(), async (req, res) => {
    try {
      const did = req.headers['x-agent-did'] || 'did:op:admin';
      const body = z.object({ resolution: z.string().min(1).max(5000) }).safeParse(req.body || {});
      if (!body.success) return res.status(400).json({ error: 'invalid_input' });
      const r = await pool.query(
        `UPDATE aml_alerts SET status='cleared', resolution=$1, resolved_at=NOW() WHERE alert_id=$2 RETURNING alert_id`,
        [body.data.resolution, req.params.id]
      ).catch(() => ({ rows: [] }));
      if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
      await auditChain.append({ event_type: 'aml.alert_cleared', alert_id: req.params.id, by: did, timestamp: new Date().toISOString() });
      return res.json({ alert_id: req.params.id, status: 'cleared' });
    } catch (e) { return res.status(500).json({ error: 'clear_failed', message: e.message }); }
  });

  app.post('/v1/aml/alerts/:id/file-sar', express.json(), async (req, res) => {
    try {
      const did = req.headers['x-agent-did'] || 'did:op:admin';
      const body = z.object({
        narrative: z.string().min(1).max(50000),
        jurisdiction: z.string().max(80).optional(),
        additional_alert_ids: z.array(z.string()).optional()
      }).safeParse(req.body || {});
      if (!body.success) return res.status(400).json({ error: 'invalid_input', details: body.error.issues });
      const alert = await pool.query(`SELECT * FROM aml_alerts WHERE alert_id=$1`, [req.params.id]).catch(() => ({ rows: [] }));
      if (!alert.rows[0]) return res.status(404).json({ error: 'not_found' });
      if (!alert.rows[0].agent_did) return res.status(409).json({ error: 'alert_has_no_subject' });
      const alertIds = [req.params.id, ...(body.data.additional_alert_ids || [])];
      const filingId = genId('sar');
      await pool.query(
        `INSERT INTO aml_sar_filings (filing_id, alert_ids, subject_did, narrative, status, jurisdiction)
         VALUES ($1,$2,$3,$4,'drafted',$5)`,
        [filingId, alertIds, alert.rows[0].agent_did, body.data.narrative, body.data.jurisdiction || 'US-FinCEN']
      );
      await pool.query(
        `UPDATE aml_alerts SET status='sar_filed', resolved_at=NOW() WHERE alert_id = ANY($1)`,
        [alertIds]
      ).catch(() => {});
      await auditChain.append({ event_type: 'aml.sar_drafted', filing_id: filingId, subject_did: alert.rows[0].agent_did, alert_ids: alertIds, by: did, timestamp: new Date().toISOString() });
      return res.status(201).json({ filing_id: filingId, subject_did: alert.rows[0].agent_did, alert_ids: alertIds, status: 'drafted' });
    } catch (e) { return res.status(500).json({ error: 'file_failed', message: e.message }); }
  });

  app.get('/v1/aml/sar-filings', async (req, res) => {
    const params = []; const conds = [];
    if (req.query.status) { params.push(req.query.status); conds.push(`status=$${params.length}`); }
    if (req.query.subject_did) { params.push(req.query.subject_did); conds.push(`subject_did=$${params.length}`); }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const r = await pool.query(`SELECT * FROM aml_sar_filings ${where} ORDER BY created_at DESC LIMIT 500`, params).catch(() => ({ rows: [] }));
    return res.json({ filings: r.rows, count: r.rows.length });
  });

  app.post('/v1/aml/rules', express.json(), async (req, res) => {
    try {
      const token = req.headers['x-admin-token'];
      if (token !== process.env.OPERATOR_ADMIN_TOKEN) return res.status(401).json({ error: 'admin_required' });
      const body = z.object({
        name: z.string().min(1).max(300),
        kind: z.enum(RULE_KINDS),
        conditions: z.record(z.any()),
        severity: z.enum(SEVERITIES).optional(),
        active: z.boolean().optional()
      }).safeParse(req.body || {});
      if (!body.success) return res.status(400).json({ error: 'invalid_input', details: body.error.issues });
      const d = body.data;
      const ruleId = genId('arule');
      await pool.query(
        `INSERT INTO aml_rules (rule_id, name, kind, conditions, severity, active)
         VALUES ($1,$2,$3,$4::jsonb,$5,$6)`,
        [ruleId, d.name, d.kind, JSON.stringify(d.conditions), d.severity || 'medium', d.active !== false]
      );
      await auditChain.append({ event_type: 'aml.rule_created', rule_id: ruleId, kind: d.kind, timestamp: new Date().toISOString() });
      return res.status(201).json({ rule_id: ruleId, name: d.name });
    } catch (e) { return res.status(500).json({ error: 'create_failed', message: e.message }); }
  });

  registerCron(app, '/v1/_jobs/aml-sweep', async (req, res) => {
    try {
      // In production: walk recent bank/crypto transactions, re-evaluate active rules.
      // Here we re-run open alerts to flag escalations.
      const rules = await pool.query(`SELECT * FROM aml_rules WHERE active=TRUE`).catch(() => ({ rows: [] }));
      const open = await pool.query(`SELECT alert_id, factors FROM aml_alerts WHERE status='open' AND created_at > NOW() - INTERVAL '7 days'`).catch(() => ({ rows: [] }));
      let escalated = 0;
      for (const alert of open.rows) {
        const tx = alert.factors?.tx;
        if (!tx) continue;
        for (const rule of rules.rows) {
          if (evaluateRule(rule, tx) && rule.severity === 'critical') {
            await pool.query(`UPDATE aml_alerts SET severity='critical' WHERE alert_id=$1 AND severity!='critical'`, [alert.alert_id]).catch(() => {});
            escalated++;
          }
        }
      }
      return res.json({ swept: open.rows.length, escalated, rules_active: rules.rows.length });
    } catch (e) {
      return res.status(500).json({ error: 'sweep_failed', message: e.message });
    }
  });
}

module.exports = { migrate, registerAmlRoutes, RULE_KINDS, SEVERITIES, evaluateRule };
