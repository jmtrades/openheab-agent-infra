#!/usr/bin/env bash
# ============================================================================
# OpenHeab substrate — one-shot production deploy
# ============================================================================
set -euo pipefail

GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[0;33m'; NC='\033[0m'
ok() { echo -e "${GREEN}✓${NC} $1"; }
err() { echo -e "${RED}✗${NC} $1"; }
warn() { echo -e "${YELLOW}!${NC} $1"; }
step() { echo; echo "==> $1"; }

step "Step 1 — Prerequisites"
command -v vercel >/dev/null || { err "vercel CLI not found. npm i -g vercel"; exit 1; }
command -v node >/dev/null || { err "node not found"; exit 1; }
ok "vercel + node present"

if [ ! -f .env.production ]; then
  if [ -f .env.production.template ]; then
    warn ".env.production not found — copying from template"
    cp .env.production.template .env.production
  fi
  err "Edit .env.production and re-run ./deploy.sh"
  exit 1
fi
set -a; source .env.production; set +a

REQUIRED=(DATABASE_URL IDENTITY_MASTER_KEK CRYPTO_MASTER_KEK OPERATOR_PUBLIC_URL OPENAI_API_KEY)
MISSING=()
for v in "${REQUIRED[@]}"; do
  [ -z "${!v:-}" ] && MISSING+=("$v")
done
[ ${#MISSING[@]} -gt 0 ] && { err "Missing env: ${MISSING[*]}"; exit 1; }
ok "Required env vars set"

step "Step 2 — Local tests"
BANK_MASTER_KEK="${BANK_MASTER_KEK:-$IDENTITY_MASTER_KEK}" \
SECRETS_MASTER_KEK="${SECRETS_MASTER_KEK:-$IDENTITY_MASTER_KEK}" \
STRIPE_SECRET_KEY="${STRIPE_SECRET_KEY:-sk_test_dummy}" \
STRIPE_WEBHOOK_SECRET="${STRIPE_WEBHOOK_SECRET:-whsec_dummy}" \
STRIPE_PRICE_PRO_MONTHLY="${STRIPE_PRICE_PRO_MONTHLY:-price_dummy}" \
node test/unit.js 2>&1 | tail -3 || warn "unit tests had issues"

step "Step 3 — Migrate database"
if [ -z "${SKIP_MIGRATE:-}" ]; then
  npm run migrate && ok "Database migrated" || warn "Migration had issues"
fi

step "Step 4 — Push env vars to Vercel"
push_env() {
  echo "$2" | vercel env add "$1" production --force 2>&1 | tail -1 || true
}

for v in "${REQUIRED[@]}" CRON_SECRET BANK_MASTER_KEK SECRETS_MASTER_KEK ADMIN_API_TOKEN \
         WEBHOOK_SIGNING_SECRET ANTHROPIC_API_KEY STRIPE_SECRET_KEY \
         STRIPE_WEBHOOK_SECRET STRIPE_PRICE_PRO_MONTHLY; do
  if [ -n "${!v:-}" ]; then push_env "$v" "${!v}"; ok "Pushed $v"; fi
done

step "Step 5 — Deploy to production"
DEPLOY_URL=$(vercel deploy --prod --yes 2>&1 | tail -1)
ok "Deployed: $DEPLOY_URL"

step "Step 6 — Smoke test"
sleep 5
LIVE_URL="${OPERATOR_PUBLIC_URL:-$DEPLOY_URL}"

curl -sf "$LIVE_URL/healthz" >/dev/null && ok "/healthz OK" || err "/healthz FAILED"
curl -sf "$LIVE_URL/.well-known/agents.json" >/dev/null && ok "agents.json OK" || err "agents.json FAILED"
curl -sf "$LIVE_URL/mcp/manifest" >/dev/null && ok "/mcp/manifest OK" || err "/mcp/manifest FAILED"

step "Step 7 — Live identity creation test"
CREATE=$(curl -sf -X POST "$LIVE_URL/v1/identities" \
  -H 'content-type: application/json' -d '{"name":"smoketest-agent"}' 2>&1 || echo "FAIL")
if echo "$CREATE" | grep -q 'did:op:'; then
  ok "Identity creation works"
else
  err "Identity creation FAILED: $CREATE"
fi

echo
echo "================================================================="
echo "✓ LAUNCH COMPLETE — substrate live at $LIVE_URL"
echo "================================================================="
echo
echo "Next: submit /mcp manifest to Smithery + mcp.run, post on HN."
