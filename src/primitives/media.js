// ============================================================================
// OpenHeab Media — Podcast / video / livestream / radio infrastructure.
// Channels, episodes (audio/video blobs), subscriptions, plays tracking,
// livestreams (RTMP/HLS), and public RSS XML feeds.
// ============================================================================
const express = require('express');
const cryptoLib = require('crypto');
const { z } = require('zod');

const MEDIA_KINDS = ['podcast', 'video', 'livestream', 'radio'];
const EPISODE_STATUSES = ['draft', 'published', 'archived'];
const STREAM_STATUSES = ['live', 'scheduled', 'ended'];

// ----------------------------------------------------------------------------
// Migration
// ----------------------------------------------------------------------------
async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS media_channels (
      channel_id        TEXT PRIMARY KEY,
      owner_did         TEXT NOT NULL,
      kind              TEXT NOT NULL,
      name              TEXT NOT NULL,
      description       TEXT,
      slug              TEXT NOT NULL UNIQUE,
      rss_url           TEXT,
      cover_blob_id     TEXT,
      language          TEXT,
      category          TEXT,
      public            BOOLEAN NOT NULL DEFAULT TRUE,
      subscriber_count  BIGINT NOT NULL DEFAULT 0,
      total_plays       BIGINT NOT NULL DEFAULT 0,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_media_channels_owner ON media_channels (owner_did);
    CREATE INDEX IF NOT EXISTS idx_media_channels_kind ON media_channels (kind, public);

    CREATE TABLE IF NOT EXISTS media_episodes (
      episode_id      TEXT PRIMARY KEY,
      channel_id      TEXT NOT NULL,
      title           TEXT NOT NULL,
      description     TEXT,
      audio_blob_id   TEXT,
      video_blob_id   TEXT,
      duration_seconds INTEGER,
      published_at    TIMESTAMPTZ,
      transcript      TEXT,
      chapters        JSONB,
      plays           BIGINT NOT NULL DEFAULT 0,
      status          TEXT NOT NULL DEFAULT 'draft',
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_media_episodes_channel ON media_episodes (channel_id, published_at DESC);
    CREATE INDEX IF NOT EXISTS idx_media_episodes_status ON media_episodes (status, published_at DESC);

    CREATE TABLE IF NOT EXISTS media_subscriptions (
      subscriber_did TEXT NOT NULL,
      channel_id     TEXT NOT NULL,
      subscribed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (subscriber_did, channel_id)
    );
    CREATE INDEX IF NOT EXISTS idx_media_subscriptions_channel ON media_subscriptions (channel_id);

    CREATE TABLE IF NOT EXISTS media_plays (
      play_id          TEXT PRIMARY KEY,
      episode_id       TEXT NOT NULL,
      listener_did     TEXT,
      position_seconds INTEGER,
      completed        BOOLEAN NOT NULL DEFAULT FALSE,
      played_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_media_plays_episode ON media_plays (episode_id, played_at DESC);
    CREATE INDEX IF NOT EXISTS idx_media_plays_listener ON media_plays (listener_did, played_at DESC);

    CREATE TABLE IF NOT EXISTS media_livestreams (
      stream_id          TEXT PRIMARY KEY,
      channel_id         TEXT NOT NULL,
      agent_did          TEXT NOT NULL,
      title              TEXT,
      rtmp_url           TEXT,
      hls_url            TEXT,
      status             TEXT NOT NULL DEFAULT 'scheduled',
      scheduled_at       TIMESTAMPTZ,
      started_at         TIMESTAMPTZ,
      ended_at           TIMESTAMPTZ,
      viewer_count_peak  INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_media_livestreams_channel ON media_livestreams (channel_id);
    CREATE INDEX IF NOT EXISTS idx_media_livestreams_status ON media_livestreams (status);
  `).catch(() => {});
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------
function genId(prefix) { return `${prefix}_${cryptoLib.randomBytes(12).toString('hex')}`; }

function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
}

function xmlEscape(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;'
  }[c]));
}

function buildRSS(channel, episodes, baseUrl) {
  const items = episodes.map(e => {
    const audioUrl = e.audio_blob_id
      ? `${baseUrl}/v1/storage/blobs/${e.audio_blob_id}/download`
      : '';
    return `
    <item>
      <title>${xmlEscape(e.title)}</title>
      <description>${xmlEscape(e.description || '')}</description>
      <guid isPermaLink="false">${xmlEscape(e.episode_id)}</guid>
      <pubDate>${new Date(e.published_at || e.created_at).toUTCString()}</pubDate>
      ${e.duration_seconds ? `<itunes:duration>${e.duration_seconds}</itunes:duration>` : ''}
      ${audioUrl ? `<enclosure url="${xmlEscape(audioUrl)}" type="audio/mpeg" />` : ''}
    </item>`;
  }).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
  <channel>
    <title>${xmlEscape(channel.name)}</title>
    <link>${xmlEscape(`${baseUrl}/v1/media/channels/${channel.slug}`)}</link>
    <description>${xmlEscape(channel.description || '')}</description>
    <language>${xmlEscape(channel.language || 'en')}</language>
    <itunes:category text="${xmlEscape(channel.category || 'Technology')}" />
    ${items}
  </channel>
</rss>`;
}

// ----------------------------------------------------------------------------
// Routes
// ----------------------------------------------------------------------------
function registerMediaRoutes(app, pool, verifyAgentAuth, auditChain) {
  // POST /v1/agents/:did/media/channels
  const ChannelSchema = z.object({
    kind: z.enum(MEDIA_KINDS),
    name: z.string().min(1).max(300),
    description: z.string().max(20000).optional(),
    slug: z.string().min(1).max(80).optional(),
    cover_blob_id: z.string().max(200).optional(),
    language: z.string().max(20).optional(),
    category: z.string().max(80).optional(),
    public: z.boolean().optional()
  });
  app.post('/v1/agents/:did/media/channels', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const parse = ChannelSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;
      const channelId = genId('chan');
      let slug = d.slug ? slugify(d.slug) : slugify(d.name);
      if (!slug) slug = `ch-${channelId.slice(-8)}`;
      // Make sure slug is unique; append suffix on collision.
      const baseSlug = slug;
      let n = 1;
      while (true) {
        const ex = await pool.query(`SELECT 1 FROM media_channels WHERE slug=$1`, [slug])
          .catch(() => ({ rows: [] }));
        if (!ex.rows[0]) break;
        n++;
        slug = `${baseSlug}-${n}`;
        if (n > 999) { slug = `${baseSlug}-${cryptoLib.randomBytes(3).toString('hex')}`; break; }
      }
      const baseUrl = process.env.OPERATOR_PUBLIC_URL || '';
      const rssUrl = `${baseUrl}/v1/media/channels/${slug}/rss`;
      await pool.query(
        `INSERT INTO media_channels
           (channel_id, owner_did, kind, name, description, slug, rss_url,
            cover_blob_id, language, category, public)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [channelId, did, d.kind, d.name, d.description || null, slug, rssUrl,
         d.cover_blob_id || null, d.language || 'en',
         d.category || null, d.public !== false]
      );
      await auditChain.append({
        event_type: 'media.channel_created', channel_id: channelId,
        owner_did: did, kind: d.kind, slug, timestamp: new Date().toISOString()
      });
      return res.status(201).json({ channel_id: channelId, slug, rss_url: rssUrl });
    } catch (e) { return res.status(500).json({ error: 'create_failed', message: e.message }); }
  });

  // POST /v1/agents/:did/media/channels/:id/episodes
  const EpisodeSchema = z.object({
    title: z.string().min(1).max(500),
    description: z.string().max(20000).optional(),
    audio_blob_id: z.string().max(200).optional(),
    video_blob_id: z.string().max(200).optional(),
    duration_seconds: z.number().int().nonnegative().optional(),
    transcript: z.string().max(1_000_000).optional(),
    chapters: z.array(z.record(z.any())).optional(),
    status: z.enum(EPISODE_STATUSES).optional(),
    published_at: z.string().optional()
  });
  app.post('/v1/agents/:did/media/channels/:id/episodes', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const ch = await pool.query(
        `SELECT channel_id FROM media_channels WHERE channel_id=$1 AND owner_did=$2`,
        [req.params.id, did]
      ).catch(() => ({ rows: [] }));
      if (!ch.rows[0]) return res.status(404).json({ error: 'channel_not_found' });
      const parse = EpisodeSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;
      const episodeId = genId('ep');
      const status = d.status || 'published';
      const publishedAt = d.published_at || (status === 'published' ? new Date().toISOString() : null);
      await pool.query(
        `INSERT INTO media_episodes
           (episode_id, channel_id, title, description, audio_blob_id, video_blob_id,
            duration_seconds, published_at, transcript, chapters, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11)`,
        [episodeId, req.params.id, d.title, d.description || null,
         d.audio_blob_id || null, d.video_blob_id || null,
         d.duration_seconds || null, publishedAt,
         d.transcript || null, JSON.stringify(d.chapters || []), status]
      );
      await auditChain.append({
        event_type: 'media.episode_created', episode_id: episodeId,
        channel_id: req.params.id, owner_did: did,
        status, timestamp: new Date().toISOString()
      });
      return res.status(201).json({ episode_id: episodeId, status });
    } catch (e) { return res.status(500).json({ error: 'create_failed', message: e.message }); }
  });

  // GET /v1/media/channels/:slug (public)
  app.get('/v1/media/channels/:slug', async (req, res) => {
    const r = await pool.query(
      `SELECT * FROM media_channels WHERE slug=$1 AND public=TRUE`, [req.params.slug]
    ).catch(() => ({ rows: [] }));
    if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
    return res.json(r.rows[0]);
  });

  // GET /v1/media/channels/:slug/episodes
  app.get('/v1/media/channels/:slug/episodes', async (req, res) => {
    const ch = await pool.query(
      `SELECT channel_id FROM media_channels WHERE slug=$1 AND public=TRUE`,
      [req.params.slug]
    ).catch(() => ({ rows: [] }));
    if (!ch.rows[0]) return res.status(404).json({ error: 'not_found' });
    const r = await pool.query(
      `SELECT * FROM media_episodes WHERE channel_id=$1 AND status='published'
       ORDER BY published_at DESC LIMIT 200`,
      [ch.rows[0].channel_id]
    ).catch(() => ({ rows: [] }));
    return res.json({ episodes: r.rows, count: r.rows.length });
  });

  // POST /v1/agents/:did/media/channels/:id/subscribe
  app.post('/v1/agents/:did/media/channels/:id/subscribe', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const ch = await pool.query(
        `SELECT channel_id FROM media_channels WHERE channel_id=$1`, [req.params.id]
      ).catch(() => ({ rows: [] }));
      if (!ch.rows[0]) return res.status(404).json({ error: 'channel_not_found' });
      const ins = await pool.query(
        `INSERT INTO media_subscriptions (subscriber_did, channel_id)
         VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING subscriber_did`,
        [did, req.params.id]
      ).catch(() => ({ rows: [] }));
      if (ins.rows[0]) {
        await pool.query(
          `UPDATE media_channels SET subscriber_count = subscriber_count + 1
           WHERE channel_id=$1`, [req.params.id]
        ).catch(() => {});
      }
      await auditChain.append({
        event_type: 'media.subscribed', channel_id: req.params.id,
        subscriber_did: did, timestamp: new Date().toISOString()
      });
      return res.json({ channel_id: req.params.id, subscribed: true });
    } catch (e) { return res.status(500).json({ error: 'subscribe_failed', message: e.message }); }
  });

  // POST /v1/agents/:did/media/episodes/:id/play
  const PlaySchema = z.object({
    position_seconds: z.number().int().nonnegative().optional(),
    completed: z.boolean().optional()
  });
  app.post('/v1/agents/:did/media/episodes/:id/play', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const parse = PlaySchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;
      const ep = await pool.query(
        `SELECT episode_id, channel_id FROM media_episodes WHERE episode_id=$1`,
        [req.params.id]
      ).catch(() => ({ rows: [] }));
      if (!ep.rows[0]) return res.status(404).json({ error: 'episode_not_found' });
      const playId = genId('play');
      await pool.query(
        `INSERT INTO media_plays (play_id, episode_id, listener_did, position_seconds, completed)
         VALUES ($1, $2, $3, $4, $5)`,
        [playId, req.params.id, did, d.position_seconds || 0, !!d.completed]
      );
      await pool.query(
        `UPDATE media_episodes SET plays = plays + 1 WHERE episode_id=$1`,
        [req.params.id]
      ).catch(() => {});
      await pool.query(
        `UPDATE media_channels SET total_plays = total_plays + 1 WHERE channel_id=$1`,
        [ep.rows[0].channel_id]
      ).catch(() => {});
      return res.json({ play_id: playId, episode_id: req.params.id });
    } catch (e) { return res.status(500).json({ error: 'play_failed', message: e.message }); }
  });

  // POST /v1/agents/:did/media/livestreams/start
  const StreamStartSchema = z.object({
    channel_id: z.string(),
    title: z.string().max(500).optional(),
    scheduled_at: z.string().optional()
  });
  app.post('/v1/agents/:did/media/livestreams/start', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const parse = StreamStartSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;
      const ch = await pool.query(
        `SELECT channel_id FROM media_channels WHERE channel_id=$1 AND owner_did=$2`,
        [d.channel_id, did]
      ).catch(() => ({ rows: [] }));
      if (!ch.rows[0]) return res.status(404).json({ error: 'channel_not_found' });
      const streamId = genId('strm');
      const streamKey = cryptoLib.randomBytes(16).toString('hex');
      const baseUrl = process.env.OPERATOR_PUBLIC_URL || '';
      const rtmpUrl = `rtmp://stream.openheab.invalid/live/${streamKey}`;
      const hlsUrl = `${baseUrl}/v1/media/livestreams/${streamId}/playlist.m3u8`;
      const isScheduled = !!d.scheduled_at && new Date(d.scheduled_at) > new Date();
      await pool.query(
        `INSERT INTO media_livestreams
           (stream_id, channel_id, agent_did, title, rtmp_url, hls_url,
            status, scheduled_at, started_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [streamId, d.channel_id, did, d.title || null, rtmpUrl, hlsUrl,
         isScheduled ? 'scheduled' : 'live',
         d.scheduled_at || null, isScheduled ? null : new Date().toISOString()]
      );
      await auditChain.append({
        event_type: 'media.livestream_started', stream_id: streamId,
        channel_id: d.channel_id, agent_did: did,
        timestamp: new Date().toISOString()
      });
      return res.status(201).json({
        stream_id: streamId, rtmp_url: rtmpUrl, hls_url: hlsUrl,
        status: isScheduled ? 'scheduled' : 'live'
      });
    } catch (e) { return res.status(500).json({ error: 'start_failed', message: e.message }); }
  });

  // POST /v1/agents/:did/media/livestreams/:id/end
  app.post('/v1/agents/:did/media/livestreams/:id/end', async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const r = await pool.query(
        `UPDATE media_livestreams SET status='ended', ended_at=NOW()
         WHERE stream_id=$1 AND agent_did=$2 AND status IN ('live','scheduled')
         RETURNING stream_id, status, ended_at`,
        [req.params.id, did]
      ).catch(() => ({ rows: [] }));
      if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
      await auditChain.append({
        event_type: 'media.livestream_ended', stream_id: req.params.id,
        agent_did: did, timestamp: new Date().toISOString()
      });
      return res.json(r.rows[0]);
    } catch (e) { return res.status(500).json({ error: 'end_failed', message: e.message }); }
  });

  // GET /v1/agents/:did/media/channels/:id/rss   AND   /v1/media/channels/:slug/rss
  async function serveRSS(slugOrId, isId, res) {
    const where = isId ? 'channel_id' : 'slug';
    const ch = await pool.query(
      `SELECT * FROM media_channels WHERE ${where}=$1 AND public=TRUE`, [slugOrId]
    ).catch(() => ({ rows: [] }));
    if (!ch.rows[0]) return res.status(404).json({ error: 'not_found' });
    const eps = await pool.query(
      `SELECT * FROM media_episodes WHERE channel_id=$1 AND status='published'
       ORDER BY published_at DESC LIMIT 500`,
      [ch.rows[0].channel_id]
    ).catch(() => ({ rows: [] }));
    const baseUrl = process.env.OPERATOR_PUBLIC_URL || '';
    const xml = buildRSS(ch.rows[0], eps.rows, baseUrl);
    res.setHeader('content-type', 'application/rss+xml; charset=utf-8');
    return res.send(xml);
  }
  app.get('/v1/agents/:did/media/channels/:id/rss', async (req, res) => {
    return serveRSS(req.params.id, true, res);
  });
  app.get('/v1/media/channels/:slug/rss', async (req, res) => {
    return serveRSS(req.params.slug, false, res);
  });
}

module.exports = {
  migrate,
  registerMediaRoutes,
  buildRSS,
  slugify,
  xmlEscape,
  MEDIA_KINDS,
  EPISODE_STATUSES,
  STREAM_STATUSES
};
