// ============================================================================
// realtime_ws.js — WebSocket-style bi-directional channel via long-polling
// fallback (no native WS dep on serverless). Topics: agent inbox, audit
// chain tail, multi-agent rooms. Adds full bidirectional comms alongside SSE.
// ============================================================================
const crypto = require('crypto');

async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS rt_channels (
      channel_id        TEXT PRIMARY KEY,
      owner_did         TEXT NOT NULL,
      kind              TEXT NOT NULL,
      slug              TEXT,
      members           TEXT[],
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS rt_messages (
      message_id        TEXT PRIMARY KEY,
      channel_id        TEXT NOT NULL,
      from_did          TEXT,
      kind              TEXT NOT NULL DEFAULT 'text',
      payload           JSONB NOT NULL,
      sequence          BIGSERIAL,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_rt_messages_channel_seq ON rt_messages (channel_id, sequence);
  `);
}

function newId(p) { return p + '_' + crypto.randomBytes(10).toString('hex'); }

function registerRealtimeWsRoutes(app, pool, verifyAgentAuth, auditChain) {
  const express = require('express');

  app.post('/v1/agents/:did/rt/channels', express.json(), async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const { kind, slug, members } = req.body || {};
    if (!kind) return res.status(400).json({ error: 'kind_required' });
    const id = newId('ch');
    await pool.query(
      `INSERT INTO rt_channels (channel_id, owner_did, kind, slug, members)
       VALUES ($1,$2,$3,$4,$5)`,
      [id, did, kind, slug || null, members || [did]]
    );
    if (auditChain) await auditChain.append({ event_type: 'rt.channel_created', channel_id: id, owner_did: did, kind }).catch(() => {});
    res.status(201).json({ channel_id: id });
  });

  app.post('/v1/rt/channels/:cid/send', express.json({ limit: '2mb' }), async (req, res) => {
    const did = req.headers['x-agent-did'];
    if (!did) return res.status(401).json({ error: 'agent_did_required' });
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const id = newId('msg');
    await pool.query(
      `INSERT INTO rt_messages (message_id, channel_id, from_did, kind, payload)
       VALUES ($1,$2,$3,$4,$5)`,
      [id, req.params.cid, did, req.body?.kind || 'text', JSON.stringify(req.body?.payload || { text: req.body?.text || '' })]
    );
    res.status(201).json({ message_id: id });
  });

  // Long-poll: blocks up to 25s for new messages after the given sequence
  app.get('/v1/rt/channels/:cid/poll', async (req, res) => {
    const did = req.headers['x-agent-did'];
    if (!did) return res.status(401).json({ error: 'agent_did_required' });
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const since = parseInt(req.query.since_sequence) || 0;
    const deadline = Date.now() + 25000;

    const fetchNew = async () => {
      const r = await pool.query(`
        SELECT message_id, from_did, kind, payload, sequence, created_at
        FROM rt_messages WHERE channel_id = $1 AND sequence > $2
        ORDER BY sequence ASC LIMIT 100
      `, [req.params.cid, since]).catch(() => ({ rows: [] }));
      return r.rows;
    };

    let msgs = await fetchNew();
    while (msgs.length === 0 && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 1000));
      msgs = await fetchNew();
    }
    res.json({ channel_id: req.params.cid, messages: msgs, next_since: msgs.length ? Number(msgs[msgs.length - 1].sequence) : since });
  });

  app.get('/v1/agents/:did/rt/channels', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(`SELECT channel_id, kind, slug, members, created_at FROM rt_channels WHERE owner_did=$1 OR $1 = ANY(members) ORDER BY created_at DESC LIMIT 100`,
      [did]).catch(() => ({ rows: [] }));
    res.json({ channels: r.rows });
  });
}

module.exports = { migrate, registerRealtimeWsRoutes };
