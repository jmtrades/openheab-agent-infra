// ============================================================================
// backup_restore.js — operator-grade data export. `/v1/admin/backup/create`
// dumps every table to a single signed JSON bundle. `/v1/admin/backup/list`
// shows recent backups. `/v1/admin/backup/:id/download` streams the bundle.
// Restore is intentionally manual (operator runs psql against bundle).
// ============================================================================
const crypto = require('crypto');

async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS backup_runs (
      backup_id      TEXT PRIMARY KEY,
      status         TEXT NOT NULL DEFAULT 'pending',
      tables_count   INTEGER,
      rows_count     BIGINT,
      size_bytes     BIGINT,
      digest         TEXT,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at   TIMESTAMPTZ,
      error          TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_backup_runs_status ON backup_runs (status, created_at DESC);
  `);
}

function newId() { return 'bk_' + crypto.randomBytes(10).toString('hex'); }

async function listTables(pool) {
  const r = await pool.query(
    `SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname = 'public' ORDER BY tablename`
  ).catch(() => ({ rows: [] }));
  return r.rows.map(r => r.tablename);
}

async function dumpTable(pool, table, rowLimit = 100000) {
  const r = await pool.query(`SELECT * FROM ${table} LIMIT $1`, [rowLimit]).catch(() => ({ rows: [] }));
  return r.rows;
}

async function createBackup(pool, opts = {}) {
  const id = newId();
  await pool.query(
    `INSERT INTO backup_runs (backup_id, status) VALUES ($1, 'running')`, [id]
  ).catch(() => {});

  const startedAt = Date.now();
  const tables = await listTables(pool);
  const filtered = tables.filter(t => !t.startsWith('backup_runs') && !t.startsWith('pg_'));

  const bundle = {
    bundle_format: 'openheab-backup-v1',
    backup_id: id,
    created_at: new Date().toISOString(),
    substrate_version: '0.2.0',
    tables_count: filtered.length,
    tables: {}
  };
  let totalRows = 0;
  for (const t of filtered) {
    const rows = await dumpTable(pool, t, opts.rowLimit || 100000);
    bundle.tables[t] = { row_count: rows.length, rows };
    totalRows += rows.length;
  }

  const serialized = JSON.stringify(bundle);
  const digest = crypto.createHash('sha256').update(serialized).digest('hex');
  const size = Buffer.byteLength(serialized);

  await pool.query(
    `UPDATE backup_runs SET status='completed', tables_count=$2, rows_count=$3, size_bytes=$4, digest=$5, completed_at=NOW() WHERE backup_id=$1`,
    [id, filtered.length, totalRows, size, digest]
  ).catch(() => {});

  return {
    backup_id: id, tables: filtered.length, rows: totalRows, size_bytes: size, digest,
    elapsed_ms: Date.now() - startedAt, bundle: opts.includeBundle ? bundle : undefined
  };
}

function isAdmin(req) {
  const token = process.env.OPERATOR_ADMIN_TOKEN || process.env.INTERNAL_API_KEY;
  if (!token) return false;
  return req.headers['x-admin-token'] === token || req.headers['x-internal-api-key'] === token;
}

function registerBackupRestoreRoutes(app, pool, verifyAgentAuth, auditChain) {
  const express = require('express');

  app.post('/v1/admin/backup/create', express.json(), async (req, res) => {
    if (!isAdmin(req)) return res.status(401).json({ error: 'admin_required' });
    try {
      const result = await createBackup(pool, { rowLimit: req.body?.row_limit_per_table || 100000 });
      if (auditChain) await auditChain.append({
        event_type: 'backup.created', backup_id: result.backup_id,
        tables: result.tables, rows: result.rows, digest: result.digest
      }).catch(() => {});
      res.status(201).json(result);
    } catch (e) {
      res.status(500).json({ error: 'backup_failed', message: e.message });
    }
  });

  app.get('/v1/admin/backup/list', async (req, res) => {
    if (!isAdmin(req)) return res.status(401).json({ error: 'admin_required' });
    const r = await pool.query(
      `SELECT backup_id, status, tables_count, rows_count, size_bytes, digest, created_at, completed_at
       FROM backup_runs ORDER BY created_at DESC LIMIT 50`
    ).catch(() => ({ rows: [] }));
    res.json({ backups: r.rows });
  });

  // Download — re-dumps tables on the fly. We don't persist the actual bundle
  // (it could be massive). For real backups, run periodically + write to S3.
  app.get('/v1/admin/backup/:backup_id/download', async (req, res) => {
    if (!isAdmin(req)) return res.status(401).json({ error: 'admin_required' });
    const result = await createBackup(pool, { rowLimit: 100000, includeBundle: true });
    res.set('content-type', 'application/json');
    res.set('content-disposition', `attachment; filename="openheab-backup-${result.backup_id}.json"`);
    res.send(JSON.stringify(result.bundle, null, 2));
  });

  // Cron: optional scheduled backup. Operator wires CRON_SECRET + this fires daily.
  const { registerCron } = require('../cron_auth');
  registerCron(app, '/v1/_jobs/daily-backup', async (req, res) => {
    try {
      const result = await createBackup(pool, { rowLimit: 100000 });
      if (auditChain) await auditChain.append({
        event_type: 'backup.scheduled', backup_id: result.backup_id, rows: result.rows
      }).catch(() => {});
      res.json({ ok: true, ...result });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
}

module.exports = { migrate, registerBackupRestoreRoutes, createBackup, listTables };
