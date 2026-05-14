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
const expectedMinPrimitives = 80;  // we have 100+; this is a floor
const expectedMinRoutes = 400;

console.log(`primitive_count=${primitiveCount}`);
console.log(`route_count=${routeCount}`);

let failed = false;
if (primitiveCount < expectedMinPrimitives) {
  console.error(`FAIL: expected at least ${expectedMinPrimitives} primitives, got ${primitiveCount}`);
  failed = true;
}
if (routeCount < expectedMinRoutes) {
  console.error(`FAIL: expected at least ${expectedMinRoutes} routes, got ${routeCount}`);
  failed = true;
}

// Spot check a few critical route families across all layers
const expectedFamilies = [
  '/v1/identities', '/v1/audit/verify',
  '/v1/agents/:did/inbox', '/v1/agents/:did/wallet/balance',
  '/v1/agents/:did/memory/kv/:key', '/v1/agents/:did/cards',
  '/v1/agents/:did/savings/accounts',
  '/v1/agents/:did/sandbox/sessions', '/v1/agents/:did/browser/sessions',
  '/v1/agents/:did/voice/tts', '/v1/agents/:did/vision/generate',
  '/v1/search', '/v1/translate',
  '/v1/multisig/wallets', '/v1/lending/pools',
  '/v1/dao/create', '/v1/agents/:did/planning/plans',
  '/v1/agents/:did/beliefs', '/v1/agents/:did/goals',
  '/v1/agents/:did/health/records', '/v1/agents/:did/passport/documents',
  '/v1/agents/:did/property', '/v1/agents/:did/logistics/shipments',
  '/v1/agents/:did/crm/contacts', '/v1/agents/:did/projects',
  '/v1/agents/:did/chat/rooms', '/v1/agents/:did/invoicing/invoices',
  '/v1/agents/:did/compute/instances', '/v1/agents/:did/calendars',
  '/v1/agents/:did/apis', '/v1/agents/:did/robotics/robots',
  '/mcp', '/mcp/manifest'
];

let familyMisses = 0;
for (const family of expectedFamilies) {
  if (!routes.some(r => r.includes(family))) {
    console.warn(`  MISSING: ${family}`);
    familyMisses++;
  }
}
if (familyMisses > 5) {
  console.error(`FAIL: ${familyMisses} expected route families missing`);
  failed = true;
}

if (failed) process.exit(1);
console.log(`\nPASS: boot test green (${primitiveCount} primitives, ${routeCount} routes, ${familyMisses} family misses)`);
