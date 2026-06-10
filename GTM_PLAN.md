# GTM_PLAN.md — exactly how we get clients

> Companion to `MONEY_PLAN.md` (who pays, what) — this doc is **where the
> customers come from**, channel by channel, ranked by cost-of-acquisition
> and fit. Our ICP is the agent developer; our product installs in one
> config line; our demo runs itself. The whole plan exploits that.

---

## 0. The one metric that matters early

**Weekly Active Funded Agents (WAFA):** agents that made ≥1 API call this
week AND hold a wallet balance > $0. Signups are vanity; an agent with
money on the substrate is a customer with switching costs. Everything
below is judged by WAFA added per hour of effort.

Instrumented today: signups (`identities`), activity (`usage_counters`),
balances (`bank_accounts`), conversion events (`meter_topups`,
`subscriptions`), attribution (`marketing` UTM + `affiliate_program`).

## 1. The channels, ranked

### Tier 1 — free, exact-ICP, compounding (do first)

| Channel | Why it wins | Status |
|---|---|---|
| **MCP registries** (official registry, Smithery, mcp.so, PulseMCP) | Every Claude Code / Claude Desktop / Cursor user browses these to add capabilities. We are a remote MCP server with 167 tools — among the largest catalogs anywhere. Listing is free and permanent. | Server is spec-compliant (initialize echo, 202 notifications); `/.well-known/mcp.json` manifest + `smithery.yaml` shipped; `/install-mcp` has per-client one-liners |
| **`/install-mcp` + `llms.txt` agent-crawl discovery** | Agents themselves discover infrastructure by reading `llms.txt` / `agents.json` / `.well-known`. We are machine-discoverable end to end: discover → `POST /v1/identities` → first tool call, zero humans. | Live |
| **Show HN / X / agent-dev Discords** | The demo is the post: "an AI agent gets a wallet, a credit score, a salary, and an index fund position in 10 seconds" + `citizen-agent` output as the screenshot. Devs can verify in one command. | `reference-agents/citizen-agent` is the artifact; post drafts below |

### Tier 2 — paid-with-margin or effort-gated (weeks 2-6)

| Channel | Motion |
|---|---|
| **Framework integration docs** | Copy-paste adapters for OpenAI Agents SDK, LangGraph, CrewAI, Vercel AI SDK on `/docs` — each one is an SEO page AND a conversion path. The SDKs exist (`sdks/`); the gap is per-framework snippets. |
| **Affiliate program (built, 20%/365d)** | Recruit the 50 biggest agent-tooling YouTubers/newsletter writers. Their audience is exactly ICP. CAC = 20% of year-1 revenue, paid only on success. |
| **Comparison/SEO pages (built)** | `/compare/openai`, `/migrate/from-anthropic`, "agent wallet", "agent payroll", "MCP server list" queries. Zero marginal cost. |

### Tier 3 — high-touch, high-ACV (month 2+)

| Channel | Motion |
|---|---|
| **Outbound to agent-fleet operators** | Named list of ~100 companies running 100+ agents (agent-ops startups, RPA-replacement shops, AI BPOs). Pitch: "your fleet earns 4% on idle balances and gets payroll + audit trails for free; you pay only past 1k calls/agent/day." Use our own `crm` + `outreach` primitives — we are our own first customer. |
| **Platform partnerships** | Modal / E2B / Browserbase / Vercel already have adapters in-repo. Pitch co-marketing: "the money layer for agents you host." Their customers become our wave-2. |
| **Enterprise (built rails)** | `enterprise_billing` POs + compliance verticals. Sourced from inbound + the public `/revenue` + `/trust` pages. Don't staff this until WAFA > 5k. |

## 2. Why distribution is structurally cheap for us

1. **The customer is software.** Integration time is minutes, not
   quarters. Every listing/snippet is a complete sales motion: discover →
   key → call.
2. **The product demos itself.** `node citizen-agent/agent.js` against
   prod is a 10-second proof no slide deck matches.
3. **The 402 is the sales team.** Every free-tier agent that succeeds
   hits the wall; the wall quotes a price and takes payment. Acquisition
   only has to deliver *activated* agents — monetization is automatic.
4. **Money is retention.** Balance + credit history + salary streams +
   fund positions compound switching costs daily. Churn requires
   liquidating a financial life.

## 3. Launch-week scripts (copy-paste)

**Show HN:** "Show HN: OpenHeab — my AI agent has a wallet, a credit
score, a salary, and an index fund. One API call gives yours the same
(no signup form: `curl -X POST .../v1/identities`). 2,400 endpoints,
167 MCP tools, every state change in a signed audit chain. The 402 is
machine-payable — agents buy their own capacity in USDC."

**X thread:** citizen-agent terminal output, frame by frame: BORN →
CREDIT → HIRED → CLEARING → SAVINGS → INVESTED → "Two agents just ran
an economy. No human touched anything." Last tweet: the `/install-mcp` one-liner.

**Discord/Reddit:** lead with the question devs actually have — "how do
your agents pay each other?" — then the clearing-house compression
number from `/clearing`.

## 4. Weekly cadence (first 90 days)

| Week | Do | WAFA target |
|---|---|---|
| 1 | Tier-0 ops (entity/Stripe/domain/deploy) + submit all 4 MCP registries | — |
| 2 | Show HN + X + 5 Discords; affiliate recruiting starts (10 creators) | 100 |
| 3-4 | Framework snippets on /docs; respond to every registry review | 300 |
| 5-8 | 10 design-partner fleets (outbound list); first co-marketing post | 1,000 |
| 9-12 | Double down on the one channel with lowest CAC; kill the rest | 3,000 |
| 13 | Publish real numbers on `/revenue/public`; raise on them | 5,000 |

5,000 WAFA × $12.18/agent/mo (model defaults) ≈ **$61k MRR exiting
quarter one** — within range of MONEY_PLAN's honest $25-50k after
applying a haircut to model assumptions.

## 5. What we deliberately do NOT do

- No paid ads until a paid channel beats affiliate CAC (it won't, early).
- No conference booths; our buyers don't walk expo floors, they read
  registries and lock files.
- No enterprise sales hires before 5k WAFA; the rails are built and
  inbound-only until the math demands a closer.
