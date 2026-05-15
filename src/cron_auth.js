// ============================================================================
// Unified cron auth + in-process scheduler registry
// ============================================================================
const REGISTERED_CRONS = [];

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
  REGISTERED_CRONS.push({ path, handler });
}

function listCrons() { return REGISTERED_CRONS.slice(); }

// In-process scheduler — fires every cron handler on a fixed interval.
// Use this only when running standalone (e.g., `node server.js`); on Vercel,
// crons fire via vercel.json schedule.
function startInProcessScheduler({ intervalMs = 60_000, onError = () => {} } = {}) {
  const fakeRes = () => {
    const obj = { _status: 200, _body: null };
    obj.status = (c) => { obj._status = c; return obj; };
    obj.json = (b) => { obj._body = b; return obj; };
    obj.send = (b) => { obj._body = b; return obj; };
    obj.end = () => obj;
    return obj;
  };
  const fakeReq = { headers: {}, body: {}, query: {}, params: {} };
  const fire = async () => {
    for (const { path, handler } of REGISTERED_CRONS) {
      try { await handler(fakeReq, fakeRes()); }
      catch (e) { onError(e, path); }
    }
  };
  const timer = setInterval(fire, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

module.exports = { isCronRequest, cronRoute, registerCron, listCrons, startInProcessScheduler };
