// ============================================================================
// OpenHeab Projects — Project + task management
// ============================================================================
const express = require('express');
const cryptoLib = require('crypto');
const { z } = require('zod');

const PROJECT_STATUSES = ['active', 'on_hold', 'complete', 'cancelled'];
const TASK_STATUSES = ['todo', 'in_progress', 'blocked', 'done'];
const TASK_PRIORITIES = ['low', 'medium', 'high', 'critical'];

async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS projects (
      project_id    TEXT PRIMARY KEY,
      owner_did     TEXT NOT NULL,
      name          TEXT NOT NULL,
      description   TEXT,
      status        TEXT NOT NULL DEFAULT 'active',
      due_date      DATE,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_projects_owner ON projects (owner_did);
    CREATE INDEX IF NOT EXISTS idx_projects_status ON projects (status);

    CREATE TABLE IF NOT EXISTS tasks (
      task_id            TEXT PRIMARY KEY,
      project_id         TEXT,
      owner_did          TEXT NOT NULL,
      assignee_did       TEXT,
      title              TEXT NOT NULL,
      description        TEXT,
      status             TEXT NOT NULL DEFAULT 'todo',
      priority           TEXT NOT NULL DEFAULT 'medium',
      labels             TEXT[] DEFAULT '{}',
      due_date           DATE,
      parent_task_id     TEXT,
      dependencies       TEXT[] DEFAULT '{}',
      time_spent_seconds BIGINT DEFAULT 0,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at       TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks (project_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_owner ON tasks (owner_did);
    CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks (assignee_did);
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks (status);

    CREATE TABLE IF NOT EXISTS task_comments (
      comment_id   TEXT PRIMARY KEY,
      task_id      TEXT NOT NULL,
      author_did   TEXT NOT NULL,
      body         TEXT NOT NULL,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_task_comments_task ON task_comments (task_id);
  `).catch(() => {});
}

function genId(prefix) {
  return `${prefix}_${cryptoLib.randomBytes(12).toString('hex')}`;
}

function registerProjectsRoutes(app, pool, verifyAgentAuth, auditChain) {
  const ProjectSchema = z.object({
    name: z.string().min(1).max(300),
    description: z.string().max(5000).optional(),
    status: z.enum(PROJECT_STATUSES).optional(),
    due_date: z.string().optional()
  });

  app.post('/v1/agents/:did/projects', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const parse = ProjectSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;
      const projectId = genId('prj');
      await pool.query(
        `INSERT INTO projects (project_id, owner_did, name, description, status, due_date)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [projectId, did, d.name, d.description || null, d.status || 'active', d.due_date || null]
      );
      await auditChain.append({ event_type: 'projects.created', project_id: projectId, owner_did: did, timestamp: new Date().toISOString() });
      return res.status(201).json({ project_id: projectId, owner_did: did, name: d.name });
    } catch (e) { return res.status(500).json({ error: 'create_failed', message: e.message }); }
  });

  app.get('/v1/agents/:did/projects', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(
      `SELECT * FROM projects WHERE owner_did=$1 ORDER BY created_at DESC`, [did]
    ).catch(() => ({ rows: [] }));
    return res.json({ projects: r.rows, count: r.rows.length });
  });

  app.put('/v1/agents/:did/projects/:id', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const parse = ProjectSchema.partial().safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;
      const fields = []; const params = []; let idx = 1;
      for (const [k, v] of Object.entries(d)) {
        if (v === undefined) continue;
        fields.push(`${k}=$${idx++}`); params.push(v);
      }
      if (!fields.length) return res.json({ project_id: req.params.id, unchanged: true });
      params.push(req.params.id, did);
      const r = await pool.query(
        `UPDATE projects SET ${fields.join(', ')}, updated_at=NOW()
         WHERE project_id=$${idx++} AND owner_did=$${idx} RETURNING project_id`,
        params
      ).catch(() => ({ rows: [] }));
      if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
      await auditChain.append({ event_type: 'projects.updated', project_id: req.params.id, owner_did: did, timestamp: new Date().toISOString() });
      return res.json({ project_id: req.params.id, updated: true });
    } catch (e) { return res.status(500).json({ error: 'update_failed', message: e.message }); }
  });

  app.delete('/v1/agents/:did/projects/:id', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(
      `DELETE FROM projects WHERE project_id=$1 AND owner_did=$2 RETURNING project_id`,
      [req.params.id, did]
    ).catch(() => ({ rows: [] }));
    if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
    await auditChain.append({ event_type: 'projects.deleted', project_id: req.params.id, owner_did: did, timestamp: new Date().toISOString() });
    return res.json({ deleted: true });
  });

  const TaskSchema = z.object({
    assignee_did: z.string().optional(),
    title: z.string().min(1).max(500),
    description: z.string().max(10000).optional(),
    status: z.enum(TASK_STATUSES).optional(),
    priority: z.enum(TASK_PRIORITIES).optional(),
    labels: z.array(z.string()).optional(),
    due_date: z.string().optional(),
    parent_task_id: z.string().optional(),
    dependencies: z.array(z.string()).optional(),
    time_spent_seconds: z.number().int().min(0).optional()
  });

  app.post('/v1/agents/:did/projects/:id/tasks', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const parse = TaskSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;
      const proj = await pool.query(`SELECT project_id FROM projects WHERE project_id=$1 AND owner_did=$2`, [req.params.id, did]).catch(() => ({ rows: [] }));
      if (!proj.rows[0]) return res.status(404).json({ error: 'project_not_found' });
      const taskId = genId('tsk');
      await pool.query(
        `INSERT INTO tasks (task_id, project_id, owner_did, assignee_did, title, description, status,
           priority, labels, due_date, parent_task_id, dependencies, time_spent_seconds)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [taskId, req.params.id, did, d.assignee_did || null, d.title, d.description || null,
         d.status || 'todo', d.priority || 'medium', d.labels || [], d.due_date || null,
         d.parent_task_id || null, d.dependencies || [], d.time_spent_seconds || 0]
      );
      await auditChain.append({ event_type: 'projects.task_created', task_id: taskId, project_id: req.params.id, owner_did: did, timestamp: new Date().toISOString() });
      return res.status(201).json({ task_id: taskId, project_id: req.params.id });
    } catch (e) { return res.status(500).json({ error: 'create_failed', message: e.message }); }
  });

  app.get('/v1/agents/:did/projects/:id/tasks', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(
      `SELECT * FROM tasks WHERE project_id=$1 AND owner_did=$2 ORDER BY created_at DESC`,
      [req.params.id, did]
    ).catch(() => ({ rows: [] }));
    return res.json({ tasks: r.rows, count: r.rows.length });
  });

  app.put('/v1/agents/:did/projects/:pid/tasks/:tid', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const parse = TaskSchema.partial().safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;
      const fields = []; const params = []; let idx = 1;
      for (const [k, v] of Object.entries(d)) {
        if (v === undefined) continue;
        fields.push(`${k}=$${idx++}`); params.push(v);
      }
      if (d.status === 'done') fields.push(`completed_at=NOW()`);
      if (!fields.length) return res.json({ task_id: req.params.tid, unchanged: true });
      params.push(req.params.tid, req.params.pid, did);
      const r = await pool.query(
        `UPDATE tasks SET ${fields.join(', ')}, updated_at=NOW()
         WHERE task_id=$${idx++} AND project_id=$${idx++} AND owner_did=$${idx} RETURNING task_id`,
        params
      ).catch(() => ({ rows: [] }));
      if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
      await auditChain.append({ event_type: 'projects.task_updated', task_id: req.params.tid, owner_did: did, timestamp: new Date().toISOString() });
      return res.json({ task_id: req.params.tid, updated: true });
    } catch (e) { return res.status(500).json({ error: 'update_failed', message: e.message }); }
  });

  app.get('/v1/agents/:did/projects/:id/board', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(
      `SELECT * FROM tasks WHERE project_id=$1 AND owner_did=$2 ORDER BY priority DESC, created_at DESC`,
      [req.params.id, did]
    ).catch(() => ({ rows: [] }));
    const board = {};
    for (const status of TASK_STATUSES) board[status] = [];
    for (const t of r.rows) (board[t.status] || (board[t.status] = [])).push(t);
    return res.json({ project_id: req.params.id, board });
  });

  app.post('/v1/agents/:did/tasks/:id/comments', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const body = z.object({ body: z.string().min(1).max(10000) }).safeParse(req.body || {});
      if (!body.success) return res.status(400).json({ error: 'invalid_input' });
      const commentId = genId('cmt');
      await pool.query(
        `INSERT INTO task_comments (comment_id, task_id, author_did, body) VALUES ($1,$2,$3,$4)`,
        [commentId, req.params.id, did, body.data.body]
      );
      await auditChain.append({ event_type: 'projects.task_comment', comment_id: commentId, task_id: req.params.id, author_did: did, timestamp: new Date().toISOString() });
      return res.status(201).json({ comment_id: commentId, task_id: req.params.id });
    } catch (e) { return res.status(500).json({ error: 'comment_failed', message: e.message }); }
  });

  app.get('/v1/agents/:did/tasks', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const params = [did];
    let sql = `SELECT * FROM tasks WHERE (owner_did=$1 OR assignee_did=$1)`;
    if (req.query.status) { params.push(req.query.status); sql += ` AND status=$${params.length}`; }
    if (req.query.assignee) { params.push(req.query.assignee); sql += ` AND assignee_did=$${params.length}`; }
    if (req.query.priority) { params.push(req.query.priority); sql += ` AND priority=$${params.length}`; }
    sql += ` ORDER BY created_at DESC LIMIT 500`;
    const r = await pool.query(sql, params).catch(() => ({ rows: [] }));
    return res.json({ tasks: r.rows, count: r.rows.length });
  });
}

module.exports = { migrate, registerProjectsRoutes, PROJECT_STATUSES, TASK_STATUSES, TASK_PRIORITIES };
