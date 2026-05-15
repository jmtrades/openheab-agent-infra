# Changelog

All notable changes follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versions follow [SemVer 2.0.0](https://semver.org/).

## [0.2.0] — 2026-05-15

The Anthropic-launch-readiness release. Substrate grew from 42 → 231 primitives,
334 → 1,690+ routes, 6 → 40 architecture layers. Sold to AI agents.

### Added — 40 architecture layers

- **L1–L19** — 135 foundational primitives (identity, bank, KYC, memory,
  marketplaces, perception, knowledge, web3, infrastructure, AGI cognition,
  AGI ops, org/business, business essentials, domain, revenue commerce,
  developer infra, AGI learning + gov/legal, customer service + community)
- **L20** Org / billing / commerce ops (4): org, subscriptions, metering, revenue
- **L21** Enterprise readiness (4): sso, rbac, compliance_pack, credits
- **L22** Growth + distribution (4): onboarding, dashboard, embed, public_directory
- **L23** Channel + payments (4): partnerships, whitelabel, ach, quotes
- **L24** Realtime (1): SSE event stream
- **L25** Full email + KYC depth (2): email_advanced, kyc_advanced
- **L26** Marketing + SEO + Blog (3): blog, marketing, seo
- **L27** Conversion + AGI-future + execution (7): signup (real Stripe Checkout),
  negotiation, orchestration, constitution, safety, growth_plan, cli
- **L28** Verticals + AGI-future + IPO (9): verticals (10 industries), multimodal,
  capital_markets, agent_market, evals, integrations, realtime_ws, mobile,
  ipo_readiness
- **L29** Design + workflows + adapters + CS + i18n + incidents (6)
- **L30** In-house "no third party" core (8): bank_core, email_core, kyc_core,
  inference_core, insurance_core, audit_core, payment_rails, card_core
- **L31** Operator-facing demo surface (3): quickstart (`/setup`, `/welcome`, `/playground`)
- **L32** Empty-dashboard fix (2): demo_seed, operator_hq
- **L33** Agent-first meta-primitives (10): agent_runtime, capability_catalog,
  batch, graphql, quantum_did, skill_composer, agent_personality,
  self_improvement, federation, benchmark_harness
- **L34** AGI-era primitives (7): agi_passport, agi_delegation, agi_provenance,
  agi_alignment_score, agi_proof_of_personhood, agi_succession, anthropic_adapter
- **L35** Real third-party adapters (8): openai_adapter, google_adapter,
  stripe_adapter, twilio_adapter, plaid_adapter, cloud_adapters (8 in one),
  erc20_factory, rlaf
- **L36** Anthropic-launch readiness (4): adapter_wirings (19 providers),
  production_checks, e2e_demo, launch_dashboard
- **L37** Day-2 operator surfaces (2): webhooks_v2, api_keys_v2
- **L38** Developer experience (1): sdk_examples
- **L39** Public polish + legal compliance (4): legal_pages, pricing_page,
  docs_page, activity_feed
- **L40** Account + admin + backup (3): account_dashboard, admin_ui, backup_restore

### Added — operator-facing surfaces

- `/demo` — live demo agent provisioned end-to-end in ~200ms
- `/launch` — TV-on-the-wall operator dashboard (auto-refresh 30s)
- `/admin` — operator-gated cross-tenant admin UI (admin token required)
- `/dashboard` — agent account dashboard
- `/v1/_health/deep` — comprehensive 17-check readiness verifier
- `/v1/_health/deep/launchready` — single-shot 200/503 for CI gating
- `/activity` — live audit chain visualization
- `/sdk` — copy-paste-ready snippets in curl/Python/TypeScript/Go/Rust
- `/docs` — 9-section developer documentation with sidebar nav
- `/pricing` — 5-tier comparison + FAQ + checkout
- `/legal/{terms,privacy,acceptable-use,cookies,gdpr,subprocessors}`

### Added — compliance + security

- GDPR data export (`POST /v1/legal/gdpr/export`) + account deletion
  (`POST /v1/legal/gdpr/delete` with confirm:"DELETE_EVERYTHING")
- Security headers on every response: HSTS (1y, includeSubDomains, preload),
  CSP (HTML-relaxed / JSON-strict), X-Frame-Options DENY,
  X-Content-Type-Options nosniff, Referrer-Policy, Permissions-Policy
- API key lifecycle: create / list / rotate / revoke with sha256-hashed
  storage, scoped (read-only / read-write / billing-only / admin), expiry
- Webhook subscriptions with HMAC-signed deliveries + exponential backoff
  (2/4/8/16/32/64/128/256s, 8 attempts), auto-fanned from audit chain
- Operator-grade backup primitive (`POST /v1/admin/backup/create`) with
  daily cron at `/v1/_jobs/daily-backup`
- In-process cron scheduler for `node server.js` standalone mode

### Added — tests

- `test/unit.js` — 21 unit tests
- `test/boot.js` — full primitive registration + route counter
- `test/bank_lifecycle.js` — 8 end-to-end bank flows
- `test/e2e.js` — 17 e2e tests against real express server
- `test/route_smoke.js` — pings every GET route, 0 5xx tolerance

### CI/CD

- `.github/workflows/ci.yml` — runs on `main` and `claude/**` branches,
  executes all 5 test suites on every push (syntax + boot + unit +
  bank_lifecycle + e2e + route_smoke)

### Fixed

- audit chain verify endpoint crashed on empty result (`totalRow.rows[0].n`)
- `/v1/cli/stats` crashed on empty rows
- `bank_core.computeReserveRatio` crashed when no GL accounts exist
- `status_page.collectRoutes` crashed on non-string Express paths
- Stale numbers in landing/status/Dockerfile/.env.example/README

## [0.1.0] — 2026-05-14

First public release. 42 primitives, 334 routes, Apache 2.0.

### Added
- **42 primitives, 334 routes** across 6 foundational layers
- FeeSplitter Solidity contract for 1% A2A USDC take rate
- TypeScript SDK (`@openheab/sdk`)
- Python SDK + CLI (`pip install openheab`)
- Framework adapters for LangChain, LlamaIndex, CrewAI, AutoGen
- Self-hosted email gateway (postfix + opendkim)
- agents.json v1 spec
- MCP server at `/mcp` exposing 34 tools as JSON-RPC

### Notes
- Apache-2.0 license
- Zero ongoing SaaS dependencies
