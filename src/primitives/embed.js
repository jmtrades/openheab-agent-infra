// ============================================================================
// embed.js — embeddable widgets (pay-button, reputation badge, login,
// marketplace card, cost calculator, agent chat). Single JS snippet that
// 3rd-party sites paste in to drive distribution.
// ============================================================================
const crypto = require('crypto');
const { z } = require('zod');

const KINDS = ['pay_button', 'reputation_badge', 'login', 'marketplace_card', 'cost_calc', 'agent_chat'];

async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS embed_widgets (
      widget_id        TEXT PRIMARY KEY,
      owner_did        TEXT NOT NULL,
      kind             TEXT NOT NULL,
      name             TEXT NOT NULL,
      config           JSONB NOT NULL DEFAULT '{}'::jsonb,
      target_origins   TEXT[],
      api_key_hash     TEXT,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      status           TEXT NOT NULL DEFAULT 'active'
    );
    CREATE INDEX IF NOT EXISTS idx_embed_widgets_owner
      ON embed_widgets (owner_did, status);
    CREATE TABLE IF NOT EXISTS embed_views (
      view_id          TEXT PRIMARY KEY,
      widget_id        TEXT NOT NULL,
      origin           TEXT,
      occurred_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      ip_hash          TEXT,
      user_agent_hash  TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_embed_views_widget
      ON embed_views (widget_id, occurred_at DESC);
    CREATE TABLE IF NOT EXISTS embed_conversions (
      conversion_id    TEXT PRIMARY KEY,
      widget_id        TEXT NOT NULL,
      kind             TEXT NOT NULL,
      value_cents      BIGINT,
      related_id       TEXT,
      occurred_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

function newId(p) { return p + '_' + crypto.randomBytes(10).toString('hex'); }

function corsForOrigin(origins, requestOrigin) {
  if (!origins || origins.length === 0) return '*';
  if (requestOrigin && origins.includes(requestOrigin)) return requestOrigin;
  return null;
}

function generateWidgetJS(widget, baseUrl) {
  const wid = JSON.stringify(widget.widget_id);
  const base = JSON.stringify(baseUrl);
  return `(function(){
  var WID = ${wid}, BASE = ${base};
  function $(s, p){return (p||document).querySelector(s)}
  function el(tag, attrs, text){
    var e = document.createElement(tag);
    if(attrs) for(var k in attrs) e.setAttribute(k, attrs[k]);
    if(text != null) e.textContent = text;
    return e;
  }
  function track(kind, value){
    fetch(BASE + '/v1/embed/widget/' + WID + '/event', {
      method:'POST', headers:{'content-type':'application/json'},
      body: JSON.stringify({kind:kind, value_cents:value || null})
    }).catch(function(){});
  }
  fetch(BASE + '/v1/embed/widget/' + WID + '/config.json').then(function(r){return r.json()}).then(function(cfg){
    var container = $('#openheab-widget-' + WID) || (function(){
      var d = el('div', {id:'openheab-widget-'+WID, style:'all:initial;font-family:system-ui;display:inline-block;color:#0a0a0a'});
      document.body.appendChild(d); return d;
    })();
    container.innerHTML = '';
    track('view');
    if(cfg.kind === 'pay_button'){
      var btn = el('button', {style:'all:initial;background:#7df9ff;color:#001a1f;padding:10px 18px;border-radius:6px;font-weight:700;font-size:14px;cursor:pointer;font-family:system-ui'}, 'Pay ' + (cfg.amount_usdc || '5.00') + ' USDC');
      btn.onclick = function(){
        track('click');
        window.location.href = BASE + '/v1/agents/' + cfg.recipient_did + '/wallet/topup?amount=' + (cfg.amount_usdc||'5.00') + '&from_widget=' + WID;
      };
      container.appendChild(btn);
    } else if(cfg.kind === 'reputation_badge'){
      var box = el('a', {href: BASE + '/v1/agents/' + cfg.agent_did + '/reputation', target:'_blank', style:'all:initial;display:inline-flex;align-items:center;gap:6px;padding:6px 12px;border:1px solid #ddd;border-radius:99px;font-family:system-ui;font-size:12px;color:#333;text-decoration:none;cursor:pointer'});
      box.appendChild(el('span', {style:'width:8px;height:8px;border-radius:50%;background:#22c55e'}));
      box.appendChild(el('span', null, 'OpenHeab verified · score ' + (cfg.score || '0.85')));
      container.appendChild(box);
    } else if(cfg.kind === 'login'){
      var b = el('button', {style:'all:initial;background:#0a0a0a;color:#7df9ff;padding:10px 18px;border-radius:6px;font-weight:600;font-size:14px;cursor:pointer;font-family:system-ui;border:1px solid #7df9ff'}, 'Sign in with OpenHeab');
      b.onclick = function(){track('click'); window.location.href = BASE + '/sso/start?widget=' + WID;};
      container.appendChild(b);
    } else if(cfg.kind === 'marketplace_card'){
      var card = el('div', {style:'all:initial;display:block;width:280px;border:1px solid #ddd;padding:18px;border-radius:10px;font-family:system-ui;color:#0a0a0a;background:#fff'});
      card.appendChild(el('div', {style:'font:600 11px/1 ui-monospace,monospace;color:#7da;text-transform:uppercase;letter-spacing:1px'}, cfg.category || 'extension'));
      card.appendChild(el('div', {style:'font-weight:700;font-size:18px;margin:8px 0 4px'}, cfg.title || 'Untitled'));
      card.appendChild(el('div', {style:'color:#666;font-size:13px;margin-bottom:14px'}, cfg.description || ''));
      var install = el('button', {style:'all:initial;background:#7df9ff;color:#001a1f;padding:8px 14px;border-radius:5px;font-weight:600;font-size:13px;cursor:pointer;font-family:system-ui'}, 'Install · ' + (cfg.price_label || 'Free'));
      install.onclick = function(){track('install', cfg.price_cents || 0); window.location.href = BASE + '/v1/extensions/' + cfg.slug;};
      card.appendChild(install);
      container.appendChild(card);
    } else if(cfg.kind === 'cost_calc'){
      var calc = el('div', {style:'all:initial;display:block;width:300px;font-family:system-ui;color:#0a0a0a;background:#fff;border:1px solid #ddd;padding:18px;border-radius:10px'});
      calc.appendChild(el('div', {style:'font-weight:600;font-size:14px;margin-bottom:10px'}, 'Inference cost estimator'));
      var slider = el('input', {type:'range', min:'1', max:'100', value:'10', style:'width:100%'});
      var label = el('div', {style:'font:600 22px/1.2 ui-monospace,monospace;margin-top:8px'}, '$' + (10 * 0.012).toFixed(2) + '/day');
      slider.oninput = function(){
        var v = +this.value; label.textContent = '$' + (v * 0.012).toFixed(2) + '/day · ' + v + 'k tokens';
      };
      calc.appendChild(slider); calc.appendChild(label);
      container.appendChild(calc);
    } else if(cfg.kind === 'agent_chat'){
      var box = el('div', {style:'all:initial;display:block;width:340px;height:380px;border:1px solid #ddd;border-radius:10px;background:#fff;font-family:system-ui;color:#0a0a0a;padding:14px;display:flex;flex-direction:column'});
      var log = el('div', {style:'flex:1;overflow:auto;font-size:13px;padding:6px'});
      var inp = el('input', {placeholder:'Ask the agent…', style:'all:initial;width:100%;padding:8px 10px;border:1px solid #ccc;border-radius:5px;font-family:system-ui;font-size:13px'});
      box.appendChild(log); box.appendChild(inp);
      container.appendChild(box);
    } else {
      container.appendChild(el('div', null, 'Unknown widget kind: ' + cfg.kind));
    }
  }).catch(function(){
    container.innerHTML = '<div style="font-family:system-ui;color:#900;font-size:12px">[OpenHeab widget failed to load]</div>';
  });
})();`;
}

const widgetSchema = z.object({
  kind: z.enum(KINDS),
  name: z.string().min(1).max(120),
  config: z.record(z.any()).optional(),
  target_origins: z.array(z.string()).optional()
});

function registerEmbedRoutes(app, pool, verifyAgentAuth, auditChain) {
  const express = require('express');

  app.post('/v1/agents/:did/embed/widgets', express.json(), async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const p = widgetSchema.safeParse(req.body || {});
    if (!p.success) return res.status(400).json({ error: 'invalid_input', details: p.error.flatten() });
    const id = newId('emb');
    const apiKey = 'emb_' + crypto.randomBytes(20).toString('hex');
    const apiKeyHash = crypto.createHash('sha256').update(apiKey).digest('hex');
    await pool.query(
      `INSERT INTO embed_widgets (widget_id, owner_did, kind, name, config, target_origins, api_key_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [id, did, p.data.kind, p.data.name, JSON.stringify(p.data.config || {}),
       p.data.target_origins || null, apiKeyHash]
    );
    if (auditChain) await auditChain.append({ event_type: 'embed.widget_created', owner_did: did, widget_id: id, kind: p.data.kind }).catch(() => {});
    const base = process.env.OPERATOR_PUBLIC_URL || '';
    res.status(201).json({
      widget_id: id, api_key: apiKey,
      snippet: `<script src="${base}/v1/embed/widget/${id}.js" async></script>`
    });
  });

  app.get('/v1/agents/:did/embed/widgets', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(`
      SELECT widget_id, kind, name, config, target_origins, status, created_at
      FROM embed_widgets WHERE owner_did = $1 ORDER BY created_at DESC LIMIT 100
    `, [did]).catch(() => ({ rows: [] }));
    res.json({ widgets: r.rows });
  });

  app.delete('/v1/agents/:did/embed/widgets/:wid', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did, { strictSignatureRequired: true });
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const r = await pool.query(`UPDATE embed_widgets SET status='disabled' WHERE widget_id=$1 AND owner_did=$2 RETURNING widget_id`,
      [req.params.wid, did]).catch(() => ({ rows: [] }));
    if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
    res.json({ widget_id: r.rows[0].widget_id, status: 'disabled' });
  });

  app.get('/v1/embed/widget/:wid.js', async (req, res) => {
    const r = await pool.query(`SELECT widget_id, kind, config, target_origins, status FROM embed_widgets WHERE widget_id = $1`,
      [req.params.wid]).catch(() => ({ rows: [] }));
    if (!r.rows[0] || r.rows[0].status !== 'active') {
      return res.status(404).type('application/javascript').send(`console.error('[OpenHeab] widget not found');`);
    }
    res.setHeader('content-type', 'application/javascript');
    res.setHeader('cache-control', 'public, max-age=60');
    const base = process.env.OPERATOR_PUBLIC_URL || ('http://' + req.headers.host);
    res.send(generateWidgetJS(r.rows[0], base));
  });

  app.get('/v1/embed/widget/:wid/config.json', async (req, res) => {
    const r = await pool.query(`SELECT widget_id, kind, config, target_origins FROM embed_widgets WHERE widget_id = $1 AND status='active'`,
      [req.params.wid]).catch(() => ({ rows: [] }));
    if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
    const origin = corsForOrigin(r.rows[0].target_origins, req.headers.origin);
    if (origin) res.setHeader('access-control-allow-origin', origin);
    res.setHeader('cache-control', 'public, max-age=60');
    const cfg = typeof r.rows[0].config === 'string' ? JSON.parse(r.rows[0].config) : r.rows[0].config;
    res.json({ widget_id: r.rows[0].widget_id, kind: r.rows[0].kind, ...cfg });
  });

  app.post('/v1/embed/widget/:wid/event', express.json(), async (req, res) => {
    const r = await pool.query(`SELECT widget_id, target_origins FROM embed_widgets WHERE widget_id = $1`, [req.params.wid])
      .catch(() => ({ rows: [] }));
    if (!r.rows[0]) return res.status(404).end();
    const origin = corsForOrigin(r.rows[0].target_origins, req.headers.origin);
    if (origin) res.setHeader('access-control-allow-origin', origin);
    const kind = req.body?.kind || 'view';
    const value_cents = req.body?.value_cents;
    if (kind === 'view') {
      const ipHash = crypto.createHash('sha256').update(req.ip || '').digest('hex').slice(0, 16);
      const uaHash = crypto.createHash('sha256').update(req.headers['user-agent'] || '').digest('hex').slice(0, 16);
      await pool.query(
        `INSERT INTO embed_views (view_id, widget_id, origin, ip_hash, user_agent_hash)
         VALUES ($1,$2,$3,$4,$5)`,
        [newId('ev'), r.rows[0].widget_id, req.headers.origin || null, ipHash, uaHash]
      ).catch(() => {});
    } else {
      await pool.query(
        `INSERT INTO embed_conversions (conversion_id, widget_id, kind, value_cents)
         VALUES ($1,$2,$3,$4)`,
        [newId('cv'), r.rows[0].widget_id, kind, value_cents || null]
      ).catch(() => {});
    }
    res.json({ ok: true });
  });

  app.get('/v1/agents/:did/embed/widgets/:wid/stats', async (req, res) => {
    const did = req.params.did;
    const auth = await verifyAgentAuth(req, did);
    if (!auth.valid) return res.status(401).json({ error: auth.error });
    const v = await pool.query(`SELECT COUNT(*)::int AS c FROM embed_views WHERE widget_id = $1`, [req.params.wid])
      .catch(() => ({ rows: [{ c: 0 }] }));
    const c = await pool.query(`
      SELECT kind, COUNT(*)::int AS c, COALESCE(SUM(value_cents),0)::bigint AS total
      FROM embed_conversions WHERE widget_id = $1 GROUP BY kind
    `, [req.params.wid]).catch(() => ({ rows: [] }));
    res.json({ widget_id: req.params.wid, views: v.rows[0].c, conversions: c.rows });
  });

  app.get('/v1/embed/snippets/:kind', (req, res) => {
    const base = process.env.OPERATOR_PUBLIC_URL || '';
    res.json({
      kind: req.params.kind,
      install_html: `<div id="openheab-widget-WIDGET_ID"></div>\n<script src="${base}/v1/embed/widget/WIDGET_ID.js" async></script>`,
      note: 'Replace WIDGET_ID with the value returned from POST /v1/agents/:did/embed/widgets'
    });
  });
}

module.exports = { migrate, registerEmbedRoutes, generateWidgetJS, KINDS };
