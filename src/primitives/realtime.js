// ============================================================================
// realtime.js — Server-Sent Events stream of the audit chain.
//
// Any client (web, agent, CLI) connects to /v1/realtime/stream and receives
// a live push of every audit-chained event as JSON. The most important
// "this is the best agent infra in the world" feature: agents can react to
// other agents' events with sub-second latency, no polling.
//
// Filtering by event_type prefix, by agent DID, or by org ID is supported
// via query string. Per-connection cursor: clients pass `?since_length=N`
// to replay missed events on reconnect.
// ============================================================================

async function migrate(_pool) {
  // No tables — the audit chain is the source of truth. We just stream from it.
}

function matches(entry, filters) {
  if (filters.event_type && !String(entry.event_type || '').startsWith(filters.event_type)) return false;
  if (filters.event_type_in && !filters.event_type_in.includes(entry.event_type)) return false;
  if (filters.agent_did) {
    const dids = [
      entry.agent_did, entry.from_did, entry.to_did, entry.owner_did,
      entry.subject_did, entry.author_did, entry.recipient_did, entry.borrower_did
    ].filter(Boolean);
    if (!dids.includes(filters.agent_did)) return false;
  }
  if (filters.org_id && entry.org_id !== filters.org_id) return false;
  return true;
}

function registerRealtimeRoutes(app, pool, verifyAgentAuth) {
  // GET /v1/realtime/stream — SSE
  app.get('/v1/realtime/stream', async (req, res) => {
    // Optional auth: signed agent or bearer key
    const did = req.headers['x-agent-did'];
    if (did) {
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
    }
    // Filters from query string
    const filters = {
      event_type: req.query.event_type,
      event_type_in: req.query.event_type_in
        ? String(req.query.event_type_in).split(',').filter(Boolean) : null,
      agent_did: req.query.agent_did,
      org_id: req.query.org_id
    };

    res.setHeader('content-type', 'text/event-stream');
    res.setHeader('cache-control', 'no-cache, no-transform');
    res.setHeader('connection', 'keep-alive');
    res.setHeader('x-accel-buffering', 'no');
    if (req.headers.origin) res.setHeader('access-control-allow-origin', req.headers.origin);
    res.flushHeaders?.();

    let lastLength = parseInt(req.query.since_length) || 0;
    if (!lastLength) {
      // Default: start at the current head minus 0
      const head = await pool.query(`SELECT MAX(length) AS m FROM audit_chain`).catch(() => ({ rows: [] }));
      lastLength = parseInt(head.rows?.[0]?.m || 0);
    }

    let alive = true;
    let pollMs = 1000;

    const send = (eventName, data) => {
      try {
        if (eventName) res.write(`event: ${eventName}\n`);
        res.write(`data: ${JSON.stringify(data)}\n\n`);
      } catch { alive = false; }
    };

    send('hello', { server: 'openheab-realtime', cursor: lastLength, ts: new Date().toISOString() });

    // Keep-alive ping every 25s
    const keepalive = setInterval(() => {
      if (!alive) return;
      try { res.write(': ping\n\n'); } catch { alive = false; }
    }, 25000);

    const poll = async () => {
      while (alive && !res.writableEnded) {
        try {
          const r = await pool.query(
            `SELECT length, hash, entry, created_at FROM audit_chain
             WHERE length > $1 ORDER BY length ASC LIMIT 200`, [lastLength]
          ).catch(() => ({ rows: [] }));
          for (const row of r.rows) {
            lastLength = parseInt(row.length);
            const entry = typeof row.entry === 'string' ? (() => { try { return JSON.parse(row.entry); } catch { return {}; } })() : row.entry;
            if (!matches(entry, filters)) continue;
            send('event', {
              length: lastLength, hash: row.hash, ts: row.created_at, ...entry
            });
          }
          pollMs = r.rows.length ? 250 : Math.min(pollMs * 1.4, 4000);
        } catch (e) {
          send('error', { message: e.message });
          pollMs = 5000;
        }
        await new Promise(r => setTimeout(r, pollMs));
      }
    };
    poll();

    req.on('close', () => {
      alive = false;
      clearInterval(keepalive);
      try { res.end(); } catch {}
    });
  });

  // GET /v1/realtime/replay?from=N&to=M — bounded replay (non-streaming JSON)
  app.get('/v1/realtime/replay', async (req, res) => {
    const from = Math.max(1, parseInt(req.query.from) || 1);
    const to = Math.min(from + 1000, parseInt(req.query.to) || (from + 200));
    const r = await pool.query(
      `SELECT length, hash, entry, created_at FROM audit_chain
       WHERE length BETWEEN $1 AND $2 ORDER BY length ASC`, [from, to]
    ).catch(() => ({ rows: [] }));
    res.json({
      from, to, count: r.rows.length,
      events: r.rows.map(row => {
        const entry = typeof row.entry === 'string' ? (() => { try { return JSON.parse(row.entry); } catch { return {}; } })() : row.entry;
        return { length: parseInt(row.length), hash: row.hash, ts: row.created_at, ...entry };
      })
    });
  });
}

module.exports = { migrate, registerRealtimeRoutes };
