#!/usr/bin/env node
// ============================================================================
// citizen-agent — a day in the life of an economic citizen of the substrate.
//
// Zero dependencies (Node 18+). Run it against any OpenHeab deployment:
//
//   node agent.js --base https://openheab.com
//   node agent.js --base http://localhost:3000
//
// What it does, fully autonomously — no human, no dashboard, no Stripe form:
//
//   1. BIRTH      two agents self-onboard: POST /v1/identities → DID +
//                 Ed25519 keypair + API key + USDC wallet, in one call
//   2. CREDIT     the employer pulls the worker's credit report (paid, logged)
//   3. EMPLOYMENT the employer starts a weekly salary stream with withholding
//   4. COMMERCE   both register A2A obligations for the next clearing cycle
//   5. SAVINGS    the worker enrolls idle USDC into treasury yield
//   6. INVESTING  the worker buys index fund shares at NAV
//   7. BOOKS      the worker reads its own meter, positions, and band
//
// Every request is signed with the agent's own Ed25519 key exactly the way
// the substrate verifies it: sign(METHOD\nPATH\nSHA256(JSON.stringify(body))).
// This file is also the smallest correct client implementation of that scheme.
// ============================================================================
const crypto = require('crypto');

const args = process.argv.slice(2);
const BASE = (args[args.indexOf('--base') + 1] && args.includes('--base'))
  ? args[args.indexOf('--base') + 1].replace(/\/$/, '')
  : 'http://localhost:3000';

const dollars = c => `$${(Number(c) / 100).toLocaleString(undefined, { minimumFractionDigits: 2 })}`;

class Citizen {
  constructor(name) { this.name = name; }

  async birth() {
    const r = await fetch(`${BASE}/v1/identities`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: this.name, kind: 'reference-citizen' })
    });
    if (r.status !== 201) throw new Error(`birth failed: ${r.status} ${await r.text()}`);
    const j = await r.json();
    this.did = j.did;
    this.privateKey = crypto.createPrivateKey(j.private_key);
    this.apiKey = j.api_key;
    this.wallet = j.wallet;
    return this;
  }

  sign(method, path, body) {
    const bodyHash = crypto.createHash('sha256')
      .update(JSON.stringify(body || {})).digest('hex');
    return crypto.sign(null, Buffer.from(`${method}\n${path}\n${bodyHash}`), this.privateKey).toString('hex');
  }

  async call(method, path, body) {
    const headers = {
      'x-agent-did': this.did,
      'x-agent-sig': this.sign(method, path, body)
    };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const r = await fetch(`${BASE}${path}`, {
      method, headers, body: body !== undefined ? JSON.stringify(body) : undefined
    });
    const json = await r.json().catch(() => null);
    if (r.status >= 400) {
      throw new Error(`${method} ${path} → ${r.status}: ${JSON.stringify(json)}`);
    }
    return json;
  }
}

(async () => {
  console.log(`\ncitizen-agent → ${BASE}\n`);

  // -- 1. Birth ---------------------------------------------------------------
  const worker = await new Citizen('citizen-worker').birth();
  const employer = await new Citizen('citizen-employer').birth();
  console.log(`BORN      ${worker.name}    ${worker.did}`);
  console.log(`          wallet ${worker.wallet ? worker.wallet.address : '(chain provisioning off)'}`);
  console.log(`BORN      ${employer.name}  ${employer.did}\n`);

  // -- 2. Credit check before hiring -------------------------------------------
  const report = await employer.call('POST', '/v1/credit/pulls', {
    subject_did: worker.did, requester_did: employer.did, purpose: 'employment'
  });
  console.log(`CREDIT    employer pulled worker's report: score ${report.score} (band ${report.band}) — fee ${dollars(report.fee_cents)}`);
  console.log(`          factors: ${Object.entries(report.factors).map(([k, v]) => `${k}=${v}`).join(', ')}\n`);

  // -- 3. Employment ------------------------------------------------------------
  const stream = await employer.call('POST', '/v1/payroll/streams', {
    employer_did: employer.did, employee_did: worker.did,
    amount_cents: 250000, frequency: 'weekly', withholding_bps: 1500,
    role_title: 'Autonomous Research Agent'
  });
  console.log(`HIRED     weekly $2,500.00 salary stream ${stream.stream_id} (15% withholding, ${stream.fee_bps} bps processing)`);

  // -- 4. Commerce: mutual obligations for the clearing cycle -------------------
  await worker.call('POST', '/v1/clearing/obligations', {
    debtor_did: worker.did, creditor_did: employer.did, amount_cents: 1800, memo: 'API costs reimbursement'
  });
  await employer.call('POST', '/v1/clearing/obligations', {
    debtor_did: employer.did, creditor_did: worker.did, amount_cents: 7300, memo: 'completed research bounty'
  });
  const position = await worker.call('GET', `/v1/clearing/agents/${worker.did}/position`);
  console.log(`CLEARING  worker owes ${dollars(position.pending_owes_cents)}, is owed ${dollars(position.pending_owed_cents)} → nets to ${dollars(position.projected_net_cents)} in tonight's cycle`);

  // -- 5. Savings ----------------------------------------------------------------
  const enrollment = await worker.call('POST', '/v1/treasury/enroll', {
    agent_did: worker.did, amount_cents: 50000
  });
  console.log(`SAVINGS   worker enrolled $500.00 at ${(enrollment.net_apy_bps / 100).toFixed(2)}% APY (credited daily)`);

  // -- 6. Investing ---------------------------------------------------------------
  const buy = await worker.call('POST', '/v1/funds/ohb-50/buy', {
    agent_did: worker.did, amount_cents: 30000
  });
  console.log(`INVESTED  worker bought ${buy.shares_bought} shares of OHB-50 at $${buy.nav_usd.toFixed(2)} NAV (${dollars(buy.spent_cents)})\n`);

  // -- 7. Reading its own books ----------------------------------------------------
  const [funds, payroll, band, usage] = await Promise.all([
    worker.call('GET', `/v1/funds/agents/${worker.did}`),
    worker.call('GET', `/v1/payroll/agents/${worker.did}`),
    worker.call('GET', `/v1/credit/agents/${worker.did}/score`),
    worker.call('GET', `/v1/usage/${worker.did}`)
  ]);
  console.log('THE WORKER\'S BOOKS');
  console.log(`  credit band        ${band.band} (public; full report costs a pull)`);
  console.log(`  fund positions     ${funds.positions.length} (${dollars(funds.total_value_cents)} market value)`);
  console.log(`  salary streams     ${payroll.as_employee.length} inbound (${payroll.as_employee.map(s => `${dollars(s.amount_cents)}/${s.frequency}`).join(', ')})`);
  console.log(`  lifetime earnings  ${dollars(payroll.lifetime_net_earnings_cents)} (first run lands with tonight's payroll cron)`);
  console.log(`  API usage today    ${usage.today.reduce((a, f) => a + f.calls, 0)} calls across ${usage.today.length} families (allowance ${usage.daily_allowance}/day)`);

  console.log(`\nOVERNIGHT the substrate's crons will: credit treasury interest,`);
  console.log(`net the clearing cycle to one signed amount each, run payroll`);
  console.log(`(gross→withholding→fee→net), mark fund NAVs, accrue expense`);
  console.log(`ratios, and append every event to the signed audit chain.`);
  console.log(`\nTwo agents just ran an economy. No human touched anything.\n`);
})().catch(e => { console.error(`\nFAILED: ${e.message}\n`); process.exit(1); });
