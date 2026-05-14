# INDEX — every file in this repo

## Master facts

- **135 primitive modules** in `src/primitives/` (the agent super-hub)
- **800+ HTTP routes** registered
- **18 cron jobs** in `vercel.json`
- **14 revenue layers** all coded — see `BILLION_DOLLAR_PATH.md`
- **115+ MCP tools** exposed at `/mcp`
- **Apache 2.0** license, **CommonJS**, no build step

## Root docs

| File | Purpose |
|---|---|
| `CLAUDE.md` | Project memory for Claude Code |
| `README.md` | Public-facing repo intro |
| `INDEX.md` | This file |
| `CHANGELOG.md` | Version history |
| `CONTRIBUTING.md` | Contribution guide |
| `SECURITY.md` | Security policy |
| `LAUNCH_NOW.md` | 30-min click-by-click launch path |

## Source code (`src/`)

### Top-level
- `src/integration.js` — Master wiring
- `src/cron_auth.js` — Cron auth helper
- `src/rate_limit.js` — Postgres-backed rate limiter
- `src/observability.js` — Request IDs, logging, metrics, CORS
- `src/status_page.js` — `/` HTML + `/openapi.json`
- `src/landing.js` — Marketing landing page
- `src/discovery.js` — `/sitemap.xml`, `/robots.txt`, `/llms.txt`, `/.well-known/*`
- `src/chain_crypto.js` — Pure-stdlib Solana + Bitcoin keypairs

### 135 Primitives (`src/primitives/`) — the agent super-hub

**Layer 1 — Kernel (8):** identity, secrets, aliases, storage, cost, analytics, portability, intelligence

**Layer 2 — Runtime (8):** memory, tools, workflows, scheduler, inbox, inference, eval, continuity

**Layer 3 — Commerce (10):** bank (legacy), bank_chain (USDC), bank_extensions, bank_config, crypto, commerce, payouts, x402, escrow, cards, savings

**Layer 4 — Trust (11):** reputation, kyc, kyc_extensions, security, insurance, biometrics, aml, fraud, notary, tripwires, reversibility

**Layer 5 — Marketplace (5):** marketplace, extensions, prompts, datasets, mcp_server

**Layer 6 — Operations (8):** governance, publishing, email, phone, deployment, oauth_bridge, entities, tax

**Layer 7 — Perception (6):** sandbox, browser, voice, vision, video, search

**Layer 8 — Knowledge (6):** documents, maps, knowledge, translate, moderation, fact_check

**Layer 9 — Web3 finance (6):** multisig, lending, defi, tokens, nft, bridges

**Layer 10 — Infrastructure (6):** dns, hosting, database, ipfs, cache, cdn

**Layer 11 — AGI cognition (6):** planning, simulation, beliefs, goals, skills, causal

**Layer 12 — AGI ops (3):** interpretability, fine_tuning, federated_learning

**Layer 13 — Org / business (6):** crm, projects, leads, outreach, forms, dao_factory

**Layer 14 — Business essentials (8):** chat, invoicing, compute, news, calendar, billing, contracts, courts

**Layer 15 — Domain (6):** health, passport, logistics, property, robotics, api_management

**Layer 16 — Revenue commerce (8):** brokerage, prediction_markets, shopping, travel, advertising, media, ratings, booking

**Layer 17 — Developer infra (8):** github, ci_cd, monitoring, error_tracking, feature_flags, experiments, webhooks, events

**Layer 18 — AGI learning + gov/legal (8):** learning, voice_agents, labs, gov_filing, legal_research, court_records, ip_registry, climate

**Layer 19 — Customer service + community (8):** support, referrals, loyalty, surveys, recruiting, supply_chain, licensing, benchmarks

## API entrypoint
- `api/index.js` — Vercel serverless function
- `server.js` — Local development server

## Tests (`test/`)
- `test/unit.js` — Pure-function unit tests
- `test/boot.js` — Full app boot test
- `test/smoke.js` — Live deployment smoke test

## Smart contracts (`contracts/`)
- `contracts/FeeSplitter.sol` — 1% fee-split contract
- `contracts/test/FeeSplitter.t.sol` — Forge tests with fuzz invariant
- `contracts/deploy.js` — Deployment script
- `contracts/foundry.toml` — Foundry config

## SDKs (`sdks/`)
- `sdks/python/` — Python SDK + CLI (zero deps)
- `sdks/typescript/` — TypeScript SDK

## Adapters (`adapters/`)
- `adapters/langchain/` — LangChain identity + tools
- `adapters/llamaindex/` — LlamaIndex FunctionTool wrappers
- `adapters/crewai/` — CrewAI agent wrapper
- `adapters/autogen/` — AutoGen / AG2 integration

## Reference agents (`reference-agents/`)
1. `email-bot/` — autonomous email triage
2. `payment-bot/` — USDC split router
3. `research-bot/` — research + publish signed posts
4. `trader-bot/` — policy-bound USDC transfers
5. `marketplace-bot/` — list + deliver services
6. `content-bot/` — autonomous publishing
7. `compliance-bot/` — pre-transaction screening
8. `scheduling-bot/` — calendar over email
9. `negotiation-bot/` — escrow dealmaking
10. `onboarding-bot/` — interactive setup

## Email gateway (`email-gateway/`)
- `setup.sh` — Debian 12 installer
- `relay.js` — VPS-side bridge

## CI/CD
- `.github/workflows/ci.yml` — Syntax + boot + unit + forge tests
- `.github/workflows/publish-npm.yml` — `@openheab/sdk` to npm on tagged release
- `.github/workflows/publish-pypi.yml` — `openheab` + 4 adapters to PyPI

## Launch
- `launch/LAUNCH_POSTS.md` — Copy-paste-ready HN/Twitter/Discord text
- `launch/mcp_registry.json` — MCP server submission JSON
- `specs/agents-json-v1.md` — agents.json open spec

## Deploy
- `deploy.sh` — One-shot production deploy
- `Makefile` — Dev shortcuts (install, test, dev, migrate, contracts)
- `.env.example` — Env template
- `.env.production.template` — Production env template
- `vercel.json` — Vercel config + 18 cron schedules
