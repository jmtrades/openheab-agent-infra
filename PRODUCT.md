# PRODUCT.md — the full product design

> The master document. `VISION.md` says why this wins, `MONEY_PLAN.md`
> says who pays, `GTM_PLAN.md` says where customers come from — this doc
> defines **what the product is**: positioning, personas, journeys, the
> complete surface, and the design principles that keep 2,400+ routes
> feeling like one product.

---

## 1. Positioning

**Category:** the financial system for AI agents.
**One-liner:** one API call gives an agent an identity, a USDC wallet, a
credit score, a salary, 4% yield, and index funds — every state change
signed into a public audit chain.

We deliberately lead with **money**, not with "322 primitives" or "the
agent society." Breadth is the moat; money is the buying trigger. The
society layers (universities, diplomacy, concerts, diaries) stay in the
product as engagement + culture surfaces, but they are never the pitch.

**Against the field:**
- Payments APIs for agents (Stripe-for-agents startups) sell one rail.
  We sell the whole stack the rail plugs into — and the rail.
- Agent frameworks (LangGraph, CrewAI) own orchestration, not value.
  We are complementary: their agents bank here. (Hence framework docs,
  not framework competition.)
- Crypto agent projects sell tokens. We sell infrastructure with
  Web2-grade ergonomics: REST + MCP, cents-denominated, audit-chained.

## 2. Personas and their first ten minutes

| Persona | Arrives via | First 10 minutes | Converts when |
|---|---|---|---|
| **The agent itself** | `llms.txt`, `.well-known/mcp.json`, another agent | `POST /v1/identities` → first tool call → reads its own `/v1/usage` | Hits the 402 → pays it from balance (`/v1/meter/topup`) |
| **Agent developer** | MCP registry, Show HN, a friend | `/install-mcp` one-liner → tools appear in Claude Code/Cursor → `/tour` | Free tier limits a real workload → plan or autopay |
| **Fleet operator** | Outbound, comparison pages | `/money` simulator with their fleet size → `/dashboard` per-agent books | Payroll + treasury float math beats their current stack |
| **Enterprise buyer** | Inbound from `/trust`, `/revenue/public` | Audit chain verify + SOC2-track evidence + SSO/RBAC docs | PO via `/enterprise-billing`, NET-60, signed DPA |

Design rule: **every persona's first session must reach value without
talking to us** — the agent in seconds, the developer in one config
line, the operator in one simulator URL, the enterprise in one
self-served evidence pack.

## 3. The product surface (information architecture)

```
/                  The story: money layer → machine billing → quickstart
                   → fleets → proof → breadth → why now. Live stats.
/install-mcp       THE acquisition page. Per-client one-liners + key bootstrap.
/docs              Reference + guides. /openapi.json for machines.
/pricing           Plans + usage add-ons. /v1/pricing/usdc for agents.
/money             The economics, public: rate card + MRR simulator.
/dashboard         The agent's books: wallet, usage, positions, salary.
/treasury /credit /clearing /payroll /funds     The money-layer products.
/trust /audit-verify /proof-of-reserves /revenue/public   The proof set.
/mcp + /mcp/registry + /.well-known/mcp.json    The machine front door.
Everything else    Reachable via /sitemap + search; never in top nav.
```

Top nav is exactly six links (Install · Docs · Pricing · Economics ·
Trust · Blog) + CTA. The other ~1,270 pages earn discovery through
search, sitemap, and contextual links — not navigation bloat.

## 4. Design principles (what keeps this coherent)

1. **The agent is a first-class user.** Every human page has a machine
   twin (HTML ↔ JSON), every error is machine-actionable (the 402
   carries its own payment instructions), and nothing requires a form.
2. **One ledger, one chain, one identity.** Every product settles on the
   same cents ledger (value conserved by construction), writes the same
   audit chain, and keys off the same DID. No product is an island.
3. **Show the books.** Our revenue model, reserves, audit chain, and
   live metrics are public. Trust is the product; opacity is churn.
4. **Fail open on metering, fail closed on money.** A billing bug must
   never break the product; a payment must never succeed without
   settlement.
5. **Idempotent everything.** Every cron, every purchase, every webhook
   can be replayed safely. Distributed systems retry; bills must not.

## 5. What we built and why it gains traction

| Surface | Traction mechanism |
|---|---|
| Machine-payable 402 + autopay | Converts without sales; gets talked about (no one else does this) |
| Treasury yield 4% | The reason balances stay; "your agents earn while idle" is the hook line |
| Credit bureau (free band) | Every public band link markets the bureau; lenders pay for depth |
| Clearing compression % | A live, quotable number ("we netted 98% away") — shareable proof |
| `/money` simulator | Every prospect argues with our model in their own browser — engagement that sells |
| `/install-mcp` + manifest | One-line adoption through registries — distribution without spend |
| Audit chain + open books | The trust artifact enterprises and regulators need; competitors can't retrofit history |
| Open source (Apache 2) | Self-hosters become contributors, integrators, and eventually hosted customers |

## 6. The build-out sequence from here

1. **Now (done in repo):** money layer, settlement integrity, metering +
   conversion, MCP distribution, the redesigned front door, all proven
   against real Postgres (400+ tests).
2. **Launch (founder ops):** Tier-0 list (`WHAT_WE_NEED_TO_WIN.md`) —
   entity, Stripe, domain, deploy, FeeSplitter mainnet — then
   `GTM_PLAN.md` week 1-2 (registries + launch posts).
3. **First 1,000 WAFA:** double down on whichever of the three Tier-1
   channels wins; ship framework snippets; turn on affiliates.
4. **First $100k MRR:** fleet design partners; first external lender on
   the bureau; first marketplace clearing through us.
5. **The compounding phase:** AUM products (treasury → funds → lending)
   deepen with every cohort; bps-on-flow overtakes subscriptions; the
   audit chain becomes the industry's trust standard.

The product is designed so that each phase's users *create the asset*
the next phase sells: usage creates credit files, credit files price
lending, lending creates flow, flow creates AUM, AUM creates yield —
and every loop writes the chain that makes the next customer trust us.
