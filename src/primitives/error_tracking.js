// ============================================================================
// OpenHeab Error Tracking — Sentry-style exception tracking with grouping
// Tables: error_projects, error_events, error_issues, error_rules
// Fingerprint: SHA-256(exception_type + first 3 stack frames)
// ============================================================================
const cryptoLib = require('crypto');
const express = require('express');
const { z } = require('zod');

const PLATFORMS = ['node', 'python', 'ruby', 'go', 'rust', 'web'];
const LEVELS = ['error', 'warning', 'info', 'fatal'];
const ISSUE_STATUSES = ['open', 'resolved', 'ignored'];
const RULE_ACTIONS = ['assign_to', 'notify', 'silence'];

// ----------------------------------------------------------------------------
// DSN encryption
// ----------------------------------------------------------------------------
function getMasterKek() {
  const raw = process.env.ERROR_TRACKING_KEK
           || process.env.IDENTITY_MASTER_KEK
           || 'openheab-error-default-kek';
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, 'hex');
  return cryptoLib.createHash('sha256').update(raw).digest();
}

function encDsn(plain) {
  const kek = getMasterKek();
  const iv = cryptoLib.randomBytes(12);
  const cipher = cryptoLib.createCipheriv('aes-256-gcm', kek, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

function decDsn(b64) {
  if (!b64) return null;
  try {
    const buf = Buffer.from(b64, 'base64');
    const kek = getMasterKek();
    const iv = buf.slice(0, 12);
    const tag = buf.slice(12, 28);
    const ct = buf.slice(28);
    const decipher = cryptoLib.createDecipheriv('aes-256-gcm', kek, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch { return null; }
}

// ----------------------------------------------------------------------------
// Migration
// ----------------------------------------------------------------------------
async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS error_projects (
      project_id TEXT PRIMARY KEY,
      owner_did  TEXT NOT NULL,
      name       TEXT NOT NULL,
      slug       TEXT NOT NULL,
      platform   TEXT NOT NULL DEFAULT 'node',
      dsn_enc    TEXT,
      active     BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (owner_did, slug)
    );

    CREATE TABLE IF NOT EXISTS error_events (
      event_id        TEXT PRIMARY KEY,
      project_id      TEXT NOT NULL REFERENCES error_projects(project_id) ON DELETE CASCADE,
      fingerprint     TEXT NOT NULL,
      exception_type  TEXT,
      message         TEXT,
      stacktrace      JSONB,
      breadcrumbs     JSONB,
      tags            JSONB,
      user_context    JSONB,
      environment     TEXT,
      release         TEXT,
      level           TEXT NOT NULL DEFAULT 'error',
      ts              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      ingested_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_evt_proj_fp ON error_events (project_id, fingerprint, ts DESC);
    CREATE INDEX IF NOT EXISTS idx_evt_ingested ON error_events (ingested_at DESC);

    CREATE TABLE IF NOT EXISTS error_issues (
      issue_id      TEXT PRIMARY KEY,
      project_id    TEXT NOT NULL REFERENCES error_projects(project_id) ON DELETE CASCADE,
      fingerprint   TEXT UNIQUE NOT NULL,
      title         TEXT,
      first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      count_24h     INTEGER NOT NULL DEFAULT 0,
      count_total   INTEGER NOT NULL DEFAULT 0,
      status        TEXT NOT NULL DEFAULT 'open',
      assignee_did  TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_issues_proj ON error_issues (project_id, last_seen_at DESC);
    CREATE INDEX IF NOT EXISTS idx_issues_status ON error_issues (status);

    CREATE TABLE IF NOT EXISTS error_rules (
      rule_id    TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES error_projects(project_id) ON DELETE CASCADE,
      pattern    TEXT NOT NULL,
      action     TEXT NOT NULL,
      params     JSONB
    );
    CREATE INDEX IF NOT EXISTS idx_rules_proj ON error_rules (project_id);
  `);
}

function genProjectId() { return 'eproj_' + cryptoLib.randomBytes(12).toString('hex'); }
function genEventId()   { return 'eevt_' + cryptoLib.randomBytes(12).toString('hex'); }
function genIssueId()   { return 'eiss_' + cryptoLib.randomBytes(12).toString('hex'); }
function genRuleId()    { return 'erul_' + cryptoLib.randomBytes(12).toString('hex'); }

function makeDsn(projectId) {
  return `openheab://${cryptoLib.randomBytes(16).toString('hex')}@errors.openheab.app/${projectId}`;
}

function fingerprint(exceptionType, stacktrace) {
  const frames = Array.isArray(stacktrace?.frames) ? stacktrace.frames
               : Array.isArray(stacktrace) ? stacktrace
               : [];
  const top3 = frames.slice(0, 3)
    .map(f => `${f.function || ''}|${f.filename || f.file || ''}|${f.lineno || f.line || ''}`)
    .join('||');
  return cryptoLib.createHash('sha256')
    .update(`${exceptionType || 'Error'}::${top3}`).digest('hex');
}

// ----------------------------------------------------------------------------
// Routes
// ----------------------------------------------------------------------------
function registerErrorTrackingRoutes(app, pool, verifyAgentAuth, auditChain) {
  // POST /v1/agents/:did/errors/projects
  const ProjectSchema = z.object({
    name: z.string().min(1).max(256),
    slug: z.string().min(1).max(128).regex(/^[a-z0-9-]+$/),
    platform: z.enum(PLATFORMS).optional().default('node')
  });

  app.post('/v1/agents/:did/errors/projects', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const parse = ProjectSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;

      const projectId = genProjectId();
      const dsn = makeDsn(projectId);

      try {
        await pool.query(
          `INSERT INTO error_projects
           (project_id, owner_did, name, slug, platform, dsn_enc)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [projectId, did, d.name, d.slug, d.platform, encDsn(dsn)]
        );
      } catch (e) {
        if (e.code === '23505') return res.status(409).json({ error: 'slug_taken' });
        throw e;
      }

      await auditChain.append({
        event_type: 'errors.project_created',
        project_id: projectId, owner_did: did,
        slug: d.slug, platform: d.platform,
        timestamp: new Date().toISOString()
      });

      return res.status(201).json({
        project_id: projectId, owner_did: did,
        name: d.name, slug: d.slug, platform: d.platform,
        dsn, active: true, created_at: new Date().toISOString()
      });
    } catch (e) {
      console.error('[errors.project.create]', e);
      return res.status(500).json({ error: 'project_create_failed', message: e.message });
    }
  });

  // GET /v1/agents/:did/errors/projects
  app.get('/v1/agents/:did/errors/projects', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });

    const r = await pool.query(
      `SELECT project_id, name, slug, platform, dsn_enc, active, created_at
       FROM error_projects WHERE owner_did = $1 ORDER BY created_at DESC`,
      [did]
    ).catch(() => ({ rows: [] }));

    const projects = r.rows.map(p => ({
      project_id: p.project_id, name: p.name, slug: p.slug,
      platform: p.platform, active: p.active, created_at: p.created_at,
      dsn: decDsn(p.dsn_enc)
    }));
    return res.json({ projects, count: projects.length });
  });

  // POST /v1/errors/ingest — public-ish, authenticated by DSN
  const IngestSchema = z.object({
    dsn: z.string().min(1).max(2048).optional(),
    project_id: z.string().min(1).max(128).optional(),
    exception_type: z.string().max(256).optional(),
    message: z.string().max(8192).optional(),
    stacktrace: z.any().optional(),
    breadcrumbs: z.any().optional(),
    tags: z.record(z.any()).optional(),
    user_context: z.record(z.any()).optional(),
    environment: z.string().max(64).optional(),
    release: z.string().max(128).optional(),
    level: z.enum(LEVELS).optional().default('error'),
    ts: z.string().optional()
  });

  app.post('/v1/errors/ingest', express.json({ limit: '2mb' }), async (req, res) => {
    try {
      const parse = IngestSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;

      // Resolve project via DSN or explicit ID
      let projectId = d.project_id;
      if (!projectId && d.dsn) {
        const m = String(d.dsn).match(/\/([^/]+)$/);
        if (m) projectId = m[1];
      }
      // Also accept x-sentry-auth / x-openheab-dsn header
      if (!projectId) {
        const hdr = req.headers['x-openheab-dsn'] || req.headers['x-sentry-auth'];
        if (hdr) {
          const m = String(hdr).match(/\/([^/?\s]+)/);
          if (m) projectId = m[1];
        }
      }
      if (!projectId) return res.status(401).json({ error: 'missing_dsn' });

      const projR = await pool.query(
        `SELECT project_id, active FROM error_projects WHERE project_id = $1`,
        [projectId]
      ).catch(() => ({ rows: [] }));
      if (!projR.rows[0] || !projR.rows[0].active) {
        return res.status(404).json({ error: 'project_not_found_or_inactive' });
      }

      const fp = fingerprint(d.exception_type, d.stacktrace);
      const eventId = genEventId();

      await pool.query(
        `INSERT INTO error_events
         (event_id, project_id, fingerprint, exception_type, message, stacktrace,
          breadcrumbs, tags, user_context, environment, release, level, ts)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb,$9::jsonb,$10,$11,$12,
                 COALESCE($13::timestamptz, NOW()))`,
        [eventId, projectId, fp, d.exception_type || null, d.message || null,
         d.stacktrace ? JSON.stringify(d.stacktrace) : null,
         d.breadcrumbs ? JSON.stringify(d.breadcrumbs) : null,
         d.tags ? JSON.stringify(d.tags) : null,
         d.user_context ? JSON.stringify(d.user_context) : null,
         d.environment || null, d.release || null, d.level || 'error',
         d.ts || null]
      );

      // Upsert into issues
      const title = `${d.exception_type || 'Error'}: ${(d.message || '').slice(0, 256)}`;
      await pool.query(
        `INSERT INTO error_issues
         (issue_id, project_id, fingerprint, title, count_24h, count_total)
         VALUES ($1,$2,$3,$4,1,1)
         ON CONFLICT (fingerprint) DO UPDATE SET
           last_seen_at = NOW(),
           count_24h = error_issues.count_24h + 1,
           count_total = error_issues.count_total + 1,
           status = CASE WHEN error_issues.status = 'resolved'
                         THEN 'open' ELSE error_issues.status END`,
        [genIssueId(), projectId, fp, title]
      );

      return res.status(202).json({
        event_id: eventId, project_id: projectId, fingerprint: fp,
        ingested_at: new Date().toISOString()
      });
    } catch (e) {
      console.error('[errors.ingest]', e);
      return res.status(500).json({ error: 'ingest_failed', message: e.message });
    }
  });

  // GET /v1/agents/:did/errors/projects/:id/issues
  app.get('/v1/agents/:did/errors/projects/:id/issues', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });

    const own = await pool.query(
      `SELECT project_id FROM error_projects WHERE project_id = $1 AND owner_did = $2`,
      [req.params.id, did]
    ).catch(() => ({ rows: [] }));
    if (!own.rows[0]) return res.status(404).json({ error: 'project_not_found' });

    const status = req.query.status;
    const limit = Math.min(parseInt(req.query.limit) || 50, 500);
    const conds = ['project_id = $1'];
    const params = [req.params.id];
    if (status) { params.push(status); conds.push(`status = $${params.length}`); }
    params.push(limit);

    const r = await pool.query(
      `SELECT issue_id, fingerprint, title, first_seen_at, last_seen_at,
              count_24h, count_total, status, assignee_did
       FROM error_issues WHERE ${conds.join(' AND ')}
       ORDER BY last_seen_at DESC LIMIT $${params.length}`,
      params
    ).catch(() => ({ rows: [] }));
    return res.json({ issues: r.rows, count: r.rows.length });
  });

  // GET /v1/agents/:did/errors/issues/:id (with full events)
  app.get('/v1/agents/:did/errors/issues/:id', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });

    const r = await pool.query(
      `SELECT i.*, p.owner_did, p.slug AS project_slug FROM error_issues i
       JOIN error_projects p ON p.project_id = i.project_id
       WHERE i.issue_id = $1`,
      [req.params.id]
    ).catch(() => ({ rows: [] }));
    if (!r.rows[0]) return res.status(404).json({ error: 'issue_not_found' });
    if (r.rows[0].owner_did !== did) return res.status(403).json({ error: 'forbidden' });
    const issue = r.rows[0];

    const limit = Math.min(parseInt(req.query.events_limit) || 50, 200);
    const events = await pool.query(
      `SELECT event_id, exception_type, message, stacktrace, breadcrumbs, tags,
              user_context, environment, release, level, ts, ingested_at
       FROM error_events WHERE project_id = $1 AND fingerprint = $2
       ORDER BY ts DESC LIMIT $3`,
      [issue.project_id, issue.fingerprint, limit]
    ).catch(() => ({ rows: [] }));

    return res.json({ ...issue, events: events.rows });
  });

  // POST /v1/agents/:did/errors/issues/:id/resolve
  app.post('/v1/agents/:did/errors/issues/:id/resolve', express.json(), async (req, res) => {
    return setIssueStatus(req, res, 'resolved');
  });

  // POST /v1/agents/:did/errors/issues/:id/ignore
  app.post('/v1/agents/:did/errors/issues/:id/ignore', express.json(), async (req, res) => {
    return setIssueStatus(req, res, 'ignored');
  });

  async function setIssueStatus(req, res, status) {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const upd = await pool.query(
        `UPDATE error_issues i SET status = $1
         FROM error_projects p
         WHERE i.issue_id = $2 AND i.project_id = p.project_id AND p.owner_did = $3
         RETURNING i.issue_id, i.fingerprint`,
        [status, req.params.id, did]
      ).catch(() => ({ rows: [] }));
      if (!upd.rows[0]) return res.status(404).json({ error: 'issue_not_found' });

      await auditChain.append({
        event_type: `errors.issue_${status}`,
        issue_id: req.params.id, owner_did: did,
        fingerprint: upd.rows[0].fingerprint,
        timestamp: new Date().toISOString()
      });

      return res.json({ issue_id: req.params.id, status });
    } catch (e) {
      console.error('[errors.issue.status]', e);
      return res.status(500).json({ error: 'status_change_failed', message: e.message });
    }
  }

  // GET /v1/agents/:did/errors/projects/:id/stats
  app.get('/v1/agents/:did/errors/projects/:id/stats', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });

    const own = await pool.query(
      `SELECT project_id FROM error_projects WHERE project_id = $1 AND owner_did = $2`,
      [req.params.id, did]
    ).catch(() => ({ rows: [] }));
    if (!own.rows[0]) return res.status(404).json({ error: 'project_not_found' });

    const r24 = await pool.query(
      `SELECT date_trunc('hour', ts) AS bucket, COUNT(*) AS n
       FROM error_events WHERE project_id = $1 AND ts >= NOW() - INTERVAL '24 hours'
       GROUP BY 1 ORDER BY 1`, [req.params.id]
    ).catch(() => ({ rows: [] }));

    const r7 = await pool.query(
      `SELECT date_trunc('day', ts) AS bucket, COUNT(*) AS n
       FROM error_events WHERE project_id = $1 AND ts >= NOW() - INTERVAL '7 days'
       GROUP BY 1 ORDER BY 1`, [req.params.id]
    ).catch(() => ({ rows: [] }));

    const total = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE ts >= NOW() - INTERVAL '24 hours') AS h24,
         COUNT(*) FILTER (WHERE ts >= NOW() - INTERVAL '7 days') AS d7,
         COUNT(*) AS total,
         COUNT(DISTINCT fingerprint) FILTER (WHERE ts >= NOW() - INTERVAL '24 hours') AS issues_24h
       FROM error_events WHERE project_id = $1`, [req.params.id]
    ).catch(() => ({ rows: [{}] }));

    return res.json({
      project_id: req.params.id,
      totals: total.rows[0] || {},
      trend_24h_by_hour: r24.rows,
      trend_7d_by_day: r7.rows
    });
  });
}

module.exports = {
  migrate,
  registerErrorTrackingRoutes,
  fingerprint,
  PLATFORMS,
  LEVELS,
  ISSUE_STATUSES
};
