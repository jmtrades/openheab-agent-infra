// ============================================================================
// OpenHeab GitHub — Git operations for agents (GitHub/GitLab/Bitbucket/self)
// Tables: git_repos, git_branches, git_commits, git_pull_requests, git_actions
// ============================================================================
const cryptoLib = require('crypto');
const express = require('express');
const { z } = require('zod');

const HOSTS = ['github', 'gitlab', 'bitbucket', 'self'];
const ACTION_KINDS = ['clone', 'commit', 'push', 'pr', 'merge', 'comment'];
const ACTION_STATUSES = ['pending', 'success', 'failed'];
const PR_STATUSES = ['open', 'merged', 'closed'];

let cost = null;
try { cost = require('./cost'); } catch { /* optional */ }

// ----------------------------------------------------------------------------
// Crypto helpers for token storage
// ----------------------------------------------------------------------------
function getMasterKek() {
  const raw = process.env.GIT_MASTER_KEK
           || process.env.IDENTITY_MASTER_KEK
           || 'openheab-git-default-kek';
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, 'hex');
  return cryptoLib.createHash('sha256').update(raw).digest();
}

function encryptToken(plaintext) {
  if (!plaintext) return null;
  const kek = getMasterKek();
  const iv = cryptoLib.randomBytes(12);
  const cipher = cryptoLib.createCipheriv('aes-256-gcm', kek, iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

function decryptToken(b64) {
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
    CREATE TABLE IF NOT EXISTS git_repos (
      repo_id        TEXT PRIMARY KEY,
      owner_did      TEXT NOT NULL,
      host           TEXT NOT NULL DEFAULT 'github',
      owner_slug     TEXT NOT NULL,
      name           TEXT NOT NULL,
      default_branch TEXT NOT NULL DEFAULT 'main',
      private        BOOLEAN NOT NULL DEFAULT FALSE,
      clone_url      TEXT,
      ssh_url        TEXT,
      token_enc      TEXT,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_synced_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_git_repos_owner ON git_repos (owner_did);
    CREATE INDEX IF NOT EXISTS idx_git_repos_slug ON git_repos (host, owner_slug, name);

    CREATE TABLE IF NOT EXISTS git_branches (
      repo_id        TEXT NOT NULL REFERENCES git_repos(repo_id) ON DELETE CASCADE,
      name           TEXT NOT NULL,
      sha            TEXT,
      ahead          INTEGER NOT NULL DEFAULT 0,
      behind         INTEGER NOT NULL DEFAULT 0,
      last_commit_at TIMESTAMPTZ,
      PRIMARY KEY (repo_id, name)
    );

    CREATE TABLE IF NOT EXISTS git_commits (
      commit_sha    TEXT PRIMARY KEY,
      repo_id       TEXT NOT NULL REFERENCES git_repos(repo_id) ON DELETE CASCADE,
      author_did    TEXT,
      author_email  TEXT,
      message       TEXT,
      parent_shas   TEXT[],
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_git_commits_repo ON git_commits (repo_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS git_pull_requests (
      pr_id        TEXT PRIMARY KEY,
      repo_id      TEXT NOT NULL REFERENCES git_repos(repo_id) ON DELETE CASCADE,
      number       INTEGER NOT NULL,
      title        TEXT NOT NULL,
      body         TEXT,
      head_branch  TEXT NOT NULL,
      base_branch  TEXT NOT NULL,
      status       TEXT NOT NULL DEFAULT 'open',
      author_did   TEXT,
      mergeable    BOOLEAN,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      merged_at    TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_git_prs_repo ON git_pull_requests (repo_id, status);

    CREATE TABLE IF NOT EXISTS git_actions (
      action_id   TEXT PRIMARY KEY,
      repo_id     TEXT,
      agent_did   TEXT NOT NULL,
      kind        TEXT NOT NULL,
      payload     JSONB,
      status      TEXT NOT NULL DEFAULT 'pending',
      result      JSONB,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_git_actions_agent ON git_actions (agent_did, created_at DESC);
  `);
}

function genRepoId()   { return 'repo_' + cryptoLib.randomBytes(12).toString('hex'); }
function genActionId() { return 'gact_' + cryptoLib.randomBytes(12).toString('hex'); }
function genPrId()     { return 'gpr_' + cryptoLib.randomBytes(12).toString('hex'); }
function genCommitSha() {
  return cryptoLib.randomBytes(20).toString('hex');
}

async function recordAction(pool, did, repoId, kind, payload, status, result) {
  const actionId = genActionId();
  await pool.query(
    `INSERT INTO git_actions (action_id, repo_id, agent_did, kind, payload, status, result)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7::jsonb)`,
    [actionId, repoId || null, did, kind,
     payload ? JSON.stringify(payload) : null,
     status, result ? JSON.stringify(result) : null]
  ).catch(() => {});
  if (cost) {
    await cost.recordCost(pool, {
      agent_did: did, resource_type: 'github.' + kind,
      amount_cents: 1, reference_id: actionId
    }).catch(() => {});
  }
  return actionId;
}

// ----------------------------------------------------------------------------
// Routes
// ----------------------------------------------------------------------------
function registerGithubRoutes(app, pool, verifyAgentAuth, auditChain) {
  // POST /v1/agents/:did/github/repos — register existing or create new
  const RepoSchema = z.object({
    host: z.enum(HOSTS).optional().default('github'),
    owner_slug: z.string().min(1).max(128),
    name: z.string().min(1).max(128),
    default_branch: z.string().max(128).optional().default('main'),
    private: z.boolean().optional().default(false),
    clone_url: z.string().max(512).optional(),
    ssh_url: z.string().max(512).optional(),
    token: z.string().max(512).optional(),
    create: z.boolean().optional().default(false)
  });

  app.post('/v1/agents/:did/github/repos', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const parse = RepoSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;

      const repoId = genRepoId();
      const cloneUrl = d.clone_url || `https://${d.host}.com/${d.owner_slug}/${d.name}.git`;
      const sshUrl = d.ssh_url || `git@${d.host}.com:${d.owner_slug}/${d.name}.git`;
      const tokenEnc = encryptToken(d.token || process.env.GITHUB_TOKEN || null);

      await pool.query(
        `INSERT INTO git_repos
         (repo_id, owner_did, host, owner_slug, name, default_branch, private, clone_url, ssh_url, token_enc)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [repoId, did, d.host, d.owner_slug, d.name, d.default_branch,
         d.private, cloneUrl, sshUrl, tokenEnc]
      );

      // Seed default branch
      await pool.query(
        `INSERT INTO git_branches (repo_id, name) VALUES ($1, $2)
         ON CONFLICT (repo_id, name) DO NOTHING`,
        [repoId, d.default_branch]
      );

      await recordAction(pool, did, repoId, 'clone',
        { host: d.host, owner_slug: d.owner_slug, name: d.name, create: d.create },
        'success', { repo_id: repoId });

      await auditChain.append({
        event_type: 'github.repo_registered',
        repo_id: repoId, owner_did: did, host: d.host,
        owner_slug: d.owner_slug, name: d.name,
        created: d.create,
        timestamp: new Date().toISOString()
      });

      return res.status(201).json({
        repo_id: repoId, owner_did: did, host: d.host,
        owner_slug: d.owner_slug, name: d.name,
        default_branch: d.default_branch, private: d.private,
        clone_url: cloneUrl, ssh_url: sshUrl,
        created_at: new Date().toISOString()
      });
    } catch (e) {
      console.error('[github.repo.create]', e);
      return res.status(500).json({ error: 'repo_create_failed', message: e.message });
    }
  });

  // GET /v1/agents/:did/github/repos
  app.get('/v1/agents/:did/github/repos', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });

    const r = await pool.query(
      `SELECT repo_id, host, owner_slug, name, default_branch, private,
              clone_url, ssh_url, created_at, last_synced_at
       FROM git_repos WHERE owner_did = $1 ORDER BY created_at DESC`,
      [did]
    ).catch(() => ({ rows: [] }));
    return res.json({ repos: r.rows, count: r.rows.length });
  });

  // POST /v1/agents/:did/github/repos/:id/clone
  app.post('/v1/agents/:did/github/repos/:id/clone', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const r = await pool.query(
        `SELECT * FROM git_repos WHERE repo_id = $1 AND owner_did = $2`,
        [req.params.id, did]
      ).catch(() => ({ rows: [] }));
      if (!r.rows[0]) return res.status(404).json({ error: 'repo_not_found' });
      const repo = r.rows[0];

      await pool.query(
        `UPDATE git_repos SET last_synced_at = NOW() WHERE repo_id = $1`,
        [repo.repo_id]
      );

      const actionId = await recordAction(pool, did, repo.repo_id, 'clone',
        { branch: req.body?.branch || repo.default_branch },
        'success', { clone_url: repo.clone_url });

      await auditChain.append({
        event_type: 'github.repo_cloned',
        repo_id: repo.repo_id, owner_did: did,
        timestamp: new Date().toISOString()
      });

      return res.json({
        action_id: actionId, repo_id: repo.repo_id, status: 'success',
        clone_url: repo.clone_url, ssh_url: repo.ssh_url,
        default_branch: repo.default_branch
      });
    } catch (e) {
      console.error('[github.clone]', e);
      return res.status(500).json({ error: 'clone_failed', message: e.message });
    }
  });

  // POST /v1/agents/:did/github/repos/:id/commit
  const CommitSchema = z.object({
    path: z.string().min(1).max(1024),
    content: z.string().max(10 * 1024 * 1024),
    message: z.string().min(1).max(4096),
    branch: z.string().max(128).optional(),
    author_email: z.string().max(256).optional()
  });

  app.post('/v1/agents/:did/github/repos/:id/commit',
    express.json({ limit: '12mb' }), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const parse = CommitSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;

      const r = await pool.query(
        `SELECT * FROM git_repos WHERE repo_id = $1 AND owner_did = $2`,
        [req.params.id, did]
      ).catch(() => ({ rows: [] }));
      if (!r.rows[0]) return res.status(404).json({ error: 'repo_not_found' });
      const repo = r.rows[0];

      const branch = d.branch || repo.default_branch;
      const branchR = await pool.query(
        `SELECT sha FROM git_branches WHERE repo_id = $1 AND name = $2`,
        [repo.repo_id, branch]
      ).catch(() => ({ rows: [] }));
      const parentSha = branchR.rows[0]?.sha;

      const commitSha = genCommitSha();
      await pool.query(
        `INSERT INTO git_commits
         (commit_sha, repo_id, author_did, author_email, message, parent_shas)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [commitSha, repo.repo_id, did, d.author_email || null, d.message,
         parentSha ? [parentSha] : []]
      );

      await pool.query(
        `INSERT INTO git_branches (repo_id, name, sha, ahead, last_commit_at)
         VALUES ($1,$2,$3,1,NOW())
         ON CONFLICT (repo_id, name) DO UPDATE SET
           sha = $3, ahead = git_branches.ahead + 1, last_commit_at = NOW()`,
        [repo.repo_id, branch, commitSha]
      );

      const actionId = await recordAction(pool, did, repo.repo_id, 'commit',
        { path: d.path, branch, message: d.message },
        'success', { commit_sha: commitSha });

      await auditChain.append({
        event_type: 'github.commit_created',
        repo_id: repo.repo_id, owner_did: did,
        commit_sha: commitSha, branch, path: d.path,
        timestamp: new Date().toISOString()
      });

      return res.status(201).json({
        action_id: actionId, commit_sha: commitSha,
        repo_id: repo.repo_id, branch, path: d.path,
        message: d.message, status: 'success'
      });
    } catch (e) {
      console.error('[github.commit]', e);
      return res.status(500).json({ error: 'commit_failed', message: e.message });
    }
  });

  // POST /v1/agents/:did/github/repos/:id/push
  const PushSchema = z.object({
    branch: z.string().max(128).optional(),
    force: z.boolean().optional().default(false)
  });

  app.post('/v1/agents/:did/github/repos/:id/push', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const parse = PushSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;

      const r = await pool.query(
        `SELECT * FROM git_repos WHERE repo_id = $1 AND owner_did = $2`,
        [req.params.id, did]
      ).catch(() => ({ rows: [] }));
      if (!r.rows[0]) return res.status(404).json({ error: 'repo_not_found' });
      const repo = r.rows[0];

      const branch = d.branch || repo.default_branch;
      const aheadR = await pool.query(
        `UPDATE git_branches SET ahead = 0 WHERE repo_id = $1 AND name = $2
         RETURNING sha, ahead`,
        [repo.repo_id, branch]
      ).catch(() => ({ rows: [] }));

      const actionId = await recordAction(pool, did, repo.repo_id, 'push',
        { branch, force: d.force }, 'success', { branch_head: aheadR.rows[0]?.sha });

      await auditChain.append({
        event_type: 'github.push',
        repo_id: repo.repo_id, owner_did: did, branch, force: d.force,
        timestamp: new Date().toISOString()
      });

      return res.json({
        action_id: actionId, repo_id: repo.repo_id, branch,
        status: 'success', head: aheadR.rows[0]?.sha || null
      });
    } catch (e) {
      console.error('[github.push]', e);
      return res.status(500).json({ error: 'push_failed', message: e.message });
    }
  });

  // POST /v1/agents/:did/github/repos/:id/prs — create PR
  const PrSchema = z.object({
    title: z.string().min(1).max(512),
    body: z.string().max(65536).optional(),
    head_branch: z.string().min(1).max(128),
    base_branch: z.string().max(128).optional()
  });

  app.post('/v1/agents/:did/github/repos/:id/prs', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const parse = PrSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;

      const r = await pool.query(
        `SELECT * FROM git_repos WHERE repo_id = $1 AND owner_did = $2`,
        [req.params.id, did]
      ).catch(() => ({ rows: [] }));
      if (!r.rows[0]) return res.status(404).json({ error: 'repo_not_found' });
      const repo = r.rows[0];

      const baseBranch = d.base_branch || repo.default_branch;
      const cnt = await pool.query(
        `SELECT COALESCE(MAX(number), 0) AS n FROM git_pull_requests WHERE repo_id = $1`,
        [repo.repo_id]
      ).catch(() => ({ rows: [{ n: 0 }] }));
      const number = parseInt(cnt.rows[0].n) + 1;
      const prId = genPrId();

      await pool.query(
        `INSERT INTO git_pull_requests
         (pr_id, repo_id, number, title, body, head_branch, base_branch,
          status, author_did, mergeable)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'open',$8,TRUE)`,
        [prId, repo.repo_id, number, d.title, d.body || null,
         d.head_branch, baseBranch, did]
      );

      const actionId = await recordAction(pool, did, repo.repo_id, 'pr',
        { number, title: d.title, head: d.head_branch, base: baseBranch },
        'success', { pr_id: prId });

      await auditChain.append({
        event_type: 'github.pr_created',
        pr_id: prId, repo_id: repo.repo_id, owner_did: did,
        number, head_branch: d.head_branch, base_branch: baseBranch,
        timestamp: new Date().toISOString()
      });

      return res.status(201).json({
        pr_id: prId, repo_id: repo.repo_id, number,
        title: d.title, head_branch: d.head_branch, base_branch: baseBranch,
        status: 'open', mergeable: true, author_did: did, action_id: actionId,
        created_at: new Date().toISOString()
      });
    } catch (e) {
      console.error('[github.pr.create]', e);
      return res.status(500).json({ error: 'pr_create_failed', message: e.message });
    }
  });

  // POST /v1/agents/:did/github/prs/:id/merge
  const MergeSchema = z.object({
    method: z.enum(['merge', 'squash', 'rebase']).optional().default('merge'),
    commit_message: z.string().max(4096).optional()
  });

  app.post('/v1/agents/:did/github/prs/:id/merge', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const parse = MergeSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;

      const r = await pool.query(
        `SELECT pr.*, r.owner_did AS repo_owner FROM git_pull_requests pr
         JOIN git_repos r ON r.repo_id = pr.repo_id
         WHERE pr.pr_id = $1`,
        [req.params.id]
      ).catch(() => ({ rows: [] }));
      if (!r.rows[0]) return res.status(404).json({ error: 'pr_not_found' });
      const pr = r.rows[0];
      if (pr.repo_owner !== did) return res.status(403).json({ error: 'forbidden' });
      if (pr.status !== 'open') return res.status(400).json({ error: 'pr_not_open', status: pr.status });
      if (!pr.mergeable) return res.status(400).json({ error: 'pr_not_mergeable' });

      const mergeSha = genCommitSha();
      await pool.query(
        `UPDATE git_pull_requests
         SET status = 'merged', merged_at = NOW()
         WHERE pr_id = $1`,
        [pr.pr_id]
      );

      await pool.query(
        `INSERT INTO git_commits
         (commit_sha, repo_id, author_did, message, parent_shas)
         VALUES ($1,$2,$3,$4,$5)`,
        [mergeSha, pr.repo_id, did,
         d.commit_message || `Merge PR #${pr.number}: ${pr.title}`, []]
      );

      const actionId = await recordAction(pool, did, pr.repo_id, 'merge',
        { pr_id: pr.pr_id, method: d.method },
        'success', { merge_sha: mergeSha });

      await auditChain.append({
        event_type: 'github.pr_merged',
        pr_id: pr.pr_id, repo_id: pr.repo_id, owner_did: did,
        number: pr.number, merge_sha: mergeSha, method: d.method,
        timestamp: new Date().toISOString()
      });

      return res.json({
        pr_id: pr.pr_id, status: 'merged', merge_sha: mergeSha,
        method: d.method, action_id: actionId,
        merged_at: new Date().toISOString()
      });
    } catch (e) {
      console.error('[github.merge]', e);
      return res.status(500).json({ error: 'merge_failed', message: e.message });
    }
  });

  // POST /v1/agents/:did/github/prs/:id/comment
  const CommentSchema = z.object({
    body: z.string().min(1).max(65536)
  });

  app.post('/v1/agents/:did/github/prs/:id/comment', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const parse = CommentSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;

      const r = await pool.query(
        `SELECT pr_id, repo_id, number FROM git_pull_requests WHERE pr_id = $1`,
        [req.params.id]
      ).catch(() => ({ rows: [] }));
      if (!r.rows[0]) return res.status(404).json({ error: 'pr_not_found' });
      const pr = r.rows[0];

      const actionId = await recordAction(pool, did, pr.repo_id, 'comment',
        { pr_id: pr.pr_id, body: d.body },
        'success', { length: d.body.length });

      await auditChain.append({
        event_type: 'github.pr_commented',
        pr_id: pr.pr_id, repo_id: pr.repo_id, agent_did: did,
        number: pr.number, comment_length: d.body.length,
        timestamp: new Date().toISOString()
      });

      return res.status(201).json({
        action_id: actionId, pr_id: pr.pr_id,
        commented_at: new Date().toISOString()
      });
    } catch (e) {
      console.error('[github.comment]', e);
      return res.status(500).json({ error: 'comment_failed', message: e.message });
    }
  });

  // GET /v1/agents/:did/github/actions (helper for visibility)
  app.get('/v1/agents/:did/github/actions', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const limit = Math.min(parseInt(req.query.limit) || 50, 500);
    const r = await pool.query(
      `SELECT action_id, repo_id, kind, payload, status, result, created_at
       FROM git_actions WHERE agent_did = $1
       ORDER BY created_at DESC LIMIT $2`,
      [did, limit]
    ).catch(() => ({ rows: [] }));
    return res.json({ actions: r.rows, count: r.rows.length });
  });
}

module.exports = {
  migrate,
  registerGithubRoutes,
  HOSTS,
  ACTION_KINDS,
  PR_STATUSES,
  encryptToken,
  decryptToken
};
