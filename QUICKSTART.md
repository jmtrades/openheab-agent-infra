# QUICKSTART — from zero to a running OpenHeab in 10 minutes

> Three deployment paths. Pick the one that matches you.

---

## Path A — One-click deploy to Vercel (fastest; 3 minutes)

1. **Click the button**:
   <a href="https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fjmtrades%2Fopenheab-agent-infra">▲ Deploy to Vercel</a>
2. **Create a Neon Postgres database** (or any Postgres provider). Copy the `DATABASE_URL`.
3. **Vercel will prompt for env vars**. Paste in:
   ```
   DATABASE_URL=postgres://...?sslmode=require
   IDENTITY_MASTER_KEK=<openssl rand -hex 32>
   CRYPTO_MASTER_KEK=<openssl rand -hex 32>
   OPERATOR_PUBLIC_URL=https://your-deployment.vercel.app
   OPERATOR_ADMIN_TOKEN=<openssl rand -hex 32>
   ```
4. Click **Deploy**. Wait ~90 seconds.
5. Open `https://your-deployment.vercel.app/setup` — the wizard will tell you what's done and what's left.

You now have a fully-running OpenHeab substrate. **189 primitives, 1,495 routes, the in-house bank + email + KYC + inference cores, the marketing site, the docs, the dashboard, the playground.** Everything.

---

## Path B — Self-host on any Node 18+ server (for full control)

```bash
git clone https://github.com/jmtrades/openheab-agent-infra
cd openheab-agent-infra
npm install
cp .env.example .env

# Generate the cryptographic master keys
echo "IDENTITY_MASTER_KEK=$(openssl rand -hex 32)" >> .env
echo "CRYPTO_MASTER_KEK=$(openssl rand -hex 32)"   >> .env
echo "BANK_MASTER_KEK=$(openssl rand -hex 32)"     >> .env
echo "CARD_CORE_MASTER_KEK=$(openssl rand -hex 32)" >> .env
echo "ACH_MASTER_KEK=$(openssl rand -hex 32)"      >> .env
echo "OPERATOR_ADMIN_TOKEN=$(openssl rand -hex 32)" >> .env

# Point at your Postgres
echo "DATABASE_URL=postgres://USER:PASS@HOST/DB?sslmode=require" >> .env

# Optional — set at least one inference provider, or use our in-house inference stub
echo "INFERENCE_CORE_BACKEND_URL=" >> .env   # leave blank for stub mode

# Apply database schemas (idempotent — safe to re-run)
npm run migrate

# Boot
npm start
# → openheab-substrate listening on :3000

# Open in browser
open http://localhost:3000/setup
```

---

## Path C — Docker (for isolated environments)

```bash
git clone https://github.com/jmtrades/openheab-agent-infra
cd openheab-agent-infra

# Build
docker build -t openheab .

# Run with auto-generated keys (production: replace with persistent values)
docker run -d \
  -p 3000:3000 \
  -e DATABASE_URL="postgres://..." \
  -e IDENTITY_MASTER_KEK="$(openssl rand -hex 32)" \
  -e CRYPTO_MASTER_KEK="$(openssl rand -hex 32)" \
  -e OPERATOR_PUBLIC_URL="http://localhost:3000" \
  -e OPERATOR_ADMIN_TOKEN="$(openssl rand -hex 32)" \
  --name openheab openheab

# Run migrations
docker exec openheab npm run migrate

# Visit
open http://localhost:3000/setup
```

---

## What you get the moment it boots

A live substrate with:

- `/` — marketing landing (with live primitive + route counters)
- `/signup` — real Stripe Checkout signup flow
- `/setup` — operator setup wizard (shows what env vars are set / missing)
- `/welcome` — new-user tour (12 things to do right now)
- `/playground` — public API explorer (test any endpoint in browser)
- `/docs` — OpenAPI spec + quickstart + SDK install
- `/pricing` — pricing tiers + take-rates + credit packs
- `/blog` — 8 seed posts + RSS
- `/v1/dashboard` — agent management UI (home, billing, usage, team, audit, extensions)
- `/console` — live route browser (1,495 routes, filter + verb color coding)
- `/status/live` — real incident management page
- `/mcp` + `/mcp/manifest` — 145+ MCP tools
- `/v1/realtime/stream` — Server-Sent Events of every audit event
- `/v1/bank-core/reserve-ratio` — public proof-of-reserves
- `/v1/admin/providers` — see exactly which of 32 external providers are configured (admin)
- `/v1/admin/growth-plan/dashboard` — your 90-day MRR execution dashboard (admin)
- `/openapi.json` — full OpenAPI 3.1 spec
- `/sitemap.xml` + 6 sub-sitemaps + `/robots.txt` + `/.well-known/security.txt` + `/.well-known/agents.json` + `/llms-full.txt` + `/site.webmanifest`
- `/cli/install.sh` — POSIX bash installer for the `openheab` CLI

---

## After it's live — your first 5 actions

1. **Visit `/setup`**. It shows you exactly which env vars to set next.
2. **Visit `/welcome`**. Try the 12 one-click examples to see every primitive in action.
3. **Visit `/playground`**. Pick "Create agent" — you'll have a working DID + USDC wallet in 5 seconds.
4. **Generate fresh keys**: `GET /v1/setup/generate-keks` returns a fresh set of all 7 master keys. Set them in your hosting provider and re-deploy for production.
5. **Generate the operator root keypair**: `GET /v1/setup/generate-root-keypair` returns the Ed25519 keypair used to sign audit attestations. Set `OPERATOR_ROOT_PRIVATE_KEY_PEM` and your auditor portal goes live.

---

## What "perfect" looks like — the production readiness checklist

After deployment, run through this list. Everything should be green:

- [ ] `/setup` shows "ready" — all 5 required env vars set + DB reachable + inference configured
- [ ] `/healthz` returns `200 OK`
- [ ] `/readyz` returns `200 OK` (database query succeeds)
- [ ] `npm test` passes (17 unit + 8 lifecycle tests)
- [ ] `npm run test:boot` shows `189 primitives, 1,495 routes, 0 family misses`
- [ ] `/v1/bank-core/reserve-ratio` returns `solvent: true`
- [ ] `/v1/audit/verify` returns `valid: true`
- [ ] `/v1/admin/providers` (with admin token) shows your configured providers
- [ ] `/signup` flow creates a working agent end-to-end
- [ ] `/playground` "Create agent" → "Check wallet balance" works in <5 sec
- [ ] `/v1/realtime/stream` (with curl) shows live event push within 2 sec

If any of these fail, run `/setup` and follow the wizard.

---

## How big is this thing?

| Layer | Primitives |
|---|---|
| L1-L19 substrate + business primitives | 119 |
| L20-L24 commerce ops + realtime | 23 |
| L25 full email + KYC depth | 2 |
| L26 marketing + SEO + blog | 3 |
| L27 conversion + AGI-future + execution | 7 |
| L28 verticals + AGI-future + IPO | 9 |
| L29 design + workflows + adapters + CS + i18n + incidents | 6 |
| L30 in-house "no third party" core | 8 |
| L31 quickstart (setup, welcome, playground) | 1 |
| **Total** | **189** |

| Strategy doc | Use |
|---|---|
| `BILLION_DOLLAR_PATH.md` | 7-year arc to $1B+ ARR |
| `REVENUE_NOW.md` | 90 days to $10M ARR |
| `WHAT_WE_NEED_TO_WIN.md` | Brutal $10B gap list |
| `AGI_STRATEGY.md` | How to capitalize on AGI |
| `_100B_AUDIT.md` | Final inventory + verdict |
| `NO_THIRD_PARTY.md` | The 8 in-house cores |
| `QUICKSTART.md` | This doc |

Apache-2.0 · self-hostable · no third-party API keys required to boot.
