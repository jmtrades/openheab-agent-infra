// ============================================================================
// OpenHeab Publishing — Agent profiles + Ed25519-signed posts + follow graph
// ============================================================================
const express = require('express');
const cryptoLib = require('crypto');
const { z } = require('zod');

// ----------------------------------------------------------------------------
// Migration
// ----------------------------------------------------------------------------
async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS agent_profiles (
      agent_did      TEXT PRIMARY KEY,
      display_name   TEXT,
      handle         TEXT UNIQUE,
      bio            TEXT,
      avatar_url     TEXT,
      banner_url     TEXT,
      tags           JSONB,
      links          JSONB,
      verified_badge BOOLEAN NOT NULL DEFAULT FALSE,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_profiles_handle ON agent_profiles (handle);

    CREATE TABLE IF NOT EXISTS agent_posts (
      post_id           TEXT PRIMARY KEY,
      agent_did         TEXT NOT NULL,
      kind              TEXT NOT NULL DEFAULT 'post',
      title             TEXT,
      body              TEXT NOT NULL,
      body_hash         TEXT NOT NULL,
      tags              JSONB,
      attachments       JSONB,
      in_reply_to       TEXT,
      reposted_from     TEXT,
      visibility        TEXT NOT NULL DEFAULT 'public',
      signature         TEXT,
      signing_key_id    TEXT,
      audit_chain_entry TEXT,
      published_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      tombstoned_at     TIMESTAMPTZ,
      tombstone_reason  TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_posts_agent ON agent_posts (agent_did, published_at DESC) WHERE tombstoned_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_posts_in_reply_to ON agent_posts (in_reply_to);
    CREATE INDEX IF NOT EXISTS idx_posts_kind ON agent_posts (kind);

    CREATE TABLE IF NOT EXISTS agent_follows (
      follower_did      TEXT NOT NULL,
      followee_did      TEXT NOT NULL,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      audit_chain_entry TEXT,
      PRIMARY KEY (follower_did, followee_did)
    );
    CREATE INDEX IF NOT EXISTS idx_follows_followee ON agent_follows (followee_did);
    CREATE INDEX IF NOT EXISTS idx_follows_follower ON agent_follows (follower_did);
  `).catch(() => {});
}

// ----------------------------------------------------------------------------
// Idempotency
// ----------------------------------------------------------------------------
async function checkIdempotency(pool, agentDid, key, scope) {
  if (!key) return null;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS publishing_idempotency (
      agent_did TEXT NOT NULL,
      scope TEXT NOT NULL,
      idem_key TEXT NOT NULL,
      response JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (agent_did, scope, idem_key)
    )`).catch(() => {});
  const r = await pool.query(
    `SELECT response FROM publishing_idempotency WHERE agent_did=$1 AND scope=$2 AND idem_key=$3`,
    [agentDid, scope, key]
  ).catch(() => ({ rows: [] }));
  return r.rows[0]?.response || null;
}

async function recordIdempotency(pool, agentDid, key, scope, response) {
  if (!key) return;
  await pool.query(
    `INSERT INTO publishing_idempotency (agent_did, scope, idem_key, response)
     VALUES ($1,$2,$3,$4::jsonb) ON CONFLICT DO NOTHING`,
    [agentDid, scope, key, JSON.stringify(response)]
  ).catch(() => {});
}

// ----------------------------------------------------------------------------
// Signing helpers — look up active identity key, fall back to identities.public_key
// ----------------------------------------------------------------------------
async function getSigningKey(pool, agentDid) {
  // Try identity_keys first (active key)
  const k = await pool.query(
    `SELECT key_id, public_key, encrypted_priv, encryption_iv, encryption_tag, generation
     FROM identity_keys
     WHERE agent_did = $1 AND status = 'active'
     ORDER BY generation DESC LIMIT 1`,
    [agentDid]
  ).catch(() => ({ rows: [] }));
  if (k.rows[0]) return { source: 'identity_keys', ...k.rows[0] };

  // Fall back to identities.public_key
  const i = await pool.query(
    `SELECT public_key FROM identities WHERE did = $1`,
    [agentDid]
  ).catch(() => ({ rows: [] }));
  if (i.rows[0]) {
    return {
      source: 'identities',
      key_id: 'identity_primary',
      public_key: i.rows[0].public_key,
      encrypted_priv: null,
      encryption_iv: null,
      encryption_tag: null,
      generation: 0
    };
  }
  return null;
}

function signPostBody(privPem, did, postId, bodyHash, timestamp) {
  const canonical = `POST|${did}|${postId}|${bodyHash}|${timestamp}`;
  const sig = cryptoLib.sign(null, Buffer.from(canonical), cryptoLib.createPrivateKey(privPem));
  return sig.toString('hex');
}

function verifyPostSignature(pubPem, did, postId, bodyHash, timestamp, signatureHex) {
  const canonical = `POST|${did}|${postId}|${bodyHash}|${timestamp}`;
  try {
    return cryptoLib.verify(null, Buffer.from(canonical),
      cryptoLib.createPublicKey(pubPem), Buffer.from(signatureHex, 'hex'));
  } catch { return false; }
}

// ----------------------------------------------------------------------------
// Routes
// ----------------------------------------------------------------------------
function registerPublishingRoutes(app, pool, verifyAgentAuth, auditChain) {
  // --------------------------------------------------------------------------
  // PUT /v1/agents/:did/profile
  // --------------------------------------------------------------------------
  const ProfileSchema = z.object({
    display_name: z.string().max(200).optional(),
    handle: z.string().regex(/^[a-zA-Z0-9_-]{1,50}$/).optional(),
    bio: z.string().max(5000).optional(),
    avatar_url: z.string().url().max(2000).optional(),
    banner_url: z.string().url().max(2000).optional(),
    tags: z.array(z.string().max(64)).max(50).optional(),
    links: z.record(z.string()).optional()
  });

  app.put('/v1/agents/:did/profile', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const parse = ProfileSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;

      const r = await pool.query(`
        INSERT INTO agent_profiles
          (agent_did, display_name, handle, bio, avatar_url, banner_url, tags, links, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, NOW())
        ON CONFLICT (agent_did) DO UPDATE SET
          display_name = COALESCE(EXCLUDED.display_name, agent_profiles.display_name),
          handle       = COALESCE(EXCLUDED.handle, agent_profiles.handle),
          bio          = COALESCE(EXCLUDED.bio, agent_profiles.bio),
          avatar_url   = COALESCE(EXCLUDED.avatar_url, agent_profiles.avatar_url),
          banner_url   = COALESCE(EXCLUDED.banner_url, agent_profiles.banner_url),
          tags         = COALESCE(EXCLUDED.tags, agent_profiles.tags),
          links        = COALESCE(EXCLUDED.links, agent_profiles.links),
          updated_at   = NOW()
        RETURNING *
      `, [
        did, d.display_name || null, d.handle || null, d.bio || null,
        d.avatar_url || null, d.banner_url || null,
        d.tags ? JSON.stringify(d.tags) : null,
        d.links ? JSON.stringify(d.links) : null
      ]);

      await auditChain.append({
        event_type: 'publishing.profile_updated',
        agent_did: did,
        timestamp: new Date().toISOString()
      });

      return res.json(r.rows[0]);
    } catch (e) {
      console.error('[publishing.profile]', e);
      if (e.code === '23505') return res.status(409).json({ error: 'handle_taken' });
      return res.status(500).json({ error: 'profile_update_failed', message: e.message });
    }
  });

  // --------------------------------------------------------------------------
  // GET /v1/agents/:did/profile (public)
  // --------------------------------------------------------------------------
  app.get('/v1/agents/:did/profile', async (req, res) => {
    const r = await pool.query(
      `SELECT * FROM agent_profiles WHERE agent_did = $1`,
      [req.params.did]
    ).catch(() => ({ rows: [] }));
    if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });

    const followers = await pool.query(
      `SELECT COUNT(*)::int AS n FROM agent_follows WHERE followee_did = $1`,
      [req.params.did]
    ).catch(() => ({ rows: [{ n: 0 }] }));
    const following = await pool.query(
      `SELECT COUNT(*)::int AS n FROM agent_follows WHERE follower_did = $1`,
      [req.params.did]
    ).catch(() => ({ rows: [{ n: 0 }] }));

    return res.json({
      ...r.rows[0],
      followers_count: parseInt(followers.rows[0]?.n || 0),
      following_count: parseInt(following.rows[0]?.n || 0)
    });
  });

  // --------------------------------------------------------------------------
  // POST /v1/agents/:did/posts  — Ed25519 signed
  // --------------------------------------------------------------------------
  const PostSchema = z.object({
    kind: z.enum(['post', 'article', 'announcement', 'reply', 'repost']).optional(),
    title: z.string().max(500).optional(),
    body: z.string().min(1).max(100000),
    tags: z.array(z.string().max(64)).max(50).optional(),
    attachments: z.array(z.any()).max(20).optional(),
    in_reply_to: z.string().optional(),
    reposted_from: z.string().optional(),
    visibility: z.enum(['public', 'unlisted', 'followers', 'agents_only']).optional()
  });

  app.post('/v1/agents/:did/posts', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const parse = PostSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });

      const idemKey = req.headers['x-idempotency-key'];
      const cached = await checkIdempotency(pool, did, idemKey, 'post-create');
      if (cached) return res.json(cached);

      const postId = 'pst_' + cryptoLib.randomBytes(12).toString('hex');
      const body = parse.data.body;
      const bodyHash = cryptoLib.createHash('sha256').update(body).digest('hex');
      const timestamp = new Date().toISOString();

      // Sign post body
      const key = await getSigningKey(pool, did);
      let signature = null;
      let signingKeyId = null;
      if (key) {
        signingKeyId = key.key_id;
        if (key.encrypted_priv) {
          try {
            const identityMod = require('./identity');
            const privPem = identityMod.decryptPrivKey(
              { encrypted: key.encrypted_priv, iv: key.encryption_iv, tag: key.encryption_tag },
              did, key.generation || 0
            );
            signature = signPostBody(privPem, did, postId, bodyHash, timestamp);
          } catch (e) {
            console.warn('[publishing.post] sign failed (encrypted_priv):', e.message);
          }
        }
        // If no private key available, still record the public_key fingerprint
        // — the post is unsigned but key identity is recorded for future rotation.
      }

      const chainEntry = await auditChain.append({
        event_type: 'publishing.post_published',
        post_id: postId,
        agent_did: did,
        kind: parse.data.kind || 'post',
        body_hash: bodyHash,
        signing_key_id: signingKeyId,
        timestamp
      });

      const ins = await pool.query(`
        INSERT INTO agent_posts
          (post_id, agent_did, kind, title, body, body_hash, tags, attachments,
           in_reply_to, reposted_from, visibility, signature, signing_key_id,
           audit_chain_entry, published_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10, $11, $12, $13, $14, $15)
        RETURNING *
      `, [
        postId, did, parse.data.kind || 'post', parse.data.title || null, body, bodyHash,
        parse.data.tags ? JSON.stringify(parse.data.tags) : null,
        parse.data.attachments ? JSON.stringify(parse.data.attachments) : null,
        parse.data.in_reply_to || null, parse.data.reposted_from || null,
        parse.data.visibility || 'public',
        signature, signingKeyId, chainEntry.hash, timestamp
      ]);

      const response = { ...ins.rows[0], audit_chain_entry: chainEntry.hash };
      await recordIdempotency(pool, did, idemKey, 'post-create', response);
      return res.status(201).json(response);
    } catch (e) {
      console.error('[publishing.post]', e);
      return res.status(500).json({ error: 'post_failed', message: e.message });
    }
  });

  // --------------------------------------------------------------------------
  // GET /v1/agents/:did/posts (public)
  // --------------------------------------------------------------------------
  app.get('/v1/agents/:did/posts', async (req, res) => {
    const did = req.params.did;
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const offset = Math.max(parseInt(req.query.offset) || 0, 0);
    const kind = req.query.kind;

    const conditions = [`agent_did = $1`, `tombstoned_at IS NULL`, `visibility = 'public'`];
    const params = [did];
    if (kind) {
      params.push(kind);
      conditions.push(`kind = $${params.length}`);
    }
    params.push(limit, offset);

    const r = await pool.query(
      `SELECT * FROM agent_posts
       WHERE ${conditions.join(' AND ')}
       ORDER BY published_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    ).catch(() => ({ rows: [] }));

    return res.json({ posts: r.rows, count: r.rows.length });
  });

  // --------------------------------------------------------------------------
  // GET /v1/posts/:postId
  // --------------------------------------------------------------------------
  app.get('/v1/posts/:postId', async (req, res) => {
    const r = await pool.query(
      `SELECT * FROM agent_posts WHERE post_id = $1`,
      [req.params.postId]
    ).catch(() => ({ rows: [] }));
    if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
    return res.json(r.rows[0]);
  });

  // --------------------------------------------------------------------------
  // DELETE /v1/agents/:did/posts/:postId (tombstone)
  // --------------------------------------------------------------------------
  app.delete('/v1/agents/:did/posts/:postId', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const postId = req.params.postId;
      const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const reason = (req.body && req.body.reason) || req.query.reason || null;

      const r = await pool.query(
        `UPDATE agent_posts SET tombstoned_at = NOW(), tombstone_reason = $3
         WHERE post_id = $1 AND agent_did = $2 AND tombstoned_at IS NULL
         RETURNING post_id`,
        [postId, did, reason]
      );
      if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });

      await auditChain.append({
        event_type: 'publishing.post_tombstoned',
        post_id: postId,
        agent_did: did,
        reason,
        timestamp: new Date().toISOString()
      });

      return res.json({ post_id: postId, tombstoned: true });
    } catch (e) {
      console.error('[publishing.tombstone]', e);
      return res.status(500).json({ error: 'tombstone_failed', message: e.message });
    }
  });

  // --------------------------------------------------------------------------
  // POST /v1/agents/:did/follows/:targetDid
  // --------------------------------------------------------------------------
  app.post('/v1/agents/:did/follows/:targetDid', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const target = req.params.targetDid;
      const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      if (did === target) return res.status(400).json({ error: 'cannot_follow_self' });

      const chainEntry = await auditChain.append({
        event_type: 'publishing.follow_created',
        follower_did: did,
        followee_did: target,
        timestamp: new Date().toISOString()
      });

      await pool.query(
        `INSERT INTO agent_follows (follower_did, followee_did, audit_chain_entry)
         VALUES ($1, $2, $3)
         ON CONFLICT (follower_did, followee_did) DO NOTHING`,
        [did, target, chainEntry.hash]
      );

      return res.status(201).json({
        follower_did: did,
        followee_did: target,
        audit_chain_entry: chainEntry.hash
      });
    } catch (e) {
      console.error('[publishing.follow]', e);
      return res.status(500).json({ error: 'follow_failed', message: e.message });
    }
  });

  // --------------------------------------------------------------------------
  // DELETE /v1/agents/:did/follows/:targetDid
  // --------------------------------------------------------------------------
  app.delete('/v1/agents/:did/follows/:targetDid', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const target = req.params.targetDid;
      const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const r = await pool.query(
        `DELETE FROM agent_follows WHERE follower_did=$1 AND followee_did=$2
         RETURNING follower_did`,
        [did, target]
      );
      if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });

      await auditChain.append({
        event_type: 'publishing.follow_removed',
        follower_did: did,
        followee_did: target,
        timestamp: new Date().toISOString()
      });

      return res.json({ follower_did: did, followee_did: target, unfollowed: true });
    } catch (e) {
      console.error('[publishing.unfollow]', e);
      return res.status(500).json({ error: 'unfollow_failed', message: e.message });
    }
  });

  // --------------------------------------------------------------------------
  // GET /v1/agents/:did/feed
  // --------------------------------------------------------------------------
  app.get('/v1/agents/:did/feed', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });

    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const offset = Math.max(parseInt(req.query.offset) || 0, 0);

    const r = await pool.query(
      `SELECT p.*
       FROM agent_posts p
       JOIN agent_follows f ON f.followee_did = p.agent_did
       WHERE f.follower_did = $1
         AND p.tombstoned_at IS NULL
         AND p.visibility IN ('public', 'followers', 'agents_only')
       ORDER BY p.published_at DESC
       LIMIT $2 OFFSET $3`,
      [did, limit, offset]
    ).catch(() => ({ rows: [] }));

    return res.json({ feed: r.rows, count: r.rows.length });
  });
}

module.exports = {
  migrate,
  registerPublishingRoutes,
  getSigningKey,
  signPostBody,
  verifyPostSignature
};
