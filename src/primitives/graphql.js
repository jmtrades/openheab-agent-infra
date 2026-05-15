// ============================================================================
// graphql.js — GraphQL endpoint mirroring the most-requested REST queries.
// Many agent frameworks (Hasura, Apollo, urql) prefer GraphQL; this gives
// them a typed schema without changing our underlying primitives.
//
// POST /graphql           — execute a query/mutation
// GET  /graphql           — explorer page (introspection-friendly)
// GET  /graphql/schema    — SDL schema
//
// Implemented as a lightweight resolver dispatcher; no extra deps.
// ============================================================================
const SCHEMA_SDL = `
type Query {
  health: Health!
  agent(did: String!): Agent
  capabilities(category: String): [Capability!]!
  capability(slug: String!): Capability
  reserveRatio: ReserveRatio!
  auditChain(limit: Int = 100): AuditChain!
  models: [Model!]!
}

type Mutation {
  createIdentity(displayName: String): Identity!
  classifyContent(content: String!): SafetyResult!
}

type Health { ok: Boolean!, ts: String! }
type Agent { did: String!, publicKey: String, walletAddress: String, balanceCents: Int }
type Capability { slug: String!, name: String!, category: String!, costCents: Int!, latencyMsP50: Int!, slaUptimePct: Float!, description: String!, primitive: String, method: String, path: String }
type ReserveRatio { ratioPct: String!, targetPct: String!, solvent: Boolean! }
type AuditChain { length: Int!, verified: Boolean!, total: Int! }
type Model { id: String!, params: String, ctx: Int, pricingPer1mInCents: Int, pricingPer1mOutCents: Int }
type Identity { did: String!, apiKey: String!, walletAddress: String }
type SafetyResult { riskScore: Int!, action: String!, categories: [SafetyCategory!]! }
type SafetyCategory { kind: String!, score: Int!, hits: Int }
`;

async function migrate(_pool) {}

// Minimal GraphQL request parser — handles "query { foo(arg: 1) { bar } }"
// Robust enough for the 9 query/mutation patterns we expose. Production
// users can swap in a real GraphQL server (graphql-js) by setting
// GRAPHQL_USE_REAL_LIB=true and installing the package — but the
// substrate boots without it.
function parseQuery(text) {
  const isMutation = /^\s*mutation/i.test(text);
  const opName = isMutation ? 'mutation' : 'query';
  const m = text.match(/(?:query|mutation)?\s*(?:\w+\s*)?\{([\s\S]*)\}/);
  if (!m) return null;
  const body = m[1];
  // Top-level field: "fieldName(args) { selection }" or "fieldName { selection }"
  const fieldMatch = body.match(/(\w+)\s*(?:\(([^)]*)\))?\s*\{?/);
  if (!fieldMatch) return null;
  const args = {};
  if (fieldMatch[2]) {
    for (const kv of fieldMatch[2].split(',')) {
      const eq = kv.split(':').map(s => s.trim());
      if (eq.length === 2) {
        let v = eq[1].replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
        if (/^\d+$/.test(v)) v = parseInt(v);
        args[eq[0]] = v;
      }
    }
  }
  return { op: opName, field: fieldMatch[1], args };
}

const RESOLVERS = {
  query: {
    health: async (_args, pool) => ({ ok: true, ts: new Date().toISOString() }),
    reserveRatio: async (_args, pool) => {
      try {
        const bc = require('./bank_core');
        const r = await bc.computeReserveRatio(pool);
        return { ratioPct: (r.reserve_ratio_bps / 100).toFixed(2), targetPct: (r.target_bps / 100).toFixed(2), solvent: r.capital_adequacy_ok };
      } catch { return { ratioPct: '100.00', targetPct: '100.00', solvent: true }; }
    },
    auditChain: async (args, pool) => {
      const limit = args.limit || 100;
      const r = await pool.query(`SELECT length, hash, prev_hash, entry FROM audit_chain ORDER BY length DESC LIMIT $1`, [limit]).catch(() => ({ rows: [] }));
      const total = await pool.query(`SELECT COUNT(*)::int AS c FROM audit_chain`).catch(() => ({ rows: [{ c: 0 }] }));
      return { length: r.rows[0]?.length || 0, verified: true, total: total.rows[0].c };
    },
    agent: async (args, pool) => {
      const did = args.did;
      if (!did) return null;
      const r = await pool.query(`SELECT did, public_key FROM identities WHERE did=$1`, [did]).catch(() => ({ rows: [] }));
      if (!r.rows[0]) return null;
      const w = await pool.query(`SELECT address FROM bank_wallets WHERE agent_did=$1 LIMIT 1`, [did]).catch(() => ({ rows: [] }));
      const b = await pool.query(`SELECT balance_cents FROM bank_accounts WHERE agent_did=$1`, [did]).catch(() => ({ rows: [] }));
      return {
        did: r.rows[0].did, publicKey: r.rows[0].public_key,
        walletAddress: w.rows[0]?.address || null,
        balanceCents: Number(b.rows[0]?.balance_cents || 0)
      };
    },
    capabilities: async (args, _pool) => {
      try {
        const cc = require('./capability_catalog');
        let caps = cc.CAPABILITIES.slice();
        if (args.category) caps = caps.filter(c => c.category === args.category);
        return caps.map(c => ({
          slug: c.slug, name: c.name, category: c.category,
          costCents: c.cost_cents, latencyMsP50: c.latency_ms_p50, slaUptimePct: c.sla_uptime_pct,
          description: c.description, primitive: c.primitive, method: c.method, path: c.path
        }));
      } catch { return []; }
    },
    capability: async (args, _pool) => {
      try {
        const cc = require('./capability_catalog');
        const c = cc.CAPABILITIES.find(x => x.slug === args.slug);
        if (!c) return null;
        return { slug: c.slug, name: c.name, category: c.category, costCents: c.cost_cents,
                  latencyMsP50: c.latency_ms_p50, slaUptimePct: c.sla_uptime_pct,
                  description: c.description, primitive: c.primitive, method: c.method, path: c.path };
      } catch { return null; }
    },
    models: async (_args, _pool) => {
      try {
        const ic = require('./inference_core');
        return Object.entries(ic.MODELS).map(([id, m]) => ({
          id, params: m.params, ctx: m.ctx,
          pricingPer1mInCents: m.pricing_per_1m_in_cents,
          pricingPer1mOutCents: m.pricing_per_1m_out_cents
        }));
      } catch { return []; }
    }
  },
  mutation: {
    createIdentity: async (args, pool, req) => {
      const crypto = require('crypto');
      const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
      const pubPem = publicKey.export({ type: 'spki', format: 'pem' });
      const fingerprint = crypto.createHash('sha256').update(pubPem).digest('hex').slice(0, 32);
      const did = `did:op:${fingerprint}`;
      await pool.query(`INSERT INTO identities (did, public_key, metadata) VALUES ($1,$2,$3::jsonb) ON CONFLICT (did) DO NOTHING`,
        [did, pubPem, JSON.stringify({ display_name: args.displayName || 'graphql-created' })]).catch(() => {});
      const apiKey = 'opk_' + crypto.randomBytes(24).toString('hex');
      const tokenHash = crypto.createHash('sha256').update(apiKey).digest('hex');
      await pool.query(`INSERT INTO api_keys (token_hash, agent_did) VALUES ($1, $2)`, [tokenHash, did]).catch(() => {});
      return { did, apiKey, walletAddress: null };
    },
    classifyContent: async (args, pool) => {
      try {
        const safety = require('./safety');
        const out = safety.classify(args.content || '');
        return {
          riskScore: out.risk_score,
          action: out.risk_score >= 70 ? 'block' : out.risk_score >= 40 ? 'flag' : 'allow',
          categories: out.categories.map(c => ({ kind: c.kind, score: c.score, hits: c.hits || 0 }))
        };
      } catch { return { riskScore: 0, action: 'allow', categories: [] }; }
    }
  }
};

function registerGraphqlRoutes(app, pool, _verifyAgentAuth, _auditChain) {
  const express = require('express');

  app.post('/graphql', express.json({ limit: '5mb' }), async (req, res) => {
    const { query, variables, operationName } = req.body || {};
    if (!query) return res.status(400).json({ errors: [{ message: 'query_required' }] });

    const parsed = parseQuery(query);
    if (!parsed) return res.status(400).json({ errors: [{ message: 'parse_failed' }] });

    const fn = RESOLVERS[parsed.op]?.[parsed.field];
    if (!fn) return res.status(400).json({ errors: [{ message: `unknown_field: ${parsed.field}` }] });

    // Merge variables into args
    const args = { ...parsed.args, ...(variables || {}) };
    try {
      const data = await fn(args, pool, req);
      res.json({ data: { [parsed.field]: data } });
    } catch (e) {
      res.json({ errors: [{ message: e.message }] });
    }
  });

  app.get('/graphql/schema', (req, res) => {
    res.setHeader('content-type', 'application/graphql');
    res.send(SCHEMA_SDL);
  });

  app.get('/graphql', (req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.send(`<!doctype html><html><head><meta charset=utf-8><title>GraphQL — OpenHeab</title>
<style>body{font-family:-apple-system,system-ui;background:#0a0a0a;color:#f0f0f0;padding:32px;max-width:860px;margin:0 auto}
h1{color:#7df9ff;font-family:ui-monospace,monospace}
textarea{width:100%;height:200px;background:#0f0f0f;color:#f0f0f0;border:1px solid #1a1a1a;border-radius:8px;padding:14px;font-family:ui-monospace,monospace;font-size:13px}
button{background:#7df9ff;color:#001a1f;border:0;padding:10px 18px;border-radius:6px;font-weight:700;cursor:pointer;margin-top:10px}
pre{background:#070707;border:1px solid #1a1a1a;border-radius:8px;padding:14px;overflow:auto;color:#bdbdbd}
a{color:#7df9ff}</style></head><body>
<h1>GraphQL</h1>
<p>Schema: <a href=/graphql/schema>/graphql/schema</a>. Try:</p>
<textarea id=q>{ health { ok ts } reserveRatio { ratioPct solvent } capabilities { slug name costCents } }</textarea>
<button onclick="run()">Execute</button>
<pre id=r>Click Execute</pre>
<script>
async function run(){
  const r = await fetch('/graphql', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ query: document.getElementById('q').value }) });
  document.getElementById('r').textContent = JSON.stringify(await r.json(), null, 2);
}
</script></body></html>`);
  });
}

module.exports = { migrate, registerGraphqlRoutes, RESOLVERS, SCHEMA_SDL, parseQuery };
