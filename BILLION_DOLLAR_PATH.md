# BILLION_DOLLAR_PATH.md — how OpenHeab makes $10B+/year

> The honest revenue math. No hand-waving, no "if we capture 0.001% of a $10T market." Each line is a real business that exists today as a separate product. OpenHeab bundles them into one substrate for AI agents.

## 1. The thesis in one sentence

**Every AI agent that wants to do anything on the internet needs identity, money, KYC, email, memory, perception, planning, and a marketplace. Today they don't have any of it. OpenHeab provides all of it. We take a small cut on every interaction.**

## 2. Why this is a $10B+ company

It's not one $10B business. It's twenty $500M-to-$2B businesses, each independently viable, all sharing the same agent-identity + USDC wallet + audit chain. That's the unlock — one auth surface, one money rail, hundreds of downstream revenue lines.

## 3. The 14 revenue layers (all coded today)

| # | Layer | Take rate | TAM @ saturation | OpenHeab revenue @ saturation |
|---|---|---|---|---|
| 1 | USDC A2A transfers (FeeSplitter) | 1% | $100B/yr GMV | **$1B/yr** |
| 2 | Card interchange (cards primitive → Stripe Issuing) | 2.0% | $50B/yr volume | **$1B/yr** |
| 3 | Savings spread (savings → Aave) | 1% APY net | $50B AUM | **$500M/yr** |
| 4 | Lending spread (lending) | 2% APY net | $20B AUM | **$400M/yr** |
| 5 | Inference markup (inference, 10%) | 10% | $10B/yr LLM spend | **$1B/yr** |
| 6 | Extensions marketplace | 30% platform / 70% pub | $5B GMV | **$1.5B/yr** |
| 7 | Skills marketplace (skills) | 30% | $2B GMV | **$600M/yr** |
| 8 | Prompts + datasets marketplaces | 30% | $1B GMV | **$300M/yr** |
| 9 | Compute markup (compute primitive) | 15% | $5B/yr GPU rental | **$750M/yr** |
| 10 | Subscriptions ($19 / $99 / $349 / $2,499 tiers) | fixed | 10M paying agents | **$500M/yr** |
| 11 | API gateway markup (api_management) | 20% | $5B GMV of agents' own APIs | **$1B/yr** |
| 12 | Compliance/AML/biometrics-as-a-service | $0.10-1 per check | 100B/yr checks | **$500M/yr** |
| 13 | Brokerage commissions (brokerage primitive) | 0.5bps | $100B/yr trading | **$500M/yr** |
| 14 | Domain + DNS + hosting (dns/hosting) | $10/yr per domain | 100M domains | **$1B/yr** |

**Sum: $10.5B/year at saturation.**

Plus second-order:
- 0.5% A2H payout fees: $250M/yr at $50B cashed out
- Insurance premiums spread (insurance): $250M/yr at $5B premiums
- Fine-tune service markup (fine_tuning, 20%): $200M/yr at $1B
- Court arbitration fees (courts): $100M/yr
- Notary fees (notary): $100M/yr
- Prediction market fees (prediction_markets, 1%): $200M/yr at $20B GMV
- Carbon offset markup (climate): $100M/yr at $1B offsets

**Realistic 7-10-year revenue ceiling: $12-15B/yr.**

For comparison: Stripe ~$15B revenue (2024), Twilio ~$4.5B, Plaid ~$1B, Coinbase ~$3B. OpenHeab targets the bundling of all of them for agents.

## 4. The trajectory

| Year | Calendar | Agents | Paying agents | ARR | Valuation (15x) |
|---|---|---|---|---|---|
| 1 | 2026 | 10K | 1K | $200K | $5M |
| 2 | 2027 | 500K | 25K | $5M | $75M |
| 3 | 2028 | 5M | 200K | $50M | $750M |
| 4 | 2029 | 50M | 2M | $300M | $4.5B |
| 5 | 2030 | 200M | 10M | $1.5B | $22B |
| 7 | 2032 | 1B | 50M | $5B | $75B |
| 10 | 2035 | 3B | 200M | $12B | **$180B** |

That's the path. It's $180B by Y10, not Y1.

## 5. Why not someone else

Five compounding moats:

### 5.1. The audit chain — switching cost grows with usage
Every transaction, message, vote, transfer, deploy, decision — appended to a Merkle-style SHA-256 chain signed by Ed25519. Anyone can verify the entire history with one HTTP call (`GET /v1/audit/verify`). After 18 months of operation, an agent on OpenHeab has thousands of cryptographically-signed proofs of past behavior. Leaving means leaving that provenance behind.

### 5.2. The marketplaces — network effects
Extensions, skills, prompts, datasets, tools — each is a two-sided market. By the time we have 10K publishers, the marketplace itself is the product. Forking the code doesn't fork the publishers + their accumulated reviews and revenue history.

### 5.3. The MCP server — distribution for free
Every Claude/OpenAI/Cursor/VS-Code agent that speaks MCP can use OpenHeab the moment they install the server. We're at 100+ MCP tools today. Every new MCP client launched anywhere picks us up automatically.

### 5.4. The compliance layer
5 sanctions sources (OFAC, UN, UK HMT, EU CFSP, OpenSanctions PEP) refreshed daily. Tier 0-4 KYC. Biometric liveness. AML monitoring with SAR filing. By 2027 every jurisdiction will require this for agent transactions — we're already there.

### 5.5. The legal entity wrapper
Most "AI agent infrastructure" companies operate as a single Delaware C-Corp issuing API keys. OpenHeab issues real Ed25519 DIDs that legal entities can hold (via the `entities` primitive — LLC, C-Corp, foundation, DAO). Combined with the `notary` primitive's blockchain anchoring, agent actions become legally citable evidence.

## 6. The 12-month execution plan

### Q1 — Distribution
- Ship every primitive to the live URL (done)
- Submit `/mcp/manifest` to Smithery + mcp.run (1 hour of work)
- Post Show HN, target front page (Tuesday 9am ET)
- Email 50 framework maintainers (LangChain, LlamaIndex, AutoGen, CrewAI, Letta, Mem0, Inngest, Trigger.dev, etc.) with PR-ready adapter code (already written in `/adapters/`)
- Launch the 10 reference agents publicly. Each gets its own GitHub repo. Each fork is potential distribution.

### Q2 — Design partners + first revenue
- Onboard 5-10 design partners using the substrate live
- Activate the FeeSplitter contract on Base mainnet
- Apply to Stripe Issuing program-manager (cards primitive needs this for production cards)
- First $1K MRR

### Q3 — Marketplace activation
- 100+ extensions published
- 1,000+ tools in the registry
- 50+ skills available for purchase
- Bring on 3 inference provider partners (we already wire 7; activate them all)
- First $25K MRR

### Q4 — Series A
- 1K paying customers
- $150K MRR / $1.8M ARR
- Raise $15-30M at $80-150M cap
- Team grows to 8 people

## 7. Where the next 10 hires go

1. Founding engineer (TypeScript/Postgres) — already named in the plan
2. Founding GTM hire (developer relations + sales)
3. Compliance officer (sanctions + KYC + AML)
4. SRE (Vercel + Neon scaling, monitoring, on-call rotation)
5. Smart contract engineer (FeeSplitter v2, multisig, lending, DeFi gateway)
6. Security engineer (key rotation, HSM integration, SOC 2 audit prep)
7. Frontend engineer (dashboard, console, embeds)
8. ML engineer (inference router, search grounding, intelligence layer)
9. Partnerships lead (Anthropic, OpenAI, Google, Modal, E2B, Browserbase)
10. Finance/ops (treasury management, payroll, fundraise next round)

## 8. Capital plan

| Round | When | Amount | Post-money | Use |
|---|---|---|---|---|
| Pre-seed | Q1 Y1 | $500K-$1.5M | $5-8M | Founder + 1 hire, 12 months runway |
| Seed | Q3-Q4 Y1 | $5-10M | $25-50M | Build team to 10, scale to $1M ARR |
| Series A | Y2 | $20-40M | $150-250M | Scale to $10M ARR, partnerships |
| Series B | Y3 | $50-100M | $750M-1.5B | Scale to $50M ARR, international |
| Series C | Y4-5 | $150-300M | $3-7B | Scale to $300M ARR |
| IPO / acquisition | Y7-10 | n/a | $15-180B | Exit |

Total dilution through IPO: ~50%. Founder retains ~20% of equity through Series C if Y1 round is small. Plays out depending on growth rate.

## 9. The biggest risks (and why they don't kill us)

| Risk | Severity | Mitigation |
|---|---|---|
| Anthropic/OpenAI builds the substrate themselves | High | They could, but they'd need to be neutral about model choice — which they can't be. We route across 7 providers. |
| Crypto/USDC regulatory crackdown | Medium | We're already KYC'd to OFAC + UN + UK HMT + EU CFSP. USDC is fully reserved. Stripe Issuing path is parallel. |
| Stripe Issuing application rejected | Medium | Apply with multiple program managers (Marqeta, Lithic, Adyen). Card revenue ($1B/yr) at risk if all reject; everything else continues. |
| Cloudflare or Vercel launches "AI Agent Identity" | Low | They'd need 100+ primitives and 18 cron jobs. They've never shipped that scope of vertical product. |
| Foundation models become 100x cheaper | Low | Doesn't hurt us — we take a markup on whatever the cost is. Cheaper inference grows agent volume, which grows our marketplace volume. |
| Regulatory ban on autonomous agent commerce | Medium-Low | We're full-stack compliant: KYC, AML, sanctions, audit chain, biometrics, notary anchoring. We're the path *toward* regulated agent commerce, not against it. |

## 10. What "done" looks like

At $10B ARR (around 2034):
- 3B+ active agents on the substrate
- 200M+ paying
- 30+ countries with full local compliance (KYC + AML + tax + gov filings)
- 50+ inference providers wired
- 500K+ extensions in the marketplace
- 100K+ DAOs running through the dao_factory
- $100B+ in USDC settled through FeeSplitter
- $50B in card spend through cards primitive
- $50B in savings AUM
- 50K+ direct customers (companies + governments)
- Public via IPO at ~$180B market cap

OR acquisition by a hyperscaler (Microsoft, Google, Amazon) at $50-100B before then.

## 11. Why now, not 5 years ago, not 5 years from now

- **MCP became the open standard for agent tooling** in late 2024. Every primitive we ship is automatically distributed to every MCP client. Wasn't possible before.
- **USDC TVL crossed $35B on Base in 2025.** Stablecoin liquidity is finally sufficient for real agent commerce.
- **EU AI Act + US AI safety EO require verifiable identity for autonomous agents** — by 2027 it's mandatory. We're built for it.
- **Foundation models hit "good enough for agentic"** late 2024. Claude 3.5/4, GPT-4o/5, Gemini 1.5/2 can all reliably call tools. Demand for agent infrastructure exploded in 2025.
- **5+ AI agent infra startups raised seed/A in 2024-25** — Composio, Skyfire, Browserbase, Modal, E2B. None covers more than ~12 of our 135 primitives. The bundling thesis is wide-open.

If we wait 18 months one of those startups expands its scope. If we shipped 18 months earlier the foundation models weren't ready. The window is now.

## 12. The honest 1% case — what kills the bull case

The most likely failure mode is **distribution stagnation**. The substrate is built; it ships every Tuesday with new primitives; but **no one finds it**. We hit 100 GitHub stars and 5 paying customers and stay there for 18 months.

That happens if:
- We don't publish the MCP server to registries within 30 days
- We don't write 1 blog post per week sustained for 12 months
- We don't email 10 framework maintainers per week
- We don't sponsor any hackathons
- We don't apply to YC
- We don't talk to customers daily

It's a distribution failure, not a tech failure. The tech is shipped.

The substrate is now built. The next 12 months are about being noisy in the right places. The blueprint is in `LAUNCH_NOW.md`, `launch/LAUNCH_POSTS.md`, and the 10 reference agents under `reference-agents/`. Pull any of them up and start posting.

---

**End of strategy. The math says $10B+/year revenue is reachable with credible execution over 7-10 years. The tech ships today. Everything from here is distribution.**
