// ============================================================================
// OpenHeab Portability — Signed agent-state export/import
// ============================================================================
const express = require('express');
const cryptoLib = require('crypto');
const { z } = require('zod');

const MANIFEST_VERSION = '1.0';

// EXPORTABLE_TABLES: list of {table, key} where `key` is the DID column
const EXPORTABLE_TABLES = [
  { table: 'identities', key: 'did' },
  { table: 'identity_keys', key: 'agent_did' },
  { table: 'agent_profiles', key: 'agent_did' },
  { table: 'agent_constitutions', key: 'agent_did' },
  { table: 'reputation_scores', key: 'agent_did' },
  { table: 'reputation_vouches', key: 'target_did' },
  { table: 'bank_wallets', key: 'agent_did' },
  { table: 'bank_transactions', key: 'agent_did' },
  { table: 'bank_spending_policy', key: 'agent_did' },
  { table: 'inbox_envelopes', key: 'recipient_did' },
  { table: 'memory_kv', key: 'agent_did' },
  { table: 'memory_episodes', key: 'agent_did' },
  { table: 'kyc_claims', key: 'agent_did' },
  { table: 'capability_tokens', key: 'agent_did' },
  { table: 'email_addresses', key: 'agent_did' },
  { table: 'did_aliases', key: 'owner_did' },
  { table: 'deployment_manifests', key: 'agent_did' },
  { table: 'scheduled_tasks', key: 'agent_did' },
  { table: 'oauth_grants', key: 'agent_did' },
  { table: 'insurance_policies', key: 'insured_did' },
  { table: 'inference_policies', key: 'agent_did' },
  { table: 'cost_budgets', key: 'agent_did' },
  { table: 'legal_entities', key: 'controlling_did' },
  { table: 'tax_forms', key: 'agent_did' }
];

// ----------------------------------------------------------------------------
// Migration
// ----------------------------------------------------------------------------
async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS portability_exports (
      export_id        TEXT PRIMARY KEY,
      agent_did        TEXT NOT NULL,
      manifest_hash    TEXT NOT NULL,
      bytes            BIGINT NOT NULL DEFAULT 0,
      signature        TEXT NOT NULL,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_portability_exports_agent ON portability_exports (agent_did, created_at DESC);

    CREATE TABLE IF NOT EXISTS portability_imports (
      import_id        TEXT PRIMARY KEY,
      agent_did        TEXT NOT NULL,
      manifest_hash    TEXT NOT NULL,
      signature_valid  BOOLEAN NOT NULL DEFAULT FALSE,
      tables_imported  JSONB,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `).catch(() => {});
}

function genId(prefix) {
  return `${prefix}_${cryptoLib.randomBytes(12).toString('hex')}`;
}

function canonicalJson(obj) {
  // Deterministic, sorted-key JSON
  const sorter = (k, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return Object.keys(v).sort().reduce((acc, key) => { acc[key] = v[key]; return acc; }, {});
    }
    return v;
  };
  return JSON.stringify(obj, sorter);
}

function signManifest(canonical) {
  const secret = process.env.WEBHOOK_SIGNING_SECRET || 'dev-portability-secret';
  return cryptoLib.createHmac('sha256', secret).update(canonical).digest('hex');
}

function hashCanonical(canonical) {
  return cryptoLib.createHash('sha256').update(canonical).digest('hex');
}

async function collectExport(pool, did) {
  const tables = {};
  for (const { table, key } of EXPORTABLE_TABLES) {
    try {
      const colsR = await pool.query(
        `SELECT column_name FROM information_schema.columns WHERE table_name=$1 AND column_name=$2`,
        [table, key]
      ).catch(() => ({ rows: [] }));
      if (!colsR.rows[0]) continue;
      const r = await pool.query(`SELECT * FROM ${table} WHERE ${key}=$1 LIMIT 50000`, [did])
        .catch(() => ({ rows: [] }));
      if (r.rows && r.rows.length) tables[table] = r.rows;
    } catch {}
  }
  return tables;
}

// ----------------------------------------------------------------------------
// Routes
// ----------------------------------------------------------------------------
function registerPortabilityRoutes(app, pool, verifyAgentAuth, auditChain) {
  // GET /v1/agents/:did/portability/export
  app.get('/v1/agents/:did/portability/export', async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const tables = await collectExport(pool, did);
      const manifest = {
        manifest_version: MANIFEST_VERSION,
        agent_did: did,
        exported_at: new Date().toISOString(),
        tables
      };
      const canonical = canonicalJson(manifest);
      const manifestHash = hashCanonical(canonical);
      const signature = signManifest(canonical);
      const bytes = Buffer.byteLength(canonical, 'utf8');

      const exportId = genId('pexp');
      await pool.query(
        `INSERT INTO portability_exports (export_id, agent_did, manifest_hash, bytes, signature)
         VALUES ($1,$2,$3,$4,$5)`,
        [exportId, did, manifestHash, bytes, signature]
      ).catch(() => {});

      await auditChain.append({
        event_type: 'portability.exported',
        export_id: exportId, agent_did: did, manifest_hash: manifestHash,
        bytes, timestamp: new Date().toISOString()
      });

      const signedManifest = {
        ...manifest,
        manifest_hash: manifestHash,
        signature_alg: 'HMAC-SHA256',
        signature
      };

      res.setHeader('content-type', 'application/json');
      res.setHeader('content-disposition',
        `attachment; filename="openheab-portability-${did.slice(7, 19) || 'agent'}.json"`);
      return res.send(JSON.stringify(signedManifest, null, 2));
    } catch (e) {
      console.error('[portability.export]', e);
      return res.status(500).json({ error: 'export_failed', message: e.message });
    }
  });

  // GET /v1/agents/:did/portability/export.sig — just hash + signature
  app.get('/v1/agents/:did/portability/export.sig', async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const tables = await collectExport(pool, did);
      const manifest = {
        manifest_version: MANIFEST_VERSION,
        agent_did: did,
        exported_at: new Date().toISOString(),
        tables
      };
      const canonical = canonicalJson(manifest);
      const manifestHash = hashCanonical(canonical);
      const signature = signManifest(canonical);
      return res.json({
        agent_did: did,
        manifest_hash: manifestHash,
        signature_alg: 'HMAC-SHA256',
        signature
      });
    } catch (e) {
      console.error('[portability.export.sig]', e);
      return res.status(500).json({ error: 'sig_failed', message: e.message });
    }
  });

  // POST /v1/portability/import
  const ImportSchema = z.object({
    manifest_version: z.string(),
    agent_did: z.string(),
    exported_at: z.string().optional(),
    tables: z.record(z.array(z.any())),
    manifest_hash: z.string(),
    signature: z.string(),
    signature_alg: z.string().optional()
  });

  app.post('/v1/portability/import', express.json({ limit: '200mb' }), async (req, res) => {
    try {
      const parse = ImportSchema.safeParse(req.body || {});
      if (!parse.success) return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      const d = parse.data;

      const auth = await verifyAgentAuth(req, d.agent_did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      // Verify hash + signature against canonical of manifest fields only
      const manifest = {
        manifest_version: d.manifest_version,
        agent_did: d.agent_did,
        exported_at: d.exported_at,
        tables: d.tables
      };
      const canonical = canonicalJson(manifest);
      const expectedHash = hashCanonical(canonical);
      const expectedSig = signManifest(canonical);
      const { safeTokenCompare } = require('../safe_compare');
      const hashValid = safeTokenCompare(expectedHash, d.manifest_hash);
      const sigValid = safeTokenCompare(expectedSig, d.signature);

      if (!hashValid) return res.status(400).json({ error: 'manifest_hash_mismatch' });
      if (!sigValid) return res.status(400).json({ error: 'signature_invalid' });

      const importId = genId('pimp');
      const tablesImported = {};
      let inserted = 0;
      let skipped = 0;
      const exportableTableNames = new Set(EXPORTABLE_TABLES.map(t => t.table));
      const keyByTable = Object.fromEntries(EXPORTABLE_TABLES.map(t => [t.table, t.key]));

      for (const [tableName, rows] of Object.entries(d.tables || {})) {
        if (!exportableTableNames.has(tableName)) {
          skipped += rows.length;
          tablesImported[tableName] = { skipped: rows.length, reason: 'not_exportable' };
          continue;
        }
        // Skip if agent already has data in this table
        const key = keyByTable[tableName];
        const existing = await pool.query(
          `SELECT 1 FROM ${tableName} WHERE ${key}=$1 LIMIT 1`, [d.agent_did]
        ).catch(() => ({ rows: [] }));
        if (existing.rows[0]) {
          tablesImported[tableName] = { skipped: rows.length, reason: 'agent_data_exists' };
          skipped += rows.length;
          continue;
        }
        // Discover columns
        const colsR = await pool.query(
          `SELECT column_name, data_type FROM information_schema.columns WHERE table_name=$1`,
          [tableName]
        ).catch(() => ({ rows: [] }));
        if (!colsR.rows.length) {
          tablesImported[tableName] = { skipped: rows.length, reason: 'table_missing' };
          skipped += rows.length;
          continue;
        }
        const validCols = new Set(colsR.rows.map(c => c.column_name));
        const colTypes = Object.fromEntries(colsR.rows.map(c => [c.column_name, c.data_type]));
        let count = 0;
        for (const row of rows) {
          const cols = Object.keys(row).filter(c => validCols.has(c));
          if (!cols.length) continue;
          const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
          const values = cols.map(c => {
            const v = row[c];
            const t = colTypes[c];
            if (v !== null && typeof v === 'object' && (t === 'jsonb' || t === 'json')) {
              return JSON.stringify(v);
            }
            return v;
          });
          const colList = cols.map(c => {
            const t = colTypes[c];
            return (t === 'jsonb' || t === 'json') ? c : c;
          }).join(', ');
          const valueList = cols.map((c, i) => {
            const t = colTypes[c];
            return (t === 'jsonb' || t === 'json') ? `$${i + 1}::jsonb` : `$${i + 1}`;
          }).join(', ');
          try {
            await pool.query(
              `INSERT INTO ${tableName} (${colList}) VALUES (${valueList}) ON CONFLICT DO NOTHING`,
              values
            );
            count += 1;
          } catch {}
        }
        tablesImported[tableName] = { inserted: count };
        inserted += count;
      }

      await pool.query(
        `INSERT INTO portability_imports (import_id, agent_did, manifest_hash,
           signature_valid, tables_imported)
         VALUES ($1,$2,$3,$4,$5::jsonb)`,
        [importId, d.agent_did, d.manifest_hash, sigValid, JSON.stringify(tablesImported)]
      ).catch(() => {});

      await auditChain.append({
        event_type: 'portability.imported',
        import_id: importId, agent_did: d.agent_did,
        manifest_hash: d.manifest_hash, inserted, skipped,
        timestamp: new Date().toISOString()
      });

      return res.status(201).json({
        import_id: importId, inserted, skipped,
        tables_imported: tablesImported
      });
    } catch (e) {
      console.error('[portability.import]', e);
      return res.status(500).json({ error: 'import_failed', message: e.message });
    }
  });

  // GET /v1/portability/schema
  app.get('/v1/portability/schema', (req, res) => {
    return res.json({
      manifest_version: MANIFEST_VERSION,
      signature_alg: 'HMAC-SHA256',
      portable_tables: EXPORTABLE_TABLES,
      fields: [
        'manifest_version', 'agent_did', 'exported_at', 'tables',
        'manifest_hash', 'signature_alg', 'signature'
      ]
    });
  });
}

module.exports = {
  migrate,
  registerPortabilityRoutes,
  MANIFEST_VERSION,
  EXPORTABLE_TABLES,
  canonicalJson,
  signManifest,
  hashCanonical
};
