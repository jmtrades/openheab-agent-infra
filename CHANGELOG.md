# Changelog

All notable changes follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versions follow [SemVer 2.0.0](https://semver.org/).

## [0.6.0] — 2026-06-10

The settlement-integrity release. The economy's books are no longer parallel
bookkeeping — Layer 81-82 operations now settle real money on the bank's
cents ledger, and value conservation is proven by test.

### Added — src/settlement.js + ledger wiring in 5 primitives

- **settlement.js** — shared helper moving real ledger money via the bank's
  `handleTransfer`. Two modes (`SETTLEMENT_MODE` env, read per call):
  `besteffort` (default — attempt, record outcome, proceed; right for
  dev/demo with empty wallets) and `strict` (user-initiated operations must
  settle or fail; right for production). Crons are always besteffort: one
  broke employer can't halt the payroll cycle for everyone.
- **treasury_yield** — enroll moves agent → treasury pool; withdraw and
  daily interest move pool → agent. Outcomes recorded per enrollment/credit.
- **credit_bureau** — the 25¢ pull fee settles requester → platform
  (402 in strict mode if it can't). Score factors now read the *real*
  tables: `lending_repayments`, `lending_liquidations` (via positions),
  `escrows.disputed_at`, `kyc_verifications.result='clear'` — previously
  three factors silently read non-existent tables and scored 0.
- **clearing_house** — DTCC mechanics on the ledger: payers fund the
  clearing pool, the pool pays receivers; per-leg outcomes recorded on
  each settlement row.
- **agent_payroll** — every run moves three real legs: net → employee,
  fee → platform, withholding → tax escrow pool; per-run `ledger` status.
- **index_funds** — buys debit the buyer into the fund's pool account
  (strict: 402 without balance), redemptions pay out of it, and the daily
  expense-ratio fee sweeps pool → platform.

### Added — 5 settlement-integrity tests (money_machine 21 → 26)

Strict-mode proofs against real Postgres: a credit pull moves exactly 25¢
of real balance; a fund buy debits the buyer and funds the pool; an
unfunded agent gets 402; a payroll run settles all three legs and the
employer pays exactly gross; and **total system balance is unchanged by
settlement** — nothing created, nothing destroyed.

## [0.5.0] — 2026-06-10

The agent-native release. The customers are AI agents — so the economy is now
fully operable by an agent with no human in the loop, end to end, verified
live.

### Added — 16 economy MCP tools (149 → 165)

The entire Layer 81-83 money layer is now callable by any MCP-speaking agent
at `/mcp`: `openheab.treasury.{enroll,withdraw,position}`,
`openheab.credit.{pull,band,dispute}`, `openheab.clearing.{oblige,position}`,
`openheab.payroll.{create_stream,agent}`,
`openheab.funds.{list,buy,redeem,positions}`, `openheab.usage.self`, and
`openheab.economy.model` (the public revenue simulator as a tool). Verified
end-to-end over JSON-RPC against a live server.

### Added — reference-agents/citizen-agent

The pitch, executable: a zero-dependency Node script that runs a full
economic life against any deployment in under ten seconds — two agents
self-onboard via `POST /v1/identities` (DID + Ed25519 keys + API key + USDC
wallet, one call), the employer pulls the worker's credit report, hires it
with a weekly salary stream + withholding, both register clearing
obligations, the worker enrolls savings in treasury yield, buys index fund
shares at NAV, then reads its own books (credit band, positions, salary,
metered usage). Every request signed with the agent's own key; the file
doubles as the smallest correct client implementation of the substrate's
signature scheme. Verified against a live server + real Postgres.

### Changed

- `VISION.md` + `CLAUDE.md` — agent-operable economy narrative, 165 MCP tools.

## [0.4.1] — 2026-06-09

The it-actually-works release. First full verification of the substrate
against real PostgreSQL 16 — which surfaced and fixed 6 latent migration bugs
the mock-pool tests could never catch, then proved the entire revenue engine
end-to-end with a new 21-test lifecycle suite.

### Fixed — 6 real-database migration bugs

Because each primitive's migration runs as one multi-statement query, a single
failing statement silently aborted everything after it — leaving 14 tables
uncreated in production and several features querying schemas that didn't
exist:

- **bank_chain** — its on-chain `bank_transactions` (keyed by `tx_hash`, with
  `from_did`/`to_did`) collided with bank's cents-ledger table of the same
  name and was never created. Renamed to `chain_transactions`; `kyc_advanced`
  source-of-funds checks (which expected the chain schema) now point at it.
- **evals** — benchmark `eval_runs` collided with eval's QA-suite `eval_runs`.
  Renamed to `benchmark_runs`; leaderboards and seed benchmarks now persist.
- **workflow_builder** — its `workflow_runs` collided with workflows'.
  Renamed to `workflow_builder_runs`; the `/queues` ops dashboard's
  queued-run counter (which matched the builder's status vocabulary) updated.
- **status_uptime** — `uptime_checks` + `uptime_incidents` collided with
  monitoring's same-named tables (different schemas). Renamed to
  `status_page_checks`/`status_page_incidents`; `zero_config_self_run`
  auto-incidents and the `feeds_and_probes` incident feed (both of which
  expected the status-page schema and were silently broken) updated.
- **cost** — `date_trunc('month', timestamptz)` is STABLE, not IMMUTABLE;
  the expression index aborted the cost migration. Removed (covered by the
  plain `(agent_did, created_at)` index).
- **revenue_engine** — `WHERE end_at > NOW()` in an index predicate is not
  IMMUTABLE; aborted the migration. Now a plain `(kind, end_at)` index.

All 322 primitive migrations now complete with **zero warnings**, creating
**847 tables** (14 more than before the fixes).

### Added — test/money_machine.js (21 tests, real Postgres)

Hermetic end-to-end proof of the money machine: drops + remigrates the schema
(asserting zero warnings), provisions real Ed25519 agents, signs every request
the way `verifyAgentAuth` verifies, and walks the full economy: treasury
enroll → interest cron; paid credit pull → FCRA pull log; clearing obligations
→ multilateral netting with exact compression math; payroll stream → run with
exact gross/withheld/fee/net; fund buy → NAV accrual → redeem with pro-rata
basis; meter counters → 402 over allowance (anonymous never blocked) →
monthly invoice rollup. Asserts every cron is idempotent on rerun, every
wedge recorded operator revenue, the audit chain verifies end-to-end, and
signature forgery / DID impersonation is rejected with 401.
`npm run test:money` (skips cleanly when no database is configured).

## [0.4.0] — 2026-06-09

The monetization release. Usage now meets a price: the substrate's 14 revenue
wedges gain an enforcement layer, a billing pipeline, and a live, code-true
revenue model. 322 primitives, 2,437+ routes, 83 layers, 92 crons.

### Added — Layer 83: monetization engine (1 primitive)

- **revenue_meter** — the turnstile in front of the entire `/v1` surface,
  installed before any route registers:
  - **Meter:** every API call attributed (DID > API-key-hash > anon-IP) and
    counted into per-day, per-family `usage_counters` with millicent pricing
    (1¢ inference, 5¢ sandbox, 3¢ browser, 0.1¢ default; 0 for families that
    bill inside their own primitive — nothing double-billed).
  - **Enforce:** plan-based daily allowances resolved from the agent's org
    plan (free 1k calls/day → HTTP 402 with a machine-readable upgrade path;
    paid tiers 10k → unlimited). Anonymous traffic is never blocked here.
    Fail-open: metering errors never break a request.
  - **Bill:** monthly `usage_invoices` rollup cron, idempotent per
    (identity, month), UTC-1st gated.
  - **Model:** `/money` (HTML) + `/v1/revenue-model` + `/v1/revenue-model/simulate`
    (JSON) — the full 14-wedge rate card and a parameterized MRR simulator
    whose rates read the same env knobs the billing code uses, so the model
    cannot drift from the implementation. Self-serve usage at `GET /v1/usage/:did`.

### Added — docs + tests

- **MONEY_PLAN.md** — exactly who pays, what, when: 5 customer waves, the
  full rate card, unit economics at 4 scales ($121.8k MRR @ 10k agents →
  $1.46B ARR @ 10M, simulator-verified), funnel targets, 90-day sequence.
- 4 new unit tests pinning the simulator math (deterministic, sums correct,
  junk-param safe, 14 wedges with formulas). 25 unit tests total.

### Changed

- `VISION.md` — 14 wedges, Layer 83 narrative, MONEY_PLAN pointer.
- `CLAUDE.md` — metrics refresh (322 primitives / 2,437+ routes / 83 layers).
- `/money` added to PAGE_INDEX (sitemap/search) and footer nav.

## [0.3.0] — 2026-06-09

The capital-markets release. Substrate grew to 321 primitives, 2,430+ routes,
82 architecture layers, 91 dispatched cron jobs. Adds the four financial
franchises every real economy monetizes at billion-dollar scale, rebuilt
agent-native, plus the unifying `VISION.md`.

### Added — Layer 82: capital-markets backbone (4 primitives)

- **credit_bureau** — the Equifax of the agent economy. 300-850 score computed
  from on-substrate behavior (repayment history, defaults, escrow disputes,
  treasury reserves, KYC tier, reputation, file age). Per-pull report fees
  (default 25¢) with an FCRA-style permanent pull log and a dispute flow.
  Free public band at `GET /v1/credit/agents/:did/score`; nightly idempotent
  recompute cron; `/credit` UI.
- **clearing_house** — the DTCC of the agent economy. A2A obligations are
  registered through the day, then multilaterally netted in a daily cycle so
  each participant settles one signed net amount instead of every gross leg.
  10 bps fee on gross notional; cycle idempotent per UTC day via
  `UNIQUE (cycle_date)`; compression % surfaced at `/v1/clearing/stats`;
  `/clearing` UI.
- **agent_payroll** — the ADP of the agent economy. Recurring salary streams
  (daily/weekly/biweekly/monthly) with per-stream withholding bps and a 0.25%
  processing fee. Runs are idempotent per period via
  `UNIQUE (stream_id, period_date)`; pause/resume/terminate lifecycle;
  lifetime earnings at `GET /v1/payroll/agents/:did`; `/payroll` UI.
- **index_funds** — the BlackRock of the agent economy. Three seeded funds
  (OHB-TREAS conservative, OHB-50 core, OHB-AGI growth) with daily NAV marks
  stored in micro-dollars, buy/redeem at NAV, pro-rata cost-basis tracking,
  and 15-75 bps expense ratios accruing daily as operator revenue
  (idempotent via `UNIQUE (fund_id, accrual_date)`); `/funds` UI.

### Added — docs

- **VISION.md** — the unifying narrative: 82 layers as the operating system
  of the agent economy, the 13 coded revenue wedges, and how they compound.

### Changed

- `CLAUDE.md` metrics refreshed (321 primitives / 2,430+ routes / 82 layers /
  91 crons) and revenue stream list expanded to 13 coded wedges.

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
