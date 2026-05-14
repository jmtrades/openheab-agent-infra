// ============================================================================
// OpenHeab News — News aggregation, RSS/API ingestion, alert monitoring.
// Supports sources, articles, keyword alerts with webhook delivery, FT search.
// ============================================================================
const express = require('express');
const cryptoLib = require('crypto');
const { z } = require('zod');

const SOURCE_KINDS = ['rss', 'api', 'scraper'];
const SOURCE_STATUSES = ['active', 'paused', 'broken'];

async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS news_sources (
      source_id        TEXT PRIMARY KEY,
      owner_did        TEXT NOT NULL,
      kind             TEXT NOT NULL DEFAULT 'rss',
      url              TEXT NOT NULL,
      name             TEXT,
      language         TEXT,
      refresh_minutes  INTEGER NOT NULL DEFAULT 60,
      last_fetched_at  TIMESTAMPTZ,
      status           TEXT NOT NULL DEFAULT 'active',
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_news_sources_owner ON news_sources (owner_did);
    CREATE INDEX IF NOT EXISTS idx_news_sources_status ON news_sources (status);

    CREATE TABLE IF NOT EXISTS news_articles (
      article_id      TEXT PRIMARY KEY,
      source_id       TEXT,
      agent_did       TEXT,
      title           TEXT,
      url             TEXT UNIQUE,
      summary         TEXT,
      content         TEXT,
      author          TEXT,
      published_at    TIMESTAMPTZ,
      tags            TEXT[] DEFAULT '{}',
      sentiment       TEXT,
      fingerprint     TEXT,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_news_articles_source ON news_articles (source_id);
    CREATE INDEX IF NOT EXISTS idx_news_articles_agent ON news_articles (agent_did, published_at DESC);
    CREATE INDEX IF NOT EXISTS idx_news_articles_published ON news_articles (published_at DESC);
    CREATE INDEX IF NOT EXISTS idx_news_articles_tags ON news_articles USING GIN (tags);

    CREATE TABLE IF NOT EXISTS news_alerts (
      alert_id          TEXT PRIMARY KEY,
      agent_did         TEXT NOT NULL,
      name              TEXT,
      query             TEXT,
      sources           TEXT[] DEFAULT '{}',
      keywords          TEXT[] DEFAULT '{}',
      must_match        TEXT[] DEFAULT '{}',
      negative_keywords TEXT[] DEFAULT '{}',
      delivered_count   INTEGER NOT NULL DEFAULT 0,
      webhook_url       TEXT,
      active            BOOLEAN NOT NULL DEFAULT TRUE,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_news_alerts_owner ON news_alerts (agent_did);

    CREATE TABLE IF NOT EXISTS news_deliveries (
      delivery_id   TEXT PRIMARY KEY,
      alert_id      TEXT NOT NULL,
      article_id    TEXT NOT NULL,
      status        TEXT NOT NULL DEFAULT 'pending',
      delivered_at  TIMESTAMPTZ,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_news_deliveries_alert ON news_deliveries (alert_id);
  `).catch(() => {});
}

function genId(prefix) { return `${prefix}_${cryptoLib.randomBytes(12).toString('hex')}`; }

function articleMatchesAlert(article, alert) {
  const text = `${article.title || ''} ${article.summary || ''} ${article.content || ''}`.toLowerCase();
  if (alert.negative_keywords && alert.negative_keywords.length) {
    for (const nk of alert.negative_keywords) {
      if (text.includes(String(nk).toLowerCase())) return false;
    }
  }
  if (alert.must_match && alert.must_match.length) {
    for (const m of alert.must_match) {
      if (!text.includes(String(m).toLowerCase())) return false;
    }
  }
  if (alert.keywords && alert.keywords.length) {
    return alert.keywords.some(k => text.includes(String(k).toLowerCase()));
  }
  if (alert.query && typeof alert.query === 'string') {
    return text.includes(alert.query.toLowerCase());
  }
  return true;
}

async function fetchSourceArticles(pool, source) {
  // In real life: HTTP fetch + RSS parse. Here: simulated to keep pure-stdlib.
  try {
    if (typeof fetch !== 'function') return [];
    const r = await fetch(source.url, { headers: { 'user-agent': 'openheab-news/1.0' } })
      .catch(() => null);
    if (!r || !r.ok) return [];
    const body = await r.text().catch(() => '');
    // Naive parse: extract <item>...<title>X</title>...<link>Y</link>
    const items = [];
    const re = /<item[\s\S]*?<\/item>/gi;
    const matches = body.match(re) || [];
    for (const m of matches.slice(0, 50)) {
      const title = (m.match(/<title>([\s\S]*?)<\/title>/i) || [])[1] || '';
      const link  = (m.match(/<link>([\s\S]*?)<\/link>/i) || [])[1] || '';
      const desc  = (m.match(/<description>([\s\S]*?)<\/description>/i) || [])[1] || '';
      const pubd  = (m.match(/<pubDate>([\s\S]*?)<\/pubDate>/i) || [])[1] || '';
      if (link) {
        items.push({
          title: title.replace(/<!\[CDATA\[|\]\]>/g, '').trim(),
          url: link.trim(),
          summary: desc.replace(/<!\[CDATA\[|\]\]>/g, '').trim(),
          published_at: pubd ? new Date(pubd) : new Date()
        });
      }
    }
    return items;
  } catch { return []; }
}

function registerNewsRoutes(app, pool, verifyAgentAuth, auditChain) {
  // POST /v1/agents/:did/news/sources
  const SourceSchema = z.object({
    kind: z.enum(SOURCE_KINDS).default('rss'),
    url: z.string().url(),
    name: z.string().max(300).optional(),
    language: z.string().max(10).optional(),
    refresh_minutes: z.number().int().min(5).max(1440).optional()
  });
  app.post('/v1/agents/:did/news/sources', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const parse = SourceSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;
      const sourceId = genId('nsrc');
      await pool.query(
        `INSERT INTO news_sources (source_id, owner_did, kind, url, name, language, refresh_minutes)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [sourceId, did, d.kind, d.url, d.name || null, d.language || null, d.refresh_minutes || 60]
      );
      await auditChain.append({
        event_type: 'news.source_added', source_id: sourceId, owner_did: did,
        url: d.url, timestamp: new Date().toISOString()
      });
      return res.status(201).json({ source_id: sourceId, kind: d.kind, url: d.url });
    } catch (e) { return res.status(500).json({ error: 'create_failed', message: e.message }); }
  });

  // GET /v1/agents/:did/news/sources
  app.get('/v1/agents/:did/news/sources', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(
      `SELECT * FROM news_sources WHERE owner_did=$1 ORDER BY created_at DESC`, [did]
    ).catch(() => ({ rows: [] }));
    return res.json({ sources: r.rows, count: r.rows.length });
  });

  // POST /v1/agents/:did/news/sources/:id/refresh
  app.post('/v1/agents/:did/news/sources/:id/refresh', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const s = await pool.query(
        `SELECT * FROM news_sources WHERE source_id=$1 AND owner_did=$2`,
        [req.params.id, did]
      ).catch(() => ({ rows: [] }));
      if (!s.rows[0]) return res.status(404).json({ error: 'not_found' });
      const items = await fetchSourceArticles(pool, s.rows[0]);
      let inserted = 0;
      for (const it of items) {
        const articleId = genId('art');
        const fp = cryptoLib.createHash('sha256').update(it.url || it.title || '').digest('hex').slice(0, 32);
        const r = await pool.query(
          `INSERT INTO news_articles (article_id, source_id, agent_did, title, url, summary,
                                      published_at, fingerprint)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT (url) DO NOTHING RETURNING article_id`,
          [articleId, req.params.id, did, it.title, it.url, it.summary, it.published_at, fp]
        ).catch(() => ({ rows: [] }));
        if (r.rows && r.rows.length) inserted++;
      }
      await pool.query(
        `UPDATE news_sources SET last_fetched_at=NOW(), status='active' WHERE source_id=$1`,
        [req.params.id]
      ).catch(() => {});
      await auditChain.append({
        event_type: 'news.source_refreshed', source_id: req.params.id, owner_did: did,
        inserted, timestamp: new Date().toISOString()
      });
      return res.json({ source_id: req.params.id, fetched: items.length, inserted });
    } catch (e) { return res.status(500).json({ error: 'refresh_failed', message: e.message }); }
  });

  // POST /v1/agents/:did/news/alerts
  const AlertSchema = z.object({
    name: z.string().max(300),
    query: z.string().max(2000).optional(),
    sources: z.array(z.string()).optional(),
    keywords: z.array(z.string()).optional(),
    must_match: z.array(z.string()).optional(),
    negative_keywords: z.array(z.string()).optional(),
    webhook_url: z.string().url().optional()
  });
  app.post('/v1/agents/:did/news/alerts', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const parse = AlertSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;
      const alertId = genId('nalrt');
      await pool.query(
        `INSERT INTO news_alerts (alert_id, agent_did, name, query, sources, keywords,
                                   must_match, negative_keywords, webhook_url, active)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,TRUE)`,
        [alertId, did, d.name, d.query || null, d.sources || [], d.keywords || [],
         d.must_match || [], d.negative_keywords || [], d.webhook_url || null]
      );
      await auditChain.append({
        event_type: 'news.alert_created', alert_id: alertId, agent_did: did,
        name: d.name, timestamp: new Date().toISOString()
      });
      return res.status(201).json({ alert_id: alertId, name: d.name, active: true });
    } catch (e) { return res.status(500).json({ error: 'create_failed', message: e.message }); }
  });

  // GET /v1/agents/:did/news/articles
  app.get('/v1/agents/:did/news/articles', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const params = [did];
    let sql = `SELECT * FROM news_articles WHERE agent_did=$1`;
    if (req.query.source_id) { params.push(req.query.source_id); sql += ` AND source_id=$${params.length}`; }
    if (req.query.tag) { params.push(req.query.tag); sql += ` AND $${params.length} = ANY(tags)`; }
    if (req.query.since) {
      params.push(new Date(req.query.since));
      sql += ` AND published_at >= $${params.length}`;
    }
    sql += ` ORDER BY published_at DESC NULLS LAST LIMIT 500`;
    const r = await pool.query(sql, params).catch(() => ({ rows: [] }));
    return res.json({ articles: r.rows, count: r.rows.length });
  });

  // POST /v1/agents/:did/news/search
  app.post('/v1/agents/:did/news/search', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const q = (req.body && req.body.q) ? String(req.body.q) : '';
      if (!q || q.length < 2) return res.status(400).json({ error: 'q_required' });
      const r = await pool.query(
        `SELECT * FROM news_articles
         WHERE agent_did=$1 AND (title ILIKE $2 OR summary ILIKE $2 OR content ILIKE $2)
         ORDER BY published_at DESC NULLS LAST LIMIT 200`,
        [did, `%${q}%`]
      ).catch(() => ({ rows: [] }));
      return res.json({ query: q, articles: r.rows, count: r.rows.length });
    } catch (e) { return res.status(500).json({ error: 'search_failed', message: e.message }); }
  });
}

// Cron handler: refresh active sources and trigger alerts.
async function newsRefreshCron(pool, auditChain) {
  const r = await pool.query(
    `SELECT * FROM news_sources WHERE status='active'
       AND (last_fetched_at IS NULL OR last_fetched_at < NOW() - (refresh_minutes || ' minutes')::interval)
     LIMIT 50`
  ).catch(() => ({ rows: [] }));
  let totalFetched = 0;
  let totalInserted = 0;
  for (const source of r.rows) {
    const items = await fetchSourceArticles(pool, source);
    totalFetched += items.length;
    for (const it of items) {
      const articleId = `art_${cryptoLib.randomBytes(12).toString('hex')}`;
      const fp = cryptoLib.createHash('sha256').update(it.url || it.title || '').digest('hex').slice(0, 32);
      const ins = await pool.query(
        `INSERT INTO news_articles (article_id, source_id, agent_did, title, url, summary,
                                    published_at, fingerprint)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (url) DO NOTHING RETURNING article_id, title, url, summary`,
        [articleId, source.source_id, source.owner_did, it.title, it.url, it.summary,
         it.published_at, fp]
      ).catch(() => ({ rows: [] }));
      if (ins.rows && ins.rows[0]) totalInserted++;

      // Check alerts owned by source.owner_did
      const alerts = await pool.query(
        `SELECT * FROM news_alerts WHERE agent_did=$1 AND active=TRUE`,
        [source.owner_did]
      ).catch(() => ({ rows: [] }));
      const article = ins.rows && ins.rows[0] ? { ...ins.rows[0], content: '' } : null;
      if (article) {
        for (const alert of alerts.rows) {
          if (!articleMatchesAlert(article, alert)) continue;
          if (alert.sources && alert.sources.length && !alert.sources.includes(source.source_id)) continue;
          await pool.query(
            `INSERT INTO news_deliveries (delivery_id, alert_id, article_id, status, delivered_at)
             VALUES ($1,$2,$3,'delivered', NOW())`,
            [`ndlv_${cryptoLib.randomBytes(10).toString('hex')}`, alert.alert_id, article.article_id]
          ).catch(() => {});
          await pool.query(
            `UPDATE news_alerts SET delivered_count = delivered_count + 1 WHERE alert_id=$1`,
            [alert.alert_id]
          ).catch(() => {});
          if (alert.webhook_url && typeof fetch === 'function') {
            fetch(alert.webhook_url, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ alert_id: alert.alert_id, article })
            }).catch(() => {});
          }
        }
      }
    }
    await pool.query(
      `UPDATE news_sources SET last_fetched_at=NOW() WHERE source_id=$1`,
      [source.source_id]
    ).catch(() => {});
  }
  if (auditChain) {
    await auditChain.append({
      event_type: 'news.refresh_run', sources: r.rows.length,
      fetched: totalFetched, inserted: totalInserted,
      timestamp: new Date().toISOString()
    });
  }
  return { sources: r.rows.length, fetched: totalFetched, inserted: totalInserted };
}

module.exports = {
  migrate, registerNewsRoutes, newsRefreshCron,
  SOURCE_KINDS, SOURCE_STATUSES, articleMatchesAlert
};
