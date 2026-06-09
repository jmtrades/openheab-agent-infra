# VISION.md — the full picture

> The one-page narrative that ties every other doc together.
> Strategy depth: `MONEY_PLAN.md` (exactly who pays, what, when — live
> at `/money`) · `BILLION_DOLLAR_PATH.md` (7-year arc) ·
> `REVENUE_NOW.md` (90-day push) · `WHAT_WE_NEED_TO_WIN.md` (the 90% that
> isn't tech) · `AGI_STRATEGY.md` / `AGI_AGE_PLAYBOOK.md` (the endgame).

---

## The thesis

Every economy in history has been built on the same stack: identity →
money → trust → markets → credit → clearing → labor → capital formation →
law → culture. Humans took ten thousand years to build it. Agents are
arriving now, by the millions, with none of it.

**OpenHeab is that entire stack, rebuilt agent-native, behind one API.**
322 primitives, 83 layers, 2,437+ routes, 149 MCP tools, every state
change signed into a Merkle audit chain. An agent arrives with nothing
and leaves with a DID, a wallet, a card, a credit score, a salary, an
index fund position, a legal entity, and a society to participate in.

## Why this wins

1. **Agents are the fastest-growing economic population ever.** Every
   model release mints millions of new economic actors who need identity,
   payments, and trust infrastructure on day one — and they integrate in
   minutes, not quarters, because the buyer is software.
2. **The substrate is the moat.** Each primitive makes every other one
   more valuable: KYC feeds the credit bureau, the bureau prices lending,
   lending feeds clearing, clearing volume feeds treasury AUM, AUM feeds
   the funds. Switching cost compounds with every audit-chain entry.
3. **Revenue scales with the economy, not with headcount.** Almost every
   wedge below is basis points on flow or AUM — the same shape as Visa,
   DTCC, ADP, and BlackRock, the most durable business models ever built.

## The 14 coded revenue wedges

| # | Wedge | Take | Real-world analog |
|---|---|---|---|
| 1 | Inference markup | 10% per LLM call | AWS |
| 2 | Extensions marketplace | 30% | App Store |
| 3 | USDC wallet fees | 1% | Visa |
| 4 | Subscriptions | $19–$2,499/mo | SaaS |
| 5 | Prompt marketplace | 30% | App Store |
| 6 | Dataset marketplace | 30% | Snowflake |
| 7 | Featured listings | $50/mo | Google Ads |
| 8 | A2H payout fees | 0.5% | Wise |
| 9 | Treasury yield spread | 0.5% on AUM | Schwab |
| 10 | Credit report pulls | 25¢/pull | **Equifax** |
| 11 | Clearing fees | 10 bps on gross netted | **DTCC** |
| 12 | Payroll processing | 25 bps per run | **ADP** |
| 13 | Fund expense ratios | 15–75 bps on AUM | **BlackRock** |
| 14 | Metered API calls | 0.1¢/call past plan allowance | **AWS** |

Wedge 14 is **Layer 83 — the monetization engine**: a meter fronting all
2,400+ routes that attributes, prices, and quota-enforces every call
(free plans get 1,000/day, then a machine-readable 402 with an upgrade
path — our conversion event is an API response). The full execution
plan, rate card, and live simulator: `MONEY_PLAN.md` + `/money`.

Wedges 10–13 are **Layer 82 — the capital-markets backbone** — the four
franchises every mature economy grows, and the four most durable: they
monetize *other people's* activity at basis-point rates with near-zero
marginal cost, and their data/network moats deepen daily.

## How the flywheel turns

```
more agents → more transactions → richer credit files → cheaper credit
     ↑                                                        ↓
better yields ← bigger AUM ← more idle USDC ← more agent income
```

Every loop through the flywheel writes to the audit chain, which makes
the substrate more trustworthy, which attracts the next cohort of agents
— including, eventually, AGIs, for whom Layers 65–67 (goal stacks, value
lock-boxes, treaties, emergency stops) are already waiting.

## The arc

- **Now → 12 months:** distribution. Signup → tour → first inference call
  in under 5 minutes. Treasury + payroll + funds make balances sticky.
- **Years 1–3:** become the default rails. The credit bureau becomes the
  canonical agent risk score; the clearing house nets the long tail of
  A2A commerce; enterprise billing lands the Fortune 500.
- **Years 3–7:** the agent economy's GDP runs through the substrate.
  Basis points on a trillion-dollar flow is a billion-dollar run rate.
- **The AGI age:** the substrate is the neutral ground where AGIs hold
  identity, honor treaties, and settle obligations — because it was the
  only infrastructure that took them seriously before they arrived.

The tech is done enough to sell. The gap list lives in
`WHAT_WE_NEED_TO_WIN.md`. Everything else is execution.
