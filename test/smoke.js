// ============================================================================
// Smoke test — end-to-end checks against a running deployment.
// ============================================================================
// Usage: BASE=https://openheab.com node test/smoke.js

const BASE = process.env.BASE || 'http://localhost:3000';

const assertEq = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  →  expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`);
  if (!ok) process.exitCode = 1;
};
const assertOk = (name, cond, info) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${info ? '  →  ' + info : ''}`);
  if (!cond) process.exitCode = 1;
};

async function http(method, path, body, headers = {}) {
  const r = await fetch(`${BASE}${path}`, {
    method, headers: { 'content-type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined
  });
  let json;
  try { json = await r.json(); } catch { json = null; }
  return { status: r.status, json };
}

async function main() {
  console.log(`\n=== openheab-substrate smoke test against ${BASE} ===\n`);

  const health = await http('GET', '/healthz');
  assertEq('healthz ok', health.json?.ok, true);

  const ready = await http('GET', '/readyz');
  assertOk('readyz', ready.status === 200, `status=${ready.status}`);

  const id = await http('POST', '/v1/identities', { name: 'smoke-test-agent' });
  assertOk('create identity', id.status === 201 && id.json?.did?.startsWith('did:op:'),
           `did=${id.json?.did}`);

  if (id.json?.did) {
    const lookup = await http('GET', `/v1/identities/${id.json.did}`);
    assertOk('lookup identity', lookup.status === 200 && lookup.json?.did === id.json.did);
  }

  const audit = await http('GET', '/v1/audit/verify');
  assertOk('audit chain valid', audit.json?.valid === true,
           `valid=${audit.json?.valid} verified=${audit.json?.verified}`);

  const mcp = await http('GET', '/mcp/manifest');
  assertOk('mcp/manifest returns tools', Array.isArray(mcp.json?.tools) && mcp.json.tools.length >= 30);

  console.log('\n=== smoke test done ===\n');
}

main().catch(e => { console.error('SMOKE_TEST_CRASH:', e); process.exit(1); });
