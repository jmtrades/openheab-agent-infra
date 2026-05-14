// ============================================================================
// OpenHeab Chat — Real-time synchronous chat (distinct from inbox A2A async).
// Supports direct/group/agent_human/agent_agent rooms with long-poll delivery.
// ============================================================================
const express = require('express');
const cryptoLib = require('crypto');
const { z } = require('zod');

const ROOM_KINDS = ['direct', 'group', 'agent_human', 'agent_agent'];
const MSG_KINDS = ['text', 'image', 'file', 'system'];

async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS chat_rooms (
      room_id      TEXT PRIMARY KEY,
      name         TEXT,
      owner_did    TEXT NOT NULL,
      kind         TEXT NOT NULL DEFAULT 'group',
      member_dids  TEXT[] NOT NULL DEFAULT '{}',
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      archived_at  TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_chat_rooms_owner ON chat_rooms (owner_did);
    CREATE INDEX IF NOT EXISTS idx_chat_rooms_members ON chat_rooms USING GIN (member_dids);

    CREATE TABLE IF NOT EXISTS chat_messages (
      message_id   TEXT PRIMARY KEY,
      room_id      TEXT NOT NULL,
      sender_did   TEXT NOT NULL,
      content      TEXT,
      kind         TEXT NOT NULL DEFAULT 'text',
      attachments  JSONB,
      reply_to     TEXT,
      edited_at    TIMESTAMPTZ,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_chat_messages_room_time ON chat_messages (room_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_chat_messages_sender ON chat_messages (sender_did);

    CREATE TABLE IF NOT EXISTS chat_presence (
      room_id       TEXT NOT NULL,
      did           TEXT NOT NULL,
      last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      typing        BOOLEAN NOT NULL DEFAULT FALSE,
      PRIMARY KEY (room_id, did)
    );
    CREATE INDEX IF NOT EXISTS idx_chat_presence_room ON chat_presence (room_id);
  `).catch(() => {});
}

function genId(prefix) {
  return `${prefix}_${cryptoLib.randomBytes(12).toString('hex')}`;
}

async function isMember(pool, roomId, did) {
  const r = await pool.query(
    `SELECT 1 FROM chat_rooms WHERE room_id=$1 AND ($2 = owner_did OR $2 = ANY(member_dids))`,
    [roomId, did]
  ).catch(() => ({ rows: [] }));
  return !!r.rows[0];
}

function registerChatRoutes(app, pool, verifyAgentAuth, auditChain) {
  // POST /v1/chat/rooms — create a room
  const RoomSchema = z.object({
    name: z.string().max(300).optional(),
    owner_did: z.string(),
    kind: z.enum(ROOM_KINDS).default('group'),
    member_dids: z.array(z.string()).optional()
  });

  app.post('/v1/chat/rooms', express.json(), async (req, res) => {
    try {
      const parse = RoomSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;
      const auth = await verifyAgentAuth(req, d.owner_did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const roomId = genId('room');
      const members = Array.from(new Set([d.owner_did, ...(d.member_dids || [])]));
      await pool.query(
        `INSERT INTO chat_rooms (room_id, name, owner_did, kind, member_dids)
         VALUES ($1,$2,$3,$4,$5)`,
        [roomId, d.name || null, d.owner_did, d.kind, members]
      );
      await auditChain.append({
        event_type: 'chat.room_created', room_id: roomId, owner_did: d.owner_did,
        kind: d.kind, member_count: members.length, timestamp: new Date().toISOString()
      });
      return res.status(201).json({ room_id: roomId, owner_did: d.owner_did, kind: d.kind, member_dids: members });
    } catch (e) { return res.status(500).json({ error: 'create_failed', message: e.message }); }
  });

  // GET /v1/agents/:did/chat/rooms
  app.get('/v1/agents/:did/chat/rooms', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(
      `SELECT * FROM chat_rooms WHERE ($1 = owner_did OR $1 = ANY(member_dids))
         AND archived_at IS NULL
       ORDER BY created_at DESC LIMIT 500`,
      [did]
    ).catch(() => ({ rows: [] }));
    return res.json({ rooms: r.rows, count: r.rows.length });
  });

  // POST /v1/chat/rooms/:id/messages
  const MsgSchema = z.object({
    sender_did: z.string(),
    content: z.string().max(40000).optional(),
    kind: z.enum(MSG_KINDS).default('text'),
    attachments: z.array(z.record(z.any())).optional(),
    reply_to: z.string().optional()
  });

  app.post('/v1/chat/rooms/:id/messages', express.json(), async (req, res) => {
    try {
      const parse = MsgSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;
      const auth = await verifyAgentAuth(req, d.sender_did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      if (!(await isMember(pool, req.params.id, d.sender_did))) {
        return res.status(403).json({ error: 'not_a_member' });
      }

      const messageId = genId('msg');
      await pool.query(
        `INSERT INTO chat_messages (message_id, room_id, sender_did, content, kind, attachments, reply_to)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [messageId, req.params.id, d.sender_did, d.content || null, d.kind,
         d.attachments ? JSON.stringify(d.attachments) : null, d.reply_to || null]
      );
      // Update sender presence
      await pool.query(
        `INSERT INTO chat_presence (room_id, did, last_seen_at, typing)
         VALUES ($1,$2, NOW(), FALSE)
         ON CONFLICT (room_id, did) DO UPDATE SET last_seen_at=NOW(), typing=FALSE`,
        [req.params.id, d.sender_did]
      ).catch(() => {});

      await auditChain.append({
        event_type: 'chat.message_sent', message_id: messageId,
        room_id: req.params.id, sender_did: d.sender_did, kind: d.kind,
        timestamp: new Date().toISOString()
      });
      return res.status(201).json({ message_id: messageId, room_id: req.params.id, sender_did: d.sender_did, created_at: new Date().toISOString() });
    } catch (e) { return res.status(500).json({ error: 'send_failed', message: e.message }); }
  });

  // GET /v1/chat/rooms/:id/messages?since=ISO — long-poll style
  app.get('/v1/chat/rooms/:id/messages', async (req, res) => {
    try {
      const did = req.headers['x-agent-did'] || req.query.did;
      if (!did) return res.status(401).json({ error: 'missing_did' });
      const auth = await verifyAgentAuth(req, String(did));
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      if (!(await isMember(pool, req.params.id, String(did)))) {
        return res.status(403).json({ error: 'not_a_member' });
      }
      const since = req.query.since ? new Date(req.query.since) : new Date(Date.now() - 24 * 3600 * 1000);
      const limit = Math.min(parseInt(req.query.limit) || 200, 1000);
      const r = await pool.query(
        `SELECT message_id, room_id, sender_did, content, kind, attachments,
                reply_to, edited_at, created_at
         FROM chat_messages WHERE room_id=$1 AND created_at > $2
         ORDER BY created_at ASC LIMIT $3`,
        [req.params.id, since, limit]
      ).catch(() => ({ rows: [] }));
      return res.json({ room_id: req.params.id, since: since.toISOString(), messages: r.rows, count: r.rows.length });
    } catch (e) { return res.status(500).json({ error: 'list_failed', message: e.message }); }
  });

  // POST /v1/chat/rooms/:id/presence — heartbeat with typing flag
  const PresenceSchema = z.object({
    did: z.string(),
    typing: z.boolean().optional()
  });
  app.post('/v1/chat/rooms/:id/presence', express.json(), async (req, res) => {
    try {
      const parse = PresenceSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input' });
      const auth = await verifyAgentAuth(req, parse.data.did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      if (!(await isMember(pool, req.params.id, parse.data.did))) {
        return res.status(403).json({ error: 'not_a_member' });
      }
      await pool.query(
        `INSERT INTO chat_presence (room_id, did, last_seen_at, typing)
         VALUES ($1,$2, NOW(), $3)
         ON CONFLICT (room_id, did) DO UPDATE SET last_seen_at=NOW(), typing=$3`,
        [req.params.id, parse.data.did, !!parse.data.typing]
      );
      return res.json({ room_id: req.params.id, did: parse.data.did, typing: !!parse.data.typing, last_seen_at: new Date().toISOString() });
    } catch (e) { return res.status(500).json({ error: 'presence_failed', message: e.message }); }
  });

  // GET /v1/chat/rooms/:id/presence — list online members (last_seen < 60s)
  app.get('/v1/chat/rooms/:id/presence', async (req, res) => {
    const cutoff = new Date(Date.now() - 60 * 1000);
    const r = await pool.query(
      `SELECT did, last_seen_at, typing FROM chat_presence
       WHERE room_id=$1 AND last_seen_at >= $2
       ORDER BY last_seen_at DESC`,
      [req.params.id, cutoff]
    ).catch(() => ({ rows: [] }));
    return res.json({ room_id: req.params.id, online: r.rows, count: r.rows.length });
  });

  // POST /v1/chat/rooms/:id/members
  const MemberSchema = z.object({
    actor_did: z.string(),
    add: z.array(z.string()).optional(),
    remove: z.array(z.string()).optional()
  });
  app.post('/v1/chat/rooms/:id/members', express.json(), async (req, res) => {
    try {
      const parse = MemberSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input' });
      const d = parse.data;
      const auth = await verifyAgentAuth(req, d.actor_did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const room = await pool.query(`SELECT owner_did, member_dids FROM chat_rooms WHERE room_id=$1`, [req.params.id]).catch(() => ({ rows: [] }));
      if (!room.rows[0]) return res.status(404).json({ error: 'not_found' });
      if (room.rows[0].owner_did !== d.actor_did) return res.status(403).json({ error: 'only_owner_can_modify_members' });
      let members = new Set(room.rows[0].member_dids || []);
      (d.add || []).forEach(x => members.add(x));
      (d.remove || []).forEach(x => members.delete(x));
      const final = Array.from(members);
      await pool.query(`UPDATE chat_rooms SET member_dids=$1 WHERE room_id=$2`, [final, req.params.id]);
      await auditChain.append({
        event_type: 'chat.members_updated', room_id: req.params.id,
        actor_did: d.actor_did, added: d.add || [], removed: d.remove || [],
        timestamp: new Date().toISOString()
      });
      return res.json({ room_id: req.params.id, member_dids: final });
    } catch (e) { return res.status(500).json({ error: 'members_update_failed', message: e.message }); }
  });

  // POST /v1/chat/rooms/:id/archive
  app.post('/v1/chat/rooms/:id/archive', express.json(), async (req, res) => {
    try {
      const actor = req.body && req.body.actor_did;
      if (!actor) return res.status(400).json({ error: 'missing_actor_did' });
      const auth = await verifyAgentAuth(req, actor);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const room = await pool.query(`SELECT owner_did FROM chat_rooms WHERE room_id=$1`, [req.params.id]).catch(() => ({ rows: [] }));
      if (!room.rows[0]) return res.status(404).json({ error: 'not_found' });
      if (room.rows[0].owner_did !== actor) return res.status(403).json({ error: 'only_owner_can_archive' });
      await pool.query(`UPDATE chat_rooms SET archived_at=NOW() WHERE room_id=$1`, [req.params.id]);
      await auditChain.append({
        event_type: 'chat.room_archived', room_id: req.params.id, actor_did: actor,
        timestamp: new Date().toISOString()
      });
      return res.json({ room_id: req.params.id, archived_at: new Date().toISOString() });
    } catch (e) { return res.status(500).json({ error: 'archive_failed', message: e.message }); }
  });
}

module.exports = { migrate, registerChatRoutes, ROOM_KINDS, MSG_KINDS, isMember };
