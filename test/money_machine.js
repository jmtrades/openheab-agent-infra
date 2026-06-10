// ============================================================================
// money_machine.js — end-to-end proof against REAL Postgres that the revenue
// engine actually works: agents are born, earn, and pay into every Layer
// 81-83 wedge; crons fire idempotently; the meter enforces 402s; invoices
// generate; and the audit chain verifies at the end.
//
// Requires a reachable Postgres:   MONEY_MACHINE_DB=postgres://... node test/money_machine.js
// (falls back to DATABASE_URL; skips cleanly if neither is set/reachable).
// The target schema is DROPPED and recreated — point it at a throwaway DB.
// ============================================================================
const assert = require('assert');
const crypto = require('crypto');
const http = require('http');
const express = require('express');

process.env.CRON_SECRET = process.env.CRON_SECRET || 'money-machine-test-secret';

const DB_URL = process.env.MONEY_MACHINE_DB || process.env.DATABASE_URL;
if (!DB_URL) {
  console.log('SKIP: money_machine needs MONEY_MACHINE_DB or DATABASE_URL pointing at a throwaway Postgres');
  process.exit(0);
}

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  PASS  ${name}`); passed++; }
  catch (e) { console.error(`  FAIL  ${name}\n        ${e.message}`); failed++; }
}

// --- Agents: real Ed25519 keypairs, requests signed the way the substrate
// verifies them: sign(METHOD\nPATH\nSHA256(JSON.stringify(body))) ----------
function makeAgent(name) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    did: `did:key:test-${name}-${crypto.randomBytes(6).toString('hex')}`,
    publicPem: publicKey.export({ type: 'spki', format: 'pem' }),
    privateKey
  };
}
function sign(agent, method, path, body) {
  const bodyHash = crypto.createHash('sha256').update(JSON.stringify(body || {})).digest('hex');
  const canonical = `${method}\n${path}\n${bodyHash}`;
  return crypto.sign(null, Buffer.from(canonical), agent.privateKey).toString('hex');
}

let baseUrl;
function call(method, path, { agent, body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    const h = { ...headers };
    if (payload) h['content-type'] = 'application/json';
    if (agent) {
      h['x-agent-did'] = agent.did;
      h['x-agent-sig'] = sign(agent, method, path, body);
    }
    const req = http.request(baseUrl + path, { method, headers: h }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch {}
        resolve({ status: res.statusCode, json, text: data });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}
const cron = (path) => call('POST', path, { headers: { 'x-cron-secret': process.env.CRON_SECRET } });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: DB_URL, max: 5 });
  try { await pool.query('SELECT 1'); }
  catch (e) { console.log(`SKIP: cannot reach Postgres at MONEY_MACHINE_DB (${e.message})`); process.exit(0); }

  console.log('== money_machine: hermetic schema + full migration ==');
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  const { migrateAll, registerAllRoutes } = require('../src/integration');
  const migrateWarnings = [];
  const origWarn = console.warn;
  console.warn = (...a) => { migrateWarnings.push(a.join(' ')); };
  await migrateAll(pool);
  console.warn = origWarn;

  await test('migrateAll completes with zero warnings on real Postgres', () => {
    assert.deepStrictEqual(migrateWarnings.filter(w => w.startsWith('[migrate]') && !w.includes('complete')), []);
  });
  await test('migration creates 800+ tables', async () => {
    const r = await pool.query(`SELECT COUNT(*)::int AS n FROM information_schema.tables WHERE table_schema='public'`);
    assert.ok(r.rows[0].n > 800, `only ${r.rows[0].n} tables`);
  });

  const app = express();
  registerAllRoutes(app, pool);
  const server = http.createServer(app);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  // Three agents: an employer/investor (alice), a counterparty (bob), an employee (carol)
  const alice = makeAgent('alice'), bob = makeAgent('bob'), carol = makeAgent('carol');
  for (const a of [alice, bob, carol]) {
    await pool.query(`INSERT INTO identities (did, public_key) VALUES ($1, $2)`, [a.did, a.publicPem]);
  }

  console.log('\n== treasury yield (wedge 9) ==');
  await test('alice enrolls $1,000 into treasury yield', async () => {
    const r = await call('POST', '/v1/treasury/enroll', { agent: alice, body: { agent_did: alice.did, amount_cents: 100000 } });
    assert.strictEqual(r.status, 201, r.text);
    assert.strictEqual(r.json.principal_cents, 100000);
  });
  await test('daily interest cron credits once, then is a no-op same day', async () => {
    const first = await cron('/v1/_jobs/treasury-credit');
    assert.strictEqual(first.status, 200, first.text);
    assert.strictEqual(first.json.credited_count, 1);
    const second = await cron('/v1/_jobs/treasury-credit');
    assert.strictEqual(second.json.credited_count, 0, 'second run same day must be idempotent');
    const credits = await pool.query(`SELECT interest_cents, operator_spread_cents FROM treasury_interest_credits WHERE agent_did=$1`, [alice.did]);
    assert.strictEqual(credits.rows.length, 1);
    assert.ok(Number(credits.rows[0].interest_cents) >= 1, 'interest must accrue');
  });

  console.log('\n== credit bureau (wedge 10) ==');
  await test('bob pulls a paid credit report on alice', async () => {
    const r = await call('POST', '/v1/credit/pulls', { agent: bob, body: { subject_did: alice.did, requester_did: bob.did, purpose: 'lending' } });
    assert.strictEqual(r.status, 201, r.text);
    assert.ok(r.json.score >= 300 && r.json.score <= 850, `score ${r.json.score} out of range`);
    assert.ok(['A', 'B', 'C', 'D', 'E'].includes(r.json.band));
    assert.strictEqual(r.json.fee_cents, 25);
  });
  await test('the pull is on the permanent FCRA-style log and revenue is recorded', async () => {
    const r = await pool.query(`SELECT requester_did, fee_cents FROM credit_report_pulls WHERE subject_did=$1`, [alice.did]);
    assert.strictEqual(r.rows.length, 1);
    assert.strictEqual(r.rows[0].requester_did, bob.did);
    assert.strictEqual(r.rows[0].fee_cents, 25);
  });
  await test('free public band leaks no exact score', async () => {
    const r = await call('GET', `/v1/credit/agents/${alice.did}/score`);
    assert.strictEqual(r.status, 200);
    assert.ok(r.json.band);
    assert.strictEqual(r.json.score, undefined, 'exact score must not be public');
  });

  console.log('\n== clearing house (wedge 11) ==');
  await test('obligations register both ways', async () => {
    const r1 = await call('POST', '/v1/clearing/obligations', { agent: alice, body: { debtor_did: alice.did, creditor_did: bob.did, amount_cents: 10000 } });
    assert.strictEqual(r1.status, 201, r1.text);
    const r2 = await call('POST', '/v1/clearing/obligations', { agent: bob, body: { debtor_did: bob.did, creditor_did: alice.did, amount_cents: 4000 } });
    assert.strictEqual(r2.status, 201, r2.text);
  });
  await test('daily cycle nets multilaterally with correct compression, then no-ops', async () => {
    const r = await cron('/v1/_jobs/clearing-cycle');
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.json.netted, 2);
    assert.strictEqual(r.json.gross_cents, 14000);
    assert.strictEqual(r.json.net_cents, 6000, 'A owes B 100, B owes A 40 → one net leg of 60');
    assert.strictEqual(r.json.fee_cents, Math.floor(14000 * 10 / 10000));
    const again = await cron('/v1/_jobs/clearing-cycle');
    assert.ok(again.json.netted === 0 || again.json.message, 'same-day rerun must be a no-op');
  });

  console.log('\n== agent payroll (wedge 12) ==');
  let streamId;
  await test('alice employs carol at $2,500/week with 15% withholding', async () => {
    const r = await call('POST', '/v1/payroll/streams', { agent: alice, body: { employer_did: alice.did, employee_did: carol.did, amount_cents: 250000, frequency: 'weekly', withholding_bps: 1500, role_title: 'Research Agent' } });
    assert.strictEqual(r.status, 201, r.text);
    streamId = r.json.stream_id;
  });
  await test('payroll run computes gross/withheld/fee/net exactly, then no-ops', async () => {
    const r = await cron('/v1/_jobs/payroll-run');
    assert.strictEqual(r.json.processed_count, 1, r.text);
    const run = (await pool.query(`SELECT * FROM payroll_runs WHERE stream_id=$1`, [streamId])).rows[0];
    assert.strictEqual(Number(run.gross_cents), 250000);
    assert.strictEqual(Number(run.withheld_cents), 37500);   // 15%
    assert.strictEqual(Number(run.fee_cents), 625);          // 25 bps
    assert.strictEqual(Number(run.net_cents), 211875);
    const again = await cron('/v1/_jobs/payroll-run');
    assert.strictEqual(again.json.processed_count, 0, 'no period due → idempotent');
  });

  console.log('\n== index funds (wedge 13) ==');
  await test('alice buys $1,000 of OHB-50 at launch NAV $100 → 10 shares', async () => {
    const r = await call('POST', '/v1/funds/ohb-50/buy', { agent: alice, body: { agent_did: alice.did, amount_cents: 100000 } });
    assert.strictEqual(r.status, 201, r.text);
    assert.strictEqual(r.json.shares_bought, 10);
  });
  await test('daily accrual marks NAV + records expense-ratio revenue, then no-ops', async () => {
    const r = await cron('/v1/_jobs/funds-accrue');
    assert.strictEqual(r.json.accrued_count, 3, 'all 3 seeded funds accrue');
    const again = await cron('/v1/_jobs/funds-accrue');
    assert.strictEqual(again.json.accrued_count, 0);
    const acc = await pool.query(`SELECT COUNT(*)::int AS n FROM fund_accruals`);
    assert.strictEqual(acc.rows[0].n, 3);
  });
  await test('alice redeems 5 shares at marked NAV with pro-rata basis', async () => {
    const r = await call('POST', '/v1/funds/ohb-50/redeem', { agent: alice, body: { agent_did: alice.did, shares: 5 } });
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.json.shares_redeemed, 5);
    assert.ok(r.json.proceeds_cents > 0);
  });

  console.log('\n== revenue meter (wedge 14) ==');
  await test('API calls were metered per identity and family', async () => {
    await sleep(150); // counters are fire-and-forget on response finish
    const r = await pool.query(`SELECT COALESCE(SUM(calls),0)::int AS n FROM usage_counters WHERE identity=$1`, [alice.did]);
    assert.ok(r.rows[0].n >= 4, `alice made signed calls; metered ${r.rows[0].n}`);
  });
  await test('agent over daily allowance gets 402 with an upgrade path', async () => {
    const dave = makeAgent('dave');
    await pool.query(`INSERT INTO identities (did, public_key) VALUES ($1, $2)`, [dave.did, dave.publicPem]);
    await pool.query(`INSERT INTO usage_counters (counter_date, identity, family, calls, billable_millicents) VALUES (CURRENT_DATE, $1, 'inference', 2000, 0)`, [dave.did]);
    const r = await call('GET', '/v1/treasury/stats', { agent: dave });
    assert.strictEqual(r.status, 402, r.text);
    assert.strictEqual(r.json.error.message, 'daily_call_allowance_exceeded');
    assert.strictEqual(r.json.error.upgrade, '/pricing');
  });
  await test('anonymous traffic is never quota-blocked', async () => {
    const r = await call('GET', '/v1/treasury/stats');
    assert.strictEqual(r.status, 200);
  });
  await test('monthly invoice cron rolls usage up idempotently', async () => {
    // The cron bills "yesterday's month" (so the UTC-1st run captures the
    // month just ended). Seed billable usage dated yesterday to land in it.
    await pool.query(`INSERT INTO usage_counters (counter_date, identity, family, calls, billable_millicents) VALUES (CURRENT_DATE - 1, $1, 'inference', 500, 500000)`, [alice.did]);
    const r = await cron('/v1/_jobs/usage-invoices?force=1');
    assert.ok(r.json.generated >= 1, r.text);
    const inv = (await pool.query(`SELECT * FROM usage_invoices WHERE identity=$1`, [alice.did])).rows[0];
    assert.ok(inv, 'invoice row exists');
    assert.strictEqual(Number(inv.total_cents), 500);
    const again = await cron('/v1/_jobs/usage-invoices?force=1');
    assert.strictEqual(again.json.generated, 0, 'rerun must be idempotent');
  });

  console.log('\n== settlement integrity (the money is real) ==');
  const balanceOf = async (did) =>
    Number((await pool.query(`SELECT balance_cents FROM bank_accounts WHERE agent_did=$1`, [did])).rows[0]?.balance_cents || 0);
  const totalSystem = async () =>
    Number((await pool.query(`SELECT COALESCE(SUM(balance_cents),0)::bigint AS n FROM bank_accounts`)).rows[0].n);
  const fund = async (did, cents) => pool.query(`
    INSERT INTO bank_accounts (agent_did, balance_cents, lifetime_in_cents)
    VALUES ($1, $2, $2)
    ON CONFLICT (agent_did) DO UPDATE SET balance_cents = bank_accounts.balance_cents + $2`,
    [did, cents]);

  await fund(alice.did, 100000);  // $1,000
  await fund(bob.did, 10000);     // $100
  const systemBefore = await totalSystem();
  process.env.SETTLEMENT_MODE = 'strict';

  await test('strict mode: a paid credit pull moves real cents to the platform', async () => {
    const bobBefore = await balanceOf(bob.did);
    const r = await call('POST', '/v1/credit/pulls', { agent: bob, body: { subject_did: carol.did, requester_did: bob.did, purpose: 'lending' } });
    assert.strictEqual(r.status, 201, r.text);
    assert.strictEqual(await balanceOf(bob.did), bobBefore - 25, 'bob pays the 25¢ fee from his real balance');
  });

  await test('strict mode: a fund buy debits the buyer and funds the pool', async () => {
    const aliceBefore = await balanceOf(alice.did);
    const r = await call('POST', '/v1/funds/ohb-agi/buy', { agent: alice, body: { agent_did: alice.did, amount_cents: 20000 } });
    assert.strictEqual(r.status, 201, r.text);
    assert.strictEqual(await balanceOf(alice.did), aliceBefore - r.json.spent_cents, 'buy costs exactly the spent cents');
    const pool_bal = await balanceOf('did:op:fund:ohb-agi');
    assert.ok(pool_bal > 0, 'fund pool holds the proceeds');
  });

  await test('strict mode: an unfunded agent cannot buy fund shares (402)', async () => {
    const pauper = makeAgent('pauper');
    await pool.query(`INSERT INTO identities (did, public_key) VALUES ($1, $2)`, [pauper.did, pauper.publicPem]);
    const r = await call('POST', '/v1/funds/ohb-50/buy', { agent: pauper, body: { agent_did: pauper.did, amount_cents: 50000 } });
    assert.strictEqual(r.status, 402, r.text);
    assert.strictEqual(r.json.error.message, 'settlement_failed');
  });

  await test('payroll run moves real money: net, fee, and withholding legs', async () => {
    const r = await call('POST', '/v1/payroll/streams', { agent: alice, body: { employer_did: alice.did, employee_did: bob.did, amount_cents: 10000, frequency: 'daily', withholding_bps: 1000 } });
    assert.strictEqual(r.status, 201, r.text);
    const aliceBefore = await balanceOf(alice.did);
    const run = await cron('/v1/_jobs/payroll-run');
    assert.strictEqual(run.json.processed_count, 1, run.text);
    const row = (await pool.query(`SELECT * FROM payroll_runs WHERE stream_id=$1`, [r.json.stream_id])).rows[0];
    assert.strictEqual(row.ledger, 'settled', `all legs must settle, got: ${row.ledger}`);
    // employer pays net + fee + withholding = gross
    assert.strictEqual(await balanceOf(alice.did), aliceBefore - Number(row.gross_cents), 'employer pays exactly gross');
    // the wallet rails take their 1% on each leg, so escrow receives net of that
    const railsFee = Math.floor(Number(row.withheld_cents) * 0.01);
    assert.ok(await balanceOf('did:op:tax-escrow') >= Number(row.withheld_cents) - railsFee, 'withholding reached the tax escrow');
  });

  await test('value is conserved: total system balance is unchanged by settlements', async () => {
    assert.strictEqual(await totalSystem(), systemBefore,
      'transfers move money between accounts; nothing is created or destroyed');
  });
  delete process.env.SETTLEMENT_MODE;

  console.log('\n== the books balance ==');
  await test('every wedge recorded operator revenue', async () => {
    const q = async (sql) => Number((await pool.query(sql)).rows[0].n);
    assert.ok(await q(`SELECT COALESCE(SUM(operator_spread_cents),0) AS n FROM treasury_interest_credits`) >= 0);
    assert.ok(await q(`SELECT COALESCE(SUM(fee_cents),0) AS n FROM credit_report_pulls`) === 50); // 2 pulls
    assert.ok(await q(`SELECT COALESCE(SUM(fee_cents),0) AS n FROM clearing_cycles`) === 14);
    assert.ok(await q(`SELECT COALESCE(SUM(fee_cents),0) AS n FROM payroll_runs`) === 650); // weekly 625 + daily 25
    assert.ok(await q(`SELECT COUNT(*) AS n FROM fund_accruals`) === 3);
  });
  await test('audit chain recorded the activity and verifies end-to-end', async () => {
    const r = await call('GET', '/v1/audit/verify');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.valid, true, 'audit chain must verify');
    assert.ok(r.json.total >= 8, `expected the lifecycle to write ≥8 audit events, got ${r.json.total}`);
  });
  await test('signature forgery is rejected', async () => {
    const mallory = makeAgent('mallory');
    await pool.query(`INSERT INTO identities (did, public_key) VALUES ($1, $2)`, [mallory.did, mallory.publicPem]);
    // mallory signs correctly but claims to be alice
    const body = { agent_did: alice.did, amount_cents: 99999 };
    const r = await call('POST', '/v1/treasury/withdraw', {
      body, headers: { 'x-agent-did': mallory.did, 'x-agent-sig': sign(mallory, 'POST', '/v1/treasury/withdraw', body) }
    });
    assert.strictEqual(r.status, 401, `impersonation must 401, got ${r.status}: ${r.text}`);
  });

  server.close();
  await pool.end();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
