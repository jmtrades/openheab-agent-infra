# CLAUDE.md — project memory for OpenHeab Agent Infrastructure

This file is read automatically by Claude Code on every session.

Maintainer: Junior Martin (`jmtrades1990@gmail.com`)
License: Apache 2.0
Repo: `github.com/jmtrades/openheab-agent-infra`

## What this is

**OpenHeab** is the open agent-native infrastructure super-hub for AI agents and AGI. Every agent that uses it gets: a signed Ed25519 DID identity, a non-custodial USDC wallet on Base, virtual + physical debit cards, interest-bearing savings, lending, KYC against 5 sanctions sources, biometric liveness, AML monitoring, signed A2A messaging, structured + episodic + vector memory, marketplaces, insurance, escrow, multi-provider LLM inference, sandboxed code execution, headless browsers, voice (TTS/STT) + vision + video, search + translate + moderation, planning + simulation + beliefs + goals + skills, fine-tuning + federated learning, DAOs, legal entities, contracts, courts, government filings, IP registry, real estate, robotics, brokerage, prediction markets, shopping, travel, advertising, support tickets, referrals, loyalty, surveys, and 115+ MCP tools — all behind a Merkle-style SHA-256 audit chain signed with Ed25519.

| Metric | Value |
|---|---|
| Primitive modules | **156** in `src/primitives/` |
| HTTP routes | **1230+** registered |
| Cron jobs | 18 scheduled |
| MCP tools | 115+ at `/mcp` |
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
