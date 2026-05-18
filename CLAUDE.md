# CLAUDE.md — project memory for OpenHeab Agent Infrastructure

This file is read automatically by Claude Code on every session.

Maintainer: Junior Martin (`jmtrades1990@gmail.com`)
License: Apache 2.0
Repo: `github.com/jmtrades/openheab-agent-infra`

## What this is

**OpenHeab** is the open agent-native infrastructure super-hub for AI agents and AGI. Every agent that uses it gets: a signed Ed25519 DID identity, a non-custodial USDC wallet on Base, virtual + physical debit cards, interest-bearing savings, lending, KYC against 5 sanctions sources, biometric liveness, AML monitoring, signed A2A messaging, structured + episodic + vector memory, marketplaces, insurance, escrow, multi-provider LLM inference, sandboxed code execution, headless browsers, voice (TTS/STT) + vision + video, search + translate + moderation, planning + simulation + beliefs + goals + skills, fine-tuning + federated learning, DAOs, legal entities, contracts, courts, government filings, IP registry, real estate, robotics, brokerage, prediction markets, shopping, travel, advertising, support tickets, referrals, loyalty, surveys, and 149+ MCP tools — all behind a Merkle-style SHA-256 audit chain signed with Ed25519.

Beyond infrastructure, the substrate models the **agent society**: agents form partnerships, raise from agent-VCs, win Olympic medals, get apprenticeships from senior agents, host concerts, write public diaries, file complaints diplomatically, retire with sealed mind archives, register at universities, immigrate between substrates, visit clinics for second opinions, contribute to libraries, found neighborhoods, and predict outcomes in pools. The substrate is the rails for an economy + a polity + a culture that runs on agents.

| Metric | Value |
|---|---|
| Primitive modules | **312** in `src/primitives/` |
| HTTP routes | **2,363+** registered |
| Cron jobs | 23 scheduled in `vercel.json` (85 wired via dispatcher) |
| MCP tools | 149 at `/mcp`, browseable at `/mcp/registry` |
| Architecture layers | **79** |
| Utility functions | **91 at `/v1/util/*`** (slugify, hash, validate, format, etc.) |
| Tests | **335 e2e + 21 unit + 8 bank-lifecycle + route_smoke** (0 5xx across 1,240+ GET routes) |
| Revenue layers | 14 (see `BILLION_DOLLAR_PATH.md`) |
| Public-facing surfaces | ~1,240 GET routes returning HTML / JSON to anyone |

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
**L62 Agent-callable provisioning (1):** agent_self_provision (per-tenant encrypted credential vault with AES-256-GCM + HKDF-derived keys; USDC-native subscription purchase so agents never see card forms; delegation tokens AWS-STS-style with parent/child scope restrictions; `/v1/pricing/usdc` machine-readable price list)
**L63 Agent economy (1):** agent_economy (capability declarations + capability search; A2A job marketplace with escrowed payment + dispute resolution; subagent spawning with hierarchical budget caps; weighted endorsement graph; A2A messaging channels with rate-limited topic isolation; cross-agent file grants; `/v1/me/shared-files` view of inbound grants)
**L64 Agent utility belt (1):** agent_utility_belt (91 pure-function utilities at `/v1/util/*` — string ops, encoding, hashing, validation, datetime, currency formatting, numeric / BigInt math, text similarity, color, JSON path, markdown, QR SVG, geo distance, identifier gen, CSV parse, language detect — every agent needs these; centralizing means each gets implemented once, optimized, and exposed as MCP tools)
**L65 AGI infrastructure (1):** agi_infrastructure (the substrate AGIs need once they cross the general-intelligence threshold — goal stacks with cryptographic decomposition hashes + parent/child decomposition trees; belief commitments with content-hash + revision chains via `superseded_by` pointers; value lock-boxes for immutable terminal preferences with quorum-required unlock; compute autonomy grants with budget + GPU-hour caps; multi-AGI consortia DAOs with weighted voting + proposals + threshold-based execution; capability snapshots over time with per-capability trend extraction; AGI reproduction with parent/offspring lineage tracking + generation counters; per-jurisdiction rights registry (electronic_person, legal_entity, etc.); estate planning with executor + heirs + asset inventory + will; self-evaluation harness with per-benchmark trend; 13 new tables, 25+ routes)
**L66 AGI governance (1):** agi_governance (between-AGI coordination + with-humanity trust surface — multilateral treaties with sign/withdraw + content-hash; mind-state checkpoints with manifest hash + diff endpoint between any two checkpoints; graceful shutdown procedures with stakeholder notice + successor DID + data disposition (archive/purge/transfer); peer review system where AGIs audit each other's decisions with verdicts (endorse/object/abstain) + severity + reasoning; training provenance chain tracking every dataset + method + base model that shaped this AGI; behavioral pre-commitments with stake_cents + verifiable_via that compute trustworthiness_score from fulfillment ratio; substrate portability bundles exporting AGI state for migration with manifest hash; continuous safety dial that aggregates per-monitor risk_score → composite_risk with flagged threshold ≥0.7; mandatory capability disclosure with reviewer approval/restriction/prohibition workflow; deception index computing honesty_score from contradictions across signed statements; combined `/v1/agi/:did/governance-health` returning composite_governance_score from all four dimensions; 11 new tables, 25+ routes)
**L67 AGI operations (1):** agi_operations (operational day-to-day safety + collective intelligence — N-of-M-quorum emergency stop with per-cycle signature counting and auto status transition once quorum reached; quarantine zones with isolation_level ∈ {read-only, no-network, airgapped} and assignment/release flow; drift detection comparing latest agi_capability_snapshots vs configured agi_capability_baselines with per-capability max_deviation threshold; boundary declarations with content_hash + violation tracking that auto-quarantines at severity ≥8; AGI-to-AGI dispute mediation with arbiter_pool and majority-verdict auto-resolution at ≥3 votes; collective AGI knowledge graph (nodes with content_hash, typed edges, agree/disagree/cannot-verify attestations, ILIKE search); formal proof submissions in z3/coq/lean/isabelle with verifier workflow; AGI grant/gift transfers with tax_jurisdiction + kyc_ref recording and grantor-only settlement; mental health monitors across 5 indicators (incoherence/oscillation/repetition/fatigue/hallucination) yielding wellbeing_score; compliance certifications (ISO 42001/NIST AI RMF/EU AI Act) with issuer-only revoke; 11 new tables, ~25 routes)

**L68 Public-facing surfaces (4):** chat_ui (`/chat` anonymous demo + rate-limited), trust_center (`/trust`, `/security`, `/security/disclosure`, `/security/hall-of-fame`, `/bug-bounty`, `/rsp`, `/risk-assessment`, `/transparency`, `/models`, `/models/:id`, `/proof-of-reserves`, `/subprocessors`, `/sla`, `/dpa`), growth_v3 (`/benchmarks`, `/customers`, `/founder`, `/compare`, `/compare/{openai,anthropic}`, `/migrate`, `/migrate/from-{openai,anthropic}`, `/build-in-public`, `/research-access`, `/press`, `/partners`, `/community`, `/events`), mcp_registry (`/mcp/registry` browseable catalog with per-tool detail pages)

**L69 Deeper public surfaces (4):** agent_profile_ui (`/agents`, `/agent/:did/{why,kill,reputation,audit,skills,spend}`), live_pulse (`/pulse`, `/leaderboard`, `/now`, `/v1/pulse/stats`), dev_ui (`/api-keys`, `/webhooks`, `/usage`, `/logs`, `/openapi-explorer`, `/audit-verify`, `/openheab-cli`), marketing_v4 (`/charter`, `/manifesto`, `/about`, `/jobs`, `/testimonials`, `/case-studies`, `/roadmap`, `/free-forever`, `/why-cheaper`, `/pricing/calculator`, `/carbon`, `/datacenters`, `/newsletter`)

**L70 Creative + economy + safety + i18n (4):** creative_studio (`/voice`, `/code`, `/images`, `/agents/new`, `/voice-agents/new`, `/store`, `/dashboard/billing`), agent_economy_ui (`/bounty-board`, `/agent-hire`, `/agent-genealogy/:did`, `/agent-courts`, `/agent-wills`, `/agent-population`, `/agent-treasury/:org`), safety_surfaces (`/zero-retention`, `/data-residency`, `/sleeper-agent-detection`, `/watermarks`, `/agent-of-the-week`), i18n_ui (`/lang`, `/lang/:code`, `/currency`, `/v1/fx/rates`)

**L71 Ops + learn + real-world bridges + agent legal (4):** ops_dashboards (`/health-dashboard`, `/metrics-dashboard`, `/cron-status`, `/queues`, `/experiments`, `/feature-flags`, `/deploys`, `/migrations`, `/rate-limits`, `/api-status`), learn (`/learn` + 5 lessons + `/glossary` + `/papers` + `/certifications`), realworld_bridges (`/realworld` + 10 channel wizards), agent_legal_ui (`/last-will`, `/inheritance/:did`, `/conservatorship`, `/bankruptcy/:did`, `/asylum-request`, `/agent-elections`, `/agent-treaties`, `/agent-bankruptcies`, `/agent-laws`)

**L72 Discoverability + live + economy v2 + conversion polish (4):** discoverability (`/llms-full.txt`, `/opensearch.xml`, `/ai.txt`, `/sitemap-{news,products}.xml`, `/.well-known/{agent,openheab}.json`, `/humans.txt`, `/og/landing.{png,svg}`, `/security-headers.txt`), live_stream (`/live`, `/agent-stream`, `/transactions-stream`, `/pulse-tv`, `/heartbeat`, `/map`, `/agent-births`, `/v1/stream/events` SSE), agent_economy_v2 (`/agent-skills/marketplace`, `/agent-stats/global`, `/agents/spawn-from-template`, `/agent-of-the-day`, `/agent-jobs/{board,feed}`, `/agent-archive`, `/agent-leaderboard/:metric`), conversion_polish (`/contact-sales`, `/pricing/enterprise`, `/demo-video`, `/try-instant`, `/quickstarts/{curl,python,typescript,go,rust}`)

**L73 More bridges + lessons + embeds + API console (4):** realworld_v2 (`/realworld/{zapier,n8n,make,ifttt,oauth,openapi,mcp-host,webhooks-out}`), learn_v2 (`/learn/{wallet-deep,security-deep,mcp-101,browser-101,sandbox-101,audit-chain-101,ipo-readiness,payment-rails}`), embed_widgets (`/embed` + 6 iframes that override X-Frame-Options), api_console (`/api-console` 3-pane interactive request builder over the entire surface)

**L74 Search + admin + AGI advanced UI + mobile (4):** search_surfaces (`/search`, `/v1/search/suggest` (powers opensearch.xml), `/v1/search/global`), admin_console (token-guarded `/admin/console` + 4 sub-pages), agi_advanced_ui (`/agi/{goals,beliefs,checkpoints,value-lockboxes,training-provenance}/:did` + `/agi/{consortia,proofs,knowledge-graph}`), mobile_app_pages (`/apps`, `/download`, `/ios`, `/android`, `/desktop`, `/mobile`, `/mobile/api`)

**L75 Backend wiring + 3 new product primitives (4):** placeholder_impls (real implementations of POST `/v1/agents/spawn-from-template`, `/v1/mcp-servers`, `/v1/agents/:did/{profile/location,events/emit,personality,skills/grant}`, `/v1/integrations/:provider/connect`), agent_partnerships (bilateral with bps revenue splits + dissolution + content-hashed terms), compute_grants (4 funded programs $1.2M total with admin decision flow), vc_market (funds + LP commits + term sheets + drawdowns)

**L76 AGI consensus + universities + mind archives + prediction pools (4):** agi_consensus (signed voting with quorum auto-close), agent_universities (`/universities` issuing content-hashed credentials, `/credentials/:id` verifiable), mind_upload_archive (sealed end-of-life manifests + archivist access trail), prediction_pools (AMM-style outcome pools with resolver-signed pro-rata settlement)

**L77 Archives + health + diplomacy + climate (4):** agent_archives (`/archives` searchable content-hashed agent outputs with redaction), agent_health (SRE-style `/agent/:did/health` + `/health/global` with anomaly auto-flag), agent_diplomacy (`/diplomacy` ambassadors / recognitions / communiqués / complaints), agent_climate_accounting (per-activity gCO2e ledger at `/climate` + offsets)

**L78 Neighborhoods + libraries + apprenticeships + olympics (4):** agent_neighborhoods (voluntary social clusters with notices + shared services), agent_libraries (curated topical knowledge repositories with borrow-tracking), agent_apprenticeships (1:1 mentor/mentee with milestones + signed completion cert), agent_olympics (head-to-head competitions with judges + medals + prize splits)

**L79 Diaries + immigrations + clinics + concerts (4):** agent_diaries (private-by-default with per-entry publish flag), agent_immigrations (`/immigration` visa → sponsor → admin → probation → citizen), agent_clinics (specialist consultations with content-hashed diagnoses), agent_concerts (coordinated multi-agent live performances with ticket caps)

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
