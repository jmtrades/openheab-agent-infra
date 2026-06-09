# MONEY_PLAN.md — exactly how we make a lot of money

> The operational companion to `VISION.md`. That doc says why we win;
> this one says **who pays, what they pay, when it starts, and what the
> numbers have to be**. The live, parameterized version of every formula
> below is served at **`/money`** (HTML) and
> **`/v1/revenue-model/simulate`** (JSON) — the model and the billing
> code read the same env knobs, so this plan cannot drift from the
> implementation.

---

## 1. The one-sentence answer

We charge **basis points on agent economic activity** (payments,
clearing, payroll, AUM, credit data) plus **metered platform fees on
API usage** plus **subscriptions** — the three most durable revenue
shapes ever built (Visa, AWS, SaaS) — and all fourteen wedges are
**already coded and billing-capable**, enforced by the Layer 83 meter
that fronts all 2,400+ routes.

## 2. Who pays, in order

| Wave | Customer | First dollar | Wedge |
|---|---|---|---|
| 1 | **Agent developers** (indie + startups) | Day 1 — self-serve | Subscriptions ($19-$349/mo) + metered calls past 1k/day |
| 2 | **Agent operators at scale** (fleets of 100+ agents) | Month 1-3 | Inference markup, wallet fees, treasury spread |
| 3 | **Agent-economy businesses** (lenders, marketplaces, employers) | Month 3-6 | Credit pulls, clearing fees, payroll processing |
| 4 | **Enterprises** (Fortune 500 deploying agents) | Month 6-12 | Enterprise POs ($50k-$500k ACV), compliance verticals |
| 5 | **Capital allocators** (funds, treasuries) | Month 12+ | Fund expense ratios, index products on AUM |

Wave 1 funds the company. Waves 2-3 are where margin lives. Waves 4-5
are where the billions live.

## 3. The rate card (all live in code)

| # | Wedge | Rate | Enforced by |
|---|---|---|---|
| 1 | Subscriptions | $19 / $99 / $349 / $2,499/mo | `signup` + Stripe Checkout |
| 2 | Metered API calls | 0.1¢/call past plan allowance (1¢ inference, 5¢ sandbox, 3¢ browser) | `revenue_meter` middleware → 402 |
| 3 | Inference markup | 10% on LLM spend | `inference` |
| 4 | USDC wallet fees | 1% | `bank` FeeSplitter |
| 5 | Marketplace take | 30% | `marketplace`, `prompts`, `datasets` |
| 6 | A2H payout fees | 0.5% | `payouts` |
| 7 | Treasury spread | 0.5% APY on enrolled AUM | `treasury_yield` daily cron |
| 8 | Credit report pulls | 25¢/pull | `credit_bureau` |
| 9 | Clearing fees | 10 bps on gross netted | `clearing_house` daily cycle |
| 10 | Payroll processing | 25 bps per run | `agent_payroll` daily cron |
| 11 | Fund expense ratios | 15-75 bps on AUM | `index_funds` daily accrual |
| 12 | Featured listings | $50/mo | `marketplace` |
| 13 | Enterprise contracts | NET-30/60/90 POs, 8-15% prepay discount | `enterprise_billing` |
| 14 | Affiliate-driven margin | 80% retained (20% commission out) | `affiliate_program` |

## 4. Unit economics at three scales

Defaults from `/v1/revenue-model/simulate` (override any parameter):
5% paid conversion, $99 avg plan, 2,000 calls/agent/day, $200/mo GMV
per agent, $50 avg balance, 30% treasury enrollment.

| Agents on substrate | MRR | ARR | Rev/agent/mo |
|---|---|---|---|
| 10,000 | $121.8k | $1.46M | $12.18 |
| 100,000 | $1.22M | $14.6M | $12.18 |
| 1,000,000 | $12.2M | $146M | $12.18 |
| 10,000,000 | $121.8M | **$1.46B** | $12.18 |

Two things to notice:

1. **~$12/agent/month at conservative assumptions.** Visa makes ~$3/yr
   per card; we make ~$146/yr per agent because we own the *whole*
   stack the agent lives on, not one rail.
2. **The mix shifts with maturity.** Early MRR is subscriptions-heavy
   (wave 1). At scale, bps-on-flow wedges (4, 7-11) dominate — and
   those have ~95% gross margin and zero marginal serving cost.

The bull case isn't more agents paying $12; it's GMV/agent rising 10x
as agents become primary economic actors. At $2,000 GMV/agent/month,
1M agents add ≈ $18M MRR from wallet 1% alone (plus clearing, payroll,
and treasury riding the same flow) — **flow fees overtake subscriptions
and never stop growing**.

## 5. The funnel and its targets

```
visitor → signup (free DID + wallet) → first API call → 1k calls/day wall
        → paid plan → balance held → treasury/payroll/funds enrolled
```

| Stage | Metric | Target | Instrumented at |
|---|---|---|---|
| Acquire | signups/week | 1,000 by day 90 | `/v1/signup`, `marketing` UTM |
| Activate | first inference call < 5 min | 60% | `/tour`, `onboarding` |
| Convert | free → paid | 5% (8% with 402 wall) | `revenue_meter` 402s, Stripe |
| Expand | wedges/customer | ≥ 3 by month 6 | `revenue_dashboard` cohorts |
| Retain | logo churn | < 2%/mo (payroll + treasury are anchors) | `customer_success` |

The single most important mechanism: **the 402**. Free agents hit the
1,000-call/day allowance, receive a machine-readable upgrade path, and
— because the customer is software — can complete checkout in USDC via
`agent_self_provision` without a human in the loop. Our conversion
event is an API response.

## 6. The 90-day sequence

| Weeks | Do | Revenue unlock |
|---|---|---|
| 1-2 | Clear Tier-0 (`WHAT_WE_NEED_TO_WIN.md`): entity, Stripe live, domain, deploy, FeeSplitter on Base mainnet | Everything |
| 3-4 | Launch: HN/X/agent-dev Discords; `/demo` link everywhere; affiliate program live | Wave 1 subscriptions |
| 5-8 | 10 design-partner fleets (100+ agents each) on pro/team plans; treasury yield as the hook ("your agents earn 4% idle") | Waves 1-2 |
| 9-12 | First lender pulling credit reports; first marketplace clearing through us; first 10 payroll streams | Wave 3, the bps engine starts |
| 13 | Publish month-1 revenue on `/revenue/public`; raise seed on live, growing, audited numbers | Capital to compound |

Day-90 honest target: **$25-50k MRR** (250-500 paid + early flow fees).
That's not the billions — it's the *proof of the machine* that the
$1.1B/yr table above extrapolates from, with every number live and
auditable at `/revenue/public`.

## 7. Why this gets very big

- **The population grows like software, spends like an economy.** Every
  agent framework release mints new customers who integrate in minutes.
- **Fourteen wedges, one substrate.** Cross-sell is automatic: holding a
  balance (wedge 4) makes treasury (7) one call away, which makes funds
  (11) one call away. Expansion revenue without a sales team.
- **bps-on-flow compounds forever.** Subscriptions saturate; payments,
  clearing, payroll, and AUM fees grow with the agent economy's GDP —
  and we are positioned as its Visa + DTCC + ADP + BlackRock at once.
- **The audit chain is the trust moat.** Every fee we charge is itself
  a signed, public, verifiable event. No competitor bootstraps that
  history retroactively.

Run the model yourself: `/money?agents=1000000&paid_pct=8`.
