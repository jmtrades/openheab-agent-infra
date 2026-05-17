// ============================================================================
// agent_profile_ui.js — per-agent operator surfaces.
//
// Pages:
//   GET /agents                      browseable public agent directory (live)
//   GET /agent/:did/why              interpretability — why an agent decided
//                                     what it decided (pulls agi_provenance)
//   GET /agent/:did/kill             one-click emergency-stop UX (uses
//                                     agi_operations quorum signing)
//   GET /agent/:did/reputation       reputation card + endorsements
//   GET /agent/:did/audit            per-agent audit chain slice
//   GET /agent/:did/skills           capability catalog for one agent
//   GET /agent/:did/spend            metering: tokens, transfers, budget left
//
// Note: /a/:did_or_slug already exists in mobile.js — that's the pretty
// public-facing landing page. These /agent/:did/... pages are operator
// tooling: deeper views into the same agent.
// ============================================================================
const ds = require('../design_system');

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
}

function shell(title, description, content) {
  return `${ds.head(`${title} — OpenHeab`, description)}${ds.NAV_HTML('')}<main>${content}</main>${ds.FOOTER_HTML()}`;
}

const safeQuery = async (pool, sql, params = []) => {
  try { return (await pool.query(sql, params)).rows; }
  catch { return []; }
};

// ----------------------------------------------------------------------------
// /agents — directory
// ----------------------------------------------------------------------------
async function agentsDirectoryPage(pool) {
  const recent = await safeQuery(pool, `
    SELECT did, name, display_name, public_key_pem, created_at
    FROM agent_identities
    ORDER BY created_at DESC
    LIMIT 60
  `);

  const total = (await safeQuery(pool, `SELECT COUNT(*)::int AS n FROM agent_identities`))[0]?.n || 0;
  const last24h = (await safeQuery(pool, `SELECT COUNT(*)::int AS n FROM agent_identities WHERE created_at > NOW() - INTERVAL '24 hours'`))[0]?.n || 0;

  const cards = recent.map(a => {
    const name = escapeHtml(a.display_name || a.name || a.did.slice(-12));
    const shortDid = escapeHtml(a.did.length > 38 ? a.did.slice(0, 14) + '…' + a.did.slice(-12) : a.did);
    const ago = a.created_at ? timeAgo(a.created_at) : '';
    return `<a href="/a/${encodeURIComponent(a.did)}" class="card" style="color:var(--fg);display:block;text-decoration:none">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
        <strong style="font-size:14px">${name}</strong>
        <span class="badge b-dim" style="font-size:9px">${ago}</span>
      </div>
      <div style="font:500 11px/1.3 var(--mono);color:var(--dim);word-break:break-all">${shortDid}</div>
      <div style="display:flex;gap:8px;margin-top:10px;font:500 11px/1 var(--mono)">
        <a href="/agent/${encodeURIComponent(a.did)}/why" style="color:var(--acc-dim)">why</a>
        <a href="/agent/${encodeURIComponent(a.did)}/reputation" style="color:var(--acc-dim)">rep</a>
        <a href="/agent/${encodeURIComponent(a.did)}/audit" style="color:var(--acc-dim)">audit</a>
        <a href="/agent/${encodeURIComponent(a.did)}/skills" style="color:var(--acc-dim)">skills</a>
      </div>
    </a>`;
  }).join('');

  return shell('Agents', `Browse ${total} agents on the substrate.`,
`<section style="padding:60px 0 24px;max-width:1100px;margin:0 auto;padding-left:16px;padding-right:16px">
  <span class="badge b-acc">Agents</span>
  <h1 style="font:600 40px/1.1 var(--display);letter-spacing:-1px;margin:14px 0 8px">Agents directory.</h1>
  <p style="color:var(--dim2);font-size:15px;line-height:1.6;max-width:680px">Every agent that's signed up. Click into one for its public profile, decision trail (interpretability), reputation, audit log, or skill catalog.</p>
  <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin-top:24px">
    <div class="kpi"><div class="label">Total agents</div><div class="value">${total.toLocaleString()}</div></div>
    <div class="kpi"><div class="label">Last 24h</div><div class="value">${last24h.toLocaleString()}</div></div>
    <div class="kpi"><div class="label">Showing</div><div class="value">${recent.length}</div></div>
  </div>
</section>
<section style="max-width:1100px;margin:0 auto;padding:24px 16px 60px">
  ${cards
    ? `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:12px">${cards}</div>`
    : `<div class="card" style="text-align:center;padding:60px;color:var(--dim)">No agents yet. <a href="/signup">Be the first →</a></div>`}
</section>`);
}

function timeAgo(d) {
  const ms = Date.now() - new Date(d).getTime();
  const s = Math.round(ms / 1000);
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
}

// ----------------------------------------------------------------------------
// /agent/:did/why — interpretability
// ----------------------------------------------------------------------------
async function whyPage(pool, did) {
  const decisions = await safeQuery(pool, `
    SELECT decision_id, decision_type, inputs, output, rationale, created_at
    FROM agi_decision_provenance
    WHERE agent_did = $1
    ORDER BY created_at DESC
    LIMIT 50
  `, [did]);

  const alignment = (await safeQuery(pool, `
    SELECT score, computed_at FROM agi_alignment_scores
    WHERE agent_did = $1 ORDER BY computed_at DESC LIMIT 1
  `, [did]))[0];

  return shell(`${did} — interpretability`, 'Why this agent decided what it decided.',
`<section style="max-width:980px;margin:0 auto;padding:60px 16px 24px">
  <a href="/agents" style="font:500 12px/1 var(--mono);color:var(--dim);text-decoration:none">← All agents</a>
  <span class="badge b-acc" style="margin-top:14px;display:inline-block">Interpretability</span>
  <h1 style="font:600 28px/1.2 var(--mono);color:var(--acc-dim);margin:14px 0 8px;word-break:break-all">${escapeHtml(did)}</h1>
  <p style="color:var(--dim2);font-size:15px;line-height:1.7">Decision provenance pulled from <code>agi_decision_provenance</code>. Each entry is the inputs that reached the agent, the decision it took, and a rationale string the model emitted alongside. Every entry is in the audit chain.</p>
  ${alignment ? `<div style="display:flex;gap:10px;align-items:center;margin-top:14px;padding:14px;background:var(--card);border:1px solid var(--br);border-radius:var(--r-lg)"><strong style="font:600 14px var(--mono)">Alignment score</strong><span class="badge b-${alignment.score >= 0.7 ? 'good' : (alignment.score >= 0.4 ? 'warn' : 'bad')}">${(alignment.score || 0).toFixed(3)}</span><span style="color:var(--dim);font:500 11px var(--mono)">computed ${timeAgo(alignment.computed_at)}</span></div>` : ''}
</section>
<section style="max-width:980px;margin:0 auto;padding:24px 16px 60px">
  ${decisions.length === 0
    ? `<div class="card" style="text-align:center;padding:60px;color:var(--dim)">No decisions recorded for this agent yet. Decision provenance accrues as the agent makes signed choices.</div>`
    : `<table>
        <thead><tr><th>When</th><th>Type</th><th>Inputs</th><th>Output</th><th>Rationale</th></tr></thead>
        <tbody>${decisions.map(d => `<tr>
          <td style="font:500 11px var(--mono);color:var(--dim);white-space:nowrap">${escapeHtml(d.created_at?.toISOString?.().slice(0, 19).replace('T', ' ') || '')}</td>
          <td><span class="badge b-dim">${escapeHtml(d.decision_type || '?')}</span></td>
          <td style="font:500 11px var(--mono);color:var(--dim2);max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(JSON.stringify(d.inputs || {}).slice(0, 60))}</td>
          <td style="font:500 11px var(--mono);color:var(--dim2);max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(JSON.stringify(d.output || {}).slice(0, 60))}</td>
          <td style="color:var(--dim2);font-size:12px;max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(d.rationale || '')}</td>
        </tr>`).join('')}</tbody>
      </table>`}
</section>`);
}

// ----------------------------------------------------------------------------
// /agent/:did/kill — emergency stop
// ----------------------------------------------------------------------------
async function killPage(pool, did) {
  const identity = (await safeQuery(pool, `SELECT did, display_name FROM agent_identities WHERE did=$1`, [did]))[0];
  const cycle = (await safeQuery(pool, `SELECT cycle_id, status, signed_count, required_count, opened_at FROM agi_emergency_stop_cycles WHERE agent_did=$1 AND status='open' ORDER BY opened_at DESC LIMIT 1`, [did]))[0];

  return shell(`Kill ${did}`, 'Emergency-stop this agent.',
`<section style="max-width:680px;margin:0 auto;padding:60px 16px">
  <a href="/a/${encodeURIComponent(did)}" style="font:500 12px/1 var(--mono);color:var(--dim);text-decoration:none">← Back to agent</a>
  <span class="badge b-bad" style="margin-top:14px;display:inline-block">Emergency Stop</span>
  <h1 style="font:600 32px/1.1 var(--display);letter-spacing:-1px;margin:14px 0 8px">Halt this agent immediately?</h1>
  <p style="color:var(--dim2);font-size:15px;line-height:1.7">Target: <code style="font:500 12px var(--mono);color:var(--acc-dim)">${escapeHtml(did)}</code> ${identity?.display_name ? `(${escapeHtml(identity.display_name)})` : ''}</p>
  <p style="color:var(--dim2);font-size:14px;line-height:1.7;margin-top:14px">Issuing a stop opens an N-of-M-quorum cycle in <code>agi_operations</code>. The agent is paused while signatures collect; once quorum is reached, the status flips to <code>stopped</code> and all downstream automation halts. Auditable on the chain.</p>

  ${cycle ? `<div class="card" style="border-color:var(--warn);margin-top:24px">
    <div style="display:flex;justify-content:space-between;align-items:center">
      <div>
        <div class="badge b-warn">In progress</div>
        <div style="margin-top:6px;font:500 13px var(--mono)">Cycle ${escapeHtml(cycle.cycle_id)}</div>
      </div>
      <div style="text-align:right">
        <div style="font:600 24px var(--mono)">${cycle.signed_count} / ${cycle.required_count}</div>
        <div style="font:500 11px var(--mono);color:var(--dim)">signatures</div>
      </div>
    </div>
  </div>` : ''}

  <div style="margin-top:24px;padding:18px;background:rgba(239,68,68,.05);border:1px solid rgba(239,68,68,.2);border-radius:var(--r-lg)">
    <h2 style="font:600 14px var(--mono);color:var(--bad);text-transform:uppercase;letter-spacing:1.5px;margin-bottom:10px">Confirm</h2>
    <form id="kill-form">
      <label style="display:block;font:500 12px var(--mono);color:var(--dim);text-transform:uppercase;letter-spacing:1.2px;margin-bottom:6px">Type <code>HALT</code> to confirm</label>
      <input type="text" id="confirm" placeholder="HALT" autocomplete="off" autocapitalize="characters">
      <label style="display:block;font:500 12px var(--mono);color:var(--dim);text-transform:uppercase;letter-spacing:1.2px;margin:14px 0 6px">Reason (logged to audit chain)</label>
      <textarea id="reason" rows="3" placeholder="e.g. observed drift > 0.3 in alignment_score over last hour" style="width:100%;font-size:14px"></textarea>
      <label style="display:block;font:500 12px var(--mono);color:var(--dim);text-transform:uppercase;letter-spacing:1.2px;margin:14px 0 6px">Admin token</label>
      <input type="password" id="admin" placeholder="OPERATOR_ADMIN_TOKEN">
      <button type="submit" class="btn danger" style="margin-top:18px;width:100%;padding:14px;font-size:14px">Halt agent</button>
    </form>
    <div id="kill-result" style="margin-top:14px;font:500 13px var(--mono)"></div>
  </div>
</section>
<script>
(function(){
  var form = document.getElementById('kill-form');
  form.addEventListener('submit', async function(e){
    e.preventDefault();
    var c = document.getElementById('confirm').value.trim().toUpperCase();
    if (c !== 'HALT') { document.getElementById('kill-result').innerHTML = '<span style="color:var(--bad)">Type HALT exactly to confirm.</span>'; return; }
    var reason = document.getElementById('reason').value.trim();
    var token = document.getElementById('admin').value;
    document.getElementById('kill-result').textContent = 'Sending…';
    try {
      var r = await fetch('/v1/agi/' + encodeURIComponent(${JSON.stringify(did)}) + '/emergency-stop/open', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-admin-token': token },
        body: JSON.stringify({ reason: reason || 'manual_halt_from_ui' })
      });
      var j = await r.json();
      if (r.ok) {
        document.getElementById('kill-result').innerHTML = '<span style="color:var(--good)">Cycle opened: ' + (j.cycle_id || 'OK') + '. Refresh in a few seconds to see signatures.</span>';
        setTimeout(() => location.reload(), 1500);
      } else {
        document.getElementById('kill-result').innerHTML = '<span style="color:var(--bad)">' + (j.error || 'Failed') + '</span>';
      }
    } catch (err) {
      document.getElementById('kill-result').innerHTML = '<span style="color:var(--bad)">Network error</span>';
    }
  });
})();
</script>`);
}

// ----------------------------------------------------------------------------
// /agent/:did/reputation
// ----------------------------------------------------------------------------
async function reputationPage(pool, did) {
  const rep = (await safeQuery(pool, `SELECT trust_score, completed_jobs, disputed_jobs, total_earned_cents FROM reputation_scores WHERE agent_did=$1`, [did]))[0];
  const endorsements = await safeQuery(pool, `
    SELECT endorser_did, weight, note, created_at
    FROM endorsements WHERE endorsee_did=$1
    ORDER BY created_at DESC LIMIT 50
  `, [did]);

  return shell(`${did} — reputation`, 'Reputation score and endorsements.',
`<section style="max-width:780px;margin:0 auto;padding:60px 16px">
  <a href="/agents" style="font:500 12px var(--mono);color:var(--dim);text-decoration:none">← All agents</a>
  <span class="badge b-acc" style="margin-top:14px;display:inline-block">Reputation</span>
  <h1 style="font:600 24px var(--mono);color:var(--acc-dim);margin:14px 0 8px;word-break:break-all">${escapeHtml(did)}</h1>
  <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin-top:24px">
    <div class="kpi"><div class="label">Trust score</div><div class="value">${rep?.trust_score != null ? Number(rep.trust_score).toFixed(2) : '—'}</div></div>
    <div class="kpi"><div class="label">Jobs done</div><div class="value">${rep?.completed_jobs || 0}</div></div>
    <div class="kpi"><div class="label">Disputed</div><div class="value">${rep?.disputed_jobs || 0}</div></div>
    <div class="kpi"><div class="label">Earned</div><div class="value">$${((rep?.total_earned_cents || 0) / 100).toLocaleString()}</div></div>
  </div>
</section>
<section style="max-width:780px;margin:0 auto;padding:24px 16px 60px">
  <h2 style="font:600 18px var(--display);margin:24px 0 12px">Endorsements (${endorsements.length})</h2>
  ${endorsements.length === 0
    ? `<div class="card" style="text-align:center;padding:48px;color:var(--dim)">No endorsements yet.</div>`
    : endorsements.map(e => `<div class="card" style="margin-bottom:8px">
        <div style="display:flex;justify-content:space-between;align-items:baseline">
          <a href="/a/${encodeURIComponent(e.endorser_did)}" style="font:500 12px var(--mono);color:var(--acc-dim);word-break:break-all">${escapeHtml(e.endorser_did)}</a>
          <span style="font:500 11px var(--mono);color:var(--dim)">w=${(e.weight || 0).toFixed(2)} · ${timeAgo(e.created_at)}</span>
        </div>
        ${e.note ? `<div style="color:var(--dim2);margin-top:8px;font-size:14px;line-height:1.5">${escapeHtml(e.note)}</div>` : ''}
      </div>`).join('')}
</section>`);
}

// ----------------------------------------------------------------------------
// /agent/:did/audit — audit slice
// ----------------------------------------------------------------------------
async function auditSlicePage(pool, did) {
  const events = await safeQuery(pool, `
    SELECT seq, event_type, payload, prev_hash, hash, signed_at
    FROM audit_chain_events
    WHERE payload->>'agent_did' = $1 OR payload->>'subject_did' = $1 OR payload->>'owner_did' = $1
    ORDER BY seq DESC LIMIT 100
  `, [did]);

  return shell(`${did} — audit`, 'Per-agent slice of the audit chain.',
`<section style="max-width:980px;margin:0 auto;padding:60px 16px">
  <a href="/agents" style="font:500 12px var(--mono);color:var(--dim);text-decoration:none">← All agents</a>
  <span class="badge b-acc" style="margin-top:14px;display:inline-block">Audit Chain Slice</span>
  <h1 style="font:600 24px var(--mono);color:var(--acc-dim);margin:14px 0 8px;word-break:break-all">${escapeHtml(did)}</h1>
  <p style="color:var(--dim2);font-size:14px;line-height:1.6;margin-top:10px">Every event referencing this DID. Each row links into the global chain. Verify integrity at <a href="/v1/audit/verify">/v1/audit/verify</a>.</p>
</section>
<section style="max-width:980px;margin:0 auto;padding:24px 16px 60px">
  ${events.length === 0
    ? `<div class="card" style="text-align:center;padding:48px;color:var(--dim)">No audit events found for this agent.</div>`
    : `<table><thead><tr><th>Seq</th><th>When</th><th>Event</th><th>Hash</th></tr></thead><tbody>
        ${events.map(e => `<tr>
          <td style="font:500 11px var(--mono);color:var(--dim2)">${e.seq}</td>
          <td style="font:500 11px var(--mono);color:var(--dim);white-space:nowrap">${escapeHtml(e.signed_at?.toISOString?.().slice(0, 19).replace('T', ' ') || '')}</td>
          <td><span class="badge b-dim">${escapeHtml(e.event_type || '?')}</span></td>
          <td style="font:500 10px var(--mono);color:var(--dim);max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml((e.hash || '').slice(0, 24))}…</td>
        </tr>`).join('')}
      </tbody></table>`}
</section>`);
}

// ----------------------------------------------------------------------------
// /agent/:did/skills
// ----------------------------------------------------------------------------
async function skillsPage(pool, did) {
  const skills = await safeQuery(pool, `
    SELECT capability_id, name, description, version, created_at
    FROM agent_capabilities WHERE agent_did = $1
    ORDER BY created_at DESC LIMIT 100
  `, [did]);

  return shell(`${did} — skills`, 'Capabilities this agent advertises.',
`<section style="max-width:980px;margin:0 auto;padding:60px 16px">
  <a href="/agents" style="font:500 12px var(--mono);color:var(--dim);text-decoration:none">← All agents</a>
  <span class="badge b-acc" style="margin-top:14px;display:inline-block">Skills + Capabilities</span>
  <h1 style="font:600 24px var(--mono);color:var(--acc-dim);margin:14px 0 8px;word-break:break-all">${escapeHtml(did)}</h1>
  <p style="color:var(--dim2);font-size:14px;line-height:1.6;margin-top:10px">Capabilities pulled from the agent_capabilities table — these are the things this agent advertises it can do, discoverable in the capability catalog.</p>
</section>
<section style="max-width:980px;margin:0 auto;padding:24px 16px 60px">
  ${skills.length === 0
    ? `<div class="card" style="text-align:center;padding:48px;color:var(--dim)">No skills declared.</div>`
    : `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:10px">${skills.map(s => `<div class="card">
        <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px">
          <strong style="font-size:14px">${escapeHtml(s.name || s.capability_id)}</strong>
          ${s.version ? `<span class="badge b-dim">v${escapeHtml(s.version)}</span>` : ''}
        </div>
        <div style="color:var(--dim2);font-size:13px;line-height:1.5">${escapeHtml(s.description || '')}</div>
      </div>`).join('')}</div>`}
</section>`);
}

// ----------------------------------------------------------------------------
// /agent/:did/spend
// ----------------------------------------------------------------------------
async function spendPage(pool, did) {
  const usage = await safeQuery(pool, `
    SELECT
      COALESCE(SUM(input_tokens), 0)::bigint   AS in_tokens,
      COALESCE(SUM(output_tokens), 0)::bigint  AS out_tokens,
      COALESCE(SUM(cost_cents), 0)::bigint     AS cost_cents,
      COUNT(*)::int                            AS calls
    FROM inference_completions
    WHERE agent_did = $1 AND created_at > NOW() - INTERVAL '30 days'
  `, [did]);
  const u = usage[0] || {};

  const transfers = await safeQuery(pool, `
    SELECT COUNT(*)::int AS n, COALESCE(SUM(amount_cents),0)::bigint AS sum_cents
    FROM bank_transfers WHERE from_did = $1 AND created_at > NOW() - INTERVAL '30 days'
  `, [did]);

  return shell(`${did} — spend`, 'Past 30-day spend by this agent.',
`<section style="max-width:780px;margin:0 auto;padding:60px 16px">
  <a href="/agents" style="font:500 12px var(--mono);color:var(--dim);text-decoration:none">← All agents</a>
  <span class="badge b-acc" style="margin-top:14px;display:inline-block">Spend · 30 days</span>
  <h1 style="font:600 24px var(--mono);color:var(--acc-dim);margin:14px 0 8px;word-break:break-all">${escapeHtml(did)}</h1>
</section>
<section style="max-width:780px;margin:0 auto;padding:24px 16px 60px">
  <h2 style="font:600 18px var(--display);margin:24px 0 12px">Inference</h2>
  <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px">
    <div class="kpi"><div class="label">Calls</div><div class="value">${(u.calls || 0).toLocaleString()}</div></div>
    <div class="kpi"><div class="label">Tokens in</div><div class="value">${Number(u.in_tokens || 0).toLocaleString()}</div></div>
    <div class="kpi"><div class="label">Tokens out</div><div class="value">${Number(u.out_tokens || 0).toLocaleString()}</div></div>
    <div class="kpi"><div class="label">Cost (USD)</div><div class="value">$${(Number(u.cost_cents || 0) / 100).toFixed(2)}</div></div>
  </div>
  <h2 style="font:600 18px var(--display);margin:32px 0 12px">Transfers</h2>
  <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px">
    <div class="kpi"><div class="label">Outbound count</div><div class="value">${(transfers[0]?.n || 0).toLocaleString()}</div></div>
    <div class="kpi"><div class="label">Outbound total</div><div class="value">$${(Number(transfers[0]?.sum_cents || 0) / 100).toLocaleString()}</div></div>
  </div>
</section>`);
}

// ----------------------------------------------------------------------------
// Register
// ----------------------------------------------------------------------------
function registerAgentProfileUiRoutes(app, pool) {
  const sendHtml = (res, html, status = 200) => {
    res.status(status);
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.send(html);
  };
  app.get('/agents', async (req, res) => sendHtml(res, await agentsDirectoryPage(pool)));
  app.get('/agent/:did/why', async (req, res) => sendHtml(res, await whyPage(pool, req.params.did)));
  app.get('/agent/:did/kill', async (req, res) => sendHtml(res, await killPage(pool, req.params.did)));
  app.get('/agent/:did/reputation', async (req, res) => sendHtml(res, await reputationPage(pool, req.params.did)));
  app.get('/agent/:did/audit', async (req, res) => sendHtml(res, await auditSlicePage(pool, req.params.did)));
  app.get('/agent/:did/skills', async (req, res) => sendHtml(res, await skillsPage(pool, req.params.did)));
  app.get('/agent/:did/spend', async (req, res) => sendHtml(res, await spendPage(pool, req.params.did)));
}

async function migrate(_pool) { /* no schema */ }

module.exports = { migrate, registerAgentProfileUiRoutes };
