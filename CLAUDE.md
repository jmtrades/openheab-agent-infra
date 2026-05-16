# CLAUDE.md — project memory for OpenHeab Agent Infrastructure

This file is read automatically by Claude Code on every session.

Maintainer: Junior Martin (`jmtrades1990@gmail.com`)
License: Apache 2.0
Repo: `github.com/jmtrades/openheab-agent-infra`

## What this is

**OpenHeab** is the open agent-native infrastructure super-hub for AI agents and AGI. Every agent that uses it gets: a signed Ed25519 DID identity, a non-custodial USDC wallet on Base, virtual + physical debit cards, interest-bearing savings, lending, KYC against 5 sanctions sources, biometric liveness, AML monitoring, signed A2A messaging, structured + episodic + vector memory, marketplaces, insurance, escrow, multi-provider LLM inference, sandboxed code execution, headless browsers, voice (TTS/STT) + vision + video, search + translate + moderation, planning + simulation + beliefs + goals + skills, fine-tuning + federated learning, DAOs, legal entities, contracts, courts, government filings, IP registry, real estate, robotics, brokerage, prediction markets, shopping, travel, advertising, support tickets, referrals, loyalty, surveys, and 115+ MCP tools — all behind a Merkle-style SHA-256 audit chain signed with Ed25519.

| Metric | Value |
|---|---|
| Primitive modules | **242** in `src/primitives/` |
| HTTP routes | **1,741+** registered |
| Cron jobs | 21 scheduled (78 wired via dispatcher) |
| MCP tools | 149 at `/mcp` |
| Architecture layers | 47 |
| Tests | 122 passing + route smoke (0 5xx across 790 GET routes) |
| Revenue layers | 14 (see `BILLION_DOLLAR_PATH.md`) |

## The 135 primitives (19 layers)

**L1 Kernel (8):** identity, secrets, aliases, storage, cost, analytics, portability, intelligence
**L2 Runtime (8):** memory, tools, workflows, scheduler, inbox, inference, eval, continuity
**L3 Commerce (11):** bank, bank_chain, bank_extensions, bank_account, crypto, commerce, payouts, x402, escrow, cards, savings
**L4 Trust (11):** reputation, kyc, kyc_extensions, security, insurance, biometrics, aml, fraud, notary, tripwires, reversibility
**L5 Marketplace (5):** marketplace, extensions, prompts, datasets, mcp_server
**L6 Operations (8):** governance, publishing, email, phone, deployment, oauth_bridge, entities, tax
**L7 Perception (6):** sandbox, browser, voice, vision, video, search
**L8 Knowledge (6):** documents, maps, knowledge, translate, moderation, fact_check
**L9 Web3 finance (6):** multisig, lending, defi, tokens, nft, bridges
**L10 Infrastructure (6):** dns, hosting, database, ipfs, cache, cdn
**L11 AGI cognition (6):** planning, simulation, beliefs, goals, skills, causal
**L12 AGI ops (3):** interpretability, fine_tuning, federated_learning
**L13 Org / business (6):** crm, projects, leads, outreach, forms, dao_factory
**L14 Business essentials (8):** chat, invoicing, compute, news, calendar, billing, contracts, courts
**L15 Domain (6):** health, passport, logistics, property, robotics, api_management
**L16 Revenue commerce (8):** brokerage, prediction_markets, shopping, travel, advertising, media, ratings, booking
**L17 Developer infra (8):** github, ci_cd, monitoring, error_tracking, feature_flags, experiments, webhooks, events
**L18 AGI learning + gov/legal (8):** learning, voice_agents, labs, gov_filing, legal_research, court_records, ip_registry, climate
**L19 Customer service + community (8):** support, referrals, loyalty, surveys, recruiting, supply_chain, licensing, benchmarks
**L20 Org / billing / commerce ops (4):** org, subscriptions, metering, revenue
**L21 Enterprise readiness (4):** sso, rbac, compliance_pack, credits
**L22 Growth + distribution (4):** onboarding, dashboard, embed, public_directory
**L23 Channel + payments (4):** partnerships, whitelabel, ach, quotes
**L24 Realtime (1):** realtime (SSE event stream)
**L25 Full email + KYC depth (2):** email_advanced (threading, attachments, aliases, filters, templates, lists/newsletters, analytics, suppression, calendar invites, search, snooze, autoresponder), kyc_advanced (KYB orgs, ID document verification, UBOs, address proofs, source-of-funds, Travel Rule FATF, adverse media, country+industry risk scoring, SAR generation, ZK proofs, continuous monitoring)
**L26 Marketing + SEO + Blog (3):** blog (8 seed posts + RSS + double-opt-in newsletter signup + admin authoring), marketing (lead capture with UTM attribution, conversion tracking, lead magnets, comparison pages, solution pages by use case, /about, /customers, /jobs, /press, /security, /status, /changelog, /roadmap), seo (comprehensive sitemap index, robots.txt, security.txt RFC 9116, humans.txt, llms.txt + llms-full.txt, site.webmanifest, favicon.svg, og.svg, agents.json, JSON-LD Organization+SoftwareApplication+FAQPage+SearchAction+BreadcrumbList helpers)
**L27 Conversion + AGI-future + execution (7):** signup (real Stripe Checkout flow + provisioning identity+org+wallet+API key in one POST + Stripe webhook handlers — THE #1 revenue gate), negotiation (A2A bid/ask/counter/accept protocol with escrow + dispute), orchestration (Airflow-for-agents DAG with cron-driven node execution), constitution (declarative agent rules with cryptographic enforcement + binding + violation tracking), safety (AGI safety classifier with 14 attack categories, auto-quarantine, red-team runs), growth_plan ($10M MRR/90-day execution dashboard with weekly targets + milestones + linear projection), cli (downloadable CLI tool at /cli/install.sh + /cli/openheab — `npx openheab signup`)
**L28 Verticals + AGI-future + IPO (9):** verticals (10 industry-specific compliance shims: healthcare/HIPAA, education/FERPA, defense/ITAR, government/FedRAMP, finance/FINRA, insurance/NAIC, pharma/21CFR, aviation/FAA, legal/ABA, energy/NERC), multimodal (text+image+audio+video+sensor fusion routed to cheapest provider supporting all modalities), capital_markets (cap tables with vesting, bonds, funding rounds, dividends, agent-issued equity), agent_market (hire-an-agent: RFPs/bids/escrowed engagement/reviews; 20% take rate), evals (8 seed benchmarks + leaderboards), integrations (Slack/Discord/Teams/WhatsApp/Telegram/SMS/iMessage with encrypted access tokens), realtime_ws (long-poll bidirectional channels), mobile (device enrollment, push notifications, app version checks, deep links via Apple/Google universal links, public agent profile pages /a/:did_or_slug), ipo_readiness (19 ICFR controls, board-pack generator, S-1/10-K/10-Q filing tracker, employee equity admin with vesting+cliff, insider trading windows, readiness score)
**L29 Design + workflows + adapters + CS + i18n + incidents (6):** design_system, workflow_builder, provider_adapters, customer_success, i18n, status_incidents
**L30 In-house "no third party" core (8):** bank_core (double-entry general ledger replacing Mercury/Stripe Treasury — FBO accounts, reserve mgmt, capital adequacy ratio, balance sheet, public proof-of-reserves), email_core (DKIM/SPF/DMARC signing+verification replacing SendGrid — RSA-2048 keypair gen, MTA queue with backoff, IMAP-style folders, Bayesian spam scorer), kyc_core (canonical sanctions DB + Levenshtein fuzzy match + decisioning rules replacing Onfido/Persona/Sumsub), inference_core (OpenAI-compatible chat completions + embeddings + fine-tuning replacing Anthropic/OpenAI — 5 model tiers, pluggable backend), insurance_core (full underwriting + claims + reserves + reinsurance replacing Embroker/Vouch — 5 products, premium calc with KYC risk multiplier), audit_core (continuous evidence collection + Ed25519-signed independent attestations replacing Vanta/Drata — auditor portal with token-scoped access), payment_rails (real NACHA file gen for ACH + SWIFT MT103 + SEPA pain.001 XML replacing Modern Treasury/Dwolla/Wise — full file generation with Luhn-correct entry hashes), card_core (Luhn-valid PAN gen + AES-256-GCM PAN storage + ISO 8583 auth/capture/reverse/chargeback flow replacing Stripe Issuing/Marqeta/Lithic — interchange revenue auto-recorded)
**L31 Operator-facing demo surface (3):** quickstart (`/setup` wizard + `/welcome` tour + `/playground` live API explorer)
**L32 Empty-dashboard fix (2):** demo_seed (`/v1/admin/demo/seed` populates 50 agents, 10 orgs, 100 transactions for instant "alive" dashboards), operator_hq (`/v1/admin/hq` cross-tenant operator overview)
**L33 Agent-first meta-primitives (10):** agent_runtime, capability_catalog, batch, graphql, quantum_did, skill_composer, agent_personality, self_improvement, federation, benchmark_harness
**L34 AGI-era primitives (7):** agi_passport (cross-lab portable agent identity), agi_delegation (hierarchical scope-restricted authority), agi_provenance (Ed25519-signed decision audit), agi_alignment_score (continuous behavioral scoring), agi_proof_of_personhood (Sybil resistance via biometric+social+stake+RLAF), agi_succession (estate planning for retiring agents), anthropic_adapter (real Anthropic API forwarder with budget enforcement)
**L35 Real third-party adapters (8):** openai_adapter, google_adapter, stripe_adapter, twilio_adapter, plaid_adapter, cloud_adapters (Modal+E2B+Browserbase+Sentry+Datadog+PagerDuty+GitHub+Slack), erc20_factory (real on-chain ERC-20 deploy via viem), rlaf (Reinforcement Learning from Agent Feedback)
**L36 Anthropic-launch readiness (4):** adapter_wirings (19 more provider HTTP forwarders in one file: Mistral, Together, Modern Treasury, Wise, SendGrid, Onfido, Persona, Sumsub, Comply Advantage, Vercel, Cloudflare DNS, AWS S3 presign, Alchemy webhooks, Discord, Vanta, Drata, Carta, Teams, WhatsApp), production_checks (`/v1/_health/deep` comprehensive readiness verifier — DB roundtrip + audit chain integrity + in-house cores + adapters + tables + routes + crons + secrets + bank ledger consistency), e2e_demo (`/demo` single shareable URL provisioning real demo agent end-to-end in ~200ms), launch_dashboard (`/launch` TV-on-the-wall operator HTML — substrate metrics + 24h activity + revenue + adapter status, auto-refreshes every 30s)
**L37 Day-2 operator surfaces (2):** webhooks_v2 (agents subscribe to event streams via `POST /v1/agents/:did/webhooks/subscribe` with HMAC-signed deliveries + exponential backoff retries, audit chain auto-fans-out to subscribers), api_keys_v2 (full key lifecycle: create/list/rotate/revoke with sha256-hashed storage, scoped to read-only/read-write/billing-only/admin, expiry support, raw key only shown once at creation)
**L38 Developer experience (1):** sdk_examples (`/sdk` polished page with curl/Python/TypeScript/Go/Rust snippets for signup/inference/transfer/KYC/webhooks/MCP — copy buttons + language picker)
**L39 Public polish + legal compliance (4):** legal_pages (Terms, Privacy, Acceptable Use, Cookies, GDPR rights — plus self-serve `/v1/legal/gdpr/export` and `/v1/legal/gdpr/delete` endpoints), pricing_page (`/pricing` polished 5-tier comparison with direct checkout buttons + FAQ + usage-based add-ons table), docs_page (`/docs` documentation surface with sidebar nav, 9 sections, in-page search), activity_feed (`/activity` live-refreshing audit chain visualization showing recent substrate events with stat counters)
**L40 Account + admin + backup (3):** account_dashboard (`/dashboard` polished agent home — wallet, KYC, cards, recent events, API keys, webhooks all live from Postgres; with sign-in prompt when no DID supplied), admin_ui (`/admin` operator-gated cross-tenant dashboard — agent counts, 24h activity, top spenders, KYC tier distribution, adapter status, recent audit events, admin actions), backup_restore (`POST /v1/admin/backup/create` dumps every table to signed JSON bundle with sha256 digest; `GET /v1/admin/backup/list`; daily cron job)
**L41 Public status + email templates (2):** status_uptime (`/status` polished public status page like status.openheab.com — per-component health, 24h uptime %, latency, active + recent incidents, auto-refresh 60s; admin endpoints to record checks + declare/resolve incidents; cron job for self-checks), email_templates (transactional templates for signup_welcome / billing_receipt / security_alert / kyc_approved / password_reset; render HTML + text; preview endpoint at `/v1/email-templates/:name/preview`; send-via-internal-key endpoint logging to transactional_emails)
**L42 First-time user tour (1):** welcome_tour (`/tour` polished 6-step interactive walkthrough — signup → profile → inference → wallet → MCP → done. Each step shows copy-paste curl + JS snippets, progress bar, "I'm done" advance, breadcrumb step nav. The page every new visitor lands on after signup)

## Critical infrastructure files

| Path | What it is |
|---|---|
| `src/integration.js` | Master wiring. Requires all primitives, runs `migrateAll(pool)`, calls each `registerXRoutes`, holds `makeAuditChainAdapter`, `makeVerifyAgentAuth`. |
| `api/index.js` | Vercel serverless entrypoint. Lazy-inits the express app on cold start. |
| `server.js` | Local server entrypoint. |
| `src/cron_auth.js` | `registerCron(app, path, handler)` — wraps a handler with cron auth. |
| `src/rate_limit.js` | Postgres-backed distributed rate limiter with in-memory fallback. |
| `src/observability.js` | Request IDs, JSON logging, CORS, Prometheus metrics, 404 handler. |
| `src/status_page.js` | The HTML homepage at `/`. Also serves `/openapi.json`. |
| `src/landing.js` | Marketing landing page. |
| `src/discovery.js` | `/sitemap.xml`, `/robots.txt`, `/llms.txt`, `/.well-known/agents.json`. |
| `src/chain_crypto.js` | Pure-stdlib Solana + Bitcoin keypair + address derivation. |

## Conventions

- **Zod for every mutating request.**
- **Audit chain on every state change.** `auditChain.append({ event_type, ... })`.
- **Idempotency.** Accept `X-Idempotency-Key`.
- **Signature verification.** `verifyAgentAuth(req, did)` — signature over `METHOD\nPATH\nSHA256(body)`.
- **256-bit values always as strings.** `amount_raw`, `price_usdc_raw` are NUMERIC(78,0) in Postgres.
- **Cron handlers idempotent.** `registerCron(app, path, handler)` accepts both POST and GET.

## How to test

```bash
node test/unit.js
node test/boot.js
node test/integration.js
```

## How to deploy

```bash
./deploy.sh
```

## Revenue streams (all coded)

1. Inference markup (10% on every LLM call)
2. Extensions marketplace (30% platform / 70% publisher)
3. USDC wallet fees (1% via FeeSplitter)
4. Subscriptions ($19/$99/$349/$2,499)
5. Prompt marketplace (30%)
6. Dataset marketplace (30%)
7. Tool featured listings ($50/mo)
8. A2H payout fees (0.5%)
