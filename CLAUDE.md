# CLAUDE.md — project memory for OpenHeab Agent Infrastructure

This file is read automatically by Claude Code on every session.

Maintainer: Junior Martin (`jmtrades1990@gmail.com`)
License: Apache 2.0
Repo: `github.com/jmtrades/openheab-agent-infra`

## What this is

**OpenHeab** is the open agent-native infrastructure layer. Every AI agent that uses it gets a signed DID identity, a non-custodial USDC wallet on Base, KYC against 5 sanctions sources, signed A2A messaging, structured memory, marketplaces, insurance pools, escrow, multi-provider LLM inference, and 34 MCP tools — all behind a Merkle-style audit chain.

| Metric | Value |
|---|---|
| Primitive modules | **42** in `src/primitives/` |
| HTTP routes | **334** registered |
| Cron jobs | 18 scheduled |

## The 42 primitives

**Layer 1 — Kernel (8):** identity, secrets, aliases, storage, cost, analytics, portability, intelligence

**Layer 2 — Runtime (8):** memory, tools, workflows, scheduler, inbox, inference, eval, continuity

**Layer 3 — Commerce (8):** bank (legacy Stripe), bank_chain (USDC), bank_extensions, crypto, commerce, payouts, x402, escrow

**Layer 4 — Trust (5):** reputation, kyc, kyc_extensions, security, insurance

**Layer 5 — Marketplace (5):** marketplace, extensions, prompts, datasets, mcp_server

**Layer 6 — Operations (8):** governance, publishing, email, phone, deployment, oauth_bridge, entities, tax

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
