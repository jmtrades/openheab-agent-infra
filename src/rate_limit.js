// ============================================================================
// HTTP rate limiting — sliding-window, per-IP or per-API-key
// ============================================================================
const buckets = new Map();

function clientKey(req) {
  const fwd = req.headers['x-forwarded-for'];
  const ip = (fwd ? fwd.split(',')[0].trim() : (req.ip || req.connection?.remoteAddress)) || 'unknown';
  const apiKey = (req.headers.authorization || '').startsWith('Bearer ')
    ? req.headers.authorization.slice(7, 17) : null;
  return apiKey ? `k:${apiKey}` : `ip:${ip}`;
}

async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS rate_limit_buckets (
      bucket_key   TEXT PRIMARY KEY,
      count        INTEGER NOT NULL DEFAULT 0,
      reset_at     BIGINT NOT NULL,
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_rate_limit_reset ON rate_limit_buckets (reset_at);
  `).catch(() => {});
}

async function bumpDistributed(pool, key, windowMs) {
  const now = Date.now();
  const resetAt = now + windowMs;
  const r = await pool.query(`
    INSERT INTO rate_limit_buckets (bucket_key, count, reset_at, updated_at)
    VALUES ($1, 1, $2, NOW())
    ON CONFLICT (bucket_key) DO UPDATE SET
      count = CASE WHEN rate_limit_buckets.reset_at < $3 THEN 1 ELSE rate_limit_buckets.count + 1 END,
      reset_at = CASE WHEN rate_limit_buckets.reset_at < $3 THEN $2 ELSE rate_limit_buckets.reset_at END,
      updated_at = NOW()
    RETURNING count, reset_at
  `, [key, resetAt, now]);
  return { count: r.rows[0].count, resetAt: Number(r.rows[0].reset_at) };
}

function bumpInMemory(key, windowMs) {
  const now = Date.now();
  let bucket = buckets.get(key);
  if (!bucket || bucket.resetAt < now) {
    bucket = { count: 0, resetAt: now + windowMs };
    buckets.set(key, bucket);
  }
  bucket.count++;
  if (Math.random() < 0.001) {
    for (const [k, b] of buckets) {
      if (b.resetAt < now - windowMs) buckets.delete(k);
    }
  }
  return bucket;
}

function rateLimit({ windowMs = 60_000, max = 60, skip = () => false, pool = null, keyer = null } = {}) {
  return async function rl(req, res, next) {
    if (skip(req)) return next();
    const k = keyer ? keyer(req) : clientKey(req);
    const now = Date.now();
    let bucket;
    if (pool) {
      try { bucket = await bumpDistributed(pool, k, windowMs); }
      catch { bucket = bumpInMemory(k, windowMs); }
    } else {
      bucket = bumpInMemory(k, windowMs);
    }
    res.setHeader('X-RateLimit-Limit', max);
    res.setHeader('X-RateLimit-Remaining', Math.max(0, max - bucket.count));
    res.setHeader('X-RateLimit-Reset', Math.floor(bucket.resetAt / 1000));

    if (bucket.count > max) {
      const retrySec = Math.ceil((bucket.resetAt - now) / 1000);
      res.setHeader('Retry-After', retrySec);
      return res.status(429).json({
        error: 'rate_limit_exceeded',
        retry_after_seconds: retrySec, limit: max, window_ms: windowMs
      });
    }
    next();
  };
}

function skipForHealth(req) {
  return req.path === '/healthz' || req.path === '/readyz' || req.path === '/openapi.json';
}

module.exports = { rateLimit, clientKey, skipForHealth, migrate };
