// ============================================================================
// api_console.js — interactive API console (request builder for any endpoint).
//
//   GET /api-console           OpenAPI-driven request builder UI
//   GET /api-console/runs      saved request history (localStorage)
//
// Uses /openapi.json to populate the endpoint picker. User's API key is held
// in localStorage. Sends real requests with their auth.
// ============================================================================
const ds = require('../design_system');

function shell(title, description, content, extraHead = '') {
  return `${ds.head(`${title} — OpenHeab`, description, { extraHead })}${ds.NAV_HTML('')}<main>${content}</main>${ds.FOOTER_HTML()}`;
}

const CONSOLE_CSS = `
.ac-shell{display:grid;grid-template-columns:340px 1fr;gap:16px;max-width:1240px;margin:0 auto;padding:24px 16px;min-height:calc(100vh - 200px)}
@media(max-width:880px){.ac-shell{grid-template-columns:1fr}}
.ac-side{background:var(--card);border:1px solid var(--br);border-radius:var(--r-xl);overflow:hidden;display:flex;flex-direction:column;max-height:calc(100vh - 200px)}
.ac-side input{border-radius:0;border:0;border-bottom:1px solid var(--br);font-family:var(--mono);font-size:13px;padding:12px 14px}
.ac-list{flex:1;overflow-y:auto;font:500 12px var(--mono)}
.ac-list .op{padding:8px 14px;border-bottom:1px solid var(--br);cursor:pointer;display:flex;gap:10px;align-items:center;transition:background var(--mo-fast)}
.ac-list .op:hover{background:var(--card2)}
.ac-list .op.active{background:var(--card2);border-left:2px solid var(--acc)}
.ac-list .op .m{font-weight:700;width:54px;text-align:right;flex-shrink:0;font-size:10px}
.ac-list .m.GET{color:var(--good)}
.ac-list .m.POST{color:var(--acc)}
.ac-list .m.PATCH{color:var(--warn)}
.ac-list .m.PUT{color:var(--warn)}
.ac-list .m.DELETE{color:var(--bad)}
.ac-list .p{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dim2)}
.ac-main{display:flex;flex-direction:column;gap:14px;min-width:0}
.ac-row{display:flex;gap:8px;align-items:center}
.ac-row select{width:100px}
.ac-row .ac-url{flex:1;font-family:var(--mono);font-size:13px}
.ac-row .ac-send{padding:10px 18px;flex-shrink:0}
.ac-tabs{display:flex;gap:2px;border-bottom:1px solid var(--br)}
.ac-tabs button{background:transparent;border:0;color:var(--dim);padding:8px 14px;font:500 12px var(--mono);text-transform:uppercase;letter-spacing:1px;cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-1px}
.ac-tabs button.active{color:var(--acc);border-bottom-color:var(--acc)}
.ac-pane{background:var(--card);border:1px solid var(--br);border-radius:var(--r-xl);padding:0;overflow:hidden}
.ac-pane textarea{border-radius:0;border:0;font-family:var(--mono);font-size:12.5px;min-height:200px;padding:14px;resize:vertical}
.ac-resp{background:var(--card);border:1px solid var(--br);border-radius:var(--r-xl);padding:14px;font-family:var(--mono);font-size:12.5px;overflow-x:auto;max-height:50vh;overflow-y:auto;white-space:pre-wrap;word-break:break-word}
.ac-status{display:flex;gap:14px;align-items:center;padding:8px 14px;background:var(--card);border:1px solid var(--br);border-radius:var(--r-md);font:500 11px var(--mono);color:var(--dim)}
.ac-status .ok{color:var(--good)}.ac-status .bad{color:var(--bad)}
.ac-empty{display:grid;place-items:center;color:var(--dim);padding:48px;text-align:center;font:500 13px var(--mono)}
`;

function consolePage() {
  return shell('API console', 'Interactive request builder for any OpenHeab endpoint.', `
<section style="max-width:1240px;margin:0 auto;padding:40px 16px 12px">
  <span class="badge b-acc">API console</span>
  <h1 style="font:600 32px/1.1 var(--display);letter-spacing:-1px;margin:14px 0 8px">Interactive console.</h1>
  <p style="color:var(--dim2);font-size:14px;line-height:1.6;max-width:680px">Pick any of the 2,000+ documented endpoints. Edit the path params and body. Send a real request with your key. Inspect the response.</p>
  <div style="display:flex;gap:8px;margin-top:14px;align-items:center">
    <input type="password" id="apikey" placeholder="sk_oh_… (stored locally only)" style="flex:1;max-width:360px;font-family:var(--mono);font-size:12px;padding:8px 12px">
    <button class="btn ghost" id="save-key" style="font-size:12px">Save key</button>
    <span id="key-status" style="font:500 11px var(--mono);color:var(--dim)"></span>
  </div>
</section>
<section class="ac-shell">
  <aside class="ac-side">
    <input type="search" id="filter" placeholder="Filter ${'2,000+'} endpoints…" autocomplete="off">
    <div class="ac-list" id="ops"><div class="ac-empty">Loading openapi.json…</div></div>
  </aside>
  <div class="ac-main">
    <div id="builder" style="display:none">
      <div class="ac-row">
        <select id="method" disabled>
          <option>GET</option><option>POST</option><option>PUT</option><option>PATCH</option><option>DELETE</option>
        </select>
        <input class="ac-url" id="url" value="" />
        <button class="btn primary ac-send" id="send">Send →</button>
      </div>
      <div class="ac-tabs" id="tabs">
        <button data-tab="body" class="active">Body</button>
        <button data-tab="headers">Headers</button>
        <button data-tab="docs">Docs</button>
      </div>
      <div class="ac-pane" id="pane-body"><textarea id="body" placeholder='{}'></textarea></div>
      <div class="ac-pane" id="pane-headers" style="display:none"><textarea id="headers" placeholder='{"key": "value"}'></textarea></div>
      <div class="ac-pane" id="pane-docs" style="display:none"><div id="docs" style="padding:16px;font-size:13px;line-height:1.6;color:var(--dim2)"></div></div>
      <div class="ac-status" id="status">Ready.</div>
      <pre class="ac-resp" id="resp">// Response will appear here</pre>
    </div>
    <div id="empty" class="ac-empty" style="background:var(--card);border:1px solid var(--br);border-radius:var(--r-xl)">Select an endpoint on the left.</div>
  </div>
</section>
<script>
let allOps = [];
function getKey(){ return localStorage.getItem('openheab_key') || ''; }
function paintKey(){
  var k = getKey();
  document.getElementById('apikey').value = k ? k.slice(0,6) + '…' + k.slice(-4) : '';
  document.getElementById('key-status').innerHTML = k ? '<span style="color:var(--good)">✓ saved</span>' : '<span style="color:var(--dim)">no key</span>';
}
document.getElementById('save-key').addEventListener('click', function(){
  var v = document.getElementById('apikey').value.trim();
  if (v && !v.includes('…')) { localStorage.setItem('openheab_key', v); paintKey(); }
});
paintKey();

fetch('/openapi.json').then(r => r.json()).then(spec => {
  for (var p in spec.paths || {}) {
    for (var m in spec.paths[p]) {
      var op = spec.paths[p][m];
      if (typeof op !== 'object') continue;
      allOps.push({ method: m.toUpperCase(), path: p, summary: op.summary || op.description || '', spec: op });
    }
  }
  allOps.sort(function(a, b){ return a.path.localeCompare(b.path); });
  render('');
});

function render(filter) {
  var f = (filter || '').toLowerCase();
  var box = document.getElementById('ops');
  var matched = allOps.filter(function(o){
    return !f || o.path.toLowerCase().includes(f) || o.method.toLowerCase().includes(f) || o.summary.toLowerCase().includes(f);
  }).slice(0, 200);
  if (!matched.length) { box.innerHTML = '<div class="ac-empty">No matches</div>'; return; }
  box.innerHTML = matched.map(function(o, i){
    return '<div class="op" data-i="' + allOps.indexOf(o) + '"><span class="m ' + o.method + '">' + o.method + '</span><span class="p">' + o.path + '</span></div>';
  }).join('');
  box.querySelectorAll('.op').forEach(function(el){
    el.addEventListener('click', function(){
      box.querySelectorAll('.op').forEach(function(e){ e.classList.remove('active'); });
      el.classList.add('active');
      pick(allOps[parseInt(el.dataset.i)]);
    });
  });
}
document.getElementById('filter').addEventListener('input', function(e){ render(e.target.value); });

function pick(op) {
  document.getElementById('empty').style.display = 'none';
  document.getElementById('builder').style.display = 'block';
  document.getElementById('method').value = op.method;
  document.getElementById('url').value = op.path;
  document.getElementById('body').value = '';
  document.getElementById('docs').innerHTML = '<strong>' + op.method + ' ' + op.path + '</strong><br><br>' + (op.summary || '<em>No documentation</em>') + (op.spec.parameters ? '<br><br><strong>Parameters:</strong><br><pre style="font-size:11px;margin-top:8px">' + JSON.stringify(op.spec.parameters, null, 2) + '</pre>' : '');
}
document.getElementById('send').addEventListener('click', async function(){
  var method = document.getElementById('method').value;
  var url = document.getElementById('url').value;
  var bodyTxt = document.getElementById('body').value.trim();
  var hdrTxt = document.getElementById('headers').value.trim();
  var headers = { 'content-type': 'application/json' };
  if (getKey()) headers['Authorization'] = 'Bearer ' + getKey();
  if (hdrTxt) { try { Object.assign(headers, JSON.parse(hdrTxt)); } catch (e) { document.getElementById('status').innerHTML = '<span class="bad">Invalid headers JSON</span>'; return; } }
  document.getElementById('status').textContent = 'Sending…';
  var resp = document.getElementById('resp');
  resp.textContent = '';
  var start = performance.now();
  try {
    var opts = { method, headers };
    if (method !== 'GET' && method !== 'HEAD' && bodyTxt) opts.body = bodyTxt;
    var r = await fetch(url, opts);
    var t = await r.text();
    var ms = Math.round(performance.now() - start);
    document.getElementById('status').innerHTML = '<span class="' + (r.ok ? 'ok' : 'bad') + '">' + r.status + ' ' + r.statusText + '</span> · ' + ms + 'ms · ' + t.length + ' bytes';
    try { resp.textContent = JSON.stringify(JSON.parse(t), null, 2); }
    catch { resp.textContent = t; }
  } catch (e) {
    document.getElementById('status').innerHTML = '<span class="bad">Network error: ' + e.message + '</span>';
  }
});
document.querySelectorAll('#tabs button').forEach(function(b){
  b.addEventListener('click', function(){
    document.querySelectorAll('#tabs button').forEach(function(x){ x.classList.remove('active'); });
    b.classList.add('active');
    ['body', 'headers', 'docs'].forEach(function(k){
      document.getElementById('pane-' + k).style.display = b.dataset.tab === k ? 'block' : 'none';
    });
  });
});
</script>`, `<style>${CONSOLE_CSS}</style>`);
}

function registerApiConsoleRoutes(app, _pool) {
  app.get('/api-console', (req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.send(consolePage());
  });
}

async function migrate(_pool) {}
module.exports = { migrate, registerApiConsoleRoutes };
