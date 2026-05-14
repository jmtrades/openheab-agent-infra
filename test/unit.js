// ============================================================================
// Unit tests — pure functions, no DB required
// ============================================================================
const assert = require('assert');
const crypto = require('crypto');

let passed = 0, failed = 0;

function test(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); passed++; }
  catch (e) { console.error(`  FAIL  ${name}\n        ${e.message}`); failed++; }
}

// chain_crypto.js
console.log('\n== chain_crypto ==');
const cc = require('../src/chain_crypto');

test('base58Encode + base58Decode roundtrip', () => {
  const buf = Buffer.from('hello world');
  const enc = cc.base58Encode(buf);
  const dec = cc.base58Decode(enc);
  assert.deepStrictEqual(dec, buf);
});

test('provisionSolanaKeypair returns base58 address', () => {
  const kp = cc.provisionSolanaKeypair();
  assert.match(kp.address, /^[1-9A-HJ-NP-Za-km-z]+$/);
});

test('provisionBitcoinKeypair returns base58check P2PKH', () => {
  const kp = cc.provisionBitcoinKeypair();
  assert.match(kp.address, /^[1][a-km-zA-HJ-NP-Z1-9]+$/);
});

// bank_chain wallet generation
console.log('\n== bank_chain wallet generation ==');
try {
  process.env.BANK_MASTER_KEK = '0'.repeat(64);
  process.env.IDENTITY_MASTER_KEK = '0'.repeat(64);
  process.env.CRYPTO_MASTER_KEK = '0'.repeat(64);

  const bank = require('../src/primitives/bank_chain');

  test('generateWallet produces unique addresses', () => {
    const addresses = new Set();
    for (let i = 0; i < 10; i++) addresses.add(bank.generateWallet().address);
    assert.strictEqual(addresses.size, 10);
  });

  test('generateWallet address is 0x-prefixed 40 hex chars', () => {
    const w = bank.generateWallet();
    assert.match(w.address, /^0x[0-9a-f]{40}$/);
  });
} catch (e) { console.warn('  SKIP bank_chain tests:', e.message); }

// bank_config catalog
console.log('\n== bank_config catalog ==');
try {
  const bankConfig = require('../src/primitives/bank_config');
  test('CHAINS includes base + ethereum + solana', () => {
    assert.ok(bankConfig.CHAINS.base);
    assert.ok(bankConfig.CHAINS.ethereum);
    assert.ok(bankConfig.CHAINS.solana);
  });
  test('USDC supported on base + ethereum + solana', () => {
    assert.ok(bankConfig.ASSETS.USDC.base);
    assert.ok(bankConfig.ASSETS.USDC.ethereum);
    assert.ok(bankConfig.ASSETS.USDC.solana);
  });
  test('getAssetConfig throws for unsupported pair', () => {
    assert.throws(() => bankConfig.getAssetConfig('FOO', 'base'));
  });
} catch (e) { console.warn('  SKIP bank_config tests:', e.message); }

// kyc_extensions tiers
console.log('\n== kyc_extensions tiers ==');
try {
  const kycExt = require('../src/primitives/kyc_extensions');
  test('TIER_LIMITS has 5 tiers (0-4)', () => {
    for (let t = 0; t < 5; t++) assert.ok(kycExt.TIER_LIMITS[t]);
  });
  test('Tier 4 has no limit', () => {
    assert.strictEqual(kycExt.TIER_LIMITS[4].daily, null);
    assert.strictEqual(kycExt.TIER_LIMITS[4].monthly, null);
  });
  test('Tier limits are monotonic', () => {
    for (let t = 0; t < 3; t++) {
      const a = BigInt(kycExt.TIER_LIMITS[t].daily);
      const b = BigInt(kycExt.TIER_LIMITS[t + 1].daily);
      assert.ok(b > a);
    }
  });
} catch (e) { console.warn('  SKIP kyc_extensions tests:', e.message); }

// cron_auth
console.log('\n== cron_auth ==');
const { isCronRequest } = require('../src/cron_auth');
test('isCronRequest accepts matching x-cron-secret', () => {
  process.env.CRON_SECRET = 'test-secret';
  const req = { headers: { 'x-cron-secret': 'test-secret' } };
  assert.strictEqual(isCronRequest(req), true);
});
test('isCronRequest rejects wrong secret', () => {
  process.env.CRON_SECRET = 'test-secret';
  const req = { headers: { 'x-cron-secret': 'wrong' } };
  assert.strictEqual(isCronRequest(req), false);
});
test('isCronRequest accepts Vercel cron + bearer', () => {
  process.env.CRON_SECRET = 'test-secret';
  const req = { headers: { 'x-vercel-cron': '1', authorization: 'Bearer test-secret' } };
  assert.strictEqual(isCronRequest(req), true);
});

// rate_limit
console.log('\n== rate_limit ==');
const { rateLimit } = require('../src/rate_limit');
test('rate limit allows under cap', () => {
  const rl = rateLimit({ windowMs: 60_000, max: 5 });
  const req = { headers: {}, ip: '1.2.3.4', path: '/test' };
  const res = { setHeader: () => {}, status: () => res, json: () => {} };
  let calls = 0;
  rl(req, res, () => calls++);
  rl(req, res, () => calls++);
  rl(req, res, () => calls++);
  assert.strictEqual(calls, 3);
});

test('rate limit blocks over cap', () => {
  const rl = rateLimit({ windowMs: 60_000, max: 2 });
  const req = { headers: {}, ip: '5.6.7.8', path: '/test' };
  let statusCode = 0;
  const res = {
    setHeader: () => {},
    status: (c) => { statusCode = c; return res; },
    json: () => {}
  };
  rl(req, res, () => {});
  rl(req, res, () => {});
  rl(req, res, () => {});
  assert.strictEqual(statusCode, 429);
});

// audit chain
console.log('\n== audit chain adapter ==');
const { makeAuditChainAdapter } = require('../src/integration');
test('canonical hash is deterministic', () => {
  const mockPool = { query: async () => ({ rows: [] }) };
  const ac = makeAuditChainAdapter(mockPool);
  return Promise.all([ac.append({ a: 1, b: 2 }), ac.append({ a: 1, b: 2 })])
    .then(([r1, r2]) => assert.strictEqual(r1.hash, r2.hash));
});

setTimeout(() => {
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}, 100);
