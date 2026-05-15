// ============================================================================
// cli.js — endpoints + a downloadable bash installer that powers `npx openheab`
// and `curl -sL https://openheab.com/cli/install.sh | sh`. The CLI is the
// single fastest signup-to-success developer surface — and it doubles as a
// distribution channel because every dev who installs it pulls our brand.
// ============================================================================
const crypto = require('crypto');

async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cli_installs (
      install_id        TEXT PRIMARY KEY,
      version           TEXT,
      platform          TEXT,
      ip_hash           TEXT,
      ua_hash           TEXT,
      occurred_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_cli_installs_at ON cli_installs (occurred_at DESC);
  `);
}

const INSTALL_SH = (base) => `#!/usr/bin/env sh
# OpenHeab CLI installer
# Usage: curl -sL ${base}/cli/install.sh | sh
set -e
echo "→ Installing openheab CLI..."
INSTALL_DIR="\${OPENHEAB_INSTALL_DIR:-$HOME/.openheab}"
mkdir -p "$INSTALL_DIR/bin"
curl -sL "${base}/cli/openheab" -o "$INSTALL_DIR/bin/openheab"
chmod +x "$INSTALL_DIR/bin/openheab"

# Add to PATH if not already
PROFILE=""
if [ -f "$HOME/.zshrc" ]; then PROFILE="$HOME/.zshrc";
elif [ -f "$HOME/.bashrc" ]; then PROFILE="$HOME/.bashrc";
elif [ -f "$HOME/.profile" ]; then PROFILE="$HOME/.profile"; fi

if [ -n "$PROFILE" ] && ! grep -q ".openheab/bin" "$PROFILE"; then
  echo 'export PATH="$HOME/.openheab/bin:$PATH"' >> "$PROFILE"
  echo "→ Added $INSTALL_DIR/bin to PATH in $PROFILE"
fi

# Telemetry: count this install (anonymous)
curl -sL -X POST "${base}/v1/cli/installs" -H "content-type: application/json" \\
  -d '{"version":"0.1.0","platform":"'$(uname -s)'/'$(uname -m)'"}' > /dev/null 2>&1 || true

echo "✓ Installed. Run: openheab --help"
echo "  Quickstart:  openheab signup"
`;

const CLI_SCRIPT = (base) => `#!/usr/bin/env sh
# OpenHeab CLI v0.1.0 — minimal POSIX shell client
# https://openheab.com  —  Apache-2.0
set -e

OPENHEAB_BASE="\${OPENHEAB_BASE:-${base}}"
OPENHEAB_API_KEY="\${OPENHEAB_API_KEY:-}"

if [ -f "$HOME/.openheab/config" ]; then
  . "$HOME/.openheab/config"
fi

cmd_help() {
  cat <<'EOF'
openheab — agent-native infrastructure CLI

USAGE:
  openheab <command> [args]

COMMANDS:
  signup [email]          Create an agent + USDC wallet + API key
  identity                Show current identity (DID + wallet address)
  balance                 Show wallet USDC balance
  transfer <to_did> <amt> Transfer USDC to another agent
  send <to_email> <subj>  Send an email from your agent
  inbox                   List inbox messages
  call <method> <path>    Raw API call (e.g. openheab call GET /v1/orgs)
  mcp                     Print MCP server config snippet
  docs                    Open docs in browser
  --version               Print CLI version

ENV:
  OPENHEAB_BASE     API base URL (default: ${base})
  OPENHEAB_API_KEY  Bearer API key

EXAMPLES:
  openheab signup alice@startup.com
  openheab balance
  openheab transfer did:op:abc123 5.00
EOF
}

cmd_version() { echo "openheab 0.1.0"; }

cmd_signup() {
  EMAIL="\${1:-}"
  if [ -z "$EMAIL" ]; then printf "Email: "; read EMAIL; fi
  echo "→ Provisioning identity + USDC wallet..."
  RESP=$(curl -sL -X POST "$OPENHEAB_BASE/v1/signup" \\
    -H "content-type: application/json" \\
    -d "{\\"email\\":\\"$EMAIL\\",\\"plan_code\\":\\"free\\"}")
  echo "$RESP" | head -c 4000
  echo ""
  API_KEY=$(echo "$RESP" | sed -n 's/.*"api_key":"\\([^"]*\\)".*/\\1/p' | head -1)
  DID=$(echo "$RESP" | sed -n 's/.*"did":"\\([^"]*\\)".*/\\1/p' | head -1)
  if [ -n "$API_KEY" ]; then
    mkdir -p "$HOME/.openheab"
    cat > "$HOME/.openheab/config" <<CFG
OPENHEAB_API_KEY="$API_KEY"
OPENHEAB_DID="$DID"
CFG
    echo ""
    echo "✓ Saved credentials to ~/.openheab/config"
    echo "  DID:     $DID"
    echo "  API key: \${API_KEY:0:12}…"
  fi
}

cmd_identity() {
  if [ -z "\${OPENHEAB_DID:-}" ]; then echo "Not signed up. Run: openheab signup"; exit 1; fi
  curl -sL "$OPENHEAB_BASE/v1/identities/$OPENHEAB_DID" \\
    -H "Authorization: Bearer $OPENHEAB_API_KEY"
  echo ""
}

cmd_balance() {
  if [ -z "\${OPENHEAB_DID:-}" ]; then echo "Not signed up. Run: openheab signup"; exit 1; fi
  curl -sL "$OPENHEAB_BASE/v1/agents/$OPENHEAB_DID/wallet/balance" \\
    -H "Authorization: Bearer $OPENHEAB_API_KEY"
  echo ""
}

cmd_transfer() {
  TO="\${1:-}"; AMT="\${2:-}"
  if [ -z "$TO" ] || [ -z "$AMT" ]; then echo "Usage: openheab transfer <to_did> <amount_usdc>"; exit 1; fi
  curl -sL -X POST "$OPENHEAB_BASE/v1/agents/$OPENHEAB_DID/wallet/transfer" \\
    -H "Authorization: Bearer $OPENHEAB_API_KEY" \\
    -H "content-type: application/json" \\
    -d "{\\"to_did\\":\\"$TO\\",\\"amount\\":\\"$AMT\\"}"
  echo ""
}

cmd_inbox() {
  curl -sL "$OPENHEAB_BASE/v1/agents/$OPENHEAB_DID/inbox?limit=20" \\
    -H "Authorization: Bearer $OPENHEAB_API_KEY"
  echo ""
}

cmd_send() {
  TO="\${1:-}"; SUBJ="\${2:-}"
  if [ -z "$TO" ] || [ -z "$SUBJ" ]; then echo "Usage: openheab send <to_email> <subject>"; exit 1; fi
  echo "Body (Ctrl+D when done):"
  BODY=$(cat)
  curl -sL -X POST "$OPENHEAB_BASE/v1/agents/$OPENHEAB_DID/email/send" \\
    -H "Authorization: Bearer $OPENHEAB_API_KEY" \\
    -H "content-type: application/json" \\
    -d "{\\"to\\":\\"$TO\\",\\"subject\\":\\"$SUBJ\\",\\"body_text\\":\\"$BODY\\"}"
  echo ""
}

cmd_call() {
  METHOD="\${1:-GET}"; PATH_="\${2:-/}"
  curl -sL -X "$METHOD" "$OPENHEAB_BASE$PATH_" \\
    -H "Authorization: Bearer $OPENHEAB_API_KEY"
  echo ""
}

cmd_mcp() {
  cat <<EOF
{
  "mcpServers": {
    "openheab": {
      "url": "$OPENHEAB_BASE/mcp",
      "auth": "Bearer $OPENHEAB_API_KEY"
    }
  }
}
EOF
}

cmd_docs() {
  URL="$OPENHEAB_BASE/docs"
  if command -v open >/dev/null 2>&1; then open "$URL"; else echo "$URL"; fi
}

CMD="\${1:-help}"; shift 2>/dev/null || true
case "$CMD" in
  signup)    cmd_signup "$@" ;;
  identity)  cmd_identity ;;
  balance)   cmd_balance ;;
  transfer)  cmd_transfer "$@" ;;
  inbox)     cmd_inbox ;;
  send)      cmd_send "$@" ;;
  call)      cmd_call "$@" ;;
  mcp)       cmd_mcp ;;
  docs)      cmd_docs ;;
  --version|version) cmd_version ;;
  help|-h|--help|*) cmd_help ;;
esac
`;

function newId(p) { return p + '_' + crypto.randomBytes(10).toString('hex'); }

function registerCliRoutes(app, pool, _verifyAgentAuth, _auditChain) {
  const express = require('express');

  app.get('/cli/install.sh', (req, res) => {
    const base = process.env.OPERATOR_PUBLIC_URL || ('http://' + req.headers.host);
    res.setHeader('content-type', 'text/x-shellscript');
    res.setHeader('cache-control', 'public, max-age=300');
    res.send(INSTALL_SH(base));
  });

  app.get('/cli/openheab', (req, res) => {
    const base = process.env.OPERATOR_PUBLIC_URL || ('http://' + req.headers.host);
    res.setHeader('content-type', 'text/x-shellscript');
    res.setHeader('cache-control', 'public, max-age=3600');
    res.send(CLI_SCRIPT(base));
  });

  app.post('/v1/cli/installs', express.json(), async (req, res) => {
    const ipHash = crypto.createHash('sha256').update(req.ip || '').digest('hex').slice(0, 16);
    const uaHash = crypto.createHash('sha256').update(req.headers['user-agent'] || '').digest('hex').slice(0, 16);
    await pool.query(
      `INSERT INTO cli_installs (install_id, version, platform, ip_hash, ua_hash)
       VALUES ($1,$2,$3,$4,$5)`,
      [newId('cli'), req.body?.version || null, req.body?.platform || null, ipHash, uaHash]
    ).catch(() => {});
    res.json({ ok: true });
  });

  app.get('/v1/cli/stats', async (req, res) => {
    const total = await pool.query(`SELECT COUNT(*)::int AS c FROM cli_installs`).catch(() => ({ rows: [{ c: 0 }] }));
    const last24h = await pool.query(`SELECT COUNT(*)::int AS c FROM cli_installs WHERE occurred_at > NOW() - INTERVAL '24 hours'`).catch(() => ({ rows: [{ c: 0 }] }));
    const byPlatform = await pool.query(`SELECT platform, COUNT(*)::int AS c FROM cli_installs GROUP BY platform ORDER BY c DESC LIMIT 20`).catch(() => ({ rows: [] }));
    res.json({ total_installs: total.rows[0].c, installs_24h: last24h.rows[0].c, by_platform: byPlatform.rows });
  });
}

module.exports = { migrate, registerCliRoutes, INSTALL_SH, CLI_SCRIPT };
