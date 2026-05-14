# Changelog

All notable changes follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versions follow [SemVer 2.0.0](https://semver.org/).

## [0.1.0] — 2026-05-14

First public release. OpenHeab substrate complete.

### Added
- **42 primitives, 334 routes**
  - Layer 1 — Kernel: identity, secrets, aliases, storage, cost, analytics, portability, intelligence
  - Layer 2 — Runtime: memory, tools, workflows, scheduler, inbox, inference, eval, continuity
  - Layer 3 — Commerce: bank, bank_chain, bank_extensions, crypto, commerce, payouts, x402, escrow
  - Layer 4 — Trust: reputation, kyc, kyc_extensions, security, insurance
  - Layer 5 — Marketplace: marketplace, extensions, prompts, datasets, mcp_server
  - Layer 6 — Operations: governance, publishing, email, phone, deployment, oauth_bridge, entities, tax
- **FeeSplitter Solidity contract** for 1% A2A USDC take rate
- **TypeScript SDK** (`@openheab/sdk`)
- **Python SDK + CLI** (`pip install openheab`)
- **Framework adapters** for LangChain, LlamaIndex, CrewAI, AutoGen
- **Reference agents** demonstrating common patterns
- **Self-hosted email gateway** (postfix + opendkim)
- **agents.json v1 spec**
- **MCP server** at /mcp exposing 34 tools as JSON-RPC

### Notes
- Apache-2.0 license
- Zero ongoing SaaS dependencies (uses Neon Postgres + Vercel + USDC on Base + OpenAI for embeddings)
