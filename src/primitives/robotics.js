// ============================================================================
// Robotics — control interface for physical agents (drones, robot arms,
// autonomous vehicles, embodied AGI).
// ============================================================================
const crypto = require('crypto');
const { z } = require('zod');

const ROBOT_KINDS = ['arm', 'humanoid', 'wheeled', 'drone', 'crawler', 'gripper',
  'sensor_array', 'autonomous_vehicle', 'industrial', 'consumer', 'other'];

async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS robots (
      robot_id        TEXT PRIMARY KEY,
      owner_did       TEXT NOT NULL,
      controller_did  TEXT,
      kind            TEXT NOT NULL,
      manufacturer    TEXT,
      model           TEXT,
      serial_number   TEXT,
      capabilities    JSONB,
      sensors         JSONB,
      status          TEXT NOT NULL DEFAULT 'offline',
      last_heartbeat_at TIMESTAMPTZ,
      location        JSONB,
      battery_pct     REAL,
      firmware_version TEXT,
      api_endpoint    TEXT,
      api_key_enc     BYTEA,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_robots_owner ON robots (owner_did, status);

    CREATE TABLE IF NOT EXISTS robot_commands (
      command_id      TEXT PRIMARY KEY,
      robot_id        TEXT NOT NULL,
      issuer_did      TEXT NOT NULL,
      kind            TEXT NOT NULL,
      payload         JSONB NOT NULL,
      priority        INTEGER NOT NULL DEFAULT 5,
      timeout_ms      INTEGER,
      status          TEXT NOT NULL DEFAULT 'queued',
      result          JSONB,
      error           TEXT,
      issued_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      dispatched_at   TIMESTAMPTZ,
      completed_at    TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_robot_commands_queue
      ON robot_commands (robot_id, status, priority, issued_at);

    CREATE TABLE IF NOT EXISTS robot_telemetry (
      telemetry_id    TEXT PRIMARY KEY,
      robot_id        TEXT NOT NULL,
      metrics         JSONB NOT NULL,
      sensor_readings JSONB,
      pose            JSONB,
      recorded_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_robot_telemetry_robot
      ON robot_telemetry (robot_id, recorded_at DESC);

    CREATE TABLE IF NOT EXISTS robot_safety_zones (
      zone_id         TEXT PRIMARY KEY,
      robot_id        TEXT NOT NULL,
      kind            TEXT NOT NULL,
      geometry        JSONB NOT NULL,
      active          BOOLEAN NOT NULL DEFAULT TRUE,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

const registerSchema = z.object({
  kind: z.enum(ROBOT_KINDS),
  manufacturer: z.string().max(100).optional(),
  model: z.string().max(100).optional(),
  serial_number: z.string().max(100).optional(),
  capabilities: z.array(z.string()).max(50).optional(),
  sensors: z.array(z.string()).max(50).optional(),
  api_endpoint: z.string().url().optional(),
  api_key: z.string().optional()
});

function encryptKey(key) {
  const masterKek = process.env.IDENTITY_MASTER_KEK;
  if (!masterKek || !key) return null;
  const k = Buffer.from(masterKek.slice(0, 64), 'hex');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', k, iv);
  const ct = Buffer.concat([cipher.update(key, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]);
}

async function handleRegister(req, res, pool, verifyAgentAuth, auditChain) {
  const did = req.params.did;
  const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
  if (!auth.valid) return res.status(401).json({ error: auth.error });

  let body;
  try { body = registerSchema.parse(req.body); }
  catch (e) { return res.status(400).json({ error: 'invalid_request', details: e.errors }); }

  const id = 'rob_' + crypto.randomBytes(10).toString('hex');
  await pool.query(`
    INSERT INTO robots (robot_id, owner_did, controller_did, kind, manufacturer,
      model, serial_number, capabilities, sensors, api_endpoint, api_key_enc)
    VALUES ($1, $2, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10)
  `, [id, did, body.kind, body.manufacturer || null, body.model || null,
      body.serial_number || null,
      body.capabilities ? JSON.stringify(body.capabilities) : null,
      body.sensors ? JSON.stringify(body.sensors) : null,
      body.api_endpoint || null,
      body.api_key ? encryptKey(body.api_key) : null]);

  if (auditChain) {
    await auditChain.append({ event_type: 'robot.registered', owner_did: did, robot_id: id, kind: body.kind });
  }
  return res.status(201).json({ robot_id: id, kind: body.kind });
}

async function handleList(req, res, pool, verifyAgentAuth) {
  const did = req.params.did;
  const auth = await verifyAgentAuth(req, did);
  if (!auth.valid) return res.status(401).json({ error: auth.error });
  const r = await pool.query(`
    SELECT robot_id, kind, manufacturer, model, status, last_heartbeat_at, battery_pct, location
    FROM robots WHERE owner_did = $1 OR controller_did = $1 ORDER BY created_at DESC
  `, [did]);
  return res.json({ agent_did: did, robots: r.rows });
}

const commandSchema = z.object({
  kind: z.string().min(1).max(80),
  payload: z.record(z.any()),
  priority: z.number().int().min(0).max(10).optional(),
  timeout_ms: z.number().int().min(100).max(600_000).optional()
});

async function handleSendCommand(req, res, pool, verifyAgentAuth, auditChain) {
  const did = req.headers['x-agent-did'];
  if (!did) return res.status(401).json({ error: 'agent_did_required' });
  const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
  if (!auth.valid) return res.status(401).json({ error: auth.error });

  let body;
  try { body = commandSchema.parse(req.body); }
  catch (e) { return res.status(400).json({ error: 'invalid_request', details: e.errors }); }

  const robot = await pool.query(
    `SELECT owner_did, controller_did, status FROM robots WHERE robot_id = $1`,
    [req.params.id]
  );
  if (!robot.rows[0]) return res.status(404).json({ error: 'robot_not_found' });
  if (did !== robot.rows[0].owner_did && did !== robot.rows[0].controller_did) {
    return res.status(403).json({ error: 'not_authorized_controller' });
  }
  if (robot.rows[0].status === 'offline') {
    return res.status(409).json({ error: 'robot_offline' });
  }

  const cmdId = 'rcmd_' + crypto.randomBytes(10).toString('hex');
  await pool.query(`
    INSERT INTO robot_commands (command_id, robot_id, issuer_did, kind, payload,
      priority, timeout_ms)
    VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
  `, [cmdId, req.params.id, did, body.kind, JSON.stringify(body.payload),
      body.priority ?? 5, body.timeout_ms || null]);

  if (auditChain) {
    await auditChain.append({
      event_type: 'robot.command_issued',
      robot_id: req.params.id, issuer_did: did, command_id: cmdId, kind: body.kind
    });
  }
  return res.status(202).json({ command_id: cmdId, status: 'queued' });
}

async function handleNextCommand(req, res, pool) {
  // Long-polling endpoint for robots — gets next queued command + marks dispatched
  const r = await pool.query(`
    UPDATE robot_commands SET status = 'dispatched', dispatched_at = NOW()
    WHERE command_id = (
      SELECT command_id FROM robot_commands
      WHERE robot_id = $1 AND status = 'queued'
      ORDER BY priority DESC, issued_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED
    )
    RETURNING command_id, kind, payload, priority, timeout_ms
  `, [req.params.id]).catch(() => ({ rows: [] }));
  if (!r.rows[0]) return res.status(204).end();
  return res.json(r.rows[0]);
}

async function handleCompleteCommand(req, res, pool, auditChain) {
  const result = req.body?.result || null;
  const error = req.body?.error || null;
  const status = error ? 'failed' : 'completed';
  const r = await pool.query(`
    UPDATE robot_commands SET status = $1, result = $2::jsonb, error = $3, completed_at = NOW()
    WHERE command_id = $4 AND status = 'dispatched'
    RETURNING command_id, robot_id
  `, [status, result ? JSON.stringify(result) : null, error, req.params.cmd_id]);
  if (!r.rows[0]) return res.status(404).json({ error: 'not_found_or_not_dispatched' });
  if (auditChain) {
    await auditChain.append({
      event_type: 'robot.command_' + status,
      command_id: r.rows[0].command_id, robot_id: r.rows[0].robot_id
    });
  }
  return res.json({ command_id: r.rows[0].command_id, status });
}

async function handleTelemetry(req, res, pool) {
  const t = z.object({
    metrics: z.record(z.any()),
    sensor_readings: z.record(z.any()).optional(),
    pose: z.record(z.any()).optional()
  }).safeParse(req.body);
  if (!t.success) return res.status(400).json({ error: 'invalid_request', details: t.error.errors });

  const tid = 'tel_' + crypto.randomBytes(8).toString('hex');
  await pool.query(`
    INSERT INTO robot_telemetry (telemetry_id, robot_id, metrics, sensor_readings, pose)
    VALUES ($1, $2, $3::jsonb, $4::jsonb, $5::jsonb)
  `, [tid, req.params.id, JSON.stringify(t.data.metrics),
      t.data.sensor_readings ? JSON.stringify(t.data.sensor_readings) : null,
      t.data.pose ? JSON.stringify(t.data.pose) : null]);

  // Update robot heartbeat
  await pool.query(`
    UPDATE robots SET last_heartbeat_at = NOW(), status = 'online',
      battery_pct = COALESCE($1, battery_pct), location = COALESCE($2::jsonb, location)
    WHERE robot_id = $3
  `, [t.data.metrics.battery_pct ?? null,
      t.data.pose?.position ? JSON.stringify(t.data.pose.position) : null,
      req.params.id]);

  return res.status(202).json({ telemetry_id: tid });
}

async function handleGetTelemetry(req, res, pool, verifyAgentAuth) {
  const did = req.headers['x-agent-did'];
  if (!did) return res.status(401).json({ error: 'agent_did_required' });
  const r = await pool.query(`
    SELECT t.* FROM robot_telemetry t
    JOIN robots r ON r.robot_id = t.robot_id
    WHERE t.robot_id = $1 AND (r.owner_did = $2 OR r.controller_did = $2)
    ORDER BY t.recorded_at DESC LIMIT 100
  `, [req.params.id, did]);
  return res.json({ robot_id: req.params.id, telemetry: r.rows });
}

async function handleEmergencyStop(req, res, pool, verifyAgentAuth, auditChain) {
  const did = req.headers['x-agent-did'];
  if (!did) return res.status(401).json({ error: 'agent_did_required' });
  const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
  if (!auth.valid) return res.status(401).json({ error: auth.error });

  await pool.query(`UPDATE robot_commands SET status = 'cancelled' WHERE robot_id = $1 AND status = 'queued'`,
    [req.params.id]);
  const cmdId = 'rcmd_' + crypto.randomBytes(10).toString('hex');
  await pool.query(`
    INSERT INTO robot_commands (command_id, robot_id, issuer_did, kind, payload, priority)
    VALUES ($1, $2, $3, 'emergency_stop', '{}'::jsonb, 10)
  `, [cmdId, req.params.id, did]);
  if (auditChain) {
    await auditChain.append({ event_type: 'robot.emergency_stop', robot_id: req.params.id, issuer_did: did });
  }
  return res.json({ stopped: true, command_id: cmdId });
}

function registerRoboticsRoutes(app, pool, verifyAgentAuth, auditChain) {
  app.post('/v1/agents/:did/robotics/robots',
    (req, res) => handleRegister(req, res, pool, verifyAgentAuth, auditChain));
  app.get('/v1/agents/:did/robotics/robots',
    (req, res) => handleList(req, res, pool, verifyAgentAuth));
  app.post('/v1/robotics/robots/:id/commands',
    (req, res) => handleSendCommand(req, res, pool, verifyAgentAuth, auditChain));
  app.get('/v1/robotics/robots/:id/next-command',
    (req, res) => handleNextCommand(req, res, pool));
  app.post('/v1/robotics/commands/:cmd_id/complete',
    (req, res) => handleCompleteCommand(req, res, pool, auditChain));
  app.post('/v1/robotics/robots/:id/telemetry',
    (req, res) => handleTelemetry(req, res, pool));
  app.get('/v1/robotics/robots/:id/telemetry',
    (req, res) => handleGetTelemetry(req, res, pool, verifyAgentAuth));
  app.post('/v1/robotics/robots/:id/emergency-stop',
    (req, res) => handleEmergencyStop(req, res, pool, verifyAgentAuth, auditChain));
}

module.exports = { migrate, registerRoboticsRoutes, ROBOT_KINDS };
