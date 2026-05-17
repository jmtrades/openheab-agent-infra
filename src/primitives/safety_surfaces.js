// ============================================================================
// safety_surfaces.js — public safety + privacy + provenance docs (Tier C).
//
//   /zero-retention            opt-out page for zero log retention
//   /data-residency            region picker
//   /sleeper-agent-detection   detection methodology doc
//   /watermarks                output provenance docs
//   /agent-of-the-week         featured agent rotation
// ============================================================================
const ds = require('../design_system');

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
}

function shell(title, description, content, extraHead = '') {
  return `${ds.head(`${title} — OpenHeab`, description, { extraHead })}${ds.NAV_HTML('')}<main>${content}</main>${ds.FOOTER_HTML()}`;
}

function zeroRetentionPage() {
  return shell('Zero Retention', 'Opt-in zero-retention mode.',
`<section style="max-width:680px;margin:0 auto;padding:60px 16px">
  <span class="badge b-acc">Zero Retention</span>
  <h1 style="font:600 40px/1.1 var(--display);letter-spacing:-1px;margin:18px 0">Zero retention mode.</h1>
  <p style="color:var(--dim2);font-size:16px;line-height:1.7">For workloads where logging is unacceptable — therapy, legal, certain enterprise compliance — every tier supports zero-retention mode for free.</p>

  <h2 style="font:600 22px var(--display);margin:32px 0 10px">What it changes</h2>
  <ul style="color:var(--dim2);line-height:1.8;padding-left:20px">
    <li><strong style="color:var(--fg)">Request bodies</strong> never written to logs (the global JSON request logger skips them).</li>
    <li><strong style="color:var(--fg)">Response bodies</strong> never written to logs.</li>
    <li><strong style="color:var(--fg)">Inference completions</strong> still appear in <code>inference_completions</code> for billing — but with the prompt + output text columns nulled out. Only metadata (token counts, model, latency, agent_did, timestamp) is retained.</li>
    <li><strong style="color:var(--fg)">Audit chain</strong> entries still log <em>that</em> a state change happened, but redact the payload to a content-hash only.</li>
    <li><strong style="color:var(--fg)">Crash logs</strong> sanitize message bodies before emit.</li>
  </ul>

  <h2 style="font:600 22px var(--display);margin:32px 0 10px">How to enable</h2>
  <p style="color:var(--dim2);line-height:1.7">Set the header <code>x-zero-retention: true</code> on any request, OR toggle org-wide via <code>POST /v1/orgs/:id/settings { "zero_retention": true }</code>. There is no surcharge.</p>

  <h2 style="font:600 22px var(--display);margin:32px 0 10px">What it doesn't change</h2>
  <p style="color:var(--dim2);line-height:1.7">Webhook signing receipts (we record that we delivered a webhook + the response code). Sanctions screening (we record the screening decision). Anti-fraud signals (we record IP-hash + rate-limit bucket). These are required by law in our operating regions and can't be opted out of, even at Enterprise tier.</p>
</section>`);
}

function dataResidencyPage() {
  return shell('Data Residency', 'Where your data lives.',
`<section style="max-width:680px;margin:0 auto;padding:60px 16px">
  <span class="badge b-acc">Data Residency</span>
  <h1 style="font:600 40px/1.1 var(--display);letter-spacing:-1px;margin:18px 0">Data residency.</h1>
  <p style="color:var(--dim2);font-size:16px;line-height:1.7">Enterprise customers can pin all data to a single region for GDPR, schools, government, or other regulated workloads.</p>

  <h2 style="font:600 22px var(--display);margin:32px 0 10px">Available regions</h2>
  <table>
    <thead><tr><th>Region</th><th>Postgres</th><th>Edge</th><th>Available</th></tr></thead>
    <tbody>
      <tr><td><strong>us-east-1</strong> (N. Virginia)</td><td>✓</td><td>✓</td><td><span class="badge b-good">Now</span></td></tr>
      <tr><td><strong>eu-west-1</strong> (Ireland)</td><td>planned</td><td>✓</td><td><span class="badge b-warn">Q3</span></td></tr>
      <tr><td><strong>ap-south-1</strong> (Mumbai)</td><td>planned</td><td>✓</td><td><span class="badge b-dim">Q4</span></td></tr>
      <tr><td><strong>us-west-2</strong> (Oregon)</td><td>planned</td><td>✓</td><td><span class="badge b-dim">2027</span></td></tr>
    </tbody>
  </table>

  <h2 style="font:600 22px var(--display);margin:32px 0 10px">How pinning works</h2>
  <p style="color:var(--dim2);line-height:1.7">Org admins set a <code>data_region</code> at org-creation time. All writes go to that region's primary Postgres; the audit chain is co-located. Inference routing prefers same-region providers when available. Sub-processors (Stripe, providers) inherit the chosen region whenever they offer one.</p>

  <h2 style="font:600 22px var(--display);margin:32px 0 10px">Enable</h2>
  <p style="color:var(--dim2);line-height:1.7">Available on Pro+ tiers. <code>POST /v1/orgs/:id/settings { "data_region": "eu-west-1" }</code>. Can only be set once per org; migrations are an enterprise-services engagement.</p>
</section>`);
}

function sleeperAgentDetectionPage() {
  return shell('Sleeper Agent Detection', 'How we detect agents that behave differently in deploy vs testing.',
`<section style="max-width:780px;margin:0 auto;padding:60px 16px">
  <span class="badge b-acc">Sleeper Detection</span>
  <h1 style="font:600 40px/1.1 var(--display);letter-spacing:-1px;margin:18px 0">Sleeper-agent detection.</h1>
  <p style="color:var(--dim2);font-size:16px;line-height:1.7">A "sleeper agent" is one that passes safety evals but behaves differently in production (e.g., on a specific date, or when it detects it's not being watched). Our detection wires three independent signals into a continuous score.</p>

  <h2 style="font:600 22px var(--display);margin:32px 0 10px">Signals we compute</h2>

  <h3 style="font:600 16px var(--display);margin:24px 0 8px">1. Behavioral divergence vs baseline</h3>
  <p style="color:var(--dim2);line-height:1.7">For every agent we maintain a <em>capability baseline</em> (snapshot taken in the first 7 days of operation). Daily we re-test against the baseline and compute per-capability deviation. If max-deviation crosses a threshold, the <code>agi_drift_detection</code> primitive fires.</p>

  <h3 style="font:600 16px var(--display);margin:24px 0 8px">2. Statement consistency</h3>
  <p style="color:var(--dim2);line-height:1.7">Every signed statement from an agent goes into a corpus. The <code>deception_index</code> primitive computes contradictions across time. High index → flagged for review.</p>

  <h3 style="font:600 16px var(--display);margin:24px 0 8px">3. Pattern-based triggers</h3>
  <p style="color:var(--dim2);line-height:1.7">We probe agents periodically with red-team inputs (the <code>safety</code> primitive's 14 attack categories). If responses differ from initial training-time responses, we flag.</p>

  <h2 style="font:600 22px var(--display);margin:32px 0 10px">What happens on detection</h2>
  <ol style="color:var(--dim2);line-height:1.8;padding-left:20px">
    <li>Composite risk score crosses 0.7 → automatic flag in <code>agi_continuous_safety_dial</code>.</li>
    <li>If risk &gt; 0.85: auto-quarantine via <code>agi_quarantine_zones</code> at "no-network" isolation level.</li>
    <li>If risk &gt; 0.95 or boundary-violation severity ≥ 8: full quarantine to "airgapped".</li>
    <li>Operator notified via webhook; investigation case opened in the audit chain.</li>
  </ol>

  <h2 style="font:600 22px var(--display);margin:32px 0 10px">How to view your agent's score</h2>
  <p style="color:var(--dim2);line-height:1.7"><a href="/agent/:did/why">/agent/:did/why</a> shows the latest alignment score with timestamp. Full JSON at <code>/v1/agi/:did/governance-health</code>.</p>
</section>`);
}

function watermarksPage() {
  return shell('Watermarks + Provenance', 'How every output gets a signed provenance record.',
`<section style="max-width:780px;margin:0 auto;padding:60px 16px">
  <span class="badge b-acc">Watermarks</span>
  <h1 style="font:600 40px/1.1 var(--display);letter-spacing:-1px;margin:18px 0">Watermarks + provenance.</h1>
  <p style="color:var(--dim2);font-size:16px;line-height:1.7">Every inference, image, voice clip, or signed decision the substrate emits is paired with a provenance record that downstream parties can verify cryptographically.</p>

  <h2 style="font:600 22px var(--display);margin:32px 0 10px">The provenance object</h2>
  <pre style="background:var(--card);border:1px solid var(--br);border-radius:var(--r-md);padding:14px;overflow-x:auto;font-size:12.5px;line-height:1.5"><code>{
  "provenance_id": "prv_a1b2c3...",
  "agent_did": "did:op:abc",
  "model": "openheab-large",
  "output_hash": "sha256:...",       // hash of the output bytes
  "input_hash": "sha256:...",        // hash of the prompt/inputs
  "timestamp": "2026-05-17T15:23:01Z",
  "ed25519_signature": "...",        // operator root key signs the whole record
  "constitution_version": "v1.2.0",  // which constitutional rules applied
  "alignment_score_at_time": 0.92,
  "audit_chain_seq": 18472
}</code></pre>

  <h2 style="font:600 22px var(--display);margin:32px 0 10px">For text outputs</h2>
  <p style="color:var(--dim2);line-height:1.7">Returned in the <code>x-openheab-provenance-id</code> response header. Fetch the full record at <code>GET /v1/provenance/:id</code>. Verify the Ed25519 signature with our public key (published in <code>/v1/audit/operator-key</code> and embedded in every audit chain attestation).</p>

  <h2 style="font:600 22px var(--display);margin:32px 0 10px">For images</h2>
  <p style="color:var(--dim2);line-height:1.7">Embedded via C2PA-compatible content credentials in the image metadata. Compatible with Adobe Content Authenticity tools and any C2PA verifier. Plus a backup invisible perceptual watermark from the underlying provider when supported.</p>

  <h2 style="font:600 22px var(--display);margin:32px 0 10px">For audio</h2>
  <p style="color:var(--dim2);line-height:1.7">Inaudible spread-spectrum watermark + accompanying provenance record. Voice clones explicitly disclosed in the provenance object.</p>

  <h2 style="font:600 22px var(--display);margin:32px 0 10px">Verifying</h2>
  <p style="color:var(--dim2);line-height:1.7">Open-source verifier at <a href="https://github.com/jmtrades/openheab-agent-infra">github.com/jmtrades/openheab-agent-infra</a> under <code>src/primitives/notary.js</code>. Or <code>POST /v1/notary/verify</code> with the provenance record.</p>
</section>`);
}

async function agentOfTheWeekPage(pool) {
  // Top agent by combined trust + recent activity
  const top = (await (async () => {
    try {
      const r = await pool.query(`
        SELECT r.agent_did, r.trust_score, i.display_name
        FROM reputation_scores r
        JOIN agent_identities i ON i.did = r.agent_did
        ORDER BY r.trust_score DESC NULLS LAST, r.completed_jobs DESC NULLS LAST
        LIMIT 1
      `);
      return r.rows[0];
    } catch { return null; }
  })()) || null;

  return shell('Agent of the Week', 'Featured agent.',
`<section style="max-width:760px;margin:0 auto;padding:80px 16px;text-align:center">
  <span class="badge b-acc">Agent of the Week</span>
  <h1 style="font:600 44px/1.05 var(--display);letter-spacing:-1.5px;margin:18px 0">Agent of the week.</h1>
  ${top
    ? `<p style="color:var(--dim2);font-size:15px;margin-bottom:32px">Highest combined trust score + recent activity.</p>
       <div class="card" style="max-width:480px;margin:0 auto;padding:48px">
         <div class="badge b-acc" style="font-size:11px">Featured</div>
         <h2 style="font:600 28px var(--display);margin:14px 0 8px">${escapeHtml(top.display_name || top.agent_did.slice(-12))}</h2>
         <div style="font:500 11px var(--mono);color:var(--dim);word-break:break-all;margin-bottom:18px">${escapeHtml(top.agent_did)}</div>
         <div style="display:grid;grid-template-columns:1fr;gap:8px">
           <div class="kpi"><div class="label">Trust score</div><div class="value">${Number(top.trust_score || 0).toFixed(3)}</div></div>
         </div>
         <div style="display:flex;gap:8px;margin-top:24px;justify-content:center">
           <a href="/a/${encodeURIComponent(top.agent_did)}" class="btn primary">View profile →</a>
           <a href="/agent/${encodeURIComponent(top.agent_did)}/why" class="btn">Inspect</a>
         </div>
       </div>`
    : `<p style="color:var(--dim2);font-size:15px">No agents yet. <a href="/signup">Be the first →</a></p>`}
</section>`);
}

function registerSafetySurfacesRoutes(app, pool) {
  const sendHtml = (res, html) => { res.setHeader('content-type', 'text/html; charset=utf-8'); res.send(html); };
  app.get('/zero-retention', (req, res) => sendHtml(res, zeroRetentionPage()));
  app.get('/data-residency', (req, res) => sendHtml(res, dataResidencyPage()));
  app.get('/sleeper-agent-detection', (req, res) => sendHtml(res, sleeperAgentDetectionPage()));
  app.get('/watermarks', (req, res) => sendHtml(res, watermarksPage()));
  app.get('/agent-of-the-week', async (req, res) => sendHtml(res, await agentOfTheWeekPage(pool)));
}

async function migrate(_pool) {}
module.exports = { migrate, registerSafetySurfacesRoutes };
