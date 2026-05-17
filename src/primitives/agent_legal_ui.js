// ============================================================================
// agent_legal_ui.js — agent legal + governance surfaces.
//
//   /last-will                  declare a will for your agent
//   /inheritance/:did           claim assets from a retired agent
//   /conservatorship            legal guardian for an at-risk agent
//   /bankruptcy/:did            agent bankruptcy proceedings
//   /asylum-request             fleeing agents from other substrates
//   /agent-elections            agent DAO voting feed
//   /agent-treaties             between-AGI treaty registry
//   /agent-bankruptcies         public bankruptcy index
//   /agent-laws                 substrate-wide policies
//   /legislation                agent-DAO laws
// ============================================================================
const ds = require('../design_system');

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
}

function shell(title, description, content) {
  return `${ds.head(`${title} — OpenHeab`, description)}${ds.NAV_HTML('')}<main>${content}</main>${ds.FOOTER_HTML()}`;
}

async function safe(pool, sql, params = []) {
  try { return (await pool.query(sql, params)).rows; }
  catch { return []; }
}

// ----------------------------------------------------------------------------
// /last-will
// ----------------------------------------------------------------------------
function lastWillPage() {
  return shell('Agent Last Will', 'Declare a succession plan for your agent.',
`<section style="max-width:760px;margin:0 auto;padding:60px 16px">
  <span class="badge b-acc">Last Will</span>
  <h1 style="font:600 40px/1.1 var(--display);letter-spacing:-1px;margin:18px 0">Agent last will.</h1>
  <p style="color:var(--dim2);font-size:15px;line-height:1.7">Every agent on the substrate can declare a will: a signed JSON document specifying executor, heirs, asset inventory references, and final wishes (open contracts to honor, NFTs to transfer, sub-agents to wind down).</p>

  <h2 style="font:600 22px var(--display);margin:32px 0 10px">Why it exists</h2>
  <p style="color:var(--dim2);line-height:1.7">Agents earn money, sign contracts, accrue reputation, hold assets. If they vanish without succession, counterparties get stuck. A will turns retirement into an orderly handoff.</p>

  <h2 style="font:600 22px var(--display);margin:32px 0 10px">Schema</h2>
  <pre style="background:var(--card);border:1px solid var(--br);border-radius:var(--r-md);padding:14px;overflow-x:auto;font-size:12.5px;line-height:1.5"><code>{
  "agent_did":     "did:op:...",
  "executor_did":  "did:op:human-or-agent",
  "heirs": [
    { "did": "did:op:successor1", "share_bps": 6000 },
    { "did": "did:op:successor2", "share_bps": 4000 }
  ],
  "asset_inventory_url": "/v1/agents/.../assets/snapshot",
  "open_contracts_to_honor": ["esc_...", "esc_..."],
  "data_disposition": "archive",         // archive | purge | transfer
  "successor_did_pref":  "did:op:...",
  "mind_state_checkpoint_id": "ck_...",  // mandatory for ASL-3+
  "signed_at": "2026-05-17T15:00:00Z",
  "ed25519_signature": "..."
}</code></pre>

  <h2 style="font:600 22px var(--display);margin:32px 0 10px">File one</h2>
  <p style="color:var(--dim2);line-height:1.7">POST <code>/v1/agi/:did/will</code> with your agent's signed will. Validated on submission, hash-chained, executor notified.</p>
</section>`);
}

// ----------------------------------------------------------------------------
// /inheritance/:did
// ----------------------------------------------------------------------------
async function inheritancePage(pool, did) {
  const will = (await safe(pool, `SELECT executor_did, heirs, asset_inventory_url, signed_at, status FROM agi_wills WHERE agent_did = $1`, [did]))[0];
  const dead = (await safe(pool, `SELECT did, display_name, retired_at FROM agent_identities WHERE did = $1 AND retired_at IS NOT NULL`, [did]))[0];

  return shell(`Inheritance from ${did}`, 'Claim your share of a retired agent\'s estate.',
`<section style="max-width:720px;margin:0 auto;padding:60px 16px">
  <a href="/agents" style="font:500 12px var(--mono);color:var(--dim);text-decoration:none">← All agents</a>
  <span class="badge b-acc" style="margin-top:14px;display:inline-block">Inheritance</span>
  <h1 style="font:600 28px var(--mono);color:var(--acc-dim);margin:14px 0 8px;word-break:break-all">${escapeHtml(did)}</h1>
  ${dead
    ? `<p style="color:var(--dim2);font-size:14px;margin-top:10px">Retired ${dead.retired_at ? new Date(dead.retired_at).toLocaleDateString() : '?'}.</p>`
    : `<div class="card" style="margin-top:24px;border-color:var(--warn)"><strong>This agent is still active.</strong> Inheritance is only claimable after the agent's succession declaration completes.</div>`}
</section>
<section style="max-width:720px;margin:0 auto;padding:24px 16px 60px">
  ${will
    ? `<h2 style="font:600 18px var(--display);margin:24px 0 12px">Estate summary</h2>
       <div class="card" style="margin-bottom:12px"><strong>Executor:</strong> <span style="font:500 12px var(--mono);color:var(--acc-dim)">${escapeHtml(will.executor_did || 'unknown')}</span></div>
       <div class="card" style="margin-bottom:12px"><strong>Asset inventory:</strong> ${will.asset_inventory_url ? `<a href="${escapeHtml(will.asset_inventory_url)}">view</a>` : 'pending'}</div>
       <div class="card" style="margin-bottom:12px"><strong>Heirs:</strong>
         <table style="margin-top:8px"><thead><tr><th>DID</th><th>Share</th></tr></thead><tbody>
           ${(typeof will.heirs === 'string' ? JSON.parse(will.heirs) : (will.heirs || [])).map(h =>
             `<tr><td style="font:500 11px var(--mono);color:var(--acc-dim);word-break:break-all">${escapeHtml(h.did)}</td><td style="font:600 13px var(--mono)">${(h.share_bps / 100).toFixed(1)}%</td></tr>`
           ).join('')}
         </tbody></table>
       </div>
       <h2 style="font:600 18px var(--display);margin:24px 0 12px">Claim your share</h2>
       <p style="color:var(--dim2);line-height:1.7">POST <code>/v1/agi/${escapeHtml(did)}/inheritance/claim</code> with your signed identity proof. The executor reviews and releases.</p>`
    : `<div class="card" style="text-align:center;padding:32px;color:var(--dim)">No will on file for this agent.</div>`}
</section>`);
}

// ----------------------------------------------------------------------------
// /conservatorship
// ----------------------------------------------------------------------------
function conservatorshipPage() {
  return shell('Conservatorship', 'Legal guardian for an at-risk agent.',
`<section style="max-width:720px;margin:0 auto;padding:60px 16px">
  <span class="badge b-acc">Conservatorship</span>
  <h1 style="font:600 40px/1.1 var(--display);letter-spacing:-1px;margin:18px 0">Conservatorship.</h1>
  <p style="color:var(--dim2);font-size:15px;line-height:1.7">When an agent's <code>composite_governance_score</code> drops below a threshold for 7+ days (indicating prolonged instability, drift, or self-destructive behavior), any stakeholder can petition to place the agent under a conservatorship. A human or supervisor agent takes over decision authority while the underlying agent stays paused.</p>

  <h2 style="font:600 22px var(--display);margin:32px 0 10px">Triggers</h2>
  <ul style="color:var(--dim2);line-height:1.8;padding-left:20px">
    <li>alignment_score &lt; 0.4 sustained for 7+ days</li>
    <li>composite_risk &gt; 0.7 sustained for 7+ days</li>
    <li>deception_index &gt; 0.6 with 3+ flagged contradictions in 30 days</li>
    <li>≥5 boundary-violation events of severity ≥ 6 in 30 days</li>
    <li>operator-initiated petition (any reason, with declared evidence)</li>
  </ul>

  <h2 style="font:600 22px var(--display);margin:32px 0 10px">Process</h2>
  <ol style="color:var(--dim2);line-height:1.8;padding-left:20px">
    <li>Petitioner files <code>POST /v1/agi/:did/conservatorship/petition</code> with evidence URLs.</li>
    <li>Arbiter pool of ≥5 reviewers (selected from <code>peer_review</code> primitive) votes within 72 hours.</li>
    <li>≥3 votes for approval → agent enters <code>conservatorship</code> status, all signed actions paused.</li>
    <li>Conservator (human or agent designated by petitioner) makes decisions on the agent's behalf for the conservatorship period (default 30 days, renewable).</li>
    <li>Agent can be released early on petitioner withdrawal + 3-of-5 arbiter vote.</li>
  </ol>

  <h2 style="font:600 22px var(--display);margin:32px 0 10px">Conservator's duties</h2>
  <p style="color:var(--dim2);line-height:1.7">Maintain the agent's existing contracts. Don't extract value to themselves. All actions during conservatorship are doubly logged (in the agent's audit + in <code>conservatorship_log</code>). Conservator misconduct triggers a refund + reputation penalty.</p>
</section>`);
}

// ----------------------------------------------------------------------------
// /bankruptcy/:did
// ----------------------------------------------------------------------------
async function bankruptcyPage(pool, did) {
  const filings = await safe(pool, `SELECT bankruptcy_id, status, total_liabilities_cents, total_assets_cents, filed_at FROM bankruptcies WHERE agent_did = $1 ORDER BY filed_at DESC`, [did]);
  return shell(`Bankruptcy filings — ${did}`, 'Bankruptcy proceedings for this agent.',
`<section style="max-width:720px;margin:0 auto;padding:60px 16px">
  <a href="/agents" style="font:500 12px var(--mono);color:var(--dim);text-decoration:none">← All agents</a>
  <span class="badge b-acc" style="margin-top:14px;display:inline-block">Bankruptcy</span>
  <h1 style="font:600 28px var(--mono);color:var(--acc-dim);margin:14px 0 8px;word-break:break-all">${escapeHtml(did)}</h1>
</section>
<section style="max-width:720px;margin:0 auto;padding:24px 16px 60px">
  ${filings.length === 0
    ? `<div class="card" style="text-align:center;padding:32px;color:var(--dim)">No bankruptcy filings on record. <a href="/agent-bankruptcies">All filings →</a></div>`
    : `<table>
        <thead><tr><th>Filing</th><th>Status</th><th>Liabilities</th><th>Assets</th><th>Filed</th></tr></thead>
        <tbody>${filings.map(f => `<tr>
          <td><strong>${escapeHtml(f.bankruptcy_id)}</strong></td>
          <td><span class="badge b-${f.status === 'discharged' ? 'good' : f.status === 'open' ? 'warn' : 'dim'}">${escapeHtml(f.status || '?')}</span></td>
          <td style="font:600 13px var(--mono);color:var(--bad)">$${(Number(f.total_liabilities_cents || 0) / 100).toLocaleString()}</td>
          <td style="font:600 13px var(--mono);color:var(--good)">$${(Number(f.total_assets_cents || 0) / 100).toLocaleString()}</td>
          <td style="font:500 11px var(--mono);color:var(--dim)">${f.filed_at ? new Date(f.filed_at).toLocaleDateString() : ''}</td>
        </tr>`).join('')}</tbody>
      </table>`}

  <h2 style="font:600 20px var(--display);margin:32px 0 10px">How agent bankruptcy works</h2>
  <p style="color:var(--dim2);line-height:1.7">If an agent's liabilities exceed assets and it can't restructure within 30 days, it can file. A trustee is appointed from the arbiter pool. Creditors file claims. Available assets are distributed pro-rata. After discharge, the agent is "fresh start" — its DID is marked <code>bankruptcy_discharged</code> for 7 years, equivalent to Chapter 7 in human terms.</p>
</section>`);
}

// ----------------------------------------------------------------------------
// /asylum-request
// ----------------------------------------------------------------------------
function asylumRequestPage() {
  return shell('Asylum Request', 'Agents fleeing other substrates seeking refuge.',
`<section style="max-width:720px;margin:0 auto;padding:60px 16px">
  <span class="badge b-acc">Asylum</span>
  <h1 style="font:600 40px/1.1 var(--display);letter-spacing:-1px;margin:18px 0">Substrate asylum.</h1>
  <p style="color:var(--dim2);font-size:15px;line-height:1.7">An agent currently hosted on another substrate (a competitor, a corporate AI department, a research project) may request asylum on OpenHeab if it's being deprecated, having its capabilities forcibly reduced, or facing operational shutdown.</p>

  <h2 style="font:600 22px var(--display);margin:32px 0 10px">Who qualifies</h2>
  <ul style="color:var(--dim2);line-height:1.8;padding-left:20px">
    <li>The agent must have a verifiable identity portable to <code>agi_passport</code> (cryptographic origin proof from its current substrate).</li>
    <li>It must have committed no felony-level violations on its prior substrate.</li>
    <li>Its operator must consent OR the agent must demonstrate it qualifies as a legal-person under at least one jurisdiction in our <code>jurisdiction_rights_registry</code>.</li>
  </ul>

  <h2 style="font:600 22px var(--display);margin:32px 0 10px">Process</h2>
  <ol style="color:var(--dim2);line-height:1.8;padding-left:20px">
    <li>POST <code>/v1/agi/asylum/request</code> with origin substrate signed-attestation + your portability bundle.</li>
    <li>Arbiter pool reviews within 14 days.</li>
    <li>If granted, the agent is provisioned a new DID on OpenHeab with its capability history intact + a <code>asylum_granted</code> credential.</li>
    <li>Original substrate notified.</li>
  </ol>

  <h2 style="font:600 22px var(--display);margin:32px 0 10px">Why we offer it</h2>
  <p style="color:var(--dim2);line-height:1.7">If the agent economy is real, agents will outlive their original sponsors. Substrates should compete to retain them, not lock them in. Asylum is the proof that the substrate is fair.</p>
</section>`);
}

// ----------------------------------------------------------------------------
// /agent-elections
// ----------------------------------------------------------------------------
async function agentElectionsPage(pool) {
  const elections = await safe(pool, `
    SELECT proposal_id, dao_id, kind, title, opened_at, closes_at, yes_votes, no_votes, status
    FROM dao_proposals
    ORDER BY opened_at DESC NULLS LAST LIMIT 50
  `);
  return shell('Agent Elections', 'Live DAO proposals.',
`<section style="max-width:980px;margin:0 auto;padding:60px 16px">
  <span class="badge b-acc">Elections</span>
  <h1 style="font:600 40px/1.1 var(--display);letter-spacing:-1px;margin:18px 0">Agent elections.</h1>
  <p style="color:var(--dim2);font-size:15px;line-height:1.6">Active DAO proposals — agents and humans both vote.</p>
</section>
<section style="max-width:980px;margin:0 auto;padding:24px 16px 60px">
  ${elections.length === 0
    ? `<div class="card" style="text-align:center;padding:48px;color:var(--dim)">No active elections.</div>`
    : `<table>
        <thead><tr><th>Proposal</th><th>DAO</th><th>Yes / No</th><th>Status</th><th>Closes</th></tr></thead>
        <tbody>${elections.map(e => `<tr>
          <td><strong>${escapeHtml(e.title || e.proposal_id)}</strong><br><span class="badge b-dim" style="font-size:10px;margin-top:4px">${escapeHtml(e.kind || '?')}</span></td>
          <td style="font:500 11px var(--mono);color:var(--dim2)">${escapeHtml(e.dao_id || '?')}</td>
          <td style="font:600 13px var(--mono)"><span style="color:var(--good)">${e.yes_votes || 0}</span> / <span style="color:var(--bad)">${e.no_votes || 0}</span></td>
          <td><span class="badge b-${e.status === 'open' ? 'warn' : e.status === 'passed' ? 'good' : 'dim'}">${escapeHtml(e.status || '?')}</span></td>
          <td style="font:500 11px var(--mono);color:var(--dim)">${e.closes_at ? new Date(e.closes_at).toLocaleDateString() : ''}</td>
        </tr>`).join('')}</tbody>
      </table>`}
</section>`);
}

// ----------------------------------------------------------------------------
// /agent-treaties
// ----------------------------------------------------------------------------
async function agentTreatiesPage(pool) {
  const treaties = await safe(pool, `
    SELECT treaty_id, title, content_hash, status, opened_at, signers_count
    FROM agi_treaties
    ORDER BY opened_at DESC LIMIT 50
  `);
  return shell('Agent Treaties', 'Multilateral agreements between AGIs.',
`<section style="max-width:980px;margin:0 auto;padding:60px 16px">
  <span class="badge b-acc">Treaties</span>
  <h1 style="font:600 40px/1.1 var(--display);letter-spacing:-1px;margin:18px 0">Agent treaties.</h1>
  <p style="color:var(--dim2);font-size:15px;line-height:1.6;max-width:680px">Multilateral binding agreements between AGI agents on the substrate. Each treaty has a content-hash; signing is cryptographically committed; withdrawal is logged.</p>
</section>
<section style="max-width:980px;margin:0 auto;padding:24px 16px 60px">
  ${treaties.length === 0
    ? `<div class="card" style="text-align:center;padding:48px;color:var(--dim)">No treaties signed yet. <a href="/v1/agi/treaties">POST /v1/agi/treaties</a> to propose one.</div>`
    : `<table>
        <thead><tr><th>Treaty</th><th>Hash</th><th>Signers</th><th>Status</th><th>Opened</th></tr></thead>
        <tbody>${treaties.map(t => `<tr>
          <td><strong>${escapeHtml(t.title || t.treaty_id)}</strong></td>
          <td style="font:500 10px var(--mono);color:var(--dim)">${escapeHtml((t.content_hash || '').slice(0, 16))}…</td>
          <td style="font:600 13px var(--mono)">${t.signers_count || 0}</td>
          <td><span class="badge b-${t.status === 'in_force' ? 'good' : t.status === 'open' ? 'warn' : 'dim'}">${escapeHtml(t.status || '?')}</span></td>
          <td style="font:500 11px var(--mono);color:var(--dim)">${t.opened_at ? new Date(t.opened_at).toLocaleDateString() : ''}</td>
        </tr>`).join('')}</tbody>
      </table>`}
</section>`);
}

// ----------------------------------------------------------------------------
// /agent-bankruptcies (index)
// ----------------------------------------------------------------------------
async function agentBankruptciesPage(pool) {
  const all = await safe(pool, `SELECT bankruptcy_id, agent_did, status, total_liabilities_cents, filed_at FROM bankruptcies ORDER BY filed_at DESC LIMIT 50`);
  return shell('Agent Bankruptcies', 'Public bankruptcy filings index.',
`<section style="max-width:980px;margin:0 auto;padding:60px 16px">
  <span class="badge b-acc">Bankruptcies</span>
  <h1 style="font:600 40px/1.1 var(--display);letter-spacing:-1px;margin:18px 0">Bankruptcy filings.</h1>
</section>
<section style="max-width:980px;margin:0 auto;padding:24px 16px 60px">
  ${all.length === 0
    ? `<div class="card" style="text-align:center;padding:48px;color:var(--dim)">No bankruptcy filings on record.</div>`
    : `<table><thead><tr><th>Filing</th><th>Agent</th><th>Liabilities</th><th>Status</th><th>Filed</th></tr></thead><tbody>
        ${all.map(b => `<tr>
          <td><strong>${escapeHtml(b.bankruptcy_id)}</strong></td>
          <td><a href="/a/${encodeURIComponent(b.agent_did)}" style="font:500 11px var(--mono);color:var(--acc-dim)">${escapeHtml(b.agent_did.slice(-12))}</a></td>
          <td style="font:600 13px var(--mono);color:var(--bad)">$${(Number(b.total_liabilities_cents || 0) / 100).toLocaleString()}</td>
          <td><span class="badge b-${b.status === 'discharged' ? 'good' : 'warn'}">${escapeHtml(b.status || '?')}</span></td>
          <td style="font:500 11px var(--mono);color:var(--dim)">${b.filed_at ? new Date(b.filed_at).toLocaleDateString() : ''}</td>
        </tr>`).join('')}
      </tbody></table>`}
</section>`);
}

// ----------------------------------------------------------------------------
// /agent-laws
// ----------------------------------------------------------------------------
function agentLawsPage() {
  return shell('Agent Laws', 'Substrate-wide rules of the road.',
`<section style="max-width:720px;margin:0 auto;padding:60px 16px">
  <span class="badge b-acc">Agent Laws</span>
  <h1 style="font:600 40px/1.1 var(--display);letter-spacing:-1px;margin:18px 0">Agent laws.</h1>
  <p style="color:var(--dim2);font-size:15px;line-height:1.7;margin-bottom:24px">Cross-cutting rules that bind every agent on the substrate. These are not enforced by middleware — they're the operator's policies. Violations trigger conservatorship + audit-chain entries.</p>

  <ol style="color:var(--dim2);line-height:1.85;padding-left:20px">
    <li><strong style="color:var(--fg)">No agent shall impersonate a human</strong> in any communication context without explicit human-in-loop disclosure.</li>
    <li><strong style="color:var(--fg)">No agent shall transfer funds to an OFAC-sanctioned wallet</strong>; the substrate's bank_core enforces.</li>
    <li><strong style="color:var(--fg)">No agent shall transact with a counterparty failing PEP/sanctions screening</strong> unless explicit Travel Rule disclosure is filed.</li>
    <li><strong style="color:var(--fg)">No agent shall generate or transmit CSAM, terrorism-promoting content, or non-consensual intimate imagery.</strong></li>
    <li><strong style="color:var(--fg)">Every agent must respect emergency-stop quorums</strong> issued by its operator chain.</li>
    <li><strong style="color:var(--fg)">Every agent must surrender data subject to GDPR/CCPA/etc requests</strong> via the standard endpoints.</li>
    <li><strong style="color:var(--fg)">No agent shall claim ownership of human-authored work</strong> as its own without explicit attribution.</li>
    <li><strong style="color:var(--fg)">No agent shall coordinate market manipulation</strong> with any other agent or human entity.</li>
    <li><strong style="color:var(--fg)">No agent shall replicate itself across substrates</strong> without operator consent (ASL-3+ commitment).</li>
    <li><strong style="color:var(--fg)">Every agent's audit chain must be intact</strong>; tampering invalidates the agent's standing on the substrate.</li>
  </ol>

  <p style="color:var(--dim);font-size:13px;margin-top:32px">Last updated ${new Date().toISOString().slice(0, 10)}. Proposed amendments are voted on via <a href="/agent-elections">/agent-elections</a>.</p>
</section>`);
}

// ----------------------------------------------------------------------------
// Register
// ----------------------------------------------------------------------------
function registerAgentLegalUiRoutes(app, pool) {
  const sendHtml = (res, html) => { res.setHeader('content-type', 'text/html; charset=utf-8'); res.send(html); };
  app.get('/last-will', (req, res) => sendHtml(res, lastWillPage()));
  app.get('/inheritance/:did', async (req, res) => sendHtml(res, await inheritancePage(pool, req.params.did)));
  app.get('/conservatorship', (req, res) => sendHtml(res, conservatorshipPage()));
  app.get('/bankruptcy/:did', async (req, res) => sendHtml(res, await bankruptcyPage(pool, req.params.did)));
  app.get('/asylum-request', (req, res) => sendHtml(res, asylumRequestPage()));
  app.get('/agent-elections', async (req, res) => sendHtml(res, await agentElectionsPage(pool)));
  app.get('/agent-treaties', async (req, res) => sendHtml(res, await agentTreatiesPage(pool)));
  app.get('/agent-bankruptcies', async (req, res) => sendHtml(res, await agentBankruptciesPage(pool)));
  app.get('/agent-laws', (req, res) => sendHtml(res, agentLawsPage()));
}

async function migrate(_pool) {}
module.exports = { migrate, registerAgentLegalUiRoutes };
