// ============================================================================
// Boot test — registers all primitives against a mock pool
// ============================================================================
const express = require('express');
const { registerAllRoutes, primitives } = require('../src/integration');

const mockPool = {
  query: async () => ({ rows: [] }),
  connect: async () => ({ query: async () => ({ rows: [] }), release: () => {} })
};

const app = express();
try {
  registerAllRoutes(app, mockPool);
} catch (e) {
  console.error('FAIL: registerAllRoutes threw:', e.message);
  console.error(e.stack);
  process.exit(1);
}

let routeCount = 0;
const routes = [];
for (const layer of app._router?.stack || []) {
  if (layer.route) {
    routeCount++;
    routes.push(`${Object.keys(layer.route.methods).join(',').toUpperCase()} ${layer.route.path}`);
  } else if (layer.name === 'router' && layer.handle?.stack) {
    for (const sub of layer.handle.stack) {
      if (sub.route) {
        routeCount++;
        routes.push(`${Object.keys(sub.route.methods).join(',').toUpperCase()} ${sub.route.path}`);
      }
    }
  }
}

const primitiveCount = Object.keys(primitives).length;
const expectedPrimitives = 42;
const expectedMinRoutes = 200;

console.log(`primitive_count=${primitiveCount}`);
console.log(`route_count=${routeCount}`);

let failed = false;
if (primitiveCount < expectedPrimitives) {
  console.error(`FAIL: expected ${expectedPrimitives} primitives, got ${primitiveCount}`);
  failed = true;
}
if (routeCount < expectedMinRoutes) {
  console.error(`FAIL: expected at least ${expectedMinRoutes} routes, got ${routeCount}`);
  failed = true;
}

const expectedFamilies = [
  '/v1/identities', '/v1/audit/verify',
  '/v1/agents/:did/inbox', '/v1/agents/:did/wallet/balance',
  '/v1/agents/:did/memory/kv/:key', '/v1/agents/:did/identity/rotate-key',
  '/v1/agents/:did/reputation/vouch', '/v1/marketplace/listings',
  '/v1/agents/:did/profile', '/v1/agents/:did/constitution',
  '/v1/analytics/event', '/v1/agents/:did/eval/run',
  '/v1/agents/:did/kyc/claims', '/v1/agents/:did/email/address',
  '/v1/extensions', '/v1/agents/:did/budget',
  '/v1/inference/chat/completions', '/v1/security/scan/input',
  '/v1/tools', '/v1/intelligence/network',
  '/v1/agents/:did/deployment', '/mcp', '/mcp/manifest',
  '/v1/prompts', '/v1/aliases', '/v1/agents/:did/schedules',
  '/v1/insurance/pools', '/v1/x402/resources', '/v1/escrow',
  '/v1/datasets', '/v1/agents/:did/entities', '/v1/agents/:did/tax/forms',
  '/v1/agents/:did/portability/export'
];

for (const family of expectedFamilies) {
  if (!routes.some(r => r.includes(family))) {
    console.error(`FAIL: expected route family not found: ${family}`);
    failed = true;
  }
}

if (failed) process.exit(1);
console.log('\nPASS: boot test green');
