// ============================================================================
// Unified cron auth
// ============================================================================
function isCronRequest(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  if (req.headers['x-cron-secret'] === secret) return true;
  if (req.headers['x-vercel-cron'] && req.headers['authorization'] === `Bearer ${secret}`) return true;
  if (req.headers['authorization'] === `Bearer ${secret}`) return true;
  return false;
}

function cronRoute(handler) {
  return async (req, res) => {
    if (!isCronRequest(req)) return res.status(401).end();
    return handler(req, res);
  };
}

function registerCron(app, path, handler) {
  app.post(path, cronRoute(handler));
  app.get(path, cronRoute(handler));
}

module.exports = { isCronRequest, cronRoute, registerCron };
