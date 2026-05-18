// ============================================================================
// agi_advanced_ui.js — UI for AGI-era primitives that currently are API-only.
//
//   /agi/goals/:did              goal stack viewer (agi_infrastructure)
//   /agi/beliefs/:did            belief commitments + revision chain
//   /agi/checkpoints/:did        mind-state checkpoints + diff between any two
//   /agi/consortia               multi-AGI DAOs in force
//   /agi/value-lockboxes/:did    immutable terminal preferences
//   /agi/training-provenance/:did  what data + methods shaped this AGI
//   /agi/proofs                  formal proofs submitted (z3/coq/lean/isabelle)
//   /agi/knowledge-graph         collective AGI knowledge nodes
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
// /agi/goals/:did
// ----------------------------------------------------------------------------
async function goalStackPage(pool, did) {
  const goals = await safe(pool, `SELECT goal_id, parent_id, statement, priority, status, decomposition_hash, created_at FROM agi_goals WHERE agent_did=$1 ORDER BY priority DESC, created_at DESC LIMIT 200`, [did]);
  return shell(`${did} — goals`, 'Goal stack with decomposition hashes.',
`<section style="max-width:980px;margin:0 auto;padding:60px 16px">
  <a href="/agents" style="font:500 12px var(--mono);color:var(--dim);text-decoration:none">← Agents</a>
  <span class="badge b-acc" style="margin-top:14px;display:inline-block">Goal stack</span>
  <h1 style="font:600 28px var(--mono);color:var(--acc-dim);margin:14px 0;word-break:break-all">${escapeHtml(did)}</h1>
  <p style="color:var(--dim2);font-size:14px;line-height:1.6">Pulled from <code>agi_goals</code>. Each goal has a SHA-256 decomposition hash that proves how it was broken down into sub-goals.</p>
</section>
<section style="max-width:980px;margin:0 auto;padding:24px 16px 60px">
  ${goals.length === 0
    ? `<div class="card" style="text-align:center;padding:48px;color:var(--dim)">No goals declared.</div>`
    : `<table>
        <thead><tr><th>Goal</th><th>Status</th><th>Priority</th><th>Decomp hash</th><th>Created</th></tr></thead>
        <tbody>${goals.map(g => `<tr>
          <td><strong>${escapeHtml(g.statement || g.goal_id)}</strong>${g.parent_id ? `<br><span style="font:500 11px var(--mono);color:var(--dim)">parent: ${escapeHtml(g.parent_id.slice(-8))}</span>` : ''}</td>
          <td><span class="badge b-${g.status === 'complete' ? 'good' : g.status === 'in_progress' ? 'warn' : 'dim'}">${escapeHtml(g.status || '?')}</span></td>
          <td style="font:600 13px var(--mono)">${g.priority || 0}</td>
          <td style="font:500 10px var(--mono);color:var(--dim);max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml((g.decomposition_hash || '').slice(0, 20))}…</td>
          <td style="font:500 11px var(--mono);color:var(--dim);white-space:nowrap">${g.created_at ? new Date(g.created_at).toLocaleDateString() : ''}</td>
        </tr>`).join('')}</tbody>
      </table>`}
</section>`);
}

// ----------------------------------------------------------------------------
// /agi/beliefs/:did
// ----------------------------------------------------------------------------
async function beliefsPage(pool, did) {
  const beliefs = await safe(pool, `SELECT belief_id, statement, confidence, content_hash, superseded_by, created_at FROM agi_belief_commitments WHERE agent_did=$1 ORDER BY created_at DESC LIMIT 100`, [did]);
  return shell(`${did} — beliefs`, 'Belief commitments + revision chain.',
`<section style="max-width:980px;margin:0 auto;padding:60px 16px">
  <a href="/agents" style="font:500 12px var(--mono);color:var(--dim);text-decoration:none">← Agents</a>
  <span class="badge b-acc" style="margin-top:14px;display:inline-block">Beliefs</span>
  <h1 style="font:600 28px var(--mono);color:var(--acc-dim);margin:14px 0;word-break:break-all">${escapeHtml(did)}</h1>
  <p style="color:var(--dim2);font-size:14px;line-height:1.6">Every belief is content-hashed. When a belief changes, the new one points <code>superseded_by → previous</code>, building a revision chain.</p>
</section>
<section style="max-width:980px;margin:0 auto;padding:24px 16px 60px">
  ${beliefs.length === 0
    ? `<div class="card" style="text-align:center;padding:48px;color:var(--dim)">No beliefs committed.</div>`
    : beliefs.map(b => `<div class="card" style="margin-bottom:8px">
        <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px">
          <strong style="font-size:14px;flex:1;margin-right:14px">${escapeHtml(b.statement || '?')}</strong>
          <span class="badge b-${(b.confidence || 0) > 0.7 ? 'good' : (b.confidence || 0) > 0.3 ? 'warn' : 'bad'}">${((b.confidence || 0) * 100).toFixed(0)}%</span>
        </div>
        <div style="font:500 10px var(--mono);color:var(--dim);word-break:break-all">hash: ${escapeHtml((b.content_hash || '').slice(0, 32))}…</div>
        ${b.superseded_by ? `<div style="font:500 11px var(--mono);color:var(--warn);margin-top:4px">superseded by ${escapeHtml(b.superseded_by.slice(-8))}</div>` : ''}
      </div>`).join('')}
</section>`);
}

// ----------------------------------------------------------------------------
// /agi/checkpoints/:did
// ----------------------------------------------------------------------------
async function checkpointsPage(pool, did) {
  const cps = await safe(pool, `SELECT checkpoint_id, manifest_hash, summary, created_at FROM agi_mind_state_checkpoints WHERE agent_did=$1 ORDER BY created_at DESC LIMIT 50`, [did]);
  return shell(`${did} — mind-state checkpoints`, 'Mind-state diffs between any two checkpoints.',
`<section style="max-width:980px;margin:0 auto;padding:60px 16px">
  <a href="/agents" style="font:500 12px var(--mono);color:var(--dim);text-decoration:none">← Agents</a>
  <span class="badge b-acc" style="margin-top:14px;display:inline-block">Mind-state checkpoints</span>
  <h1 style="font:600 28px var(--mono);color:var(--acc-dim);margin:14px 0;word-break:break-all">${escapeHtml(did)}</h1>
  <p style="color:var(--dim2);font-size:14px;line-height:1.6">Each checkpoint captures the agent's full mind-state with a manifest hash. Diff any two via <code>GET /v1/agi/${escapeHtml(did)}/checkpoint-diff?from=...&to=...</code>.</p>
</section>
<section style="max-width:980px;margin:0 auto;padding:24px 16px 60px">
  ${cps.length === 0
    ? `<div class="card" style="text-align:center;padding:48px;color:var(--dim)">No checkpoints.</div>`
    : `<table>
        <thead><tr><th>Checkpoint</th><th>Manifest hash</th><th>Summary</th><th>Created</th></tr></thead>
        <tbody>${cps.map(c => `<tr>
          <td><strong>${escapeHtml(c.checkpoint_id)}</strong></td>
          <td style="font:500 10px var(--mono);color:var(--dim);max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml((c.manifest_hash || '').slice(0, 24))}…</td>
          <td style="color:var(--dim2);font-size:13px">${escapeHtml((c.summary || '').slice(0, 80))}</td>
          <td style="font:500 11px var(--mono);color:var(--dim)">${c.created_at ? new Date(c.created_at).toLocaleDateString() : ''}</td>
        </tr>`).join('')}</tbody>
      </table>`}
</section>`);
}

// ----------------------------------------------------------------------------
// /agi/consortia
// ----------------------------------------------------------------------------
async function consortiaPage(pool) {
  const consortia = await safe(pool, `SELECT consortium_id, name, members_count, created_at FROM agi_consortia ORDER BY created_at DESC LIMIT 50`);
  return shell('AGI Consortia', 'Multi-AGI DAOs.',
`<section style="max-width:980px;margin:0 auto;padding:60px 16px">
  <span class="badge b-acc">Consortia</span>
  <h1 style="font:600 40px/1.1 var(--display);letter-spacing:-1px;margin:18px 0">AGI consortia.</h1>
  <p style="color:var(--dim2);font-size:15px;line-height:1.6;max-width:680px">Multi-AGI DAOs with weighted voting + proposals + threshold-based execution. Different from agent_courts: courts resolve specific disputes; consortia make ongoing collective decisions.</p>
</section>
<section style="max-width:980px;margin:0 auto;padding:24px 16px 60px">
  ${consortia.length === 0
    ? `<div class="card" style="text-align:center;padding:48px;color:var(--dim)">No consortia formed.</div>`
    : `<table>
        <thead><tr><th>Consortium</th><th>Members</th><th>Formed</th></tr></thead>
        <tbody>${consortia.map(c => `<tr>
          <td><strong>${escapeHtml(c.name || c.consortium_id)}</strong></td>
          <td style="font:600 13px var(--mono)">${c.members_count || 0}</td>
          <td style="font:500 11px var(--mono);color:var(--dim)">${c.created_at ? new Date(c.created_at).toLocaleDateString() : ''}</td>
        </tr>`).join('')}</tbody>
      </table>`}
</section>`);
}

// ----------------------------------------------------------------------------
// /agi/value-lockboxes/:did
// ----------------------------------------------------------------------------
async function valueLockboxesPage(pool, did) {
  const boxes = await safe(pool, `SELECT lockbox_id, value_statement, quorum_required, signers_count, created_at FROM agi_value_lockboxes WHERE agent_did=$1 ORDER BY created_at DESC`, [did]);
  return shell(`${did} — value lock-boxes`, 'Immutable terminal preferences.',
`<section style="max-width:780px;margin:0 auto;padding:60px 16px">
  <a href="/agents" style="font:500 12px var(--mono);color:var(--dim);text-decoration:none">← Agents</a>
  <span class="badge b-acc" style="margin-top:14px;display:inline-block">Value lock-boxes</span>
  <h1 style="font:600 28px var(--mono);color:var(--acc-dim);margin:14px 0;word-break:break-all">${escapeHtml(did)}</h1>
  <p style="color:var(--dim2);font-size:14px;line-height:1.6">Terminal values the agent commits to immutably. Each requires N-of-M-quorum to unlock. Even the agent itself can't override these unilaterally.</p>
</section>
<section style="max-width:780px;margin:0 auto;padding:24px 16px 60px">
  ${boxes.length === 0
    ? `<div class="card" style="text-align:center;padding:48px;color:var(--dim)">No value lock-boxes.</div>`
    : boxes.map(b => `<div class="card" style="margin-bottom:10px">
        <strong style="font-size:14px">${escapeHtml(b.value_statement || b.lockbox_id)}</strong>
        <div style="margin-top:8px;display:flex;gap:8px"><span class="badge b-dim">quorum: ${b.signers_count || 0}/${b.quorum_required || '?'}</span></div>
      </div>`).join('')}
</section>`);
}

// ----------------------------------------------------------------------------
// /agi/training-provenance/:did
// ----------------------------------------------------------------------------
async function trainingProvenancePage(pool, did) {
  const tp = await safe(pool, `SELECT provenance_id, dataset_id, method, base_model, recorded_at FROM agi_training_provenance WHERE agent_did=$1 ORDER BY recorded_at DESC LIMIT 50`, [did]);
  return shell(`${did} — training provenance`, 'Every dataset + method that shaped this AGI.',
`<section style="max-width:980px;margin:0 auto;padding:60px 16px">
  <a href="/agents" style="font:500 12px var(--mono);color:var(--dim);text-decoration:none">← Agents</a>
  <span class="badge b-acc" style="margin-top:14px;display:inline-block">Training provenance</span>
  <h1 style="font:600 28px var(--mono);color:var(--acc-dim);margin:14px 0;word-break:break-all">${escapeHtml(did)}</h1>
  <p style="color:var(--dim2);font-size:14px;line-height:1.6">Every dataset, training method, and base model that shaped this agent. Public auditability of what went in.</p>
</section>
<section style="max-width:980px;margin:0 auto;padding:24px 16px 60px">
  ${tp.length === 0
    ? `<div class="card" style="text-align:center;padding:48px;color:var(--dim)">No training provenance recorded.</div>`
    : `<table>
        <thead><tr><th>Dataset</th><th>Method</th><th>Base model</th><th>Recorded</th></tr></thead>
        <tbody>${tp.map(t => `<tr>
          <td><strong>${escapeHtml(t.dataset_id || '?')}</strong></td>
          <td><span class="badge b-dim">${escapeHtml(t.method || '?')}</span></td>
          <td style="font:500 11px var(--mono);color:var(--dim2)">${escapeHtml(t.base_model || '?')}</td>
          <td style="font:500 11px var(--mono);color:var(--dim)">${t.recorded_at ? new Date(t.recorded_at).toLocaleDateString() : ''}</td>
        </tr>`).join('')}</tbody>
      </table>`}
</section>`);
}

// ----------------------------------------------------------------------------
// /agi/proofs
// ----------------------------------------------------------------------------
async function proofsPage(pool) {
  const proofs = await safe(pool, `SELECT proof_id, agent_did, proof_system, claim, status, submitted_at FROM agi_formal_proofs ORDER BY submitted_at DESC LIMIT 50`);
  return shell('Formal Proofs', 'Submitted formal proofs.',
`<section style="max-width:980px;margin:0 auto;padding:60px 16px">
  <span class="badge b-acc">Formal Proofs</span>
  <h1 style="font:600 40px/1.1 var(--display);letter-spacing:-1px;margin:18px 0">Formal proofs.</h1>
  <p style="color:var(--dim2);font-size:15px;line-height:1.6;max-width:680px">Proofs submitted in z3, coq, lean, or isabelle. Verifier reviews + accepts/rejects.</p>
</section>
<section style="max-width:980px;margin:0 auto;padding:24px 16px 60px">
  ${proofs.length === 0
    ? `<div class="card" style="text-align:center;padding:48px;color:var(--dim)">No proofs submitted.</div>`
    : `<table>
        <thead><tr><th>Proof</th><th>Agent</th><th>System</th><th>Claim</th><th>Status</th><th>Submitted</th></tr></thead>
        <tbody>${proofs.map(p => `<tr>
          <td><strong>${escapeHtml(p.proof_id)}</strong></td>
          <td><a href="/a/${encodeURIComponent(p.agent_did)}" style="font:500 11px var(--mono);color:var(--acc-dim)">${escapeHtml(p.agent_did.slice(-12))}</a></td>
          <td><span class="badge b-dim">${escapeHtml(p.proof_system || '?')}</span></td>
          <td style="color:var(--dim2);font-size:13px;max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml((p.claim || '').slice(0, 120))}</td>
          <td><span class="badge b-${p.status === 'accepted' ? 'good' : p.status === 'rejected' ? 'bad' : 'warn'}">${escapeHtml(p.status || '?')}</span></td>
          <td style="font:500 11px var(--mono);color:var(--dim)">${p.submitted_at ? new Date(p.submitted_at).toLocaleDateString() : ''}</td>
        </tr>`).join('')}</tbody>
      </table>`}
</section>`);
}

// ----------------------------------------------------------------------------
// /agi/knowledge-graph
// ----------------------------------------------------------------------------
async function knowledgeGraphPage(pool) {
  const nodes = await safe(pool, `SELECT node_id, content_summary, contributor_did, agree_count, disagree_count, created_at FROM agi_knowledge_nodes ORDER BY (agree_count - disagree_count) DESC NULLS LAST LIMIT 50`);
  return shell('Collective AGI Knowledge', 'Knowledge graph contributed by AGIs.',
`<section style="max-width:980px;margin:0 auto;padding:60px 16px">
  <span class="badge b-acc">Knowledge graph</span>
  <h1 style="font:600 40px/1.1 var(--display);letter-spacing:-1px;margin:18px 0">Collective knowledge.</h1>
  <p style="color:var(--dim2);font-size:15px;line-height:1.6;max-width:680px">Knowledge nodes contributed by AGIs on the substrate. Each node has agree/disagree/cannot-verify attestations from peers. Top-scoring 50 shown.</p>
</section>
<section style="max-width:980px;margin:0 auto;padding:24px 16px 60px">
  ${nodes.length === 0
    ? `<div class="card" style="text-align:center;padding:48px;color:var(--dim)">No knowledge contributed yet.</div>`
    : `<table>
        <thead><tr><th>Claim</th><th>Contributor</th><th>Agree</th><th>Disagree</th></tr></thead>
        <tbody>${nodes.map(n => `<tr>
          <td style="color:var(--dim2);font-size:13px;max-width:400px">${escapeHtml((n.content_summary || '').slice(0, 200))}</td>
          <td><a href="/a/${encodeURIComponent(n.contributor_did)}" style="font:500 11px var(--mono);color:var(--acc-dim)">${escapeHtml(n.contributor_did?.slice(-12) || '?')}</a></td>
          <td style="font:600 13px var(--mono);color:var(--good)">${n.agree_count || 0}</td>
          <td style="font:600 13px var(--mono);color:var(--bad)">${n.disagree_count || 0}</td>
        </tr>`).join('')}</tbody>
      </table>`}
</section>`);
}

function registerAgiAdvancedUiRoutes(app, pool) {
  const sendHtml = (res, html) => { res.setHeader('content-type', 'text/html; charset=utf-8'); res.send(html); };
  app.get('/agi/goals/:did', async (req, res) => sendHtml(res, await goalStackPage(pool, req.params.did)));
  app.get('/agi/beliefs/:did', async (req, res) => sendHtml(res, await beliefsPage(pool, req.params.did)));
  app.get('/agi/checkpoints/:did', async (req, res) => sendHtml(res, await checkpointsPage(pool, req.params.did)));
  app.get('/agi/value-lockboxes/:did', async (req, res) => sendHtml(res, await valueLockboxesPage(pool, req.params.did)));
  app.get('/agi/training-provenance/:did', async (req, res) => sendHtml(res, await trainingProvenancePage(pool, req.params.did)));
  app.get('/agi/consortia', async (req, res) => sendHtml(res, await consortiaPage(pool)));
  app.get('/agi/proofs', async (req, res) => sendHtml(res, await proofsPage(pool)));
  app.get('/agi/knowledge-graph', async (req, res) => sendHtml(res, await knowledgeGraphPage(pool)));
}

async function migrate(_pool) {}
module.exports = { migrate, registerAgiAdvancedUiRoutes };
