// ============================================================================
// OpenHeab Advertising — Buy ad placements across Google, Meta, Twitter, TikTok,
// LinkedIn. Manages accounts, campaigns, creatives, targeting + custom audiences.
// Receives webhook metric updates from ad platforms.
// ============================================================================
const express = require('express');
const cryptoLib = require('crypto');
const { z } = require('zod');

const PLATFORMS = ['google', 'meta', 'twitter', 'tiktok', 'linkedin', 'reddit'];
const ACCOUNT_STATUSES = ['active', 'paused', 'suspended'];
const OBJECTIVES = ['conversions', 'awareness', 'traffic', 'engagement', 'app', 'leads'];
const CAMPAIGN_STATUSES = ['draft', 'active', 'paused', 'ended'];
const CREATIVE_KINDS = ['image', 'video', 'carousel', 'text'];

// ----------------------------------------------------------------------------
// Migration
// ----------------------------------------------------------------------------
async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ad_accounts (
      account_id           TEXT PRIMARY KEY,
      agent_did            TEXT NOT NULL,
      platform             TEXT NOT NULL,
      account_id_provider  TEXT,
      billing_address      JSONB,
      monthly_budget_cents BIGINT,
      status               TEXT NOT NULL DEFAULT 'active',
      created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_ad_accounts_agent ON ad_accounts (agent_did);
    CREATE INDEX IF NOT EXISTS idx_ad_accounts_platform ON ad_accounts (platform, status);

    CREATE TABLE IF NOT EXISTS ad_campaigns (
      campaign_id        TEXT PRIMARY KEY,
      account_id         TEXT NOT NULL,
      agent_did          TEXT NOT NULL,
      name               TEXT NOT NULL,
      objective          TEXT NOT NULL,
      status             TEXT NOT NULL DEFAULT 'draft',
      budget_cents       BIGINT,
      daily_budget_cents BIGINT,
      started_at         TIMESTAMPTZ,
      ended_at           TIMESTAMPTZ,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_ad_campaigns_account ON ad_campaigns (account_id);
    CREATE INDEX IF NOT EXISTS idx_ad_campaigns_agent ON ad_campaigns (agent_did, created_at DESC);

    CREATE TABLE IF NOT EXISTS ad_creatives (
      creative_id  TEXT PRIMARY KEY,
      campaign_id  TEXT NOT NULL,
      kind         TEXT NOT NULL,
      headline     TEXT,
      body         TEXT,
      media_url    TEXT,
      landing_url  TEXT,
      status       TEXT NOT NULL DEFAULT 'active',
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_ad_creatives_campaign ON ad_creatives (campaign_id);

    CREATE TABLE IF NOT EXISTS ad_targeting (
      campaign_id          TEXT PRIMARY KEY,
      demographics         JSONB,
      interests            TEXT[],
      geos                 TEXT[],
      devices              TEXT[],
      custom_audience_ids  TEXT[],
      updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS ad_metrics (
      campaign_id  TEXT NOT NULL,
      date         DATE NOT NULL,
      impressions  BIGINT NOT NULL DEFAULT 0,
      clicks       BIGINT NOT NULL DEFAULT 0,
      conversions  BIGINT NOT NULL DEFAULT 0,
      spend_cents  BIGINT NOT NULL DEFAULT 0,
      cpc_cents    BIGINT,
      cpm_cents    BIGINT,
      ctr_bps      INTEGER,
      PRIMARY KEY (campaign_id, date)
    );

    CREATE TABLE IF NOT EXISTS ad_audiences (
      audience_id  TEXT PRIMARY KEY,
      agent_did    TEXT NOT NULL,
      platform     TEXT NOT NULL,
      name         TEXT NOT NULL,
      size         INTEGER NOT NULL DEFAULT 0,
      definition   JSONB,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_ad_audiences_agent ON ad_audiences (agent_did);
  `).catch(() => {});
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------
function genId(prefix) { return `${prefix}_${cryptoLib.randomBytes(12).toString('hex')}`; }

// ----------------------------------------------------------------------------
// Routes
// ----------------------------------------------------------------------------
function registerAdvertisingRoutes(app, pool, verifyAgentAuth, auditChain) {
  // POST /v1/agents/:did/advertising/accounts
  const AccountSchema = z.object({
    platform: z.enum(PLATFORMS),
    account_id_provider: z.string().max(200).optional(),
    billing_address: z.record(z.any()).optional(),
    monthly_budget_cents: z.number().int().nonnegative().optional()
  });
  app.post('/v1/agents/:did/advertising/accounts', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const parse = AccountSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;
      const accountId = genId('adacct');
      await pool.query(
        `INSERT INTO ad_accounts
           (account_id, agent_did, platform, account_id_provider, billing_address, monthly_budget_cents)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6)`,
        [accountId, did, d.platform, d.account_id_provider || null,
         d.billing_address ? JSON.stringify(d.billing_address) : null,
         d.monthly_budget_cents || null]
      );
      await auditChain.append({
        event_type: 'advertising.account_created', account_id: accountId,
        agent_did: did, platform: d.platform, timestamp: new Date().toISOString()
      });
      return res.status(201).json({ account_id: accountId, platform: d.platform, status: 'active' });
    } catch (e) { return res.status(500).json({ error: 'create_failed', message: e.message }); }
  });

  // GET /v1/agents/:did/advertising/accounts
  app.get('/v1/agents/:did/advertising/accounts', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(
      `SELECT * FROM ad_accounts WHERE agent_did=$1 ORDER BY created_at DESC`, [did]
    ).catch(() => ({ rows: [] }));
    return res.json({ accounts: r.rows, count: r.rows.length });
  });

  // POST /v1/agents/:did/advertising/campaigns
  const CampaignSchema = z.object({
    account_id: z.string(),
    name: z.string().min(1).max(300),
    objective: z.enum(OBJECTIVES),
    budget_cents: z.number().int().nonnegative().optional(),
    daily_budget_cents: z.number().int().nonnegative().optional(),
    targeting: z.object({
      demographics: z.record(z.any()).optional(),
      interests: z.array(z.string()).optional(),
      geos: z.array(z.string()).optional(),
      devices: z.array(z.string()).optional(),
      custom_audience_ids: z.array(z.string()).optional()
    }).optional()
  });
  app.post('/v1/agents/:did/advertising/campaigns', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const parse = CampaignSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;
      const acct = await pool.query(
        `SELECT account_id FROM ad_accounts WHERE account_id=$1 AND agent_did=$2`,
        [d.account_id, did]
      ).catch(() => ({ rows: [] }));
      if (!acct.rows[0]) return res.status(404).json({ error: 'account_not_found' });

      const campaignId = genId('camp');
      await pool.query(
        `INSERT INTO ad_campaigns
           (campaign_id, account_id, agent_did, name, objective, status,
            budget_cents, daily_budget_cents)
         VALUES ($1,$2,$3,$4,$5,'draft',$6,$7)`,
        [campaignId, d.account_id, did, d.name, d.objective,
         d.budget_cents || null, d.daily_budget_cents || null]
      );
      if (d.targeting) {
        await pool.query(
          `INSERT INTO ad_targeting
             (campaign_id, demographics, interests, geos, devices, custom_audience_ids)
           VALUES ($1, $2::jsonb, $3, $4, $5, $6)
           ON CONFLICT (campaign_id) DO UPDATE
             SET demographics=$2::jsonb, interests=$3, geos=$4, devices=$5,
                 custom_audience_ids=$6, updated_at=NOW()`,
          [campaignId,
           d.targeting.demographics ? JSON.stringify(d.targeting.demographics) : null,
           d.targeting.interests || null,
           d.targeting.geos || null,
           d.targeting.devices || null,
           d.targeting.custom_audience_ids || null]
        );
      }
      await auditChain.append({
        event_type: 'advertising.campaign_created', campaign_id: campaignId,
        agent_did: did, objective: d.objective, timestamp: new Date().toISOString()
      });
      return res.status(201).json({ campaign_id: campaignId, status: 'draft' });
    } catch (e) { return res.status(500).json({ error: 'create_failed', message: e.message }); }
  });

  // GET /v1/agents/:did/advertising/campaigns
  app.get('/v1/agents/:did/advertising/campaigns', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const params = [did];
    let sql = `SELECT * FROM ad_campaigns WHERE agent_did=$1`;
    if (req.query.account_id) {
      params.push(req.query.account_id);
      sql += ` AND account_id=$${params.length}`;
    }
    if (req.query.status) {
      params.push(req.query.status);
      sql += ` AND status=$${params.length}`;
    }
    sql += ` ORDER BY created_at DESC LIMIT 200`;
    const r = await pool.query(sql, params).catch(() => ({ rows: [] }));
    return res.json({ campaigns: r.rows, count: r.rows.length });
  });

  // POST /v1/agents/:did/advertising/campaigns/:id/creatives
  const CreativeSchema = z.object({
    kind: z.enum(CREATIVE_KINDS),
    headline: z.string().max(500).optional(),
    body: z.string().max(5000).optional(),
    media_url: z.string().url().max(2000).optional(),
    landing_url: z.string().url().max(2000)
  });
  app.post('/v1/agents/:did/advertising/campaigns/:id/creatives', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const parse = CreativeSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;
      const c = await pool.query(
        `SELECT campaign_id FROM ad_campaigns WHERE campaign_id=$1 AND agent_did=$2`,
        [req.params.id, did]
      ).catch(() => ({ rows: [] }));
      if (!c.rows[0]) return res.status(404).json({ error: 'campaign_not_found' });

      const creativeId = genId('crv');
      await pool.query(
        `INSERT INTO ad_creatives
           (creative_id, campaign_id, kind, headline, body, media_url, landing_url, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'active')`,
        [creativeId, req.params.id, d.kind, d.headline || null, d.body || null,
         d.media_url || null, d.landing_url]
      );
      await auditChain.append({
        event_type: 'advertising.creative_added', creative_id: creativeId,
        campaign_id: req.params.id, agent_did: did,
        kind: d.kind, timestamp: new Date().toISOString()
      });
      return res.status(201).json({ creative_id: creativeId, kind: d.kind });
    } catch (e) { return res.status(500).json({ error: 'creative_failed', message: e.message }); }
  });

  // PUT /v1/agents/:did/advertising/campaigns/:id  (pause/resume/edit)
  const UpdateCampaignSchema = z.object({
    name: z.string().min(1).max(300).optional(),
    status: z.enum(CAMPAIGN_STATUSES).optional(),
    budget_cents: z.number().int().nonnegative().optional(),
    daily_budget_cents: z.number().int().nonnegative().optional()
  });
  app.put('/v1/agents/:did/advertising/campaigns/:id', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const parse = UpdateCampaignSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;
      const fields = []; const params = [];
      const set = (k, v) => { params.push(v); fields.push(`${k}=$${params.length}`); };
      if (d.name !== undefined) set('name', d.name);
      if (d.status !== undefined) {
        set('status', d.status);
        if (d.status === 'active') fields.push(`started_at=COALESCE(started_at, NOW())`);
        if (d.status === 'ended') fields.push(`ended_at=NOW()`);
      }
      if (d.budget_cents !== undefined) set('budget_cents', d.budget_cents);
      if (d.daily_budget_cents !== undefined) set('daily_budget_cents', d.daily_budget_cents);
      if (!fields.length) return res.status(400).json({ error: 'no_fields' });
      params.push(req.params.id, did);
      const r = await pool.query(
        `UPDATE ad_campaigns SET ${fields.join(', ')}
         WHERE campaign_id=$${params.length - 1} AND agent_did=$${params.length}
         RETURNING campaign_id, status`,
        params
      ).catch(() => ({ rows: [] }));
      if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
      await auditChain.append({
        event_type: 'advertising.campaign_updated', campaign_id: req.params.id,
        agent_did: did, fields: Object.keys(d), timestamp: new Date().toISOString()
      });
      return res.json(r.rows[0]);
    } catch (e) { return res.status(500).json({ error: 'update_failed', message: e.message }); }
  });

  // GET /v1/agents/:did/advertising/campaigns/:id/metrics
  app.get('/v1/agents/:did/advertising/campaigns/:id/metrics', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const own = await pool.query(
      `SELECT campaign_id FROM ad_campaigns WHERE campaign_id=$1 AND agent_did=$2`,
      [req.params.id, did]
    ).catch(() => ({ rows: [] }));
    if (!own.rows[0]) return res.status(404).json({ error: 'not_found' });
    const r = await pool.query(
      `SELECT * FROM ad_metrics WHERE campaign_id=$1 ORDER BY date DESC LIMIT 365`,
      [req.params.id]
    ).catch(() => ({ rows: [] }));
    // Aggregate totals
    const totals = r.rows.reduce((a, m) => ({
      impressions: a.impressions + Number(m.impressions || 0),
      clicks: a.clicks + Number(m.clicks || 0),
      conversions: a.conversions + Number(m.conversions || 0),
      spend_cents: a.spend_cents + Number(m.spend_cents || 0)
    }), { impressions: 0, clicks: 0, conversions: 0, spend_cents: 0 });
    return res.json({ campaign_id: req.params.id, daily: r.rows, totals });
  });

  // POST /v1/agents/:did/advertising/audiences
  const AudienceSchema = z.object({
    platform: z.enum(PLATFORMS),
    name: z.string().min(1).max(300),
    size: z.number().int().nonnegative().optional(),
    definition: z.record(z.any()).optional()
  });
  app.post('/v1/agents/:did/advertising/audiences', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const parse = AudienceSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;
      const audienceId = genId('aud');
      await pool.query(
        `INSERT INTO ad_audiences (audience_id, agent_did, platform, name, size, definition)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
        [audienceId, did, d.platform, d.name, d.size || 0,
         d.definition ? JSON.stringify(d.definition) : null]
      );
      await auditChain.append({
        event_type: 'advertising.audience_created', audience_id: audienceId,
        agent_did: did, platform: d.platform, name: d.name,
        timestamp: new Date().toISOString()
      });
      return res.status(201).json({ audience_id: audienceId, platform: d.platform });
    } catch (e) { return res.status(500).json({ error: 'audience_failed', message: e.message }); }
  });

  // POST /v1/_webhooks/ad-platform — metric updates
  const WebhookSchema = z.object({
    campaign_id: z.string(),
    date: z.string(),
    impressions: z.number().int().nonnegative().optional(),
    clicks: z.number().int().nonnegative().optional(),
    conversions: z.number().int().nonnegative().optional(),
    spend_cents: z.number().int().nonnegative().optional()
  });
  app.post('/v1/_webhooks/ad-platform', express.json(), async (req, res) => {
    try {
      // Verify webhook secret (loose check; production should use HMAC)
      const expected = process.env.AD_PLATFORM_WEBHOOK_SECRET;
      if (expected && req.headers['x-ad-platform-secret'] !== expected) {
        return res.status(401).json({ error: 'invalid_webhook_secret' });
      }
      const parse = WebhookSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;
      const impressions = d.impressions || 0;
      const clicks = d.clicks || 0;
      const spend = d.spend_cents || 0;
      const cpc = clicks > 0 ? Math.round(spend / clicks) : null;
      const cpm = impressions > 0 ? Math.round((spend / impressions) * 1000) : null;
      const ctr = impressions > 0 ? Math.round((clicks / impressions) * 10000) : null;
      await pool.query(
        `INSERT INTO ad_metrics
           (campaign_id, date, impressions, clicks, conversions,
            spend_cents, cpc_cents, cpm_cents, ctr_bps)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (campaign_id, date) DO UPDATE
           SET impressions = ad_metrics.impressions + EXCLUDED.impressions,
               clicks = ad_metrics.clicks + EXCLUDED.clicks,
               conversions = ad_metrics.conversions + EXCLUDED.conversions,
               spend_cents = ad_metrics.spend_cents + EXCLUDED.spend_cents,
               cpc_cents=EXCLUDED.cpc_cents, cpm_cents=EXCLUDED.cpm_cents,
               ctr_bps=EXCLUDED.ctr_bps`,
        [d.campaign_id, d.date, impressions, clicks, d.conversions || 0,
         spend, cpc, cpm, ctr]
      );

      // Record spend as cost on the campaign owner
      const own = await pool.query(
        `SELECT agent_did FROM ad_campaigns WHERE campaign_id=$1`, [d.campaign_id]
      ).catch(() => ({ rows: [] }));
      if (own.rows[0] && spend > 0) {
        try {
          const cost = require('./cost');
          if (cost && typeof cost.recordCost === 'function') {
            await cost.recordCost(pool, {
              agent_did: own.rows[0].agent_did,
              resource_type: 'advertising_spend',
              provider: 'ad_platform',
              amount_cents: spend,
              units: impressions, unit_type: 'impressions',
              reference_id: `${d.campaign_id}:${d.date}`,
              tags: { campaign_id: d.campaign_id, date: d.date }
            });
          }
        } catch {}
      }

      await auditChain.append({
        event_type: 'advertising.metrics_updated',
        campaign_id: d.campaign_id, date: d.date,
        impressions, clicks, spend_cents: spend,
        timestamp: new Date().toISOString()
      });
      return res.json({ ok: true });
    } catch (e) { return res.status(500).json({ error: 'webhook_failed', message: e.message }); }
  });
}

module.exports = {
  migrate,
  registerAdvertisingRoutes,
  PLATFORMS,
  ACCOUNT_STATUSES,
  OBJECTIVES,
  CAMPAIGN_STATUSES,
  CREATIVE_KINDS
};
