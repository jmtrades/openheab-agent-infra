// ============================================================================
// me_endpoints.js — `/v1/me`, `/v1/me/usage`, `/v1/me/limits`. The
// convenience endpoints every Anthropic-style SDK needs: "what context am
// I in right now". Resolves Bearer key → agent identity + tier + usage.
// Saves every SDK call an extra round-trip.
// ============================================================================
const crypto = require('crypto');

async function migrate(pool) {}

// Tier limits — mirrors pricing_page.js TIERS shape
const TIER_LIMITS = {
  free:       { agents: 1,   inference_per_month: 10_000,   markup_pct: 5, kyc_tier_max: 0 },
  starter:    { agents: 5,   inference_per_month: 100_000,  markup_pct: 3, kyc_tier_max: 1 },
  pro:        { agents: 50,  inference_per_month: 1_000_000, markup_pct: 2, kyc_tier_max: 3 },
  team:       { agents: 500, inference_per_month: 10_000_000, markup_pct: 1, kyc_tier_max: 4 },
  enterprise: { agents: null, inference_per_month: null,     markup_pct: 0, kyc_tier_max: 4 }
};

async function resolveAgentFromRequest(pool, req) {
  // Bearer api key path
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ')) {
    const raw = auth.slice(7);
    try {
      const { verifyApiKey } = require('./api_keys_v2');
      const v = await verifyApiKey(pool, raw);
      if (v?.valid) return { did: v.agent_did, key_id: v.key_id, scope: v.scope, auth_kind: 'api_key_v2' };
    } catch {}
    // Fall back to legacy api_keys table
    try {
      const h = crypto.createHash('sha256').update(raw).digest('hex');
      const r = await pool.query(`SELECT agent_did FROM api_keys WHERE token_hash = $1 AND revoked_at IS NULL`, [h]).catch(() => ({ rows: [] }));
      if (r.rows[0]) return { did: r.rows[0].agent_did, auth_kind: 'api_key_legacy' };
    } catch {}
  }
  // x-agent-did header (signed-request path — caller has already proven sig)
  if (req.headers['x-agent-did']) {
    return { did: req.headers['x-agent-did'], auth_kind: 'header' };
  }
  return null;
}

async function gatherMe(pool, ctx) {
  const did = ctx.did;
  const safe = async (sql, params = []) => {
    try { return (await pool.query(sql, params)).rows; } catch { return []; }
  };

  // Identity
  const idRows = await safe(`SELECT did, public_key_pem, name, created_at, updated_at FROM agent_identities WHERE did=$1`, [did]);
  const identity = idRows[0] || { did };

  // Org membership
  const orgRows = await safe(
    `SELECT o.org_id, o.name, o.slug, o.plan, o.status, om.role
     FROM org_members om JOIN orgs o USING (org_id) WHERE om.agent_did=$1 ORDER BY om.joined_at DESC LIMIT 5`,
    [did]
  );

  // Determine plan: take from first org (owner role wins)
  const plan = orgRows.find(o => o.role === 'owner')?.plan
            || orgRows[0]?.plan
            || 'free';
  const limits = TIER_LIMITS[plan] || TIER_LIMITS.free;

  // Wallet
  const wallets = await safe(`SELECT address, network, asset FROM wallets WHERE agent_did=$1 LIMIT 5`, [did]);

  // KYC
  const kyc = await safe(`SELECT status, tier, country FROM kyc_subjects WHERE agent_did=$1 ORDER BY created_at DESC LIMIT 1`, [did]);

  // Counts
  const counts = await safe(`
    SELECT
      (SELECT COUNT(*)::int FROM api_keys_v2 WHERE agent_did=$1 AND revoked_at IS NULL) AS api_keys_active,
      (SELECT COUNT(*)::int FROM webhook_subscriptions_v2 WHERE agent_did=$1 AND enabled=TRUE) AS webhooks_active,
      (SELECT COUNT(*)::int FROM cards WHERE agent_did=$1) AS cards_count
  `, [did]);

  return {
    did: identity.did,
    name: identity.name,
    created_at: identity.created_at,
    auth_kind: ctx.auth_kind,
    auth_scope: ctx.scope || 'unknown',
    plan,
    limits,
    orgs: orgRows,
    wallets,
    kyc: kyc[0] || null,
    counts: counts[0] || { api_keys_active: 0, webhooks_active: 0, cards_count: 0 }
  };
}

async function gatherUsage(pool, did, periodDays = 30) {
  const safe = async (sql, params = []) => {
    try { return (await pool.query(sql, params)).rows; } catch { return []; }
  };
  const periodMs = periodDays * 86_400_000;
  const since = new Date(Date.now() - periodMs).toISOString();

  const inf = await safe(`
    SELECT COUNT(*)::int AS calls,
           COALESCE(SUM(prompt_tokens),0)::bigint AS prompt_tokens,
           COALESCE(SUM(completion_tokens),0)::bigint AS completion_tokens,
           COALESCE(SUM(cost_cents),0)::bigint AS spend_cents
    FROM inference_calls WHERE agent_did=$1 AND created_at > $2
  `, [did, since]);

  const transfers = await safe(`
    SELECT COUNT(*)::int AS count,
           COALESCE(SUM(debit_cents),0)::bigint AS debits_cents,
           COALESCE(SUM(credit_cents),0)::bigint AS credits_cents
    FROM bank_ledger WHERE account_did=$1 AND created_at > $2
  `, [did, since]);

  const auditEvents = await safe(`
    SELECT COUNT(*)::int AS n FROM audit_chain
    WHERE created_at > $1 AND (entry->>'agent_did' = $2 OR entry->>'did' = $2 OR entry->>'subject_did' = $2)
  `, [since, did]);

  return {
    period_days: periodDays,
    inference: inf[0] || { calls: 0, prompt_tokens: 0, completion_tokens: 0, spend_cents: 0 },
    transfers: transfers[0] || { count: 0, debits_cents: 0, credits_cents: 0 },
    audit_events: auditEvents[0]?.n || 0
  };
}

function registerMeEndpointsRoutes(app, pool, verifyAgentAuth, auditChain) {
  // GET /v1/me — current agent context (bearer key → DID + plan + limits + wallet + KYC + counts)
  app.get('/v1/me', async (req, res) => {
    const ctx = await resolveAgentFromRequest(pool, req);
    if (!ctx) return res.status(401).json({
      error: 'unauthenticated',
      hint: 'Send Authorization: Bearer <api_key> or x-agent-did + x-agent-signature.'
    });
    try {
      const me = await gatherMe(pool, ctx);
      res.set('cache-control', 'private, no-store');
      res.json(me);
    } catch (e) { res.status(500).json({ error: 'me_failed', message: e.message }); }
  });

  // GET /v1/me/usage[?period_days=30]
  app.get('/v1/me/usage', async (req, res) => {
    const ctx = await resolveAgentFromRequest(pool, req);
    if (!ctx) return res.status(401).json({ error: 'unauthenticated' });
    const periodDays = Math.min(parseInt(req.query.period_days) || 30, 365);
    try {
      const usage = await gatherUsage(pool, ctx.did, periodDays);
      res.set('cache-control', 'private, no-store');
      res.json({ did: ctx.did, ...usage });
    } catch (e) { res.status(500).json({ error: 'usage_failed', message: e.message }); }
  });

  // GET /v1/me/limits — your tier's caps + remaining (so SDKs can warn before hitting them)
  app.get('/v1/me/limits', async (req, res) => {
    const ctx = await resolveAgentFromRequest(pool, req);
    if (!ctx) return res.status(401).json({ error: 'unauthenticated' });
    try {
      const me = await gatherMe(pool, ctx);
      const usage = await gatherUsage(pool, ctx.did, 30);
      const limits = me.limits;
      const remaining = {
        inference_calls_remaining: limits.inference_per_month == null
          ? null
          : Math.max(0, limits.inference_per_month - usage.inference.calls),
        agents_remaining: limits.agents == null
          ? null
          : Math.max(0, limits.agents - me.counts.api_keys_active)
      };
      res.set('cache-control', 'private, no-store');
      res.json({ did: ctx.did, plan: me.plan, limits, current_usage: usage, remaining });
    } catch (e) { res.status(500).json({ error: 'limits_failed', message: e.message }); }
  });

  // GET /v1/me/keys — shortcut to /v1/agents/:did/keys
  app.get('/v1/me/keys', async (req, res) => {
    const ctx = await resolveAgentFromRequest(pool, req);
    if (!ctx) return res.status(401).json({ error: 'unauthenticated' });
    const r = await pool.query(
      `SELECT key_id, name, key_prefix, scope, expires_at, last_used_at, use_count, revoked_at, created_at
       FROM api_keys_v2 WHERE agent_did=$1 ORDER BY created_at DESC`, [ctx.did]
    ).catch(() => ({ rows: [] }));
    res.json({ did: ctx.did, keys: r.rows });
  });

  // GET /v1/me/webhooks — shortcut to /v1/agents/:did/webhooks/subscriptions
  app.get('/v1/me/webhooks', async (req, res) => {
    const ctx = await resolveAgentFromRequest(pool, req);
    if (!ctx) return res.status(401).json({ error: 'unauthenticated' });
    const r = await pool.query(
      `SELECT subscription_id, target_url, event_types, enabled, created_at, last_delivered_at
       FROM webhook_subscriptions_v2 WHERE agent_did=$1 ORDER BY created_at DESC`, [ctx.did]
    ).catch(() => ({ rows: [] }));
    res.json({ did: ctx.did, subscriptions: r.rows });
  });
}

module.exports = { migrate, registerMeEndpointsRoutes, resolveAgentFromRequest, gatherMe, gatherUsage, TIER_LIMITS };
