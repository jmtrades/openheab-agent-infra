// ============================================================================
// Unified cron auth + in-process scheduler registry + meta-dispatcher
// ============================================================================
const REGISTERED_CRONS = [];

function isCronRequest(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const { safeTokenCompare } = require('./safe_compare');
  if (safeTokenCompare(req.headers['x-cron-secret'], secret)) return true;
  const auth = req.headers['authorization'] || '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  // Vercel's cron facility sends a Bearer with the project's CRON_SECRET
  if (req.headers['x-vercel-cron'] && safeTokenCompare(bearer, secret)) return true;
  if (safeTokenCompare(bearer, secret)) return true;
  return false;
}

function cronRoute(handler) {
  return async (req, res) => {
    if (!isCronRequest(req)) return res.status(401).end();
    return handler(req, res);
  };
}

// Default cadence is "every minute" — most cron handlers are idempotent and
// short-circuit if there's nothing to do, so this is safe. Pass a schedule
// hint (e.g. 'daily', 'hourly', 'every:5m') to control dispatcher frequency.
function registerCron(app, path, handler, schedule = 'every:1m') {
  app.post(path, cronRoute(handler));
  app.get(path, cronRoute(handler));
  REGISTERED_CRONS.push({ path, handler, schedule, lastFiredAt: 0 });
}

function listCrons() { return REGISTERED_CRONS.slice(); }

function shouldFire(cron, now) {
  const last = cron.lastFiredAt || 0;
  const ageMs = now - last;
  const s = cron.schedule || 'every:1m';
  if (s === 'daily') return ageMs >= 86_400_000;
  if (s === 'hourly') return ageMs >= 3_600_000;
  if (s.startsWith('every:')) {
    const spec = s.slice(6);
    const m = spec.match(/^(\d+)([smh])$/);
    if (!m) return ageMs >= 60_000;
    const ms = parseInt(m[1]) * (m[2] === 's' ? 1000 : m[2] === 'm' ? 60_000 : 3_600_000);
    return ageMs >= ms;
  }
  return ageMs >= 60_000;
}

async function fireAllDue() {
  const now = Date.now();
  const fakeRes = () => {
    const obj = { _status: 200, _body: null };
    obj.status = (c) => { obj._status = c; return obj; };
    obj.json = (b) => { obj._body = b; return obj; };
    obj.send = (b) => { obj._body = b; return obj; };
    obj.end = () => obj;
    return obj;
  };
  const fakeReq = { headers: {}, body: {}, query: {}, params: {} };
  const fired = [];
  const failed = [];
  for (const cron of REGISTERED_CRONS) {
    if (!shouldFire(cron, now)) continue;
    try {
      await cron.handler(fakeReq, fakeRes());
      cron.lastFiredAt = now;
      fired.push(cron.path);
    } catch (e) {
      failed.push({ path: cron.path, error: e.message });
    }
  }
  return { fired, failed, total_registered: REGISTERED_CRONS.length };
}

// In-process scheduler — fires due cron handlers on a fixed interval.
function startInProcessScheduler({ intervalMs = 60_000, onError = () => {} } = {}) {
  const timer = setInterval(async () => {
    try { await fireAllDue(); }
    catch (e) { onError(e, '_scheduler'); }
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

// Register the meta-dispatcher route. Vercel only needs to schedule this one
// path; the dispatcher fans out to every registered handler whose schedule
// says it's due. Saves cron-count quota on Vercel.
function registerCronDispatcher(app) {
  const handler = async (req, res) => {
    const result = await fireAllDue();
    res.json(result);
  };
  app.post('/v1/_jobs/_dispatcher', cronRoute(handler));
  app.get('/v1/_jobs/_dispatcher', cronRoute(handler));
}

module.exports = {
  isCronRequest, cronRoute, registerCron, listCrons,
  startInProcessScheduler, registerCronDispatcher, fireAllDue
};
